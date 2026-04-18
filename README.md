# Connect 4

Mobile-first, browser-only, peer-to-peer Connect 4 for two players. Built for our cabin matches.

**Live:** https://lettfeti.github.io/c4/

## How it works

- Pure HTML / CSS / JS — no backend.
- WebRTC via [PeerJS](https://peerjs.com/) (free public signaling broker).
- One player creates a game and gets a 6-character code.
- The other enters the code (or opens a share link) to join.
- Data channel carries moves; each client runs identical game logic.
- Win / loss / draw counts are tracked per opponent name in `localStorage`.

## Play

1. Open the link on both phones.
2. Enter your names.
3. Host taps **Create game**, shares the code.
4. Guest taps **Join game**, enters the code.
5. Red plays first; first-mover alternates each rematch.

Tap anywhere in a column to drop a disc.

## Deploy

Static site — GitHub Pages serves `index.html` from `main`. No build step.

### Custom domain (optional)

To serve from `c4.lettfeti.com`:

1. In this repo's **Settings → Pages**, set **Custom domain** to `c4.lettfeti.com`.
2. Add a DNS CNAME record: `c4` → `lettfeti.github.io`.

## Local dev

Just open `index.html` over a local server (PeerJS needs HTTPS or `localhost`):

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

## Files

- `index.html` — markup and screens
- `style.css` — all visuals
- `game.js` — game logic, PeerJS wiring, win detection, stats
- `manifest.webmanifest` — PWA add-to-home-screen
