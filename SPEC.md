# MyHub — Spec

> **Hub de configuration** pour les mods & prefs d'Impre.
> Né de l'enquête "pane Home cassé par la migration SRD" (2026-08-18) — verdict :
> les prefs moteur fonctionnent parfaitement, seule l'UI officielle est amputée.
> MyHub ne restaure rien : il propose **notre** page à nous.

## 🎯 Vision

**À terme** : le point d'entrée unique de configuration de *tous* les mods Impre
(nœuds de la molécule) et des prefs Firefox/Zen qui vont avec (l'œil central).

**V1 (scope actuel)** : l'objectif principal — Accueil, Newtab, Favoris.
L'architecture sections déclaratives est pensée dès le départ pour accueillir
les futurs modules sans refonte.

## 🎨 Identité

- **Logo/favicon** : `resources/MyHub.png` — structure moléculaire (nœuds = mods)
  convergent vers un œil central (le hub qui voit tout). Flat, fond transparent,
  lisible à 16px
- **Design tokens** (issus du logo) :
  - `--mh-accent: #2B7CE9` (bleu vif)
  - `--mh-dark: #1A365D` (bleu nuit — pupille/textes)
  - `--mh-white: #FFFFFF` (sclère/contrast)
- **`body { background: transparent; }`** — wallpaper fourni plus tard (asset du mod)
- Vanilla JS, flex/grid CSS, zéro framework — épuré et léger

## 📁 Structure du mod

```
myhub/
├── theme.json            # Mod Sine (js: true)
├── myhub.uc.js           # browser.xhtml : entrée d'ouverture (V1: optionnel)
├── manager.html          # La page (markup, sections rendues en JS)
├── manager.css           # Styles + tokens
├── manager.js            # Rendu + bindings prefs + drag & drop
├── resources/
│   ├── MyHub.png         # Favicon (source : Downloads/MyHub.png)
│   └── MyHub.ico         # Version .ico (backup/usage futur)
└── SPEC.md               # Ce fichier
```

URL d'accès : `chrome://sine/content/myhub/manager.html`
(mécanisme prouvé : mapping `content sine ../sine-mods/` du manifest Sine —
cf. restore-home-settings/inject.js chargé ainsi ; favicon déclaré via `<link rel="icon">`)

## 🧩 Sections & prefs (source : dump du profil, enquête 2026-08-18)

Architecture **hub** : chaque section est une déclaration, chaque pref une entrée.
Ajouter un futur module (URLBar-2.0, CustomFavicon...) = ajouter une section.

```js
const SECTIONS = [
  { id: 'homepage',  title: 'Accueil & Démarrage', prefs: [...] },
  { id: 'favorites', title: 'Favoris',             grid: true, prefs: [...] },
  { id: 'newtab',    title: 'Nouvel onglet',       prefs: [...], readonly: [...] },
  // Futur : { id: 'urlbar', module: 'URLBar-2.0', prefs: [...] }, etc.
];
```

### Section `homepage` — Accueil & Démarrage

| Pref | Type | Contrôle UI |
|---|---|---|
| `browser.startup.homepage` | string | Champ URL (+ aide multi-onglets `\|`) + bouton « page courante » |
| `browser.startup.page` | int | Radio : `0` page vide / `1` accueil / `3` session / `4` session+accueil |

### Section `favorites` — Grille (le cœur de la V1)

| Pref | Type | Contrôle UI |
|---|---|---|
| `browser.newtabpage.pinned` | string (JSON) | Grille drag & drop — tiles `{url, label, baseDomain}` |
| `browser.urlbar.maxRichResults` | int | Nombre de slots |
| `browser.newtabpage.activity-stream.topSitesRows` | int | Lignes (valeur actuelle : 4) |
| `browser.newtabpage.activity-stream.topSitesMaxSitesPerRow` | int | Tiles/ligne (default : 8) |

Comportements grille :
- **Drag & drop HTML5 natif** → réordonne le tableau JSON → `setStringPref` live
- **Ajout / édition / suppression** inline (label + URL)
- **Favicon auto** : scan des dossiers d'icônes (même mécanique que URLBar-2.0 :
  `zen-about-favicons/icons/`, `CustomFavicon/icons/` + `favicon-map.json`),
  fallback favicon réseau
- **Snapshot de sécurité** : backup du JSON en pref `myhub.backup.pinned` avant
  chaque write + bouton « restaurer »

### Section `newtab` — Nouvel onglet

| Pref | Type | Contrôle UI |
|---|---|---|
| `browser.newtabpage.enabled` | bool | Checkbox (activity stream vs page vide) |
| `browser.newtab.extensionControlled` | bool | ⚠️ **Lecture seule** — statut extension NewTab |

> ⚠️ Verdict d'enquête : `browser.newtab.url` est **morte côté moteur** (jamais
> lue, `AboutNewTab.newTabURL` la dépasse). Newtab custom = extension
> (`chrome_url_overrides.newtab`). La page affiche le statut honnêtement + lien
> vers about:addons — pas de faux contrôle.

## ⚙️ Contraintes techniques

- **Event Driven Only** (rule maison) : listeners + observers
  (`Services.prefs.addObserver` pour refléter les changements externes), **zéro polling**
- Privilèges chrome directs — pas d'extension, pas de bridge
- Writes directs + toasts discrets ; aucune écriture fichier (sauf wallpapers plus tard)
- Pas d'alias `about:` (écarté : moins bien, chrome:// suffit)

## 🗺️ Roadmap

| Version | Contenu |
|---|---|
| **V1** | Page + 3 sections + grille drag + écriture live + design transparent + logo |
| V1.1 | Itérations design (retours Impre), wallpaper |
| V2 | Hub complet : sections par mod (URLBar-2.0, CustomFavicon, ...), import/export JSON |

## 🔄 Workflow (règle Sine-Workflow.md)

1. Création ici (`Sine-Mods/myhub/`, copie favicon depuis Downloads) → git init +
   push GitHub **public** (`Impre-dev/myhub`)
2. Install via Sine UI (`Impre-dev/myhub`) → restart Zen
3. Itérations **directement dans le profil** (`…/chrome/sine-mods/myhub/`) → restart Zen
4. Validé → sync profil → ici → commit + push

---

*Spec v2 (rename home-manager → MyHub) — 2026-08-18. Sources : dump prefs profil,
main.js/preferences.js/home-startup.mjs, shortcuts_manager.py (système obsolète),
URLBar-2.0 (favicon scan), analyse logo MyHub.png.*
