(function () {
  'use strict';

  const { Game, chooseMove, squareName, WHITE, BLACK, F_EP, F_CASTLE } = Chess;

  // Solid glyphs for both sides (coloured in CSS); U+FE0E stops the pawn rendering as an emoji.
  const GLYPHS = ['', '♟', '♞', '♝', '♜', '♛', '♚'].map((g) => g && g + '︎');
  const PIECE_NAMES = ['', 'pawn', 'knight', 'bishop', 'rook', 'queen', 'king'];
  const STORAGE_KEY = 'chessMess';
  const LAST_GAME_KEY = 'chessMess.lastGame';
  const MOVE_MS = 300;

  const boardEl = document.getElementById('board');
  const boardWrapEl = document.getElementById('board-wrap');
  const statusEl = document.getElementById('status');
  const promotionEl = document.getElementById('promotion');
  const promotionChoicesEl = document.getElementById('promotion-choices');
  const gameOverEl = document.getElementById('game-over');
  const difficultyEl = document.getElementById('difficulty');
  const sideEl = document.getElementById('side');
  const resignEl = document.getElementById('resign');
  const reviewLastEl = document.getElementById('review-last');
  const scoreEls = {
    player: document.getElementById('score-player'),
    computer: document.getElementById('score-computer'),
    draws: document.getElementById('score-draws'),
  };

  const saved = load(STORAGE_KEY);
  const score = { player: saved.player || 0, computer: saved.computer || 0, draws: saved.draws || 0 };
  difficultyEl.value = ['easy', 'medium', 'hard'].includes(saved.difficulty) ? saved.difficulty : 'easy';
  sideEl.value = saved.side === 'black' ? 'black' : 'white';

  let game, playerColor, legal, selected, lastMove, positions, history, result;
  let lastGame = load(LAST_GAME_KEY);
  let squareEls = [];
  let flipped = false;      // the board is drawn from black's side
  let dealing = false;      // true while the pieces drop in at the start of a game
  let reviewing = false;    // true while a finished game is being reviewed instead of played
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
    store(STORAGE_KEY, { ...score, difficulty: difficultyEl.value, side: sideEl.value });
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
        pending.resolve(chooseMove(pending.game, pending.level, pending.seen));
        pending = null;
      }
    };
  } catch {
    worker = null;
  }

  function think() {
    const level = difficultyEl.value;
    return new Promise((resolve) => {
      if (!worker) {
        const current = game, seen = positions;
        setTimeout(() => resolve(chooseMove(current, level, seen)), 50);
        return;
      }
      pending = { id: ++requestId, resolve, game, level, seen: positions };
      worker.postMessage({ id: pending.id, state: game.snapshot(), level, seen: [...positions] });
    });
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

  function newGame() {
    turnToken++;
    clearTimeout(gameOverTimer);
    FX.stop();
    game = new Game();
    playerColor = sideEl.value === 'black' ? BLACK : WHITE;
    legal = game.legalMoves();
    selected = -1;
    lastMove = null;
    result = null;
    history = [];
    positions = new Map([[game.key(), 1]]);
    promotionEl.hidden = true;
    gameOverEl.hidden = true;
    boardWrapEl.classList.remove('lost');
    dealing = true;
    render();
    const token = turnToken;
    setTimeout(() => {
      if (token === turnToken) dealing = false;
    }, 1200);
    if (game.turn !== playerColor) computerTurn();
  }

  function finish(winner, title, message) {
    result = message;
    turnToken++;
    score[winner === 'draw' ? 'draws' : winner]++;
    save();
    // Kept so the game can be reviewed afterwards, even after the page is reloaded.
    if (history.length) {
      lastGame = {
        moves: history.map(({ from, to, promo }) => ({ from, to, promo })),
        player: playerColor === BLACK ? 'black' : 'white',
        level: difficultyEl.value,
        winner, result: message,
      };
      store(LAST_GAME_KEY, lastGame);
    }
    // Let the final move (and any explosion) play out before announcing the result.
    gameOverTimer = setTimeout(() => {
      document.getElementById('game-over-title').textContent = title;
      document.getElementById('game-over-text').textContent = message;
      gameOverEl.className = 'overlay ' + (winner === 'player' ? 'win' : winner === 'computer' ? 'loss' : 'draw');
      gameOverEl.hidden = false;
      if (winner === 'player') FX.celebrate();
      if (winner === 'computer') boardWrapEl.classList.add('lost');
    }, 900);
  }

  // `drop` is set when the player dragged the piece onto its square, so it should not slide there
  // again; it holds how far the piece was swinging when it was let go.
  function playMove(move, drop) {
    const mover = game.turn;
    dealing = false;
    game.make(move);
    history.push(move);
    lastMove = move;
    selected = -1;
    legal = game.legalMoves();
    const key = game.key();
    positions.set(key, (positions.get(key) || 0) + 1);

    if (!legal.length) {
      if (game.inCheck()) {
        if (mover === playerColor) finish('player', 'You win!', 'Checkmate — you beat the computer.');
        else finish('computer', 'Defeat', 'Checkmate — the computer wins.');
      } else {
        finish('draw', 'Draw', 'Stalemate — no legal moves left.');
      }
    } else if (game.insufficientMaterial()) {
      finish('draw', 'Draw', 'Not enough pieces left to checkmate.');
    } else if (positions.get(key) >= 3) {
      finish('draw', 'Draw', 'The same position came up three times.');
    } else if (game.halfmove >= 100) {
      finish('draw', 'Draw', 'Fifty moves without a capture or pawn move.');
    }

    render();
    animateMove(move, mover, drop);
    if (!result && game.turn !== playerColor) computerTurn();
  }

  function playerCanMove() {
    return !reviewing && !result && game.turn === playerColor && promotionEl.hidden;
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
    selected = piece && (piece & 8) === playerColor && sq !== selected ? sq : -1;
    render();
  }

  function askPromotion(moves, drop) {
    promotionChoicesEl.replaceChildren(...moves.map((m) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'square';
      button.setAttribute('aria-label', PIECE_NAMES[m.promo]);
      button.append(pieceEl(playerColor | m.promo));
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
    if (!piece || (piece & 8) !== playerColor) return onSquareClick(sq);

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
    const moves = legal.filter((m) => m.from === sq && m.to === to);
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
    if (game.turn !== playerColor) return 'Computer is thinking';
    return game.inCheck() ? 'You are in check — your move.' : 'Your move.';
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
      movable: playerCanMove() ? playerColor : -1,
    });
    resignEl.disabled = Boolean(result);
    reviewLastEl.disabled = !lastGame.moves;

    const text = statusText();
    if (statusEl.textContent !== text) {
      statusEl.textContent = text;
      statusEl.animate([{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'none' }], { duration: 300 });
    }
    statusEl.classList.toggle('thinking', !result && game.turn !== playerColor);

    for (const who of Object.keys(scoreEls)) {
      const el = scoreEls[who], value = String(score[who]);
      if (el.textContent !== value) {
        // Do not animate the numbers filling in when the page first loads.
        if (game.fullmove > 1 || result) pop(el);
        el.textContent = value;
      }
    }
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
        if (!result && game.turn !== playerColor) computerTurn();
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Controls
  // ---------------------------------------------------------------------------

  document.getElementById('new-game').addEventListener('click', newGame);
  document.getElementById('play-again').addEventListener('click', newGame);
  document.getElementById('view-board').addEventListener('click', () => {
    gameOverEl.hidden = true;
  });
  document.getElementById('review-game').addEventListener('click', startReview);
  reviewLastEl.addEventListener('click', startReview);

  resignEl.addEventListener('click', () => {
    if (result) return;
    promotionEl.hidden = true;
    selected = -1;
    finish('computer', 'Defeat', 'You resigned — the computer wins.');
    render();
  });

  document.getElementById('reset-score').addEventListener('click', () => {
    score.player = score.computer = score.draws = 0;
    save();
    render();
  });

  // Difficulty applies from the computer's next move; switching sides starts a fresh game.
  difficultyEl.addEventListener('change', save);
  sideEl.addEventListener('change', () => {
    save();
    newGame();
  });

  newGame();
})();
