/* MyHub — manager.js
 * Page privilégiée (chrome://sine/content/MyHub/manager.html)
 * → accès direct à Services.prefs, IOUtils, PlacesUtils. Zéro bridge.
 *
 * Architecture hub : SECTIONS déclaratives. Ajouter une pref = une entrée.
 * Event Driven Only : Services.prefs.addObserver pour refléter les changements
 * externes (pas de polling).
 */

'use strict';

const TAG = '[MyHub]';

/* ═══════════════ Prefs utilisées ═══════════════ */

const PREFS = {
  homepage: 'browser.startup.homepage',
  startupPage: 'browser.startup.page',
  pinned: 'browser.newtabpage.pinned',
  maxRichResults: 'browser.urlbar.maxRichResults',
  topSitesRows: 'browser.newtabpage.activity-stream.topSitesRows',
  maxPerRow: 'browser.newtabpage.activity-stream.topSitesMaxSitesPerRow',
  backupPinned: 'MyHub.backup.pinned',
};

/* ═══════════════ Utilitaires ═══════════════ */

const Prefs = {
  getStr(p, d = '') {
    return Services.prefs.getStringPref(p, d);
  },
  setStr(p, v) {
    Services.prefs.setStringPref(p, v);
  },
  getInt(p, d = 0) {
    return Services.prefs.getIntPref(p, d);
  },
  setInt(p, v) {
    Services.prefs.setIntPref(p, v);
  },
  getBool(p, d = false) {
    return Services.prefs.getBoolPref(p, d);
  },
  setBool(p, v) {
    Services.prefs.setBoolPref(p, v);
  },
};

/* Anti-écho : nos propres writes déclenchent les observers → on filtre */
let suppressObserver = false;
const uiSyncers = new Map(); // pref → callback de rafraîchissement UI

function observePref(pref, syncFn) {
  uiSyncers.set(pref, syncFn);
  Services.prefs.addObserver(pref, {
    observe(subject, topic, name) {
      if (suppressObserver) return;
      try {
        uiSyncers.get(name)?.();
      } catch (e) {
        console.warn(TAG, 'sync UI:', e);
      }
    },
  });
}

/* Toast */
let toastTimer = null;
function toast(msg, warn = false) {
  const el = document.getElementById('mh-toast');
  el.textContent = msg;
  el.hidden = false;
  el.classList.toggle('warn', warn);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 2200);
}

/* ═══════════════ Favicons (mécanique URLBar-2.0) ═══════════════ */

const Favicon = {
  cache: {}, // clé → data:image/png;base64,...
  domainMap: {}, // domaine → clé

  async load() {
    const dirs = [
      PathUtils.join(PathUtils.profileDir, 'chrome', 'sine-mods', 'zen-about-favicons', 'icons'),
      PathUtils.join(PathUtils.profileDir, 'chrome', 'sine-mods', 'CustomFavicon', 'icons'),
    ];
    for (const dir of dirs) {
      try {
        if (!(await IOUtils.exists(dir))) continue;
        for (const filePath of await IOUtils.getChildren(dir)) {
          if (!filePath.toLowerCase().endsWith('.png')) continue;
          const key = filePath
            .split(/[/\\]/)
            .pop()
            .replace(/\.png$/i, '')
            .toLowerCase();
          try {
            const bytes = await IOUtils.read(filePath);
            let binary = '';
            for (const b of bytes) binary += String.fromCharCode(b);
            this.cache[key] = 'data:image/png;base64,' + btoa(binary);
          } catch (e) {
            /* skip */
          }
        }
      } catch (e) {
        /* dossier manquant */
      }
    }
    // favicon-map.json — lookup domaine → icône
    try {
      const mapPath = PathUtils.join(PathUtils.profileDir, 'chrome', 'sine-mods', 'CustomFavicon', 'favicon-map.json');
      if (await IOUtils.exists(mapPath)) {
        const text = new TextDecoder().decode(await IOUtils.read(mapPath));
        const map = JSON.parse(text);
        for (const [domain, filename] of Object.entries(map.custom || {})) {
          this.domainMap[domain] = filename.replace(/\.png$/i, '').toLowerCase();
        }
      }
    } catch (e) {
      /* fallback générique */
    }
    console.log(`${TAG} favicons: ${Object.keys(this.cache).length} icônes, ${Object.keys(this.domainMap).length} domaines`);
  },

  forUrl(url, label) {
    if (!url) return null;
    let host = '';
    try {
      host = new URL(url).hostname.replace(/^www\./, '');
    } catch (e) {}
    if (this.domainMap[host] && this.cache[this.domainMap[host]]) {
      return this.cache[this.domainMap[host]];
    }
    if (host && this.cache[host.split('.')[0]]) {
      return this.cache[host.split('.')[0]];
    }
    // Fallback : première lettre du label
    return null;
  },
};

