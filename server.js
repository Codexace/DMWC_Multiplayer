const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ── Game state store ────────────────────────────────────────────────
const rooms = new Map();

// ── Constants ───────────────────────────────────────────────────────
const PLAYER_CONFIGS = {
  5: { investigators: 3, cultists: 2, futile: 19, elderSigns: 5, cthulhu: 1 },
  6: { investigators: 4, cultists: 2, futile: 23, elderSigns: 6, cthulhu: 1 },
  7: { investigators: 5, cultists: 2, futile: 27, elderSigns: 7, cthulhu: 1 },
  8: { investigators: 5, cultists: 3, futile: 31, elderSigns: 8, cthulhu: 1 },
};
const MAX_ROUNDS = 4;
const CARDS_PER_PLAYER = 5;
const BOT_NAMES = ['Alice', 'Bob', 'Carol', 'Dave', 'Eve', 'Frank', 'Grace', 'Hank'];
let botIdCounter = 0;

// ── Helpers ─────────────────────────────────────────────────────────
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return rooms.has(code) ? generateRoomCode() : code;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function buildInvestigationDeck(playerCount) {
  const cfg = PLAYER_CONFIGS[playerCount];
  const deck = [];
  for (let i = 0; i < cfg.futile; i++) deck.push('futile');
  for (let i = 0; i < cfg.elderSigns; i++) deck.push('elder_sign');
  deck.push('cthulhu');
  return shuffle(deck);
}

function buildRoleDeck(playerCount) {
  const cfg = PLAYER_CONFIGS[playerCount];
  const roles = [];
  for (let i = 0; i < cfg.investigators; i++) roles.push('investigator');
  for (let i = 0; i < cfg.cultists; i++) roles.push('cultist');
  return shuffle(roles);
}

function dealCards(room) {
  const playerCount = room.players.length;
  const cardsNeeded = playerCount * CARDS_PER_PLAYER;

  // Use remaining deck cards from previous rounds or build fresh
  let deck;
  if (room.round === 1) {
    deck = buildInvestigationDeck(playerCount);
  } else {
    // Collect all unrevealed cards
    deck = [];
    for (const p of room.players) {
      deck.push(...p.cards.filter(c => !c.revealed).map(c => c.type));
    }
    shuffle(deck);
  }

  // Deal evenly
  const perPlayer = Math.floor(deck.length / playerCount);
  let idx = 0;
  for (const p of room.players) {
    p.cards = [];
    for (let i = 0; i < perPlayer; i++) {
      p.cards.push({ type: deck[idx++], revealed: false });
    }
  }
  // Leftover cards (shouldn't happen with proper counts, but safety)
  let extra = 0;
  while (idx < deck.length) {
    room.players[extra % playerCount].cards.push({ type: deck[idx++], revealed: false });
    extra++;
  }
}

function getPublicGameState(room) {
  return {
    code: room.code,
    phase: room.phase,
    round: room.round,
    maxRounds: MAX_ROUNDS,
    actionsLeft: room.actionsLeft,
    activePlayerIdx: room.activePlayerIdx,
    elderSignsFound: room.elderSignsFound,
    elderSignsTotal: PLAYER_CONFIGS[room.players.length]?.elderSigns || 0,
    cthulhuFound: room.cthulhuFound,
    winner: room.winner,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      cardCount: p.cards.filter(c => !c.revealed).length,
      revealedCards: p.cards.filter(c => c.revealed).map(c => c.type),
      totalCards: p.cards.length,
      declaration: p.declaration,
      isHost: p.isHost,
      connected: p.connected,
      isBot: !!p.isBot,
      role: room.phase === 'game_over' ? p.role : null,
    })),
    log: room.log,
  };
}

function getPrivateState(room, playerId) {
  const player = room.players.find(p => p.id === playerId);
  if (!player) return null;
  return {
    role: player.role,
    hand: player.cards.map(c => ({ type: c.type, revealed: c.revealed })),
  };
}

function addLog(room, message) {
  room.log.push({ message, timestamp: Date.now() });
  if (room.log.length > 100) room.log.shift();
}

function broadcastState(room) {
  for (const p of room.players) {
    if (p.isBot) continue; // Bots have no socket
    const sock = io.sockets.sockets.get(p.id);
    if (sock) {
      sock.emit('game_state', {
        ...getPublicGameState(room),
        private: getPrivateState(room, p.id),
      });
    }
  }
  // After broadcasting to humans, let bots act
  tickBots(room);
}

