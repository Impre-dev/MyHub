// ==UserScript==
// @name           MyHub — accès
// @version        1.0.0
// @description    Ouvre le hub MyHub (Ctrl+Alt+H) — page de config Accueil/Newtab/Favoris
// @author         Impre
// @include        main
// ==/UserScript==

(function () {
  'use strict';

  const HUB_URL = 'chrome://sine/content/MyHub/manager.html';

  const HUB_ICON = 'chrome://sine/content/MyHub/resources/MyHub.png';

  function openHub() {
    // Ouvre (ou focus) le hub dans un onglet
    for (const win of Services.wm.getEnumerator('navigator:browser')) {
      for (const tab of win.gBrowser.tabs) {
        if (tab.linkedBrowser.currentURI.spec === HUB_URL) {
          win.gBrowser.selectedTab = tab;
          win.focus();
          return;
        }
      }
    }
    gBrowser.addTab(HUB_URL, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
  }

  /** Favoris dynamiques : la page MyHub écrit la pref brute ; ce script (contexte
   *  browser = VRAIE instance NewTabUtils, celle que lit UrlbarProviderTopSites)
   *  réconcilie le cache pinnedLinks à chaque changement de pref.
   *  pin()/unpin() → cache live + notif "newtab-link-changed" → urlbar & newtab
   *  rafraîchis SANS restart.
   *  ⚠️ La page ne peut pas le faire elle-même : importESModule y charge une
   *  instance SÉPARÉE au cache vide (bug wipe 2026-08-18). */
  function syncPinnedCache() {
    const { NewTabUtils } = ChromeUtils.importESModule('resource://gre/modules/NewTabUtils.sys.mjs');
    if (NewTabUtils.__myHubSync) return; // singleton inter-fenêtres (même instance ESM)
    NewTabUtils.__myHubSync = true;

    const PREF = 'browser.newtabpage.pinned';
    const readPref = () => {
      try {
        return JSON.parse(Services.prefs.getStringPref(PREF, '[]')) || [];
      } catch {
        return [];
      }
    };

    // ⚠️ Verrou de ré-entrance : les observers pref sont SYNCHRONES — chaque
    // pin()/unpin() écrit la pref et re-déclenche reconcile() en plein rebuild
    // → récursion infinie → stack overflow → crash Zen (bug 2026-08-18).
    let syncing = false;

    const reconcile = () => {
      if (syncing) return; // notification issue de notre propre rebuild → ignorer
      const entries = readPref().filter(Boolean);
      const links = NewTabUtils.pinnedLinks.links || [];
      // Anti-écho par comparaison d'état (couvre les writes de NewTabUtils lui-même)
      const same = links.length === entries.length && entries.every((e, i) => links[i] && links[i].url === e.url);
      if (entries.length === 0) return; // anti-wipe : jamais de sync vers un état vide
      if (same) return;
      syncing = true;
      try {
        for (const l of [...links]) if (l) NewTabUtils.pinnedLinks.unpin(l);
        // title ET label : NewTabUtils resérialise la pref avec ses champs — on
        // conserve le libellé MyHub (label) ET le champ natif (title)
        entries.forEach((e, i) =>
          NewTabUtils.pinnedLinks.pin({ url: e.url, label: e.label || e.title, title: e.label || e.title, baseDomain: e.baseDomain }, i),
        );
      } finally {
        syncing = false;
      }
      console.log('[MyHub] cache pinnedLinks réconcilié (' + entries.length + ' favoris)');
      // Urlbar (component.enabled=false) : lit AboutNewTab.getTopSites() →
      // store Redux du feed ActivityStream "feeds.system.topsites". Ce feed a
      // son PROPRE pinnedCache et ne se réveille sur AUCUN topic observer pour
      // les pins (le natif passe par des actions Redux depuis la page AS).
      // → on reproduit son flow pin natif : pinnedCache.expire + refresh.
      try {
        const { AboutNewTab } = ChromeUtils.importESModule('resource:///modules/AboutNewTab.sys.mjs');
        const feed = AboutNewTab.activityStream?.store?.feeds?.get?.('feeds.system.topsites');
        if (feed) {
          feed.pinnedCache.expire();
          feed.refresh({ broadcast: true }); // async → store TopSites.rows à jour
        } else {
          console.warn('[MyHub] feed topsites introuvable (activityStream non initialisé)');
        }
      } catch (e) {
        console.warn('[MyHub] TopSitesFeed refresh échoué:', e);
      }
      // Composant TopSites (si browser.topsites.component.enabled passe à true
      // un jour) — même mécanique, laissée en double couverture :
      try {
        const { TopSites } = ChromeUtils.importESModule('resource:///modules/topsites/TopSites.sys.mjs');
        TopSites.pinnedCache.expire();
        TopSites.refresh({ broadcast: true }).catch(() => {});
      } catch {}
    };

    Services.prefs.addObserver(PREF, reconcile); // Event Driven Only, zéro polling
    reconcile(); // import initial (au démarrage de la fenêtre)
  }

  /** Favicon de la tab bar — les <link rel=icon> relatifs sont ignorés sur chrome://
   *  → override event-driven de tab.image quand un tab affiche MyHub */
  function patchTabIcon() {
    const applyIcon = (tab) => {
      if (tab?.linkedBrowser?.currentURI?.spec === HUB_URL) tab.image = HUB_ICON;
    };
    gBrowser.tabContainer.addEventListener('TabAttrModified', (e) => applyIcon(e.target));
    gBrowser.tabContainer.addEventListener('TabSelect', (e) => applyIcon(e.target));
  }

  function init() {
    if (window.__myHubPatched) return;
    if (!window.gBrowser || !document.getElementById('mainKeyset')) {
      setTimeout(init, 500);
      return;
    }
    window.__myHubPatched = true;

    // Hotkey Ctrl+Alt+H (event-driven : pur XUL key, zéro polling)
    const key = document.createXULElement('key');
    key.id = 'myHub-open-key';
    key.setAttribute('modifiers', 'accel alt');
    key.setAttribute('key', 'H');
    key.setAttribute('oncommand', 'void 0;');
    key.addEventListener('command', openHub);
    document.getElementById('mainKeyset').appendChild(key);

    patchTabIcon(); // favicon coloré dans la barre d'onglets
    syncPinnedCache(); // favoris dynamiques : pref → cache NewTabUtils → urlbar live
    window.openMyHub = openHub;
    console.log('[MyHub] hotkey Ctrl+Alt+H actif — window.openMyHub() dispo');
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') init();
  else document.addEventListener('DOMContentLoaded', init, { once: true });
})();