/* ═══════════════ Grille favoris ═══════════════ */

const Grid = {
  entries: [], // [{url, label, baseDomain?} | null]

  load() {
    try {
      this.entries = JSON.parse(Prefs.getStr(PREFS.pinned, '[]'));
    } catch (e) {
      console.warn(TAG, 'pinned JSON invalide, reset', e);
      this.entries = [];
    }
    if (!Array.isArray(this.entries)) this.entries = [];
  },

  /** Écriture live (le snapshot d'ouverture est figé dans sectionFavorites) */
  save() {
    suppressObserver = true;
    try {
      Prefs.setStr(PREFS.pinned, JSON.stringify(this.entries));
    } finally {
      suppressObserver = false;
    }
    toast('Favoris enregistrés ✓');
  },

  /** Fige l'état courant comme point de retour (appelé une fois, à l'ouverture) */
  snapshot() {
    Prefs.setStr(PREFS.backupPinned, Prefs.getStr(PREFS.pinned, '[]'));
  },

  restore() {
    const backup = Prefs.getStr(PREFS.backupPinned, '');
    if (!backup) return toast('Aucun snapshot disponible', true);
    suppressObserver = true;
    try {
      Prefs.setStr(PREFS.pinned, backup);
    } finally {
      suppressObserver = false;
    }
    this.load();
    renderGrid();
    toast('Grille du début de session restaurée ✓');
  },

  move(from, to) {
    const [item] = this.entries.splice(from, 1);
    this.entries.splice(to, 0, item);
    this.save();
    renderGrid();
  },

  add(url, label) {
    let baseDomain;
    try {
      baseDomain = new URL(url).hostname.replace(/^www\./, '');
    } catch (e) {}
    this.entries.push({ url, label: label || baseDomain || url, baseDomain });
    this.save();
    renderGrid();
  },

  edit(index, url, label) {
    const e = this.entries[index] || {};
    e.url = url;
    e.label = label;
    try {
      e.baseDomain = new URL(url).hostname.replace(/^www\./, '');
    } catch (err) {}
    this.entries[index] = e;
    this.save();
    renderGrid();
  },

  remove(index) {
    this.entries.splice(index, 1);
    this.save();
    renderGrid();
  },
};

/* ── Rendu grille + drag & drop HTML5 natif ── */