function checkWinConditions(room) {
  const cfg = PLAYER_CONFIGS[room.players.length];
  if (room.cthulhuFound) {
    room.winner = 'cultists';
    room.phase = 'game_over';
    addLog(room, 'Cthulhu has been revealed! The Cultists win!');
    return true;
  }
  if (room.elderSignsFound >= cfg.elderSigns) {
    room.winner = 'investigators';
    room.phase = 'game_over';
    addLog(room, 'All Elder Signs found! The Investigators win!');
    return true;
  }
  return false;
}

function startRound(room) {
  room.phase = 'declaring';
  dealCards(room);
  for (const p of room.players) {
    p.declaration = null;
  }
  addLog(room, `--- Round ${room.round} ---`);
  room.declarationsRemaining = room.players.length;
  broadcastState(room);
}

function startInvestigation(room) {
  room.phase = 'investigating';
  room.actionsLeft = room.players.length;
  // Shuffle each player's cards (they already looked at them)
  for (const p of room.players) {
    const unrevealed = p.cards.filter(c => !c.revealed);
    const revealed = p.cards.filter(c => c.revealed);
    shuffle(unrevealed);
    p.cards = [...unrevealed, ...revealed];
  }
  addLog(room, 'Investigation phase begins!');
  broadcastState(room);
}

// ── Bot Logic ───────────────────────────────────────────────────────
function tickBots(room) {
  if (room.phase === 'lobby' || room.phase === 'game_over') return;

  if (room.phase === 'declaring') {
    // Bots that haven't declared yet
    const undeclaredBots = room.players.filter(p => p.isBot && p.declaration === null);
    undeclaredBots.forEach((bot, i) => {
      setTimeout(() => {
        if (room.phase !== 'declaring' || bot.declaration !== null) return;
        // Count actual cards
        const elderCount = bot.cards.filter(c => !c.revealed && c.type === 'elder_sign').length;
        const cthulhuCount = bot.cards.filter(c => !c.revealed && c.type === 'cthulhu').length;
        // Sometimes lie (30% chance)
        let declaredElder = elderCount;
        let declaredCthulhu = cthulhuCount;
        if (Math.random() < 0.3) {
          declaredElder = Math.floor(Math.random() * (bot.cards.filter(c => !c.revealed).length + 1));
          declaredCthulhu = Math.random() < 0.5 ? 0 : (cthulhuCount > 0 ? 1 : 0);
        }
        bot.declaration = { elderSigns: declaredElder, cthulhu: declaredCthulhu };
        room.declarationsRemaining--;
        addLog(room, `${bot.name} claims: ${declaredElder} Elder Sign(s), ${declaredCthulhu} Cthulhu.`);
        if (room.declarationsRemaining <= 0) {
          startInvestigation(room);
        } else {
          broadcastState(room);
        }
      }, 500 + i * 300);
    });
    return;
  }

  if (room.phase === 'investigating') {
    const activePlayer = room.players[room.activePlayerIdx];
    if (!activePlayer?.isBot) return;
    setTimeout(() => {
      if (room.phase !== 'investigating') return;
      const currentActive = room.players[room.activePlayerIdx];
      if (!currentActive?.isBot || currentActive.id !== activePlayer.id) return;

      // Pick a random other player with unrevealed cards
      const targets = room.players.filter(p =>
        p.id !== activePlayer.id && p.cards.some(c => !c.revealed)
      );
      if (targets.length === 0) return;
      const target = targets[Math.floor(Math.random() * targets.length)];

      // Reveal a random unrevealed card
      const unrevealedIndices = target.cards
        .map((c, i) => (!c.revealed ? i : -1))
        .filter(i => i >= 0);
      if (unrevealedIndices.length === 0) return;
      const revealIdx = unrevealedIndices[Math.floor(Math.random() * unrevealedIndices.length)];
      const card = target.cards[revealIdx];
      card.revealed = true;

      const cardName = card.type === 'elder_sign' ? 'Elder Sign' : card.type === 'cthulhu' ? 'Cthulhu' : 'Futile Investigation';
      addLog(room, `${activePlayer.name} investigated ${target.name} and revealed: ${cardName}!`);

      if (card.type === 'elder_sign') room.elderSignsFound++;
      if (card.type === 'cthulhu') room.cthulhuFound = true;

      if (checkWinConditions(room)) {
        broadcastState(room);
        return;
      }

      room.actionsLeft--;
      room.activePlayerIdx = room.players.indexOf(target);

      if (room.actionsLeft <= 0) {
        room.round++;
        if (room.round > MAX_ROUNDS) {
          room.winner = 'cultists';
          room.phase = 'game_over';
          addLog(room, 'All rounds completed without finding all Elder Signs. The Cultists win!');
          broadcastState(room);
        } else {
          startRound(room);
        }
      } else {
        broadcastState(room);
      }
    }, 800);
    return;
  }
}

