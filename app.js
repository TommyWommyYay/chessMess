(function () {
  'use strict';

  const { Game, chooseMove, sameMove, moveToUci, squareName, WHITE, BLACK, F_EP, F_CASTLE, MIN_RATING, MAX_RATING } = Chess;

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
  const RATING_NAMES = [[400, 'Beginner'], [800, 'Casual'], [1200, 'Club player'], [1600, 'Strong'], [2000, 'Expert'], [2300, 'Master'],
    [2850, 'Magnus Carlsen']];
  // The slider's last stop, one step past our own engine's top rating, is the Magnus level:
  // Stockfish at full strength (see magnus.js), rated like Magnus himself.
  const MAGNUS_RATING = 2850;
  const MAGNUS_STOP = MAX_RATING + 100;
  const MAGNUS_THINK_MS = 2000;

  const boardEl = document.getElementById('board');
  const boardWrapEl = document.getElementById('board-wrap');
  const statusEl = document.getElementById('status');
  const promotionEl = document.getElementById('promotion');
  const promotionChoicesEl = document.getElementById('promotion-choices');
  const gameOverEl = document.getElementById('game-over');
  const mainEl = document.querySelector('main');
  const modeEl = document.getElementById('mode');
  const ratingEl = document.getElementById('rating');
  const sideEl = document.getElementById('side');
  const nameEls = {
    me: document.getElementById('name'),
    white: document.getElementById('white-name'),
    black: document.getElementById('black-name'),
  };
  const resignEl = document.getElementById('resign');
  const reviewLastEl = document.getElementById('review-last');
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
  ratingEl.max = MAGNUS_STOP;
  setSlider(clampRating(saved.rating ?? OLD_LEVELS[saved.difficulty] ?? START_RATING));
  sideEl.value = saved.side === 'black' ? 'black' : 'white';
  const names = { me: '', white: '', black: '', ...saved.names };
  for (const key of Object.keys(nameEls)) nameEls[key].value = names[key] = cleanName(names[key]);
  let myRating = Number.isFinite(saved.myRating) ? saved.myRating : START_RATING;

  let mode = modeEl.value;  // 'computer', 'local' (two players on this screen) or 'online'
  let game, playerColor, legal, selected, lastMove, positions, history, result;
  let lastGame = load(LAST_GAME_KEY);
  let squareEls = [];
  let flipped = false;      // the board is drawn from black's side
  let dealing = false;      // true while the pieces drop in at the start of a game
  let reviewing = false;    // true while a finished game is being reviewed instead of played
  let waiting = false;      // an online game that has not started, or whose friend has dropped out
  let waitingText = '';
  let gameRating = sliderRating();   // the computer's rating for the game being played
  let magnusFailed = false; // Stockfish could not be loaded, so the Magnus level falls back to 2400
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
    store(STORAGE_KEY, { scores, mode, rating: sliderRating(), myRating, names, side: sideEl.value });
  }

  function clampRating(value) {
    if (Number(value) >= MAGNUS_RATING) return MAGNUS_RATING;
    return Math.min(MAX_RATING, Math.max(MIN_RATING, Math.round(Number(value) / 100) * 100 || START_RATING));
  }

  function sliderRating() {
    return Number(ratingEl.value) >= MAGNUS_STOP ? MAGNUS_RATING : Number(ratingEl.value);
  }

  function setSlider(rating) {
    ratingEl.value = rating >= MAGNUS_RATING ? MAGNUS_STOP : rating;
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
    if (mode === 'computer') return [names.me || 'You', gameRating === MAGNUS_RATING ? 'Magnus (2850)' : `Computer (${gameRating})`];
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
    return { me: 'you', computer: 'the computer', friend: friendName || 'your friend' }[seat(color)];
  }

  const capitalise = (text) => text[0].toUpperCase() + text.slice(1);

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
        pending.resolve(chooseMove(pending.game, pending.rating, pending.seen));
        pending = null;
      }
    };
  } catch {
    worker = null;
  }

  function think() {
    if (gameRating === MAGNUS_RATING && !magnusFailed) return thinkLikeMagnus();
    return thinkOurselves(Math.min(gameRating, MAX_RATING));
  }

  function thinkOurselves(rating) {
    return new Promise((resolve) => {
      if (!worker) {
        const current = game, seen = positions;
        setTimeout(() => resolve(chooseMove(current, rating, seen)), 50);
        return;
      }
      pending = { id: ++requestId, resolve, game, rating, seen: positions };
      worker.postMessage({ id: pending.id, state: game.snapshot(), rating, seen: [...positions] });
    });
  }

  function thinkLikeMagnus() {
    const current = game, moves = history.map(moveToUci);
    return Magnus.bestMove(moves, MAGNUS_THINK_MS).then(
      (uci) => {
        if (current !== game) return null;
        return legal.find((m) => moveToUci(m) === uci) || thinkOurselves(MAX_RATING);
      },
      () => {
        // Stockfish is fetched from the internet; without it, play our own engine's best.
        magnusFailed = true;
        render();
        return current === game ? thinkOurselves(MAX_RATING) : null;
      },
    );
  }

  function computerTurn() {
    const token = ++turnToken;
    // Wait at least long enough for the player's move (or the opening deal) to finish animating.
    const pause = new Promise((resolve) => setTimeout(resolve, lastMove ? 700 : 1300));
    Promise.all([think(), pause]).then(([move]) => {
      if (token === turnToken && !result && move) playMove(move);
    });
  }

  // ---------------------------------------------------------------------------
  // Game flow
  // ---------------------------------------------------------------------------

  // Starts a game with this screen's player on `color` (for an online game, the color the host
  // picked; otherwise the "Play as" choice). `moves` are already played, when an online game is
  // picked up again after a dropped connection.
  function newGame(color, moves = []) {
    turnToken++;
    clearTimeout(gameOverTimer);
    FX.stop();
    game = new Game();
    playerColor = mode === 'local' ? WHITE : color ?? (sideEl.value === 'black' ? BLACK : WHITE);
    gameRating = sliderRating();
    selected = -1;
    lastMove = null;
    result = null;
    history = [];
    positions = new Map([[game.key(), 1]]);
    for (const saved of moves) {
      const move = game.legalMoves().find((m) => sameMove(m, saved));
      if (!move) break;
      record(move);
    }
    legal = game.legalMoves();
    promotionEl.hidden = true;
    gameOverEl.hidden = true;
    boardWrapEl.classList.remove('lost');
    dealing = !moves.length;
    render();
    const token = turnToken;
    setTimeout(() => {
      if (token === turnToken) dealing = false;
    }, 1200);
    if (seat(game.turn) === 'computer') computerTurn();
  }

  // `winner` is a color, or null for a draw.
  function finish(winner, message) {
    result = message;
    turnToken++;
    const iWon = winner !== null && seat(winner) === 'me';
    const column = winner === null ? 'draws' : (mode === 'local' ? winner === WHITE : iWon) ? 'me' : 'them';
    scores[mode][column]++;
    const ratingText = mode === 'computer' ? rate(winner === null ? 0.5 : iWon ? 1 : 0) : '';
    save();
    // Kept so the game can be reviewed afterwards, even after the page is reloaded.
    if (history.length) {
      lastGame = {
        moves: history.map(({ from, to, promo }) => ({ from, to, promo })),
        player: playerColor === BLACK ? 'black' : 'white',
        opponent: mode,
        level: gameRating,
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

  // Makes a move on the board without any of the presentation; returns the new position's key.
  function record(move) {
    game.make(move);
    history.push(move);
    lastMove = move;
    const key = game.key();
    positions.set(key, (positions.get(key) || 0) + 1);
    return key;
  }

  // `drop` is set when the player dragged the piece onto its square, so it should not slide there
  // again; it holds how far the piece was swinging when it was let go.
  function playMove(move, drop) {
    const mover = game.turn;
    dealing = false;
    const key = record(move);
    selected = -1;
    legal = game.legalMoves();
    if (mode === 'online' && seat(mover) === 'me') Online.sendMove(move, history.length - 1);

    if (!legal.length) {
      if (game.inCheck()) finish(mover, checkmateText(mover));
      else finish(null, 'Stalemate — no legal moves left.');
    } else if (game.insufficientMaterial()) {
      finish(null, 'Not enough pieces left to checkmate.');
    } else if (positions.get(key) >= 3) {
      finish(null, 'The same position came up three times.');
    } else if (game.halfmove >= 100) {
      finish(null, 'Fifty moves without a capture or pawn move.');
    }

    render();
    // An online friend's move can arrive during a review, which has the board just then.
    if (!reviewing) animateMove(move, mover, drop);
    if (!result && seat(game.turn) === 'computer') computerTurn();
  }

  function playerCanMove() {
    return !reviewing && !waiting && !result && seat(game.turn) === 'me' && promotionEl.hidden;
  }

  function onSquareClick(sq) {
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

  // When castling, the rook jumps over the king: from the corner to the square next to it.
  function slideRook(move) {
    if (!(move.flags & F_CASTLE)) return;
    if (move.to > move.from) slide(move.to + 1, move.to - 1);
    else slide(move.to - 2, move.to + 1);
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
    const square = squareEls[captureSq];
    const ghost = pieceEl(move.captured);
    ghost.classList.add('ghost');
    square.prepend(ghost);
    setTimeout(() => {
      const box = square.getBoundingClientRect();
      FX.explode(box.left + box.width / 2, box.top + box.height / 2, box.width, (move.captured & 8) === WHITE);
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
    }, drop ? 0 : MOVE_MS * 0.6);
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
    if (result) return result;
    if (waiting) return waitingText;
    const who = seat(game.turn), check = game.inCheck();
    if (who === 'computer') return 'Computer is thinking';
    if (who === 'friend') return `${capitalise(sideName(game.turn))} is thinking`;
    if (mode === 'local') {
      const name = sideName(game.turn);
      return check ? `${capitalise(name)} is in check — ${name} to move.` : `${capitalise(name)} to move.`;
    }
    return check ? 'You are in check — your move.' : 'Your move.';
  }

  // Draws a position onto the board and returns its squares, indexed by square number. The live
  // game and the review both draw through here. `movable` is the color whose pieces can be picked up.
  function drawBoard(position, { flip = false, lastMove = null, selected = -1, targets = new Set(), movable = -1 } = {}) {
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
    if (reviewing) return;
    boardEl.classList.toggle('dealing', dealing);
    drawBoard(game, {
      flip: playerColor === BLACK,
      lastMove,
      selected,
      targets: new Set(legal.filter((m) => m.from === selected).map((m) => m.to)),
      movable: playerCanMove() ? game.turn : -1,
    });
    mainEl.dataset.mode = mode;
    resignEl.disabled = Boolean(result) || waiting;
    reviewLastEl.disabled = !lastGame.moves;

    const text = statusText();
    if (statusEl.textContent !== text) {
      statusEl.textContent = text;
      statusEl.animate([{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'none' }], { duration: 300 });
    }
    statusEl.classList.toggle('thinking', !result && !waiting && seat(game.turn) !== 'me');

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

  function renderRating() {
    const chosen = sliderRating();
    document.getElementById('rating-value').textContent = chosen;
    // A new rating for the computer takes over from the next game, unless this one has not begun.
    const later = chosen !== gameRating;
    let note = later ? ' · from your next game' : '';
    if (chosen === MAGNUS_RATING) note += magnusFailed ? ' · Stockfish did not load (offline?), so playing at 2400' : ' · Stockfish at full strength';
    document.getElementById('rating-name').textContent = ratingName(chosen) + note;
    document.getElementById('my-rating').textContent = myRating;
    // The filled part of the slider track.
    ratingEl.style.setProperty('--fill', ((ratingEl.value - MIN_RATING) / (MAGNUS_STOP - MIN_RATING) * 100) + '%');
    document.getElementById('rating-field').classList.toggle('magnus', chosen === MAGNUS_RATING);
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
        if (!result && seat(game.turn) === 'computer') computerTurn();
      },
    });
  }

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
    begin(color, moves) {
      waiting = false;
      newGame(color, moves);
    },
    resume() {
      waiting = false;
      render();
    },
    move(message) {
      // Ignore anything that is not the friend's next move in this very game.
      if (waiting || result || seat(game.turn) !== 'friend' || message.ply !== history.length) return;
      const move = legal.find((m) => sameMove(m, message));
      if (move) playMove(move);
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
      return { moves: history.map(({ from, to, promo }) => ({ from, to, promo })), finished: Boolean(result) };
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
    if (result || waiting) return;
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
    if (mode === 'computer' && !history.length && !result) gameRating = sliderRating();
    magnusFailed = false;
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

  newGame();
  if (mode === 'online') {
    Online.open(onlineHooks);
    if (joinCode) Online.join(joinCode);
  }
})();
