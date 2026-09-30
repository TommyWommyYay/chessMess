// Online games against a friend. The two browsers talk to each other directly over WebRTC; PeerJS
// and its free public server are only used for them to find each other, so there is no server of
// our own. One player creates a game and sends the link (or just the code); the other opens it.
// The creator (the host) decides who plays which color, and each side checks every move it
// receives against its own copy of the rules.
(function (root) {
  'use strict';

  const { WHITE, BLACK } = Chess;

  const PEERJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/peerjs/1.5.5/peerjs.min.js';
  const ID_PREFIX = 'chessmess-';
  const CODE_LETTERS = 'abcdefghjkmnpqrstuvwxyz23456789';   // no 0/o or 1/l/i to mix up
  const CODE_LENGTH = 6;
  // A closed laptop or a dropped wifi connection does not always close the connection, so both
  // sides send a ping now and then and give up on a friend they have not heard from for a while.
  const PING_MS = 4000, TIMEOUT_MS = 15000;

  const panelEl = document.getElementById('online');
  const textEl = document.getElementById('online-text');
  const actionsEl = document.getElementById('online-actions');

  let hooks = null;         // callbacks into the game (see open() at the bottom)
  let peer = null, conn = null;
  let role = null;          // 'host' or 'guest'
  let code = null;
  let hostColor = WHITE;
  let started = false;      // the host has started at least one game with this friend
  let over = false;         // the current game has finished
  let rematch = { me: false, them: false };
  let lastHeard = 0, pinger = null;
  let loading = null;

  // PeerJS is only fetched once someone actually wants to play online, so everything else keeps
  // working offline.
  function loadPeerJs() {
    if (root.Peer) return Promise.resolve();
    if (!loading) {
      loading = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = PEERJS_URL;
        script.onload = resolve;
        script.onerror = () => {
          loading = null;
          script.remove();
          reject(new Error('PeerJS did not load'));
        };
        document.head.append(script);
      });
    }
    return loading;
  }

  function newCode() {
    const values = crypto.getRandomValues(new Uint32Array(CODE_LENGTH));
    return Array.from(values, (v) => CODE_LETTERS[v % CODE_LETTERS.length]).join('');
  }

  // Accepts a bare code or a whole pasted link.
  function parseCode(text) {
    const match = /join=([a-z0-9]+)/i.exec(text);
    const value = (match ? match[1] : text).trim().toLowerCase();
    return new RegExp(`^[${CODE_LETTERS}]{${CODE_LENGTH}}$`).test(value) ? value : null;
  }

  function send(message) {
    if (conn && conn.open) conn.send(message);
  }

  // ---------------------------------------------------------------------------
  // The panel under the board
  // ---------------------------------------------------------------------------

  function show(text, ...actions) {
    textEl.replaceChildren(...[].concat(text));
    actionsEl.replaceChildren(...actions);
  }

  function button(label, onClick, primary) {
    const el = document.createElement('button');
    el.type = 'button';
    el.textContent = label;
    if (primary) el.className = 'primary';
    el.addEventListener('click', onClick);
    return el;
  }

  function strong(text) {
    const el = document.createElement('strong');
    el.textContent = text;
    return el;
  }

  const leaveButton = () => button('Leave', () => idle());

  function idle(note) {
    disconnect();
    const input = document.createElement('input');
    input.className = 'code';
    input.placeholder = 'code';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-label', 'Game code');
    const joinButton = button('Join', () => join(input.value));
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') joinButton.click();
    });
    show(note || 'Create a game and send your friend the link, or type in the code your friend sent you.',
      button('Create game', host, true), input, joinButton);
    hooks.wait('Create a game or join one below.');
  }

  function waitingForGuest() {
    const link = location.href.split(/[?#]/)[0] + '?join=' + code;
    const field = document.createElement('input');
    field.className = 'link';
    field.readOnly = true;
    field.value = link;
    field.setAttribute('aria-label', 'Invite link');
    field.addEventListener('focus', () => field.select());
    const copy = button('Copy link', async () => {
      try {
        await navigator.clipboard.writeText(link);
        copy.textContent = 'Copied!';
      } catch {
        field.select();
      }
    }, true);
    const text = ['Send your friend this link. The game starts as soon as they open it. Code: ', strong(code)];
    if (location.protocol === 'file:') {
      const note = document.createElement('small');
      note.className = 'online-note';
      note.textContent = 'This copy of the game is opened from your computer, so the link only works for you. ' +
        'Put the game online (e.g. GitHub Pages) to share links; until then your friend can open their own copy and type in the code.';
      text.push(note);
    }
    show(text, field, copy, button('Cancel', () => idle()));
    hooks.wait('Waiting for your friend to join…');
  }

  function playing(note) {
    if (over) return gameOver();
    show([note ? note + ' ' : '', 'Playing online, game ', strong(code), '.'],
      button('Offer draw', offerDraw), leaveButton());
  }

  function gameOver() {
    over = true;
    if (rematch.me) {
      show('Waiting for your friend to accept the rematch…', leaveButton());
    } else {
      show(rematch.them ? 'Your friend wants a rematch.' : 'Game over. Fancy another?',
        button('Rematch', requestRematch, true), leaveButton());
    }
  }

  function fail(message) {
    idle(message);
  }

  // ---------------------------------------------------------------------------
  // Connecting
  // ---------------------------------------------------------------------------

  async function host() {
    disconnect();
    role = 'host';
    code = newCode();
    hostColor = hooks.preferredColor();
    show('Setting up your game…', button('Cancel', () => idle()));
    hooks.wait('Setting up your game…');
    try {
      await loadPeerJs();
    } catch {
      return fail('Could not load the online library. Check your internet connection and try again.');
    }
    if (role !== 'host') return;
    const p = peer = new Peer(ID_PREFIX + code);
    p.on('open', () => {
      if (peer === p) waitingForGuest();
    });
    p.on('connection', (c) => {
      if (peer !== p) return;
      if (conn) {
        // Someone else with the link while the friend is still here.
        c.on('open', () => {
          c.send({ type: 'full' });
          setTimeout(() => c.close(), 1000);
        });
        return;
      }
      attach(c, guestArrived);
    });
    listen(p);
  }

  async function join(text) {
    const wanted = parseCode(text);
    if (!wanted) return fail(`That code does not look right. It should be ${CODE_LENGTH} letters and numbers.`);
    disconnect();
    role = 'guest';
    code = wanted;
    show(['Joining game ', strong(code), '…'], button('Cancel', () => idle()));
    hooks.wait('Joining your friend’s game…');
    try {
      await loadPeerJs();
    } catch {
      return fail('Could not load the online library. Check your internet connection and try again.');
    }
    if (role !== 'guest') return;
    const p = peer = new Peer();
    p.on('open', () => {
      if (peer === p) attach(p.connect(ID_PREFIX + code, { reliable: true }), () => show('Connected. Starting the game…'));
    });
    listen(p);
  }

  function listen(p) {
    // Losing the link to the PeerJS server does not affect a game in progress, but it is needed
    // for a friend to (re)join, so get it back.
    p.on('disconnected', () => {
      if (peer === p && !p.destroyed) p.reconnect();
    });
    p.on('error', (err) => {
      if (peer !== p) return;
      if (err.type === 'unavailable-id' && role === 'host') return host();   // code taken: pick another
      if (err.type === 'peer-unavailable') {
        return fail(`Could not find game ${code}. Check the code, and that your friend still has the game open.`);
      }
      if (err.type === 'browser-incompatible') return fail('This browser cannot play online. Try a recent Chrome, Firefox, Edge or Safari.');
      // Other errors while a game is going on are followed by the connection closing, which is handled there.
      if (!conn) fail(`Could not connect (${err.type}). Check your internet connection and try again.`);
    });
  }

  function attach(c, onOpen) {
    c.on('open', () => {
      conn = c;
      lastHeard = Date.now();
      clearInterval(pinger);
      pinger = setInterval(() => {
        if (Date.now() - lastHeard > TIMEOUT_MS) lost(c);
        else send({ type: 'ping' });
      }, PING_MS);
      onOpen();
    });
    c.on('data', (message) => {
      if (conn !== c) return;
      lastHeard = Date.now();
      receive(message);
    });
    c.on('close', () => lost(c));
    c.on('error', () => lost(c));
  }

  function lost(c) {
    if (conn !== c) return;
    conn = null;
    clearInterval(pinger);
    c.close();
    if (role === 'host') {
      // Stay open so the friend can come back with the same link, e.g. after refreshing the page.
      show(['Your friend disconnected. They can rejoin with the same link or the code ', strong(code), '.'], leaveButton());
      hooks.wait('Your friend disconnected. Waiting for them to come back…');
    } else {
      show('Lost the connection to your friend’s game.', button('Reconnect', () => join(code), true), leaveButton());
      hooks.wait('Lost the connection to your friend.');
    }
  }

  function disconnect() {
    clearInterval(pinger);
    const c = conn, p = peer;
    conn = peer = null;
    role = null;
    started = over = false;
    rematch = { me: false, them: false };
    if (c) c.close();
    if (p) p.destroy();
  }

  // ---------------------------------------------------------------------------
  // The game itself
  // ---------------------------------------------------------------------------

  // The host's side of a friend (re)joining: carry on with the game in progress, or start a new one.
  function guestArrived() {
    const { moves, finished } = hooks.snapshot();
    if (started && !finished) {
      send({ type: 'start', color: hostColor ^ 8, moves });
      playing('Your friend is back.');
      hooks.resume();
      return;
    }
    if (started) hostColor ^= 8;
    startGame();
  }

  function startGame() {
    started = true;
    over = false;
    rematch = { me: false, them: false };
    send({ type: 'start', color: hostColor ^ 8, moves: [] });
    playing();
    hooks.begin(hostColor, []);
  }

  function offerDraw() {
    send({ type: 'draw-offer' });
    show('Draw offered. Waiting for your friend to answer…', leaveButton());
  }

  function requestRematch() {
    rematch.me = true;
    send({ type: 'rematch' });
    if (!maybeRematch()) gameOver();
  }

  // Once both players have asked for a rematch, the host starts it with the colors swapped.
  function maybeRematch() {
    if (!rematch.me || !rematch.them) return false;
    if (role === 'host') {
      hostColor ^= 8;
      startGame();
    } else {
      show('Starting the rematch…');
    }
    return true;
  }

  function receive(message) {
    switch (message && message.type) {
      case 'start':
        if (role !== 'guest') return;
        over = false;
        rematch = { me: false, them: false };
        playing();
        hooks.begin(message.color === BLACK ? BLACK : WHITE, Array.isArray(message.moves) ? message.moves : []);
        break;
      case 'move':
        hooks.move(message);
        break;
      case 'resign':
        hooks.resign();
        break;
      case 'draw-offer':
        if (over) return;
        show('Your friend offers a draw.', button('Accept', () => {
          send({ type: 'draw-accept' });
          hooks.draw();
        }, true), button('Decline', () => {
          send({ type: 'draw-decline' });
          playing();
        }));
        break;
      case 'draw-accept':
        hooks.draw();
        break;
      case 'draw-decline':
        playing('Your friend declined the draw.');
        break;
      case 'rematch':
        rematch.them = true;
        if (!maybeRematch() && over) gameOver();
        break;
      case 'full':
        fail('That game already has two players.');
        break;
    }
  }

  root.Online = {
    // hooks: wait(text) freezes the board with a message; begin(color, moves) starts (or restores)
    // a game with this player on `color`; resume() unfreezes it; move(), resign() and draw() report
    // the friend's actions; snapshot() returns { moves, finished } for a friend who rejoins; and
    // preferredColor() is the color the host picked.
    open(gameHooks) {
      hooks = gameHooks;
      panelEl.hidden = false;
      idle();
    },
    close() {
      disconnect();
      panelEl.hidden = true;
    },
    join,
    sendMove({ from, to, promo }, ply) {
      send({ type: 'move', from, to, promo, ply });
    },
    resign() {
      send({ type: 'resign' });
    },
    gameOver,
    rematch: requestRematch,
  };
})(this);
