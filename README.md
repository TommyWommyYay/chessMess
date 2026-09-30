# chessMess

A browser chess game against the computer.

Open `index.html` in a browser to play — there is nothing to install or build.

- Three difficulties: easy, medium and hard.
- Play as white or black. Click a piece and then a square, or pick the piece up and drag it (it dangles from your pointer).
- The score (your wins, draws, computer wins) is kept in the browser between visits.
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
- `fx.js` — the animated background, capture explosions and win fireworks.