function renderGrid() {
  const gridEl = document.getElementById('mh-grid');
  gridEl.innerHTML = '';

  Grid.entries.forEach((entry, index) => {
    const tile = document.createElement('div');
    tile.className = 'mh-tile';
    tile.draggable = true;
    tile.dataset.index = index;

    const icon = Favicon.forUrl(entry?.url, entry?.label);
    if (icon) {
      const img = document.createElement('img');
      img.src = icon;
      tile.appendChild(img);
    } else {
      const letter = document.createElement('div');
      letter.className = 'mh-letter';
      letter.textContent = (entry?.label || '?').charAt(0).toUpperCase();
      tile.appendChild(letter);
    }

    const label = document.createElement('span');
    label.className = 'mh-label';
    label.textContent = entry?.label || '';
    label.title = entry?.url || '';
    tile.appendChild(label);

    // Actions edit / delete (visibles au hover via CSS)
    const actions = document.createElement('div');
    actions.className = 'mh-actions';
    const editBtn = document.createElement('button');
    editBtn.textContent = '✎';
    editBtn.title = 'Modifier';
    editBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const url = prompt('URL :', entry?.url || 'https://');
      if (url === null) return;
      const lbl = prompt('Label :', entry?.label || '');
      if (lbl === null) return;
      Grid.edit(index, url.trim(), lbl.trim());
    });
    const delBtn = document.createElement('button');
    delBtn.textContent = '✕';
    delBtn.title = 'Supprimer';
    delBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      Grid.remove(index);
    });
    actions.append(editBtn, delBtn);
    tile.appendChild(actions);

    // Drag & drop
    tile.addEventListener('dragstart', (ev) => {
      ev.dataTransfer.effectAllowed = 'move';
      ev.dataTransfer.setData('text/myhub-index', String(index));
      tile.classList.add('dragging');
    });
    tile.addEventListener('dragend', () => tile.classList.remove('dragging'));
    tile.addEventListener('dragover', (ev) => {
      ev.preventDefault();
      tile.classList.add('drag-over');
    });
    tile.addEventListener('dragleave', () => tile.classList.remove('drag-over'));
    tile.addEventListener('drop', (ev) => {
      ev.preventDefault();
      tile.classList.remove('drag-over');
      const from = parseInt(ev.dataTransfer.getData('text/myhub-index'), 10);
      const to = parseInt(tile.dataset.index, 10);
      if (!isNaN(from) && !isNaN(to) && from !== to) Grid.move(from, to);
    });

    gridEl.appendChild(tile);
  });

  // Tile "+"
  const addTile = document.createElement('div');
  addTile.className = 'mh-tile mh-tile-add';
  addTile.textContent = '+ Ajouter';
  addTile.addEventListener('click', () => {
    const url = prompt('URL du favori :', 'https://');
    if (!url || !url.trim()) return;
    const lbl = prompt('Label (optionnel) :', '');
    Grid.add(url.trim(), (lbl || '').trim());
  });
  gridEl.appendChild(addTile);
}

/* ═══════════════ Sections déclaratives ═══════════════ */

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node[k] = v;
  node.append(...children.filter(Boolean));
  return node;
}

function sectionHomepage(root) {
  const input = el('input', { type: 'url', id: 'mh-homepage' });
  input.value = Prefs.getStr(PREFS.homepage, '');
  const save = () => {
    suppressObserver = true;
    try {
      Prefs.setStr(PREFS.homepage, input.value.trim());
    } finally {
      suppressObserver = false;
    }
    toast("Page d'accueil enregistrée ✓");
  };
  input.addEventListener('change', save);

  const currentBtn = el('button', {
    className: 'mh-ghost',
    textContent: 'Utiliser la page courante',
    onclick: () => {
      const win = Services.wm.getMostRecentWindow('navigator:browser');
      const spec = win?.gBrowser?.selectedBrowser?.currentURI?.spec;
      if (spec) {
        input.value = spec;
        save();
      } else toast('Aucune fenêtre de navigation trouvée', true);
    },
  });

  const radio = el('div', { className: 'mh-radio' });
  const modes = [
    [0, 'Page vide'],
    [1, "Page d'accueil"],
    [3, 'Session précédente'],
    [4, 'Session + accueil'],
  ];
  const syncRadio = () => {
    radio.querySelectorAll('input').forEach((r) => {
      r.checked = parseInt(r.value, 10) === Prefs.getInt(PREFS.startupPage, 1);
    });
  };
  modes.forEach(([val, lbl]) => {
    const r = el('input', { type: 'radio', name: 'mh-startup', value: String(val) });
    r.addEventListener('change', () => {
      suppressObserver = true;
      try {
        Prefs.setInt(PREFS.startupPage, val);
      } finally {
        suppressObserver = false;
      }
      toast('Démarrage enregistré ✓');
    });
    radio.append(el('label', {}, r, lbl));
  });
  syncRadio();
  observePref(PREFS.homepage, () => {
    input.value = Prefs.getStr(PREFS.homepage, '');
  });
  observePref(PREFS.startupPage, syncRadio);

  // Info-bulle multi-onglets : visible uniquement au focus de l'input (pur CSS :focus-within)
  const tip = el('span', { className: 'mh-tip' }, 'Plusieurs onglets : séparer les URLs par un « | »');
  const wrap = el('span', { className: 'mh-input-wrap' }, input, tip);

  root.append(
    el('div', { className: 'mh-row' }, el('label', { textContent: "URL de la page d'accueil" }), wrap, currentBtn),
    el('div', { className: 'mh-row' }, el('label', { textContent: 'Au démarrage' }), radio),
  );
}

