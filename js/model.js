/* Modèle de données : colonnes reconnues, règles de classement, agrégations.
   Ce fichier ne dépend pas de l'interface. */

const FIELD_DEFS = {
  numero: 'N° de bordereau',
  identifiant: 'identifiant unique',
  type: 'Type de bordereau',
  statut: 'Statut du bordereau',
  denomination: 'Dénomination usuelle',
  codeDechet: 'Code déchet',
  dateExpedition: "Date d'expédition",
  expediteur: 'Expéditeur - Nom usuel',
  expediteurRS: 'Expéditeur - Raison sociale',
  lieuCollecte: 'Expéditeur - Référence du chantier / lieu de collecte',
  entrepriseTravaux: 'Entreprise de travaux - Raison sociale',
  destination: 'Destination - Nom usuel',
  qteRecue: 'Quantité réceptionnée nette (tonnes)',
  qteRefusee: 'Quantité refusée nette (tonnes)',
  qteAcceptee: 'Quantité acceptée / traitée nette (tonnes)',
  codeTraitement: 'Code(s) de traitement réalisé(s)'
};

const REQUIRED_FIELDS = ['qteRecue', 'codeTraitement', 'denomination', 'expediteur'];
const MULTI_FIELDS = ['expediteur', 'expediteurRS', 'lieuCollecte', 'entrepriseTravaux', 'destination'];
const CAT_RANK = { valorise: 0, elimine: 1, autre: 2 };

/* Clé de comparaison : sans accents, sans casse, espaces normalisés */
function normalizeKey(value) {
  return String(value == null ? '' : value)
    .replace(/^\uFEFF/, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’`]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/* Nombre au format français ou anglais ; vide ou non numérique => 0 */
function toNumber(value) {
  const s = String(value == null ? '' : value).trim().replace(/\s/g, '').replace(',', '.');
  if (s === '' || s.toLowerCase() === 'null') return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

/* Date au format ISO (AAAA-MM-JJ) ou française (JJ/MM/AAAA) */
function isoDate(value) {
  const s = String(value || '').trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return '';
}

/* Extrait les codes de traitement (R1, R12, D10, D9F…) d'une cellule */
function splitCodes(value) {
  const codes = String(value || '').toUpperCase().split(/[^A-Z0-9]+/).filter((c) => /^[RD]\d+[A-Z]?$/.test(c));
  return [...new Set(codes)];
}

/* Règle : au moins un code R => valorisé ; sinon un code D => éliminé ; sinon non traité */
function catOfKey(key) {
  if (/\bR\d/.test(key)) return 'valorise';
  if (/\bD\d/.test(key)) return 'elimine';
  return 'autre';
}

function codeSort(a, b) {
  return CAT_RANK[catOfKey(a)] - CAT_RANK[catOfKey(b)] || a.localeCompare(b, 'fr', { numeric: true });
}

/* Transforme un texte CSV (déjà normalisé) en lignes exploitables */
function buildDataset(text) {
  const delimiter = detectDelimiter(text);
  const table = parseCSV(text, delimiter);
  if (table.length < 2) throw new Error('Le fichier ne contient aucune ligne de données.');

  const norm = table[0].map((h) => normalizeKey(h));
  const cols = {};
  Object.keys(FIELD_DEFS).forEach((f) => {
    cols[f] = norm.indexOf(normalizeKey(FIELD_DEFS[f]));
  });
  const missing = REQUIRED_FIELDS.filter((f) => cols[f] < 0).map((f) => FIELD_DEFS[f]);
  if (missing.length) {
    throw new Error(`Colonnes introuvables : ${missing.join(', ')}. Vérifie que le fichier provient de l'onglet « Import Track Déchet ».`);
  }

  const get = (row, f) => (cols[f] >= 0 && row[cols[f]] != null ? String(row[cols[f]]).trim() : '');
  const lines = [];
  for (let r = 1; r < table.length; r++) {
    const row = table[r];
    const codes = splitCodes(get(row, 'codeTraitement'));
    const codeKey = codes.length ? codes.join(' + ') : '(aucun)';
    lines.push({
      id: r,
      numero: get(row, 'numero'),
      identifiant: get(row, 'identifiant'),
      type: get(row, 'type') || '(non renseigné)',
      statut: get(row, 'statut') || '(non renseigné)',
      denomination: get(row, 'denomination') || '(non renseignée)',
      codeDechet: get(row, 'codeDechet') || '(sans code)',
      dateExpedition: isoDate(get(row, 'dateExpedition')),
      expediteur: get(row, 'expediteur') || '(non renseigné)',
      expediteurRS: get(row, 'expediteurRS') || '(non renseignée)',
      lieuCollecte: get(row, 'lieuCollecte') || '(non renseigné)',
      entrepriseTravaux: get(row, 'entrepriseTravaux') || '(non renseignée)',
      destination: get(row, 'destination') || '(non renseignée)',
      qteRecue: toNumber(get(row, 'qteRecue')),
      qteRefusee: toNumber(get(row, 'qteRefusee')),
      qteAcceptee: toNumber(get(row, 'qteAcceptee')),
      codes,
      codeKey,
      categorie: catOfKey(codeKey)
    });
  }

  const found = {};
  Object.keys(FIELD_DEFS).forEach((f) => {
    found[f] = cols[f] >= 0;
  });
  return { delimiter, found, lines };
}

