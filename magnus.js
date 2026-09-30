// The top computer level, named after the world's best player: Stockfish 10, the open-source chess
// engine, at full strength. Our own engine is nowhere near that strong, so this level borrows
// Stockfish instead. It is fetched only when someone picks the level, and runs in a worker so the
// page stays smooth while it thinks. (It plays about as strongly as Magnus, not in his style.)
(function (root) {
  'use strict';

  const STOCKFISH_URL = 'https://cdnjs.cloudflare.com/ajax/libs/stockfish.js/10.0.2/stockfish.js';
  const LOAD_TIMEOUT_MS = 20000;

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
        const line = String(event.data);
        if (line === 'readyok') {
          clearTimeout(timer);
          worker.onmessage = (e) => listener && listener(String(e.data));
          resolve();
        }
      };
      worker.postMessage('uci');
      worker.postMessage('setoption name Skill Level value 20');
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

  // Stockfish's choice after the given moves from the starting position (in UCI notation, like
  // "e2e4" or "e7e8q"), thinking for `ms` milliseconds. Requests wait their turn, since Stockfish
  // thinks about one position at a time.
  function bestMove(moves, ms) {
    const request = queue.then(() => start()).then(() => new Promise((resolve) => {
      listener = (line) => {
        if (!line.startsWith('bestmove')) return;
        listener = null;
        const move = line.split(' ')[1];
        resolve(move && move !== '(none)' ? move : null);
      };
      worker.postMessage('ucinewgame');
      worker.postMessage('position startpos' + (moves.length ? ' moves ' + moves.join(' ') : ''));
      worker.postMessage('go movetime ' + ms);
    }));
    queue = request.catch(() => {});
    return request;
  }

  root.Magnus = { bestMove };
})(this);