// ── Socket.io ───────────────────────────────────────────────────────
io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('create_room', ({ playerName }, cb) => {
    const code = generateRoomCode();
    const room = {
      code,
      phase: 'lobby',
      round: 0,
      actionsLeft: 0,
      activePlayerIdx: 0,
      elderSignsFound: 0,
      cthulhuFound: false,
      winner: null,
      players: [],
      log: [],
      declarationsRemaining: 0,
    };
    room.players.push({
      id: socket.id,
      name: playerName,
      role: null,
      cards: [],
      declaration: null,
      isHost: true,
      connected: true,
    });
    rooms.set(code, room);
    currentRoom = code;
    socket.join(code);
    cb({ success: true, code, playerId: socket.id });
    broadcastState(room);
  });

  socket.on('join_room', ({ code, playerName }, cb) => {
    const room = rooms.get(code.toUpperCase());
    if (!room) return cb({ success: false, error: 'Room not found' });
    if (room.phase !== 'lobby') return cb({ success: false, error: 'Game already in progress' });
    if (room.players.length >= 8) return cb({ success: false, error: 'Room is full' });
    if (room.players.some(p => p.name === playerName)) return cb({ success: false, error: 'Name already taken' });

    room.players.push({
      id: socket.id,
      name: playerName,
      role: null,
      cards: [],
      declaration: null,
      isHost: false,
      connected: true,
    });
    currentRoom = code;
    socket.join(code);
    addLog(room, `${playerName} joined the room.`);
    cb({ success: true, code: room.code, playerId: socket.id });
    broadcastState(room);
  });

  socket.on('add_bot', (_, cb) => {
    const room = rooms.get(currentRoom);
    if (!room) return cb?.({ success: false, error: 'No room' });
    const player = room.players.find(p => p.id === socket.id);
    if (!player?.isHost) return cb?.({ success: false, error: 'Only host can add bots' });
    if (room.phase !== 'lobby') return cb?.({ success: false, error: 'Game already started' });
    if (room.players.length >= 8) return cb?.({ success: false, error: 'Room is full' });

    botIdCounter++;
    const usedNames = room.players.map(p => p.name);
    const botName = BOT_NAMES.find(n => !usedNames.includes('Bot ' + n)) || ('Bot ' + botIdCounter);

    room.players.push({
      id: 'bot-' + botIdCounter,
      name: 'Bot ' + botName,
      role: null,
      cards: [],
      declaration: null,
      isHost: false,
      connected: true,
      isBot: true,
    });
    addLog(room, `${room.players[room.players.length - 1].name} joined the room.`);
    cb?.({ success: true });
    broadcastState(room);
  });

  socket.on('start_game', (_, cb) => {
    const room = rooms.get(currentRoom);
    if (!room) return cb?.({ success: false, error: 'No room' });
    const player = room.players.find(p => p.id === socket.id);
    if (!player?.isHost) return cb?.({ success: false, error: 'Only host can start' });
    if (room.players.length < 5) return cb?.({ success: false, error: 'Need at least 5 players' });
    if (room.players.length > 8) return cb?.({ success: false, error: 'Too many players' });

    // Assign roles
    const roles = buildRoleDeck(room.players.length);
    room.players.forEach((p, i) => { p.role = roles[i]; });

    // Pick random starting player
    room.activePlayerIdx = Math.floor(Math.random() * room.players.length);
    room.round = 1;

    addLog(room, 'Game started! Roles have been dealt.');
    addLog(room, `${room.players[room.activePlayerIdx].name} goes first.`);
    cb?.({ success: true });
    startRound(room);
  });

  socket.on('declare', ({ elderSigns, cthulhu }, cb) => {
    const room = rooms.get(currentRoom);
    if (!room || room.phase !== 'declaring') return cb?.({ success: false });
    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.declaration !== null) return cb?.({ success: false, error: 'Already declared' });

    player.declaration = { elderSigns: Number(elderSigns), cthulhu: Number(cthulhu) };
    room.declarationsRemaining--;
    addLog(room, `${player.name} claims: ${elderSigns} Elder Sign(s), ${cthulhu} Cthulhu.`);

    if (room.declarationsRemaining <= 0) {
      startInvestigation(room);
    } else {
      broadcastState(room);
    }
    cb?.({ success: true });
  });

  socket.on('investigate', ({ targetPlayerId, cardIndex }, cb) => {
    const room = rooms.get(currentRoom);
    if (!room || room.phase !== 'investigating') return cb?.({ success: false });

    const activePlayer = room.players[room.activePlayerIdx];
    if (activePlayer.id !== socket.id) return cb?.({ success: false, error: 'Not your turn' });

    const target = room.players.find(p => p.id === targetPlayerId);
    if (!target) return cb?.({ success: false, error: 'Player not found' });
    if (target.id === activePlayer.id) return cb?.({ success: false, error: "Can't investigate yourself" });

    // Find unrevealed cards for the target
    const unrevealedIndices = target.cards
      .map((c, i) => (!c.revealed ? i : -1))
      .filter(i => i >= 0);
    if (unrevealedIndices.length === 0) return cb?.({ success: false, error: 'No cards left to reveal' });

    // Pick a random unrevealed card (the active player picks a player, not a specific card)
    const revealIdx = unrevealedIndices[Math.floor(Math.random() * unrevealedIndices.length)];
    const card = target.cards[revealIdx];
    card.revealed = true;

    const cardName = card.type === 'elder_sign' ? 'Elder Sign' : card.type === 'cthulhu' ? 'Cthulhu' : 'Futile Investigation';
    addLog(room, `${activePlayer.name} investigated ${target.name} and revealed: ${cardName}!`);

    if (card.type === 'elder_sign') room.elderSignsFound++;
    if (card.type === 'cthulhu') room.cthulhuFound = true;

    if (checkWinConditions(room)) {
      broadcastState(room);
      cb?.({ success: true, card: card.type });
      return;
    }

    room.actionsLeft--;

    // Pass active player to the investigated player
    room.activePlayerIdx = room.players.indexOf(target);

    if (room.actionsLeft <= 0) {
      // End of round
      room.round++;
      if (room.round > MAX_ROUNDS) {
        room.winner = 'cultists';
        room.phase = 'game_over';
        addLog(room, 'All rounds completed without finding all Elder Signs. The Cultists win!');
        broadcastState(room);
      } else {
        startRound(room);
      }
    } else {
      broadcastState(room);
    }
    cb?.({ success: true, card: card.type });
  });

  socket.on('chat', ({ message }) => {
    const room = rooms.get(currentRoom);
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    const sanitized = String(message).slice(0, 500);
    addLog(room, `[${player.name}]: ${sanitized}`);
    broadcastState(room);
  });

  socket.on('play_again', (_, cb) => {
    const room = rooms.get(currentRoom);
    if (!room) return cb?.({ success: false });
    const player = room.players.find(p => p.id === socket.id);
    if (!player?.isHost) return cb?.({ success: false, error: 'Only host can restart' });

    // Reset game state and remove bots
    room.phase = 'lobby';
    room.round = 0;
    room.actionsLeft = 0;
    room.activePlayerIdx = 0;
    room.elderSignsFound = 0;
    room.cthulhuFound = false;
    room.winner = null;
    room.log = [];
    room.declarationsRemaining = 0;
    room.players = room.players.filter(p => !p.isBot);
    for (const p of room.players) {
      p.role = null;
      p.cards = [];
      p.declaration = null;
    }
    addLog(room, 'Game reset. Waiting for host to start.');
    broadcastState(room);
    cb?.({ success: true });
  });

  socket.on('disconnect', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (player) {
      player.connected = false;
      addLog(room, `${player.name} disconnected.`);

      // If in lobby, remove them
      if (room.phase === 'lobby') {
        room.players = room.players.filter(p => p.id !== socket.id);
        if (room.players.length > 0 && !room.players.some(p => p.isHost)) {
          room.players[0].isHost = true;
        }
        if (room.players.length === 0) {
          rooms.delete(currentRoom);
          return;
        }
      }
      broadcastState(room);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Don't Mess With Cthulhu running on http://localhost:${PORT}`);
});
