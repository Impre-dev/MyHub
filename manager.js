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
  newtabEnabled: 'browser.newtabpage.enabled',
  newtabExtCtrl: 'browser.newtab.extensionControlled',
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

  /** Écriture live + snapshot de sécurité avant chaque write */
  save() {
    // Snapshot de l'ancienne valeur (une seule génération)
    const current = Prefs.getStr(PREFS.pinned, '[]');
    if (current !== Prefs.getStr(PREFS.backupPinned, '')) {
      Prefs.setStr(PREFS.backupPinned, current);
    }
    suppressObserver = true;
    try {
      Prefs.setStr(PREFS.pinned, JSON.stringify(this.entries));
    } finally {
      suppressObserver = false;
    }
    toast('Favoris enregistrés ✓');
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
    toast('Snapshot restauré ✓');
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

  root.append(
    el('div', { className: 'mh-row' }, el('label', { textContent: "URL de la page d'accueil" }), input, currentBtn),
    el('div', { className: 'mh-hint', textContent: 'Plusieurs onglets : séparer les URLs par un « | »' }),
    el('div', { className: 'mh-row' }, el('label', { textContent: 'Au démarrage' }), radio),
  );
}

function sectionFavorites(root) {
  Grid.load(); // charge browser.newtabpage.pinned avant le premier rendu
  const gridEl = el('div', { className: 'mh-grid', id: 'mh-grid' });

  const numRow = (labelText, pref, def) => {
    const input = el('input', { type: 'number' });
    input.value = Prefs.getInt(pref, def);
    const commit = () => {
      suppressObserver = true;
      try {
        Prefs.setInt(pref, parseInt(input.value, 10) || def);
      } finally {
        suppressObserver = false;
      }
      toast(`${labelText} enregistré ✓`);
    };
    input.addEventListener('change', commit);
    observePref(pref, () => {
      input.value = Prefs.getInt(pref, def);
    });
    return el('div', { className: 'mh-row' }, el('label', { textContent: labelText }), input);
  };

  const restoreBtn = el('button', {
    className: 'mh-ghost',
    textContent: '↺ Restaurer le snapshot',
    onclick: () => Grid.restore(),
  });

  (root.append(gridEl, el('div', { className: 'mh-row' }, el('label', { textContent: 'Grille' }), restoreBtn)),
    root.append(
      numRow('Slots (maxRichResults)', PREFS.maxRichResults, 22),
      numRow('Lignes (topSitesRows)', PREFS.topSitesRows, 4),
      numRow('Tiles / ligne', PREFS.maxPerRow, 8),
    ));

  // Reflet des changements externes de la grille
  observePref(PREFS.pinned, () => {
    Grid.load();
    renderGrid();
  });
}

function sectionNewtab(root) {
  const cb = el('input', { type: 'checkbox' });
  cb.checked = Prefs.getBool(PREFS.newtabEnabled, true);
  cb.addEventListener('change', () => {
    suppressObserver = true;
    try {
      Prefs.setBool(PREFS.newtabEnabled, cb.checked);
    } finally {
      suppressObserver = false;
    }
    toast('Préférence newtab enregistrée ✓');
  });
  observePref(PREFS.newtabEnabled, () => {
    cb.checked = Prefs.getBool(PREFS.newtabEnabled, true);
  });

  const extCtrl = Prefs.getBool(PREFS.newtabExtCtrl, false);
  const status = el('span', {
    className: 'mh-status',
    textContent: extCtrl
      ? "⚙ Une extension contrôle le nouvel onglet (NewTab/redirect) — l'URL custom du newtab se gère dans about:addons"
      : 'Aucune extension ne contrôle le nouvel onglet',
  });

  root.append(
    el('div', { className: 'mh-row' }, el('label', { textContent: 'Page nouvel onglet (Activity Stream)' }), cb),
    el('div', { className: 'mh-row' }, status),
  );
}

/* ═══════════════ Boot ═══════════════ */

const SECTIONS = [
  { id: 'homepage', title: 'Accueil & Démarrage', build: sectionHomepage },
  { id: 'favorites', title: 'Favoris', build: sectionFavorites },
  { id: 'newtab', title: 'Nouvel onglet', build: sectionNewtab },
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
