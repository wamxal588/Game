const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3001;

app.use(express.static(path.join(__dirname, 'public')));

const MAX_PLAYERS = 4;
const COLORS = ['red', 'green', 'yellow', 'blue'];

class RoomManager {
  constructor() {
    this.rooms = {}; // { roomId: { players, started, gameState, chat, bots } }
  }

  createRoom(roomId) {
    if (!this.rooms[roomId]) {
      this.rooms[roomId] = {
        players: [],
        started: false,
        gameState: null,
        chat: [],
        bots: [],
      };
    }
  }

  removeRoom(roomId) {
    delete this.rooms[roomId];
  }

  addPlayer(roomId, playerName, socketId, isBot = false) {
    this.createRoom(roomId);
    const room = this.rooms[roomId];
    if (room.players.length >= MAX_PLAYERS) return null;

    const playerId = uuidv4();
    const color = COLORS[room.players.length];
    const player = {
      id: playerId,
      name: playerName,
      color,
      socketId,
      pieces: [0, 0, 0, 0],
      finishedCount: 0,
      isBot,
    };
    room.players.push(player);
    if (isBot) room.bots.push(player);
    return player;
  }

  getRoom(roomId) {
    return this.rooms[roomId];
  }

  removePlayerBySocket(socketId) {
    for (const roomId of Object.keys(this.rooms)) {
      const room = this.rooms[roomId];
      const idx = room.players.findIndex(p => p.socketId === socketId);
      if (idx !== -1) {
        const removed = room.players.splice(idx, 1)[0];
        if (removed.isBot) {
          room.bots = room.bots.filter(b => b.id !== removed.id);
        }
        if (room.players.length === 0) this.removeRoom(roomId);
        return roomId;
      }
    }
    return null;
  }
}

// Bot logic: pick first possible move (very simple)
function botMove(roomId) {
  const room = roomManager.getRoom(roomId);
  if (!room || !room.started) return;

  const turnPlayer = room.players[room.gameState.turn];
  if (!turnPlayer.isBot) return; // Only bot

  // Bot rolls dice
  const dice = Math.floor(Math.random() * 6) + 1;
  room.gameState.dice = dice;
  io.to(roomId).emit('diceRolled', { dice, turn: room.gameState.turn });

  // Find possible piece to move
  let moved = false;
  for (let i = 0; i < 4; i++) {
    let pieces = turnPlayer.pieces;
    if (pieces[i] === 0 && dice === 6) {
      pieces[i] = 1;
      moved = true;
    } else if (pieces[i] > 0 && pieces[i] < 58) {
      pieces[i] += dice;
      if (pieces[i] > 58) pieces[i] = 58;
      moved = true;
    }
    if (moved) {
      turnPlayer.finishedCount = pieces.filter(p => p === 58).length;
      room.gameState.board[room.gameState.turn] = [...pieces];
      io.to(roomId).emit('boardUpdated', {
        board: room.gameState.board,
        players: room.players.map(p => ({
          name: p.name,
          color: p.color,
          pieces: p.pieces,
          finishedCount: p.finishedCount,
          isBot: !!p.isBot,
        })),
      });
      room.gameState.dice = 0;

      // Winner check
      if (turnPlayer.finishedCount === 4) {
        io.to(roomId).emit('gameEnd', { winner: turnPlayer });
        roomManager.removeRoom(roomId);
        return;
      }

      // Pass turn if dice not 6
      if (dice !== 6) {
        room.gameState.turn = (room.gameState.turn + 1) % room.players.length;
      }
      io.to(roomId).emit('turn', {
        turn: room.gameState.turn,
        color: room.players[room.gameState.turn].color,
      });

      // Bot chain: If next one is bot, move it after short delay
      setTimeout(() => {
        const nextPlayer = room.players[room.gameState.turn];
        if (nextPlayer.isBot) botMove(roomId);
      }, 1000);
      break;
    }
  }
}

const roomManager = new RoomManager();

