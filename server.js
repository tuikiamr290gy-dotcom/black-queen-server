const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;

const server = new WebSocket.Server({
  port: PORT,
});

const waitingPlayers = [];
const matches = new Map();

console.log(`Black Queen server running on port ${PORT}`);

function send(player, data) {
  if (player.readyState === WebSocket.OPEN) {
    player.send(JSON.stringify(data));
  }
}

function broadcast(match, data) {
  match.players.forEach((player) => {
    send(player, data);
  });
}

function card(suit, rank) {
  return { s: suit, r: rank };
}

function cardKey(c) {
  return `${c.s}:${c.r}`;
}

function createDeck() {
  const deck = [];

  // Suit:
  // 0 = spades
  // 1 = hearts
  // 2 = diamonds
  // 3 = clubs
  for (let suit = 0; suit < 4; suit++) {
    for (let rank = 2; rank <= 14; rank++) {
      deck.push(card(suit, rank));
    }
  }

  // Fisher-Yates shuffle
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }

  return deck;
}

function cardPoints(c) {
  // Queen of Spades = 12
  if (c.s === 0 && c.r === 12) {
    return 12;
  }

  // Every Heart = 1
  if (c.s === 1) {
    return 1;
  }

  return 0;
}

function sameCard(a, b) {
  return a.s === b.s && a.r === b.r;
}

function hasCard(hand, cardToFind) {
  return hand.some((c) => sameCard(c, cardToFind));
}

function legalCard(hand, playedCards, selectedCard) {
  if (!hasCard(hand, selectedCard)) {
    return false;
  }

  // First card of trick: anything is allowed.
  if (playedCards.length === 0) {
    return true;
  }

  const ledSuit = playedCards[0].card.s;

  // If player has the led suit, they must follow it.
  const hasLedSuit = hand.some((c) => c.s === ledSuit);

  if (hasLedSuit && selectedCard.s !== ledSuit) {
    return false;
  }

  return true;
}

function trickWinner(trick) {
  const ledSuit = trick[0].card.s;

  let winner = trick[0];

  for (const played of trick) {
    if (
      played.card.s === ledSuit &&
      played.card.r > winner.card.r
    ) {
      winner = played;
    }
  }

  return winner.seat;
}

function dealCards(match) {
  const deck = createDeck();

  match.hands = [[], [], [], []];

  for (let seat = 0; seat < 4; seat++) {
    match.hands[seat] = deck.slice(
      seat * 13,
      (seat + 1) * 13
    );

    // Same sorting style as Flutter:
    // suit first, then rank high to low.
    match.hands[seat].sort((a, b) => {
      if (a.s !== b.s) {
        return a.s - b.s;
      }

      return b.r - a.r;
    });
  }

  match.trick = [];
  match.tricksPlayed = 0;
  match.currentSeat = match.firstSeat;
  match.dealNumber++;

  match.players.forEach((player, seat) => {
    send(player, {
      type: 'hand',
      hand: match.hands[seat],
    });
  });

  broadcast(match, {
    type: 'deal_start',
    dealNumber: match.dealNumber,
    currentSeat: match.currentSeat,
    names: match.players.map(
      (p) => p.name || 'Player'
    ),
    isBot: [false, false, false, false],
  });
}

function startMatch(players) {
  const matchId = Math.random()
    .toString(36)
    .substring(2, 8)
    .toUpperCase();

  const match = {
    id: matchId,
    players,
    hands: [[], [], [], []],
    scores: [0, 0, 0, 0],
    trick: [],
    tricksPlayed: 0,
    dealNumber: 0,
    currentSeat: 0,
    firstSeat: 0,
    finished: false,
  };

  matches.set(matchId, match);

  players.forEach((player, index) => {
    player.inMatch = true;
    player.matchId = matchId;
    player.seat = index;
  });

  players.forEach((player, index) => {
    send(player, {
      type: 'match_found',
      matchId,
      seat: index,
      players: players.map((p) => ({
        name: p.name || 'Player',
        seat: p.seat,
      })),
    });
  });

  console.log(
    `Match ${matchId} created with 4 players`
  );

  // Start the first deal.
  setTimeout(() => {
    if (!match.finished) {
      dealCards(match);
    }
  }, 1000);
}

function tryMatchPlayers() {
  while (waitingPlayers.length >= 4) {
    const players = waitingPlayers.splice(0, 4);
    startMatch(players);
  }
}

function finishOnlineGame(match) {
  if (match.finished) {
    return;
  }

  match.finished = true;

  // Lowest score wins.
  let winner = 0;

  for (let i = 1; i < 4; i++) {
    if (match.scores[i] < match.scores[winner]) {
      winner = i;
    }
  }

  broadcast(match, {
    type: 'game_over',
    scores: match.scores,
    winner: winner,
    winnerName:
      match.players[winner].name || 'Player',
    reason: 'A player reached 100 points.',
  });

  console.log(
    `Match ${match.id} finished. Winner: ${match.players[winner].name} (${match.scores[winner]} points)`
  );
}

