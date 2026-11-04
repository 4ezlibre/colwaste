/* Vérification et conversion du fichier avant import.
   Accepté : CSV (UTF-8, Windows-1252, UTF-16 ; séparateur , ; ou tabulation)
             et classeur Excel .xlsx (le premier onglet est lu).
   Résultat : toujours un CSV UTF-8 séparé par des virgules, avec la liste des vérifications effectuées.
   Tout le traitement se fait dans le navigateur (aucun envoi réseau). */

const SIG_ZIP = [0x50, 0x4b, 0x03, 0x04];
const SIG_OLE = [0xd0, 0xcf, 0x11, 0xe0];

function startsWithBytes(bytes, sig) {
  return sig.every((b, i) => bytes[i] === b);
}

async function prepareImport(file) {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const notes = [];
  let text;

  if (startsWithBytes(bytes, SIG_ZIP)) {
    const zip = await readZip(buffer);
    if (zip.entries.has('xl/workbook.xml')) {
      text = await xlsxFirstSheetToCsv(zip, notes);
    } else if (zip.entries.has('content.xml')) {
      throw new Error('Format OpenDocument (.ods) non pris en charge. Enregistre le classeur au format .xlsx ou exporte l’onglet en CSV.');
    } else {
      throw new Error('Archive non reconnue. Le fichier doit être un CSV ou un classeur Excel (.xlsx).');
    }
  } else if (startsWithBytes(bytes, SIG_OLE)) {
    throw new Error('Ancien format Excel (.xls) non pris en charge. Enregistre le classeur au format .xlsx ou exporte l’onglet en CSV.');
  } else {
    notes.push('Format détecté : CSV.');
    const decoded = decodeText(bytes, notes);
    if (/^\s*<(!doctype\s+html|html|table)/i.test(decoded)) {
      throw new Error('Le fichier est une page HTML (export web). Exporte l’onglet en CSV ou en .xlsx.');
    }
    if (decoded.includes('\u0000')) {
      throw new Error('Le fichier contient des données binaires : ce n’est ni un CSV ni un classeur Excel lisible.');
    }
    const m = /\.([a-z0-9]+)$/i.exec(file.name || '');
    if (m && !['csv', 'txt'].includes(m[1].toLowerCase())) {
      notes.push(`Extension « .${m[1]} » inattendue : le contenu a été lu comme du CSV.`);
    }
    text = decoded;
  }

  return { text: normalizeCsv(text, notes), notes };
}

/* Texte : détecte UTF-16 (BOM), sinon UTF-8, sinon Windows-1252 */
function decodeText(bytes, notes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    notes.push('Encodage UTF-16 (Excel « Texte Unicode ») converti en UTF-8.');
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    notes.push('Encodage UTF-16 converti en UTF-8.');
    return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (err) {
    notes.push('Encodage Windows-1252 (ANSI) converti en UTF-8.');
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/* Contrôle et réécriture du CSV : séparateur, en-tête décalé, tableau croisé */
function normalizeCsv(raw, notes) {
  const text = raw.replace(/^\uFEFF/, '');
  if (!text.trim()) throw new Error('Le fichier est vide.');

  const delimiter = detectDelimiter(text);
  let rows = parseCSV(text, delimiter);
  if (!rows.length) throw new Error('Aucune ligne lisible dans le fichier.');

  const isHeaderRow = (r) => {
    const n = r.map((c) => normalizeKey(c));
    return n.includes(normalizeKey(FIELD_DEFS.qteRecue)) && n.includes(normalizeKey(FIELD_DEFS.denomination));
  };
  const idx = rows.findIndex((r, i) => i < 20 && isHeaderRow(r));
  if (idx > 0) {
    rows = rows.slice(idx);
    notes.push(`${idx} ligne(s) de titre avant l’en-tête supprimée(s).`);
  } else if (idx < 0 && rows.some((r) => normalizeKey(r[0]) === 'etiquettes de lignes')) {
    throw new Error('Ce fichier est un tableau croisé (onglet de synthèse), pas l’onglet « Import Track Déchet ». Exporte le premier onglet.');
  }

  if (delimiter !== ',') {
    const label = delimiter === ';' ? 'point-virgule' : 'tabulation';
    notes.push(`Séparateur « ${label} » converti en virgule.`);
  }
  return toCsvText(rows);
}

function toCsvText(rows) {
  const cell = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return rows.map((r) => r.map(cell).join(',')).join('\n');
}

/* ---------- Lecture d'un .xlsx (ZIP + XML), sans bibliothèque externe ---------- */

async function readZip(buffer) {
  const dv = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Archive Excel invalide (répertoire introuvable).');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Archive Excel invalide (répertoire central).');
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const offset = dv.getUint32(p + 42, true);
    const name = new TextDecoder('utf-8').decode(bytes.subarray(p + 46, p + 46 + nameLen));
    entries.set(name, { method, csize, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { entries, dv, bytes };
}

async function readZipEntry(zip, name) {
  const e = zip.entries.get(name);
  if (!e) return null;
  const { dv, bytes } = zip;
  if (dv.getUint32(e.offset, true) !== 0x04034b50) throw new Error('Archive Excel invalide (entrée corrompue).');
  const nameLen = dv.getUint16(e.offset + 26, true);
  const extraLen = dv.getUint16(e.offset + 28, true);
  const start = e.offset + 30 + nameLen + extraLen;
  const data = bytes.subarray(start, start + e.csize);
  if (e.method === 0) return new Uint8Array(data);
  if (e.method === 8) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('Navigateur trop ancien pour lire les .xlsx. Exporte l’onglet en CSV.');
    }
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  throw new Error('Méthode de compression non prise en charge dans le classeur Excel.');
}

async function readZipText(zip, name) {
  const data = await readZipEntry(zip, name);
  return data ? new TextDecoder('utf-8').decode(data) : null;
}

function parseXml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Classeur Excel illisible (XML invalide).');
  return doc;
}

function childrenNamed(el, name) {
  return Array.from(el.children).filter((c) => c.localName === name);
}

function descendantsNamed(el, name) {
  return Array.from(el.getElementsByTagNameNS('*', name));
}

/* Texte d'une cellule riche (<si> ou <is>) : on ignore les annotations phonétiques */
function richText(el) {
  let s = '';
  for (const c of el.children) {
    if (c.localName === 't') s += c.textContent;
    else if (c.localName === 'r') s += childrenNamed(c, 't').map((t) => t.textContent).join('');
  }
  return s;
}

function parseSharedStrings(text) {
  if (!text) return [];
  return childrenNamed(parseXml(text).documentElement, 'si').map((si) => richText(si));
}

function isDateFormat(id, code) {
  if ([14, 15, 16, 17, 22].includes(id)) return true;
  if (!code) return false;
  const clean = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '');
  return /[dy]/i.test(clean);
}

