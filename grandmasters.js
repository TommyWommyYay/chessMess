// Grandmaster opponents: the world's top 10 players, each played by Stockfish 10 (the open-source
// chess engine) set to a strength that fits their rating. Our own engine is nowhere near that
// strong, so these opponents borrow Stockfish. It is fetched only when someone picks a grandmaster,
// and runs in a worker so the page stays smooth while it thinks. They play about as strongly as the
// real players, not in their style.
(function (root) {
  'use strict';

  const STOCKFISH_URL = 'https://cdnjs.cloudflare.com/ajax/libs/stockfish.js/10.0.2/stockfish.js';
  const LOAD_TIMEOUT_MS = 20000;
  const THINK_MS = 2000;

  // The top 10 of FIDE's standard rating list of 1 September 2026.
  const LIST = [
    { id: 'carlsen', name: 'Magnus Carlsen', country: 'NOR', rating: 2823 },
    { id: 'nakamura', name: 'Hikaru Nakamura', country: 'USA', rating: 2792 },
    { id: 'caruana', name: 'Fabiano Caruana', country: 'USA', rating: 2789 },
    { id: 'sindarov', name: 'Javokhir Sindarov', country: 'UZB', rating: 2778 },
    { id: 'so', name: 'Wesley So', country: 'USA', rating: 2774 },
    { id: 'keymer', name: 'Vincent Keymer', country: 'GER', rating: 2764 },
    { id: 'abdusattorov', name: 'Nodirbek Abdusattorov', country: 'UZB', rating: 2762 },
    { id: 'praggnanandhaa', name: 'R Praggnanandhaa', country: 'IND', rating: 2761 },
    { id: 'erigaisi', name: 'Arjun Erigaisi', country: 'IND', rating: 2759 },
    { id: 'giri', name: 'Anish Giri', country: 'NED', rating: 2757 },
  ];
  const LIST_DATE = 'September 2026';

  // Stockfish's "Skill Level" (0 to 20) for each: full strength for the top-rated player, and a
  // notch lower for every 25 or so rating points below that.
  LIST.forEach((gm, i) => {
    gm.rank = i + 1;
    gm.skill = Math.max(16, Math.round(20 - (LIST[0].rating - gm.rating) / 25));
    gm.initials = gm.name.split(' ').map((word) => word[0]).join('').slice(0, 2);
  });

  let worker = null;
  let ready = null;         // resolves once Stockfish has loaded and answered "readyok"
  let listener = null;      // handles Stockfish's output for the request in progress
  let queue = Promise.resolve();

  // Stockfish talks UCI, the standard text protocol for chess engines, one line per message.
  function start() {
    if (ready) return ready;
    ready = new Promise((resolve, reject) => {
      try {
        // A worker made from a Blob can load a script from another site, which a worker made from
        // that site's address cannot; this also works when the page is opened from disk.
        const source = `importScripts(${JSON.stringify(STOCKFISH_URL)});`;
        worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
      } catch (error) {
        return reject(error);
      }
      const timer = setTimeout(() => reject(new Error('Stockfish took too long to load')), LOAD_TIMEOUT_MS);
      worker.onerror = () => {
        clearTimeout(timer);
        reject(new Error('Stockfish did not load'));
      };
      worker.onmessage = (event) => {
        if (String(event.data) === 'readyok') {
          clearTimeout(timer);
          worker.onmessage = (e) => listener && listener(String(e.data));
          resolve();
        }
      };
      worker.postMessage('uci');
      worker.postMessage('isready');
    });
    ready.catch(() => {
      // Let a later game try again (e.g. once back online).
      if (worker) worker.terminate();
      worker = null;
      ready = null;
    });
    return ready;
  }

  // The grandmaster's choice after the given moves from the starting position (in UCI notation,
  // like "e2e4" or "e7e8q"). Requests wait their turn, since Stockfish thinks about one position at
  // a time.
  function bestMove(gm, moves) {
    const request = queue.then(() => start()).then(() => new Promise((resolve) => {
      listener = (line) => {
        if (!line.startsWith('bestmove')) return;
        listener = null;
        const move = line.split(' ')[1];
        resolve(move && move !== '(none)' ? move : null);
      };
      worker.postMessage('ucinewgame');
      worker.postMessage('setoption name Skill Level value ' + gm.skill);
      worker.postMessage('position startpos' + (moves.length ? ' moves ' + moves.join(' ') : ''));
      worker.postMessage('go movetime ' + THINK_MS);
    }));
    queue = request.catch(() => {});
    return request;
  }

  root.Grandmasters = {
    LIST,
    LIST_DATE,
    find: (id) => LIST.find((gm) => gm.id === id) || null,
    bestMove,
  };
})(this);
