// Chaos mode: a five-minute game in which, every so often, each player drafts one of three
// modifiers (the way Clash Royale's chaos events hand out random twists). Most change the board
// (blasting, freezing, summoning or upgrading pieces); a few change the clocks or the turn order.
// Everything random is drawn from a seed shared by both players, so an online game plays out the
// same on both screens.
(function (root) {
  'use strict';

  const { Game, evaluate, squareName, WHITE, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING } = Chess;

  const CLOCK = { base: 5 * 60 * 1000, inc: 0 };
  // A round starts once the two players have used this much clock time between them.
  const ROUNDS = [0, 150 * 1000, 300 * 1000, 450 * 1000];
  const PICK_MS = 15 * 1000;        // how long a player has to pick
  const OFFERED = 3;
  const NAMES = ['', 'pawn', 'knight', 'bishop', 'rook', 'queen', 'king'];
  const VALUE = [0, 1, 3, 3, 5, 9, 0];

  // ---------------------------------------------------------------------------
  // Seeded random numbers (FNV-1a to hash the seed text, then mulberry32).
  // ---------------------------------------------------------------------------

  function hash(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function random(...parts) {
    let a = hash(parts.join(':'));
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffle(rand, list) {
    const out = list.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Board helpers. Square 0 is a8 and 63 is h1, so row 0 is the eighth rank.
  // ---------------------------------------------------------------------------

  const colorOf = (piece) => piece & 8;
  const typeOf = (piece) => piece & 7;
  // A square's rank counted from `color`'s own side: 1 is its back rank.
  const rankFor = (sq, color) => (color === WHITE ? 8 - (sq >> 3) : (sq >> 3) + 1);
  const describe = (piece, sq) => `${NAMES[typeOf(piece)]} on ${squareName(sq)}`;

  function squares(g, test) {
    const out = [];
    for (let sq = 0; sq < 64; sq++) if (test(g.board[sq], sq)) out.push(sq);
    return out;
  }

  function neighbours(sq) {
    const out = [], r = sq >> 3, c = sq & 7;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const nr = r + dr, nc = c + dc;
        if ((dr || dc) && nr >= 0 && nr < 8 && nc >= 0 && nc < 8) out.push(nr * 8 + nc);
      }
    }
    return out;
  }

  const pawnCanStand = (sq) => (sq >> 3) !== 0 && (sq >> 3) !== 7;

  // A position both sides can play on: one king each, no pawns on the first or last rank, and the
  // side that has just moved not left in check (or the side to move could take its king).
  function valid(g) {
    const kings = { 0: 0, 8: 0 };
    for (let sq = 0; sq < 64; sq++) {
      const piece = g.board[sq];
      if (typeOf(piece) === KING) {
        kings[colorOf(piece)]++;
        g.kingSq[colorOf(piece)] = sq;
      }
      if (typeOf(piece) === PAWN && !pawnCanStand(sq)) return false;
    }
    return kings[0] === 1 && kings[8] === 1 && !g.inCheck(g.turn ^ 8);
  }

  // Castling only stays possible while the king and that rook are still at home, and en passant
  // only while the pawn that just moved two squares is still there.
  function tidy(g) {
    for (const [bit, king, rook, color] of [[1, 60, 63, 0], [2, 60, 56, 0], [4, 4, 7, 8], [8, 4, 0, 8]]) {
      if (g.board[king] !== (color | KING) || g.board[rook] !== (color | ROOK)) g.castling &= ~bit;
    }
    if (g.ep !== -1) {
      const pawnSq = g.ep + (g.turn === WHITE ? 8 : -8);
      if (g.board[g.ep] || g.board[pawnSq] !== ((g.turn ^ 8) | PAWN)) g.ep = -1;
    }
  }

  // Makes a change to the board, and takes it back again if it would leave an impossible position.
  function attempt(g, change) {
    const saved = { board: g.board.slice(), kingSq: g.kingSq.slice(), castling: g.castling, ep: g.ep };
    change(g.board);
    tidy(g);
    if (valid(g)) {
      g.halfmove = 0;
      return true;
    }
    Object.assign(g, saved);
    return false;
  }

  // What happened, for the page to show and animate.
  const outcome = () => ({ text: '', destroyed: [], spawned: [], changed: [], moved: [], frozen: [], clock: {} });

  function destroy(c, o, sq) {
    const piece = c.g.board[sq];
    if (!attempt(c.g, (b) => { b[sq] = 0; })) return false;
    o.destroyed.push({ sq, piece });
    c.state.captured[colorOf(piece)].push(typeOf(piece));
    return true;
  }

  function place(c, o, sq, piece) {
    if (c.g.board[sq] || (typeOf(piece) === PAWN && !pawnCanStand(sq))) return false;
    if (!attempt(c.g, (b) => { b[sq] = piece; })) return false;
    o.spawned.push(sq);
    return true;
  }

  const theirs = (c, types) => squares(c.g, (p) => p && colorOf(p) === c.them && types.includes(typeOf(p)));
  const mine = (c, types) => squares(c.g, (p) => p && colorOf(p) === c.me && types.includes(typeOf(p)));
  const empty = (c, test) => squares(c.g, (p, sq) => !p && test(sq));

  function list(parts) {
    if (parts.length < 2) return parts.join('');
    return parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];
  }

  // Destroys the first of `targets` that can go; returns the text for it.
  function blastOne(c, o, targets, verb) {
    for (const sq of targets) {
      const name = describe(c.g.board[sq], sq);
      if (destroy(c, o, sq)) return `${verb} the ${name}`;
    }
    return 'found nothing to hit';
  }

  // ---------------------------------------------------------------------------
  // The modifiers. `apply(c)` gets { g, me, them, rand, state, clockLeft } and returns an outcome;
  // `kind` says what it touches, which is how the computer weighs it up.
  // ---------------------------------------------------------------------------

  const MODIFIERS = [
    {
      id: 'fireball', icon: '🔥', name: 'Fireball', kind: 'board',
      text: 'Blasts a random enemy knight or bishop (or a pawn, if they have none).',
      apply(c) {
        const o = outcome();
        const minor = shuffle(c.rand, theirs(c, [KNIGHT, BISHOP]));
        o.text = blastOne(c, o, minor.concat(shuffle(c.rand, theirs(c, [PAWN]))), 'blasted');
        return o;
      },
    },
    {
      id: 'rocket', icon: '🚀', name: 'Rocket', kind: 'board',
      text: 'Destroys an enemy rook (or, without one, their strongest piece short of the queen).',
      apply(c) {
        const o = outcome();
        const targets = [ROOK, BISHOP, KNIGHT, PAWN].flatMap((type) => shuffle(c.rand, theirs(c, [type])));
        o.text = blastOne(c, o, targets, 'destroyed');
        return o;
      },
    },
    {
      id: 'lightning', icon: '⚡', name: 'Lightning', kind: 'board',
      text: 'Zaps the enemy’s three strongest pieces down a step: queen → rook → bishop → knight → pawn.',
      apply(c) {
        const o = outcome(), hit = [];
        const targets = shuffle(c.rand, theirs(c, [KNIGHT, BISHOP, ROOK, QUEEN]))
          .sort((a, b) => VALUE[typeOf(c.g.board[b])] - VALUE[typeOf(c.g.board[a])]);
        for (const sq of targets) {
          if (hit.length === 3) break;
          const piece = c.g.board[sq], down = typeOf(piece) - 1;
          if (down === PAWN && !pawnCanStand(sq)) continue;
          if (attempt(c.g, (b) => { b[sq] = c.them | down; })) {
            hit.push(`${NAMES[typeOf(piece)]} on ${squareName(sq)}`);
            o.changed.push(sq);
          }
        }
        o.text = hit.length ? `zapped the ${list(hit)}` : 'found nothing to zap';
        return o;
      },
    },
    {
      id: 'log', icon: '🪵', name: 'The Log', kind: 'board',
      text: 'Rolls along the enemy’s most crowded pawn rank and knocks out up to three pawns.',
      apply(c) {
        const o = outcome();
        const pawns = shuffle(c.rand, theirs(c, [PAWN]));
        const byRow = new Map();
        for (const sq of pawns) byRow.set(sq >> 3, [...(byRow.get(sq >> 3) || []), sq]);
        const row = [...byRow.values()].sort((a, b) => b.length - a.length)[0] || [];
        const hit = [];
        for (const sq of row.slice(0, 3)) if (destroy(c, o, sq)) hit.push(squareName(sq));
        o.text = hit.length ? `flattened the ${hit.length === 1 ? 'pawn' : 'pawns'} on ${list(hit)}` : 'rolled past nothing';
        return o;
      },
    },
    {
      id: 'freeze', icon: '❄️', name: 'Freeze', kind: 'rule', worth: 110,
      text: 'Freezes two enemy pieces (never the king) so they can’t move for their next two turns.',
      apply(c) {
        const o = outcome();
        const already = new Set(c.state.frozen.map((f) => f.sq));
        const targets = shuffle(c.rand, theirs(c, [QUEEN, ROOK, BISHOP, KNIGHT]))
          .concat(shuffle(c.rand, theirs(c, [PAWN]))).filter((sq) => !already.has(sq)).slice(0, 2);
        for (const sq of targets) {
          c.state.frozen.push({ sq, color: c.them, turns: 2 });
          o.frozen.push(sq);
        }
        o.text = targets.length ? `froze the ${list(targets.map((sq) => describe(c.g.board[sq], sq)))}` : 'found nothing to freeze';
        return o;
      },
    },
    {
      id: 'rage', icon: '😡', name: 'Rage', kind: 'rule', worth: 160,
      text: 'On your next turn you move twice in a row (unless your first move gives check).',
      apply(c) {
        const o = outcome();
        c.state.rage[c.me] = true;
        o.text = 'will move twice next turn';
        return o;
      },
    },
    {
      id: 'elixir', icon: '💧', name: 'Elixir Collector', kind: 'clock', worth: 80,
      text: 'Adds 60 seconds to your clock.',
      apply(c) {
        const o = outcome();
        o.clock[c.me] = 60 * 1000;
        o.text = 'added 60 seconds to the clock';
        return o;
      },
    },
    {
      id: 'poison', icon: '☠️', name: 'Poison', kind: 'clock', worth: 70,
      text: 'Drains 45 seconds from the enemy’s clock (it never takes them below 10 seconds).',
      apply(c) {
        const o = outcome();
        const drain = Math.min(45 * 1000, Math.max(0, c.clockLeft(c.them) - 10 * 1000));
        o.clock[c.them] = -drain;
        o.text = drain ? `drained ${Math.round(drain / 1000)} seconds from the enemy clock` : 'could not drain any more time';
        return o;
      },
    },
    {
      id: 'graveyard', icon: '🪦', name: 'Graveyard', kind: 'board',
      text: 'Your strongest lost piece rises again on your half of the board (a skeleton pawn if you’ve lost nothing).',
      apply(c) {
        const o = outcome();
        const lost = c.state.captured[c.me].slice().sort((a, b) => VALUE[b] - VALUE[a]);
        const type = lost[0] || PAWN;
        const spots = shuffle(c.rand, empty(c, (sq) => rankFor(sq, c.me) <= 4));
        const sq = spots.find((s) => place(c, o, s, c.me | type));
        if (sq === undefined) {
          o.text = 'found no room to rise';
        } else {
          if (lost.length) c.state.captured[c.me].splice(c.state.captured[c.me].indexOf(type), 1);
          o.text = `raised a ${NAMES[type]} on ${squareName(sq)}`;
        }
        return o;
      },
    },
    {
      id: 'skeletons', icon: '💀', name: 'Skeleton Army', kind: 'board',
      text: 'Four skeleton pawns pop up on empty squares of your second and third ranks.',
      apply(c) {
        const o = outcome();
        for (const sq of shuffle(c.rand, empty(c, (s) => [2, 3].includes(rankFor(s, c.me))))) {
          if (o.spawned.length === 4) break;
          place(c, o, sq, c.me | PAWN);
        }
        o.text = o.spawned.length ? `raised ${o.spawned.length} skeleton ${o.spawned.length === 1 ? 'pawn' : 'pawns'}` : 'found no room';
        return o;
      },
    },
    {
      id: 'goblins', icon: '🛢️', name: 'Goblin Barrel', kind: 'board',
      text: 'Three goblin pawns land on empty squares deep in enemy territory (your fifth and sixth ranks).',
      apply(c) {
        const o = outcome();
        for (const sq of shuffle(c.rand, empty(c, (s) => [5, 6].includes(rankFor(s, c.me))))) {
          if (o.spawned.length === 3) break;
          place(c, o, sq, c.me | PAWN);
        }
        o.text = o.spawned.length ? `landed goblins on ${list(o.spawned.map(squareName))}` : 'found nowhere to land';
        return o;
      },
    },
    {
      id: 'megaknight', icon: '🐴', name: 'Mega Knight', kind: 'board',
      text: 'A knight crashes onto an empty central square and knocks out every enemy pawn next to it.',
      apply(c) {
        const o = outcome();
        const centre = empty(c, (sq) => (sq >> 3) >= 2 && (sq >> 3) <= 5 && (sq & 7) >= 2 && (sq & 7) <= 5);
        for (const sq of shuffle(c.rand, centre)) {
          const crushed = neighbours(sq).filter((n) => c.g.board[n] === (c.them | PAWN));
          const ok = attempt(c.g, (b) => {
            b[sq] = c.me | KNIGHT;
            for (const n of crushed) b[n] = 0;
          });
          if (!ok) continue;
          o.spawned.push(sq);
          for (const n of crushed) {
            o.destroyed.push({ sq: n, piece: c.them | PAWN });
            c.state.captured[c.them].push(PAWN);
          }
          o.text = `crashed down on ${squareName(sq)}` + (crushed.length ? `, crushing ${crushed.length} ${crushed.length === 1 ? 'pawn' : 'pawns'}` : '');
          return o;
        }
        o.text = 'found nowhere to land';
        return o;
      },
    },
    {
      id: 'evolution', icon: '🧬', name: 'Evolution', kind: 'board',
      text: 'Two of your pieces evolve a step: pawn → knight → bishop → rook → queen.',
      apply(c) {
        const o = outcome(), done = [];
        for (const sq of shuffle(c.rand, mine(c, [PAWN, KNIGHT, BISHOP, ROOK]))) {
          if (done.length === 2) break;
          const type = typeOf(c.g.board[sq]);
          if (attempt(c.g, (b) => { b[sq] = c.me | (type + 1); })) {
            done.push(`${NAMES[type]} on ${squareName(sq)} into a ${NAMES[type + 1]}`);
            o.changed.push(sq);
          }
        }
        o.text = done.length ? `evolved the ${list(done)}` : 'had nothing to evolve';
        return o;
      },
    },
    {
      id: 'tornado', icon: '🌪️', name: 'Tornado', kind: 'board',
      text: 'Drags up to three enemy pieces one square towards the middle of the board.',
      apply(c) {
        const o = outcome();
        for (const from of shuffle(c.rand, theirs(c, [PAWN, KNIGHT, BISHOP, ROOK, QUEEN]))) {
          if (o.moved.length === 3) break;
          const r = from >> 3, col = from & 7;
          const to = (r + (r < 4 ? 1 : -1)) * 8 + col + (col < 4 ? 1 : -1);
          if (c.g.board[to]) continue;
          const piece = c.g.board[from];
          if (attempt(c.g, (b) => { b[to] = piece; b[from] = 0; })) o.moved.push({ from, to });
        }
        o.text = o.moved.length ? `dragged ${o.moved.length} enemy ${o.moved.length === 1 ? 'piece' : 'pieces'} inwards` : 'blew past nothing';
        return o;
      },
    },
    {
      id: 'clone', icon: '🧪', name: 'Clone', kind: 'board',
      text: 'Copies one of your knights or bishops onto an empty square next to it (a pawn, if you have none).',
      apply(c) {
        const o = outcome();
        const sources = shuffle(c.rand, mine(c, [KNIGHT, BISHOP])).concat(shuffle(c.rand, mine(c, [PAWN])));
        for (const from of sources) {
          const piece = c.g.board[from];
          const sq = shuffle(c.rand, neighbours(from)).find((n) => place(c, o, n, piece));
          if (sq !== undefined) {
            o.text = `cloned the ${describe(piece, from)} onto ${squareName(sq)}`;
            return o;
          }
        }
        o.text = 'had nothing to clone';
        return o;
      },
    },
    {
      id: 'earthquake', icon: '🌋', name: 'Earthquake', kind: 'board',
      text: 'Shakes the centre: every pawn on the d- and e-files is destroyed, yours included.',
      apply(c) {
        const o = outcome();
        const pawns = squares(c.g, (p, sq) => typeOf(p) === PAWN && ((sq & 7) === 3 || (sq & 7) === 4));
        for (const sq of pawns) destroy(c, o, sq);
        o.text = o.destroyed.length ? `destroyed ${o.destroyed.length} centre ${o.destroyed.length === 1 ? 'pawn' : 'pawns'}` : 'shook an empty centre';
        return o;
      },
    },
    {
      id: 'mirror', icon: '🪞', name: 'Mirror', kind: 'rule', worth: 90,
      text: 'Copies whatever your opponent picks this round. (Both picking it gets you 30 seconds each.)',
    },
  ];

  const BY_ID = new Map(MODIFIERS.map((m) => [m.id, m]));

  // The three modifiers `color` is offered in a round.
  function offers(seed, round, color) {
    return shuffle(random(seed, 'offer', round, color), MODIFIERS.map((m) => m.id)).slice(0, OFFERED);
  }

  // Chaos bookkeeping that lives alongside the game: frozen pieces, a pending double move, and the
  // pieces each side has lost (for the Graveyard).
  function newState() {
    return { frozen: [], rage: { 0: false, 8: false }, captured: { 0: [], 8: [] } };
  }

  // What a pick turns into: Mirror becomes the opponent's pick.
  function effective(picks, color) {
    const id = picks[color];
    if (id !== 'mirror') return id;
    return picks[color ^ 8] === 'mirror' ? 'mirror-both' : picks[color ^ 8];
  }

  const BOTH_MIRRORS = {
    id: 'mirror-both', icon: '🪞', name: 'Mirror', kind: 'clock',
    apply(c) {
      const o = outcome();
      o.clock[c.me] = 30 * 1000;
      o.text = 'reflected a Mirror, and got 30 seconds';
      return o;
    },
  };

  // Applies `color`'s pick for a round to the game. Returns what happened; the page applies the
  // clock changes (outcome.clock, in milliseconds per color) itself.
  function apply(g, { seed, round, picks, color, state, clockLeft }) {
    const id = effective(picks, color);
    const modifier = id === 'mirror-both' ? BOTH_MIRRORS : BY_ID.get(id);
    const c = { g, me: color, them: color ^ 8, rand: random(seed, 'apply', round, color, id), state, clockLeft };
    const o = modifier.apply(c);
    o.color = color;
    o.pick = BY_ID.get(picks[color]);
    o.modifier = modifier;
    o.mirrored = picks[color] === 'mirror';
    return o;
  }

  // The computer's pick: it tries each board modifier on a copy of the game and scores the result;
  // the others get a rough fixed worth. Weaker computers judge more loosely (`noise` in centipawns).
  function choose(g, { seed, round, offered, color, state, clockLeft, noise = 0 }) {
    const own = (position) => evaluate(position) * (position.turn === color ? 1 : -1);
    const before = own(g);
    let bestId = offered[0], bestScore = -Infinity;
    for (const id of offered) {
      const modifier = BY_ID.get(id);
      let score = modifier.worth || 0;
      if (modifier.kind === 'board') {
        const copy = Game.restore(g.snapshot());
        const scratch = JSON.parse(JSON.stringify(state));
        apply(copy, { seed, round, picks: { [color]: id, [color ^ 8]: 'elixir' }, color, state: scratch, clockLeft });
        score = own(copy) - before;
      }
      score += (Math.random() - 0.5) * 2 * noise;
      if (score > bestScore) [bestId, bestScore] = [id, score];
    }
    return bestId;
  }

  root.Chaos = { CLOCK, ROUNDS, PICK_MS, MODIFIERS, find: (id) => BY_ID.get(id) || null, offers, newState, apply, choose };
})(this);
