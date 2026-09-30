(function () {
  'use strict';

  const {
    Game, chooseMove, sameMove, moveToUci, squareName, START_FEN,
    WHITE, BLACK, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING, F_EP, F_CASTLE, MIN_RATING, MAX_RATING,
  } = Chess;

  // Solid glyphs for both sides (coloured in CSS); U+FE0E stops the pawn rendering as an emoji.
  const GLYPHS = ['', '♟', '♞', '♝', '♜', '♛', '♚'].map((g) => g && g + '︎');
  const PIECE_NAMES = ['', 'pawn', 'knight', 'bishop', 'rook', 'queen', 'king'];
  const STORAGE_KEY = 'chessMess';
  const LAST_GAME_KEY = 'chessMess.lastGame';
  const MOVE_MS = 300;
  const NAME_LENGTH = 20;
  const START_RATING = 1200;
  const RATING_K = 32;      // how far one game can move your rating (the usual Elo K-factor)
  // What the computer's rating slider means, from the bottom up.
  const RATING_NAMES = [[400, 'Beginner'], [800, 'Casual'], [1200, 'Club player'], [1600, 'Strong'], [2000, 'Expert'], [2300, 'Master']];
  // Game modes. The timed ones offer chess.com's time controls: [minutes each, seconds added per move].
  const VARIANTS = {
    classic: { name: 'Classic', times: null },
    blitz: { name: 'Blitz', times: [[3, 0], [3, 2], [5, 0]] },
    rapid: { name: 'Rapid', times: [[10, 0], [15, 10], [30, 0]] },
    long: { name: 'Long', times: [[45, 15], [60, 0], [90, 30]] },
    chaos: { name: 'Chaos', times: null },
    custom: { name: 'Custom position', times: null },
  };
  const LOW_TIME_MS = 20 * 1000;     // below this a clock turns red and shows tenths of a second
  const DRAFT_DELAY_MS = 600;        // lets the last move land before a chaos round covers the board

  const boardEl = document.getElementById('board');
  const boardWrapEl = document.getElementById('board-wrap');
  const statusEl = document.getElementById('status');
  const promotionEl = document.getElementById('promotion');
  const promotionChoicesEl = document.getElementById('promotion-choices');
  const gameOverEl = document.getElementById('game-over');
  const mainEl = document.querySelector('main');
  const modeEl = document.getElementById('mode');
  const ratingEl = document.getElementById('rating');
  const opponentListEl = document.getElementById('opponent-list');
  const opponentNoteEl = document.getElementById('opponents-note');
  const sideEl = document.getElementById('side');
  const nameEls = {
    me: document.getElementById('name'),
    white: document.getElementById('white-name'),
    black: document.getElementById('black-name'),
  };
  const resignEl = document.getElementById('resign');
  const undoEl = document.getElementById('undo');
  const redoEl = document.getElementById('redo');
  const reviewLastEl = document.getElementById('review-last');
  const variantEl = document.getElementById('variant');
  const timeEl = document.getElementById('time');
  const editPositionEl = document.getElementById('edit-position');
  const gameInfoEl = document.getElementById('game-info');
  const clockEls = { top: document.getElementById('clock-top'), bottom: document.getElementById('clock-bottom') };
  const draftEl = document.getElementById('draft');
  const chaosLogEl = document.getElementById('chaos-log');
  const setupEl = document.getElementById('setup');
  const playAgainEl = document.getElementById('play-again');
  const scoreEls = {
    me: document.getElementById('score-me'),
    them: document.getElementById('score-them'),
    draws: document.getElementById('score-draws'),
  };

  const MODES = ['computer', 'local', 'online'];

  const saved = load(STORAGE_KEY);
  const blankScore = () => ({ me: 0, them: 0, draws: 0 });
  const scores = { computer: blankScore(), local: blankScore(), online: blankScore(), ...saved.scores };
  if (!saved.scores && saved.player !== undefined) {
    // Saved before there were other opponents than the computer.
    scores.computer = { me: saved.player || 0, them: saved.computer || 0, draws: saved.draws || 0 };
  }
  const joinCode = new URLSearchParams(location.search).get('join');
  modeEl.value = joinCode ? 'online' : MODES.includes(saved.mode) ? saved.mode : 'computer';
  // (Before the slider there were three difficulties.)
  const OLD_LEVELS = { easy: 600, medium: 1200, hard: 2000 };
  ratingEl.value = clampRating(saved.rating ?? OLD_LEVELS[saved.difficulty] ?? START_RATING);
  // Who you play in computer mode: 'custom' (our engine, at the slider's rating) or a grandmaster's
  // id. (A saved rating of 2850 was the slider's old Magnus stop.)
  let opponent = Grandmasters.find(saved.opponent) ? saved.opponent : saved.rating >= 2800 ? 'carlsen' : 'custom';
  sideEl.value = saved.side === 'black' ? 'black' : 'white';
  const names = { me: '', white: '', black: '', ...saved.names };
  for (const key of Object.keys(nameEls)) nameEls[key].value = names[key] = cleanName(names[key]);
  let myRating = Number.isFinite(saved.myRating) ? saved.myRating : START_RATING;
  let variant = VARIANTS[saved.variant] ? saved.variant : 'classic';
  // The chosen time control of each timed mode, as an index into its list.
  const timeChoice = { blitz: 0, rapid: 0, long: 0 };
  for (const key of Object.keys(timeChoice)) {
    const index = saved.times && saved.times[key];
    if (Number.isInteger(index) && VARIANTS[key].times[index]) timeChoice[key] = index;
  }
  let customFen = typeof saved.customFen === 'string' && !checkPosition(saved.customFen).error ? saved.customFen : START_FEN;
  variantEl.value = variant;

  let mode = modeEl.value;  // 'computer', 'local' (two players on this screen) or 'online'
  let game, playerColor, legal, selected, lastMove, positions, history, result;
  let redoStack = [];       // moves taken back with Undo, the next one to redo last
  // The rules of the game being played: { variant, fen (the starting position), time ({ base, inc }
  // in milliseconds, or null for no clock), seed (for chaos rounds) }.
  let gameSetup = null;
  let startTurn = WHITE;    // who moves first in gameSetup.fen
  // Everything played, in order: { type: 'move', from, to, promo } and { type: 'chaos', round, picks }.
  // It is what an online friend who rejoins is sent to rebuild the game.
  let timeline = [];
  // The clocks, in a timed game: `left` is the time each color has (as of `since`, for the one
  // running), `used` the time both have used between them (chaos rounds go by it) and `mark` the
  // time each had when the current turn began.
  let clock = null;
  let chaos = null;         // chaos bookkeeping (see Chaos.newState) plus the next round's number
  let draft = null;         // the chaos round being picked: { round, offers, picks }
  let drafting = false;     // a chaos round is due or being picked, so nobody can move
  let draftTimer = null;
  let friendPicks = {};     // an online friend's chaos picks that arrived early, by round
  let editing = false;      // the position editor has the board
  let edit = null;          // the position being set up: { board, turn, tool }
  let lastGame = load(LAST_GAME_KEY);
  let squareEls = [];
  let flipped = false;      // the board is drawn from black's side
  let dealing = false;      // true while the pieces drop in at the start of a game
  let reviewing = false;    // true while a finished game is being reviewed instead of played
  let waiting = false;      // an online game that has not started, or whose friend has dropped out
  let waitingText = '';
  let gameGm = null;        // the grandmaster being played, if any
  let gameRating = sliderRating();   // the computer's rating for the game being played
  let stockfishFailed = false;       // Stockfish could not be loaded, so grandmasters play as our 2400
  let friendName = '';      // the online friend's name, once they have sent it
  let turnToken = 0;        // bumped to cancel a computer move that is still being worked out
  let gameOverTimer = null;

  // Storage can be unavailable (e.g. in a private window); then things only last for this page load.
  function load(key) {
    try {
      return JSON.parse(localStorage.getItem(key)) || {};
    } catch {
      return {};
    }
  }

  function store(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // See load().
    }
  }

  function save() {
    store(STORAGE_KEY, {
      scores, mode, opponent, rating: sliderRating(), myRating, names, side: sideEl.value,
      variant, times: timeChoice, customFen,
    });
  }

  function clampRating(value) {
    return Math.min(MAX_RATING, Math.max(MIN_RATING, Math.round(Number(value) / 100) * 100 || START_RATING));
  }

  function sliderRating() {
    return Number(ratingEl.value);
  }

  function cleanName(text) {
    return String(text || '').replace(/\s+/g, ' ').trim().slice(0, NAME_LENGTH);
  }

  function ratingName(rating) {
    return RATING_NAMES.filter(([from]) => rating >= from).pop()[1];
  }

  // The two score columns, and the review's: this screen's player (or white) first.
  function columnNames() {
    if (mode === 'local') return [names.white || 'White', names.black || 'Black'];
    if (mode === 'computer') return [names.me || 'You', `${gameGm ? gameGm.name.split(' ').pop() : 'Computer'} (${gameRating})`];
    return [names.me || 'You', friendName || 'Friend'];
  }

  // Who moves the pieces of a color: 'me' (this screen), 'computer' or 'friend' (online).
  function seat(color) {
    if (mode === 'local' || color === playerColor) return 'me';
    return mode === 'computer' ? 'computer' : 'friend';
  }

  // How messages refer to a side.
  function sideName(color) {
    if (mode === 'local') return (color === WHITE ? names.white : names.black) || (color === WHITE ? 'white' : 'black');
    return { me: 'you', computer: gameGm ? gameGm.name : 'the computer', friend: friendName || 'your friend' }[seat(color)];
  }

  const capitalise = (text) => text[0].toUpperCase() + text.slice(1);

  // ---------------------------------------------------------------------------
  // Game modes
  // ---------------------------------------------------------------------------

  function timeName(time) {
    const minutes = time.base / 60000, increment = time.inc / 1000;
    return increment ? `${minutes} | ${increment}` : `${minutes} min`;
  }

  // "Blitz 3 | 2", "Chaos" or "Custom position"; nothing for a classic game.
  function setupName(setup) {
    if (!setup || setup.variant === 'classic') return '';
    const { name, times } = VARIANTS[setup.variant];
    return times && setup.time ? `${name} ${timeName(setup.time)}` : name;
  }

  function randomSeed() {
    return Math.random().toString(36).slice(2, 10);
  }

  // The rules for a new game, from the controls.
  function chosenSetup() {
    const times = VARIANTS[variant].times;
    let time = null;
    if (variant === 'chaos') {
      time = { ...Chaos.CLOCK };
    } else if (times) {
      const [minutes, increment] = times[timeChoice[variant]];
      time = { base: minutes * 60000, inc: increment * 1000 };
    }
    return { variant, fen: variant === 'custom' ? customFen : START_FEN, time, seed: randomSeed() };
  }

  // An online host's rules, checked over before they are used.
  function receivedSetup(setup) {
    if (!setup || typeof setup !== 'object' || !VARIANTS[setup.variant]) {
      return { variant: 'classic', fen: START_FEN, time: null, seed: randomSeed() };
    }
    let time = null;
    if (setup.variant === 'chaos') time = { ...Chaos.CLOCK };
    else if (VARIANTS[setup.variant].times && setup.time && Number.isFinite(setup.time.base) && setup.time.base > 0) {
      time = { base: setup.time.base, inc: Math.max(0, Number(setup.time.inc) || 0) };
    }
    const fen = typeof setup.fen === 'string' && !checkPosition(setup.fen).error ? setup.fen : START_FEN;
    return { variant: setup.variant, fen, time, seed: String(setup.seed || '') };
  }

  // Whether a position (a FEN, or a Game) can be played from. Returns { game } or { error }.
  function checkPosition(position) {
    let g;
    try {
      g = typeof position === 'string' ? new Game(position) : position;
    } catch {
      return { error: 'That is not a chess position.' };
    }
    if (!Array.isArray(g.board) || g.board.length !== 64) return { error: 'That is not a chess position.' };
    const kings = { [WHITE]: 0, [BLACK]: 0 };
    for (let sq = 0; sq < 64; sq++) {
      const piece = g.board[sq];
      if (!Number.isInteger(piece) || piece < 0 || piece > 14 || (piece && !(piece & 7)) || (piece & 7) === 7) {
        return { error: 'That is not a chess position.' };
      }
      if ((piece & 7) === KING) {
        kings[piece & 8]++;
        g.kingSq[piece & 8] = sq;
      }
      if ((piece & 7) === PAWN && (sq < 8 || sq >= 56)) return { error: 'Pawns can’t stand on the first or last rank.' };
    }
    if (kings[WHITE] !== 1 || kings[BLACK] !== 1) return { error: 'Each side needs exactly one king.' };
    const name = (color) => (color === WHITE ? 'White' : 'Black');
    if (g.inCheck(g.turn ^ 8)) {
      return { error: `${name(g.turn ^ 8)} is in check but it is ${name(g.turn).toLowerCase()}’s move, so the king could be taken. Change who moves first, or the pieces.` };
    }
    if (!g.legalMoves().length) {
      return { error: g.inCheck() ? `${name(g.turn)} is already checkmated.` : `${name(g.turn)} has no legal moves: that is stalemate already.` };
    }
    return { game: g };
  }

  // ---------------------------------------------------------------------------
  // Computer opponent. It thinks in a worker so the animations never stall; if a worker
  // cannot be started it falls back to thinking on the page itself.
  // ---------------------------------------------------------------------------

  let worker = null;
  let pending = null;
  let requestId = 0;

  try {
    worker = new Worker(URL.createObjectURL(new Blob([Chess.workerSource], { type: 'text/javascript' })));
    worker.onmessage = (event) => {
      if (pending && event.data.id === pending.id) {
        pending.resolve(event.data.move);
        pending = null;
      }
    };
    worker.onerror = () => {
      worker = null;
      if (pending) {
        pending.resolve(chooseMove(pending.game, pending.rating, pending.seen, pending.options));
        pending = null;
      }
    };
  } catch {
    worker = null;
  }

  function think() {
    if (gameGm && !stockfishFailed) return thinkLikeGrandmaster();
    return thinkOurselves(Math.min(gameRating, MAX_RATING));
  }

  // Limits on the computer's choice: frozen pieces stay put, and it hurries when short of time.
  function thinkOptions() {
    const exclude = chaos ? chaos.frozen.filter((f) => f.color === game.turn).map((f) => f.sq) : [];
    const maxMs = clock ? Math.max(100, clockLeft(game.turn) / 30) : Infinity;
    return { exclude, maxMs };
  }

  function thinkOurselves(rating) {
    const options = thinkOptions();
    return new Promise((resolve) => {
      if (!worker) {
        const current = game, seen = positions;
        setTimeout(() => resolve(chooseMove(current, rating, seen, options)), 50);
        return;
      }
      pending = { id: ++requestId, resolve, game, rating, seen: positions, options };
      worker.postMessage({ id: pending.id, state: game.snapshot(), rating, seen: [...positions], options });
    });
  }

  function thinkLikeGrandmaster() {
    const current = game, ply = history.length;
    const stillHere = () => current === game && ply === history.length;
    // A chaos round changes the board in ways moves cannot, so Stockfish gets the position itself.
    const position = chaos ? { fen: game.fen() }
      : { fen: gameSetup.fen === START_FEN ? null : gameSetup.fen, moves: history.map(moveToUci) };
    if (clock) position.movetime = clockLeft(game.turn) / 30;
    if (chaos && chaos.frozen.some((f) => f.color === game.turn)) position.only = legal.map(moveToUci);
    // Should Stockfish ever fail to answer (a position it cannot make sense of), stop waiting for it.
    const giveUp = new Promise((resolve) => setTimeout(() => resolve('timeout'), 25000));
    return Promise.race([Grandmasters.bestMove(gameGm, position), giveUp]).then(
      (uci) => {
        if (!stillHere()) return null;
        if (uci === 'timeout') {
          stockfishFailed = true;
          render();
        }
        return legal.find((m) => moveToUci(m) === uci) || thinkOurselves(MAX_RATING);
      },
      () => {
        // Stockfish is fetched from the internet; without it, play our own engine's best.
        stockfishFailed = true;
        render();
        return stillHere() ? thinkOurselves(MAX_RATING) : null;
      },
    );
  }

  function computerTurn() {
    const token = ++turnToken;
    // A reply that was taken back with Undo comes back as it was, instead of being thought out again.
    const redoing = redoStack.length > 0;
    // Wait at least long enough for the player's move (or the opening deal) to finish animating;
    // less long when the clock is ticking.
    const wait = redoing ? 450 : !lastMove ? 1300 : clock ? 400 : 700;
    const pause = new Promise((resolve) => setTimeout(resolve, wait));
    Promise.all([redoing ? null : think(), pause]).then(([move]) => {
      if (token !== turnToken || result || drafting) return;
      if (redoing) playMove(redoStack.pop(), undefined, true);
      else if (move) playMove(move);
    });
  }

  // ---------------------------------------------------------------------------
  // Game flow
  // ---------------------------------------------------------------------------

  let gameId = 0;           // bumped when a game starts or ends, to cancel anything still pending

  // Starts a game with this screen's player on `color` (for an online game, the color the host
  // picked; otherwise the "Play as" choice). `state` comes with an online game: the host's rules
  // and, when a friend rejoins, everything played so far (see gameState()). Otherwise the controls
  // decide.
  function newGame(color, state = null) {
    turnToken++;
    gameId++;
    clearTimeout(gameOverTimer);
    FX.stop();
    closeDraft();
    closeEditor();
    gameSetup = state ? receivedSetup(state.setup) : chosenSetup();
    game = new Game(gameSetup.fen);
    startTurn = game.turn;
    playerColor = mode === 'local' ? WHITE : color ?? (sideEl.value === 'black' ? BLACK : WHITE);
    gameGm = mode === 'computer' ? Grandmasters.find(opponent) : null;
    gameRating = gameGm ? gameGm.rating : sliderRating();
    selected = -1;
    lastMove = null;
    result = null;
    history = [];
    timeline = [];
    redoStack = [];
    positions = new Map([[game.key(), 1]]);
    chaos = gameSetup.variant === 'chaos' ? { ...Chaos.newState(), round: 0 } : null;
    const base = gameSetup.time ? gameSetup.time.base : 0;
    clock = gameSetup.time ? {
      base, inc: gameSetup.time.inc, left: { [WHITE]: base, [BLACK]: base }, mark: { [WHITE]: base, [BLACK]: base },
      used: 0, running: null, since: 0, started: false,
    } : null;
    drafting = false;
    friendPicks = {};
    chaosLogEl.replaceChildren();
    legal = computeLegal();
    for (const entry of state && Array.isArray(state.timeline) ? state.timeline : []) {
      if (!replayEntry(entry)) break;
    }
    if (clock && state && state.clocks) restoreClocks(state.clocks);
    promotionEl.hidden = true;
    gameOverEl.hidden = true;
    boardWrapEl.classList.remove('lost');
    dealing = !timeline.length;
    const id = gameId;
    setTimeout(() => {
      if (id === gameId) dealing = false;
    }, 1200);
    // A chaos game opens with a round (and a friend who rejoins may arrive in the middle of one).
    const drafts = maybeStartDraft(timeline.length ? 0 : 1200, state && state.picks);
    render();
    if (!drafts && seat(game.turn) === 'computer') computerTurn();
  }

  // Plays one item of an online game's timeline; returns false if it does not fit.
  function replayEntry(entry) {
    if (!entry || typeof entry !== 'object') return false;
    if (entry.type === 'chaos') {
      if (!chaos || entry.round !== chaos.round || !validPicks(entry.round, entry.picks)) return false;
      playChaosRound(entry.round, entry.picks);
    } else {
      const move = legal.find((m) => sameMove(m, entry));
      if (!move) return false;
      if (clock) clock.started = true;
      advance(move);
    }
    legal = computeLegal();
    return true;
  }

  function validPicks(round, picks) {
    return Boolean(picks) && [WHITE, BLACK].every((color) => Chaos.offers(gameSetup.seed, round, color).includes(picks[color]));
  }

  // An online game as it stands, for a friend who (re)joins.
  function gameState() {
    return {
      setup: gameSetup,
      timeline,
      clocks: clock && {
        [WHITE]: clockLeft(WHITE), [BLACK]: clockLeft(BLACK), used: clock.used, started: clock.started, mark: clock.mark,
      },
      picks: draft ? draft.picks : null,
    };
  }

  function restoreClocks(saved) {
    const time = (value, fallback) => (Number.isFinite(value) && value >= 0 ? value : fallback);
    for (const color of [WHITE, BLACK]) {
      clock.left[color] = time(saved[color], clock.left[color]);
      clock.mark[color] = time(saved.mark && saved.mark[color], clock.left[color]);
    }
    clock.used = time(saved.used, clock.used);
    clock.started = Boolean(saved.started);
  }

  // `winner` is a color, or null for a draw.
  function finish(winner, message) {
    result = message;
    turnToken++;
    gameId++;
    closeDraft();
    drafting = false;
    promotionEl.hidden = true;
    selected = -1;
    stopClock();
    const iWon = winner !== null && seat(winner) === 'me';
    const column = winner === null ? 'draws' : (mode === 'local' ? winner === WHITE : iWon) ? 'me' : 'them';
    scores[mode][column]++;
    const ratingText = mode === 'computer' ? rate(winner === null ? 0.5 : iWon ? 1 : 0) : '';
    save();
    // Kept so the game can be reviewed afterwards, even after the page is reloaded. A chaos game
    // cannot be: its rounds change the board in ways the review cannot follow.
    if (history.length && !chaos) {
      lastGame = {
        moves: history.map(({ from, to, promo }) => ({ from, to, promo })),
        fen: gameSetup.fen === START_FEN ? undefined : gameSetup.fen,
        player: playerColor === BLACK ? 'black' : 'white',
        opponent: mode,
        level: gameRating,
        opponentName: gameGm ? gameGm.name : undefined,
        names: columnNames(),
        result: message,
      };
      store(LAST_GAME_KEY, lastGame);
    }
    if (mode === 'online') Online.gameOver();

    let title = 'Draw', mood = 'draw';
    if (winner !== null && mode === 'local') [title, mood] = [capitalise(sideName(winner)) + ' wins!', 'win'];
    else if (winner !== null) [title, mood] = iWon ? ['You win!', 'win'] : ['Defeat', 'loss'];
    const reviewable = !chaos;
    // Let the final move (and any explosion) play out before announcing the result.
    gameOverTimer = setTimeout(() => {
      document.getElementById('game-over-title').textContent = title;
      document.getElementById('game-over-text').textContent = message;
      const ratingLine = document.getElementById('game-over-rating');
      ratingLine.textContent = ratingText;
      ratingLine.hidden = !ratingText;
      document.getElementById('review-game').hidden = !reviewable;
      playAgainEl.textContent = mode === 'online' ? 'Rematch' : 'Play again';
      gameOverEl.className = 'overlay ' + mood;
      gameOverEl.hidden = false;
      if (mood === 'win') FX.celebrate();
      if (mood === 'loss') boardWrapEl.classList.add('lost');
    }, 900);
  }

  // Moves your rating after a game against the computer (Elo: more for beating a stronger
  // computer, less for beating a weaker one) and describes the change.
  function rate(points) {
    const expected = 1 / (1 + 10 ** ((gameRating - myRating) / 400));
    const change = Math.round(RATING_K * (points - expected));
    myRating = Math.max(100, myRating + change);
    return `Your rating: ${myRating} (${change >= 0 ? '+' : '−'}${Math.abs(change)})`;
  }

  function resignText(loser) {
    const winner = sideName(loser ^ 8);
    return `${capitalise(sideName(loser))} resigned — ${winner} ${winner === 'you' ? 'win' : 'wins'}.`;
  }

  function checkmateText(winner) {
    if (mode !== 'local' && seat(winner) === 'me') return `Checkmate — you beat ${sideName(winner ^ 8)}.`;
    return `Checkmate — ${sideName(winner)} wins.`;
  }

  // Only a lone king, or a king with one knight or bishop, has no way at all to checkmate.
  function canMate(color) {
    let minors = 0;
    for (const piece of game.board) {
      if (!piece || (piece & 8) !== color) continue;
      const type = piece & 7;
      if (type === PAWN || type === ROOK || type === QUEEN) return true;
      if (type === KNIGHT || type === BISHOP) minors++;
    }
    return minors >= 2;
  }

  // [winner, message] when `loser`'s time runs out.
  function timeoutResult(loser) {
    const winner = loser ^ 8, name = capitalise(sideName(loser)), other = sideName(winner);
    if (!canMate(winner)) return [null, `${name} ran out of time, but ${other} can’t checkmate — a draw.`];
    return [winner, `${name} ran out of time — ${other} ${other === 'you' ? 'win' : 'wins'}.`];
  }

  // Makes a move on the board without any of the presentation; returns the new position's key.
  function record(move) {
    game.make(move);
    history.push(move);
    lastMove = move;
    const key = game.key();
    positions.set(key, (positions.get(key) || 0) + 1);
    return key;
  }

  // Plays a move with the chaos rules that come with it, but none of the presentation. Returns the
  // new position's key.
  function advance(move) {
    const mover = game.turn;
    if (chaos && move.captured) chaos.captured[mover ^ 8].push(move.captured & 7);
    const key = record(move);
    timeline.push({ type: 'move', from: move.from, to: move.to, promo: move.promo || 0 });
    if (chaos) {
      // Frozen pieces thaw a turn at a time, and are forgotten once taken.
      chaos.frozen = chaos.frozen.filter((f) => {
        if (f.color === mover) f.turns--;
        const piece = game.board[f.sq];
        return f.turns > 0 && piece && (piece & 8) === f.color;
      });
      // Rage: the same side moves again, unless its move gave check or ended the game.
      if (chaos.rage[mover]) {
        chaos.rage[mover] = false;
        if (!game.inCheck() && game.legalMoves().length && !game.insufficientMaterial()) {
          const ep = game.ep;
          game.turn = mover;
          game.ep = -1;
          if (!game.legalMoves().length) {
            game.turn = mover ^ 8;
            game.ep = ep;
          }
        }
      }
    }
    return key;
  }

  // The moves the side to move may make: all legal ones, less those of frozen pieces. Frozen pieces
  // thaw early rather than leave no move at all.
  function computeLegal() {
    const moves = game.legalMoves();
    if (!chaos) return moves;
    const frozen = new Set(chaos.frozen.filter((f) => f.color === game.turn).map((f) => f.sq));
    const free = moves.filter((m) => !frozen.has(m.from));
    if (free.length || !moves.length) return free;
    chaos.frozen = chaos.frozen.filter((f) => f.color !== game.turn);
    return moves;
  }

  // `drop` is set when the player dragged the piece onto its square, so it should not slide there
  // again; it holds how far the piece was swinging when it was let go. `redoing` is set when the
  // move is one that was taken back with Undo; any other move forgets the moves that could be redone.
  // `reportedClock` is an online friend's time after their move, as their page counted it.
  function playMove(move, drop, redoing = false, reportedClock = null) {
    const mover = game.turn;
    dealing = false;
    if (!redoing) redoStack = [];
    clockMoved(mover, reportedClock);
    const key = advance(move);
    selected = -1;
    legal = computeLegal();
    if (mode === 'online' && seat(mover) === 'me') Online.sendMove(move, history.length - 1, clock ? clock.left[mover] : null);
    checkGameOver(key);
    const drafts = maybeStartDraft(DRAFT_DELAY_MS);
    render();
    // An online friend's move can arrive during a review, or while the editor has the board.
    if (!reviewing && !editing) animateMove(move, mover, drop);
    if (!result && !drafts && seat(game.turn) === 'computer') computerTurn();
  }

  // Ends the game if the position calls for it. `key` is the position's after a move; `byChaos` is
  // set when a chaos round made the position.
  function checkGameOver(key, byChaos = false) {
    if (result) return;
    if (!legal.length) {
      const winner = game.turn ^ 8;
      if (game.inCheck()) finish(winner, (byChaos ? 'Chaos! ' : '') + checkmateText(winner));
      else finish(null, (byChaos ? 'Chaos! ' : '') + 'Stalemate — no legal moves left.');
    } else if (game.insufficientMaterial()) {
      finish(null, 'Not enough pieces left to checkmate.');
    } else if (key && positions.get(key) >= 3) {
      finish(null, 'The same position came up three times.');
    } else if (game.halfmove >= 100) {
      finish(null, 'Fifty moves without a capture or pawn move.');
    }
  }

  // ---------------------------------------------------------------------------
  // Clocks
  // ---------------------------------------------------------------------------

  function clockLeft(color) {
    const running = clock.running === color ? performance.now() - clock.since : 0;
    return Math.max(0, clock.left[color] - running);
  }

  function stopClock() {
    if (!clock || clock.running === null) return;
    clock.left[clock.running] = clockLeft(clock.running);
    clock.running = null;
  }

  // Runs the clock of the side to move, unless the game has not begun, is over or is paused. An
  // offline game pauses while the board is lent to a review or the editor; an online one only for
  // a chaos round or a friend who dropped out.
  function syncClock() {
    if (!clock) return;
    const paused = !clock.started || result || drafting || waiting || (mode !== 'online' && (reviewing || editing));
    const wanted = paused ? null : game.turn;
    if (clock.running === wanted) return;
    stopClock();
    if (wanted !== null) {
      clock.running = wanted;
      clock.since = performance.now();
    }
  }

  // The clocks after `mover` moves: its clock stops (at the time its own page reports, for an online
  // friend) and gains the increment. The game's first move is free: the clocks start after it.
  function clockMoved(mover, reported) {
    if (!clock) return;
    stopClock();
    const bonus = clock.started ? clock.inc : 0;
    if (typeof reported === 'number' && Number.isFinite(reported)) clock.left[mover] = Math.max(0, reported);
    else clock.left[mover] += bonus;
    clock.used += Math.max(0, clock.mark[mover] + bonus - clock.left[mover]);
    clock.started = true;
    clock.mark = { [WHITE]: clock.left[WHITE], [BLACK]: clock.left[BLACK] };
  }

  // Clock time used by both players so far, counting the turn in progress.
  function usedNow() {
    return clock.used + (clock.running === null ? 0 : Math.max(0, clock.mark[clock.running] - clockLeft(clock.running)));
  }

  function formatTime(ms) {
    if (ms < LOW_TIME_MS) {
      const tenths = Math.floor(ms / 100);
      return `0:${String(Math.floor(tenths / 10)).padStart(2, '0')}.${tenths % 10}`;
    }
    const seconds = Math.floor(ms / 1000);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }

  function flag(color) {
    stopClock();
    clock.left[color] = 0;
    const [winner, message] = timeoutResult(color);
    if (mode === 'online') Online.timeout();
    finish(winner, message);
    render();
  }

  // Keeps the clocks (and the chaos countdown) up to date, and calls time.
  setInterval(() => {
    if (!clock || !game) return;
    renderClocks();
    renderGameInfo();
    const color = clock.running;
    if (color === null || clockLeft(color) > 0) return;
    // An online friend's own page says when their time is up.
    if (mode === 'online' && seat(color) === 'friend') return;
    flag(color);
  }, 100);

  // ---------------------------------------------------------------------------
  // Chaos rounds. When a round is due (at the start, and then each time the players have used a
  // certain amount of clock time between them) the clocks stop and each player picks one of three
  // modifiers; then both are applied, white's first.
  // ---------------------------------------------------------------------------

  function chaosDue() {
    return Boolean(chaos) && !result && chaos.round < Chaos.ROUNDS.length && clock.used >= Chaos.ROUNDS[chaos.round];
  }

  // Starts the next chaos round after `delay` if it is due, and returns whether it is. `known` holds
  // picks already made (in a round a rejoining online friend arrives in the middle of).
  function maybeStartDraft(delay, known) {
    if (!chaosDue()) return false;
    drafting = true;
    const id = gameId;
    setTimeout(() => {
      if (id === gameId && !result && !draft) startDraft(known);
    }, delay);
    return true;
  }

  function startDraft(known) {
    const round = chaos.round, seed = gameSetup.seed;
    draft = {
      round,
      offers: { [WHITE]: Chaos.offers(seed, round, WHITE), [BLACK]: Chaos.offers(seed, round, BLACK) },
      picks: {},
    };
    drafting = true;
    for (const color of [WHITE, BLACK]) {
      const pick = (known && known[color]) || (seat(color) === 'friend' ? friendPicks[round] : null);
      if (pick && draft.offers[color].includes(pick)) draft.picks[color] = pick;
      if (seat(color) === 'computer') draft.picks[color] = computerPick(color);
    }
    render();
    nextPick();
  }

  function computerPick(color) {
    return Chaos.choose(game, {
      seed: gameSetup.seed, round: draft.round, offered: draft.offers[color], color, state: chaos,
      clockLeft: (c) => clock.left[c],
      // Weaker computers judge the modifiers more loosely.
      noise: gameGm ? 0 : Math.max(0, (1800 - gameRating) / 3),
    });
  }

  // Shows the next pick to be made on this screen, waits for an online friend's, or plays the round.
  function nextPick() {
    clearInterval(draftTimer);
    const color = [WHITE, BLACK].find((c) => seat(c) === 'me' && !draft.picks[c]);
    if (color !== undefined) return showOffers(color);
    if (draft.picks[WHITE] && draft.picks[BLACK]) return resolveDraft();
    showDraftCard(`Waiting for ${sideName(playerColor ^ 8)} to pick…`, []);
  }

  function showOffers(color) {
    const title = mode === 'local' ? `${capitalise(sideName(color))}, pick a modifier` : 'Pick a modifier';
    const choices = draft.offers[color].map((id) => {
      const modifier = Chaos.find(id);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'draft-choice';
      const icon = document.createElement('span');
      icon.className = 'draft-icon';
      icon.textContent = modifier.icon;
      const name = document.createElement('strong');
      name.textContent = modifier.name;
      const text = document.createElement('span');
      text.className = 'draft-text';
      text.textContent = modifier.text;
      button.append(icon, name, text);
      button.addEventListener('click', () => pickModifier(color, id));
      return button;
    });
    showDraftCard(title, choices);
    // A pick is made at random for anyone who takes too long.
    const deadline = performance.now() + Chaos.PICK_MS;
    const bar = document.querySelector('#draft-timer div');
    bar.style.width = '100%';
    draftTimer = setInterval(() => {
      const left = deadline - performance.now();
      bar.style.width = Math.max(0, left / Chaos.PICK_MS * 100) + '%';
      if (left <= 0) {
        const offered = draft.offers[color];
        pickModifier(color, offered[Math.floor(Math.random() * offered.length)]);
      }
    }, 100);
  }

  function showDraftCard(title, choices) {
    document.getElementById('draft-round').textContent = `Chaos round ${draft.round + 1} of ${Chaos.ROUNDS.length}`;
    document.getElementById('draft-title').textContent = title;
    document.getElementById('draft-choices').replaceChildren(...choices);
    document.getElementById('draft-timer').hidden = !choices.length;
    draftEl.hidden = false;
  }

  function pickModifier(color, id) {
    if (!draft || draft.picks[color]) return;
    draft.picks[color] = id;
    if (mode === 'online') Online.sendChaosPick(draft.round, id);
    nextPick();
  }

  function closeDraft() {
    clearInterval(draftTimer);
    draftEl.hidden = true;
    draft = null;
  }

  function resolveDraft() {
    const { round, picks } = draft;
    closeDraft();
    drafting = false;
    const outcomes = playChaosRound(round, picks);
    legal = computeLegal();
    positions.set(game.key(), (positions.get(game.key()) || 0) + 1);
    checkGameOver(null, true);
    render();
    showChaos(outcomes);
    if (!result && seat(game.turn) === 'computer') computerTurn();
  }

  // Applies both picks of a round, white's first, and returns what happened.
  function playChaosRound(round, picks) {
    const outcomes = [WHITE, BLACK].map((color) => {
      const o = Chaos.apply(game, { seed: gameSetup.seed, round, picks, color, state: chaos, clockLeft: (c) => clock.left[c] });
      for (const [c, change] of Object.entries(o.clock)) clock.left[c] = Math.max(0, clock.left[c] + change);
      return o;
    });
    clock.mark = { [WHITE]: clock.left[WHITE], [BLACK]: clock.left[BLACK] };
    chaos.round = round + 1;
    timeline.push({ type: 'chaos', round, picks: { [WHITE]: picks[WHITE], [BLACK]: picks[BLACK] } });
    selected = -1;
    return outcomes;
  }

  // Says what each pick did, over the board, and shows it happening.
  function showChaos(outcomes) {
    for (const o of outcomes) {
      const label = o.mirrored && o.modifier.id !== 'mirror-both' ? `Mirror → ${o.modifier.name}` : o.pick.name;
      const item = document.createElement('li');
      item.textContent = `${o.modifier.icon} ${capitalise(sideName(o.color))} — ${label}: ${o.text}.`;
      chaosLogEl.append(item);
      setTimeout(() => item.remove(), 7000);
      if (reviewing || editing) continue;
      for (const { sq, piece } of o.destroyed) blowUp(sq, piece);
      for (const sq of o.spawned) {
        const piece = squareEls[sq].querySelector('.piece');
        if (piece) piece.animate({ scale: [0, 1.4, 1], opacity: [0, 1, 1] }, { duration: 550, easing: 'ease-out' });
      }
      for (const sq of o.changed) {
        const piece = squareEls[sq].querySelector('.piece');
        if (piece) piece.animate({ scale: [1.5, 1], filter: ['brightness(4)', 'none'] }, { duration: 600, easing: 'ease-out' });
      }
      for (const { from, to } of o.moved) slide(from, to);
    }
    while (chaosLogEl.children.length > 4) chaosLogEl.firstElementChild.remove();
  }

  // ---------------------------------------------------------------------------
  // Undo and redo, for untimed games against the computer and on a shared screen. Against the
  // computer, Undo takes back your last move along with the computer's reply to it (or stops the
  // computer thinking about one), so it is your move again.
  // ---------------------------------------------------------------------------

  function colorOfPly(ply) {
    return ply % 2 ? startTurn ^ 8 : startTurn;
  }

  function undoAllowed() {
    return mode !== 'online' && !clock && !chaos && !reviewing && !editing && !result;
  }

  function canUndo() {
    return undoAllowed() && history.some((_, ply) => seat(colorOfPly(ply)) === 'me');
  }

  function canRedo() {
    return undoAllowed() && redoStack.length > 0 && seat(game.turn) === 'me';
  }

  // Sets the game up afresh with `moves` played.
  function replay(moves) {
    game = new Game(gameSetup.fen);
    history = [];
    timeline = [];
    lastMove = null;
    positions = new Map([[game.key(), 1]]);
    for (const move of moves) advance(move);
    legal = computeLegal();
    selected = -1;
  }

  function undo() {
    if (!canUndo()) return;
    turnToken++;   // the computer stops thinking about its reply
    const undone = [];
    while (history.length) {
      undone.push(history.pop());
      if (seat(colorOfPly(history.length)) === 'me') break;
    }
    redoStack.push(...undone);
    replay(history);
    dealing = false;
    promotionEl.hidden = true;
    render();
    // The pieces slide back where they came from, and anything they took reappears.
    for (const move of undone) {
      slide(move.to, move.from);
      slideRook(move, true);
      if (!move.captured) continue;
      const captureSq = move.flags & F_EP ? move.to + ((move.piece & 8) === WHITE ? 8 : -8) : move.to;
      const piece = squareEls[captureSq].querySelector('.piece');
      if (piece) piece.animate({ opacity: [0, 1], scale: [0.4, 1] }, { duration: MOVE_MS, easing: 'ease-out' });
    }
  }

  // Plays the next move taken back with Undo; against the computer, its reply follows by itself.
  function redo() {
    if (!canRedo()) return;
    promotionEl.hidden = true;
    playMove(redoStack.pop(), undefined, true);
  }

  function playerCanMove() {
    return !reviewing && !editing && !waiting && !drafting && !result && seat(game.turn) === 'me' && promotionEl.hidden;
  }

  function onSquareClick(sq) {
    if (editing) return editSquare(sq);
    if (!playerCanMove()) return;
    dealing = false;
    if (selected !== -1) {
      const moves = legal.filter((m) => m.from === selected && m.to === sq);
      if (moves.length > 1) return askPromotion(moves);
      if (moves.length === 1) return playMove(moves[0]);
    }
    const piece = game.board[sq];
    selected = piece && (piece & 8) === game.turn && sq !== selected ? sq : -1;
    render();
  }

  function askPromotion(moves, drop) {
    promotionChoicesEl.replaceChildren(...moves.map((m) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'square';
      button.setAttribute('aria-label', PIECE_NAMES[m.promo]);
      button.append(pieceEl(game.turn | m.promo));
      button.addEventListener('click', () => {
        promotionEl.hidden = true;
        playMove(m, drop);
      });
      return button;
    }));
    promotionEl.hidden = false;
  }

  // ---------------------------------------------------------------------------
  // Mouse and touch: click a piece and then a square, or pick the piece up and drag it there.
  // ---------------------------------------------------------------------------

  let drag = null;

  // A held piece hangs from the pointer like a pendulum. A spring pulls its angle towards a lean
  // that trails the direction of travel; being underdamped, it overshoots and sways before settling.
  const SWING_STIFFNESS = 95, SWING_DAMPING = 4.8;
  const SWING_LEAN = 5.2;   // degrees of lean per square-per-second of sideways speed
  const SWING_LIMIT = 58;
  const DRAG_PIVOT_FROM_CENTER = 0.48; // square heights from the piece center up to its held top

  function swing(now) {
    if (!drag || !drag.lifted) return;
    const dt = Math.min((now - drag.time) / 1000, 0.05);
    if (dt > 0) {
      const squaresPerSecond = (drag.x - drag.lastX) / dt / (boardEl.clientWidth / 8);
      drag.time = now;
      drag.lastX = drag.x;
      // Pointer speed is jumpy from frame to frame, so smooth it before leaning into it.
      drag.speed += (squaresPerSecond - drag.speed) * 0.35;
      const lean = Math.max(-SWING_LIMIT, Math.min(SWING_LIMIT, drag.speed * SWING_LEAN));
      drag.spin += (SWING_STIFFNESS * (lean - drag.angle) - SWING_DAMPING * drag.spin) * dt;
      drag.angle += drag.spin * dt;
      drag.piece.style.rotate = drag.angle.toFixed(2) + 'deg';
      placeDraggedPiece();
    }
    requestAnimationFrame(swing);
  }

  function placeDraggedPiece() {
    const home = squareEls[drag.sq].getBoundingClientRect();
    const square = home.width;
    const angle = drag.angle * Math.PI / 180;
    const pivotX = Math.sin(angle) * square * 0.08;
    const x = drag.x - home.left - home.width / 2 + pivotX;
    const y = drag.y - home.top - home.height / 2 + square * DRAG_PIVOT_FROM_CENTER;
    drag.piece.style.translate = `${x}px ${y}px`;
  }

  // The last of the swing dying away once a piece has been put down.
  function settle(piece, angle) {
    return piece.animate(
      { rotate: [angle, -angle * 0.45, angle * 0.2, 0].map((a) => a.toFixed(2) + 'deg') },
      { duration: 420, easing: 'ease-out' },
    );
  }

  function squareAt(x, y) {
    const box = boardEl.getBoundingClientRect();
    const col = Math.floor((x - box.left) / (box.width / 8));
    const row = Math.floor((y - box.top) / (box.height / 8));
    if (col < 0 || col > 7 || row < 0 || row > 7) return -1;
    return flipped ? 63 - (row * 8 + col) : row * 8 + col;
  }

  // The nearest point to the pointer that keeps a dragged piece on the board, a little in from the
  // edge so the piece is not cut off.
  function onBoard(event) {
    const box = boardEl.getBoundingClientRect();
    const inset = box.width / 8 * 0.3;
    return {
      x: Math.min(Math.max(event.clientX, box.left + inset), box.right - inset),
      y: Math.min(Math.max(event.clientY, box.top + inset), box.bottom - inset),
    };
  }

  boardEl.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || drag) return;
    const sq = squareAt(event.clientX, event.clientY);
    if (editing) {
      if (sq !== -1) editSquare(sq);
      return;
    }
    if (sq === -1 || !playerCanMove()) return;
    const piece = game.board[sq];
    // Pressing anything but one of the player's own pieces is a plain click: move there, or deselect.
    if (!piece || (piece & 8) !== game.turn) return onSquareClick(sq);

    const wasSelected = selected === sq;
    dealing = false;
    selected = sq;
    render();
    drag = {
      sq, wasSelected, startX: event.clientX, startY: event.clientY,
      piece: squareEls[sq].querySelector('.piece'), lifted: false, over: null,
      x: 0, y: 0, lastX: 0, time: 0, speed: 0, angle: 0, spin: 0,
    };
  });

  addEventListener('pointermove', (event) => {
    if (!drag) return;
    const { x, y } = onBoard(event);
    if (!drag.lifted) {
      // A few pixels of slack, so that an ordinary click does not count as a drag.
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 5) return;
      drag.lifted = true;
      squareEls[drag.sq].classList.add('dragging');
      boardEl.classList.add('grabbing');
      // Start the pendulum with a small kick so the piece visibly dangles as soon as it is lifted.
      drag.lastX = x;
      drag.time = performance.now();
      drag.spin = 260;
      requestAnimationFrame(swing);
    }
    drag.x = x;
    drag.y = y;
    placeDraggedPiece();
    const over = squareEls[squareAt(x, y)];
    if (over !== drag.over) {
      if (drag.over) drag.over.classList.remove('drag-over');
      if (over) over.classList.add('drag-over');
      drag.over = over;
    }
  });

  function endDrag(event) {
    if (!drag) return;
    const { sq, wasSelected, piece, lifted, over, angle } = drag;
    drag = null;
    boardEl.classList.remove('grabbing');
    if (over) over.classList.remove('drag-over');
    if (!lifted) {
      // A click without a drag: clicking the piece that was already selected puts it back down.
      if (wasSelected) {
        selected = -1;
        render();
      }
      return;
    }

    const point = onBoard(event);
    const to = event.type === 'pointercancel' ? -1 : squareAt(point.x, point.y);
    // (An online game can be paused while a piece is in the air, if the friend drops out.)
    const moves = playerCanMove() ? legal.filter((m) => m.from === sq && m.to === to) : [];
    if (!moves.length) {
      // Not a legal square: the piece glides back to where it was picked up and stays selected.
      const home = squareEls[sq];
      piece.animate({ translate: [piece.style.translate, '0px 0px'] }, { duration: 220, easing: 'cubic-bezier(0.25, 0.8, 0.3, 1)' });
      settle(piece, angle).onfinish = () => home.classList.remove('dragging');
      piece.style.translate = '';
      piece.style.rotate = '';
      return;
    }
    if (moves.length > 1) {
      // A promotion: leave the pawn sitting on the last rank while the player chooses a piece.
      const from = squareEls[sq].getBoundingClientRect(), target = squareEls[to].getBoundingClientRect();
      piece.style.translate = `${target.left - from.left}px ${target.top - from.top}px`;
      piece.style.rotate = '';
      settle(piece, angle);
      return askPromotion(moves, { angle: 0 });
    }
    playMove(moves[0], { angle });
  }

  addEventListener('pointerup', endDrag);
  addEventListener('pointercancel', endDrag);

  // ---------------------------------------------------------------------------
  // Animation
  // ---------------------------------------------------------------------------

  // The board is already drawn with the move made; this slides the piece in from where it came from.
  function slide(from, to) {
    const square = squareEls[to];
    const piece = square.querySelector('.piece:not(.ghost)');
    if (!piece) return;
    const size = boardEl.clientWidth / 8;
    const facing = flipped ? -1 : 1;
    const dx = ((from & 7) - (to & 7)) * size * facing;
    const dy = ((from >> 3) - (to >> 3)) * size * facing;
    square.classList.add('moving');
    // The glide and the little lift are separate animations so the glide keeps one smooth curve.
    piece.animate({ translate: [`${dx}px ${dy}px`, '0px 0px'] }, { duration: MOVE_MS, easing: 'cubic-bezier(0.25, 0.8, 0.3, 1)' })
      .onfinish = () => square.classList.remove('moving');
    piece.animate({ scale: [1, 1.25, 1] }, { duration: MOVE_MS, easing: 'ease-in-out' });
  }

  // When castling, the rook jumps over the king: from the corner to the square next to it
  // (or, when the castling is undone, back to the corner).
  function slideRook(move, back = false) {
    if (!(move.flags & F_CASTLE)) return;
    const [corner, beside] = move.to > move.from ? [move.to + 1, move.to - 1] : [move.to - 2, move.to + 1];
    if (back) slide(beside, corner);
    else slide(corner, beside);
  }

  function animateMove(move, mover, drop) {
    if (drop) {
      // The piece is already there; just let it settle from its lifted size and stop swinging.
      const piece = squareEls[move.to].querySelector('.piece');
      piece.animate({ scale: [1.25, 1] }, { duration: 180, easing: 'ease-out' });
      settle(piece, drop.angle);
    } else {
      slide(move.from, move.to);
    }
    slideRook(move);
    if (!move.captured) return;

    // Keep the captured piece on its square until the attacker arrives, then blow it up.
    const captureSq = move.flags & F_EP ? move.to + (mover === WHITE ? 8 : -8) : move.to;
    blowUp(captureSq, move.captured, drop ? 0 : MOVE_MS * 0.6);
  }

  // Blows up `piece`, which has just left square `sq` (taken, or destroyed in a chaos round).
  function blowUp(sq, piece, delay = 0) {
    const square = squareEls[sq];
    const ghost = pieceEl(piece);
    ghost.classList.add('ghost');
    square.prepend(ghost);
    setTimeout(() => {
      const box = square.getBoundingClientRect();
      FX.explode(box.left + box.width / 2, box.top + box.height / 2, box.width, (piece & 8) === WHITE);
      ghost.animate([
        { transform: 'scale(1)', opacity: 1, filter: 'brightness(3)' },
        { transform: 'scale(2.4)', opacity: 0, filter: 'brightness(6) blur(5px)' },
      ], { duration: 260, easing: 'ease-out', fill: 'forwards' }).onfinish = () => ghost.remove();
      boardWrapEl.animate([
        { transform: 'translate(0, 0)' },
        { transform: 'translate(-7px, 4px) rotate(-0.4deg)' },
        { transform: 'translate(6px, -5px) rotate(0.4deg)' },
        { transform: 'translate(-4px, -3px)' },
        { transform: 'translate(3px, 3px)' },
        { transform: 'translate(0, 0)' },
      ], { duration: 380, easing: 'ease-out' });
    }, delay);
  }

  function pop(el) {
    el.animate([
      { transform: 'scale(1)' },
      { transform: 'scale(1.9)', filter: 'brightness(1.8)' },
      { transform: 'scale(1)' },
    ], { duration: 700, easing: 'cubic-bezier(0.2, 0.9, 0.3, 1.2)' });
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  function pieceEl(piece) {
    const el = document.createElement('span');
    el.className = 'piece ' + ((piece & 8) === WHITE ? 'white' : 'black');
    el.textContent = GLYPHS[piece & 7];
    return el;
  }

  function coordEl(kind, text) {
    const el = document.createElement('span');
    el.className = 'coord ' + kind;
    el.textContent = text;
    return el;
  }

  function statusText() {
    if (editing) return 'Set up a position: pick a piece below, then click the board.';
    if (result) return result;
    if (waiting) return waitingText;
    if (drafting) return `Chaos round ${chaos.round + 1}! Each side picks a modifier.`;
    const who = seat(game.turn), check = game.inCheck();
    if (who === 'computer') return `${gameGm ? gameGm.name : 'Computer'} is thinking`;
    if (who === 'friend') return `${capitalise(sideName(game.turn))} is thinking`;
    if (mode === 'local') {
      const name = sideName(game.turn);
      return check ? `${capitalise(name)} is in check — ${name} to move.` : `${capitalise(name)} to move.`;
    }
    return check ? 'You are in check — your move.' : 'Your move.';
  }

  // Draws a position onto the board and returns its squares, indexed by square number. The live
  // game and the review both draw through here. `movable` is the color whose pieces can be picked up.
  // `frozen` holds squares whose pieces are frozen in a chaos game.
  function drawBoard(position, { flip = false, lastMove = null, selected = -1, targets = new Set(), movable = -1, frozen = new Set() } = {}) {
    const checkedKing = position.inCheck() ? position.kingSq[position.turn] : -1;
    const ordered = [];
    flipped = flip;
    squareEls = [];

    for (let i = 0; i < 64; i++) {
      const sq = flip ? 63 - i : i;
      const row = sq >> 3, col = sq & 7;
      const piece = position.board[sq];
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'square ' + ((row + col) % 2 === 0 ? 'light' : 'dark');
      el.style.setProperty('--i', i);
      if (lastMove && (sq === lastMove.from || sq === lastMove.to)) el.classList.add('last-move');
      if (sq === selected) el.classList.add('selected');
      if (sq === checkedKing) el.classList.add('check');
      if (targets.has(sq)) el.classList.add('target');
      if (piece) el.classList.add('occupied');
      if (piece && (piece & 8) === movable) el.classList.add('mine');
      if (piece && frozen.has(sq)) el.classList.add('frozen');

      let label = squareName(sq);
      if (piece) {
        label += ', ' + ((piece & 8) === WHITE ? 'white ' : 'black ') + PIECE_NAMES[piece & 7];
        el.append(pieceEl(piece));
      }
      el.setAttribute('aria-label', label);

      // Rank numbers down the left edge and file letters along the bottom edge.
      if (i % 8 === 0) el.append(coordEl('rank', 8 - row));
      if (i >= 56) el.append(coordEl('file', 'abcdefgh'[col]));

      // Mouse and touch are handled by the pointer events on the board; this is for the keyboard,
      // whose clicks have a detail of 0.
      el.addEventListener('click', (event) => {
        if (event.detail === 0) onSquareClick(sq);
      });
      ordered.push(el);
      squareEls[sq] = el;
    }

    boardEl.replaceChildren(...ordered);
    return squareEls;
  }

  function render() {
    syncClock();
    mainEl.dataset.mode = mode;
    mainEl.dataset.variant = variant;
    mainEl.dataset.clock = clock ? 'on' : 'off';
    renderGameInfo();
    if (reviewing) return;
    boardEl.classList.toggle('dealing', dealing && !editing);
    if (editing) {
      renderEditor();
    } else {
      drawBoard(game, {
        flip: playerColor === BLACK,
        lastMove,
        selected,
        targets: new Set(legal.filter((m) => m.from === selected).map((m) => m.to)),
        movable: playerCanMove() ? game.turn : -1,
        frozen: new Set(chaos ? chaos.frozen.map((f) => f.sq) : []),
      });
    }
    renderClocks();
    resignEl.disabled = Boolean(result) || waiting || editing;
    undoEl.disabled = !canUndo();
    redoEl.disabled = !canRedo();
    reviewLastEl.disabled = !lastGame.moves || drafting || editing;
    editPositionEl.disabled = editing || drafting;

    const text = statusText();
    if (statusEl.textContent !== text) {
      statusEl.textContent = text;
      statusEl.animate([{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'none' }], { duration: 300 });
    }
    statusEl.classList.toggle('thinking', !result && !waiting && !drafting && !editing && seat(game.turn) !== 'me');

    const [first, second] = columnNames();
    document.getElementById('score-me-label').textContent = first;
    document.getElementById('score-them-label').textContent = second;
    renderRating();
    for (const who of Object.keys(scoreEls)) {
      const el = scoreEls[who], value = String(scores[mode][who]);
      if (el.textContent !== value) {
        // Do not animate the numbers filling in when the page first loads.
        if (game.fullmove > 1 || result) pop(el);
        el.textContent = value;
      }
    }
  }

  // The two clocks, beside the board: the top one for the side at the top.
  function renderClocks() {
    if (!clock || !game) return;
    const top = flipped ? WHITE : BLACK;
    for (const [where, color] of [['top', top], ['bottom', top ^ 8]]) {
      const el = clockEls[where], left = clockLeft(color);
      el.querySelector('.clock-name').textContent = capitalise(sideName(color));
      el.querySelector('.clock-time').textContent = formatTime(left);
      el.classList.toggle('running', clock.running === color);
      el.classList.toggle('low', left < LOW_TIME_MS);
      el.classList.toggle('white-side', color === WHITE);
    }
  }

  // The line under the status: which mode this is and, in chaos, when the next round comes.
  function renderGameInfo() {
    const parts = [];
    const name = setupName(gameSetup);
    if (name) parts.push(name);
    if (chaos && !result) {
      const at = Chaos.ROUNDS[chaos.round], total = Chaos.ROUNDS.length;
      if (drafting) parts.push(`round ${chaos.round + 1} of ${total}`);
      else if (at !== undefined) parts.push(`round ${chaos.round + 1} of ${total} in ${formatTime(Math.max(0, at - usedNow()))} of play`);
      else parts.push('all rounds played');
      for (const color of [WHITE, BLACK]) {
        if (!chaos.rage[color]) continue;
        const who = sideName(color);
        parts.push(`😡 ${capitalise(who)} ${who === 'you' ? 'move' : 'moves'} twice next turn`);
      }
      if (chaos.frozen.length) parts.push('❄️ frozen pieces can’t move');
    }
    const text = parts.join(' · ');
    gameInfoEl.hidden = !text;
    if (gameInfoEl.textContent !== text) gameInfoEl.textContent = text;
  }

  function renderRating() {
    const chosen = sliderRating();
    document.getElementById('rating-value').textContent = chosen;
    // A new rating takes over from the next game, unless this one has not begun.
    const later = opponent === 'custom' && (gameGm || chosen !== gameRating);
    document.getElementById('rating-name').textContent = ratingName(chosen) + (later ? ' · from your next game' : '');
    document.getElementById('my-rating').textContent = myRating;
    // The filled part of the slider track.
    ratingEl.style.setProperty('--fill', ((chosen - MIN_RATING) / (MAX_RATING - MIN_RATING) * 100) + '%');
    renderOpponents();
  }

  // The opponent panel beside the board: a card for our own engine at the slider's rating, and one
  // for each grandmaster.
  function renderOpponents() {
    if (!opponentListEl.children.length) {
      const custom = { id: 'custom', name: 'Custom', initials: '⚙' };
      opponentListEl.append(...[custom, ...Grandmasters.LIST].map((gm) => {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'opponent';
        card.dataset.id = gm.id;
        card.setAttribute('role', 'radio');
        const avatar = document.createElement('span');
        avatar.className = 'opponent-avatar';
        avatar.textContent = gm.initials;
        // A color of its own for each player, spread around the color wheel.
        if (gm.rank) avatar.style.setProperty('--hue', (gm.rank * 137) % 360);
        const name = document.createElement('span');
        name.className = 'opponent-name';
        name.textContent = gm.name;
        const detail = document.createElement('span');
        detail.className = 'opponent-detail';
        if (gm.rank) detail.textContent = `#${gm.rank} · ${gm.country} · ${gm.rating}`;
        card.append(avatar, name, detail);
        card.addEventListener('click', () => chooseOpponent(gm.id));
        return card;
      }));
    }
    for (const card of opponentListEl.children) {
      const chosen = card.dataset.id === opponent;
      card.classList.toggle('chosen', chosen);
      card.setAttribute('aria-checked', String(chosen));
      if (card.dataset.id === 'custom') {
        card.querySelector('.opponent-detail').textContent = `Our engine · ${sliderRating()} (slider below)`;
      }
    }
    opponentNoteEl.textContent = stockfishFailed
      ? 'Stockfish could not be loaded (offline?), so the grandmasters are playing as our own engine at 2400 for now.'
      : `The top 10 of FIDE's ${Grandmasters.LIST_DATE} rating list, played by the Stockfish engine at a strength to match each rating (not their personal style).`;
  }

  // Picking an opponent starts a game against them.
  function chooseOpponent(id) {
    opponent = id;
    stockfishFailed = false;
    save();
    newGame();
  }

  // ---------------------------------------------------------------------------
  // Review of the last finished game. The review itself lives in review.js; this lends it the
  // board and puts the live game back afterwards.
  // ---------------------------------------------------------------------------

  function startReview() {
    if (!lastGame.moves) return;
    reviewing = true;
    turnToken++;
    clearTimeout(gameOverTimer);
    FX.stop();
    drag = null;
    selected = -1;
    promotionEl.hidden = true;
    gameOverEl.hidden = true;
    boardEl.classList.remove('dealing', 'grabbing');
    Review.open(lastGame, {
      draw: drawBoard,
      slide(move) {
        slide(move.from, move.to);
        slideRook(move);
      },
      save(record) {
        if (record === lastGame) store(LAST_GAME_KEY, lastGame);
      },
      close() {
        reviewing = false;
        render();
        if (!result && !drafting && seat(game.turn) === 'computer') computerTurn();
      },
    });
  }

  // ---------------------------------------------------------------------------
  // The position editor, for custom games. It borrows the board: pick a piece from the palette
  // (or the eraser), then click squares.
  // ---------------------------------------------------------------------------

  const paletteEl = document.getElementById('setup-palette');
  const setupTurnEl = document.getElementById('setup-turn');
  const setupErrorEl = document.getElementById('setup-error');
  const setupPlayEl = document.getElementById('setup-play');
  const ERASER = 0;

  paletteEl.append(...[WHITE, BLACK].flatMap((color) => [KING, QUEEN, ROOK, BISHOP, KNIGHT, PAWN].map((type) => color | type))
    .concat(ERASER).map((tool) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'setup-tool';
      button.dataset.tool = tool;
      button.setAttribute('role', 'radio');
      if (tool === ERASER) {
        button.textContent = '✕';
        button.setAttribute('aria-label', 'Eraser');
      } else {
        button.append(pieceEl(tool));
        button.setAttribute('aria-label', ((tool & 8) === WHITE ? 'White ' : 'Black ') + PIECE_NAMES[tool & 7]);
      }
      button.addEventListener('click', () => {
        edit.tool = tool;
        renderEditor();
      });
      return button;
    }));

  function openEditor() {
    if (reviewing || drafting) return;
    const start = new Game(customFen);
    turnToken++;   // the computer stops thinking (it carries on if the editor is cancelled)
    editing = true;
    edit = { board: start.board.slice(), turn: start.turn, tool: edit ? edit.tool : (WHITE | QUEEN) };
    drag = null;
    selected = -1;
    promotionEl.hidden = true;
    gameOverEl.hidden = true;
    setupErrorEl.textContent = '';
    setupPlayEl.textContent = mode === 'online' ? 'Use in my next game' : 'Play this position';
    mainEl.classList.add('editing');
    setupEl.hidden = false;
    render();
  }

  function closeEditor() {
    if (!editing) return;
    editing = false;
    mainEl.classList.remove('editing');
    setupEl.hidden = true;
  }

  function renderEditor() {
    drawBoard({ board: edit.board, inCheck: () => false }, { flip: mode !== 'local' && sideEl.value === 'black' });
    for (const button of paletteEl.children) {
      const chosen = Number(button.dataset.tool) === edit.tool;
      button.classList.toggle('chosen', chosen);
      button.setAttribute('aria-checked', String(chosen));
    }
    setupTurnEl.value = edit.turn === WHITE ? 'w' : 'b';
  }

  function editSquare(sq) {
    const { tool, board } = edit;
    if (tool === ERASER || board[sq] === tool) {
      board[sq] = 0;
    } else {
      // There is only one king of each color: placing it moves it.
      if ((tool & 7) === KING) for (let s = 0; s < 64; s++) if (board[s] === tool) board[s] = 0;
      board[sq] = tool;
    }
    setupErrorEl.textContent = '';
    renderEditor();
  }

  // The position being edited, as a game: castling is allowed wherever a king and rook are still
  // on their starting squares.
  function editedGame() {
    const g = new Game();
    g.board = edit.board.slice();
    g.turn = edit.turn;
    g.ep = -1;
    g.halfmove = 0;
    g.fullmove = 1;
    g.castling = 0;
    for (const [bit, king, rook, color] of [[1, 60, 63, WHITE], [2, 60, 56, WHITE], [4, 4, 7, BLACK], [8, 4, 0, BLACK]]) {
      if (g.board[king] === (color | KING) && g.board[rook] === (color | ROOK)) g.castling |= bit;
    }
    return g;
  }

  setupTurnEl.addEventListener('change', () => {
    edit.turn = setupTurnEl.value === 'b' ? BLACK : WHITE;
    setupErrorEl.textContent = '';
  });
  document.getElementById('setup-standard').addEventListener('click', () => {
    edit.board = new Game().board.slice();
    edit.turn = WHITE;
    setupErrorEl.textContent = '';
    renderEditor();
  });
  document.getElementById('setup-clear').addEventListener('click', () => {
    edit.board = new Array(64).fill(0);
    setupErrorEl.textContent = '';
    renderEditor();
  });
  setupPlayEl.addEventListener('click', () => {
    const { game: g, error } = checkPosition(editedGame());
    if (error) {
      setupErrorEl.textContent = error;
      return;
    }
    customFen = g.fen();
    save();
    closeEditor();
    if (mode === 'online') render();
    else newGame();
  });
  document.getElementById('setup-cancel').addEventListener('click', () => {
    closeEditor();
    render();
    if (!result && !drafting && seat(game.turn) === 'computer') computerTurn();
  });

  // ---------------------------------------------------------------------------
  // Online games. The connection lives in online.js; these are its ways into the game.
  // ---------------------------------------------------------------------------

  const onlineHooks = {
    wait(text) {
      waiting = true;
      waitingText = text;
      selected = -1;
      promotionEl.hidden = true;
      render();
    },
    begin(color, state) {
      waiting = false;
      newGame(color, state);
    },
    resume() {
      waiting = false;
      render();
    },
    move(message) {
      // Ignore anything that is not the friend's next move in this very game.
      if (waiting || result || drafting || seat(game.turn) !== 'friend' || message.ply !== history.length) return;
      const move = legal.find((m) => sameMove(m, message));
      if (move) playMove(move, undefined, false, message.clock);
    },
    chaosPick(message) {
      const color = playerColor ^ 8, { round, pick } = message;
      if (!chaos || result || typeof pick !== 'string' || !Number.isInteger(round)) return;
      if (draft && draft.round === round) {
        if (draft.picks[color] || !draft.offers[color].includes(pick)) return;
        draft.picks[color] = pick;
        if (draft.picks[playerColor]) nextPick();
      } else if (round >= chaos.round) {
        friendPicks[round] = pick;
      }
    },
    timeout() {
      // The friend's own page says their time ran out.
      if (result || !clock) return;
      const color = playerColor ^ 8;
      stopClock();
      clock.left[color] = 0;
      finish(...timeoutResult(color));
      render();
    },
    resign() {
      if (result || waiting) return;
      finish(playerColor, resignText(playerColor ^ 8));
      render();
    },
    draw() {
      if (result || waiting) return;
      finish(null, 'Draw agreed.');
      render();
    },
    snapshot() {
      return { state: gameState(), finished: Boolean(result) };
    },
    // The rules for the next game this player hosts.
    setup() {
      return chosenSetup();
    },
    // What kind of game is on, for the online panel ('' for a classic one).
    describe() {
      return setupName(gameSetup);
    },
    preferredColor() {
      return sideEl.value === 'black' ? BLACK : WHITE;
    },
    myName() {
      return names.me;
    },
    friendName(name) {
      friendName = cleanName(name);
      render();
    },
  };

  function setMode(value) {
    if (mode === 'online') Online.close();
    mode = value;
    friendName = '';
    waiting = false;
    save();
    newGame();
    if (mode === 'online') Online.open(onlineHooks);
  }

  // ---------------------------------------------------------------------------
  // Controls
  // ---------------------------------------------------------------------------

  document.getElementById('new-game').addEventListener('click', () => newGame());
  editPositionEl.addEventListener('click', openEditor);
  undoEl.addEventListener('click', undo);
  redoEl.addEventListener('click', redo);
  playAgainEl.addEventListener('click', () => {
    if (mode !== 'online') return newGame();
    gameOverEl.hidden = true;
    Online.rematch();
  });
  document.getElementById('view-board').addEventListener('click', () => {
    gameOverEl.hidden = true;
  });
  document.getElementById('review-game').addEventListener('click', startReview);
  reviewLastEl.addEventListener('click', startReview);

  resignEl.addEventListener('click', () => {
    if (result || waiting || editing) return;
    promotionEl.hidden = true;
    selected = -1;
    // On a shared screen it is the side to move that gives up.
    const loser = mode === 'local' ? game.turn : playerColor;
    if (mode === 'online') Online.resign();
    finish(loser ^ 8, resignText(loser));
    render();
  });

  document.getElementById('reset-score').addEventListener('click', () => {
    scores[mode] = blankScore();
    save();
    render();
  });

  ratingEl.addEventListener('input', () => {
    // Before the first move it can still change who you are playing.
    opponent = 'custom';
    if (mode === 'computer' && !history.length && !result) {
      gameGm = null;
      gameRating = sliderRating();
    }
    save();
    render();
  });

  for (const [key, el] of Object.entries(nameEls)) {
    el.addEventListener('input', () => {
      names[key] = cleanName(el.value);
      save();
      render();
    });
    el.addEventListener('change', () => {
      el.value = names[key];
      if (key === 'me' && mode === 'online') Online.sendName(names.me);
    });
  }

  // Switching sides starts a fresh game, except online, where it is the side the next game you
  // create starts you on.
  sideEl.addEventListener('change', () => {
    save();
    if (mode !== 'online') newGame();
  });
  modeEl.addEventListener('change', () => setMode(modeEl.value));

  // The time controls of the chosen mode, if it has any.
  function fillTimes() {
    const times = VARIANTS[variant].times || [];
    timeEl.replaceChildren(...times.map(([minutes, increment], index) => {
      const option = document.createElement('option');
      option.value = index;
      option.textContent = timeName({ base: minutes * 60000, inc: increment * 1000 });
      return option;
    }));
    if (times.length) timeEl.value = timeChoice[variant];
  }

  // A new mode starts a fresh game, except online, where it is the kind of game you host next.
  // Choosing a custom position opens the editor.
  variantEl.addEventListener('change', () => {
    variant = variantEl.value;
    fillTimes();
    save();
    if (mode !== 'online') newGame();
    else render();
    if (variant === 'custom') openEditor();
  });
  timeEl.addEventListener('change', () => {
    timeChoice[variant] = Number(timeEl.value);
    save();
    if (mode !== 'online') newGame();
  });

  fillTimes();
  newGame();
  if (mode === 'online') {
    Online.open(onlineHooks);
    if (joinCode) Online.join(joinCode);
  }
})();
