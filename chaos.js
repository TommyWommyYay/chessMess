// Chaos mode: a five-minute game in which, every 45 seconds of play, each player drafts one of three
// powerups, the way Clash Royale hands out cards. A powerup belongs to one kind of piece (all your
// knights, say) and lasts for the rest of the game, unless you later pick another powerup for the
// same kind of piece, which swaps it out. The rules of every powerup live in the engine
// (Chess.POWERS); this file names them and runs the draft. Everything random is drawn from a seed
// shared by both players, so an online game plays out the same on both screens.
(function (root) {
  'use strict';

  const { Game, POWERS, evaluate, WHITE, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING } = Chess;

  const CLOCK = { base: 5 * 60 * 1000, inc: 0 };
  const ROUND_MS = 45 * 1000;       // a draft every time the players have used this much time between them
  const PICK_MS = 12 * 1000;        // how long a player has to pick
  const OFFERED = 3;
  // Time the clock powerups give (see the page's clocks).
  const COLLECTOR_MS = 3000, PUMP_MS = 2000;

  const PIECES = { [PAWN]: 'Pawns', [KNIGHT]: 'Knights', [BISHOP]: 'Bishops', [ROOK]: 'Rooks', [QUEEN]: 'Queen', [KING]: 'King' };

  // `anim` is how the page shows the powerup at work: 'hop' for moves that jump or fly, 'boom' for
  // pieces that blow up, 'spawn' for pieces that appear, 'time' for clock bonuses, 'shield' for
  // protection. `bonus` is the computer's rough worth (in centipawns) for powerups the engine's
  // evaluation cannot see.
  const POWERUPS = [
    { id: 'hog', icon: '🐗', name: 'Hog Rider', anim: 'hop', text: 'Pawns can charge two squares forward from anywhere, not just from the start.' },
    { id: 'barbarian', icon: '🪓', name: 'Barbarians', anim: 'hop', text: 'Pawns can also capture the piece straight in front of them.' },
    { id: 'recruits', icon: '👥', name: 'Royal Recruits', anim: 'hop', text: 'Pawns can also step one square sideways.' },
    { id: 'spear', icon: '🔱', name: 'Spear Goblins', anim: 'hop', text: 'Pawns can also capture two squares diagonally ahead, over an empty square.' },
    { id: 'giantskeleton', icon: '💣', name: 'Giant Skeleton', anim: 'boom', text: 'When one of your pawns is captured, its bomb destroys the piece that took it (not a king).' },
    { id: 'collector', icon: '💧', name: 'Elixir Collector', anim: 'time', bonus: 70, text: `Every pawn move adds ${COLLECTOR_MS / 1000} seconds to your clock.` },
    { id: 'megaknight', icon: '🐴', name: 'Mega Knight', anim: 'hop', text: 'Knights can also move one square in any direction, like a king.' },
    { id: 'bandit', icon: '💨', name: 'Bandit', anim: 'hop', text: 'Knights can also dash two squares in a straight line, jumping over anything.' },
    { id: 'darkprince', icon: '🛡', name: 'Dark Prince', anim: 'shield', text: 'Knights carry a shield: pawns can’t capture them.' },
    { id: 'balloon', icon: '🎈', name: 'Balloon', anim: 'hop', text: 'Bishops fly over the first piece in their way and carry on.' },
    { id: 'icewizard', icon: '🧊', name: 'Ice Wizard', anim: 'hop', text: 'Bishops can also step one square straight up, down or sideways.' },
    { id: 'guards', icon: '🔰', name: 'Guards', anim: 'shield', text: 'Bishops carry shields: pawns can’t capture them.' },
    { id: 'cannon', icon: '💥', name: 'Cannon Cart', anim: 'hop', text: 'Rooks can also capture by firing over exactly one piece in between.' },
    { id: 'royalgiant', icon: '👑', name: 'Royal Giant', anim: 'hop', text: 'Rooks can also step one square diagonally.' },
    { id: 'ramrider', icon: '🐏', name: 'Ram Rider', anim: 'hop', text: 'Rooks can also jump like a knight.' },
    { id: 'valkyrie', icon: '🌀', name: 'Valkyrie', anim: 'boom', text: 'When a rook captures, it spins and destroys every enemy pawn next to it.' },
    { id: 'archerqueen', icon: '🏹', name: 'Archer Queen', anim: 'hop', text: 'The queen can also jump like a knight.' },
    { id: 'electro', icon: '⚡', name: 'Electro Wizard', anim: 'boom', text: 'When the queen captures, a zap destroys every enemy pawn next to her.' },
    { id: 'witch', icon: '🧹', name: 'Witch', anim: 'spawn', text: 'When the queen captures, a skeleton pawn appears on the square she left.' },
    { id: 'monk', icon: '🧘', name: 'Monk', anim: 'hop', bonus: 40, text: 'The king can also jump like a knight.' },
    { id: 'skeletonking', icon: '💀', name: 'Skeleton King', anim: 'hop', bonus: 50, text: 'The king can also stride two squares in any direction, over an empty square.' },
    { id: 'pump', icon: '⛽', name: 'Elixir Pump', anim: 'time', bonus: 90, text: `Every move you make adds ${PUMP_MS / 1000} seconds to your clock.` },
  ];
  for (const p of POWERUPS) {
    p.type = POWERS[p.id].type;
    p.pieces = PIECES[p.type];
  }
  const BY_ID = new Map(POWERUPS.map((p) => [p.id, p]));

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
  // The draft
  // ---------------------------------------------------------------------------

  // Would giving `color` this powerup put the other king in check straight away? That is only
  // allowed for the side about to move's opponent, never while the other side can't answer.
  function givesCheck(g, id, color) {
    const piece = color | POWERS[id].type, before = g.power[piece];
    g.setPower(piece, id);
    const check = g.inCheck(color ^ 8);
    g.setPower(piece, before);
    return check;
  }

  // The powerups `color` is offered in a round: none it already has, and none that would check the
  // other king while it is `color`'s own move.
  function offers(seed, round, color, g) {
    return shuffle(random(seed, 'offer', round, color), POWERUPS.map((p) => p.id))
      .filter((id) => g.power[color | POWERS[id].type] !== id)
      .filter((id) => g.turn !== color || !givesCheck(g, id, color))
      .slice(0, OFFERED);
  }

  // Gives `color` its pick. Returns { color, powerup, replaced } (replaced: the powerup it swapped out).
  function apply(g, color, id) {
    const powerup = BY_ID.get(id), piece = color | powerup.type;
    const replaced = BY_ID.get(g.power[piece]) || null;
    g.setPower(piece, id);
    return { color, powerup, replaced };
  }

  // The computer's pick: each offer is tried on a copy of the game and the position judged with it;
  // the engine's evaluation counts each powered piece's extra worth. Weaker computers judge more
  // loosely (`noise` in centipawns).
  function choose(g, { offered, color, noise = 0 }) {
    const own = (position) => evaluate(position) * (position.turn === color ? 1 : -1);
    const before = own(g);
    let bestId = offered[0], bestScore = -Infinity;
    for (const id of offered) {
      const copy = Game.restore(g.snapshot());
      apply(copy, color, id);
      let score = own(copy) - before + (BY_ID.get(id).bonus || 0);
      score += (Math.random() - 0.5) * 2 * noise;
      if (score > bestScore) [bestId, bestScore] = [id, score];
    }
    return bestId;
  }

  // Extra clock time `color` earns for a move of `piece` (in milliseconds).
  function timeBonus(g, piece) {
    const color = piece & 8;
    let ms = g.power[color | KING] === 'pump' ? PUMP_MS : 0;
    if ((piece & 7) === PAWN && g.power[color | PAWN] === 'collector') ms += COLLECTOR_MS;
    return ms;
  }

  root.Chaos = {
    CLOCK, ROUND_MS, PICK_MS, POWERUPS, WHITE,
    find: (id) => BY_ID.get(id) || null,
    offers, apply, choose, timeBonus,
  };
})(this);
