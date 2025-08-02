const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

let rooms = {};

io.on('connection', (socket) => {
    socket.on('joinRoom', ({ roomId, playerName }) => {
        if (!rooms[roomId]) rooms[roomId] = { players: [], gameState: null };
        const playerId = uuidv4();
        rooms[roomId].players.push({ id: playerId, name: playerName, socketId: socket.id, currentFloor: 4, alive: true });
        socket.join(roomId);
        io.to(roomId).emit('updatePlayers', rooms[roomId].players);
        if (rooms[roomId].players.length === 4) {
            startGame(roomId);
        }
    });

    socket.on('chooseHole', ({ roomId, playerId, holeIndex }) => {
        // Game logic
        let game = rooms[roomId];
        if (!game) return;
        let player = game.players.find(p => p.id === playerId);
        if (!player || !player.alive) return;
        let isLava = Math.random() < 0.5 ? holeIndex === 0 : holeIndex === 1;
        if (isLava) {
            player.alive = false;
            io.to(roomId).emit('playerResult', { playerId, result: 'lava', currentFloor: player.currentFloor });
        } else {
            player.currentFloor--;
            io.to(roomId).emit('playerResult', { playerId, result: 'safe', currentFloor: player.currentFloor });
        }
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
