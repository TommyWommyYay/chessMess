// Game review: steps through a finished game with the engine's verdict on every move: an evaluation
// bar and graph, an arrow for the move that should have been played, and an accuracy for each side.
(function (root) {
  'use strict';

  const { Game, analyse, moveToSan, sameMove, MATE, WHITE } = Chess;

  // A move is judged by how many percentage points it knocked off the mover's chance of winning
  // (the way Lichess does it), so that dropping a pawn matters more in a level game than in a
  // game that is already won or lost.
  const KINDS = {
    best: { label: 'Best', icon: '★', says: 'is the best move' },
    excellent: { label: 'Excellent', icon: '!', says: 'is excellent' },
    good: { label: 'Good', icon: '✓', says: 'is good' },
    forced: { label: 'Forced', icon: '→', says: 'was the only legal move' },
    inaccuracy: { label: 'Inaccuracy', icon: '?!', says: 'is an inaccuracy' },
    mistake: { label: 'Mistake', icon: '?', says: 'is a mistake' },
    blunder: { label: 'Blunder', icon: '??', says: 'is a blunder' },
  };
  const SUMMARY_KINDS = ['best', 'excellent', 'good', 'inaccuracy', 'mistake', 'blunder'];
  const MARKED_KINDS = ['inaccuracy', 'mistake', 'blunder'];
  // The column headings for the reviewed player and their opponent, by who the opponent was.
  const SIDES = {
    computer: ['You', 'Computer'],
    online: ['You', 'Friend'],
    local: ['White', 'Black'],
  };

  const mainEl = document.querySelector('main');
  const panelEl = document.getElementById('review');
  const resultEl = document.getElementById('review-result');
  const progressEl = document.getElementById('review-progress');
  const summaryEl = document.getElementById('review-summary');
  const graphEl = document.getElementById('review-graph');
  const commentEl = document.getElementById('review-comment');
  const movesEl = document.getElementById('review-moves');
  const evalBarEl = document.getElementById('eval-bar');
  const arrowsEl = document.getElementById('arrows');

  let review = null;        // the review on screen, if any

  // ---------------------------------------------------------------------------
  // Scores. The engine scores a position in centipawns for the side to move; a mate is MATE minus
  // the number of plies until it happens.
  // ---------------------------------------------------------------------------

  const isMate = (score) => Math.abs(score) > MATE - 1000;

  // The score of a move, turned into the score of the position it leads to.
  function afterMove(score) {
    return isMate(score) ? -Math.sign(score) * (Math.abs(score) + 1) : -score;
  }

  function forWhite(score, position) {
    return position.turn === WHITE ? score : -score;
  }

  // Chance of winning, 0 to 100, for the side the score belongs to.
  function winChance(score) {
    if (isMate(score)) return score > 0 ? 100 : 0;
    return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * score)) - 1);
  }

  function formatScore(white) {
    if (isMate(white)) {
      const moves = Math.ceil((MATE - Math.abs(white)) / 2);
      return moves ? (white > 0 ? '' : '−') + 'M' + moves : '#';
    }
    return (white > 0 ? '+' : white < 0 ? '−' : '') + (Math.abs(white) / 100).toFixed(1);
  }

  // White's evaluation of the position after `ply` half-moves, or null before it is analysed.
  function evalAt(ply) {
    const { analysis, positions } = review;
    if (ply === 0) return analysis[0] ? forWhite(analysis[0].bestScore, positions[0]) : null;
    const a = analysis[ply - 1];
    return a ? forWhite(afterMove(a.playedScore), positions[ply]) : null;
  }

  // The verdict on move i, or null before it is analysed.
  function verdict(i) {
    const a = review.analysis[i];
    if (!a) return null;
    const loss = Math.max(0, winChance(a.bestScore) - winChance(a.playedScore));
    const accuracy = Math.min(100, Math.max(0, 103.1668 * Math.exp(-0.04354 * loss) - 3.1669));
    let kind;
    if (a.options === 1) kind = 'forced';
    else if (sameMove(a.best, review.moves[i]) || a.playedScore >= a.bestScore) kind = 'best';
    else if (loss < 2) kind = 'excellent';
    else if (loss < 10) kind = 'good';
    else if (loss < 20) kind = 'inaccuracy';
    else if (loss < 30) kind = 'mistake';
    else kind = 'blunder';
    return { kind, accuracy };
  }

  // ---------------------------------------------------------------------------
  // Analysis runs one position at a time in its own worker, so the review can be used while it
  // fills in. Without workers it runs on the page between frames.
  // ---------------------------------------------------------------------------

  function startEngine() {
    let worker = null, pending = null, nextId = 0;
    const onPage = (position, move) => analyse(Game.restore(position.snapshot()), move);
    try {
      worker = new Worker(URL.createObjectURL(new Blob([Chess.workerSource], { type: 'text/javascript' })));
      worker.onmessage = (event) => {
        if (pending && event.data.id === pending.id) {
          const { resolve } = pending;
          pending = null;
          resolve(event.data.analysis);
        }
      };
      worker.onerror = () => {
        worker = null;
        if (pending) pending.resolve(onPage(pending.position, pending.move));
        pending = null;
      };
    } catch {
      worker = null;
    }

    return {
      analyse(position, { from, to, promo }) {
        const move = { from, to, promo };
        return new Promise((resolve) => {
          if (!worker) return setTimeout(() => resolve(onPage(position, move)), 0);
          pending = { id: ++nextId, resolve, position, move };
          worker.postMessage({ id: pending.id, type: 'analyse', state: position.snapshot(), played: move });
        });
      },
      stop() {
        if (worker) worker.terminate();
        worker = pending = null;
      },
    };
  }

  async function runAnalysis(r) {
    r.engine = startEngine();
    for (let i = r.analysis.length; i < r.moves.length; i++) {
      const result = await r.engine.analyse(r.positions[i], r.moves[i]);
      if (review !== r) return;
      r.analysis[i] = result;
      refresh(i);
    }
    r.engine.stop();
    r.record.analysis = r.analysis;
    r.board.save(r.record);
  }

  // ---------------------------------------------------------------------------
  // Opening and closing
  // ---------------------------------------------------------------------------

  // Plays the saved moves through from the start, keeping every position along the way.
  function replay(record) {
    const g = new Game();
    const positions = [Game.restore(g.snapshot())], moves = [];
    for (const saved of record.moves) {
      const legal = g.legalMoves();
      const move = legal.find((m) => sameMove(m, saved));
      if (!move) break;
      moves.push({ ...move, san: moveToSan(g, move, legal), color: g.turn, number: g.fullmove });
      g.make(move);
      positions.push(Game.restore(g.snapshot()));
    }
    return { positions, moves };
  }

  // `board` lends the review the page's board: draw(position, options) and slide(move) draw on it,
  // save(record) stores finished analysis, and close() hands the board back.
  function open(record, board) {
    const { positions, moves } = replay(record);
    review = {
      record, board, positions, moves,
      analysis: (record.analysis || []).slice(0, moves.length),
      flip: record.player === 'black',
      ply: 0, squares: [], cells: [], engine: null,
    };

    mainEl.classList.add('reviewing');
    panelEl.hidden = false;
    evalBarEl.classList.toggle('flipped', review.flip);
    const fullMoves = Math.ceil(moves.length / 2);
    const opponent = record.opponent || 'computer';
    const against = { computer: `against the ${record.level} computer`, online: 'against your friend', local: 'on one screen' }[opponent];
    resultEl.textContent = `${record.result} ${fullMoves} ${fullMoves === 1 ? 'move' : 'moves'} ${against}.`;
    [review.firstName, review.secondName] = SIDES[opponent];
    buildMoveList();
    show(0);
    refresh();
    if (review.analysis.length < moves.length) runAnalysis(review);
  }

  function close() {
    if (!review) return;
    const r = review;
    review = null;
    if (r.engine) r.engine.stop();
    // Keep what has been analysed so far, so reopening the review carries on from there.
    r.record.analysis = r.analysis;
    r.board.save(r.record);
    mainEl.classList.remove('reviewing');
    panelEl.hidden = true;
    arrowsEl.replaceChildren();
    r.board.close();
  }

  // ---------------------------------------------------------------------------
  // Drawing
  // ---------------------------------------------------------------------------

  function show(ply, animate) {
    const r = review;
    r.ply = Math.max(0, Math.min(r.moves.length, ply));
    const move = r.ply ? r.moves[r.ply - 1] : null;
    r.squares = r.board.draw(r.positions[r.ply], { flip: r.flip, lastMove: move });
    if (animate && move) r.board.slide(move);
    decorate();

    for (const cell of movesEl.querySelectorAll('.current')) cell.classList.remove('current');
    const cell = r.cells[r.ply - 1];
    if (cell) {
      cell.classList.add('current');
      // Scroll the list (not the page) so the current move is in view.
      if (cell.offsetTop < movesEl.scrollTop) movesEl.scrollTop = cell.offsetTop;
      else if (cell.offsetTop + cell.offsetHeight > movesEl.scrollTop + movesEl.clientHeight) {
        movesEl.scrollTop = cell.offsetTop + cell.offsetHeight - movesEl.clientHeight;
      }
    } else {
      movesEl.scrollTop = 0;
    }
  }

  // Everything on and around the board that depends on the analysis of the current move.
  function decorate() {
    const r = review, ply = r.ply;
    const white = evalAt(ply);
    const chance = white === null ? 50 : winChance(white);
    evalBarEl.style.setProperty('--white', chance.toFixed(1) + '%');
    evalBarEl.classList.toggle('black-ahead', chance < 50);
    evalBarEl.querySelector('.eval-text').textContent = white === null ? '' : formatScore(white);

    const cursor = graphEl.querySelector('.graph-cursor');
    if (cursor) cursor.setAttribute('transform', `translate(${ply} 0)`);

    arrowsEl.replaceChildren();
    for (const badge of r.squares.map((sq) => sq.querySelector('.badge')).filter(Boolean)) badge.remove();

    if (ply === 0) {
      commentEl.replaceChildren(
        white === null ? 'Analysing the game…' : `Starting position (${formatScore(white)}).`,
        ' Step through with the buttons below or the ← → keys.',
      );
      return;
    }

    const i = ply - 1, move = r.moves[i], v = verdict(i);
    const name = `${move.number}${move.color === WHITE ? '.' : '…'} ${move.san}`;
    if (!v) {
      commentEl.replaceChildren(`${name} — analysing…`);
      return;
    }

    const badge = document.createElement('span');
    badge.className = 'badge ' + v.kind;
    badge.textContent = KINDS[v.kind].icon;
    badge.title = KINDS[v.kind].label;
    r.squares[move.to].append(badge);

    const icon = kindIcon(v.kind);
    const score = formatScore(white);
    const parts = [icon, ` ${name} ${KINDS[v.kind].says}${score === '#' ? ' — checkmate!' : ` (${score}).`}`];
    const a = r.analysis[i];
    if (v.kind !== 'best' && v.kind !== 'forced') {
      arrowsEl.innerHTML = arrow(a.best.from, a.best.to, r.flip);
      const bestEval = formatScore(forWhite(afterMove(a.bestScore), r.positions[ply]));
      const best = document.createElement('strong');
      best.textContent = bestSan(i);
      parts.push(' Best was ', best, ` (${bestEval}).`);
    }
    commentEl.replaceChildren(...parts);
  }

  function kindIcon(kind) {
    const el = document.createElement('span');
    el.className = 'kind-icon ' + kind;
    el.textContent = KINDS[kind].icon;
    el.title = KINDS[kind].label;
    return el;
  }

  function bestSan(i) {
    const g = review.positions[i], legal = g.legalMoves();
    return moveToSan(g, legal.find((m) => sameMove(m, review.analysis[i].best)), legal);
  }

  // An arrow between two square centres, in board units (the board is 8 x 8).
  function arrow(from, to, flip) {
    const centre = (sq) => {
      const x = (sq & 7) + 0.5, y = (sq >> 3) + 0.5;
      return flip ? [8 - x, 8 - y] : [x, y];
    };
    const [x1, y1] = centre(from), [x2, y2] = centre(to);
    const length = Math.hypot(x2 - x1, y2 - y1);
    const ux = (x2 - x1) / length, uy = (y2 - y1) / length;
    const nx = -uy, ny = ux;
    const shaft = 0.09, head = 0.24, headLength = 0.42;
    const sx = x1 + ux * 0.2, sy = y1 + uy * 0.2;
    const bx = x2 - ux * headLength, by = y2 - uy * headLength;
    const points = [
      [sx + nx * shaft, sy + ny * shaft], [bx + nx * shaft, by + ny * shaft], [bx + nx * head, by + ny * head],
      [x2, y2],
      [bx - nx * head, by - ny * head], [bx - nx * shaft, by - ny * shaft], [sx - nx * shaft, sy - ny * shaft],
    ];
    return `<polygon points="${points.map((p) => p.map((n) => n.toFixed(3)).join(',')).join(' ')}"/>`;
  }

  function buildMoveList() {
    const r = review;
    const rows = [];
    for (const [i, move] of r.moves.entries()) {
      if (move.color === WHITE || i === 0) {
        const row = document.createElement('li');
        const number = document.createElement('span');
        number.className = 'move-number';
        number.textContent = move.number + '.';
        row.append(number);
        rows.push(row);
      }
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'move';
      cell.textContent = move.san;
      cell.addEventListener('click', () => show(i + 1));
      rows[rows.length - 1].append(cell);
      r.cells[i] = cell;
    }
    movesEl.replaceChildren(...rows);
  }

  // Brings everything up to date after move `changed` (or every move) has been analysed.
  function refresh(changed) {
    const r = review;
    const done = r.analysis.length, total = r.moves.length;
    progressEl.hidden = done >= total;
    progressEl.style.setProperty('--done', (done / total * 100).toFixed(1) + '%');
    progressEl.querySelector('span').textContent = `Analysing move ${Math.min(done + 1, total)} of ${total}…`;

    for (let i = changed ?? 0; i < (changed === undefined ? done : changed + 1); i++) {
      const v = verdict(i);
      r.cells[i].dataset.kind = v.kind;
      if (MARKED_KINDS.includes(v.kind)) r.cells[i].append(kindIcon(v.kind));
    }

    drawSummary();
    drawGraph();
    decorate();
  }

  function drawSummary() {
    const r = review;
    const first = r.flip ? 1 : 0;          // the player's column comes first
    const sides = [{ counts: {}, accuracy: [] }, { counts: {}, accuracy: [] }];
    for (let i = 0; i < r.analysis.length; i++) {
      const v = verdict(i), side = sides[r.moves[i].color === WHITE ? 0 : 1];
      side.counts[v.kind] = (side.counts[v.kind] || 0) + 1;
      side.accuracy.push(v.accuracy);
    }
    const ordered = [sides[first], sides[1 - first]];
    document.getElementById('review-first-side').textContent = r.firstName;
    document.getElementById('review-second-side').textContent = r.secondName;

    const row = (label, values, className) => {
      const tr = document.createElement('tr');
      if (className) tr.className = className;
      const th = document.createElement('th');
      th.append(...[].concat(label));
      tr.append(th, ...values.map((value) => {
        const td = document.createElement('td');
        td.textContent = value;
        return td;
      }));
      return tr;
    };
    const average = (list) => (list.length ? Math.round(list.reduce((a, b) => a + b, 0) / list.length) + '%' : '–');
    summaryEl.replaceChildren(
      row('Accuracy', ordered.map((side) => average(side.accuracy)), 'accuracy'),
      ...SUMMARY_KINDS.map((kind) => row(
        [kindIcon(kind), ' ' + KINDS[kind].label],
        ordered.map((side) => side.counts[kind] || 0),
        (ordered[0].counts[kind] || ordered[1].counts[kind]) ? '' : 'none',
      )),
    );
  }

  // White's chance of winning over the course of the game, with the bad moves marked.
  function drawGraph() {
    const r = review, total = r.moves.length;
    const points = [];
    for (let ply = 0; ply <= total; ply++) {
      const white = evalAt(ply);
      if (white === null) break;
      points.push([ply, 100 - winChance(white)]);
    }
    let area = '';
    if (points.length) {
      const last = points[points.length - 1][0];
      area = `<path class="graph-white" d="M0,100 ${points.map(([x, y]) => `L${x},${y.toFixed(2)}`).join(' ')} L${last},100 Z"/>`;
    }
    graphEl.innerHTML = `<svg viewBox="0 0 ${total} 100" preserveAspectRatio="none" aria-hidden="true">
      ${area}
      <line class="graph-middle" x1="0" y1="50" x2="${total}" y2="50"/>
      <line class="graph-cursor" x1="0" y1="0" x2="0" y2="100" transform="translate(${r.ply} 0)"/>
    </svg>`;
    for (let i = 0; i < r.analysis.length; i++) {
      const v = verdict(i);
      if (!MARKED_KINDS.includes(v.kind) || !points[i + 1]) continue;
      const dot = document.createElement('span');
      dot.className = 'graph-dot ' + v.kind;
      dot.style.left = ((i + 1) / total * 100) + '%';
      dot.style.top = points[i + 1][1] + '%';
      graphEl.append(dot);
    }
  }

  // ---------------------------------------------------------------------------
  // Controls
  // ---------------------------------------------------------------------------

  function step(where) {
    if (!review) return;
    const { ply, moves } = review;
    if (where === 'first') show(0);
    else if (where === 'prev') show(ply - 1);
    else if (where === 'next' && ply < moves.length) show(ply + 1, true);
    else if (where === 'last') show(moves.length);
  }

  panelEl.querySelector('.review-nav').addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (button) step(button.dataset.step);
  });

  graphEl.addEventListener('click', (event) => {
    if (!review) return;
    const box = graphEl.getBoundingClientRect();
    show(Math.round((event.clientX - box.left) / box.width * review.moves.length));
  });

  document.getElementById('review-close').addEventListener('click', close);

  const KEYS = { ArrowLeft: 'prev', ArrowRight: 'next', Home: 'first', End: 'last' };
  addEventListener('keydown', (event) => {
    if (!review || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'Escape') return close();
    if (!KEYS[event.key]) return;
    event.preventDefault();
    step(KEYS[event.key]);
  });

  root.Review = { open, close };
})(this);
