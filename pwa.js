// Makes chessMess installable as an app: registers the service worker (sw.js) that lets it work
// offline, and keeps hold of the browser's install dialog for the menu's "Install app" link.
(function (root) {
  'use strict';

  const installed = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const onWebsite = location.protocol !== 'file:';
  // iPhones and iPads cannot install from a button; Safari's Share menu does it instead.
  const apple = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  // Service workers only run on a website (https or localhost), not on a page opened from disk.
  if ('serviceWorker' in navigator && onWebsite) {
    navigator.serviceWorker.register('sw.js').catch(() => {
      // Without it the game still works; it just cannot be installed or played offline.
    });
  }

  let prompt = null;        // the browser's install dialog, saved until the link is pressed
  let done = installed;
  const listeners = [];
  const changed = () => listeners.forEach((listener) => listener());

  addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    prompt = event;
    changed();
  });

  addEventListener('appinstalled', () => {
    prompt = null;
    done = true;
    changed();
  });

  root.InstallApp = {
    // Whether to offer installing: the browser has offered it, or this is an iPhone/iPad in Safari.
    available: () => !done && (Boolean(prompt) || (apple && onWebsite)),
    // True when install() shows the browser's own dialog; otherwise show the Share-menu steps.
    canPrompt: () => Boolean(prompt),
    async install() {
      if (!prompt) return;
      const dialog = prompt;
      prompt = null;
      dialog.prompt();
      const { outcome } = await dialog.userChoice;
      if (outcome === 'accepted') done = true;
      changed();
    },
    onChange: (listener) => listeners.push(listener),
  };
})(this);
