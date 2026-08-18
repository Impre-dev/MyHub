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
    window.openMyHub = openHub;
    console.log('[MyHub] hotkey Ctrl+Alt+H actif — window.openMyHub() dispo');
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') init();
  else document.addEventListener('DOMContentLoaded', init, { once: true });
})();
