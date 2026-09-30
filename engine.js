// Chess rules + computer opponent. Works in the browser (globals) and in Node (module.exports).
(function (root) {
  'use strict';

  // Everything the engine needs lives inside this one function, so its source can also run in a worker.
  function chessEngine() {
    'use strict';

    // A piece is color | type; an empty square is 0.
    const WHITE = 0, BLACK = 8;
    const PAWN = 1, KNIGHT = 2, BISHOP = 3, ROOK = 4, QUEEN = 5, KING = 6;
    const F_EP = 1, F_CASTLE = 2, F_DOUBLE = 4;
    const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const FEN_PIECES = { p: PAWN, n: KNIGHT, b: BISHOP, r: ROOK, q: QUEEN, k: KING };

    // Squares are 0..63 with 0 = a8 and 63 = h1, so white pawns move towards row 0.
    const KNIGHT_STEPS = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
    const KING_STEPS = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
    const DIAGONALS = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
    const STRAIGHTS = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    const PROMOTIONS = [QUEEN, ROOK, BISHOP, KNIGHT];

    // Castling rights: 1 = white king side, 2 = white queen side, 4 = black king side, 8 = black queen side.
    // Any move from or to a king/rook home square clears the matching rights.
    const CASTLE_MASK = new Array(64).fill(15);
    CASTLE_MASK[60] = 12; CASTLE_MASK[63] = 14; CASTLE_MASK[56] = 13;
    CASTLE_MASK[4] = 3; CASTLE_MASK[7] = 11; CASTLE_MASK[0] = 7;

    function squareIndex(name) {
      return (8 - Number(name[1])) * 8 + (name.charCodeAt(0) - 97);
    }

    function squareName(sq) {
      return String.fromCharCode(97 + (sq & 7)) + (8 - (sq >> 3));
    }

    class Game {
      constructor(fen) {
        this.load(fen || START_FEN);
      }

      load(fen) {
        const parts = fen.trim().split(/\s+/);
        this.board = new Array(64).fill(0);
        this.kingSq = [];
        let sq = 0;
        for (const ch of parts[0]) {
          if (ch === '/') continue;
          if (ch >= '1' && ch <= '8') { sq += Number(ch); continue; }
          const lower = ch.toLowerCase();
          const color = ch === lower ? BLACK : WHITE;
          if (lower === 'k') this.kingSq[color] = sq;
          this.board[sq++] = color | FEN_PIECES[lower];
        }
        this.turn = parts[1] === 'b' ? BLACK : WHITE;
        const rights = parts[2] || '-';
        this.castling = (rights.includes('K') ? 1 : 0) | (rights.includes('Q') ? 2 : 0) |
          (rights.includes('k') ? 4 : 0) | (rights.includes('q') ? 8 : 0);
        this.ep = parts[3] && parts[3] !== '-' ? squareIndex(parts[3]) : -1;
        this.halfmove = Number(parts[4]) || 0;
        this.fullmove = Number(parts[5]) || 1;
        this.undoStack = [];
      }

      // Identifies a position for the threefold repetition rule.
      key() {
        return this.board.join(',') + '|' + this.turn + '|' + this.castling + '|' + this.ep;
      }

      attacked(sq, by) {
        const b = this.board, r = sq >> 3, c = sq & 7;
        const pawnRow = by === WHITE ? r + 1 : r - 1;
        if (pawnRow >= 0 && pawnRow < 8) {
          if (c > 0 && b[pawnRow * 8 + c - 1] === (by | PAWN)) return true;
          if (c < 7 && b[pawnRow * 8 + c + 1] === (by | PAWN)) return true;
        }
        for (const [dr, dc] of KNIGHT_STEPS) {
          const nr = r + dr, nc = c + dc;
          if (nr >= 0 && nr < 8 && nc >= 0 && nc < 8 && b[nr * 8 + nc] === (by | KNIGHT)) return true;
        }
        for (const [dr, dc] of KING_STEPS) {
          const nr = r + dr, nc = c + dc;
          if (nr >= 0 && nr < 8 && nc >= 0 && nc < 8 && b[nr * 8 + nc] === (by | KING)) return true;
        }
        for (const [dr, dc] of DIAGONALS) {
          let nr = r + dr, nc = c + dc;
          while (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) {
            const p = b[nr * 8 + nc];
            if (p) {
              if (p === (by | BISHOP) || p === (by | QUEEN)) return true;
              break;
            }
            nr += dr; nc += dc;
          }
        }
        for (const [dr, dc] of STRAIGHTS) {
          let nr = r + dr, nc = c + dc;
          while (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) {
            const p = b[nr * 8 + nc];
            if (p) {
              if (p === (by | ROOK) || p === (by | QUEEN)) return true;
              break;
            }
            nr += dr; nc += dc;
          }
        }
        return false;
      }

      inCheck(color = this.turn) {
        return this.attacked(this.kingSq[color], color ^ 8);
      }

      // Moves that follow piece movement rules but may leave the mover's king in check.
      // With capturesOnly, returns just captures and queen promotions (used by the search).
      pseudoMoves(capturesOnly) {
        const b = this.board, us = this.turn, them = us ^ 8;
        const moves = [];
        const add = (from, to, piece, captured, promo, flags) => {
          moves.push({ from, to, piece, captured, promo, flags });
        };

        for (let sq = 0; sq < 64; sq++) {
          const piece = b[sq];
          if (!piece || (piece & 8) !== us) continue;
          const r = sq >> 3, c = sq & 7, type = piece & 7;

          if (type === PAWN) {
            const dir = us === WHITE ? -1 : 1;
            const startRow = us === WHITE ? 6 : 1, promoRow = us === WHITE ? 0 : 7;
            const nr = r + dir;
            const addPawnMove = (to, captured) => {
              if (nr === promoRow) {
                for (const promo of capturesOnly ? [QUEEN] : PROMOTIONS) add(sq, to, piece, captured, promo, 0);
              } else {
                add(sq, to, piece, captured, 0, 0);
              }
            };
            const ahead = nr * 8 + c;
            if (b[ahead] === 0) {
              if (nr === promoRow) {
                addPawnMove(ahead, 0);
              } else if (!capturesOnly) {
                add(sq, ahead, piece, 0, 0, 0);
                if (r === startRow && b[ahead + dir * 8] === 0) add(sq, ahead + dir * 8, piece, 0, 0, F_DOUBLE);
              }
            }
            for (const dc of [-1, 1]) {
              const nc = c + dc;
              if (nc < 0 || nc > 7) continue;
              const to = nr * 8 + nc, target = b[to];
              if (target && (target & 8) === them) addPawnMove(to, target);
              else if (to === this.ep) add(sq, to, piece, them | PAWN, 0, F_EP);
            }
          } else if (type === KNIGHT || type === KING) {
            for (const [dr, dc] of type === KNIGHT ? KNIGHT_STEPS : KING_STEPS) {
              const nr = r + dr, nc = c + dc;
              if (nr < 0 || nr > 7 || nc < 0 || nc > 7) continue;
              const to = nr * 8 + nc, target = b[to];
              if (target === 0) {
                if (!capturesOnly) add(sq, to, piece, 0, 0, 0);
              } else if ((target & 8) === them) {
                add(sq, to, piece, target, 0, 0);
              }
            }
          } else {
            const dirs = type === BISHOP ? DIAGONALS : type === ROOK ? STRAIGHTS : KING_STEPS;
            for (const [dr, dc] of dirs) {
              let nr = r + dr, nc = c + dc;
              while (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) {
                const to = nr * 8 + nc, target = b[to];
                if (target === 0) {
                  if (!capturesOnly) add(sq, to, piece, 0, 0, 0);
                } else {
                  if ((target & 8) === them) add(sq, to, piece, target, 0, 0);
                  break;
                }
                nr += dr; nc += dc;
              }
            }
          }
        }

        if (!capturesOnly) {
          const home = us === WHITE ? 60 : 4;
          const kingSide = us === WHITE ? 1 : 4, queenSide = us === WHITE ? 2 : 8;
          if (this.kingSq[us] === home && (this.castling & (kingSide | queenSide)) && !this.attacked(home, them)) {
            if ((this.castling & kingSide) && b[home + 1] === 0 && b[home + 2] === 0 && b[home + 3] === (us | ROOK) &&
                !this.attacked(home + 1, them) && !this.attacked(home + 2, them)) {
              add(home, home + 2, us | KING, 0, 0, F_CASTLE);
            }
            if ((this.castling & queenSide) && b[home - 1] === 0 && b[home - 2] === 0 && b[home - 3] === 0 &&
                b[home - 4] === (us | ROOK) && !this.attacked(home - 1, them) && !this.attacked(home - 2, them)) {
              add(home, home - 2, us | KING, 0, 0, F_CASTLE);
            }
          }
        }
        return moves;
      }

      legalMoves() {
        const us = this.turn;
        return this.pseudoMoves(false).filter((m) => {
          this.make(m);
          const ok = !this.inCheck(us);
          this.undo(m);
          return ok;
        });
      }

      make(m) {
        const b = this.board, us = this.turn;
        this.undoStack.push(this.castling, this.ep, this.halfmove);
        b[m.from] = 0;
        b[m.to] = m.promo ? us | m.promo : m.piece;
        if (m.flags & F_EP) {
          b[m.to + (us === WHITE ? 8 : -8)] = 0;
        } else if (m.flags & F_CASTLE) {
          if (m.to > m.from) { b[m.to + 1] = 0; b[m.to - 1] = us | ROOK; }
          else { b[m.to - 2] = 0; b[m.to + 1] = us | ROOK; }
        }
        if ((m.piece & 7) === KING) this.kingSq[us] = m.to;
        this.castling &= CASTLE_MASK[m.from] & CASTLE_MASK[m.to];
        this.ep = m.flags & F_DOUBLE ? (m.from + m.to) >> 1 : -1;
        this.halfmove = (m.piece & 7) === PAWN || m.captured ? 0 : this.halfmove + 1;
        if (us === BLACK) this.fullmove++;
        this.turn = us ^ 8;
      }

      undo(m) {
        const b = this.board, us = this.turn ^ 8;
        this.turn = us;
        if (us === BLACK) this.fullmove--;
        this.halfmove = this.undoStack.pop();
        this.ep = this.undoStack.pop();
        this.castling = this.undoStack.pop();
        b[m.from] = m.piece;
        if (m.flags & F_EP) {
          b[m.to] = 0;
          b[m.to + (us === WHITE ? 8 : -8)] = m.captured;
        } else {
          b[m.to] = m.captured;
          if (m.flags & F_CASTLE) {
            if (m.to > m.from) { b[m.to + 1] = us | ROOK; b[m.to - 1] = 0; }
            else { b[m.to - 2] = us | ROOK; b[m.to + 1] = 0; }
          }
        }
        if ((m.piece & 7) === KING) this.kingSq[us] = m.from;
      }

      // True when neither side can possibly checkmate: bare kings, a single minor piece,
      // or only bishops that all stand on the same square color.
      insufficientMaterial() {
        let knights = 0, lightBishops = 0, darkBishops = 0;
        for (let sq = 0; sq < 64; sq++) {
          const type = this.board[sq] & 7;
          if (type === PAWN || type === ROOK || type === QUEEN) return false;
          if (type === KNIGHT) knights++;
          else if (type === BISHOP) {
            if (((sq >> 3) + (sq & 7)) % 2 === 0) lightBishops++; else darkBishops++;
          }
        }
        if (knights === 0) return lightBishops === 0 || darkBishops === 0;
        return knights === 1 && lightBishops + darkBishops === 0;
      }

      // Plain-data copy of the position, for handing to the worker.
      snapshot() {
        return {
          board: this.board.slice(), kingSq: this.kingSq.slice(), turn: this.turn, castling: this.castling,
          ep: this.ep, halfmove: this.halfmove, fullmove: this.fullmove,
        };
      }

      static restore(state) {
        return Object.assign(new Game(), state);
      }

      perft(depth) {
        if (depth === 0) return 1;
        let nodes = 0;
        for (const m of this.legalMoves()) {
          this.make(m);
          nodes += this.perft(depth - 1);
          this.undo(m);
        }
        return nodes;
      }
    }

    // ---------------------------------------------------------------------------
    // Computer opponent: alpha-beta search over a material + piece-square evaluation.
    // ---------------------------------------------------------------------------

    const VALUE = [0, 100, 320, 330, 500, 900, 0];
    const MATE = 100000, INF = 1000000;

    // Piece-square tables from white's point of view (index 0 = a8). Black mirrors them with sq ^ 56.
    const PST = [];
    PST[PAWN] = [
      0, 0, 0, 0, 0, 0, 0, 0,
      50, 50, 50, 50, 50, 50, 50, 50,
      10, 10, 20, 30, 30, 20, 10, 10,
      5, 5, 10, 25, 25, 10, 5, 5,
      0, 0, 0, 20, 20, 0, 0, 0,
      5, -5, -10, 0, 0, -10, -5, 5,
      5, 10, 10, -20, -20, 10, 10, 5,
      0, 0, 0, 0, 0, 0, 0, 0,
    ];
    PST[KNIGHT] = [
      -50, -40, -30, -30, -30, -30, -40, -50,
      -40, -20, 0, 0, 0, 0, -20, -40,
      -30, 0, 10, 15, 15, 10, 0, -30,
      -30, 5, 15, 20, 20, 15, 5, -30,
      -30, 0, 15, 20, 20, 15, 0, -30,
      -30, 5, 10, 15, 15, 10, 5, -30,
      -40, -20, 0, 5, 5, 0, -20, -40,
      -50, -40, -30, -30, -30, -30, -40, -50,
    ];
    PST[BISHOP] = [
      -20, -10, -10, -10, -10, -10, -10, -20,
      -10, 0, 0, 0, 0, 0, 0, -10,
      -10, 0, 5, 10, 10, 5, 0, -10,
      -10, 5, 5, 10, 10, 5, 5, -10,
      -10, 0, 10, 10, 10, 10, 0, -10,
      -10, 10, 10, 10, 10, 10, 10, -10,
      -10, 5, 0, 0, 0, 0, 5, -10,
      -20, -10, -10, -10, -10, -10, -10, -20,
    ];
    PST[ROOK] = [
      0, 0, 0, 0, 0, 0, 0, 0,
      5, 10, 10, 10, 10, 10, 10, 5,
      -5, 0, 0, 0, 0, 0, 0, -5,
      -5, 0, 0, 0, 0, 0, 0, -5,
      -5, 0, 0, 0, 0, 0, 0, -5,
      -5, 0, 0, 0, 0, 0, 0, -5,
      -5, 0, 0, 0, 0, 0, 0, -5,
      0, 0, 0, 5, 5, 0, 0, 0,
    ];
    PST[QUEEN] = [
      -20, -10, -10, -5, -5, -10, -10, -20,
      -10, 0, 0, 0, 0, 0, 0, -10,
      -10, 0, 5, 5, 5, 5, 0, -10,
      -5, 0, 5, 5, 5, 5, 0, -5,
      0, 0, 5, 5, 5, 5, 0, -5,
      -10, 5, 5, 5, 5, 5, 0, -10,
      -10, 0, 5, 0, 0, 0, 0, -10,
      -20, -10, -10, -5, -5, -10, -10, -20,
    ];
    const KING_MIDDLE = [
      -30, -40, -40, -50, -50, -40, -40, -30,
      -30, -40, -40, -50, -50, -40, -40, -30,
      -30, -40, -40, -50, -50, -40, -40, -30,
      -30, -40, -40, -50, -50, -40, -40, -30,
      -20, -30, -30, -40, -40, -30, -30, -20,
      -10, -20, -20, -20, -20, -20, -20, -10,
      20, 20, 0, 0, 0, 0, 20, 20,
      20, 30, 10, 0, 0, 10, 30, 20,
    ];
    const KING_END = [
      -50, -40, -30, -20, -20, -30, -40, -50,
      -30, -20, -10, 0, 0, -10, -20, -30,
      -30, -10, 20, 30, 30, 20, -10, -30,
      -30, -10, 30, 40, 40, 30, -10, -30,
      -30, -10, 30, 40, 40, 30, -10, -30,
      -30, -10, 20, 30, 30, 20, -10, -30,
      -30, -30, 0, 0, 0, 0, -30, -30,
      -50, -30, -30, -30, -30, -30, -30, -50,
    ];

    // Score in centipawns from the point of view of the side to move.
    function evaluate(g) {
      const b = g.board;
      let score = 0, whiteMaterial = 0, blackMaterial = 0, nonPawnMaterial = 0;
      for (let sq = 0; sq < 64; sq++) {
        const piece = b[sq];
        if (!piece) continue;
        const type = piece & 7;
        if (type === KING) continue;
        if (type !== PAWN) nonPawnMaterial += VALUE[type];
        if ((piece & 8) === WHITE) {
          whiteMaterial += VALUE[type];
          score += VALUE[type] + PST[type][sq];
        } else {
          blackMaterial += VALUE[type];
          score -= VALUE[type] + PST[type][sq ^ 56];
        }
      }

      const wk = g.kingSq[WHITE], bk = g.kingSq[BLACK];
      const endgame = nonPawnMaterial <= 2600;
      const kingTable = endgame ? KING_END : KING_MIDDLE;
      score += kingTable[wk] - kingTable[bk ^ 56];

      // When far ahead in an endgame, push the losing king to the edge and bring the kings together
      // so the search can find the mate.
      const lead = whiteMaterial - blackMaterial;
      if (endgame && Math.abs(lead) >= 400) {
        const loser = lead > 0 ? bk : wk;
        const lr = loser >> 3, lc = loser & 7;
        const fromCenter = Math.max(3 - lr, lr - 4) + Math.max(3 - lc, lc - 4);
        const kingGap = Math.abs((wk >> 3) - (bk >> 3)) + Math.abs((wk & 7) - (bk & 7));
        const bonus = 10 * fromCenter + 4 * (14 - kingGap);
        score += lead > 0 ? bonus : -bonus;
      }
      return g.turn === WHITE ? score : -score;
    }

    // Most valuable victim / least valuable attacker first, then promotions, then quiet moves.
    function orderMoves(moves) {
      for (const m of moves) {
        m.order = m.captured ? 10000 + 10 * VALUE[m.captured & 7] - VALUE[m.piece & 7] : m.promo ? 9000 : 0;
      }
      return moves.sort((a, b) => b.order - a.order);
    }

    function outOfTime(ctx) {
      if ((++ctx.nodes & 1023) === 0 && Date.now() > ctx.deadline) ctx.stop = true;
      return ctx.stop;
    }

    // Keeps searching captures at the leaves so the evaluation is not taken mid-exchange.
    function quiesce(g, alpha, beta, ctx) {
      if (outOfTime(ctx)) return 0;
      const standPat = evaluate(g);
      if (standPat >= beta) return beta;
      if (standPat > alpha) alpha = standPat;
      const us = g.turn;
      for (const m of orderMoves(g.pseudoMoves(true))) {
        g.make(m);
        if (g.inCheck(us)) { g.undo(m); continue; }
        const score = -quiesce(g, -beta, -alpha, ctx);
        g.undo(m);
        if (ctx.stop) return 0;
        if (score >= beta) return beta;
        if (score > alpha) alpha = score;
      }
      return alpha;
    }

    function negamax(g, depth, alpha, beta, ply, ctx) {
      if (g.halfmove >= 100) return 0;
      const us = g.turn;
      const inCheck = g.inCheck(us);
      if (inCheck && ply < 12) depth++;
      if (depth <= 0) return quiesce(g, alpha, beta, ctx);
      if (outOfTime(ctx)) return 0;

      let legal = 0;
      for (const m of orderMoves(g.pseudoMoves(false))) {
        g.make(m);
        if (g.inCheck(us)) { g.undo(m); continue; }
        legal++;
        const score = -negamax(g, depth - 1, -beta, -alpha, ply + 1, ctx);
        g.undo(m);
        if (ctx.stop) return 0;
        if (score >= beta) return beta;
        if (score > alpha) alpha = score;
      }
      if (!legal) return inCheck ? -MATE + ply : 0;
      return alpha;
    }

    // Scores every root move. `seen` maps position keys to how often they have occurred in the game,
    // so the computer treats a third repetition as the draw it is. With `exact`, every move gets its
    // true score (needed when noise is added); otherwise worse moves only get an upper bound.
    function searchRoot(g, moves, depth, ctx, seen, exact) {
      let alpha = -INF;
      const scored = [];
      for (const move of moves) {
        g.make(move);
        const repeats = seen ? seen.get(g.key()) || 0 : 0;
        let score = 0;
        if (repeats < 2) {
          score = -negamax(g, depth - 1, -INF, exact ? INF : -alpha, 1, ctx);
          if (repeats === 1) score = Math.trunc(score / 2);
        }
        g.undo(move);
        if (ctx.stop) return null;
        scored.push({ move, score });
        if (score > alpha) alpha = score;
      }
      return scored;
    }

    function best(scored) {
      return scored.reduce((a, b) => (b.score > a.score ? b : a));
    }

    function shuffle(list) {
      for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
      }
      return list;
    }

    const MIN_RATING = 400, MAX_RATING = 2400;

    // How the computer plays at a given rating. The ratings are rough labels rather than measured
    // strengths: weaker settings look less far ahead, misjudge positions (random noise added to
    // each move's score) and now and then play a move at random; stronger ones search properly,
    // for longer the higher they go.
    function playingStyle(rating) {
      const r = Math.min(MAX_RATING, Math.max(MIN_RATING, Number(rating) || 1200));
      return {
        randomMove: r < 1400 ? 0.45 * (1400 - r) / 1000 : 0,
        noise: r < 1700 ? (1900 - r) * 0.2 : 0,
        depth: r < 900 ? 1 : r < 1300 ? 2 : 3,
        // At 1700 and above: iterative deepening for this long.
        thinkMs: r >= 1700 ? 300 + (r - 1700) * 3 : 0,
      };
    }

    function chooseMove(g, rating, seen) {
      // Shuffled first so that equally good moves are not always played in the same order.
      const moves = orderMoves(shuffle(g.legalMoves()));
      if (!moves.length) return null;
      const ctx = { nodes: 0, stop: false, deadline: Infinity };
      const style = playingStyle(rating);

      if (Math.random() < style.randomMove) return moves[Math.floor(Math.random() * moves.length)];

      if (!style.thinkMs) {
        // Every move gets its true score so that the noise decides between them fairly.
        const scored = searchRoot(g, moves, style.depth, ctx, seen, true);
        for (const s of scored) s.score += (Math.random() - 0.5) * 2 * style.noise;
        return best(scored).move;
      }

      // Search as deep as it can within the time budget.
      ctx.deadline = Date.now() + style.thinkMs;
      let choice = moves[0];
      for (let depth = 1; depth <= 8; depth++) {
        const scored = searchRoot(g, moves, depth, ctx, seen, false);
        if (!scored) break;
        const top = best(scored);
        choice = top.move;
        // Try the best move first on the next, deeper pass.
        moves.splice(moves.indexOf(choice), 1);
        moves.unshift(choice);
        if (Math.abs(top.score) > MATE - 100) break;
      }
      return choice;
    }

    // ---------------------------------------------------------------------------
    // Game review
    // ---------------------------------------------------------------------------

    const ANALYSIS_MS = 350, ANALYSIS_MAX_DEPTH = 5;

    function sameMove(a, b) {
      return a.from === b.from && a.to === b.to && (a.promo || 0) === (b.promo || 0);
    }

    // Judges one position of a finished game: the engine's best move there and what it is worth,
    // and what the move actually played is worth when searched just as deeply. Scores are in
    // centipawns for the side to move; mates are MATE minus the number of plies to the mate.
    function analyse(g, played) {
      const moves = orderMoves(g.legalMoves());
      if (!moves.length) return { best: null, bestScore: g.inCheck() ? -MATE : 0, playedScore: null, options: 0 };
      const ctx = { nodes: 0, stop: false, deadline: Infinity };
      const start = Date.now();
      let top = null, depth = 0;
      for (let d = 1; d <= ANALYSIS_MAX_DEPTH; d++) {
        // Two plies always finish, so that simple tactics are never missed; deeper passes are timed.
        if (d > 2) ctx.deadline = start + ANALYSIS_MS;
        const scored = searchRoot(g, moves, d, ctx, null, false);
        if (!scored) break;
        top = best(scored);
        depth = d;
        moves.splice(moves.indexOf(top.move), 1);
        moves.unshift(top.move);
        if (Math.abs(top.score) > MATE - 100) break;
      }

      let playedScore = null;
      const move = played && moves.find((m) => sameMove(m, played));
      if (move) {
        playedScore = move === top.move ? top.score
          : searchRoot(g, [move], depth, { nodes: 0, stop: false, deadline: Infinity }, null, true)[0].score;
      }
      const { from, to, promo } = top.move;
      return { best: { from, to, promo }, bestScore: top.score, playedScore, options: moves.length };
    }

    // UCI notation (e2e4, e7e8q), which other chess engines understand.
    function moveToUci(m) {
      return squareName(m.from) + squareName(m.to) + (m.promo ? ' pnbrq'[m.promo] : '');
    }

    // Standard algebraic notation (Nf3, exd5, O-O, e8=Q+) for a legal move in position g.
    function moveToSan(g, m, legal = g.legalMoves()) {
      const type = m.piece & 7;
      let san;
      if (m.flags & F_CASTLE) {
        san = m.to > m.from ? 'O-O' : 'O-O-O';
      } else if (type === PAWN) {
        san = (m.captured ? squareName(m.from)[0] + 'x' : '') + squareName(m.to);
        if (m.promo) san += '=' + ' PNBRQ'[m.promo];
      } else {
        // Name the starting file or rank when another piece of the same kind could also go there.
        const rivals = legal.filter((o) => o.piece === m.piece && o.to === m.to && o.from !== m.from);
        let from = '';
        if (rivals.length) {
          const name = squareName(m.from);
          if (!rivals.some((o) => (o.from & 7) === (m.from & 7))) from = name[0];
          else if (!rivals.some((o) => (o.from >> 3) === (m.from >> 3))) from = name[1];
          else from = name;
        }
        san = ' PNBRQK'[type] + from + (m.captured ? 'x' : '') + squareName(m.to);
      }
      g.make(m);
      const suffix = g.inCheck() ? (g.legalMoves().length ? '+' : '#') : '';
      g.undo(m);
      return san + suffix;
    }

    return {
      Game, chooseMove, analyse, moveToSan, moveToUci, sameMove, evaluate, squareName, squareIndex, START_FEN, MATE,
      MIN_RATING, MAX_RATING,
      WHITE, BLACK, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING, F_EP, F_CASTLE,
    };
  }

  // Runs inside a Web Worker so the page stays smooth while the computer thinks or reviews a game.
  function workerMain(Chess) {
    self.onmessage = (event) => {
      const { id, type, state, rating, seen, played } = event.data;
      const game = Chess.Game.restore(state);
      if (type === 'analyse') self.postMessage({ id, analysis: Chess.analyse(game, played) });
      else self.postMessage({ id, move: Chess.chooseMove(game, rating, new Map(seen)) });
    };
  }

  const api = chessEngine();
  // Handing the engine's own source to a Blob worker works even when the page is opened straight
  // from disk, where loading a worker script by URL is blocked.
  api.workerSource = '(' + workerMain + ')((' + chessEngine + ')());';
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Chess = api;
})(typeof self !== 'undefined' ? self : this);
