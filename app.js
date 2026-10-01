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
  const TURN_BOARD_MS = 900;         // on a shared screen, how long after a move the board turns round

  const boardEl = document.getElementById('board');
  const boardWrapEl = document.getElementById('board-wrap');
  const statusEl = document.getElementById('status');
  const promotionEl = document.getElementById('promotion');
  const promotionChoicesEl = document.getElementById('promotion-choices');
  const gameOverEl = document.getElementById('game-over');
  const mainEl = document.querySelector('main');
  const resignEl = document.getElementById('resign');
  const undoEl = document.getElementById('undo');
  const redoEl = document.getElementById('redo');
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
  // (Before the slider there were three difficulties.)
  const OLD_LEVELS = { easy: 600, medium: 1200, hard: 2000 };
  let rating = clampRating(saved.rating ?? OLD_LEVELS[saved.difficulty] ?? START_RATING);   // our engine's, when you play it
  // Who you play in computer mode: 'custom' (our engine, at the slider's rating) or a grandmaster's
  // id. (A saved rating of 2850 was the slider's old Magnus stop.)
  let opponent = Grandmasters.find(saved.opponent) ? saved.opponent : saved.rating >= 2800 ? 'carlsen' : 'custom';
  let side = ['white', 'black', 'random'].includes(saved.side) ? saved.side : 'white';   // the side you play
  const names = { me: '', white: '', black: '', ...saved.names };
  for (const key of Object.keys(names)) names[key] = cleanName(names[key]);
  let myRating = Number.isFinite(saved.myRating) ? saved.myRating : START_RATING;
  let variant = VARIANTS[saved.variant] ? saved.variant : 'classic';
  // The chosen time control of each timed mode, as an index into its list.
  const timeChoice = { blitz: 0, rapid: 0, long: 0 };
  for (const key of Object.keys(timeChoice)) {
    const index = saved.times && saved.times[key];
    if (Number.isInteger(index) && VARIANTS[key].times[index]) timeChoice[key] = index;
  }
  let customFen = typeof saved.customFen === 'string' && !checkPosition(saved.customFen).error ? saved.customFen : START_FEN;

  // The game being played is against 'computer', 'local' (two players on this screen) or 'online'.
  // An online game needs connecting first, so the page never opens on one (except from a link).
  let mode = joinCode ? 'online' : MODES.includes(saved.mode) && saved.mode !== 'online' ? saved.mode : 'computer';
  let game, playerColor, legal, selected, lastMove, positions, history, result;
  let facing = WHITE;       // on a shared screen, the side the board is turned towards
  let lastFx = 0;           // what chaos powerups did along with the last move (see Game.lastFx)
  let powerTime = 0;        // clock time a chaos powerup gave for the last move
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
  let chaos = null;         // in a chaos game: { round }, the number of the next draft
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
      scores, mode, opponent, rating, myRating, names, side,
      variant, times: timeChoice, customFen,
    });
  }

  function clampRating(value) {
    return Math.min(MAX_RATING, Math.max(MIN_RATING, Math.round(Number(value) / 100) * 100 || START_RATING));
  }

  function sliderRating() {
    return rating;
  }

  // The color you play next, from your choice of side.
  function chosenColor() {
    if (side === 'random') return Math.random() < 0.5 ? WHITE : BLACK;
    return side === 'black' ? BLACK : WHITE;
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

  // Stockfish knows nothing of chaos powerups, so in a chaos game grandmasters are played by our
  // own engine at full strength.
  function think() {
    if (gameGm && !stockfishFailed && !chaos) return thinkLikeGrandmaster();
    return thinkOurselves(Math.min(gameRating, MAX_RATING));
  }

  // The computer hurries when it is short of time.
  function thinkOptions() {
    return { maxMs: clock ? Math.max(100, clockLeft(game.turn) / 30) : Infinity };
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
    const position = { fen: gameSetup.fen === START_FEN ? null : gameSetup.fen, moves: history.map(moveToUci) };
    if (clock) position.movetime = clockLeft(game.turn) / 30;
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
    // A reply that was taken back with Undo comes back as it was, instead of being thought out again
    // (unless it no longer fits, after a chaos round that went differently the second time).
    const next = redoStack.length ? legal.find((m) => sameMove(m, redoStack[redoStack.length - 1])) : null;
    if (!next) redoStack = [];
    const redoing = Boolean(next);
    // Wait at least long enough for the player's move (or the opening deal) to finish animating;
    // less long when the clock is ticking.
    const wait = redoing ? 450 : !lastMove ? 1300 : clock ? 400 : 700;
    const pause = new Promise((resolve) => setTimeout(resolve, wait));
    Promise.all([redoing ? null : think(), pause]).then(([move]) => {
      if (token !== turnToken || result || drafting) return;
      if (redoing) {
        redoStack.pop();
        playMove(next, undefined, true);
      } else if (move) {
        playMove(move);
      }
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
    facing = game.turn;
    playerColor = mode === 'local' ? WHITE : color ?? chosenColor();
    gameGm = mode === 'computer' ? Grandmasters.find(opponent) : null;
    gameRating = gameGm ? gameGm.rating : sliderRating();
    selected = -1;
    lastMove = null;
    result = null;
    history = [];
    timeline = [];
    redoStack = [];
    positions = new Map([[game.key(), 1]]);
    chaos = gameSetup.variant === 'chaos' ? { round: 0 } : null;
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
      if (entry.clock) timeline[timeline.length - 1].clock = entry.clock;
    }
    legal = computeLegal();
    return true;
  }

  function validPicks(round, picks) {
    const offered = Chaos.offers(gameSetup.seed, round, game);
    return Boolean(picks) && [WHITE, BLACK].every((color) =>
      offered[color].length ? offered[color].includes(picks[color]) : picks[color] === Chaos.NONE);
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
    // Kept so the game can be reviewed afterwards, even after the page is reloaded. For a chaos game
    // that includes the powerups each side picked, and how many moves into the game.
    if (history.length) {
      lastGame = {
        moves: history.map(({ from, to, promo }) => ({ from, to, promo })),
        fen: gameSetup.fen === START_FEN ? undefined : gameSetup.fen,
        powerups: chaos ? chaosPicks() : undefined,
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
    // Let the final move (and any explosion) play out before announcing the result.
    gameOverTimer = setTimeout(() => {
      document.getElementById('game-over-title').textContent = title;
      document.getElementById('game-over-text').textContent = message;
      const ratingLine = document.getElementById('game-over-rating');
      ratingLine.textContent = ratingText;
      ratingLine.hidden = !ratingText;
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

  // The chaos rounds played so far: [{ ply, picks }], ply being the number of moves made before it.
  function chaosPicks() {
    let ply = 0;
    const rounds = [];
    for (const entry of timeline) {
      if (entry.type === 'chaos') rounds.push({ ply, picks: entry.picks });
      else ply++;
    }
    return rounds;
  }

  // Makes a move on the board without any of the presentation; returns the new position's key.
  // What chaos powerups did along with it is left in lastFx.
  function record(move) {
    game.make(move);
    lastFx = game.lastFx;
    history.push(move);
    lastMove = move;
    const key = game.key();
    positions.set(key, (positions.get(key) || 0) + 1);
    return key;
  }

  // Plays a move without any of the presentation, and notes it in the timeline. Returns the new
  // position's key.
  function advance(move) {
    const key = record(move);
    timeline.push({ type: 'move', from: move.from, to: move.to, promo: move.promo || 0 });
    return key;
  }

  // The moves the side to move may make (the engine knows the chaos powerups).
  function computeLegal() {
    return game.legalMoves();
  }

  // `drop` is set when the player dragged the piece onto its square, so it should not slide there
  // again; it holds how far the piece was swinging when it was let go. `redoing` is set when the
  // move is one that was taken back with Undo; any other move forgets the moves that could be redone.
  // `reportedClock` is an online friend's time after their move, as their page counted it.
  function playMove(move, drop, redoing = false, reportedClock = null) {
    const mover = game.turn;
    dealing = false;
    if (!redoing) redoStack = [];
    clockMoved(mover, reportedClock, move);
    const key = advance(move);
    // Undo puts the clocks back the way they stood after this move.
    if (clock) {
      timeline[timeline.length - 1].clock = {
        left: { ...clock.left }, mark: { ...clock.mark }, used: clock.used, started: clock.started,
      };
    }
    selected = -1;
    legal = computeLegal();
    if (mode === 'online' && seat(mover) === 'me') Online.sendMove(move, history.length - 1, clock ? clock.left[mover] : null);
    checkGameOver(key);
    const drafts = maybeStartDraft(DRAFT_DELAY_MS);
    render();
    // An online friend's move can arrive during a review, or while the editor has the board.
    if (!reviewing && !editing) {
      animateMove(move, mover, drop);
      animatePowers(move, mover, drop);
    }
    if (mode === 'local' && !result) turnBoard();
    if (!result && !drafts && seat(game.turn) === 'computer') computerTurn();
  }

  // On a shared screen, once a move has played out, the board spins round to face the side to move.
  function turnBoard() {
    const id = gameId, ply = history.length;
    setTimeout(() => {
      if (id !== gameId || ply !== history.length || mode !== 'local' || result || facing === game.turn) return;
      facing = game.turn;
      render();
      if (!reviewing && !editing && !menuOpen) {
        boardEl.animate([
          { transform: 'rotate(180deg) scale(0.85)', opacity: 0.3 },
          { transform: 'rotate(0deg) scale(1)', opacity: 1 },
        ], { duration: 500, easing: 'cubic-bezier(0.3, 0.7, 0.3, 1)' });
      }
    }, TURN_BOARD_MS);
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
    const paused = !clock.started || result || drafting || waiting || (mode !== 'online' && (reviewing || editing || menuOpen));
    const wanted = paused ? null : game.turn;
    if (clock.running === wanted) return;
    stopClock();
    if (wanted !== null) {
      clock.running = wanted;
      clock.since = performance.now();
    }
  }

  // The clocks after `mover` moves: its clock stops (at the time its own page reports, for an online
  // friend) and gains the increment, plus any chaos powerup's bonus. The game's first move is free:
  // the clocks start after it.
  function clockMoved(mover, reported, move) {
    if (!clock) return;
    stopClock();
    powerTime = chaos && clock.started ? Chaos.timeBonus(game, move.piece) : 0;
    const bonus = clock.started ? clock.inc + powerTime : 0;
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
  // Chaos rounds. At the start, and then every 45 seconds of play (both players' clock time
  // together), the clocks stop and each player picks one of three powerups. A powerup belongs to a
  // kind of piece and lasts all game, unless a later pick for the same kind swaps it out.
  // ---------------------------------------------------------------------------

  // (Never while an online game is waiting for the friend.)
  function chaosDue() {
    return Boolean(chaos) && !result && !waiting && chaos.round < Chaos.ROUNDS && clock.used >= chaos.round * Chaos.ROUND_MS;
  }

  // Starts the next chaos round after `delay` if it is due, and returns whether it is. `known` holds
  // picks already made (in a round a rejoining online friend arrives in the middle of).
  function maybeStartDraft(delay, known) {
    if (!chaosDue()) return false;
    drafting = true;
    const id = gameId;
    setTimeout(() => {
      if (id === gameId && !result && !draft && !waiting) startDraft(known);
    }, delay);
    return true;
  }

  function startDraft(known) {
    const round = chaos.round, seed = gameSetup.seed;
    draft = {
      round,
      offers: Chaos.offers(seed, round, game),
      picks: {},
    };
    drafting = true;
    for (const color of [WHITE, BLACK]) {
      const pick = (known && known[color]) || (seat(color) === 'friend' ? friendPicks[round] : null);
      if (pick && draft.offers[color].includes(pick)) draft.picks[color] = pick;
      // A side with nothing it could be offered sits this draft out.
      if (!draft.offers[color].length) draft.picks[color] = Chaos.NONE;
      else if (seat(color) === 'computer') draft.picks[color] = computerPick(color);
    }
    render();
    nextPick();
  }

  function computerPick(color) {
    return Chaos.choose(game, {
      offered: draft.offers[color], color,
      // Weaker computers judge the powerups more loosely.
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

  // The three powerup cards for `color` to choose from.
  function showOffers(color) {
    const title = mode === 'local' ? `${capitalise(sideName(color))}, pick a powerup` : 'Pick a powerup';
    const choices = draft.offers[color].map((id) => {
      const powerup = Chaos.find(id);
      const held = Chaos.find(game.power[color | powerup.type]);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'draft-choice rarity-' + powerup.rarity.id;
      const icon = document.createElement('span');
      icon.className = 'draft-icon';
      icon.textContent = powerup.icon;
      const name = document.createElement('strong');
      name.textContent = powerup.name + ' ';
      const pieces = document.createElement('span');
      pieces.className = 'draft-pieces';
      pieces.textContent = powerup.pieces;
      const rarity = document.createElement('span');
      rarity.className = 'draft-rarity';
      rarity.textContent = powerup.rarity.name;
      name.append(pieces, rarity);
      const text = document.createElement('span');
      text.className = 'draft-text';
      text.textContent = powerup.text + (held ? ` Replaces your ${held.icon} ${held.name}.` : '');
      button.append(icon, name, text);
      button.addEventListener('click', () => pickModifier(color, id));
      return button;
    });
    showDraftCard(title, choices);
    const rarities = draft.offers[color].map((id) => Chaos.find(id).rarity.name);
    document.getElementById('draft-round').textContent += rarities[0] === rarities[1]
      ? ` · both sides get two ${rarities[0]}s` : ` · both sides get ${rarities.map((r) => (/^[AEIOU]/.test(r) ? 'an ' : 'a ') + r).join(' and ')}`;
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
    document.getElementById('draft-round').textContent = `Chaos draft ${draft.round + 1} of ${Chaos.ROUNDS}`;
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

  // Hands out both picks of a round, white's first, and returns what happened.
  function playChaosRound(round, picks) {
    const outcomes = [WHITE, BLACK].map((color) => Chaos.apply(game, color, picks[color]));
    chaos.round = round + 1;
    timeline.push({ type: 'chaos', round, picks: { [WHITE]: picks[WHITE], [BLACK]: picks[BLACK] } });
    selected = -1;
    return outcomes;
  }

  // Says what each side picked, over the board, and powers up the pieces it went to.
  function showChaos(outcomes) {
    for (const { color, powerup, replaced } of outcomes) {
      if (!powerup) continue;
      const item = document.createElement('li');
      const who = capitalise(sideName(color));
      const whose = sideName(color) === 'you' ? 'your' : mode === 'local' ? `${sideName(color)}’s` : 'their';
      item.textContent = `${powerup.icon} ${who} — ${powerup.name} for ${whose} ${powerup.pieces.toLowerCase()}` +
        (replaced ? `, swapping out ${replaced.icon} ${replaced.name}.` : '.');
      chaosLogEl.append(item);
      setTimeout(() => item.remove(), 7000);
      if (reviewing || editing) continue;
      // Every piece that gets the powerup glows, and its badge pops in.
      for (let sq = 0; sq < 64; sq++) {
        if (game.board[sq] !== (color | powerup.type)) continue;
        const square = squareEls[sq];
        square.classList.add('powering');
        setTimeout(() => square.classList.remove('powering'), 1200);
        const badge = square.querySelector('.power-badge');
        if (badge) badge.animate({ scale: [0, 2.2, 1], rotate: ['-180deg', '20deg', '0deg'] }, { duration: 700, easing: 'ease-out' });
        const piece = square.querySelector('.piece');
        if (piece) piece.animate({ scale: [1, 1.35, 1], filter: ['none', 'brightness(2.2) drop-shadow(0 0 10px gold)', 'none'] }, { duration: 800, easing: 'ease-out' });
      }
    }
    while (chaosLogEl.children.length > 4) chaosLogEl.firstElementChild.remove();
  }

  // ---------------------------------------------------------------------------
  // Undo and redo, against the computer and on a shared screen, in untimed games and chaos ones.
  // Against the computer, Undo takes back your last move along with the computer's reply to it (or
  // stops the computer thinking about one), so it is your move again. In a chaos game it also takes
  // back any powerup draft that came after those moves, and the clocks go back with them.
  // ---------------------------------------------------------------------------

  function colorOfPly(ply) {
    return ply % 2 ? startTurn ^ 8 : startTurn;
  }

  function undoAllowed() {
    return mode !== 'online' && (!clock || Boolean(chaos)) && !reviewing && !editing && !result && !drafting && !menuOpen;
  }

  function canUndo() {
    return undoAllowed() && history.some((_, ply) => seat(colorOfPly(ply)) === 'me');
  }

  // (A move can only be redone while it is still legal: a chaos round may have gone differently.)
  function canRedo() {
    return undoAllowed() && redoStack.length > 0 && seat(game.turn) === 'me' &&
      legal.some((m) => sameMove(m, redoStack[redoStack.length - 1]));
  }

  // Sets the game up afresh with `entries` of its timeline played (moves and chaos rounds), and puts
  // the clocks back the way they stood after the last of those moves.
  function rebuild(entries) {
    game = new Game(gameSetup.fen);
    history = [];
    timeline = [];
    lastMove = null;
    positions = new Map([[game.key(), 1]]);
    if (chaos) chaos.round = 0;
    legal = computeLegal();
    for (const entry of entries) if (!replayEntry(entry)) break;
    if (clock) {
      stopClock();
      const after = [...timeline].reverse().find((e) => e.type === 'move' && e.clock);
      const base = clock.base;
      const state = after ? after.clock
        : { left: { [WHITE]: base, [BLACK]: base }, mark: { [WHITE]: base, [BLACK]: base }, used: 0, started: false };
      clock.left = { ...state.left };
      clock.mark = { ...state.mark };
      clock.used = state.used;
      clock.started = state.started;
    }
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
    // Everything from the first move taken back onwards goes, chaos rounds included.
    let moves = 0;
    const cut = timeline.findIndex((entry) => entry.type === 'move' && moves++ === history.length);
    rebuild(timeline.slice(0, cut));
    facing = game.turn;
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
    const next = redoStack.pop();
    const move = legal.find((m) => sameMove(m, next));
    playMove(move, undefined, true);
  }

  // (On a shared screen, not until the board has turned to face the side to move.)
  function playerCanMove() {
    return !reviewing && !editing && !waiting && !drafting && !result && seat(game.turn) === 'me' && promotionEl.hidden &&
      (mode !== 'local' || facing === game.turn);
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
      // (Unless a Giant Skeleton's bomb has taken it.)
      const piece = squareEls[move.to].querySelector('.piece');
      if (piece) {
        piece.animate({ scale: [1.25, 1] }, { duration: 180, easing: 'ease-out' });
        settle(piece, drop.angle);
      }
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

  // ---------------------------------------------------------------------------
  // Chaos powerups at work
  // ---------------------------------------------------------------------------

  // Whether a move is one the piece could only make thanks to its powerup.
  function usesPower(move) {
    const type = move.piece & 7, fromRow = move.from >> 3;
    const dr = (move.to >> 3) - fromRow, dc = (move.to & 7) - (move.from & 7);
    const ar = Math.abs(dr), ac = Math.abs(dc);
    const knightJump = (ar === 1 && ac === 2) || (ar === 2 && ac === 1);
    // Anything standing between the two squares (for pieces that fly or fire over it).
    const overSomething = () => {
      if (ar !== ac && ar && ac) return false;
      const steps = Math.max(ar, ac), sr = Math.sign(dr), sc = Math.sign(dc);
      for (let i = 1; i < steps; i++) if (game.board[move.from + i * (sr * 8 + sc)]) return true;
      return false;
    };
    switch (type) {
      case PAWN: {
        const startRow = (move.piece & 8) === WHITE ? 6 : 1;
        if (dc === 0) return Boolean(move.captured) || (ar === 2 && fromRow !== startRow);
        return ar !== 1;
      }
      case KNIGHT: return !knightJump;
      case BISHOP: return ar !== ac || overSomething();
      case ROOK: return (ar !== 0 && ac !== 0) || overSomething();
      case QUEEN: return knightJump;
      case KING: return !(move.flags & F_CASTLE) && (ar > 1 || ac > 1);
      default: return false;
    }
  }

  // An icon that rises and fades over a square.
  function iconPop(sq, icon, big = false) {
    const square = squareEls[sq];
    if (!square) return;
    const box = square.getBoundingClientRect(), wrap = boardWrapEl.getBoundingClientRect();
    const el = document.createElement('span');
    el.className = 'power-pop' + (big ? ' big' : '');
    el.textContent = icon;
    el.style.left = box.left - wrap.left + box.width / 2 + 'px';
    el.style.top = box.top - wrap.top + box.height / 2 + 'px';
    boardWrapEl.append(el);
    setTimeout(() => el.remove(), 1100);
  }

  // Shows what a move's powerups did: a leap in an arc for a powered move, and the blasts, zaps and
  // summons that go off on a capture.
  function animatePowers(move, mover, drop) {
    if (!chaos) return;
    const powerup = Chaos.find(game.power[move.piece]);
    const size = boardEl.clientWidth / 8, facing = flipped ? -1 : 1;
    const offset = (from, to) => [((from & 7) - (to & 7)) * size * facing, ((from >> 3) - (to >> 3)) * size * facing];

    if (powerup && usesPower(move)) {
      const piece = squareEls[move.to].querySelector('.piece:not(.ghost)');
      if (piece && !drop) {
        // Leap high over whatever is in the way.
        const [dx, dy] = offset(move.from, move.to);
        piece.animate([
          { translate: `${dx}px ${dy}px`, scale: 1 },
          { translate: `${dx / 2}px ${dy / 2 - size * 0.9}px`, scale: 1.6, offset: 0.5 },
          { translate: '0px 0px', scale: 1 },
        ], { duration: 520, easing: 'ease-in-out' });
        squareEls[move.to].classList.add('moving');
        setTimeout(() => squareEls[move.to] && squareEls[move.to].classList.remove('moving'), 540);
      }
      iconPop(move.to, powerup.icon);
    }

    const fx = lastFx;
    if (fx) {
      const skeleton = (move.captured & 7) === PAWN && game.power[move.captured] === 'giantskeleton' && fx[0] === move.to;
      if (skeleton) {
        // The attacker arrives, and the pawn's bomb takes it with it.
        const ghost = pieceEl(fx[1]);
        ghost.classList.add('ghost');
        squareEls[move.to].append(ghost);
        if (!drop) {
          const [dx, dy] = offset(move.from, move.to);
          ghost.animate({ translate: [`${dx}px ${dy}px`, '0px 0px'] }, { duration: MOVE_MS, easing: 'cubic-bezier(0.25, 0.8, 0.3, 1)' });
        }
        setTimeout(() => {
          ghost.remove();
          blowUp(move.to, fx[1]);
          iconPop(move.to, '💣', true);
        }, MOVE_MS + 250);
      } else if (fx[1] === 0) {
        // A Witch leaves a skeleton pawn behind.
        const pawn = squareEls[fx[0]].querySelector('.piece');
        if (pawn) pawn.animate({ scale: [0, 1.5, 1], opacity: [0, 1, 1], filter: ['brightness(3)', 'none'] }, { duration: 600, easing: 'ease-out' });
        iconPop(fx[0], '🧹');
      } else {
        // A Valkyrie's spin or an Electro Wizard's zap takes out the pawns around.
        const icon = powerup ? powerup.icon : '💥';
        const attacker = squareEls[move.to].querySelector('.piece:not(.ghost)');
        if (attacker) {
          const keyframes = powerup && powerup.id === 'valkyrie'
            ? { rotate: ['0deg', '720deg'] }
            : { filter: ['none', 'brightness(3) drop-shadow(0 0 12px #67e8f9)', 'none', 'brightness(3) drop-shadow(0 0 12px #67e8f9)', 'none'] };
          setTimeout(() => attacker.animate(keyframes, { duration: 600, easing: 'ease-out' }), MOVE_MS);
        }
        for (let i = 0; i < fx.length; i += 2) {
          const sq = fx[i];
          setTimeout(() => {
            blowUp(sq, fx[i + 1]);
            iconPop(sq, icon);
          }, MOVE_MS + 150 + i * 40);
        }
      }
    }

    if (powerTime) clockBonus(mover, powerTime);
  }

  // "+3s" rising from a clock that a powerup just topped up.
  function clockBonus(color, ms) {
    const el = clockEls[(flipped ? WHITE : BLACK) === color ? 'top' : 'bottom'];
    const bonus = document.createElement('span');
    bonus.className = 'clock-bonus';
    bonus.textContent = `+${Math.round(ms / 1000)}s`;
    el.append(bonus);
    setTimeout(() => bonus.remove(), 1300);
    el.animate({ boxShadow: ['0 0 0 rgba(52, 211, 153, 0)', '0 0 24px rgba(52, 211, 153, 0.9)', '0 0 0 rgba(52, 211, 153, 0)'] }, { duration: 900 });
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
    if (drafting) return `Chaos draft ${chaos.round + 1}! Each side picks a powerup.`;
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
  // Pieces with a chaos powerup (`powers`, as the engine keeps them) wear its badge.
  function drawBoard(position, { flip = false, lastMove = null, selected = -1, targets = new Set(), movable = -1, powers = position.power } = {}) {
    const checkedKing = position.inCheck() ? position.kingSq[position.turn] : -1;
    const ordered = [];
    tipEl.hidden = true;
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

      let label = squareName(sq);
      if (piece) {
        label += ', ' + ((piece & 8) === WHITE ? 'white ' : 'black ') + PIECE_NAMES[piece & 7];
        el.append(pieceEl(piece));
        const powerup = powers && Chaos.find(powers[piece]);
        if (powerup) {
          label += ' with ' + powerup.name;
          const badge = document.createElement('span');
          badge.className = `power-badge ${(piece & 8) === WHITE ? 'white' : 'black'} rarity-${powerup.rarity.id}`;
          badge.textContent = powerup.icon;
          badge.dataset.tip = powerTip(powerup);
          el.append(badge);
        }
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
    mainEl.dataset.clock = clock ? 'on' : 'off';
    renderGameInfo();
    if (reviewing) return;
    boardEl.classList.toggle('dealing', dealing && !editing);
    if (editing) {
      renderEditor();
    } else {
      drawBoard(game, {
        flip: (mode === 'local' ? facing : playerColor) === BLACK,
        lastMove,
        selected,
        targets: new Set(legal.filter((m) => m.from === selected).map((m) => m.to)),
        movable: playerCanMove() ? game.turn : -1,
        powers: chaos ? game.power : null,
      });
    }
    renderClocks();
    // Only the actions that make sense in this kind of game.
    const offline = mode !== 'online';
    undoEl.hidden = redoEl.hidden = !(offline && (!clock || chaos));
    editPositionEl.hidden = !(offline && gameSetup.variant === 'custom');
    document.getElementById('new-game').hidden = !offline;
    resignEl.disabled = Boolean(result) || waiting || editing;
    undoEl.disabled = !canUndo();
    redoEl.disabled = !canRedo();
    editPositionEl.disabled = editing || drafting;
    menuButtonEl.disabled = drafting;

    const text = statusText();
    if (statusEl.textContent !== text) {
      statusEl.textContent = text;
      statusEl.animate([{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'none' }], { duration: 300 });
    }
    statusEl.classList.toggle('thinking', !result && !waiting && !drafting && !editing && seat(game.turn) !== 'me');

    const [first, second] = columnNames();
    document.getElementById('score-me-label').textContent = first;
    document.getElementById('score-them-label').textContent = second;
    for (const who of Object.keys(scoreEls)) {
      const el = scoreEls[who], value = String(scores[mode][who]);
      if (el.textContent !== value) {
        // Do not animate the numbers filling in when the page first loads.
        if (game.fullmove > 1 || result) pop(el);
        el.textContent = value;
      }
    }
  }

  // What a powerup does, for its tooltip.
  function powerTip(powerup) {
    return `${powerup.icon} ${powerup.name} · ${powerup.rarity.name} · ${powerup.pieces}\n${powerup.text}`;
  }

  // A tooltip for anything with a data-tip (the powerup emoji): on hover with a mouse, on a tap with
  // a finger.
  const tipEl = document.createElement('div');
  tipEl.className = 'tip';
  tipEl.setAttribute('role', 'tooltip');
  tipEl.hidden = true;
  document.body.append(tipEl);

  document.addEventListener('pointerover', (event) => {
    const target = event.target.closest && event.target.closest('[data-tip]');
    if (!target || (drag && drag.lifted)) {
      tipEl.hidden = true;
      return;
    }
    tipEl.textContent = target.dataset.tip;
    tipEl.hidden = false;
    const box = target.getBoundingClientRect(), tip = tipEl.getBoundingClientRect();
    const left = Math.min(Math.max(8, box.left + box.width / 2 - tip.width / 2), innerWidth - tip.width - 8);
    const above = box.top - tip.height - 8;
    tipEl.style.left = left + 'px';
    tipEl.style.top = (above >= 8 ? above : box.bottom + 8) + 'px';
  });
  addEventListener('scroll', () => { tipEl.hidden = true; }, true);

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
      // In a chaos game, the powerups that side holds.
      let held = el.querySelector('.clock-powers');
      if (!held) {
        held = document.createElement('span');
        held.className = 'clock-powers';
        el.querySelector('.clock-name').after(held);
      }
      const powerups = chaos ? [PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING].map((type) => Chaos.find(game.power[color | type])).filter(Boolean) : [];
      const text = powerups.map((p) => p.icon).join('');
      if (held.textContent !== text) {
        held.replaceChildren(...powerups.map((p) => {
          const icon = document.createElement('span');
          icon.textContent = p.icon;
          icon.dataset.tip = powerTip(p);
          return icon;
        }));
      }
    }
  }

  // The line under the status: which mode this is and, in chaos, when the next round comes.
  function renderGameInfo() {
    const parts = [];
    const name = setupName(gameSetup);
    if (name) parts.push(name);
    if (chaos && !result) {
      if (drafting) parts.push(`draft ${chaos.round + 1} of ${Chaos.ROUNDS}`);
      else if (chaos.round < Chaos.ROUNDS) parts.push(`draft ${chaos.round + 1} of ${Chaos.ROUNDS} in ${formatTime(Math.max(0, chaos.round * Chaos.ROUND_MS - usedNow()))} of play`);
      else parts.push(`all ${Chaos.ROUNDS} drafts done`);
    }
    const text = parts.join(' · ');
    gameInfoEl.hidden = !text;
    if (gameInfoEl.textContent !== text) gameInfoEl.textContent = text;
  }

  // ---------------------------------------------------------------------------
  // The menu: one choice per screen, like the branches of a tree. First the kind of opponent, then
  // only the choices that kind needs (which computer, the game mode, the time, your side), and then
  // the game. The board shows only once a game starts; the Menu button comes back here.
  // ---------------------------------------------------------------------------

  const menuBodyEl = document.getElementById('menu-body');
  const menuPathEl = document.getElementById('menu-path');
  const menuBackEl = document.getElementById('menu-back');
  const menuButtonEl = document.getElementById('open-menu');
  let menuOpen = false;
  let menuMode = mode;      // the kind of opponent being set up
  // The screens followed to get to the one showing, each with what was picked to get there.
  let trail = [];

  const VARIANT_TEXT = {
    classic: 'No clock: take your time. Moves can be taken back.',
    blitz: 'Fast games of 3 to 5 minutes each.',
    rapid: 'Steadier games of 10 to 30 minutes each.',
    long: 'Long games of 45 to 90 minutes each.',
    chaos: '5 minutes each, with Clash Royale-style powerups drafted every 45 seconds.',
    custom: 'Set up any position on the board and play from it.',
  };
  const VARIANT_ICONS = { classic: '♟︎', blitz: '⚡', rapid: '⏱️', long: '🕰️', chaos: '🌀', custom: '✏️' };

  // `resume` marks the card that goes back to the game in progress, which stands out from the rest.
  function card({ icon, title, text = '', resume = false, onClick }) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'menu-card' + (resume ? ' resume' : '');
    const iconEl = document.createElement('span');
    iconEl.className = 'menu-icon';
    if (typeof icon === 'string') iconEl.textContent = icon;
    else iconEl.append(icon);
    const body = document.createElement('span');
    body.className = 'menu-text';
    const titleEl = document.createElement('strong');
    titleEl.textContent = title;
    body.append(titleEl);
    if (text) {
      const textEl = document.createElement('span');
      textEl.textContent = text;
      body.append(textEl);
    }
    const arrow = document.createElement('span');
    arrow.className = 'menu-arrow';
    arrow.textContent = '›';
    button.append(iconEl, body, arrow);
    button.addEventListener('click', onClick);
    return button;
  }

  function menuButton(text, onClick, primary = true) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'menu-go' + (primary ? ' primary' : '');
    button.textContent = text;
    button.addEventListener('click', onClick);
    return button;
  }

  function linkButton(text, onClick) {
    const button = menuButton(text, onClick, false);
    button.className = 'link-button';
    return button;
  }

  function nameField(label, key, placeholder) {
    const wrap = document.createElement('label');
    wrap.className = 'menu-field';
    const input = document.createElement('input');
    input.maxLength = NAME_LENGTH;
    input.placeholder = placeholder;
    input.spellcheck = false;
    input.autocomplete = key === 'me' ? 'nickname' : 'off';
    input.value = names[key];
    input.addEventListener('input', () => {
      names[key] = cleanName(input.value);
      save();
    });
    wrap.append(label, input);
    return wrap;
  }

  function avatar(gm) {
    const el = document.createElement('span');
    el.className = 'opponent-avatar';
    el.textContent = gm.initials;
    // A color of its own for each player, spread around the color wheel.
    if (gm.rank) el.style.setProperty('--hue', (gm.rank * 137) % 360);
    return el;
  }

  // The game on the board, in a few words.
  function describeGame() {
    const [first, second] = columnNames();
    const kind = setupName(gameSetup);
    return `${first} vs ${second}` + (kind ? ` · ${kind}` : '');
  }

  function gameInProgress() {
    return Boolean(game) && !result && (history.length > 0 || mode === 'online' || editing);
  }

  // After the game mode (and its time), the last screen: your side, or both names on a shared screen.
  function lastStep(label) {
    go(menuMode === 'local' ? 'names' : 'side', label);
  }

  // Each screen: { title, hint, items }.
  const STEPS = {
    home() {
      const items = [];
      if (gameInProgress()) {
        items.push(card({ icon: '▶', title: 'Back to your game', text: describeGame(), resume: true, onClick: closeMenu }));
      }
      items.push(
        card({ icon: '🤖', title: 'Play the computer', text: 'Our engine at any strength, or a top-10 grandmaster.', onClick: () => go('computer', 'Computer', 'computer') }),
        card({ icon: '👥', title: 'Play a friend here', text: 'Take turns on this screen.', onClick: () => go('variant', 'Friend here', 'local') }),
        card({ icon: '🌐', title: 'Play a friend online', text: 'Send a link and play from anywhere.', onClick: () => go('online', 'Online', 'online') }),
      );
      const foot = document.createElement('div');
      foot.className = 'menu-foot';
      const rated = document.createElement('span');
      rated.textContent = `Your rating ${myRating}`;
      foot.append(rated);
      if (lastGame.moves) {
        foot.append(linkButton('Review last game', () => {
          closeMenu();
          startReview();
        }));
      }
      if (InstallApp.available()) {
        foot.append(linkButton('Install app', () => {
          if (InstallApp.canPrompt()) InstallApp.install();
          else go('install', 'Install app');
        }));
      }
      foot.append(linkButton('Reset scores', () => {
        for (const key of Object.keys(scores)) scores[key] = blankScore();
        save();
        renderMenu();
      }));
      items.push(foot);
      return { title: 'Play chess', items };
    },

    computer() {
      const custom = { id: 'custom', name: 'Our engine', initials: '⚙' };
      const items = [custom, ...Grandmasters.LIST].map((gm) => card({
        icon: avatar(gm),
        title: gm.name,
        text: gm.rank ? `#${gm.rank} in the world · ${gm.country} · ${gm.rating}` : `Any strength from ${MIN_RATING} to ${MAX_RATING}`,
        onClick: () => {
          opponent = gm.id;
          stockfishFailed = false;
          save();
          if (gm.rank) go('variant', gm.name.split(' ').pop());
          else go('rating', 'Our engine');
        },
      }));
      const hint = stockfishFailed
        ? 'Stockfish could not be loaded (offline?), so the grandmasters play as our own engine at 2400 for now.'
        : `The grandmasters are FIDE's ${Grandmasters.LIST_DATE} top 10, played by the Stockfish engine at their strength (not their style).`;
      return { title: 'Who do you want to play?', hint, items };
    },

    rating() {
      const wrap = document.createElement('div');
      wrap.className = 'rating-pick';
      const value = document.createElement('strong');
      const label = document.createElement('span');
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = MIN_RATING;
      slider.max = MAX_RATING;
      slider.step = 100;
      slider.value = rating;
      slider.setAttribute('aria-label', 'Computer rating');
      const show = () => {
        value.textContent = rating;
        label.textContent = ratingName(rating);
        // The filled part of the slider track.
        slider.style.setProperty('--fill', ((rating - MIN_RATING) / (MAX_RATING - MIN_RATING) * 100) + '%');
      };
      slider.addEventListener('input', () => {
        rating = Number(slider.value);
        save();
        show();
      });
      show();
      const readout = document.createElement('p');
      readout.className = 'rating-readout';
      readout.append(value, label);
      wrap.append(readout, slider);
      return {
        title: 'How strong should it be?',
        hint: `Lower ratings look less far ahead and make human-like mistakes. Your own rating is ${myRating}.`,
        items: [wrap, menuButton('Next', () => go('variant', String(rating)))],
      };
    },

    variant() {
      const items = Object.keys(VARIANTS).map((id) => card({
        icon: VARIANT_ICONS[id],
        title: VARIANTS[id].name,
        text: VARIANT_TEXT[id],
        onClick: () => {
          variant = id;
          save();
          if (VARIANTS[id].times) go('time', VARIANTS[id].name);
          else lastStep(VARIANTS[id].name);
        },
      }));
      return { title: 'What kind of game?', items };
    },

    time() {
      const items = VARIANTS[variant].times.map(([minutes, increment], index) => {
        const name = timeName({ base: minutes * 60000, inc: increment * 1000 });
        return card({
          icon: '⏱️',
          title: name,
          text: increment ? `${minutes} minutes each, plus ${increment} seconds for every move` : `${minutes} minutes each`,
          onClick: () => {
            timeChoice[variant] = index;
            save();
            lastStep(name);
          },
        });
      });
      return { title: 'How much time?', items };
    },

    side() {
      const choose = (value) => {
        side = value;
        save();
        startFromMenu();
      };
      const online = menuMode === 'online';
      const items = [
        nameField('Your name', 'me', 'You'),
        card({ icon: pieceEl(WHITE | KING), title: 'White', text: 'You move first.', onClick: () => choose('white') }),
        card({ icon: pieceEl(BLACK | KING), title: 'Black', text: `${online ? 'Your friend' : 'The computer'} moves first.`, onClick: () => choose('black') }),
        card({ icon: '🎲', title: 'Random', text: 'Toss a coin for it.', onClick: () => choose('random') }),
      ];
      return {
        title: online ? 'Which side do you want?' : 'Which side do you play?',
        hint: online ? 'Then you get a link to send your friend.' : '',
        items,
      };
    },

    names() {
      return {
        title: 'Who’s playing?',
        hint: 'Names are optional. White moves first.',
        items: [nameField('White', 'white', 'White'), nameField('Black', 'black', 'Black'), menuButton('Start the game', startFromMenu)],
      };
    },

    online() {
      return {
        title: 'Play a friend online',
        items: [
          card({ icon: '✉️', title: 'Create a game', text: 'Pick the rules, then send your friend the link.', onClick: () => go('variant', 'Create') }),
          card({ icon: '🔑', title: 'Join a game', text: 'Type in the code your friend sent you.', onClick: () => go('join', 'Join') }),
        ],
      };
    },

    join() {
      const wrap = document.createElement('label');
      wrap.className = 'menu-field';
      const code = document.createElement('input');
      code.className = 'code';
      code.placeholder = 'code';
      code.autocomplete = 'off';
      code.spellcheck = false;
      wrap.append('Game code', code);
      const join = () => {
        if (!code.value.trim()) return code.focus();
        menuMode = 'online';
        menuOpen = false;
        mainEl.classList.remove('in-menu');
        setMode('online');
        Online.join(code.value);
      };
      code.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') join();
      });
      return {
        title: 'Join a friend’s game',
        hint: 'Your friend sees the code (or a link) when they create a game.',
        items: [nameField('Your name', 'me', 'You'), wrap, menuButton('Join', join)],
      };
    },

    // Only reached on an iPhone or iPad, which install from Safari's Share menu rather than a button.
    install() {
      const steps = document.createElement('ol');
      steps.className = 'install-steps';
      steps.append(...[
        'Tap the Share button at the bottom of Safari (the square with an arrow pointing up).',
        'Scroll down and tap Add to Home Screen.',
        'Tap Add. chessMess now has its own icon and opens full-screen, even offline.',
      ].map((text) => {
        const item = document.createElement('li');
        item.textContent = text;
        return item;
      }));
      return { title: 'Install chessMess', hint: 'Put the game on your home screen like an app.', items: [steps] };
    },
  };

  // The browser can offer installing only after the page has loaded; show the link once it does.
  InstallApp.onChange(() => {
    if (menuOpen && !trail.length) renderMenu();
  });

  function go(step, label, newMode) {
    if (newMode) menuMode = newMode;
    trail.push({ step, label });
    renderMenu();
  }

  function renderMenu() {
    const step = trail.length ? trail[trail.length - 1].step : 'home';
    const { title, hint = '', items } = STEPS[step]();
    document.getElementById('menu-title').textContent = title;
    const hintEl = document.getElementById('menu-hint');
    hintEl.textContent = hint;
    hintEl.hidden = !hint;
    menuBodyEl.replaceChildren(...items);
    menuBodyEl.animate([{ opacity: 0, transform: 'translateX(18px)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: 'ease-out' });
    // Where you are, like a path through the branches: Play › Computer › Carlsen › Blitz.
    menuPathEl.replaceChildren(...['Play', ...trail.map((t) => t.label)].map((label, i) => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.disabled = i === trail.length;
      button.addEventListener('click', () => {
        trail = trail.slice(0, i);
        renderMenu();
      });
      item.append(button);
      return item;
    }));
    menuBackEl.parentElement.hidden = !trail.length;
  }

  function openMenu() {
    if (drafting) return;
    menuOpen = true;
    trail = [];
    menuMode = mode;
    turnToken++;   // the computer stops thinking (it carries on when you go back to the game)
    drag = null;
    selected = -1;
    promotionEl.hidden = true;
    gameOverEl.hidden = true;
    mainEl.classList.add('in-menu');
    render();
    renderMenu();
  }

  function closeMenu() {
    menuOpen = false;
    mainEl.classList.remove('in-menu');
    render();
    if (!result && !drafting && !waiting && !editing && seat(game.turn) === 'computer') computerTurn();
  }

  // The last choice is made: start the game it describes.
  function startFromMenu() {
    save();
    menuOpen = false;
    mainEl.classList.remove('in-menu');
    if (menuMode === 'online') {
      // A fresh connection, then the game is hosted straight away (after setting up the position,
      // for a custom one).
      setMode('online');
      if (variant === 'custom') openEditor();
      else Online.host();
      return;
    }
    if (menuMode !== mode) setMode(menuMode);
    else newGame();
    if (variant === 'custom') openEditor();
  }

  menuBackEl.addEventListener('click', () => {
    trail.pop();
    renderMenu();
  });
  menuButtonEl.addEventListener('click', openMenu);

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
    setupPlayEl.textContent = mode === 'online' ? 'Create the game' : 'Play this position';
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
    drawBoard({ board: edit.board, inCheck: () => false }, { flip: mode !== 'local' && side === 'black' });
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
    // Online, the position is for the game you host, which starts now.
    if (mode === 'online') Online.host();
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
      // A draft that was about to open when the friend dropped out opens now.
      if (drafting && !draft && chaosDue()) startDraft();
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
      return chosenColor();
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
    // Online, the real game only starts once the friend joins (with the host's rules); until then a
    // plain board waits behind the online panel.
    if (mode === 'online') newGame(undefined, { setup: { variant: 'classic' } });
    else newGame();
    if (mode === 'online') Online.open(onlineHooks);
  }

  // ---------------------------------------------------------------------------
  // The actions under the board
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
  document.getElementById('game-over-menu').addEventListener('click', openMenu);
  document.getElementById('review-game').addEventListener('click', startReview);

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

  // The page opens on the menu, or straight into a friend's online game from an invite link. Until
  // a game is chosen, a plain one sits behind the menu.
  newGame(undefined, { setup: { variant: 'classic' } });
  if (joinCode) {
    Online.open(onlineHooks);
    Online.join(joinCode);
  } else {
    openMenu();
  }
})();