io.on('connection', (socket) => {
  // Join Room
  socket.on('joinRoom', ({ roomId, playerName }) => {
    const player = roomManager.addPlayer(roomId, playerName, socket.id);
    if (!player) {
      socket.emit('errorMsg', { message: 'Room is full or unavailable.' });
      return;
    }
    socket.join(roomId);

    const room = roomManager.getRoom(roomId);
    io.to(roomId).emit('updatePlayers', room.players);

    // If 4 players, start immediately
    if (room.players.length === MAX_PLAYERS && !room.started) {
      room.started = true;
      room.gameState = {
        turn: 0,
        dice: 0,
        board: room.players.map(p => [...p.pieces]),
        finishedCounts: room.players.map(p => p.finishedCount),
      };
      io.to(roomId).emit('gameStarted');
      io.to(roomId).emit('turn', {
        turn: 0,
        color: room.players[0].color,
      });
      io.to(roomId).emit('gameState', {
        players: room.players.map(p => ({
          name: p.name,
          color: p.color,
          pieces: p.pieces,
          finishedCount: p.finishedCount,
          isBot: !!p.isBot,
        })),
      });
    }
  });

  // Manual start by client (for bot filling if fewer than 4)
  socket.on('startGame', ({ roomId }) => {
    const room = roomManager.getRoom(roomId);
    if (!room || room.started) return;
    // If 2 or 3 players, fill up with bots
    if (room.players.length < MAX_PLAYERS && room.players.length >= 2) {
      const botsToAdd = MAX_PLAYERS - room.players.length;
      for (let i = 1; i <= botsToAdd; i++) {
        roomManager.addPlayer(
          roomId,
          `Bot ${i}`,
          `bot-socket-${room.players.length + i}`,
          true
        );
      }
      io.to(roomId).emit('updatePlayers', room.players);
    }
    // Start game
    room.started = true;
    room.gameState = {
      turn: 0,
      dice: 0,
      board: room.players.map(p => [...p.pieces]),
      finishedCounts: room.players.map(p => p.finishedCount),
    };
    io.to(roomId).emit('gameStarted');
    io.to(roomId).emit('turn', {
      turn: 0,
      color: room.players[0].color,
    });
    io.to(roomId).emit('gameState', {
      players: room.players.map(p => ({
        name: p.name,
        color: p.color,
        pieces: p.pieces,
        finishedCount: p.finishedCount,
        isBot: !!p.isBot,
      })),
    });

    // If first turn is bot, trigger bot move
    if (room.players[0].isBot) botMove(roomId);
  });

  // Dice roll (only for real players)
  socket.on('rollDice', ({ roomId, playerId }) => {
    const room = roomManager.getRoom(roomId);
    if (!room || !room.started) return;
    const turnPlayer = room.players[room.gameState.turn];
    if (turnPlayer.id !== playerId || turnPlayer.isBot) return;

    const dice = Math.floor(Math.random() * 6) + 1;
    room.gameState.dice = dice;
    io.to(roomId).emit('diceRolled', { dice, turn: room.gameState.turn });
  });

  // Move piece (only for real players)
  socket.on('movePiece', ({ roomId, playerId, pieceIndex }) => {
    const room = roomManager.getRoom(roomId);
    if (!room || !room.started) return;
    const turnPlayer = room.players[room.gameState.turn];
    if (turnPlayer.id !== playerId || turnPlayer.isBot) return;

    const dice = room.gameState.dice;
    let pieces = turnPlayer.pieces;

    let moveSuccess = false;
    if (pieces[pieceIndex] === 0 && dice === 6) {
      pieces[pieceIndex] = 1; moveSuccess = true;
    } else if (pieces[pieceIndex] > 0 && pieces[pieceIndex] < 58) {
      pieces[pieceIndex] += dice;
      if (pieces[pieceIndex] > 58) pieces[pieceIndex] = 58;
      moveSuccess = true;
    } else {
      socket.emit('errorMsg', { message: 'Invalid move.' });
      return;
    }

    if (moveSuccess) {
      turnPlayer.finishedCount = pieces.filter(p => p === 58).length;
      room.gameState.board[room.gameState.turn] = [...pieces];
      room.gameState.dice = 0;

      io.to(roomId).emit('boardUpdated', {
        board: room.gameState.board,
        players: room.players.map(p => ({
          name: p.name,
          color: p.color,
          pieces: p.pieces,
          finishedCount: p.finishedCount,
          isBot: !!p.isBot,
        })),
      });

      // Winner check
      if (turnPlayer.finishedCount === 4) {
        io.to(roomId).emit('gameEnd', { winner: turnPlayer });
        roomManager.removeRoom(roomId);
        return;
      }

      // Pass turn if dice not 6
      if (dice !== 6) {
        room.gameState.turn = (room.gameState.turn + 1) % room.players.length;
      }
      io.to(roomId).emit('turn', {
        turn: room.gameState.turn,
        color: room.players[room.gameState.turn].color,
      });

      // If next turn is bot, trigger bot move
      const nextPlayer = room.players[room.gameState.turn];
      if (nextPlayer.isBot) setTimeout(() => botMove(roomId), 1000);
    }
  });

  // Text chat
  socket.on('chatMessage', ({ roomId, playerName, message }) => {
    const room = roomManager.getRoom(roomId);
    if (!room) return;
    const chatMsg = { playerName, message, time: Date.now() };
    room.chat.push(chatMsg);
    io.to(roomId).emit('chatUpdate', room.chat.slice(-50));
  });

  // Voice chat (WebRTC signaling)
  socket.on('webrtc', ({ roomId, data }) => {
    socket.to(roomId).emit('webrtc', data);
  });

  // Disconnect
  socket.on('disconnect', () => {
    const leftRoomId = roomManager.removePlayerBySocket(socket.id);
    if (leftRoomId) {
      const room = roomManager.getRoom(leftRoomId);
      if (room) {
        io.to(leftRoomId).emit('updatePlayers', room.players);
        io.to(leftRoomId).emit('gameState', {
          players: room.players.map(p => ({
            name: p.name,
            color: p.color,
            pieces: p.pieces,
            finishedCount: p.finishedCount,
            isBot: !!p.isBot,
          })),
        });
      }
    }
  });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));    const room = this.rooms[roomId];
    if (room.players.length >= MAX_PLAYERS) return null;

    const playerId = uuidv4();
    const color = COLORS[room.players.length];
    const player = {
      id: playerId,
      name: playerName,
      color,
      socketId,
      pieces: [0, 0, 0, 0],
      finishedCount: 0,
      isBot,
    };
    room.players.push(player);
    if (isBot) room.bots.push(player);
    return player;
  }

  getRoom(roomId) {
    return this.rooms[roomId];
  }

  removePlayerBySocket(socketId) {
    for (const roomId of Object.keys(this.rooms)) {
      const room = this.rooms[roomId];
      const idx = room.players.findIndex(p => p.socketId === socketId);
      if (idx !== -1) {
        const removed = room.players.splice(idx, 1)[0];
        if (removed.isBot) {
          room.bots = room.bots.filter(b => b.id !== removed.id);
        }
        if (room.players.length === 0) this.removeRoom(roomId);
        return roomId;
      }
    }
    return null;
  }
}

