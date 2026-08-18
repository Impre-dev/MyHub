# MyHub — SPEC V2 · Le méta-hub

> **Vision** : MyHub devient la couche de présentation UNIQUE de tout l'écosystème Impre
> (mods Sine + prefs Firefox). Les mods restent atomiques (1 repo = 1 toggle = 1 update),
> MyHub découvre, affiche et configure. La friction d'intégration disparaît par des
> **contrats déclaratifs**, jamais par des fusions de mods.

## Pourquoi cette spec existe

L'intégration "MyHub dans l'urlbar" a demandé de toucher **4 mods** : la connaissance était
hardcodée chez chaque consommateur. Exemple CanonicalFavicon : ajouter une icône = déposer
un PNG **+** éditer `favicon-map.json` — deux étapes manuelles qu'une UI MyHub ramène à
quelques clics. Le hub n'est plus un gestionnaire de favoris : c'est le **centre de contrôle**
de l'écosystème.

## Architecture cible

```mermaid
flowchart TD
    subgraph SIDEBAR["Sidebar — transparente, zéro bordure/ombre"]
        direction TB
        S1["🏠 Firefox (natif)"]
        S2["🔤 URLBar-2.0"]
        S3["🏷️ Favicons"]
        S4["✨ mods détectés auto"]
    end
    SIDEBAR -->|hashchange| ROUTER
    subgraph PAGES["Une page par domaine"]
        ROUTER --> P1["Page Firefox — accueil, favoris (V1)"]
        ROUTER --> P2["Pages mods — auto depuis preferences.json"]
        ROUTER --> P3["Pages custom — UI riches (favicon manager…)"]
    end
    PAGES --> BUS
    subgraph BUS["Bus technique (event-driven only)"]
        BUS --> O1["Services.prefs + observers"]
        BUS --> O2["NewTabUtils.pinnedLinks (cache live)"]
        BUS --> O3["Services.obs — commandes one-shot"]
        BUS --> O4["IOUtils — fichiers (icons/, favicon-map.json)"]
    end
    BUS --> MODS[Mods consommateurs]
```

**Règles d'or** : zéro polling (observers + événements DOM uniquement), zéro fusion de mods,
les pages custom ne contiennent AUCUNE connaissance hardcodée d'un mod (tout vient d'un
contrat fichier), la page doit rester fonctionnelle si un mod est absent (graceful).

## Contrats (ce qu'un mod expose pour être "hub-ready")

| Contrat | Fichier | Rôle |
|---|---|---|
| **Settings MCM** | `preferences.json` (standard Sine existant) | MyHub rend les prefs automatiquement : checkbox, dropdown, text, conditions AND/OR |
| **Icône** | `resources/MyIcon.png` (convention : nom du mod, minuscules = clé) | Sidebar + partout où le mod apparaît. Fallback : tuile lettre colorée |
| **Page custom** (optionnel) | section `myhub` dans `preferences.json` (`"myhub": {"page": "custom-id"}`) | Réserve un slot de page riche que MyHub implémente (ex: favicon manager) |
| **Commandes** (optionnel) | observées via `Services.obs` (`myhub-<modid>-<action>`) | Actions one-shot (rebuild, refresh) — le mod s'abonne, MyHub notifie |

Un mod sans aucun contrat reste invisible du hub — rétro-compatible par construction.

## Phases

### V1.1 — Fixes prérequis (suppression de la friction structurelle)

1. **Favoris dynamiques** ✅ **fait (commit d59a8f1)** — archi finale ≠ plan initial :
   la page (`manager.js`) écrit la **pref brute** (`browser.newtabpage.pinned`,
   guards anti-wipe) ; `MyHub.uc.js` (contexte browser = VRAIE instance NewTabUtils)
   observe la pref et **réconcilie** le cache `pinnedLinks` (unpin-all + re-pin
   `{url, label, title}`), puis `pinnedCache.expire() + refresh({broadcast:true})`
   du feed AS `feeds.system.topsites` → store Redux → urlbar sans restart.
   Détails : appendice « Topologie des caches top sites » en fin de spec
2. **getIconKey généralisé** : `chrome://sine/content/<modId>/…` → clé `<modId>` —
   toute future page de mod Sine est auto-résolue (dernier patch manuel de ce type)
3. **COMPACT_PATTERNS en pref** (`user.urlbar.compactPatterns`, séparateur `|`) —
   le compact set de l'urlbar devient éditable sans toucher au code
4. **Canon d'icônes** : `CustomFavicon/icons/` = source unique ; `zen-about-favicons`
   lit le même dossier pour sa mécanique SQLite ; MyHub et URLBar-2.0 scannent ce canon
5. **Fusion urlbar-mc-bg → URLBar-2.0** (CSS absorbé dans `theme.json.style`)

### V1.2 — Sidebar shell

- Sidebar gauche fixe (~60px) : transparente, sans bordure ni ombre, icônes flottantes
- Tooltip au hover en pur CSS (`::after`), même famille que les info-bulles focus
- **Routing `location.hash`** + event `hashchange` : deep-linkable, back/forward gratuit,
  dernière page mémorisée (pref `MyHub.page`)
- La page actuelle (Accueil & Démarrage + Favoris) devient la page "Firefox"
- Icônes : contrat `resources/` + fallback lettre colorée (hash du nom → teinte)