function sectionFavorites(root) {
  Grid.load(); // charge browser.newtabpage.pinned avant le premier rendu
  Grid.snapshot(); // fige l'état d'ouverture comme point de retour
  const gridEl = el('div', { className: 'mh-grid', id: 'mh-grid' });

  /* Slots : Lignes et Tiles/ligne sont DÉDUITS automatiquement (perRow = 8) */
  const slotsInput = el('input', { type: 'number', min: 1, max: 200 });
  slotsInput.value = Prefs.getInt(PREFS.maxRichResults, 22);
  const commitSlots = () => {
    const slots = Math.max(1, parseInt(slotsInput.value, 10) || 22);
    const rows = Math.max(1, Math.ceil(slots / 8));
    suppressObserver = true;
    try {
      Prefs.setInt(PREFS.maxRichResults, slots);
      Prefs.setInt(PREFS.topSitesRows, rows);
      Prefs.setInt(PREFS.maxPerRow, 8);
    } finally {
      suppressObserver = false;
    }
    toast(`Slots enregistrés ✓ (grille déduite : ${rows} lignes × 8)`);
  };
  slotsInput.addEventListener('change', commitSlots);
  observePref(PREFS.maxRichResults, () => {
    slotsInput.value = Prefs.getInt(PREFS.maxRichResults, 22);
  });

  // Bouton restore : SVG transparent, en bas à droite de la ligne Slots
  const restoreBtn = el('button', {
    className: 'mh-icon-btn',
    title: 'Restaurer la grille telle qu\u2019elle était à l\u2019ouverture de la page',
    onclick: () => Grid.restore(),
  });
  restoreBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 2.64-6.36L3 8"/><path d="M3 3v5h5"/></svg>';

  // Même info-bulle au focus que l'input homepage
  const slotsTip = el('span', { className: 'mh-tip' }, 'Lignes et tuiles/ligne du newtab sont déduites automatiquement (× 8 / ligne)');
  const slotsWrap = el('span', { className: 'mh-input-wrap' }, slotsInput, slotsTip);

  root.append(gridEl, el('div', { className: 'mh-row' }, el('label', { textContent: 'Slots (favoris max)' }), slotsWrap, restoreBtn));

  // Reflet des changements externes de la grille
  observePref(PREFS.pinned, () => {
    Grid.load();
    renderGrid();
  });
}

/* ═══════════════ Boot ═══════════════ */

const SECTIONS = [
  { id: 'homepage', title: 'Accueil & Démarrage', build: sectionHomepage },
  { id: 'favorites', title: 'Favoris', build: sectionFavorites },
];

(async function boot() {
  const root = document.getElementById('mh-sections');
  for (const s of SECTIONS) {
    const sec = el('section', { className: 'mh-section', id: `mh-${s.id}` });
    sec.append(el('h2', { textContent: s.title }));
    const body = el('div', {});
    s.build(body);
    sec.append(body);
    root.append(sec);
  }
  await Favicon.load();
  renderGrid(); // re-rend avec favicons
  console.log(`${TAG} prêt — ${SECTIONS.length} sections`);
})();