// Bot logic: pick first possible move (very simple)
function botMove(roomId) {
  const room = roomManager.getRoom(roomId);
  if (!room || !room.started) return;

  const turnPlayer = room.players[room.gameState.turn];
  if (!turnPlayer.isBot) return; // Only bot

  // Bot rolls dice
  const dice = Math.floor(Math.random() * 6) + 1;
  room.gameState.dice = dice;
  io.to(roomId).emit('diceRolled', { dice, turn: room.gameState.turn });

  // Find possible piece to move
  let moved = false;
  for (let i = 0; i < 4; i++) {
    let pieces = turnPlayer.pieces;
    if (pieces[i] === 0 && dice === 6) {
      pieces[i] = 1;
      moved = true;
    } else if (pieces[i] > 0 && pieces[i] < 58) {
      pieces[i] += dice;
      if (pieces[i] > 58) pieces[i] = 58;
      moved = true;
    }
    if (moved) {
      turnPlayer.finishedCount = pieces.filter(p => p === 58).length;
      room.gameState.board[room.gameState.turn] = [...pieces];
      io.to(roomId).emit('boardUpdated', {
        board: room.gameState.board,
        players: room.players.map(p => ({
          name: p.name,
          color: p.color,
          pieces: p.pieces,
          finishedCount: p.finishedCount,
          isBot: !!p.isBot,
        })),
      });
      room.gameState.dice = 0;

      // Winner check
      if (turnPlayer.finishedCount === 4) {
        io.to(roomId).emit('gameEnd', { winner: turnPlayer });
        roomManager.removeRoom(roomId);
        return;
      }

      // Pass turn if dice not 6
      if (dice !== 6) {
        room.gameState.turn = (room.gameState.turn + 1) % room.players.length;
      }
      io.to(roomId).emit('turn', {
        turn: room.gameState.turn,
        color: room.players[room.gameState.turn].color,
      });

      // Bot chain: If next one is bot, move it after short delay
      setTimeout(() => {
        const nextPlayer = room.players[room.gameState.turn];
        if (nextPlayer.isBot) botMove(roomId);
      }, 1000);
      break;
    }
  }
}

