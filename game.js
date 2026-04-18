(() => {
  'use strict';

  const ROWS = 6;
  const COLS = 7;
  const PEER_PREFIX = 'c4-lettfeti-';
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const STORAGE_STATS = 'c4_stats_v1';
  const STORAGE_NAME = 'c4_name_v1';

  const S = {
    screen: 'home',
    peer: null,
    conn: null,
    code: null,
    isHost: false,
    myName: '',
    oppName: '',
    myColor: null,
    oppColor: null,
    board: null,
    turn: null,
    firstOfGame: 'R',
    winner: null,
    winningCells: null,
    myWantsRematch: false,
    oppWantsRematch: false,
    connected: false,
    gameScore: { R: 0, Y: 0, D: 0 },
    solo: false,
  };

  const $ = (id) => document.getElementById(id);

  // ---------- Screen management ----------
  function show(screen) {
    S.screen = screen;
    document.querySelectorAll('.screen').forEach((el) => {
      el.hidden = el.dataset.screen !== screen;
    });
  }

  // ---------- Persistence ----------
  function loadStats() {
    try { return JSON.parse(localStorage.getItem(STORAGE_STATS) || '{}'); }
    catch { return {}; }
  }
  function saveStats(stats) {
    localStorage.setItem(STORAGE_STATS, JSON.stringify(stats));
  }
  function recordResult(oppName, result) {
    const stats = loadStats();
    const key = oppName || 'Opponent';
    if (!stats[key]) stats[key] = { w: 0, l: 0, d: 0 };
    stats[key][result] = (stats[key][result] || 0) + 1;
    saveStats(stats);
  }

  // ---------- Utilities ----------
  function genCode() {
    let out = '';
    const buf = new Uint32Array(6);
    (window.crypto || window.msCrypto).getRandomValues(buf);
    for (let i = 0; i < 6; i++) out += CODE_CHARS[buf[i] % CODE_CHARS.length];
    return out;
  }
  function peerIdFromCode(code) { return PEER_PREFIX + code.toUpperCase(); }

  function newBoard() {
    return Array.from({ length: ROWS }, () => Array(COLS).fill(null));
  }

  function lowestRow(board, col) {
    for (let r = ROWS - 1; r >= 0; r--) if (!board[r][col]) return r;
    return -1;
  }

  function checkWin(board, r, c) {
    const color = board[r][c];
    if (!color) return null;
    const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];
    for (const [dr, dc] of dirs) {
      const line = [[r, c]];
      let nr = r + dr, nc = c + dc;
      while (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS && board[nr][nc] === color) {
        line.push([nr, nc]); nr += dr; nc += dc;
      }
      nr = r - dr; nc = c - dc;
      while (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS && board[nr][nc] === color) {
        line.unshift([nr, nc]); nr -= dr; nc -= dc;
      }
      if (line.length >= 4) return line.slice(0, 4);
    }
    return null;
  }

  function isFull(board) {
    return board[0].every((x) => x);
  }

  // ---------- PeerJS ----------
  const TRANSIENT_ERRORS = new Set(['network', 'socket-error', 'socket-closed', 'server-error', 'disconnected']);
  const ERROR_MESSAGES = {
    'network': 'Network issue — check your connection',
    'socket-error': 'Network issue — check your connection',
    'socket-closed': 'Connection dropped — check your connection',
    'server-error': 'Matchmaking server unavailable',
    'disconnected': 'Disconnected from matchmaking server',
    'browser-incompatible': 'Browser does not support WebRTC',
    'ssl-unavailable': 'Secure connection unavailable',
    'peer-unavailable': 'Could not find that game. Check the code.',
    'invalid-id': 'Invalid game code',
    'unavailable-id': 'Code already in use',
    'webrtc': 'WebRTC connection failed',
  };
  function errText(err) {
    return ERROR_MESSAGES[err && err.type] || (err && err.message) || 'Unknown error';
  }

  function createPeer(id) {
    if (typeof Peer === 'undefined') {
      throw new Error('PeerJS library did not load. Reload the page.');
    }
    const opts = { debug: 1 };
    return id ? new Peer(id, opts) : new Peer(opts);
  }

  let hostRetries = 0;
  let joinRetries = 0;

  function hostGame() {
    const code = genCode();
    S.solo = false;
    S.code = code;
    S.isHost = true;
    S.myColor = 'R';
    S.oppColor = 'Y';
    S.firstOfGame = 'R';
    show('waiting');
    $('codeDisplay').textContent = code;
    $('hostStatus').textContent = 'Starting…';
    $('hostRetryBtn').hidden = true;
    $('hostSpinner').hidden = false;

    destroyPeer();
    let peer;
    try {
      peer = createPeer(peerIdFromCode(code));
    } catch (e) {
      console.error(e);
      $('hostStatus').textContent = e.message;
      $('hostSpinner').hidden = true;
      $('hostRetryBtn').hidden = false;
      return;
    }
    S.peer = peer;

    peer.on('open', () => {
      hostRetries = 0;
      $('hostStatus').textContent = 'Waiting for opponent…';
    });
    peer.on('connection', (conn) => {
      if (S.conn && S.conn.open) { try { conn.close(); } catch {} return; }
      S.conn = conn;
      setupConn(conn);
    });
    peer.on('disconnected', () => {
      console.warn('peer disconnected from broker — attempting reconnect');
      try { peer.reconnect(); } catch (e) { console.error(e); }
    });
    peer.on('error', (err) => {
      console.error('[host] peer error', err);
      if (err.type === 'unavailable-id') {
        destroyPeer();
        setTimeout(hostGame, 200);
        return;
      }
      if (TRANSIENT_ERRORS.has(err.type) && hostRetries < 2) {
        hostRetries++;
        $('hostStatus').textContent = `Network hiccup, retrying… (${hostRetries}/2)`;
        destroyPeer();
        setTimeout(hostGame, 900 * hostRetries);
        return;
      }
      $('hostStatus').textContent = errText(err);
      $('hostSpinner').hidden = true;
      $('hostRetryBtn').hidden = false;
    });
  }

  function joinGame(code) {
    code = (code || '').toUpperCase().trim();
    if (code.length !== 6) {
      $('joinStatus').textContent = 'Code must be 6 characters.';
      return;
    }
    S.solo = false;
    S.code = code;
    S.isHost = false;
    S.myColor = 'Y';
    S.oppColor = 'R';
    S.firstOfGame = 'R';
    show('connecting');
    $('connectStatus').textContent = 'Finding opponent…';
    $('joinRetryBtn').hidden = true;
    $('connectSpinner').hidden = false;

    destroyPeer();
    let peer;
    try {
      peer = createPeer(null);
    } catch (e) {
      console.error(e);
      $('connectStatus').textContent = e.message;
      $('connectSpinner').hidden = true;
      $('joinRetryBtn').hidden = false;
      return;
    }
    S.peer = peer;

    peer.on('open', () => {
      joinRetries = 0;
      $('connectStatus').textContent = 'Connecting to opponent…';
      const conn = peer.connect(peerIdFromCode(code), { reliable: true });
      S.conn = conn;
      setupConn(conn);
      setTimeout(() => {
        if (!S.connected && S.screen === 'connecting') {
          $('connectStatus').textContent = 'Could not find that game. Check the code.';
          $('connectSpinner').hidden = true;
          $('joinRetryBtn').hidden = false;
        }
      }, 9000);
    });
    peer.on('disconnected', () => {
      try { peer.reconnect(); } catch (e) { console.error(e); }
    });
    peer.on('error', (err) => {
      console.error('[join] peer error', err);
      if (TRANSIENT_ERRORS.has(err.type) && joinRetries < 2) {
        joinRetries++;
        $('connectStatus').textContent = `Network hiccup, retrying… (${joinRetries}/2)`;
        destroyPeer();
        setTimeout(() => joinGame(code), 900 * joinRetries);
        return;
      }
      if (S.screen === 'connecting') {
        $('connectStatus').textContent = errText(err);
        $('connectSpinner').hidden = true;
        $('joinRetryBtn').hidden = false;
      }
    });
  }

  function setupConn(conn) {
    let helloSent = false;
    conn.on('open', () => {
      S.connected = true;
      setConnDot(true);
      if (!helloSent) {
        conn.send({ type: 'hello', name: S.myName });
        helloSent = true;
      }
    });
    conn.on('data', onMessage);
    conn.on('close', () => {
      S.connected = false;
      setConnDot(false);
      if (S.screen === 'game') {
        $('connText').textContent = 'Opponent disconnected';
      } else if (S.screen === 'connecting') {
        $('connectStatus').textContent = 'Disconnected';
      } else if (S.screen === 'waiting') {
        $('hostStatus').textContent = 'Connection lost';
      }
    });
    conn.on('error', (err) => {
      console.error('conn error', err);
    });
  }

  function setConnDot(ok) {
    const dot = $('connDot');
    const txt = $('connText');
    if (!dot) return;
    dot.classList.toggle('bad', !ok);
    txt.textContent = ok ? 'Connected' : 'Offline';
  }

  function destroyPeer() {
    try { if (S.conn) S.conn.close(); } catch {}
    try { if (S.peer) S.peer.destroy(); } catch {}
    S.peer = null; S.conn = null; S.connected = false;
  }

  function send(msg) {
    if (S.conn && S.conn.open) S.conn.send(msg);
  }

  // ---------- Message handling ----------
  function onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'hello':
        S.oppName = (msg.name || 'Opponent').slice(0, 20);
        S.gameScore = { R: 0, Y: 0, D: 0 };
        startNewGame();
        break;
      case 'move':
        if (S.turn === S.oppColor && typeof msg.col === 'number') {
          applyMove(msg.col, S.oppColor);
        }
        break;
      case 'rematch':
        S.oppWantsRematch = true;
        maybeStartRematch();
        break;
      case 'bye':
        if (S.screen === 'game') $('connText').textContent = 'Opponent left';
        break;
    }
  }

  // ---------- Game flow ----------
  function startNewGame() {
    S.board = newBoard();
    S.turn = S.firstOfGame;
    S.winner = null;
    S.winningCells = null;
    S.myWantsRematch = false;
    S.oppWantsRematch = false;
    buildBoard();
    $('endbar').hidden = true;
    show('game');
    updateHUD();
    scheduleAi();
  }

  function maybeStartRematch() {
    if (S.myWantsRematch && S.oppWantsRematch) {
      S.firstOfGame = S.firstOfGame === 'R' ? 'Y' : 'R';
      startNewGame();
    } else if (S.oppWantsRematch && !S.myWantsRematch) {
      const btn = $('rematchBtn');
      btn.textContent = 'Rematch (opponent ready)';
    }
  }

  function handleColumnTap(col) {
    if (S.winner) return;
    if (S.turn !== S.myColor) return;
    if (S.board[0][col]) return;
    if (!S.solo) send({ type: 'move', col });
    applyMove(col, S.myColor);
    if (navigator.vibrate) { try { navigator.vibrate(8); } catch {} }
  }

  function applyMove(col, color) {
    const row = lowestRow(S.board, col);
    if (row < 0) return;
    S.board[row][col] = color;
    dropDiscDom(row, col, color);
    const win = checkWin(S.board, row, col);
    if (win) {
      S.winner = color;
      S.winningCells = win;
      S.gameScore[color]++;
      recordResult(S.oppName, color === S.myColor ? 'w' : 'l');
      setTimeout(() => highlightWin(win), 420);
      setTimeout(onGameEnd, 500);
    } else if (isFull(S.board)) {
      S.winner = 'D';
      S.gameScore.D++;
      recordResult(S.oppName, 'd');
      setTimeout(onGameEnd, 420);
    } else {
      S.turn = S.turn === 'R' ? 'Y' : 'R';
      scheduleAi();
    }
    updateHUD();
  }

  // ---------- Solo / AI ----------
  function soloGame() {
    destroyPeer();
    S.solo = true;
    S.isHost = false;
    S.code = null;
    S.myColor = 'R';
    S.oppColor = 'Y';
    S.firstOfGame = 'R';
    S.oppName = 'CPU';
    S.gameScore = { R: 0, Y: 0, D: 0 };
    startNewGame();
    setConnDot(true);
    $('connText').textContent = 'Solo';
  }

  const AI_DEPTH = 6;
  const AI_MOVE_ORDER = [3, 2, 4, 1, 5, 0, 6];
  const AI_SCORE_WIN = 1_000_000;

  function aiValidCols(board) {
    const valid = [];
    for (const c of AI_MOVE_ORDER) if (lowestRow(board, c) >= 0) valid.push(c);
    return valid;
  }

  function aiEvalWindow(a, b, c, d, ai, opp) {
    let ac = 0, oc = 0, ec = 0;
    if (a === ai) ac++; else if (a === opp) oc++; else ec++;
    if (b === ai) ac++; else if (b === opp) oc++; else ec++;
    if (c === ai) ac++; else if (c === opp) oc++; else ec++;
    if (d === ai) ac++; else if (d === opp) oc++; else ec++;
    if (ac && oc) return 0;
    if (ac === 3 && ec === 1) return 50;
    if (ac === 2 && ec === 2) return 5;
    if (oc === 3 && ec === 1) return -80;
    if (oc === 2 && ec === 2) return -4;
    return 0;
  }

  function aiEvaluate(board, ai, opp) {
    let s = 0;
    for (let r = 0; r < ROWS; r++) {
      if (board[r][3] === ai) s += 6;
      else if (board[r][3] === opp) s -= 6;
    }
    for (let r = 0; r < ROWS; r++)
      for (let c = 0; c <= COLS - 4; c++)
        s += aiEvalWindow(board[r][c], board[r][c+1], board[r][c+2], board[r][c+3], ai, opp);
    for (let c = 0; c < COLS; c++)
      for (let r = 0; r <= ROWS - 4; r++)
        s += aiEvalWindow(board[r][c], board[r+1][c], board[r+2][c], board[r+3][c], ai, opp);
    for (let r = 3; r < ROWS; r++)
      for (let c = 0; c <= COLS - 4; c++)
        s += aiEvalWindow(board[r][c], board[r-1][c+1], board[r-2][c+2], board[r-3][c+3], ai, opp);
    for (let r = 0; r <= ROWS - 4; r++)
      for (let c = 0; c <= COLS - 4; c++)
        s += aiEvalWindow(board[r][c], board[r+1][c+1], board[r+2][c+2], board[r+3][c+3], ai, opp);
    return s;
  }

  function aiMinimax(board, depth, alpha, beta, maximizing, ai, opp) {
    const valid = aiValidCols(board);
    if (!valid.length) return 0;
    if (depth === 0) return aiEvaluate(board, ai, opp);
    if (maximizing) {
      let best = -Infinity;
      for (const c of valid) {
        const r = lowestRow(board, c);
        board[r][c] = ai;
        const win = checkWin(board, r, c);
        const score = win ? AI_SCORE_WIN + depth
          : aiMinimax(board, depth - 1, alpha, beta, false, ai, opp);
        board[r][c] = null;
        if (score > best) best = score;
        if (best > alpha) alpha = best;
        if (alpha >= beta) break;
      }
      return best;
    } else {
      let best = Infinity;
      for (const c of valid) {
        const r = lowestRow(board, c);
        board[r][c] = opp;
        const win = checkWin(board, r, c);
        const score = win ? -AI_SCORE_WIN - depth
          : aiMinimax(board, depth - 1, alpha, beta, true, ai, opp);
        board[r][c] = null;
        if (score < best) best = score;
        if (best < beta) beta = best;
        if (alpha >= beta) break;
      }
      return best;
    }
  }

  function aiPickMove() {
    const ai = S.oppColor;
    const opp = S.myColor;
    const valid = aiValidCols(S.board);
    if (!valid.length) return -1;
    let bestScore = -Infinity;
    let bestMove = valid[0];
    let alpha = -Infinity;
    const beta = Infinity;
    for (const c of valid) {
      const r = lowestRow(S.board, c);
      S.board[r][c] = ai;
      const win = checkWin(S.board, r, c);
      const score = win ? AI_SCORE_WIN + AI_DEPTH
        : aiMinimax(S.board, AI_DEPTH - 1, alpha, beta, false, ai, opp);
      S.board[r][c] = null;
      if (score > bestScore) { bestScore = score; bestMove = c; }
      if (score > alpha) alpha = score;
    }
    return bestMove;
  }

  function scheduleAi() {
    if (!S.solo || S.winner || S.turn !== S.oppColor) return;
    setTimeout(() => {
      if (!S.solo || S.winner || S.turn !== S.oppColor) return;
      const c = aiPickMove();
      if (c >= 0) applyMove(c, S.oppColor);
    }, 650);
  }

  function onGameEnd() {
    updateHUD();
    const bar = $('endbar');
    const txt = $('endText');
    txt.classList.remove('win', 'lose', 'draw');
    if (S.winner === 'D') {
      txt.textContent = "It's a draw";
      txt.classList.add('draw');
    } else if (S.winner === S.myColor) {
      txt.textContent = 'You win!';
      txt.classList.add('win');
    } else {
      txt.textContent = `${S.oppName} wins`;
      txt.classList.add('lose');
    }
    $('rematchBtn').textContent = 'Rematch';
    bar.hidden = false;
  }

  // ---------- Board rendering ----------
  function buildBoard() {
    const cells = $('cells');
    cells.innerHTML = '';
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const cell = document.createElement('div');
        cell.className = 'cell';
        cell.dataset.r = r;
        cell.dataset.c = c;
        cells.appendChild(cell);
      }
    }
    const cols = $('columns');
    cols.innerHTML = '';
    for (let c = 0; c < COLS; c++) {
      const colEl = document.createElement('div');
      colEl.className = 'col';
      colEl.dataset.c = c;
      cols.appendChild(colEl);
    }
    cols.onpointerdown = (e) => {
      const target = e.target.closest('.col');
      if (!target) return;
      target.classList.add('hot');
      setTimeout(() => target.classList.remove('hot'), 160);
      const c = Number(target.dataset.c);
      handleColumnTap(c);
    };
  }

  function cellAt(r, c) {
    return document.querySelector(`.cell[data-r="${r}"][data-c="${c}"]`);
  }

  function dropDiscDom(row, col, color) {
    const cell = cellAt(row, col);
    if (!cell) return;
    const disc = document.createElement('div');
    disc.className = `disc ${color} dropping`;
    const fromPct = -(row + 1) * 112;
    const duration = 300 + row * 45;
    disc.style.setProperty('--from', `${fromPct}%`);
    disc.style.setProperty('--dur', `${duration}ms`);
    cell.appendChild(disc);
    disc.addEventListener('animationend', () => disc.classList.remove('dropping'), { once: true });
  }

  function highlightWin(cells) {
    cells.forEach(([r, c]) => {
      const cell = cellAt(r, c);
      const disc = cell && cell.querySelector('.disc');
      if (disc) disc.classList.add('win');
    });
  }

  // ---------- HUD ----------
  function updateHUD() {
    const my = $('myBadge');
    const opp = $('oppBadge');
    if (my) { my.className = 'badge ' + (S.myColor || ''); }
    if (opp) { opp.className = 'badge ' + (S.oppColor || ''); }
    $('myName').textContent = S.myName || 'You';
    $('oppName').textContent = S.oppName || 'Opponent';
    $('myScore').textContent = S.gameScore[S.myColor] || 0;
    $('oppScore').textContent = S.gameScore[S.oppColor] || 0;

    const turnEl = $('turnLabel');
    turnEl.classList.remove('win', 'lose', 'draw', 'opp-turn');
    const myEl = document.querySelector('.player.me');
    const oppEl = document.querySelector('.player.opp');
    myEl && myEl.classList.remove('active');
    oppEl && oppEl.classList.remove('active');

    if (S.winner === 'D') {
      turnEl.textContent = 'Draw';
      turnEl.classList.add('draw');
    } else if (S.winner && S.winner === S.myColor) {
      turnEl.textContent = 'You won';
      turnEl.classList.add('win');
    } else if (S.winner && S.winner === S.oppColor) {
      turnEl.textContent = 'You lost';
      turnEl.classList.add('lose');
    } else if (S.turn === S.myColor) {
      turnEl.textContent = 'Your turn';
      myEl && myEl.classList.add('active');
    } else {
      turnEl.textContent = `${S.oppName || 'Opponent'}’s turn`;
      turnEl.classList.add('opp-turn');
      oppEl && oppEl.classList.add('active');
    }

    const cols = document.querySelectorAll('.col');
    const canPlay = !S.winner && S.turn === S.myColor;
    cols.forEach((el, i) => {
      const full = S.board && S.board[0][i];
      el.classList.toggle('disabled', !canPlay || !!full);
    });
  }

  // ---------- Stats UI ----------
  function renderStats() {
    const stats = loadStats();
    const keys = Object.keys(stats).sort();
    const body = $('statsBody');
    body.innerHTML = '';
    if (!keys.length) {
      body.innerHTML = '<div class="stats-empty">No games played yet.</div>';
      return;
    }
    let tw = 0, tl = 0, td = 0;
    for (const k of keys) {
      const s = stats[k];
      tw += s.w || 0; tl += s.l || 0; td += s.d || 0;
      const row = document.createElement('div');
      row.className = 'stat-row';
      row.innerHTML = `
        <div class="stat-name">${escapeHtml(k)}</div>
        <div class="stat-val w" title="Wins">${s.w || 0}W</div>
        <div class="stat-val l" title="Losses">${s.l || 0}L</div>
        <div class="stat-val d" title="Draws">${s.d || 0}D</div>
      `;
      body.appendChild(row);
    }
    const total = document.createElement('div');
    total.className = 'stat-row';
    total.style.borderColor = 'rgba(255,255,255,0.18)';
    total.innerHTML = `
      <div class="stat-name">Total</div>
      <div class="stat-val w">${tw}W</div>
      <div class="stat-val l">${tl}L</div>
      <div class="stat-val d">${td}D</div>
    `;
    body.appendChild(total);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // ---------- Navigation ----------
  function goHome() {
    if (S.screen === 'game' && S.connected) { send({ type: 'bye' }); }
    destroyPeer();
    S.solo = false;
    S.winner = null;
    S.board = null;
    show('home');
  }

  // ---------- Event wiring ----------
  function wire() {
    S.myName = (localStorage.getItem(STORAGE_NAME) || '').trim();
    const nameInput = $('nameInput');
    nameInput.value = S.myName;
    nameInput.addEventListener('input', () => {
      S.myName = nameInput.value.trim().slice(0, 16);
      localStorage.setItem(STORAGE_NAME, S.myName);
    });

    $('hostBtn').addEventListener('click', () => {
      if (!S.myName) { nameInput.focus(); nameInput.placeholder = 'Enter your name first'; return; }
      hostGame();
    });
    $('joinBtn').addEventListener('click', () => {
      if (!S.myName) { nameInput.focus(); nameInput.placeholder = 'Enter your name first'; return; }
      show('join');
      $('joinCode').value = '';
      $('joinStatus').textContent = '';
      setTimeout(() => $('joinCode').focus(), 50);
    });
    $('soloBtn').addEventListener('click', () => {
      if (!S.myName) { nameInput.focus(); nameInput.placeholder = 'Enter your name first'; return; }
      soloGame();
    });
    $('statsBtn').addEventListener('click', () => { renderStats(); show('stats'); });

    $('copyCodeBtn').addEventListener('click', async () => {
      if (!S.code) return;
      try { await navigator.clipboard.writeText(S.code); toast('Code copied'); } catch { toast('Copy failed'); }
    });
    $('copyLinkBtn').addEventListener('click', async () => {
      if (!S.code) return;
      const url = `${location.origin}${location.pathname}?c=${S.code}`;
      try { await navigator.clipboard.writeText(url); toast('Link copied'); } catch { toast('Copy failed'); }
    });

    $('joinCode').addEventListener('input', (e) => {
      e.target.value = e.target.value.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 6);
    });
    $('joinGoBtn').addEventListener('click', () => joinGame($('joinCode').value));
    $('joinCode').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') joinGame(e.target.value);
    });

    $('hostRetryBtn').addEventListener('click', () => {
      hostRetries = 0;
      hostGame();
    });
    $('joinRetryBtn').addEventListener('click', () => {
      joinRetries = 0;
      if (S.code) joinGame(S.code); else goHome();
    });

    $('rematchBtn').addEventListener('click', () => {
      if (S.solo) {
        S.firstOfGame = S.firstOfGame === 'R' ? 'Y' : 'R';
        startNewGame();
        return;
      }
      if (!S.connected) { goHome(); return; }
      S.myWantsRematch = true;
      send({ type: 'rematch' });
      $('rematchBtn').textContent = 'Waiting for opponent…';
      $('rematchBtn').disabled = true;
      maybeStartRematch();
      setTimeout(() => { $('rematchBtn').disabled = false; }, 400);
    });
    $('leaveBtn').addEventListener('click', goHome);

    $('clearStatsBtn').addEventListener('click', () => {
      if (confirm('Clear all stats?')) { saveStats({}); renderStats(); }
    });

    document.querySelectorAll('[data-back]').forEach((el) => {
      el.addEventListener('click', goHome);
    });

    // Deep link ?c=CODE
    const url = new URL(location.href);
    const joinParam = url.searchParams.get('c');
    if (joinParam) {
      const code = joinParam.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 6);
      $('joinCode').value = code;
      if (S.myName && code.length === 6) {
        joinGame(code);
      } else {
        show('home');
        setTimeout(() => {
          nameInput.focus();
          toast('Enter your name then tap Join');
        }, 150);
      }
    }
  }

  // ---------- Toast ----------
  let toastTimer;
  function toast(msg) {
    let el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.style.cssText = 'position:fixed;left:50%;bottom:calc(24px + env(safe-area-inset-bottom));transform:translateX(-50%);background:rgba(20,28,56,0.95);border:1px solid rgba(255,255,255,0.12);color:#eef2ff;padding:10px 16px;border-radius:999px;font-size:14px;z-index:99;opacity:0;transition:opacity 180ms;pointer-events:none;';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.style.opacity = '0'; }, 1500);
  }

  document.addEventListener('DOMContentLoaded', wire);
})();
