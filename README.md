# chessMess

A browser chess game against the computer.

Open `index.html` in a browser to play — there is nothing to install or build.

- Three opponents:
  - **Computer**: pick its rating with the slider, from 400 (beginner) to 2400 (master). Lower ratings look less far ahead and make human-like mistakes; higher ones think longer. The numbers are rough labels, not measured ratings. Or pick one of the **top 10 grandmasters** (FIDE's September 2026 list, Magnus Carlsen to Anish Giri) from the panel beside the board: they're played by [Stockfish](https://stockfishchess.org) at a strength to match each rating — their strength, not their personal style. Stockfish is loaded from the internet the first time you pick one; if it can't load, you get our engine at 2400 instead. Your own rating (starting at 1200) goes up and down after every game against the computer, Elo-style.
  - **Friend, same screen**: take turns on one computer.
  - **Friend, online**: choose *Create game* and send your friend the link. The game starts when they open it. Moves travel through a free public message relay (an MQTT broker: [EMQX](https://www.emqx.com/en/mqtt/public-mqtt5-broker)'s, or [HiveMQ](https://www.hivemq.com/mqtt/public-mqtt-broker/)'s if that is down), so this needs an internet connection but no server or account of our own, and works on networks that block direct browser-to-browser connections. The relay is public, so don't send anything secret through it; the random game code keeps other people's games from mixing with yours. If your friend refreshes or drops out, they can rejoin with the same link and carry on. There's also a draw offer, a rematch button (you swap colors each rematch), and a chat with quick emotes that float across the board.
- Player names: set yours (or white's and black's, on a shared screen) and they show in the score, the status line, the chat and the review.
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
- `grandmasters.js` — the grandmaster opponents (their ratings, and Stockfish in a background worker).
- `review.js` — the game review.
- `online.js` — online games: connecting, invites, draw offers and rematches.

## Putting it online

A link to the game only works for your friend if the game is on the web. GitHub Pages hosts it for free:
push the code, then on GitHub open the repository's **Settings → Pages**, set the source to
*Deploy from a branch*, and choose the branch (e.g. `main`) and the `/ (root)` folder. After a minute or
so the game is at `https://<your-username>.github.io/chessMess/`.
- `fx.js` — the animated background, capture explosions and win fireworks.
