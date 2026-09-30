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

// Suit numbers MUST match Flutter game_logic.dart:
// 0 = Spades
// 1 = Hearts
// 2 = Diamonds
// 3 = Clubs

function createCard(suit, rank) {
  return {
    s: suit,
    r: rank,
  };
}

function sameCard(a, b) {
  return a.s === b.s && a.r === b.r;
}

function createDeck() {
  const deck = [];

  for (let suit = 0; suit < 4; suit++) {
    for (let rank = 2; rank <= 14; rank++) {
      deck.push(createCard(suit, rank));
    }
  }

  // Shuffle
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));

    const temp = deck[i];
    deck[i] = deck[j];
    deck[j] = temp;
  }

  return deck;
}

function sortHand(hand) {
  hand.sort((a, b) => {
    if (a.s !== b.s) {
      return a.s - b.s;
    }

    return b.r - a.r;
  });
}

function cardPoints(card) {
  // Black Queen = Queen of Spades
  if (card.s === 0 && card.r === 12) {
    return 12;
  }

  // Every Heart = 1 point
  if (card.s === 1) {
    return 1;
  }

  return 0;
}

function legalCard(hand, trick, selectedCard) {
  // Player must actually have the card.
  if (!hand.some((c) => sameCard(c, selectedCard))) {
    return false;
  }

  // First card of trick: anything can be played.
  if (trick.length === 0) {
    return true;
  }

  const ledSuit = trick[0].card.s;

  // Check whether player has the first suit.
  const hasLedSuit = hand.some(
    (c) => c.s === ledSuit
  );

  // If they have that suit, they must follow it.
  if (hasLedSuit && selectedCard.s !== ledSuit) {
    return false;
  }

  return true;
}

