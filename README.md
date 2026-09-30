# chessMess

A browser chess game against the computer.

Open `index.html` in a browser to play — there is nothing to install or build.

- Three opponents:
  - **Computer**, on easy, medium or hard.
  - **Friend, same screen**: take turns on one computer.
  - **Friend, online**: choose *Create game* and send your friend the link. The game starts when they open it. Moves are sent directly between your two browsers (WebRTC via [PeerJS](https://peerjs.com)), so this needs an internet connection but no server of our own. If your friend refreshes or drops out, they can rejoin with the same link and carry on. There's also a draw offer and a rematch button (you swap colors each rematch).
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
- `review.js` — the game review.
- `online.js` — online games: connecting, invites, draw offers and rematches.

## Putting it online

A link to the game only works for your friend if the game is on the web. GitHub Pages hosts it for free:
push the code, then on GitHub open the repository's **Settings → Pages**, set the source to
*Deploy from a branch*, and choose the branch (e.g. `main`) and the `/ (root)` folder. After a minute or
so the game is at `https://<your-username>.github.io/chessMess/`.
- `fx.js` — the animated background, capture explosions and win fireworks.
