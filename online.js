// Online games against a friend. Both browsers connect out to a free public MQTT broker (a message
// relay) over a secure WebSocket and exchange messages through it, so there is no server of our own
// and no direct connection between the two players is needed: that is what lets it work on home
// routers and mobile networks that block browser-to-browser connections.
// One player creates a game and sends the link (or just the code); the other opens it. The creator
// (the host) decides who plays which color, and each side checks every move it receives against
// its own copy of the rules.
(function (root) {
  'use strict';

  const { WHITE, BLACK } = Chess;

  const MQTT_URL = 'https://cdnjs.cloudflare.com/ajax/libs/mqtt/5.16.0/mqtt.min.js';
  // Tried in order; both players end up on the first one that answers.
  const BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt'];
  const TOPIC_PREFIX = 'chessmess/v1/';
  const CODE_LETTERS = 'abcdefghjkmnpqrstuvwxyz23456789';   // no 0/o or 1/l/i to mix up
  const CODE_LENGTH = 6;
  const BROKER_TIMEOUT_MS = 7000;
  const JOIN_TIMEOUT_MS = 12000;
  // A closed laptop or a dropped connection does not announce itself, so both sides send a ping now
  // and then and give up on a friend they have not heard from for a while.
  const PING_MS = 4000, TIMEOUT_MS = 15000;
  const NAME_LENGTH = 20, CHAT_LENGTH = 200, CHAT_KEPT = 100;
  const EMOTES = ['👍', '😂', '😮', '😬', '😭', '🔥', '👏', '🤝'];
  const QUICK_LINES = ['Good luck!', 'Nice move!', 'Oops!', 'Good game!'];

  const panelEl = document.getElementById('online');
  const textEl = document.getElementById('online-text');
  const actionsEl = document.getElementById('online-actions');
  const chatEl = document.getElementById('chat');
  const chatLogEl = document.getElementById('chat-log');
  const chatFormEl = document.getElementById('chat-form');
  const chatInputEl = document.getElementById('chat-input');
  const emotesEl = document.getElementById('emotes');
  const boardWrapEl = document.getElementById('board-wrap');

  let hooks = null;         // callbacks into the game (see open() at the bottom)
  let client = null;        // the connection to the broker
  let session = 0;          // bumped whenever a connection is abandoned, to ignore its late events
  let role = null;          // 'host' or 'guest'
  let code = null;
  let me = null;            // this player's id in messages
  let friend = null;        // the friend's id, while they are connected
  let friendName = '';
  let run = null;           // new on every connection, so a refreshed page starts counting afresh
  let seq = 0;              // numbers this player's messages, so repeats can be spotted
  let seen = { sender: null, seq: 0 };
  let hostColor = WHITE;
  let started = false;      // the host has started at least one game with this friend
  let over = false;         // the current game has finished
  let rematch = { me: false, them: false };
  let lastHeard = 0, pinger = null, joinTimer = null;
  let loading = null;

  // The MQTT library is only fetched once someone actually wants to play online, so everything else
  // keeps working offline.
  function loadMqtt() {
    if (root.mqtt) return Promise.resolve();
    if (!loading) {
      loading = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = MQTT_URL;
        script.onload = resolve;
        script.onerror = () => {
          loading = null;
          script.remove();
          reject(new Error('mqtt.js did not load'));
        };
        document.head.append(script);
      });
    }
    return loading;
  }

  function randomText(length) {
    const values = crypto.getRandomValues(new Uint32Array(length));
    return Array.from(values, (v) => CODE_LETTERS[v % CODE_LETTERS.length]).join('');
  }

  // Accepts a bare code or a whole pasted link.
  function parseCode(text) {
    const match = /join=([a-z0-9]+)/i.exec(text);
    const value = (match ? match[1] : text).trim().toLowerCase();
    return new RegExp(`^[${CODE_LETTERS}]{${CODE_LENGTH}}$`).test(value) ? value : null;
  }

  // A guest keeps the same id when the page is refreshed, so the host knows it is the same friend
  // coming back rather than a stranger with the link.
  function guestId(gameCode) {
    const key = 'chessMess.guest.' + gameCode;
    try {
      const id = sessionStorage.getItem(key) || randomText(12);
      sessionStorage.setItem(key, id);
      return id;
    } catch {
      return randomText(12);
    }
  }

  const topic = (sender) => TOPIC_PREFIX + code + '/' + sender;

  const cleanName = (text) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, NAME_LENGTH);
  // How the panel refers to the friend, at the start of a sentence or in the middle of one.
  const Them = () => friendName || 'Your friend';
  const them = () => friendName || 'your friend';

  function setFriendName(name) {
    friendName = cleanName(name);
    hooks.friendName(friendName);
  }

  // Every message carries its sender, and its recipient (none for a guest's hello).
  function send(message, recipient = friend) {
    if (!client) return;
    const payload = JSON.stringify({ ...message, sender: me, recipient, run, seq: ++seq });
    client.publish(topic(role), payload, { qos: 1 });
  }

  // Connects to the first broker that answers.
  async function connectBroker(current) {
    for (const url of BROKERS) {
      try {
        const c = await new Promise((resolve, reject) => {
          const attempt = root.mqtt.connect(url, { connectTimeout: BROKER_TIMEOUT_MS, reconnectPeriod: 2000 });
          const timer = setTimeout(() => {
            attempt.end(true);
            reject(new Error('timed out'));
          }, BROKER_TIMEOUT_MS);
          attempt.once('connect', () => {
            clearTimeout(timer);
            resolve(attempt);
          });
        });
        if (current !== session) {
          c.end(true);
          return null;
        }
        return c;
      } catch {
        // Try the next one.
      }
    }
    throw new Error('No broker answered');
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
    show(note || 'Set your name below, then create a game and send your friend the link, or type in the code your friend sent you.',
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
    const text = ['Send your friend this link and keep this page open. The game starts as soon as they open it. Code: ', strong(code)];
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
    showChat(true);
    show([note ? note + ' ' : '', `Playing online against ${them()}, game `, strong(code), '.'],
      button('Offer draw', offerDraw), leaveButton());
  }

  function gameOver() {
    over = true;
    if (rematch.me) {
      show(`Waiting for ${them()} to accept the rematch…`, leaveButton());
    } else {
      show(rematch.them ? `${Them()} wants a rematch.` : 'Game over. Fancy another?',
        button('Rematch', requestRematch, true), leaveButton());
    }
  }

  function fail(message) {
    idle(message);
  }

  // ---------------------------------------------------------------------------
  // Connecting
  // ---------------------------------------------------------------------------

  // Loads the library and connects to a broker; returns false (having said why) if that fails or
  // the player gave up in the meantime.
  async function connect(current) {
    run = randomText(8);
    seq = 0;
    try {
      await loadMqtt();
      if (current !== session) return false;
      const c = await connectBroker(current);
      if (!c) return false;
      client = c;
    } catch {
      if (current === session) fail('Could not reach the online game service. Check your internet connection and try again.');
      return false;
    }
    client.on('message', (_, payload) => {
      if (current === session) receiveRaw(payload);
    });
    return true;
  }

  async function host() {
    disconnect();
    const current = session;
    role = 'host';
    code = randomText(CODE_LENGTH);
    me = randomText(12);
    hostColor = hooks.preferredColor();
    show('Setting up your game…', button('Cancel', () => idle()));
    hooks.wait('Setting up your game…');
    if (!await connect(current)) return;
    client.subscribe(topic('guest'), { qos: 1 }, () => {
      if (current === session) waitingForGuest();
    });
  }

  async function join(text) {
    const wanted = parseCode(text);
    if (!wanted) return fail(`That code does not look right. It should be ${CODE_LENGTH} letters and numbers.`);
    disconnect();
    const current = session;
    role = 'guest';
    code = wanted;
    me = guestId(code);
    show(['Joining game ', strong(code), '…'], button('Cancel', () => idle()));
    hooks.wait('Joining your friend’s game…');
    if (!await connect(current)) return;
    client.subscribe(topic('host'), { qos: 1 }, () => {
      if (current !== session) return;
      send({ type: 'hello', name: hooks.myName() });
      joinTimer = setTimeout(() => {
        if (current === session && !friend) {
          fail(`Could not find game ${code}. Check the code, and that your friend still has the game open (with the link showing).`);
        }
      }, JOIN_TIMEOUT_MS);
    });
  }

  function startPinging() {
    clearInterval(pinger);
    lastHeard = Date.now();
    pinger = setInterval(() => {
      if (Date.now() - lastHeard > TIMEOUT_MS) lost();
      else send({ type: 'ping' });
    }, PING_MS);
  }

  function lost() {
    if (!friend) return;
    friend = null;
    clearInterval(pinger);
    if (role === 'host') {
      // Stay open so the friend can come back with the same link, e.g. after refreshing the page.
      show([`${Them()} disconnected. They can rejoin with the same link or the code `, strong(code), '.'], leaveButton());
      hooks.wait(`${Them()} disconnected. Waiting for them to come back…`);
      addChat('system', `${Them()} left.`);
    } else {
      show('Lost the connection to your friend’s game.', button('Reconnect', () => join(code), true), leaveButton());
      hooks.wait(`Lost the connection to ${them()}.`);
      addChat('system', 'Connection lost.');
    }
  }

  function disconnect() {
    if (friend) send({ type: 'bye' });
    session++;
    clearInterval(pinger);
    clearTimeout(joinTimer);
    if (client) client.end();
    client = friend = role = null;
    friendName = '';
    showChat(false);
    chatLogEl.replaceChildren();
    seen = { sender: null, seq: 0 };
    started = over = false;
    rematch = { me: false, them: false };
  }

  // Let the friend know straight away when this page is closed.
  addEventListener('pagehide', () => {
    if (friend) send({ type: 'bye' });
  });

  // ---------------------------------------------------------------------------
  // The game itself
  // ---------------------------------------------------------------------------

  function receiveRaw(payload) {
    let message;
    try {
      message = JSON.parse(payload.toString());
    } catch {
      return;
    }
    if (!message || typeof message !== 'object' || message.sender === me) return;
    if (message.recipient && message.recipient !== me) return;
    // The broker may deliver a message twice.
    const sender = message.sender + '/' + message.run;
    if (sender === seen.sender && message.seq <= seen.seq) return;
    seen = { sender, seq: message.seq };

    if (role === 'host' && message.type === 'hello') return welcome(message);
    if (role === 'host' && message.sender !== friend) return;
    if (role === 'guest' && friend && message.sender !== friend) return;
    lastHeard = Date.now();
    receive(message);
  }

  // A guest saying hello: the friend (re)joining, or somebody else with the link.
  function welcome({ sender, name }) {
    if (friend && friend !== sender) return send({ type: 'full' }, sender);
    friend = sender;
    setFriendName(name);
    startPinging();
    addChat('system', `${Them()} joined.`);
    guestArrived();
  }

  // The host's side of a friend (re)joining: carry on with the game in progress, or start a new one.
  function guestArrived() {
    const { moves, finished } = hooks.snapshot();
    if (started && !finished) {
      send({ type: 'start', color: hostColor ^ 8, moves, name: hooks.myName() });
      playing(`${Them()} is back.`);
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
    send({ type: 'start', color: hostColor ^ 8, moves: [], name: hooks.myName() });
    playing();
    hooks.begin(hostColor, []);
  }

  function offerDraw() {
    send({ type: 'draw-offer' });
    show(`Draw offered. Waiting for ${them()} to answer…`, leaveButton());
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
    switch (message.type) {
      case 'start':
        if (role !== 'guest') return;
        clearTimeout(joinTimer);
        if (!friend) {
          friend = message.sender;
          startPinging();
          addChat('system', 'Connected.');
        }
        setFriendName(message.name);
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
        show(`${Them()} offers a draw.`, button('Accept', () => {
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
        playing(`${Them()} declined the draw.`);
        break;
      case 'rematch':
        rematch.them = true;
        if (!maybeRematch() && over) gameOver();
        break;
      case 'bye':
        lost();
        break;
      case 'name':
        setFriendName(message.name);
        break;
      case 'chat':
        if (typeof message.text === 'string' && message.text.trim()) {
          addChat('theirs', message.text.slice(0, CHAT_LENGTH), Them());
          notify();
        }
        break;
      case 'emote':
        if (EMOTES.includes(message.emote)) {
          addChat('theirs', message.emote, Them());
          floatEmote(message.emote, false);
          notify();
        }
        break;
      case 'full':
        fail('That game already has two players.');
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Chat and emotes
  // ---------------------------------------------------------------------------

  function showChat(on) {
    chatEl.hidden = !on;
  }

  // kind: 'mine', 'theirs' or 'system'.
  function addChat(kind, text, who) {
    const item = document.createElement('li');
    item.className = 'chat-' + kind;
    if (who) {
      const name = document.createElement('span');
      name.className = 'chat-who';
      name.textContent = who;
      item.append(name, ' ');
    }
    const body = document.createElement('span');
    body.className = EMOTES.includes(text) ? 'chat-text chat-emote' : 'chat-text';
    body.textContent = text;
    item.append(body);
    chatLogEl.append(item);
    while (chatLogEl.children.length > CHAT_KEPT) chatLogEl.firstElementChild.remove();
    chatLogEl.scrollTop = chatLogEl.scrollHeight;
  }

  function say(text) {
    const clean = text.replace(/\s+/g, ' ').trim().slice(0, CHAT_LENGTH);
    if (!clean || !friend) return;
    send({ type: 'chat', text: clean });
    addChat('mine', clean, 'You');
  }

  function sendEmote(emote) {
    if (!friend) return;
    send({ type: 'emote', emote });
    addChat('mine', emote, 'You');
    floatEmote(emote, true);
  }

  // A big emoji drifting up over the board: from the bottom for yours, the top for your friend's.
  function floatEmote(emote, mine) {
    const el = document.createElement('span');
    el.className = 'emote-float ' + (mine ? 'mine' : 'theirs');
    el.textContent = emote;
    el.style.left = 20 + Math.random() * 60 + '%';
    boardWrapEl.append(el);
    el.addEventListener('animationend', () => el.remove());
  }

  // A message that arrives while you are in another tab shows in the tab's title until you return.
  const title = document.title;
  function notify() {
    if (document.hidden) document.title = '💬 ' + title;
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) document.title = title;
  });

  emotesEl.append(
    ...EMOTES.map((emote) => {
      const el = button(emote, () => sendEmote(emote));
      el.className = 'emote';
      el.setAttribute('aria-label', 'Send ' + emote);
      return el;
    }),
    ...QUICK_LINES.map((line) => {
      const el = button(line, () => say(line));
      el.className = 'quick-line';
      return el;
    }),
  );

  chatFormEl.addEventListener('submit', (event) => {
    event.preventDefault();
    say(chatInputEl.value);
    chatInputEl.value = '';
  });

  root.Online = {
    // hooks: wait(text) freezes the board with a message; begin(color, moves) starts (or restores)
    // a game with this player on `color`; resume() unfreezes it; move(), resign() and draw() report
    // the friend's actions; snapshot() returns { moves, finished } for a friend who rejoins; and
    // preferredColor() is the color the host picked; myName() is this player's name, and
    // friendName(name) passes on the friend's.
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
    sendName(name) {
      if (friend) send({ type: 'name', name });
    },
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
