/* Interface du tableau de bord. Toutes les données restent dans le navigateur. */
(function () {
  'use strict';

  const STORAGE_KEY = 'dechets-campagne-2026:dataset';

  const TABS = [
    { id: 'synthese', label: 'Synthèse' },
    { id: 'denominations', label: 'Par dénomination' },
    { id: 'expediteurs', label: 'Par expéditeur' },
    { id: 'matrice', label: 'Dénomination × traitement' },
    { id: 'valorisation', label: 'Valorisation' },
    { id: 'lignes', label: 'Lignes' },
    { id: 'donnees', label: 'Données importées' }
  ];

  const MULTI_CONFIG = [
    { key: 'expediteur', label: 'Expéditeur (nom usuel)', all: 'Tous les expéditeurs', noun: 'expéditeur(s)' },
    { key: 'expediteurRS', label: 'Expéditeur (raison sociale)', all: 'Toutes les raisons sociales', noun: 'raison(s) sociale(s)' },
    { key: 'lieuCollecte', label: 'Lieu de collecte', all: 'Tous les lieux de collecte', noun: 'lieu(x) de collecte' },
    { key: 'entrepriseTravaux', label: 'Entreprise de travaux', all: 'Toutes les entreprises', noun: 'entreprise(s)' },
    { key: 'destination', label: 'Destination (nom usuel)', all: 'Toutes les destinations', noun: 'destination(s)' }
  ];

  const TREES = {
    denominations: {
      parent: (l) => l.denomination,
      child: (l) => l.codeDechet,
      parentLabel: 'Dénomination usuelle',
      childLabel: 'Code déchet',
      noun: 'dénomination(s)'
    },
    expediteurs: {
      parent: (l) => l.expediteur,
      child: (l) => l.denomination,
      parentLabel: 'Expéditeur',
      childLabel: 'Dénomination usuelle',
      noun: 'expéditeur(s)'
    }
  };

  const SORT_GETTERS = {
    dateExpedition: (l) => l.dateExpedition,
    numero: (l) => l.numero,
    statut: (l) => l.statut,
    expediteur: (l) => l.expediteur,
    denomination: (l) => l.denomination,
    codeTraitement: (l) => l.codeKey,
    lieuCollecte: (l) => l.lieuCollecte,
    entrepriseTravaux: (l) => l.entrepriseTravaux,
    destination: (l) => l.destination,
    qteRecue: (l) => l.qteRecue,
    qteRefusee: (l) => l.qteRefusee,
    qteAcceptee: (l) => l.qteAcceptee
  };
  const NUMERIC_KEYS = ['qteRecue', 'qteRefusee', 'qteAcceptee'];
  const CAT_LABEL = {
    valorise: 'Valorisation (R)',
    elimine: 'Élimination (D)',
    autre: 'Non traité / en cours'
  };

  const state = {
    dataset: null,
    options: {},
    filters: defaultFilters(),
    msearch: Object.fromEntries(MULTI_CONFIG.map((c) => [c.key, ''])),
    openMulti: null,
    tab: 'synthese',
    open: { denominations: new Set(), expediteurs: new Set() },
    sort: { key: 'dateExpedition', dir: -1 },
    current: []
  };

  const nfInt = new Intl.NumberFormat('fr-FR');
  const nf2 = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const nf3 = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
  const nfPct = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });

  const $ = (sel) => document.querySelector(sel);
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const tonnes = (n) => `${nf2.format(n)} t`;
  const cellNum = (v) => (v ? nf3.format(v) : '–');
  const pct = (part, total) => (total > 0 ? `${nfPct.format((100 * part) / total)} %` : '–');
  const dateFR = (iso) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
  };
  const stamp = () => new Date().toISOString().slice(0, 10);
  const uniq = (arr) => [...new Set(arr)].sort((a, b) => a.localeCompare(b, 'fr'));
  const debounce = (fn, ms) => {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  };

  /* ---------- Import, persistance, export ---------- */

  async function handleFile(file) {
    if (!file) return;
    try {
      const prep = await prepareImport(file);
      const ds = buildDataset(prep.text);
      const notes = prep.notes.slice();
      notes.push('Colonnes indispensables reconnues.');
      notes.push(`${nfInt.format(ds.lines.length)} lignes importées.`);
      ds.name = file.name;
      ds.importedAt = new Date().toISOString();
      ds.notes = notes;
      state.dataset = ds;
      state.filters = defaultFilters();
      state.openMulti = null;
      MULTI_CONFIG.forEach((c) => { state.msearch[c.key] = ''; });
      state.open = { denominations: new Set(), expediteurs: new Set() };
      state.tab = 'synthese';
      rebuildFilterOptions();
      const saved = saveDataset(prep.text, ds.name, ds.importedAt, notes);
      flash('ok', `« ${ds.name} » importé. ${notes.length} vérification(s) effectuée(s), voir « Données importées ».` +
        (saved ? '' : ' Fichier trop volumineux pour être mémorisé : il disparaîtra au rechargement de la page.'));
    } catch (err) {
      flash('error', err && err.message ? err.message : String(err));
    }
    render();
  }

  function saveDataset(text, name, importedAt, notes) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ name, importedAt, text, notes }));
      return true;
    } catch (err) {
      try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* stockage indisponible */ }
      return false;
    }
  }

  function loadDataset() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      const ds = buildDataset(saved.text);
      ds.name = saved.name;
      ds.importedAt = saved.importedAt;
      ds.notes = saved.notes || [];
      state.dataset = ds;
      rebuildFilterOptions();
    } catch (err) {
      console.warn('Données précédentes non restaurées :', err);
    }
  }

  function clearDataset() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (err) { /* ignore */ }
    state.dataset = null;
    state.filters = defaultFilters();
    state.openMulti = null;
    state.open = { denominations: new Set(), expediteurs: new Set() };
    rebuildFilterOptions();
    flash('ok', 'Données effacées de ce navigateur.');
    render();
  }

  function rebuildFilterOptions() {
    const lines = state.dataset ? state.dataset.lines : [];
    fillSelect('#fDenom', 'Toutes les dénominations', uniq(lines.map((l) => l.denomination)));
    fillSelect('#fStatut', 'Tous les statuts', uniq(lines.map((l) => l.statut)));
    fillSelect('#fType', 'Tous les types', uniq(lines.map((l) => l.type)));
    state.options = {};
    MULTI_CONFIG.forEach((cfg) => {
      const counts = new Map();
      lines.forEach((l) => counts.set(l[cfg.key], (counts.get(l[cfg.key]) || 0) + 1));
      state.options[cfg.key] = [...counts]
        .map(([name, n]) => ({ name, n }))
        .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
    });
  }

  function fillSelect(sel, allLabel, values) {
    $(sel).innerHTML = `<option value="">${esc(allLabel)}</option>` +
      values.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
  }

  let flashTimer = null;
  function flash(type, text) {
    const el = $('#flash');
    el.textContent = text;
    el.className = `flash flash-${type}`;
    el.hidden = false;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { el.hidden = true; }, 8000);
  }

  function downloadCSV(filename, headers, rows) {
    const cell = (v) => {
      if (typeof v === 'number') {
        if (!Number.isFinite(v)) return '';
        return Number.isInteger(v) ? String(v) : v.toFixed(3).replace('.', ',');
      }
      const s = v == null ? '' : String(v);
      return /[";\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const body = [headers, ...rows].map((r) => r.map(cell).join(';')).join('\r\n');
    const url = URL.createObjectURL(new Blob(['\uFEFF' + body], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const aggCsvRow = (parent, child, a) => [
    parent, child, a.n, a.recue, a.valorise, a.elimine, a.autre, a.recue ? (100 * a.valorise) / a.recue : ''
  ];

  function exportTree(kind) {
    const cfg = TREES[kind];
    const rows = [];
    buildTree(state.current, cfg.parent, cfg.child).forEach((p) => {
      rows.push(aggCsvRow(p.key, '', p));
      p.children.forEach((c) => rows.push(aggCsvRow(p.key, c.key, c)));
    });
    downloadCSV(`${kind}-${stamp()}.csv`,
      [cfg.parentLabel, cfg.childLabel, 'Lignes', 'Réceptionné (t)', 'Valorisé (t)', 'Éliminé (t)', 'Non traité (t)', '% valorisé'],
      rows);
  }

  function exportLines() {
    const rows = sortLines(state.current, state.sort).map((l) => [
      l.dateExpedition, l.numero, l.identifiant, l.type, l.statut, l.expediteur, l.expediteurRS,
      l.denomination, l.codeDechet, l.codeKey, l.lieuCollecte, l.entrepriseTravaux, l.destination,
      l.qteRecue, l.qteRefusee, l.qteAcceptee, CAT_LABEL[l.categorie]
    ]);
    downloadCSV(`lignes-${stamp()}.csv`, [
      'Date expédition', 'N° bordereau', 'Identifiant', 'Type', 'Statut', 'Expéditeur (nom usuel)', 'Expéditeur (raison sociale)',
      'Dénomination usuelle', 'Code déchet', 'Code(s) traitement réalisé(s)', 'Lieu de collecte', 'Entreprise de travaux',
      'Destination (nom usuel)', 'Réceptionné (t)', 'Refusé (t)', 'Accepté / traité (t)', 'Catégorie'
    ], rows);
  }

  /* ---------- Filtres ---------- */

  function buildMultiSkeleton() {
    $('#multiFilters').innerHTML = MULTI_CONFIG.map((cfg) => `
      <div class="filter filter-multi" data-mwrap="${cfg.key}">
        <span class="filter-label">${esc(cfg.label)}</span>
        <div class="multi">
          <button type="button" class="multi-btn" data-mtoggle="${cfg.key}" aria-haspopup="true" aria-expanded="false"></button>
          <div class="multi-panel" data-mpanel="${cfg.key}" hidden>
            <input type="search" data-msearch="${cfg.key}" placeholder="Rechercher…" autocomplete="off">
            <div class="multi-tools">
              <button type="button" class="link" data-mall="${cfg.key}">Tout sélectionner (visibles)</button>
              <button type="button" class="link" data-mnone="${cfg.key}">Tout effacer</button>
            </div>
            <ul class="multi-list" data-mlist="${cfg.key}"></ul>
          </div>
        </div>
      </div>`).join('');
  }

  function multiVisible(key) {
    const q = state.msearch[key].trim().toLowerCase();
    return (state.options[key] || []).filter((o) => !q || o.name.toLowerCase().includes(q));
  }

  function renderMulti() {
    MULTI_CONFIG.forEach((cfg) => {
      const sel = state.filters.multi[cfg.key];
      const total = (state.options[cfg.key] || []).length;
      const open = state.openMulti === cfg.key;
      const btn = $(`[data-mtoggle="${cfg.key}"]`);
      btn.textContent = sel.size === 0
        ? `${cfg.all} (${total})`
        : (sel.size === 1 ? [...sel][0] : `${sel.size} sélectionnés`);
      btn.setAttribute('aria-expanded', String(open));
      $(`[data-mpanel="${cfg.key}"]`).hidden = !open;
      if (open) {
        $(`[data-mlist="${cfg.key}"]`).innerHTML = multiVisible(cfg.key).map((o) => `
          <li>
            <label><input type="checkbox" data-mopt="${cfg.key}" data-mvalue="${esc(o.name)}"${sel.has(o.name) ? ' checked' : ''}><span>${esc(o.name)}</span></label>
            <span class="count">${nfInt.format(o.n)}</span>
          </li>`).join('') || '<li class="muted">Aucune valeur ne correspond.</li>';
      }
    });
  }

  function syncControls() {
    const f = state.filters;
    setVal('#fDenom', f.denomination);
    setVal('#fStatut', f.statut);
    setVal('#fType', f.type);
    setVal('#fDateFrom', f.dateFrom);
    setVal('#fDateTo', f.dateTo);
    setVal('#fSearch', f.search);
  }

  function setVal(sel, value) {
    const el = $(sel);
    if (el !== document.activeElement && el.value !== value) el.value = value;
  }

  /* ---------- Rendu général ---------- */

  function renderTabs(active) {
    const hasData = Boolean(state.dataset);
    $('#tabs').innerHTML = TABS.map((tab) => {
      const disabled = !hasData && tab.id !== 'donnees';
      return `<button class="tab${tab.id === active ? ' active' : ''}" type="button" data-tab="${tab.id}"${disabled ? ' disabled' : ''}>${esc(tab.label)}</button>`;
    }).join('');
  }

  function render() {
    const ds = state.dataset;
    const tabId = ds ? state.tab : 'donnees';
    document.body.classList.toggle('no-data', !ds);
    $('#sourceInfo').textContent = ds
      ? `Source : ${ds.name} · importé le ${new Date(ds.importedAt).toLocaleString('fr-FR')} · ${nfInt.format(ds.lines.length)} lignes`
      : 'Aucune donnée importée. Importe l’export de l’onglet « Import Track Déchet » (CSV ou .xlsx).';
    renderTabs(tabId);
    syncControls();
    renderMulti();
    const lines = ds ? applyFilters(ds.lines, state.filters) : [];
    state.current = lines;
    const info = ds && tabId !== 'donnees'
      ? `<p class="muted info">${nfInt.format(lines.length)} ligne(s) sur ${nfInt.format(ds.lines.length)} correspondent aux filtres en cours.</p>`
      : '';
    $('#view').innerHTML = info + VIEWS[tabId](lines);
  }

  /* ---------- Briques d'affichage ---------- */

  function badge(key) {
    return `<span class="badge badge-${catOfKey(key)}">${esc(key)}</span>`;
  }

  function stackBar(a) {
    if (!a.recue) return '<div class="stack"></div>';
    const seg = (cls, v, label) => (v > 0
      ? `<span class="seg ${cls}" style="width:${((100 * v) / a.recue).toFixed(2)}%" title="${label} : ${tonnes(v)}"></span>`
      : '');
    return `<div class="stack">${seg('seg-valorise', a.valorise, 'Valorisé')}${seg('seg-elimine', a.elimine, 'Éliminé')}${seg('seg-autre', a.autre, 'Non traité')}</div>`;
  }

  const LEGEND = '<div class="legend">' +
    '<span><i class="seg-valorise"></i>Valorisé (code R)</span>' +
    '<span><i class="seg-elimine"></i>Éliminé (code D)</span>' +
    '<span><i class="seg-autre"></i>Non traité / en cours</span>' +
    '</div>';

  function kpi(label, value, sub, cls) {
    return `<div class="kpi ${cls || ''}"><div class="kpi-label">${esc(label)}</div><div class="kpi-value">${value}</div><div class="kpi-sub">${sub}</div></div>`;
  }

  const AGG_HEAD = '<th class="num">Lignes</th><th class="num">Réceptionné (t)</th><th class="num">Valorisé (t)</th>' +
    '<th class="num">Éliminé (t)</th><th class="num">Non traité (t)</th><th class="num">% valorisé</th><th>Répartition</th>';

  function aggRow(label, a, level, cls) {
    return `<tr class="lvl-${level}${cls ? ' ' + cls : ''}">
      <th scope="row">${label}</th>
      <td class="num">${nfInt.format(a.n)}</td>
      <td class="num strong">${nf2.format(a.recue)}</td>
      <td class="num c-valo">${nf2.format(a.valorise)}</td>
      <td class="num c-elim">${nf2.format(a.elimine)}</td>
      <td class="num c-autre">${nf2.format(a.autre)}</td>
      <td class="num">${pct(a.valorise, a.recue)}</td>
      <td class="bar-cell">${stackBar(a)}</td>
    </tr>`;
  }

  function EMPTY(cols, msg) {
    return `<tr><td colspan="${cols}" class="muted">${msg || 'Aucune ligne pour les filtres en cours.'}</td></tr>`;
  }

  function barList(aggs, limit) {
    const list = aggs.slice(0, limit);
    if (!list.length) return '<p class="muted">Aucune donnée pour les filtres en cours.</p>';
    const max = Math.max(...list.map((a) => a.recue));
    return list.map((a) => `
      <div class="bar-row">
        <div class="bar-label" title="${esc(a.key)}">${esc(a.key)}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${max > 0 ? ((100 * a.recue) / max).toFixed(1) : 0}%"></div></div>
        <div class="bar-value">${tonnes(a.recue)}</div>
      </div>`).join('');
  }

  /* ---------- Vues ---------- */

  function viewSynthese(lines) {
    const T = totals(lines);
    const dens = groupBy(lines, (l) => l.denomination).sort(byRecue);
    const exps = groupBy(lines, (l) => l.expediteur).sort(byRecue);
    return `
      <div class="kpis">
        ${kpi('Réceptionné (réel)', tonnes(T.recue), `Quantité réceptionnée nette · ${nfInt.format(T.n)} lignes`, '')}
        ${kpi('Valorisé', tonnes(T.valorise), `${pct(T.valorise, T.recue)} du réceptionné · codes R`, 'kpi-valo')}
        ${kpi('Éliminé', tonnes(T.elimine), `${pct(T.elimine, T.recue)} du réceptionné · codes D`, 'kpi-elim')}
        ${kpi('Non traité / en cours', tonnes(T.autre), `${pct(T.autre, T.recue)} · ni R ni D`, 'kpi-autre')}
        ${kpi('Refusé', tonnes(T.refusee), `${pct(T.refusee, T.recue)} du réceptionné · accepté / traité : ${tonnes(T.acceptee)}`, 'kpi-danger')}
        ${kpi('Expéditeurs', nfInt.format(exps.length), `${nfInt.format(dens.length)} dénominations distinctes`, '')}
      </div>
      <section class="card">
        <h2>Répartition de la quantité réceptionnée</h2>
        ${stackBar(T)}
        ${LEGEND}
      </section>
      <div class="grid-2">
        <section class="card"><h2>Top 12 dénominations</h2>${barList(dens, 12)}</section>
        <section class="card"><h2>Top 12 expéditeurs</h2>${barList(exps, 12)}</section>
      </div>`;
  }

  function viewTree(kind, lines) {
    const cfg = TREES[kind];
    const tree = buildTree(lines, cfg.parent, cfg.child);
    const T = totals(lines);
    const open = state.open[kind];
    const body = tree.map((p) => {
      const isOpen = open.has(p.key);
      let html = aggRow(
        `<button class="toggle" type="button" data-action="toggle" data-kind="${kind}" data-key="${esc(p.key)}" aria-expanded="${isOpen}">${isOpen ? '▾' : '▸'}</button>${esc(p.key)}`,
        p, 0);
      if (isOpen) html += p.children.map((c) => aggRow(esc(c.key), c, 1)).join('');
      return html;
    }).join('');
    return `
      <div class="toolbar">
        <span class="muted">${nfInt.format(tree.length)} ${cfg.noun} · ${tonnes(T.recue)} réceptionnées</span>
        <div class="toolbar-actions">
          <button class="btn" type="button" data-action="expand" data-kind="${kind}">Tout déplier</button>
          <button class="btn" type="button" data-action="collapse" data-kind="${kind}">Tout replier</button>
          <button class="btn" type="button" data-action="export-tree" data-kind="${kind}">Exporter (CSV)</button>
        </div>
      </div>
      ${LEGEND}
      <div class="table-wrap">
        <table class="grid">
          <thead><tr><th>${esc(cfg.parentLabel)} / ${esc(cfg.childLabel)}</th>${AGG_HEAD}</tr></thead>
          <tbody>${tree.length ? body + aggRow('Total', T, 0, 'total') : EMPTY(8)}</tbody>
        </table>
      </div>`;
  }

  function viewMatrice(lines) {
    const { colKeys, rows } = buildMatrix(lines);
    const T = totals(lines);
    const colTotals = {};
    lines.forEach((l) => { colTotals[l.codeKey] = (colTotals[l.codeKey] || 0) + l.qteRecue; });
    const head = colKeys.map((k) => `<th class="num">${badge(k)}</th>`).join('');
    const body = rows.map((r) => `<tr>
        <th scope="row">${esc(r.key)}<span class="sub">${esc([...r.codes].join(', '))}</span></th>
        ${colKeys.map((k) => `<td class="num">${cellNum(r.cells[k])}</td>`).join('')}
        <td class="num strong">${nf2.format(r.recue)}</td>
      </tr>`).join('');
    const foot = `<tr><th scope="row">Total</th>${colKeys.map((k) => `<td class="num">${cellNum(colTotals[k])}</td>`).join('')}<td class="num">${nf2.format(T.recue)}</td></tr>`;
    const codeAggs = groupBy(lines, (l) => l.codeKey).sort((a, b) => codeSort(a.key, b.key));
    const codeRows = codeAggs.map((a) => `<tr>
        <th scope="row">${badge(a.key)}</th>
        <td>${CAT_LABEL[catOfKey(a.key)]}</td>
        <td class="num">${nfInt.format(a.n)}</td>
        <td class="num strong">${nf2.format(a.recue)}</td>
        <td class="num">${pct(a.recue, T.recue)}</td>
      </tr>`).join('');
    return `
      <section class="card">
        <h2>Quantité réceptionnée par dénomination et code de traitement</h2>
        <p class="muted">Chaque cellule additionne la quantité réceptionnée nette (t) des lignes concernées. Colonnes R : valorisation ; colonnes D : élimination.</p>
        <div class="table-wrap">
          <table class="grid">
            <thead><tr><th>Dénomination usuelle<span class="sub">Code(s) déchet</span></th>${head}<th class="num">Total (t)</th></tr></thead>
            <tbody>${rows.length ? body : EMPTY(colKeys.length + 2)}</tbody>
            <tfoot>${rows.length ? foot : ''}</tfoot>
          </table>
        </div>
      </section>
      <section class="card">
        <h2>Par code de traitement réalisé</h2>
        <div class="table-wrap small">
          <table class="grid">
            <thead><tr><th>Code(s)</th><th>Catégorie</th><th class="num">Lignes</th><th class="num">Réceptionné (t)</th><th class="num">% du réceptionné</th></tr></thead>
            <tbody>${codeRows || EMPTY(5)}</tbody>
          </table>
        </div>
      </section>`;
  }

  function viewValorisation(lines) {
    const valo = lines.filter((l) => l.categorie === 'valorise');
    const T = totals(lines);
    const V = totals(valo);
    const allExp = new Map(groupBy(lines, (l) => l.expediteur).map((a) => [a.key, a]));
    const expAggs = groupBy(valo, (l) => l.expediteur).sort(byRecue);
    const codeAggs = groupBy(valo, (l) => l.codeKey).sort((a, b) => codeSort(a.key, b.key));
    const expRows = expAggs.map((a) => {
      const all = allExp.get(a.key);
      return `<tr>
        <th scope="row">${esc(a.key)}</th>
        <td class="num">${nfInt.format(a.n)}</td>
        <td class="num strong c-valo">${nf2.format(a.recue)}</td>
        <td class="num">${nf2.format(all.recue)}</td>
        <td class="num">${pct(a.recue, all.recue)}</td>
      </tr>`;
    }).join('');
    const codeRows = codeAggs.map((a) => `<tr>
        <th scope="row">${badge(a.key)}</th>
        <td class="num">${nfInt.format(a.n)}</td>
        <td class="num strong c-valo">${nf2.format(a.recue)}</td>
        <td class="num">${pct(a.recue, T.recue)}</td>
      </tr>`).join('');
    const detail = sortLines(valo, { key: 'dateExpedition', dir: -1 }).map((l) => `<tr>
        <td>${dateFR(l.dateExpedition)}</td>
        <td>${esc(l.numero)}</td>
        <td>${esc(l.expediteur)}</td>
        <td>${esc(l.denomination)}</td>
        <td>${esc(l.codeDechet)}</td>
        <td>${badge(l.codeKey)}</td>
        <td>${esc(l.destination)}</td>
        <td class="num strong">${nf3.format(l.qteRecue)}</td>
      </tr>`).join('');
    return `
      <div class="kpis">
        ${kpi('Quantité valorisée', tonnes(V.recue), `${pct(V.recue, T.recue)} du réceptionné · ${nfInt.format(V.n)} lignes`, 'kpi-valo')}
        ${kpi('Expéditeurs concernés', nfInt.format(expAggs.length), `sur ${nfInt.format(allExp.size)} expéditeurs`, 'kpi-valo')}
        ${kpi('Codes R utilisés', nfInt.format(codeAggs.length), codeAggs.map((a) => esc(a.key)).join(', ') || '–', 'kpi-valo')}
      </div>
      <div class="grid-2">
        <section class="card">
          <h2>Par expéditeur</h2>
          <div class="table-wrap small"><table class="grid">
            <thead><tr><th>Expéditeur</th><th class="num">Lignes</th><th class="num">Valorisé (t)</th><th class="num">Réceptionné (t)</th><th class="num">% valorisé</th></tr></thead>
            <tbody>${expRows || EMPTY(5)}</tbody>
          </table></div>
        </section>
        <section class="card">
          <h2>Par code de valorisation</h2>
          <div class="table-wrap small"><table class="grid">
            <thead><tr><th>Code R</th><th class="num">Lignes</th><th class="num">Valorisé (t)</th><th class="num">% du réceptionné</th></tr></thead>
            <tbody>${codeRows || EMPTY(4)}</tbody>
          </table></div>
        </section>
      </div>
      <section class="card">
        <h2>Détail des lignes valorisées</h2>
        <div class="table-wrap"><table class="grid">
          <thead><tr><th>Date exp.</th><th>N° bordereau</th><th>Expéditeur</th><th>Dénomination</th><th>Code déchet</th><th>Code traitement</th><th>Destination</th><th class="num">Réceptionné (t)</th></tr></thead>
          <tbody>${detail || EMPTY(8)}</tbody>
        </table></div>
      </section>`;
  }

  function viewLignes(lines) {
    const sorted = sortLines(lines, state.sort);
    const th = (key, label, cls) => {
      const active = state.sort.key === key;
      const arrow = active ? (state.sort.dir > 0 ? ' ▲' : ' ▼') : '';
      return `<th class="${cls || ''}${active ? ' sorted' : ''} sortable" data-action="sort" data-key="${key}">${esc(label)}${arrow}</th>`;
    };
    const rows = sorted.map((l) => `<tr>
        <td>${dateFR(l.dateExpedition)}</td>
        <td>${esc(l.numero)}</td>
        <td>${esc(l.statut)}</td>
        <td>${esc(l.expediteur)}<span class="sub">${esc(l.expediteurRS)}</span></td>
        <td>${esc(l.denomination)}<span class="sub">${esc(l.codeDechet)}</span></td>
        <td>${badge(l.codeKey)}</td>
        <td>${esc(l.destination)}</td>
        <td>${esc(l.lieuCollecte)}</td>
        <td>${esc(l.entrepriseTravaux)}</td>
        <td class="num strong">${cellNum(l.qteRecue)}</td>
        <td class="num">${cellNum(l.qteRefusee)}</td>
        <td class="num">${cellNum(l.qteAcceptee)}</td>
      </tr>`).join('');
    return `
      <div class="toolbar">
        <span class="muted">${nfInt.format(lines.length)} ligne(s) · cliquer sur un en-tête pour trier</span>
        <div class="toolbar-actions">
          <button class="btn" type="button" data-action="export-lines">Exporter la vue (CSV)</button>
        </div>
      </div>
      <div class="table-wrap">
        <table class="grid">
          <thead><tr>
            ${th('dateExpedition', 'Date exp.')}
            ${th('numero', 'N° bordereau')}
            ${th('statut', 'Statut')}
            ${th('expediteur', 'Expéditeur')}
            ${th('denomination', 'Dénomination / code déchet')}
            ${th('codeTraitement', 'Code traitement')}
            ${th('destination', 'Destination')}
            ${th('lieuCollecte', 'Lieu de collecte')}
            ${th('entrepriseTravaux', 'Entreprise de travaux')}
            ${th('qteRecue', 'Réceptionné (t)', 'num')}
            ${th('qteRefusee', 'Refusé (t)', 'num')}
            ${th('qteAcceptee', 'Accepté / traité (t)', 'num')}
          </tr></thead>
          <tbody>${rows || EMPTY(12)}</tbody>
        </table>
      </div>`;
  }

  function summarize(ds) {
    const dates = ds.lines.map((l) => l.dateExpedition).filter(Boolean).sort();
    return {
      lignes: ds.lines.length,
      expediteurs: new Set(ds.lines.map((l) => l.expediteur)).size,
      denominations: new Set(ds.lines.map((l) => l.denomination)).size,
      periode: dates.length ? `${dateFR(dates[0])} → ${dateFR(dates[dates.length - 1])}` : '–',
      separateur: ds.delimiter === '\t' ? 'tabulation' : `« ${ds.delimiter} »`
    };
  }

  function viewDonnees() {
    const ds = state.dataset;
    const s = ds ? summarize(ds) : null;
    const facts = ds
      ? `<dl class="facts">
          <dt>Fichier</dt><dd>${esc(ds.name)}</dd>
          <dt>Importé le</dt><dd>${esc(new Date(ds.importedAt).toLocaleString('fr-FR'))}</dd>
          <dt>Lignes</dt><dd>${nfInt.format(s.lignes)}</dd>
          <dt>Expéditeurs</dt><dd>${nfInt.format(s.expediteurs)}</dd>
          <dt>Dénominations</dt><dd>${nfInt.format(s.denominations)}</dd>
          <dt>Période d'expédition</dt><dd>${esc(s.periode)}</dd>
          <dt>Séparateur (données)</dt><dd>${esc(s.separateur)}</dd>
        </dl>
        <div class="toolbar"><span></span>
          <button class="btn btn-danger" type="button" data-action="clear">Effacer les données de ce navigateur</button>
        </div>`
      : '<p class="muted">Aucune donnée importée pour le moment.</p>';
    const notes = ds && ds.notes && ds.notes.length
      ? `<ul class="report">${ds.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>`
      : '<p class="muted">Aucune vérification enregistrée.</p>';
    const cols = ds
      ? `<ul class="cols">${Object.keys(FIELD_DEFS).map((f) => {
          const ok = ds.found[f];
          return `<li class="${ok ? 'ok' : 'ko'}">${ok ? '✓' : '✗'} ${esc(FIELD_DEFS[f])}</li>`;
        }).join('')}</ul>`
      : '<p class="muted">Importe un fichier pour vérifier les colonnes.</p>';
    return `
      <section class="card">
        <h2>Fichier source</h2>
        ${facts}
        <div class="dropzone" data-action="pick" role="button" tabindex="0">
          <p><strong>Glisse le fichier ici</strong>, ou clique pour le choisir.</p>
          <p class="muted">CSV ou classeur Excel .xlsx (premier onglet « Import Track Déchet »). Ce fichier remplace les données actuelles.</p>
        </div>
      </section>
      <section class="card">
        <h2>Vérification du format</h2>
        ${notes}
        <p class="muted">Acceptés : CSV (UTF-8, Windows-1252 ou UTF-16 ; séparateur virgule, point-virgule ou tabulation) et .xlsx. Un fichier non conforme est converti automatiquement en CSV UTF-8 à virgules. Les anciens .xls et les .ods doivent être réenregistrés en .xlsx ou exportés en CSV.</p>
      </section>
      <section class="card">
        <h2>Colonnes reconnues</h2>
        ${cols}
        <p class="muted">Les colonnes sont retrouvées par leur nom (sans tenir compte de la casse, des accents ni des espaces). Quatre colonnes sont indispensables : Quantité réceptionnée nette, Code(s) de traitement réalisé(s), Dénomination usuelle, Expéditeur - Nom usuel.</p>
      </section>`;
  }

  /* ---------- Tri et actions de vue ---------- */

  function sortLines(lines, sort) {
    const get = SORT_GETTERS[sort.key] || SORT_GETTERS.dateExpedition;
    return [...lines].sort((a, b) => {
      const x = get(a);
      const y = get(b);
      const c = typeof x === 'number' ? x - y : String(x || '').localeCompare(String(y || ''), 'fr', { numeric: true });
      return c * sort.dir || a.id - b.id;
    });
  }

  function setSort(key) {
    if (state.sort.key === key) state.sort = { key, dir: -state.sort.dir };
    else state.sort = { key, dir: NUMERIC_KEYS.includes(key) ? -1 : 1 };
    render();
  }

  function toggleOpen(kind, key) {
    const set = state.open[kind];
    if (set.has(key)) set.delete(key);
    else set.add(key);
    render();
  }

  const VIEWS = {
    synthese: viewSynthese,
    denominations: (lines) => viewTree('denominations', lines),
    expediteurs: (lines) => viewTree('expediteurs', lines),
    matrice: viewMatrice,
    valorisation: viewValorisation,
    lignes: viewLignes,
    donnees: viewDonnees
  };

  /* ---------- Événements ---------- */

  function wire() {
    $('#btnImport').addEventListener('click', () => $('#fileInput').click());
    $('#fileInput').addEventListener('change', (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      handleFile(file);
    });

    document.addEventListener('dragover', (e) => {
      e.preventDefault();
      document.body.classList.add('dragging');
    });
    document.addEventListener('dragleave', (e) => {
      if (!e.relatedTarget) document.body.classList.remove('dragging');
    });
    document.addEventListener('drop', (e) => {
      e.preventDefault();
      document.body.classList.remove('dragging');
      const file = e.dataTransfer && e.dataTransfer.files[0];
      if (file) handleFile(file);
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && state.openMulti) {
        state.openMulti = null;
        renderMulti();
      }
    });
    document.addEventListener('click', (e) => {
      if (state.openMulti && !e.target.closest(`[data-mwrap="${state.openMulti}"]`)) {
        state.openMulti = null;
        renderMulti();
      }
    });

    /* Filtres à choix multiples */
    $('#multiFilters').addEventListener('click', (e) => {
      const t = e.target.closest('[data-mtoggle],[data-mall],[data-mnone]');
      if (!t) return;
      if (t.dataset.mtoggle) {
        const k = t.dataset.mtoggle;
        state.openMulti = state.openMulti === k ? null : k;
        renderMulti();
        if (state.openMulti) $(`[data-msearch="${k}"]`).focus();
      } else if (t.dataset.mall) {
        const set = state.filters.multi[t.dataset.mall];
        multiVisible(t.dataset.mall).forEach((o) => set.add(o.name));
        render();
      } else if (t.dataset.mnone) {
        state.filters.multi[t.dataset.mnone].clear();
        render();
      }
    });
    $('#multiFilters').addEventListener('change', (e) => {
      const t = e.target;
      if (!t.matches('input[data-mopt]')) return;
      const set = state.filters.multi[t.dataset.mopt];
      if (t.checked) set.add(t.dataset.mvalue);
      else set.delete(t.dataset.mvalue);
      render();
    });
    $('#multiFilters').addEventListener('input', (e) => {
      const t = e.target;
      if (!t.matches('input[data-msearch]')) return;
      state.msearch[t.dataset.msearch] = t.value;
      renderMulti();
    });

    $('#tabs').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-tab]');
      if (!btn || btn.disabled) return;
      state.tab = btn.dataset.tab;
      render();
    });

    [['#fDenom', 'denomination'], ['#fStatut', 'statut'], ['#fType', 'type'], ['#fDateFrom', 'dateFrom'], ['#fDateTo', 'dateTo']]
      .forEach(([sel, key]) => {
        $(sel).addEventListener('change', (e) => {
          state.filters[key] = e.target.value;
          render();
        });
      });
    $('#fSearch').addEventListener('input', debounce(() => {
      state.filters.search = $('#fSearch').value;
      render();
    }, 180));
    $('#btnReset').addEventListener('click', () => {
      state.filters = defaultFilters();
      state.openMulti = null;
      MULTI_CONFIG.forEach((c) => { state.msearch[c.key] = ''; });
      document.querySelectorAll('[data-msearch]').forEach((i) => { i.value = ''; });
      render();
    });

    $('#view').addEventListener('click', (e) => {
      const el = e.target.closest('[data-action]');
      if (!el) return;
      const kind = el.dataset.kind;
      switch (el.dataset.action) {
        case 'pick':
          $('#fileInput').click();
          break;
        case 'clear':
          if (window.confirm('Effacer les données importées de ce navigateur ?')) clearDataset();
          break;
        case 'toggle':
          toggleOpen(kind, el.dataset.key);
          break;
        case 'expand':
          state.open[kind] = new Set(buildTree(state.current, TREES[kind].parent, TREES[kind].child).map((p) => p.key));
          render();
          break;
        case 'collapse':
          state.open[kind] = new Set();
          render();
          break;
        case 'export-tree':
          exportTree(kind);
          break;
        case 'sort':
          setSort(el.dataset.key);
          break;
        case 'export-lines':
          exportLines();
          break;
        default:
          break;
      }
    });
  }

  function init() {
    buildMultiSkeleton();
    wire();
    loadDataset();
    render();
  }

  init();
})();
