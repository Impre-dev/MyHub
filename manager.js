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
  page: 'MyHub.page',
};

/* ⚠️ NE JAMAIS importer NewTabUtils ici : la page obtient une INSTANCE SÉPARÉE
 * du module (registre propre), au cache pinnedLinks vide → un save() écrase la
 * pref avec un état vide (bug wipe 2026-08-18).
 * Répartition des rôles : cette page écrit la pref brute ; MyHub.uc.js (contexte
 * browser, VRAIE instance NewTabUtils) réconcilie le cache pinnedLinks à chaque
 * changement de pref → notif "newtab-link-changed" → urlbar/newtab dynamiques. */

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
  // rAF : laisser le layout se poser avant d'animer (montée depuis le bas)
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('show'); // descend
    toastTimer = setTimeout(() => {
      el.hidden = true;
    }, 350); // attends la fin de la descente
  }, 2200);
}

/* ═══════════════ Favicons (mécanique URLBar-2.0) ═══════════════ */

const Favicon = {
  cache: {}, // clé → data:image/png;base64,...
  domainMap: {}, // domaine → clé

  async load() {
    // Thème: icons/light/ (blanc) en thème sombre, icons/dark/ (noir) en clair
    // (avant: le dossier parent était scanné → 0 icône about: chargée)
    const mm = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
    const aboutSubdir = mm && mm.matches ? 'light' : 'dark';
    const dirs = [
      PathUtils.join(PathUtils.profileDir, 'chrome', 'sine-mods', 'zen-about-favicons', 'icons', aboutSubdir),
      PathUtils.join(PathUtils.profileDir, 'chrome', 'sine-mods', 'CustomFavicon', 'icons'),
      // Canon chatbots — sous-dossier du canon CF
      PathUtils.join(PathUtils.profileDir, 'chrome', 'sine-mods', 'CustomFavicon', 'icons', 'Chatbots'),
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
          // basename: "Chatbots/LeChat.png" → "lechat" (le map référence des sous-dossiers)
          this.domainMap[domain] = filename
            .split(/[/\\]/)
            .pop()
            .replace(/\.png$/i, '')
            .toLowerCase();
        }
      }
    } catch (e) {
      /* fallback générique */
    }
    console.log(`${TAG} favicons: ${Object.keys(this.cache).length} icônes, ${Object.keys(this.domainMap).length} domaines`);
  },

  forUrl(url, label) {
    if (!url) return null;
    // Notre propre page : logo couleur direct
    if (url.startsWith('chrome://sine/content/MyHub/')) return 'resources/MyHub.png';
    // about: direct → icône zen-about
    const aboutMatch = url.match(/^about:([a-z]+)/);
    if (aboutMatch && this.cache[aboutMatch[1]]) return this.cache[aboutMatch[1]];
    let host = '';
    try {
      host = new URL(url).hostname.replace(/^www\./, '');
    } catch (e) {}
    // Lookup exact puis suffixe: "chat.z.ai" → "z.ai", "docs.zen-browser.app" → "zen-browser.app"
    // (même logique que resolveIcon de CustomFavicon)
    if (this.domainMap[host] && this.cache[this.domainMap[host]]) {
      return this.cache[this.domainMap[host]];
    }
    for (const [domain, key] of Object.entries(this.domainMap)) {
      if (host.endsWith('.' + domain) && this.cache[key]) return this.cache[key];
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

  /** Source de vérité : la pref sur disque (synchronisée vers le cache
   *  NewTabUtils par MyHub.uc.js côté browser). Normalisation label/title :
   *  NewTabUtils resérialise la pref avec "title", MyHub écrit "label". */
  load() {
    try {
      this.entries = JSON.parse(Prefs.getStr(PREFS.pinned, '[]'));
    } catch (e) {
      console.warn(TAG, 'pinned JSON invalide, reset', e);
      this.entries = [];
    }
    if (!Array.isArray(this.entries)) this.entries = [];
    for (const e of this.entries) {
      if (e && !e.label) e.label = e.title;
    }
  },

  /** Écriture pref brute (le cache NewTabUtils est réconcilié par MyHub.uc.js).
   *  Guard anti-wipe : refus d'écrire un état vide (la grille contient toujours
   *  au moins la tuile MyHub — un état vide = lecture ratée, pas la réalité). */
  save() {
    if (this.entries.filter(Boolean).length === 0) {
      console.warn(TAG, 'save() bloqué : grille vide (protection anti-wipe)');
      return;
    }
    suppressObserver = true;
    try {
      Prefs.setStr(PREFS.pinned, JSON.stringify(this.entries));
    } finally {
      suppressObserver = false;
    }
    toast('Favoris enregistrés ✓');
  },

  /** Fige l'état affiché à l'ouverture comme point de retour (petite data → pref) */
  snapshot() {
    Prefs.setStr(PREFS.backupPinned, JSON.stringify(this.entries));
  },

  restore() {
    const backup = Prefs.getStr(PREFS.backupPinned, '');
    if (!backup) return toast('Aucun snapshot disponible', true);
    try {
      this.entries = JSON.parse(backup);
    } catch (e) {
      return toast('Snapshot corrompu', true);
    }
    if (!Array.isArray(this.entries)) this.entries = [];
    this.save();
    renderGrid();
    toast('Grille du début de session restaurée ✓');
  },

  /** Déplacement par insertion : after=false → avant la cible, after=true → après */
  insert(from, to, after) {
    const [item] = this.entries.splice(from, 1);
    let target = after ? to + 1 : to;
    if (from < target) target -= 1; // la suppression décale les index suivants
    this.entries.splice(target, 0, item);
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

    // Clic gauche : ouvrir le site dans un nouvel onglet
    // (un vrai drag HTML5 ne déclenche pas click → dissociation native)
    tile.addEventListener('click', () => {
      const url = entry?.url;
      if (!url) return;
      const topWin = window.browsingContext?.topChromeWindow || window;
      if (topWin.openTrustedLinkIn) topWin.openTrustedLinkIn(url, 'tab');
      else window.open(url, '_blank');
    });

    // Drag & drop : insertion avant/après selon la moitié de la tuile survolée
    tile.addEventListener('dragstart', (ev) => {
      ev.dataTransfer.effectAllowed = 'move';
      ev.dataTransfer.setData('text/myhub-index', String(index));
      tile.classList.add('dragging');
    });
    tile.addEventListener('dragend', () => tile.classList.remove('dragging'));
    tile.addEventListener('dragover', (ev) => {
      ev.preventDefault();
      const rect = tile.getBoundingClientRect();
      const after = ev.clientX > rect.left + rect.width / 2;
      tile.classList.toggle('drop-after', after);
      tile.classList.toggle('drop-before', !after);
    });
    tile.addEventListener('dragleave', () => {
      tile.classList.remove('drop-before', 'drop-after');
    });
    tile.addEventListener('drop', (ev) => {
      ev.preventDefault();
      const rect = tile.getBoundingClientRect();
      const after = ev.clientX > rect.left + rect.width / 2;
      tile.classList.remove('drop-before', 'drop-after');
      const from = parseInt(ev.dataTransfer.getData('text/myhub-index'), 10);
      const to = parseInt(tile.dataset.index, 10);
      if (!isNaN(from) && !isNaN(to) && from !== to) Grid.insert(from, to, after);
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

/* ═══════════════ Page Favicons — manager CustomFavicon (V2.1) ═══════════════ */

const CF_ROOT = PathUtils.join(PathUtils.profileDir, 'chrome', 'sine-mods', 'CustomFavicon');
const CF_MAP = PathUtils.join(CF_ROOT, 'favicon-map.json');
const CF_MAP_BAK = CF_MAP + '.provisional-backup';
const CF_ICONS = PathUtils.join(CF_ROOT, 'icons');
const CHATBOTS = 'Chatbots';

const Favicons = {
  map: { custom: {}, exclude: [] },
  orphans: [],
  loaded: false,

  async load() {
    try {
      this.map = JSON.parse(await IOUtils.readUTF8(CF_MAP));
      if (!this.map.custom) this.map.custom = {};
      if (!Array.isArray(this.map.exclude)) this.map.exclude = [];
    } catch (e) {
      console.warn(`${TAG} favicon-map illisible : ${e.message}`);
    }
    await this.scanOrphans();
    this.loaded = true;
  },

  /** PNG présents sur disque mais référencés par aucune ligne du map */
  async scanOrphans() {
    const referenced = new Set(Object.values(this.map.custom).map((p) => p.split('/').pop().toLowerCase()));
    const orphans = [];
    for (const sub of ['', CHATBOTS]) {
      const base = sub ? PathUtils.join(CF_ICONS, sub) : CF_ICONS;
      let files = [];
      try {
        files = await IOUtils.getChildren(base);
      } catch (e) {
        continue;
      }
      for (const f of files) {
        const name = PathUtils.filename(f);
        if (!name.toLowerCase().endsWith('.png')) continue;
        if (!referenced.has(name.toLowerCase())) orphans.push(sub ? `${sub}/${name}` : name);
      }
    }
    this.orphans = orphans;
  },

  /** Ré-écriture sécurisée : re-parse check + backup (pattern favoris) */
  async save() {
    const str = JSON.stringify(this.map, null, 2);
    try {
      JSON.parse(str);
    } catch (e) {
      return toast('Refus : map sérialisé invalide', true);
    }
    try {
      await IOUtils.copy(CF_MAP, CF_MAP_BAK, { overwrite: true });
      await IOUtils.writeUTF8(CF_MAP, str + '\n');
    } catch (e) {
      return toast(`Écriture impossible : ${e.message}`, true);
    }
    toast('Map enregistré ✓ — restart Zen pour appliquer');
  },

  absPath(rel) {
    return PathUtils.join(CF_ICONS, ...rel.split('/'));
  },
  fileUrl(rel) {
    return 'file:///' + encodeURI(this.absPath(rel).replace(/\\/g, '/'));
  },

  /** Copie un PNG ({name, path} du picker, ou File du drag-drop) dans le tiroir sub */
  async importIcon(src, sub) {
    const name = String(src.name || '').replace(/[\\/]/g, '_'); // anti path traversal
    if (!name.toLowerCase().endsWith('.png')) {
      toast('PNG uniquement', true);
      return null;
    }
    try {
      const bytes = src.path ? await IOUtils.read(src.path) : new Uint8Array(await src.arrayBuffer());
      const dir = sub ? PathUtils.join(CF_ICONS, sub) : CF_ICONS;
      await IOUtils.makeDirectory(dir, { ignoreExisting: true });
      await IOUtils.write(PathUtils.join(dir, name), bytes, { overwrite: true });
      return sub ? `${sub}/${name}` : name;
    } catch (e) {
      toast(`Import impossible : ${e.message}`, true);
      return null;
    }
  },

  /** Déplacement racine ⇄ Chatbots/ (drag inter-sections) */
  async moveTo(rel, sub) {
    const name = rel.split('/').pop();
    const destRel = sub ? `${sub}/${name}` : name;
    await IOUtils.move(this.absPath(rel), this.absPath(destRel));
    return destRel;
  },
};

/** File picker natif → {name, path} | null */
function favPicker() {
  return new Promise((resolve) => {
    try {
      const fp = Cc['@mozilla.org/filepicker;1'].createInstance(Ci.nsIFilePicker);
      fp.init(window, 'Choisir une icône PNG', Ci.nsIFilePicker.modeOpen);
      fp.appendFilter('Images PNG', '*.png');
      fp.open((rv) => {
        if (rv !== Ci.nsIFilePicker.returnOK && rv !== Ci.nsIFilePicker.returnReplace) return resolve(null);
        resolve({ name: fp.file.leafName, path: fp.file.path });
      });
    } catch (e) {
      // Fallback : <input type=file> (pages où Cc/Ci ne sont pas exposés)
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.png';
      input.addEventListener('change', () => resolve(input.files[0] || null), { once: true });
      input.click();
    }
  });
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

const HUB_URL = 'chrome://sine/content/MyHub/manager.html';

function sectionFavorites(root) {
  Grid.load(); // charge la pref browser.newtabpage.pinned avant le premier rendu

  // Auto-présence : MyHub s'assure d'avoir sa tuile dans la grille (pour l'urlbar du haut).
  // ⚠️ Guard anti-wipe : si la grille est VIDE au chargement, on ne bootstrap PAS
  // (état suspect = lecture ratée quelque part) — la tuile sera ajoutée à la
  // première vraie modification utilisateur.
  if (Grid.entries.filter(Boolean).length === 0) {
    console.warn(TAG, 'grille vide au chargement — auto-présence différée');
  } else if (!Grid.entries.some((e) => e?.url === HUB_URL)) {
    Grid.entries.push({ url: HUB_URL, label: 'MyHub', baseDomain: 'MyHub' });
    Grid.save();
  }

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

  // Reflet des changements externes de la grille (pin depuis le newtab natif, etc.)
  // Anti-écho par comparaison d'état : NewTabUtils écrit la pref de façon asynchrone
  // (après notre save()), donc le flag suppressObserver serait déjà reset. On ne
  // re-render que si l'état a réellement changé → pas de re-render parasite.
  observePref(PREFS.pinned, () => {
    const before = JSON.stringify(Grid.entries);
    Grid.load();
    if (JSON.stringify(Grid.entries) === before) return; // écho de notre propre save()
    renderGrid();
  });
}

/* ═══════════════ Page Favicons — sections ═══════════════ */

let favDropGuard = false;
function favPreventFileNavigation() {
  if (favDropGuard) return;
  favDropGuard = true;
  // Empêcher la navigation si un fichier est droppé hors des zones gérées
  window.addEventListener('dragover', (ev) => ev.preventDefault());
  window.addEventListener('drop', (ev) => ev.preventDefault());
}

function favNormalizeDomain(v) {
  return String(v || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
}

async function favAddDomain(sub) {
  const d = favNormalizeDomain(prompt('Domaine (ex: example.com) :', ''));
  if (!d) return;
  if (Favicons.map.custom[d]) return toast('Domaine déjà présent', true);
  const src = await favPicker();
  if (!src) return;
  const rel = await Favicons.importIcon(src, sub);
  if (!rel) return;
  Favicons.map.custom[d] = rel;
  await Favicons.save();
  renderPage('favicons');
}

/** Grille d'une section — sub: '' (Sites) ou 'Chatbots' */
async function buildFavGrid(sub, root) {
  favPreventFileNavigation();
  if (!Favicons.loaded) await Favicons.load();
  const grid = el('div', { className: 'mh-grid mh-fav-grid' });
  grid.dataset.sub = sub;
  root.append(grid);

  const entries = Object.entries(Favicons.map.custom).filter(([, p]) => (sub ? p.startsWith(CHATBOTS + '/') : !p.startsWith(CHATBOTS + '/')));

  for (const [domain, rel] of entries) {
    const tile = el('div', { className: 'mh-tile', draggable: true });
    tile.dataset.domain = domain;
    tile.append(el('img', { src: Favicons.fileUrl(rel), alt: '' }));
    tile.append(el('span', { className: 'mh-label', textContent: domain, title: rel }));

    // Actions hover : remplacer / retirer la ligne (le PNG devient orphelin)
    const actions = el('div', { className: 'mh-actions' });
    actions.append(
      el('button', {
        textContent: '✎',
        title: 'Remplacer l\u2019icône (ou drag-drop d\u2019un PNG)',
        onclick: async () => {
          const src = await favPicker();
          if (!src) return;
          const newRel = await Favicons.importIcon(src, sub);
          if (!newRel) return;
          Favicons.map.custom[domain] = newRel;
          await Favicons.save();
          renderPage('favicons');
        },
      }),
    );
    actions.append(
      el('button', {
        textContent: '✕',
        title: 'Retirer la ligne (le PNG devient orphelin)',
        onclick: async () => {
          delete Favicons.map.custom[domain];
          await Favicons.scanOrphans();
          await Favicons.save();
          renderPage('favicons');
        },
      }),
    );
    tile.append(actions);

    // Drag de la tuile → déplacement inter-sections
    tile.addEventListener('dragstart', (ev) => {
      ev.dataTransfer.effectAllowed = 'move';
      ev.dataTransfer.setData('text/fav-domain', domain);
      tile.classList.add('dragging');
    });
    tile.addEventListener('dragend', () => tile.classList.remove('dragging'));

    // Drop d'un FICHIER image sur la tuile → remplacement de l'icône
    tile.addEventListener('dragover', (ev) => {
      if ([...ev.dataTransfer.types].includes('Files')) ev.preventDefault();
    });
    tile.addEventListener('drop', async (ev) => {
      const f = ev.dataTransfer.files?.[0];
      if (!f) return; // drag interne → la grille gère
      ev.preventDefault();
      ev.stopPropagation();
      const newRel = await Favicons.importIcon(f, sub);
      if (!newRel) return;
      Favicons.map.custom[domain] = newRel;
      await Favicons.save();
      renderPage('favicons');
    });

    grid.append(tile);
  }

  // Tuile "+ Ajouter" — la section détermine le tiroir
  const addTile = el('div', { className: 'mh-tile mh-tile-add', textContent: '+ Ajouter' });
  addTile.addEventListener('click', () => favAddDomain(sub));
  grid.append(addTile);

  // Drop inter-sections : une tuile draguée ici change de tiroir
  grid.addEventListener('dragover', (ev) => {
    const types = [...ev.dataTransfer.types];
    if (types.includes('text/fav-domain') || types.includes('Files')) {
      ev.preventDefault();
      grid.classList.add('fav-drop-target');
    }
  });
  grid.addEventListener('dragleave', () => grid.classList.remove('fav-drop-target'));
  grid.addEventListener('drop', async (ev) => {
    grid.classList.remove('fav-drop-target');
    if (ev.dataTransfer.files?.length) return ev.preventDefault(); // fichier = remplacement tuile only
    const domain = ev.dataTransfer.getData('text/fav-domain');
    if (!domain) return;
    ev.preventDefault();
    const rel = Favicons.map.custom[domain];
    if (!rel) return;
    const inSub = rel.startsWith(CHATBOTS + '/');
    if ((sub === CHATBOTS) === inSub) return; // déjà au bon endroit
    try {
      Favicons.map.custom[domain] = await Favicons.moveTo(rel, sub);
      await Favicons.save();
      renderPage('favicons');
    } catch (e) {
      toast(`Déplacement impossible : ${e.message}`, true);
    }
  });
}

function sectionFavChatbots(root) {
  return buildFavGrid(CHATBOTS, root);
}
function sectionFavSites(root) {
  return buildFavGrid('', root);
}

function sectionFavExclude(root) {
  const chips = el('div', { className: 'mh-chips' });
  for (const d of Favicons.map.exclude) {
    const chip = el('span', { className: 'mh-chip' }, d);
    chip.append(
      el('button', {
        textContent: '✕',
        title: 'Retirer de la liste',
        onclick: async () => {
          Favicons.map.exclude = Favicons.map.exclude.filter((v) => v !== d);
          await Favicons.save();
          renderPage('favicons');
        },
      }),
    );
    chips.append(chip);
  }
  chips.append(
    el('button', {
      className: 'mh-chip mh-chip-add',
      textContent: '+ domaine',
      onclick: async () => {
        const d = favNormalizeDomain(prompt('Domaine à exclure (CF ne fera rien dessus) :', ''));
        if (!d) return;
        if (!Favicons.map.exclude.includes(d)) {
          Favicons.map.exclude.push(d);
          await Favicons.save();
          renderPage('favicons');
        }
      },
    }),
  );
  root.append(chips);
}

function sectionFavOrphans(root) {
  const section = root.closest('.mh-section');
  if (!Favicons.orphans.length) {
    section.hidden = true;
    return;
  }
  root.append(
    el('p', {
      className: 'mh-orphan-count',
      textContent: `${Favicons.orphans.length} PNG non référencés par le map. Suppression définitive du disque.`,
    }),
  );
  const grid = el('div', { className: 'mh-grid' });
  for (const rel of Favicons.orphans) {
    const name = rel
      .split('/')
      .pop()
      .replace(/\.png$/i, '');
    const tile = el('div', { className: 'mh-tile' });
    tile.append(el('img', { src: Favicons.fileUrl(rel), alt: '' }));
    tile.append(el('span', { className: 'mh-label', textContent: name, title: rel }));
    const actions = el('div', { className: 'mh-actions' });
    actions.append(
      el('button', {
        textContent: '✕',
        title: 'Supprimer définitivement du disque',
        onclick: async () => {
          try {
            await IOUtils.remove(Favicons.absPath(rel));
          } catch (e) {
            return toast(`Suppression impossible : ${e.message}`, true);
          }
          await Favicons.scanOrphans();
          toast('PNG supprimé ✓');
          renderPage('favicons');
        },
      }),
    );
    tile.append(actions);
    grid.append(tile);
  }
  root.append(grid);
}

/* ═══════════════ Shell (V1.2) — pages + dock + routing hash ═══════════════ */

const SECTIONS = [
  { id: 'homepage', title: 'Accueil & Démarrage', build: sectionHomepage },
  { id: 'favorites', title: 'Favoris', build: sectionFavorites },
];

const PAGES = [
  { id: 'firefox', label: 'Firefox', sections: SECTIONS },
  {
    id: 'favicons',
    label: 'Favicons',
    sections: [
      { id: 'fav-chatbots', title: 'Chatbots', build: sectionFavChatbots },
      { id: 'fav-sites', title: 'Sites', build: sectionFavSites },
      { id: 'fav-exclude', title: 'Domaines exclus', build: sectionFavExclude },
      { id: 'fav-orphans', title: 'Icônes orphelines', build: sectionFavOrphans },
    ],
  },
  // V2.x : { id: 'mods', label: 'Mods', ... }
];

function hue(str) {
  let h = 0;
  for (const c of str) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

function buildNav() {
  const nav = el('nav', { className: 'mh-nav', id: 'mh-nav' });
  for (const p of PAGES) {
    const btn = el('button', { className: 'mh-nav-btn', type: 'button' });
    btn.dataset.page = p.id;
    btn.dataset.tip = p.label; // tooltip pur CSS (::after)
    btn.setAttribute('aria-label', p.label);
    const img = el('img', { src: `resources/${p.id}.png`, alt: '' });
    // Contrat icônes : resources/<id>.png, fallback lettre colorée si absent
    img.addEventListener(
      'error',
      () => {
        const letter = el('span', { className: 'mh-nav-letter', textContent: p.label.charAt(0).toUpperCase() });
        letter.style.color = `hsl(${hue(p.label)} 70% 60%)`;
        img.replaceWith(letter);
      },
      { once: true },
    );
    btn.append(img);
    // Un seul geste : le hash pilote tout (hashchange → renderPage)
    btn.addEventListener('click', () => {
      location.hash = p.id;
    });
    nav.append(btn);
  }
  document.body.append(nav);
}

function renderPage(id) {
  const page = PAGES.find((p) => p.id === id) || PAGES[0];
  const root = document.getElementById('mh-sections');
  root.replaceChildren();
  for (const s of page.sections) {
    const sec = el('section', { className: 'mh-section', id: `mh-${s.id}` });
    sec.append(el('h2', { textContent: s.title }));
    const body = el('div', {});
    s.build(body);
    sec.append(body);
    root.append(sec);
  }
  document.querySelectorAll('.mh-nav-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.page === page.id);
  });
  Prefs.setStr(PREFS.page, page.id); // dernière page mémorisée
  // La grille favoris est créée vide par sectionFavorites → remplir après rendu.
  // Couvre le boot ET chaque switch de retour sur la page Firefox.
  if (document.getElementById('mh-grid')) renderGrid();
}

(async function boot() {
  buildNav();
  await Favicon.load();
  const fromHash = location.hash.slice(1);
  const saved = Prefs.getStr(PREFS.page, '');
  const initial = PAGES.some((p) => p.id === fromHash) ? fromHash : PAGES.some((p) => p.id === saved) ? saved : PAGES[0].id;
  // Précharger les données Favicons AVANT le rendu : les sections exclude/orphelins
  // sont sync et lisaient un état vide pendant que les grilles async chargeaient.
  if (initial === 'favicons') await Favicons.load();
  history.replaceState(null, '', '#' + initial); // pas d'événement parasite au boot
  renderPage(initial); // renderPage gère le renderGrid de la page Firefox
  window.addEventListener('hashchange', async (ev) => {
    const id = location.hash.slice(1) || PAGES[0].id;
    if (id === 'favicons' && !Favicons.loaded) await Favicons.load();
    renderPage(id);
  });
  console.log(`${TAG} prêt — ${PAGES.length} page(s), dock sur « ${initial} »`);
})();