const roomManager = new RoomManager();

io.on('connection', (socket) => {
  // Join Room
  socket.on('joinRoom', ({ roomId, playerName }) => {
    const player = roomManager.addPlayer(roomId, playerName, socket.id);
    if (!player) {
      socket.emit('errorMsg', { message: 'Room is full or unavailable.' });
      return;
    }
    socket.join(roomId);

    const room = roomManager.getRoom(roomId);
    io.to(roomId).emit('updatePlayers', room.players);

    // If 4 players, start immediately
    if (room.players.length === MAX_PLAYERS && !room.started) {
      room.started = true;
      room.gameState = {
        turn: 0,
        dice: 0,
        board: room.players.map(p => [...p.pieces]),
        finishedCounts: room.players.map(p => p.finishedCount),
      };
      io.to(roomId).emit('gameStarted');
      io.to(roomId).emit('turn', {
        turn: 0,
        color: room.players[0].color,
      });
      io.to(roomId).emit('gameState', {
        players: room.players.map(p => ({
          name: p.name,
          color: p.color,
          pieces: p.pieces,
          finishedCount: p.finishedCount,
          isBot: !!p.isBot,
        })),
      });
    }
  });

  // Manual start by client (for bot filling if fewer than 4)
  socket.on('startGame', ({ roomId }) => {
    const room = roomManager.getRoom(roomId);
    if (!room || room.started) return;
    // If 2 or 3 players, fill up with bots
    if (room.players.length < MAX_PLAYERS && room.players.length >= 2) {
      const botsToAdd = MAX_PLAYERS - room.players.length;
      for (let i = 1; i <= botsToAdd; i++) {
        roomManager.addPlayer(
          roomId,
          `Bot ${i}`,
          `bot-socket-${room.players.length + i}`,
          true
        );
      }
      io.to(roomId).emit('updatePlayers', room.players);
    }
    // Start game
    room.started = true;
    room.gameState = {
      turn: 0,
      dice: 0,
      board: room.players.map(p => [...p.pieces]),
      finishedCounts: room.players.map(p => p.finishedCount),
    };
    io.to(roomId).emit('gameStarted');
    io.to(roomId).emit('turn', {
      turn: 0,
      color: room.players[0].color,
    });
    io.to(roomId).emit('gameState', {
      players: room.players.map(p => ({
        name: p.name,
        color: p.color,
        pieces: p.pieces,
        finishedCount: p.finishedCount,
        isBot: !!p.isBot,
      })),
    });

    // If first turn is bot, trigger bot move
    if (room.players[0].isBot) botMove(roomId);
  });

  // Dice roll (only for real players)
  socket.on('rollDice', ({ roomId, playerId }) => {
    const room = roomManager.getRoom(roomId);
    if (!room || !room.started) return;
    const turnPlayer = room.players[room.gameState.turn];
    if (turnPlayer.id !== playerId || turnPlayer.isBot) return;

    const dice = Math.floor(Math.random() * 6) + 1;
    room.gameState.dice = dice;
    io.to(roomId).emit('diceRolled', { dice, turn: room.gameState.turn });
  });

  // Move piece (only for real players)
  socket.on('movePiece', ({ roomId, playerId, pieceIndex }) => {
    const room = roomManager.getRoom(roomId);
    if (!room || !room.started) return;
    const turnPlayer = room.players[room.gameState.turn];
    if (turnPlayer.id !== playerId || turnPlayer.isBot) return;

    const dice = room.gameState.dice;
    let pieces = turnPlayer.pieces;

    let moveSuccess = false;
    if (pieces[pieceIndex] === 0 && dice === 6) {
      pieces[pieceIndex] = 1; moveSuccess = true;
    } else if (pieces[pieceIndex] > 0 && pieces[pieceIndex] < 58) {
      pieces[pieceIndex] += dice;
      if (pieces[pieceIndex] > 58) pieces[pieceIndex] = 58;
      moveSuccess = true;
    } else {
      socket.emit('errorMsg', { message: 'Invalid move.' });
      return;
    }

    if (moveSuccess) {
      turnPlayer.finishedCount = pieces.filter(p => p === 58).length;
      room.gameState.board[room.gameState.turn] = [...pieces];
      room.gameState.dice = 0;

      io.to(roomId).emit('boardUpdated', {
        board: room.gameState.board,
        players: room.players.map(p => ({
          name: p.name,
          color: p.color,
          pieces: p.pieces,
          finishedCount: p.finishedCount,
          isBot: !!p.isBot,
        })),
      });

      // Winner check
      if (turnPlayer.finishedCount === 4) {
        io.to(roomId).emit('gameEnd', { winner: turnPlayer });
        roomManager.removeRoom(roomId);
        return;
      }

      // Pass turn if dice not 6
      if (dice !== 6) {
        room.gameState.turn = (room.gameState.turn + 1) % room.players.length;
      }
      io.to(roomId).emit('turn', {
        turn: room.gameState.turn,
        color: room.players[room.gameState.turn].color,
      });

      // If next turn is bot, trigger bot move
      const nextPlayer = room.players[room.gameState.turn];
      if (nextPlayer.isBot) setTimeout(() => botMove(roomId), 1000);
    }
  });

  // Text chat
  socket.on('chatMessage', ({ roomId, playerName, message }) => {
    const room = roomManager.getRoom(roomId);
    if (!room) return;
    const chatMsg = { playerName, message, time: Date.now() };
    room.chat.push(chatMsg);
    io.to(roomId).emit('chatUpdate', room.chat.slice(-50));
  });

  // Voice chat (WebRTC signaling)
  socket.on('webrtc', ({ roomId, data }) => {
    socket.to(roomId).emit('webrtc', data);
  });

  // Disconnect
  socket.on('disconnect', () => {
    const leftRoomId = roomManager.removePlayerBySocket(socket.id);
    if (leftRoomId) {
      const room = roomManager.getRoom(leftRoomId);
      if (room) {
        io.to(leftRoomId).emit('updatePlayers', room.players);
        io.to(leftRoomId).emit('gameState', {
          players: room.players.map(p => ({
            name: p.name,
            color: p.color,
            pieces: p.pieces,
            finishedCount: p.finishedCount,
            isBot: !!p.isBot,
          })),
        });
      }
    }
  });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));    this.createRoom(roomId);
    const room = this.rooms[roomId];
    if (room.players.length >= MAX_PLAYERS) return null;

    const playerId = uuidv4();
    const color = COLORS[room.players.length];
    const player = {
      id: playerId,
      name: playerName,
      color,
      socketId,
      pieces: [0, 0, 0, 0], // 0: home, 1-57: on path, 58: finished
      finishedCount: 0, // How many pieces reached finish
    };
    room.players.push(player);
    return player;
  }

  removePlayerBySocket(socketId) {
    for (const roomId of Object.keys(this.rooms)) {
      const room = this.rooms[roomId];
      const idx = room.players.findIndex(p => p.socketId === socketId);
      if (idx !== -1) {
        room.players.splice(idx, 1);
        // If room is empty, remove it
        if (room.players.length === 0) {
          this.removeRoom(roomId);
        }
        return roomId;
      }
    }
    return null;
  }

  getRoom(roomId) {
    return this.rooms[roomId];
  }
}