function defaultFilters() {
  const multi = {};
  MULTI_FIELDS.forEach((f) => { multi[f] = new Set(); });
  return { multi, denomination: '', statut: '', type: '', dateFrom: '', dateTo: '', search: '' };
}

function applyFilters(lines, f) {
  const q = f.search.trim().toLowerCase();
  return lines.filter((l) => {
    for (const key of MULTI_FIELDS) {
      if (f.multi[key].size && !f.multi[key].has(l[key])) return false;
    }
    if (f.denomination && l.denomination !== f.denomination) return false;
    if (f.statut && l.statut !== f.statut) return false;
    if (f.type && l.type !== f.type) return false;
    if (f.dateFrom && (!l.dateExpedition || l.dateExpedition < f.dateFrom)) return false;
    if (f.dateTo && (!l.dateExpedition || l.dateExpedition > f.dateTo)) return false;
    if (q) {
      const hay = [l.numero, l.identifiant, l.destination, l.denomination, l.codeDechet,
        l.expediteur, l.expediteurRS, l.lieuCollecte, l.entrepriseTravaux].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/* Agrégats : nombre de lignes et quantités en tonnes */
function emptyAgg(key) {
  return { key, n: 0, recue: 0, refusee: 0, acceptee: 0, valorise: 0, elimine: 0, autre: 0 };
}

function addToAgg(agg, l) {
  agg.n += 1;
  agg.recue += l.qteRecue;
  agg.refusee += l.qteRefusee;
  agg.acceptee += l.qteAcceptee;
  agg[l.categorie] += l.qteRecue;
}

function totals(lines, key) {
  const agg = emptyAgg(key || 'total');
  lines.forEach((l) => addToAgg(agg, l));
  return agg;
}

function groupBy(lines, keyFn) {
  const map = new Map();
  lines.forEach((l) => {
    const k = keyFn(l);
    if (!map.has(k)) map.set(k, emptyAgg(k));
    addToAgg(map.get(k), l);
  });
  return [...map.values()];
}

const byRecue = (a, b) => b.recue - a.recue || a.key.localeCompare(b.key, 'fr');

/* Arbre à deux niveaux (ex. dénomination > code déchet) */
function buildTree(lines, parentFn, childFn) {
  const groups = new Map();
  lines.forEach((l) => {
    const k = parentFn(l);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(l);
  });
  const tree = [];
  groups.forEach((arr, k) => {
    const node = totals(arr, k);
    node.children = groupBy(arr, childFn).sort(byRecue);
    tree.push(node);
  });
  return tree.sort(byRecue);
}

/* Matrice dénomination × code de traitement (quantité réceptionnée) */
function buildMatrix(lines) {
  const colKeys = [...new Set(lines.map((l) => l.codeKey))].sort(codeSort);
  const rowMap = new Map();
  lines.forEach((l) => {
    if (!rowMap.has(l.denomination)) {
      rowMap.set(l.denomination, { key: l.denomination, codes: new Set(), cells: {}, recue: 0, n: 0 });
    }
    const row = rowMap.get(l.denomination);
    row.cells[l.codeKey] = (row.cells[l.codeKey] || 0) + l.qteRecue;
    row.codes.add(l.codeDechet);
    row.recue += l.qteRecue;
    row.n += 1;
  });
  return { colKeys, rows: [...rowMap.values()].sort(byRecue) };
}