/* Pour chaque style de cellule (index s) : vrai si c'est un format de date */
function parseDateStyles(text) {
  if (!text) return [];
  const root = parseXml(text).documentElement;
  const codes = new Map();
  const numFmts = childrenNamed(root, 'numFmts')[0];
  if (numFmts) {
    childrenNamed(numFmts, 'numFmt').forEach((f) => {
      codes.set(Number(f.getAttribute('numFmtId')), f.getAttribute('formatCode') || '');
    });
  }
  const cellXfs = childrenNamed(root, 'cellXfs')[0];
  if (!cellXfs) return [];
  return childrenNamed(cellXfs, 'xf').map((xf) => {
    const id = Number(xf.getAttribute('numFmtId') || 0);
    return isDateFormat(id, codes.get(id));
  });
}

/* Numéro de série Excel -> date ISO (AAAA-MM-JJ, avec l'heure si nécessaire) */
function serialToIso(v) {
  const ms = Math.round((v - 25569) * 86400000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(v);
  const iso = d.toISOString();
  return iso.slice(0, 10) + (ms % 86400000 !== 0 ? ' ' + iso.slice(11, 19) : '');
}

/* « AB12 » -> index de colonne 27 */
function colIndex(ref) {
  const letters = /^[A-Z]+/i.exec(ref)[0].toUpperCase();
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function cellValue(c, sst, xfIsDate) {
  const t = c.getAttribute('t');
  const s = Number(c.getAttribute('s') || 0);
  if (t === 'inlineStr') {
    const is = childrenNamed(c, 'is')[0];
    return is ? richText(is) : '';
  }
  const vEl = childrenNamed(c, 'v')[0];
  if (!vEl) return '';
  const raw = vEl.textContent;
  if (t === 's') return sst[Number(raw)] ?? '';
  if (t === 'str' || t === 'e') return raw;
  if (t === 'b') return raw === '1' ? 'VRAI' : 'FAUX';
  if (xfIsDate[s] && raw !== '' && !Number.isNaN(Number(raw))) return serialToIso(Number(raw));
  return raw;
}

/* Lit le premier onglet d'un classeur .xlsx et le retourne en CSV */
async function xlsxFirstSheetToCsv(zip, notes) {
  const wb = parseXml(await readZipText(zip, 'xl/workbook.xml')).documentElement;
  const sheetEl = descendantsNamed(wb, 'sheet')[0];
  if (!sheetEl) throw new Error('Classeur Excel sans onglet lisible.');
  const sheetName = sheetEl.getAttribute('name') || 'Feuille 1';
  let rid = '';
  for (const a of sheetEl.attributes) {
    if (a.localName === 'id') rid = a.value;
  }
  let target = 'worksheets/sheet1.xml';
  const relsText = await readZipText(zip, 'xl/_rels/workbook.xml.rels');
  if (relsText && rid) {
    const rel = descendantsNamed(parseXml(relsText).documentElement, 'Relationship')
      .find((r) => r.getAttribute('Id') === rid);
    if (rel) target = rel.getAttribute('Target');
  }
  const path = target.startsWith('/') ? target.slice(1) : 'xl/' + target;
  const sheetText = await readZipText(zip, path);
  if (!sheetText) throw new Error(`Onglet introuvable dans le classeur (${path}).`);

  const sst = parseSharedStrings(await readZipText(zip, 'xl/sharedStrings.xml'));
  const xfIsDate = parseDateStyles(await readZipText(zip, 'xl/styles.xml'));
  const sheetData = descendantsNamed(parseXml(sheetText).documentElement, 'sheetData')[0];

  const rows = [];
  if (sheetData) {
    for (const row of childrenNamed(sheetData, 'row')) {
      const arr = [];
      let col = 0;
      for (const c of childrenNamed(row, 'c')) {
        const ref = c.getAttribute('r');
        const idx = ref ? colIndex(ref) : col;
        arr[idx] = cellValue(c, sst, xfIsDate);
        col = idx + 1;
      }
      rows.push(Array.from(arr, (v) => (v == null ? '' : v)));
    }
  }
  notes.push(`Format détecté : classeur Excel (.xlsx). Premier onglet « ${sheetName} » lu et converti en CSV.`);
  return toCsvText(rows);
}