### V2.0 — Moteur de modules

- **Scan** : `mods.json` + `sine-mods/*/` (IOUtils) → liste mods (id, nom, version, enabled)
- **Rendu MCM générique** : parser `preferences.json` → sections auto (types MCM +
  conditions `if`/`not`, AND/OR) — double rendu gratuit avec l'UI native Sine
- **Dashboard mods** : état on/off, version, lien repo ; (V2.2 : toggle enable via
  écriture `mods.json` + invitation restart)

### V2.1 — Pages custom (la vraie plus-value UX)

Priorisation par gain de friction :

1. **Favicon manager** (CustomFavicon) : grille domaines → icônes ; ajout = file picker
   ou URL + domaine → MyHub écrit le PNG dans le canon + la ligne `favicon-map.json`.
   Remplace le flux manuel 2 étapes. ⚠️ **Jamais de git/push depuis le hub** : une page
   chrome privilégiée qui exécute git = surface d'exécution de code + zéro review —
   le push reste un geste développeur (terminal), le hub ne touche qu'aux fichiers du profil
2. **Page URLBar** : éditeur `compactPatterns` (liste éditable), toggles des features
3. **Page MyJS** : `POPUP_BG` en sélecteur couleur
4. **Page Sidebot** : gestion icônes sites IA (même mécanique que favicon manager)

### V2.2 — Commandes runtime

- `Services.obs` : `myhub-customfavicon-rebuild`, `myhub-urlbar-reloadicons`…
- Les mods s'abonnent → actions one-shot depuis le hub sans restart
- Option : enable/disable de mods (écriture `mods.json`, restart guidé)

## Non-goals

- ❌ Fusionner les mods en super-mods (toggle/update indépendants = sacrifié)
- ❌ Polling / timers (crédo Event Driven Only — `setTimeout(fn,0)` et debounce OK)
- ❌ Modifier des mods tiers sans contrat (le hub les ignore proprement)
- ❌ MyHub comme runtime des mods — il configure, il ne remplace pas

## Risques & mitigations

| Risque | Mitigation |
|---|---|
| Format MCM évolue avec Sine | Le parser est isolé (`mcm.js`), tolérant aux types inconnus (skip + warning) |
| prefs `user.*` non standard | Préfixe `MyHub.` réservé au hub ; `user.` pour les contrats inter-mods, documentés dans la spec de chaque mod |
| Page custom obère la découvrabilité | Une page custom DOIT exposer aussi ses prefs de base via MCM (la richesse vient en plus) |
| Écriture de fichiers (favicon manager) | Backup JSON avant write + toast de confirmation ; `.gitignore` jamais touché par le hub |

## État

- ✅ V1 livrée (accueil, favoris drag & drop, snapshot, urlbar, favicon tab)
- ✅ V1.1 fix #1 « favoris dynamiques » livré et validé (commit d59a8f1)
- 🎯 Prochaine étape : **V1.1 fixes restants** (getIconKey, compactPatterns, canon icônes, fusion mc-bg) puis **V1.2 sidebar**

## Appendice — Topologie des caches top sites (Zen, 2026-08)

Enquête post-crash (source extrait des omni.ja). La chaîne complète entre la pref
et l'urlbar compte **4 couches de caches**, dont deux leurres :

```
pref browser.newtabpage.pinned
  └─ NewTabUtils.pinnedLinks (cache mémoire, contexte browser)      [couche 1]
       └─ feed ActivityStream "feeds.system.topsites" (TopSitesFeed.sys.mjs)
          — son PROPRE pinnedCache (LinksCache) + store Redux        [couche 2]
             └─ AboutNewTab.getTopSites() lit store.getState().TopSites.rows
                  └─ UrlbarProviderTopSites.startQuery() → urlbar
```

- **Pref `browser.topsites.component.enabled = false`** (défaut Zen) → l'urlbar
  passe par `AboutNewTab.getTopSites()`, PAS par le composant
  `modules/topsites/TopSites.sys.mjs` (singleton) — ce dernier reste rafraîchi en
  double couverture au cas où la pref changerait.
- La notif `newtab-link-changed` ne réveille RIEN pour les pins : le flow natif
  passe par des actions Redux émises depuis la page ActivityStream. **Seul appel
  qui fonctionne** : `feed.pinnedCache.expire() + feed.refresh({broadcast:true})`.

### Leçons (coût : un wipe de favoris + un crash Zen)

1. **`ChromeUtils.importESModule` depuis une page privilégiée charge une INSTANCE
   SÉPARÉE du module** (registre propre) — un NewTabUtils importé en page a un
   cache `pinnedLinks` VIDE, et un `save()` qui en découle écrase la pref.
   → Règle : les modules "browser-state" se manipulent depuis le `.uc.js`
   (contexte browser), jamais depuis la page.
2. **Observers pref = SYNCHRONES** : un handler qui réécrit la pref observée se
   ré-entre en boucle → stack overflow. → Verrou de ré-entrance obligatoire
   (flag + `try/finally`).
3. **Jamais écrire un état vide** : guards anti-wipe dans `Grid.save()` et
   auto-présence MyHub différée si grille vide au chargement.
4. Champs : NewTabUtils resérialise la pref avec `title` ; MyHub utilise `label`
   → pinner les DEUX + normaliser `label ← title` à la lecture.
