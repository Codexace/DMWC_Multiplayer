/* ── Don't Mess With Cthulhu – Client ─────────────────── */
const socket = io();

// ── DOM refs ────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const screenMenu = $('#screen-menu');
const screenLobby = $('#screen-lobby');
const screenGame = $('#screen-game');

let myId = null;
let gameState = null;

// ── Screens ─────────────────────────────────────────────
function showScreen(screen) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  screen.classList.add('active');
}

// ── Menu ────────────────────────────────────────────────
$('#btn-create').addEventListener('click', () => {
  const name = $('#player-name').value.trim();
  if (!name) return showError('Enter your name');
  socket.emit('create_room', { playerName: name }, (res) => {
    if (res.success) {
      myId = res.playerId;
      showScreen(screenLobby);
    } else {
      showError(res.error);
    }
  });
});

$('#btn-join').addEventListener('click', () => {
  const name = $('#player-name').value.trim();
  const code = $('#room-code').value.trim().toUpperCase();
  if (!name) return showError('Enter your name');
  if (!code) return showError('Enter a room code');
  socket.emit('join_room', { code, playerName: name }, (res) => {
    if (res.success) {
      myId = res.playerId;
      showScreen(screenLobby);
    } else {
      showError(res.error);
    }
  });
});

// Enter key support
$('#player-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-create').click(); });
$('#room-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-join').click(); });

function showError(msg) { $('#menu-error').textContent = msg; }

// ── Lobby ───────────────────────────────────────────────
$('#btn-start').addEventListener('click', () => {
  socket.emit('start_game', null, (res) => {
    if (!res.success) alert(res.error);
  });
});

$('#btn-add-bot').addEventListener('click', () => {
  socket.emit('add_bot', null, (res) => {
    if (!res?.success) alert(res?.error || 'Failed to add bot');
  });
});

function renderLobby(state) {
  $('#lobby-code').textContent = state.code;
  const container = $('#lobby-players');
  container.innerHTML = '';
  state.players.forEach(p => {
    const chip = document.createElement('div');
    chip.className = 'player-chip' +
      (p.isHost ? ' host' : '') +
      (p.id === myId ? ' you' : '') +
      (p.isBot ? ' bot' : '') +
      (!p.connected ? ' disconnected' : '');
    chip.textContent = p.name + (p.isHost ? ' (Host)' : '') + (p.id === myId ? ' (You)' : '') + (p.isBot ? ' (Bot)' : '');
    container.appendChild(chip);
  });

  const me = state.players.find(p => p.id === myId);
  const startBtn = $('#btn-start');
  const addBotBtn = $('#btn-add-bot');
  if (me?.isHost) {
    startBtn.style.display = 'inline-block';
    startBtn.disabled = state.players.length < 5;
    addBotBtn.style.display = state.players.length < 8 ? 'inline-block' : 'none';
  } else {
    startBtn.style.display = 'none';
    addBotBtn.style.display = 'none';
  }

  const status = $('#lobby-status');
  if (state.players.length < 5) {
    status.textContent = `Need ${5 - state.players.length} more player(s) to start.`;
  } else {
    status.textContent = me?.isHost ? 'Ready! Press Start Game.' : 'Waiting for host to start...';
  }
}

// ── Game State Handler ──────────────────────────────────
socket.on('game_state', (state) => {
  gameState = state;

  if (state.phase === 'lobby') {
    showScreen(screenLobby);
    renderLobby(state);
    return;
  }

  showScreen(screenGame);
  renderHeader(state);
  renderLog(state);

  // Hide all phases
  document.querySelectorAll('.phase').forEach(p => p.style.display = 'none');

  if (state.phase === 'declaring') {
    $('#phase-declaring').style.display = 'block';
    renderDeclaring(state);
  } else if (state.phase === 'investigating') {
    $('#phase-investigating').style.display = 'block';
    renderInvestigating(state);
  } else if (state.phase === 'game_over') {
    $('#phase-gameover').style.display = 'block';
    renderGameOver(state);
  }
});

// ── Render: Header ──────────────────────────────────────
function renderHeader(state) {
  $('#game-round').innerHTML = `Round: <b>${state.round}/${state.maxRounds}</b>`;
  $('#game-actions').innerHTML = `Actions: <b>${state.actionsLeft}</b>`;
  $('#game-signs').innerHTML = `Elder Signs: <b>${state.elderSignsFound}/${state.elderSignsTotal}</b>`;

  const badge = $('#game-role');
  badge.textContent = state.private.role;
  badge.className = 'role-badge ' + state.private.role;
}

// ── Render: Declaration Phase ───────────────────────────
function renderDeclaring(state) {
  // Show hand
  const hand = $('#your-hand');
  hand.innerHTML = '';
  state.private.hand.forEach(c => {
    const card = document.createElement('div');
    card.className = 'hand-card ' + c.type;
    const label = c.type === 'elder_sign' ? 'Elder Sign' : c.type === 'cthulhu' ? 'Cthulhu' : 'Futile';
    card.textContent = label;
    hand.appendChild(card);
  });

  // Populate elder signs dropdown (0 to card count) and reset both dropdowns
  const elderSelect = $('#declare-elder');
  const cardCount = state.private.hand.filter(c => !c.revealed).length;
  elderSelect.innerHTML = '';
  for (let i = 0; i <= cardCount; i++) {
    const opt = document.createElement('option');
    opt.value = i; opt.textContent = i;
    elderSelect.appendChild(opt);
  }
  elderSelect.value = '0';
  $('#declare-cthulhu').value = '0';

  // Already declared?
  const me = state.players.find(p => p.id === myId);
  const form = $('#declare-form');
  form.style.display = me.declaration ? 'none' : 'flex';

  // Show all declarations
  const container = $('#declarations');
  container.innerHTML = '';
  state.players.forEach(p => {
    const chip = document.createElement('div');
    chip.className = 'declaration-chip' + (p.declaration ? '' : ' waiting');
    if (p.declaration) {
      chip.textContent = `${p.name}: ${p.declaration.elderSigns} Elder, ${p.declaration.cthulhu} Cthulhu`;
    } else {
      chip.textContent = `${p.name}: waiting...`;
    }
    container.appendChild(chip);
  });
}