function findTrickWinner(trick) {
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

function dealNewRound(match) {
  const deck = createDeck();

  match.hands = [
    [],
    [],
    [],
    [],
  ];

  // 13 cards per player.
  for (let seat = 0; seat < 4; seat++) {
    match.hands[seat] = deck.slice(
      seat * 13,
      seat * 13 + 13
    );

    sortHand(match.hands[seat]);
  }

  match.trick = [];
  match.tricksPlayed = 0;

  // Winner of previous deal starts the next deal.
  match.currentSeat = match.firstSeat;

  match.dealNumber++;

  // Send each player ONLY their own cards.
  for (let seat = 0; seat < 4; seat++) {
    send(match.players[seat], {
      type: 'hand',
      hand: match.hands[seat],
    });
  }

  broadcast(match, {
    type: 'deal_start',
    dealNumber: match.dealNumber,
    currentSeat: match.currentSeat,
    names: match.players.map(
      (player) => player.name || 'Player'
    ),
    isBot: [
      false,
      false,
      false,
      false,
    ],
  });

  console.log(
    `Match ${match.id}: Deal ${match.dealNumber} started`
  );
}

function startMatch(players) {
  const matchId = Math.random()
    .toString(36)
    .substring(2, 8)
    .toUpperCase();

  const match = {
    id: matchId,

    players: players,

    hands: [
      [],
      [],
      [],
      [],
    ],

    scores: [
      0,
      0,
      0,
      0,
    ],

    trick: [],

    tricksPlayed: 0,

    dealNumber: 0,

    // Player 1 starts the first deal.
    firstSeat: 0,

    currentSeat: 0,

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

      matchId: matchId,

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

  // Give the clients a moment to open the game screen.
  setTimeout(() => {
    if (!match.finished) {
      dealNewRound(match);
    }
  }, 1000);
}

function tryMatchPlayers() {
  while (waitingPlayers.length >= 4) {
    const players =
      waitingPlayers.splice(0, 4);

    startMatch(players);
  }
}

function finishMatch(match) {
  if (match.finished) {
    return;
  }

  match.finished = true;

  // Lowest score wins.
  let winner = 0;

  for (let i = 1; i < 4; i++) {
    if (
      match.scores[i] <
      match.scores[winner]
    ) {
      winner = i;
    }
  }

  broadcast(match, {
    type: 'game_over',

    scores: match.scores,

    winner: winner,

    winnerName:
      match.players[winner].name ||
      'Player',

    reason:
      'A player reached 100 points.',
  });

  console.log(
    `Match ${match.id} finished. Winner: ${match.players[winner].name} with ${match.scores[winner]} points`
  );
}

function playCard(match, player, data) {
  if (match.finished) {
    return;
  }

  const seat = player.seat;

  // Wrong player trying to play.
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

  // Check legal move.
  if (
    !legalCard(
      hand,
      match.trick,
      selectedCard
    )
  ) {
    send(player, {
      type: 'error',
      message:
        'You must play a card of the first suit.',
    });

    return;
  }

  // Find card in hand.
  const cardIndex = hand.findIndex(
    (card) =>
      sameCard(card, selectedCard)
  );

  if (cardIndex === -1) {
    send(player, {
      type: 'error',
      message:
        'You do not have this card.',
    });

    return;
  }

  const playedCard =
    hand.splice(cardIndex, 1)[0];

  match.trick.push({
    seat: seat,
    card: playedCard,
  });

  // Not all four players have played yet.
  if (match.trick.length < 4) {
    match.currentSeat =
      (seat + 1) % 4;

    broadcast(match, {
      type: 'played',

      trick: match.trick,

      currentSeat:
        match.currentSeat,
    });

    return;
  }

  // Four cards have been played.
  const finishedTrick =
    [...match.trick];

  const winner =
    findTrickWinner(
      finishedTrick
    );

  let points = 0;

  for (const played of finishedTrick) {
    points += cardPoints(
      played.card
    );
  }

  // Add points to trick winner.
  match.scores[winner] += points;

  match.tricksPlayed++;

  // Winner starts next trick.
  match.currentSeat = winner;

  const scores = [
    ...match.scores,
  ];

  const reached100 =
    match.scores.some(
      (score) => score >= 100
    );

  const dealFinished =
    match.tricksPlayed === 13;

  // Clear current trick.
  match.trick = [];

  // Send trick result.
  broadcast(match, {
    type: 'trick_result',

    trick: finishedTrick,

    scores: scores,

    currentSeat:
      match.currentSeat,

    dealOver:
      reached100 || dealFinished,

    winner: winner,

    points: points,
  });

  // IMPORTANT:
  // Online game ends immediately if
  // ANY player reaches 100.
  if (reached100) {
    setTimeout(() => {
      finishMatch(match);
    }, 1800);

    return;
  }

  // Deal finished but nobody reached 100.
  // Start another deal automatically.
  if (dealFinished) {
    match.firstSeat =
      match.currentSeat;

    setTimeout(() => {
      if (!match.finished) {
        dealNewRound(match);
      }
    }, 1800);
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
    message:
      'Connected to Black Queen server',
  });

  socket.on('message', (message) => {
    try {
      const data =
        JSON.parse(
          message.toString()
        );

      // FIND MATCH
      if (
        data.type === 'find_match'
      ) {
        if (socket.inMatch) {
          return;
        }

        socket.name =
          data.name || 'Player';

        if (
          !waitingPlayers.includes(
            socket
          )
        ) {
          waitingPlayers.push(
            socket
          );

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

      // CANCEL SEARCH
      if (
        data.type ===
        'cancel_search'
      ) {
        const index =
          waitingPlayers.indexOf(
            socket
          );

        if (index !== -1) {
          waitingPlayers.splice(
            index,
            1
          );
        }

        send(socket, {
          type: 'search_cancelled',
        });

        return;
      }

      // PLAY CARD
      if (
        data.type === 'play'
      ) {
        if (!socket.inMatch) {
          send(socket, {
            type: 'error',
            message:
              'You are not in a match.',
          });

          return;
        }

        const match =
          matches.get(
            socket.matchId
          );

        if (!match) {
          send(socket, {
            type: 'error',
            message:
              'Match not found.',
          });

          return;
        }

        playCard(
          match,
          socket,
          data
        );

        return;
      }

      // The server automatically starts
      // the next deal.
      if (
        data.type ===
        'next_deal'
      ) {
        return;
      }

      // PING
      if (
        data.type === 'ping'
      ) {
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
      waitingPlayers.indexOf(
        socket
      );

    if (waitingIndex !== -1) {
      waitingPlayers.splice(
        waitingIndex,
        1
      );
    }

    // If a player leaves an active match,
    // end that match for the remaining players.
    if (socket.inMatch) {
      const match =
        matches.get(
          socket.matchId
        );

      if (
        match &&
        !match.finished
      ) {
        match.finished = true;

        match.players.forEach(
          (player) => {
            if (
              player !== socket &&
              player.readyState ===
                WebSocket.OPEN
            ) {
              send(player, {
                type:
                  'disconnected',

                message:
                  'A player disconnected from the match.',
              });
            }
          }
        );

        matches.delete(
          socket.matchId
        );
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
