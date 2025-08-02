const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3001;

// Statik frontend dosyalarını sun
app.use(express.static(path.join(__dirname, 'public')));

let rooms = {}; // roomId: {players, started}

io.on('connection', (socket) => {
    socket.on('joinRoom', ({ roomId, playerName }) => {
        if (!rooms[roomId]) rooms[roomId] = { players: [], started: false };
        if (rooms[roomId].players.length >= 4) return; // max 4 oyuncu
        const playerId = uuidv4();
        rooms[roomId].players.push({ id: playerId, name: playerName, socketId: socket.id, currentFloor: 4, alive: true });
        socket.join(roomId);
        io.to(roomId).emit('updatePlayers', rooms[roomId].players);
        // Oyun başlatılacak mı?
        if (rooms[roomId].players.length === 4 && !rooms[roomId].started) {
            rooms[roomId].started = true;
            io.to(roomId).emit('gameStarted');
        }
    });

    socket.on('chooseHole', ({ roomId, playerId, holeIndex }) => {
        let game = rooms[roomId];
        if (!game) return;
        let player = game.players.find(p => p.id === playerId);
        if (!player || !player.alive || player.currentFloor <= 1) return;
        // Deliklerden biri lav, biri güvenli (random)
        let safeHole = Math.floor(Math.random() * 2);
        if (holeIndex === safeHole) {
            player.currentFloor--;
        } else {
            player.alive = false;
        }
        io.to(roomId).emit('playerResult', { playerId, result: player.alive ? 'safe' : 'lava', currentFloor: player.currentFloor });
        checkGameEnd(roomId);
    });

    socket.on('webrtc', ({ roomId, data }) => {
        socket.to(roomId).emit('webrtc', data);
    });

    socket.on('disconnect', () => {
        Object.keys(rooms).forEach(roomId => {
            rooms[roomId].players = rooms[roomId].players.filter(p => p.socketId !== socket.id);
            io.to(roomId).emit('updatePlayers', rooms[roomId].players);
        });
    });
});

function checkGameEnd(roomId) {
    const game = rooms[roomId];
    if (!game) return;
    const alivePlayers = game.players.filter(p => p.alive);
    // Kazanan: 1. kata ilk inen veya tek hayatta kalan
    let winner = null;
    if (alivePlayers.some(p => p.currentFloor === 1)) {
        winner = alivePlayers.find(p => p.currentFloor === 1);
    } else if (alivePlayers.length === 1) {
        winner = alivePlayers[0];
    }
    if (winner) {
        io.to(roomId).emit('gameEnd', { winner });
        delete rooms[roomId];
    }
}

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));        }
        checkGameEnd(roomId);
    });

    socket.on('disconnect', () => {
        Object.keys(rooms).forEach(roomId => {
            rooms[roomId].players = rooms[roomId].players.filter(p => p.socketId !== socket.id);
            io.to(roomId).emit('updatePlayers', rooms[roomId].players);
        });
    });

    // WebRTC sinyalleri (forward)
    socket.on('webrtc', ({ roomId, data }) => {
        socket.to(roomId).emit('webrtc', data);
    });
});

function startGame(roomId) {
    rooms[roomId].gameState = 'started';
    io.to(roomId).emit('gameStarted');
}

function checkGameEnd(roomId) {
    const game = rooms[roomId];
    if (!game) return;
    const alivePlayers = game.players.filter(p => p.alive);
    if (alivePlayers.length === 1) {
        io.to(roomId).emit('gameEnd', { winner: alivePlayers[0] });
        delete rooms[roomId];
    } else if (alivePlayers.some(p => p.currentFloor === 1)) {
        const winner = alivePlayers.find(p => p.currentFloor === 1);
        io.to(roomId).emit('gameEnd', { winner });
        delete rooms[roomId];
    }
}

server.listen(3001, () => console.log('Server running on port 3001'));