const roomManager = new RoomManager();

io.on('connection', (socket) => {
  // Join Room
  socket.on('joinRoom', ({ roomId, playerName }) => {
    const player = roomManager.addPlayer(roomId, playerName, socket.id);
    if (!player) {
      socket.emit('errorMsg', { message: 'Room is full or unavailable.' });
      return;
    }
    socket.join(roomId);

    const room = roomManager.getRoom(roomId);
    io.to(roomId).emit('updatePlayers', room.players);

    // Start Game
    if (room.players.length === MAX_PLAYERS && !room.started) {
      room.started = true;
      room.gameState = {
        turn: 0,
        dice: 0,
        board: room.players.map(p => [...p.pieces]),
        finishedCounts: room.players.map(p => p.finishedCount),
      };
      io.to(roomId).emit('gameStarted');
      io.to(roomId).emit('turn', { turn: 0, color: room.players[0].color });
      io.to(roomId).emit('gameState', {
        players: room.players.map(p => ({
          name: p.name,
          color: p.color,
          pieces: p.pieces,
          finishedCount: p.finishedCount,
        }))
      });
    }
  });

  // Dice roll
  socket.on('rollDice', ({ roomId, playerId }) => {
    const room = roomManager.getRoom(roomId);
    if (!room || !room.started) return;
    const turnPlayer = room.players[room.gameState.turn];
    if (turnPlayer.id !== playerId) return;

    const dice = Math.floor(Math.random() * 6) + 1;
    room.gameState.dice = dice;
    io.to(roomId).emit('diceRolled', { dice, turn: room.gameState.turn });
  });

  // Move piece
  socket.on('movePiece', ({ roomId, playerId, pieceIndex }) => {
    const room = roomManager.getRoom(roomId);
    if (!room || !room.started) return;

    const turnPlayer = room.players[room.gameState.turn];
    if (turnPlayer.id !== playerId) return;

    const dice = room.gameState.dice;
    let pieces = turnPlayer.pieces;

    if (pieces[pieceIndex] === 0 && dice === 6) {
      pieces[pieceIndex] = 1; // Piece comes out of home
    } else if (pieces[pieceIndex] > 0 && pieces[pieceIndex] < 58) {
      pieces[pieceIndex] += dice;
      if (pieces[pieceIndex] > 58) pieces[pieceIndex] = 58;
    } else {
      socket.emit('errorMsg', { message: 'Invalid move.' });
      return;
    }

    // Count finished pieces
    turnPlayer.finishedCount = pieces.filter(p => p === 58).length;
    room.gameState.board[room.gameState.turn] = [...pieces];
    room.gameState.finishedCounts[room.gameState.turn] = turnPlayer.finishedCount;

    // Send full game state to all clients (for real-time sync)
    io.to(roomId).emit('boardUpdated', {
      board: room.gameState.board,
      players: room.players.map(p => ({
        name: p.name,
        color: p.color,
        pieces: p.pieces,
        finishedCount: p.finishedCount,
      }))
    });
    room.gameState.dice = 0;

    // Turn change
    if (dice !== 6) {
      room.gameState.turn = (room.gameState.turn + 1) % room.players.length;
    }
    io.to(roomId).emit('turn', { turn: room.gameState.turn, color: room.players[room.gameState.turn].color });

    // Winner check
    if (turnPlayer.finishedCount === 4) {
      io.to(roomId).emit('gameEnd', { winner: turnPlayer });
      roomManager.removeRoom(roomId);
    }
  });

  // Text chat
  socket.on('chatMessage', ({ roomId, playerName, message }) => {
    const room = roomManager.getRoom(roomId);
    if (!room) return;
    const chatMsg = { playerName, message, time: Date.now() };
    room.chat.push(chatMsg);
    io.to(roomId).emit('chatUpdate', room.chat.slice(-50));
  });

  // Voice chat (WebRTC signaling)
  socket.on('webrtc', ({ roomId, data }) => {
    // Forward signaling data to other clients in the room
    socket.to(roomId).emit('webrtc', data);
  });

  // Disconnect
  socket.on('disconnect', () => {
    const leftRoomId = roomManager.removePlayerBySocket(socket.id);
    if (leftRoomId) {
      const room = roomManager.getRoom(leftRoomId);
      if (room) {
        io.to(leftRoomId).emit('updatePlayers', room.players);
        io.to(leftRoomId).emit('gameState', {
          players: room.players.map(p => ({
            name: p.name,
            color: p.color,
            pieces: p.pieces,
            finishedCount: p.finishedCount,
          }))
        });
      }
    }
  });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));    if (rooms[roomId].players.length === 4 && !rooms[roomId].started) {
      rooms[roomId].started = true;
      rooms[roomId].gameState = {
        turn: 0,
        dice: 0,
        board: rooms[roomId].players.map(p => [...p.pieces]),
      };
      io.to(roomId).emit('gameStarted');
      io.to(roomId).emit('turn', { turn: 0, color: rooms[roomId].players[0].color });
    }
  });

  // Zar atma
  socket.on('rollDice', ({ roomId, playerId }) => {
    const game = rooms[roomId];
    if (!game || !game.started) return;
    const turnPlayer = game.players[game.gameState.turn];
    if (turnPlayer.id !== playerId) return;
    const dice = Math.floor(Math.random() * 6) + 1;
    game.gameState.dice = dice;
    io.to(roomId).emit('diceRolled', { dice, turn: game.gameState.turn });
  });

  // Taş oynatma/çıkarma
  socket.on('movePiece', ({ roomId, playerId, pieceIndex }) => {
    const game = rooms[roomId];
    if (!game || !game.started) return;
    const turnPlayer = game.players[game.gameState.turn];
    if (turnPlayer.id !== playerId) return;
    const dice = game.gameState.dice;
    let pieces = turnPlayer.pieces;

    if (pieces[pieceIndex] === 0 && dice === 6) {
      pieces[pieceIndex] = 1; // Taşı çıkar
    } else if (pieces[pieceIndex] > 0 && pieces[pieceIndex] < 58) {
      pieces[pieceIndex] += dice;
      if (pieces[pieceIndex] > 58) pieces[pieceIndex] = 58;
    } else {
      return; // Hamle geçersiz
    }
    game.gameState.board[game.gameState.turn] = [...pieces];
    io.to(roomId).emit('boardUpdated', { board: game.gameState.board });
    game.gameState.dice = 0;

    // 6 atınca tekrar mı oynasın?
    if (dice !== 6) {
      game.gameState.turn = (game.gameState.turn + 1) % game.players.length;
    }
    io.to(roomId).emit('turn', { turn: game.gameState.turn, color: game.players[game.gameState.turn].color });

    // Kazanan kontrolü
    if (pieces.every(p => p === 58)) {
      io.to(roomId).emit('gameEnd', { winner: turnPlayer });
      delete rooms[roomId];
    }
  });

  // Yazılı Sohbet
  socket.on('chatMessage', ({ roomId, playerName, message }) => {
    if (!rooms[roomId]) return;
    const chatMsg = { playerName, message, time: Date.now() };
    rooms[roomId].chat.push(chatMsg);
    io.to(roomId).emit('chatUpdate', rooms[roomId].chat.slice(-20));
  });

  // Sesli Sohbet (WebRTC sinyal)
  socket.on('webrtc', ({ roomId, data }) => {
    socket.to(roomId).emit('webrtc', data);
  });

  socket.on('disconnect', () => {
    Object.keys(rooms).forEach(roomId => {
      const idx = rooms[roomId].players.findIndex(p => p.socketId === socket.id);
      if (idx !== -1) {
        rooms[roomId].players.splice(idx, 1);
        io.to(roomId).emit('updatePlayers', rooms[roomId].players);
      }
      if (rooms[roomId].players.length === 0) delete rooms[roomId];
    });
  });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
