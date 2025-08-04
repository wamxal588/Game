const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3001;

// Statik dosyaları sun
app.use(express.static(path.join(__dirname, 'public')));

let rooms = {}; // { roomId: { players, started, gameState, chat } }

io.on('connection', (socket) => {
  // Katılma
  socket.on('joinRoom', ({ roomId, playerName }) => {
    if (!rooms[roomId]) rooms[roomId] = { players: [], started: false, gameState: null, chat: [] };
    if (rooms[roomId].players.length >= 4) return;
    const playerId = uuidv4();
    const colorList = ['red', 'green', 'yellow', 'blue'];
    const color = colorList[rooms[roomId].players.length];
    rooms[roomId].players.push({
      id: playerId,
      name: playerName,
      color,
      socketId: socket.id,
      pieces: [0, 0, 0, 0], // 0: evde, 1-57: yolda, 58: bitiş
    });
    socket.join(roomId);
    io.to(roomId).emit('updatePlayers', rooms[roomId].players);

    // Oyun başlasın mı?
    if (rooms[roomId].players.length === 4 && !rooms[roomId].started) {
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
