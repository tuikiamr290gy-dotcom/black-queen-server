const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;

const server = new WebSocket.Server({
  port: PORT,
});

const waitingPlayers = [];

console.log(`Black Queen server running on port ${PORT}`);

function send(player, data) {
  if (player.readyState === WebSocket.OPEN) {
    player.send(JSON.stringify(data));
  }
}

function tryMatchPlayers() {
  while (waitingPlayers.length >= 4) {
    const players = waitingPlayers.splice(0, 4);

    const matchId =
      Math.random().toString(36).substring(2, 8).toUpperCase();

    players.forEach((player, index) => {
      player.inMatch = true;
      player.matchId = matchId;
      player.seat = index;

      send(player, {
        type: 'match_found',
        matchId: matchId,
        seat: index,
        players: players.map((p) => ({
          name: p.name || 'Player',
          seat: p.seat,
        })),
      });
    });

    console.log(`Match ${matchId} created with 4 players`);
  }
}

server.on('connection', (socket) => {
  console.log('Player connected');

  socket.name = 'Player';
  socket.inMatch = false;
  socket.matchId = null;
  socket.seat = null;

  send(socket, {
    type: 'connected',
    message: 'Connected to Black Queen server',
  });

  socket.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());

      if (data.type === 'find_match') {
        if (socket.inMatch) {
          return;
        }

        socket.name = data.name || 'Player';

        if (!waitingPlayers.includes(socket)) {
          waitingPlayers.push(socket);

          send(socket, {
            type: 'searching',
            playersWaiting: waitingPlayers.length,
            message: 'Searching for players...',
          });

          console.log(
            `${socket.name} joined matchmaking. Waiting: ${waitingPlayers.length}`
          );

          tryMatchPlayers();
        }

        return;
      }

      if (data.type === 'cancel_search') {
        const index = waitingPlayers.indexOf(socket);

        if (index !== -1) {
          waitingPlayers.splice(index, 1);
        }

        send(socket, {
          type: 'search_cancelled',
        });

        return;
      }

      if (data.type === 'ping') {
        send(socket, {
          type: 'pong',
        });

        return;
      }
    } catch (error) {
      console.error('Invalid message:', error);
    }
  });

  socket.on('close', () => {
    const index = waitingPlayers.indexOf(socket);

    if (index !== -1) {
      waitingPlayers.splice(index, 1);
    }

    console.log('Player disconnected');
  });

  socket.on('error', (error) => {
    console.error('Socket error:', error.message);
  });
});