function handlePlay(match, player, data) {
  if (match.finished) {
    return;
  }

  const seat = player.seat;

  if (seat !== match.currentSeat) {
    send(player, {
      type: 'error',
      message: 'It is not your turn.',
    });
    return;
  }

  const selectedCard = data.card;

  if (
    !selectedCard ||
    typeof selectedCard.s !== 'number' ||
    typeof selectedCard.r !== 'number'
  ) {
    send(player, {
      type: 'error',
      message: 'Invalid card.',
    });
    return;
  }

  const hand = match.hands[seat];

  if (!legalCard(
    hand,
    match.trick,
    selectedCard
  )) {
    send(player, {
      type: 'error',
      message:
        'You must play a card of the first suit.',
    });
    return;
  }

  const cardIndex = hand.findIndex(
    (c) => sameCard(c, selectedCard)
  );

  if (cardIndex === -1) {
    send(player, {
      type: 'error',
      message: 'You do not have this card.',
    });
    return;
  }

  const playedCard = hand.splice(
    cardIndex,
    1
  )[0];

  match.trick.push({
    seat,
    card: playedCard,
  });

  // Not everyone has played yet.
  if (match.trick.length < 4) {
    match.currentSeat = (seat + 1) % 4;

    broadcast(match, {
      type: 'played',
      trick: match.trick,
      currentSeat: match.currentSeat,
    });

    return;
  }

  // Four players have played.
  const finishedTrick = [...match.trick];

  const winner = trickWinner(
    finishedTrick
  );

  const points = finishedTrick.reduce(
    (sum, played) =>
      sum + cardPoints(played.card),
    0
  );

  match.scores[winner] += points;

  match.tricksPlayed++;

  match.currentSeat = winner;

  const allCardsFinished =
    match.tricksPlayed === 13;

  // ONLINE-ONLY RULE:
  // The game ends immediately when ANY player
  // reaches 100 or more points.
  const someoneReached100 =
    match.scores.some(
      (score) => score >= 100
    );

  const gameFinished =
    someoneReached100 || allCardsFinished;

  match.trick = [];

  broadcast(match, {
    type: 'trick_result',
    trick: finishedTrick,
    scores: match.scores,
    currentSeat: match.currentSeat,
    dealOver: gameFinished,
    winner,
    points,
  });

  if (gameFinished) {
    if (someoneReached100) {
      setTimeout(() => {
        finishOnlineGame(match);
      }, 1700);
    } else {
      // A deal normally has 13 tricks.
      // In online mode we continue to the next deal
      // unless someone has reached 100.
      setTimeout(() => {
        if (!match.finished) {
          match.firstSeat = match.currentSeat;
          dealCards(match);
        }
      }, 1800);
    }

    return;
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
      const data = JSON.parse(
        message.toString()
      );

      if (data.type === 'find_match') {
        if (socket.inMatch) {
          return;
        }

        socket.name =
          data.name || 'Player';

        if (!waitingPlayers.includes(socket)) {
          waitingPlayers.push(socket);

          send(socket, {
            type: 'searching',
            playersWaiting:
              waitingPlayers.length,
            message:
              'Searching for players...',
          });

          console.log(
            `${socket.name} joined matchmaking. Waiting: ${waitingPlayers.length}`
          );

          tryMatchPlayers();
        }

        return;
      }

      if (data.type === 'cancel_search') {
        const index =
          waitingPlayers.indexOf(socket);

        if (index !== -1) {
          waitingPlayers.splice(index, 1);
        }

        send(socket, {
          type: 'search_cancelled',
        });

        return;
      }

      if (data.type === 'play') {
        if (!socket.inMatch) {
          send(socket, {
            type: 'error',
            message: 'You are not in a match.',
          });
          return;
        }

        const match =
          matches.get(socket.matchId);

        if (!match) {
          send(socket, {
            type: 'error',
            message: 'Match not found.',
          });
          return;
        }

        handlePlay(
          match,
          socket,
          data
        );

        return;
      }

      if (data.type === 'next_deal') {
        const match =
          matches.get(socket.matchId);

        if (!match || match.finished) {
          return;
        }

        // The server automatically starts the
        // next deal, so this message is ignored.
        return;
      }

      if (data.type === 'ping') {
        send(socket, {
          type: 'pong',
        });

        return;
      }
    } catch (error) {
      console.error(
        'Invalid message:',
        error
      );
    }
  });

  socket.on('close', () => {
    const waitingIndex =
      waitingPlayers.indexOf(socket);

    if (waitingIndex !== -1) {
      waitingPlayers.splice(
        waitingIndex,
        1
      );
    }

    if (socket.inMatch) {
      const match =
        matches.get(socket.matchId);

      if (match && !match.finished) {
        match.finished = true;

        match.players.forEach(
          (player) => {
            if (
              player !== socket &&
              player.readyState ===
                WebSocket.OPEN
            ) {
              send(player, {
                type: 'disconnected',
                message:
                  'A player disconnected from the match.',
              });
            }
          }
        );

        matches.delete(socket.matchId);
      }
    }

    console.log(
      `${socket.name} disconnected`
    );
  });

  socket.on('error', (error) => {
    console.error(
      'Socket error:',
      error.message
    );
  });
});