$('#btn-declare').addEventListener('click', () => {
  const elderSigns = parseInt($('#declare-elder').value);
  const cthulhu = parseInt($('#declare-cthulhu').value);
  socket.emit('declare', { elderSigns, cthulhu }, (res) => {
    if (!res?.success) alert('Declaration failed');
  });
});

// ── Render: Investigation Phase ─────────────────────────
function renderInvestigating(state) {
  const activePlayer = state.players[state.activePlayerIdx];
  const isMyTurn = activePlayer.id === myId;

  const prompt = $('#investigate-prompt');
  if (isMyTurn) {
    prompt.textContent = 'Your turn! Choose a player to investigate (click their board).';
    prompt.style.color = 'var(--accent)';
  } else {
    prompt.textContent = `${activePlayer.name}'s turn to investigate...`;
    prompt.style.color = '';
  }

  const container = $('#player-boards');
  container.innerHTML = '';

  state.players.forEach((p) => {
    const board = document.createElement('div');
    board.className = 'player-board';

    const unrevealedCount = p.cardCount;
    const isMe = p.id === myId;
    const canInvestigate = isMyTurn && !isMe && unrevealedCount > 0;

    if (p.id === activePlayer.id) board.classList.add('active-turn');
    if (isMe) board.classList.add('is-you');
    if (canInvestigate) board.classList.add('selectable');

    // Name
    const nameDiv = document.createElement('div');
    nameDiv.className = 'player-board-name';
    nameDiv.textContent = p.name;
    if (isMe) nameDiv.innerHTML += ' <span class="you-tag">(You)</span>';
    if (p.id === activePlayer.id) nameDiv.innerHTML += ' <span class="active-tag">&#9733; Active</span>';
    board.appendChild(nameDiv);

    // Cards
    const cardsDiv = document.createElement('div');
    cardsDiv.className = 'player-board-cards';

    // Facedown cards
    for (let i = 0; i < unrevealedCount; i++) {
      const c = document.createElement('div');
      c.className = 'board-card facedown';
      c.textContent = '?';
      cardsDiv.appendChild(c);
    }

    // Revealed cards
    p.revealedCards.forEach(type => {
      const c = document.createElement('div');
      c.className = 'board-card ' + type;
      const label = type === 'elder_sign' ? 'Elder Sign' : type === 'cthulhu' ? 'Cthulhu' : 'Futile';
      c.textContent = label;
      cardsDiv.appendChild(c);
    });

    board.appendChild(cardsDiv);

    // Declaration
    if (p.declaration) {
      const decl = document.createElement('div');
      decl.className = 'player-board-decl';
      decl.textContent = `Claims: ${p.declaration.elderSigns} Elder, ${p.declaration.cthulhu} Cthulhu`;
      board.appendChild(decl);
    }

    // Click handler
    if (canInvestigate) {
      board.addEventListener('click', () => {
        socket.emit('investigate', { targetPlayerId: p.id }, (res) => {
          if (!res?.success) alert(res?.error || 'Failed');
        });
      });
    }

    container.appendChild(board);
  });
}

// ── Render: Game Over ───────────────────────────────────
function renderGameOver(state) {
  const title = $('#gameover-title');
  if (state.winner === 'investigators') {
    title.textContent = 'Investigators Win!';
    title.style.color = 'var(--green)';
  } else {
    title.textContent = 'Cultists Win!';
    title.style.color = 'var(--purple)';
  }

  const myRole = state.private.role;
  const won = (state.winner === 'investigators' && myRole === 'investigator') ||
              (state.winner === 'cultists' && myRole === 'cultist');
  $('#gameover-role').textContent = won ? 'You won!' : 'You lost!';
  $('#gameover-role').style.color = won ? 'var(--green)' : 'var(--red)';

  // Show all roles
  const rolesDiv = $('#gameover-roles');
  rolesDiv.innerHTML = '';
  state.players.forEach(p => {
    const chip = document.createElement('div');
    chip.className = 'role-reveal-chip ' + (p.role || '');
    chip.textContent = `${p.name} — ${p.role || '?'}`;
    rolesDiv.appendChild(chip);
  });

  // Play again (host only)
  const me = state.players.find(p => p.id === myId);
  const btn = $('#btn-playagain');
  btn.style.display = me?.isHost ? 'inline-block' : 'none';
}

$('#btn-playagain').addEventListener('click', () => {
  socket.emit('play_again', null, (res) => {
    if (!res?.success) alert(res?.error || 'Failed');
  });
});

// ── Render: Log ─────────────────────────────────────────
function renderLog(state) {
  const log = $('#game-log');
  log.innerHTML = '';
  state.log.forEach(entry => {
    const div = document.createElement('div');
    div.className = 'log-entry' + (entry.message.startsWith('[') ? ' chat' : '');
    div.textContent = entry.message;
    log.appendChild(div);
  });
  log.scrollTop = log.scrollHeight;
}

// ── Chat ────────────────────────────────────────────────
$('#btn-chat').addEventListener('click', sendChat);
$('#chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });

function sendChat() {
  const input = $('#chat-input');
  const msg = input.value.trim();
  if (!msg) return;
  socket.emit('chat', { message: msg });
  input.value = '';
}
