# chessMess

A browser chess game against the computer.

Open `index.html` in a browser to play — there is nothing to install or build.

- Three opponents:
  - **Computer**: pick its rating with the slider, from 400 (beginner) to 2400 (master). Lower ratings look less far ahead and make human-like mistakes; higher ones think longer. The numbers are rough labels, not measured ratings. Or pick one of the **top 10 grandmasters** (FIDE's September 2026 list, Magnus Carlsen to Anish Giri) from the panel beside the board: they're played by [Stockfish](https://stockfishchess.org) at a strength to match each rating — their strength, not their personal style. Stockfish is loaded from the internet the first time you pick one; if it can't load, you get our engine at 2400 instead. Your own rating (starting at 1200) goes up and down after every game against the computer, Elo-style.
  - **Friend, same screen**: take turns on one computer.
  - **Friend, online**: choose *Create game* and send your friend the link. The game starts when they open it. Moves travel through a free public message relay (an MQTT broker: [EMQX](https://www.emqx.com/en/mqtt/public-mqtt5-broker)'s, or [HiveMQ](https://www.hivemq.com/mqtt/public-mqtt-broker/)'s if that is down), so this needs an internet connection but no server or account of our own, and works on networks that block direct browser-to-browser connections. The relay is public, so don't send anything secret through it; the random game code keeps other people's games from mixing with yours. If your friend refreshes or drops out, they can rejoin with the same link and carry on. There's also a draw offer, a rematch button (you swap colors each rematch), and a chat with quick emotes that float across the board.
- **Game modes**, picked under the board. They work against the computer, on a shared screen and online (where the player who creates the game picks the mode).
  - **Classic**: no clock.
  - **Blitz**, **Rapid** and **Long**: chess.com's time controls (3 min, 3 | 2, 5 min; 10 min, 15 | 10, 30 min; and 45 | 15, 60 min, 90 | 30 for long games). "3 | 2" means 3 minutes each plus 2 seconds for every move. The clocks start after the first move, and whoever runs out of time loses (it's a draw if the other side has too little left to ever checkmate).
  - **Custom position**: set up any position in the editor (pick a piece, click squares; choose who moves first) and play from it. The editor checks that the position is legal. *Edit position* reopens it.
  - **Chaos**: a 5-minute game inspired by Clash Royale's chaos events. At the start, and again after 2½, 5 and 7½ minutes of combined play, the clocks stop and each player picks one of three random modifiers, within 15 seconds. The computer picks its own too. Both picks then happen at once. There are 17 modifiers: Fireball, Rocket, Lightning, The Log, Freeze, Rage (move twice in a row), Elixir Collector (+60 s), Poison (−45 s for the opponent), Graveyard, Skeleton Army, Goblin Barrel, Mega Knight, Evolution, Tornado, Clone, Earthquake and Mirror (copy your opponent's pick). Chaos games can't be reviewed afterwards, as the rounds change the board in ways the review can't replay.
- Player names: set yours (or white's and black's, on a shared screen) and they show in the score, the status line, the chat and the review.
- **Undo and redo** (in untimed games against the computer or on a shared screen, not online): on a shared screen Undo takes back one move; against the computer it takes back your last move and the computer's reply, so it is your move again. Redo puts them back, and the computer replays the same reply. Playing a new move clears what can be redone, and both buttons are off once a game has ended.
- Play as white or black. Click a piece and then a square, or pick the piece up and drag it (it dangles from your pointer).
- A separate score for each kind of opponent is kept in the browser between visits.
- **Game review**: after a game, choose *Review game* (or *Review last game* later on). The engine goes through every move and shows:
  - an evaluation bar beside the board and a graph of the whole game,
  - a rating for each move — best, excellent, good, inaccuracy, mistake or blunder,
  - an arrow for the better move whenever you (or the computer) missed it,
  - an accuracy score and a count of each rating for both sides.

  Step through with the buttons or the ← → Home End keys; Esc goes back to the game.

## Files

- `index.html`, `style.css` — the page.
- `engine.js` — chess rules, the computer opponent and the move analysis used by the review.
- `app.js` — the board, clicking and dragging, move animations and score.
- `chaos.js` — Chaos mode: the modifiers, and the seeded dice that keep both players of an online game in step.
- `grandmasters.js` — the grandmaster opponents (their ratings, and Stockfish in a background worker).
- `review.js` — the game review.
- `online.js` — online games: connecting, invites, draw offers and rematches.

## Putting it online

A link to the game only works for your friend if the game is on the web. GitHub Pages hosts it for free:
push the code, then on GitHub open the repository's **Settings → Pages**, set the source to
*Deploy from a branch*, and choose the branch (e.g. `main`) and the `/ (root)` folder. After a minute or
so the game is at `https://<your-username>.github.io/chessMess/`.
- `fx.js` — the animated background, capture explosions and win fireworks.
