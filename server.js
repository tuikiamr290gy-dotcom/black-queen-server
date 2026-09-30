const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;

// TEMPORARY TEST MODE
// true  = 1 real player + 3 bots
// false = 4 real players
const TEST_MODE = true;

const server = new WebSocket.Server({
  port: PORT,
});

const waitingPlayers = [];
const matches = new Map();

console.log(`Black Queen server running on port ${PORT}`);
console.log(`TEST MODE: ${TEST_MODE}`);

function send(player, data) {
  if (
    player &&
    !player.isBot &&
    player.socket &&
    player.socket.readyState === WebSocket.OPEN
  ) {
    player.socket.send(JSON.stringify(data));
  }
}

function broadcast(match, data) {
  match.players.forEach((player) => {
    send(player, data);
  });
}

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
  // Queen of Spades = 12 points
  if (card.s === 0 && card.r === 12) {
    return 12;
  }

  // Every heart = 1 point
  if (card.s === 1) {
    return 1;
  }

  return 0;
}

function legalCard(hand, trick, selectedCard) {
  if (!hand.some((c) => sameCard(c, selectedCard))) {
    return false;
  }

  if (trick.length === 0) {
    return true;
  }

  const ledSuit = trick[0].card.s;

  const hasLedSuit = hand.some(
    (c) => c.s === ledSuit
  );

  if (hasLedSuit && selectedCard.s !== ledSuit) {
    return false;
  }

  return true;
}

function getLegalCards(hand, trick) {
  if (trick.length === 0) {
    return [...hand];
  }

  const ledSuit = trick[0].card.s;

  const sameSuit = hand.filter(
    (card) => card.s === ledSuit
  );

  if (sameSuit.length > 0) {
    return sameSuit;
  }

  return [...hand];
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

  for (let seat = 0; seat < 4; seat++) {
    match.hands[seat] = deck.slice(
      seat * 13,
      seat * 13 + 13
    );

    sortHand(match.hands[seat]);
  }

  match.trick = [];
  match.tricksPlayed = 0;
  match.currentSeat = match.firstSeat;
  match.dealNumber++;

  // Send only the real player's hand.
  for (let seat = 0; seat < 4; seat++) {
    const player = match.players[seat];

    if (!player.isBot) {
      send(player, {
        type: 'hand',
        hand: match.hands[seat],
      });
    }
  }

  broadcast(match, {
    type: 'deal_start',
    dealNumber: match.dealNumber,
    currentSeat: match.currentSeat,
    names: match.players.map(
      (player) => player.name
    ),
    isBot: match.players.map(
      (player) => player.isBot
    ),
  });

  console.log(
    `Match ${match.id}: Deal ${match.dealNumber} started`
  );

  // If a bot starts, let it play.
  setTimeout(() => {
    playBotIfNeeded(match);
  }, 700);
}

function createBot(name, seat) {
  return {
    name: name,
    seat: seat,
    isBot: true,
    socket: null,
    inMatch: true,
    matchId: null,
  };
}

function createMatch(realPlayer) {
  const players = [
    realPlayer,
    createBot('Bot 2', 1),
    createBot('Bot 3', 2),
    createBot('Bot 4', 3),
  ];

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

    firstSeat: 0,

    currentSeat: 0,

    finished: false,
  };

  realPlayer.inMatch = true;
  realPlayer.matchId = matchId;
  realPlayer.seat = 0;

  players.forEach((player) => {
    player.matchId = matchId;
  });

  matches.set(matchId, match);

  send(realPlayer, {
    type: 'match_found',

    matchId: matchId,

    seat: 0,

    players: players.map((player) => ({
      name: player.name,
      seat: player.seat,
    })),
  });

  console.log(
    `TEST MATCH ${matchId}: ${realPlayer.name} + 3 bots`
  );

  setTimeout(() => {
    if (!match.finished) {
      dealNewRound(match);
    }
  }, 1000);
}

function tryMatchPlayers() {
  if (TEST_MODE) {
    if (waitingPlayers.length >= 1) {
      const player = waitingPlayers.shift();

      createMatch(player);
    }

    return;
  }

  while (waitingPlayers.length >= 4) {
    const players =
      waitingPlayers.splice(0, 4);

    startRealMatch(players);
  }
}

function startRealMatch(players) {
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
        name: p.name,
        seat: p.seat,
      })),
    });
  });

  setTimeout(() => {
    if (!match.finished) {
      dealNewRound(match);
    }
  }, 1000);
}

function finishMatch(match) {
  if (match.finished) {
    return;
  }

  match.finished = true;

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
      match.players[winner].name,

    players: match.players.map(
      (player) => ({
        name: player.name,
        seat: player.seat,
        isBot: player.isBot,
      })
    ),

    reason:
      'A player reached 100 points.',
  });

  console.log(
    `Match ${match.id} finished. Winner: ${match.players[winner].name}`
  );

  setTimeout(() => {
    matches.delete(match.id);
  }, 5000);
}

function finishTrick(match) {
  const finishedTrick = [
    ...match.trick,
  ];

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

  match.scores[winner] += points;

  match.tricksPlayed++;

  match.currentSeat = winner;

  const reached100 =
    match.scores.some(
      (score) => score >= 100
    );

  const dealFinished =
    match.tricksPlayed === 13;

  match.trick = [];

  broadcast(match, {
    type: 'trick_result',

    trick: finishedTrick,

    scores: [
      ...match.scores,
    ],

    currentSeat:
      match.currentSeat,

    dealOver:
      reached100 || dealFinished,

    winner: winner,

    points: points,
  });

  if (reached100) {
    setTimeout(() => {
      finishMatch(match);
    }, 1800);

    return;
  }

  if (dealFinished) {
    match.firstSeat =
      match.currentSeat;

    setTimeout(() => {
      if (!match.finished) {
        dealNewRound(match);
      }
    }, 1800);

    return;
  }

  setTimeout(() => {
    playBotIfNeeded(match);
  }, 500);
}

function playCard(match, player, data) {
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
        'You must follow the first suit if possible.',
    });

    return;
  }

  const cardIndex =
    hand.findIndex(
      (card) =>
        sameCard(
          card,
          selectedCard
        )
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
    hand.splice(
      cardIndex,
      1
    )[0];

  match.trick.push({
    seat: seat,
    card: playedCard,
  });

  // Four cards = trick finished.
  if (match.trick.length === 4) {
    finishTrick(match);
    return;
  }

  match.currentSeat =
    (seat + 1) % 4;

  broadcast(match, {
    type: 'played',

    trick: match.trick,

    currentSeat:
      match.currentSeat,
  });

  setTimeout(() => {
    playBotIfNeeded(match);
  }, 500);
}

function playBotIfNeeded(match) {
  if (match.finished) {
    return;
  }

  const seat =
    match.currentSeat;

  const player =
    match.players[seat];

  if (!player || !player.isBot) {
    return;
  }

  const hand =
    match.hands[seat];

  if (!hand || hand.length === 0) {
    return;
  }

  const legalCards =
    getLegalCards(
      hand,
      match.trick
    );

  if (legalCards.length === 0) {
    return;
  }

  // Simple bot:
  // choose a random legal card.
  const card =
    legalCards[
      Math.floor(
        Math.random() *
          legalCards.length
      )
    ];

  playCard(
    match,
    player,
    {
      card: card,
    }
  );
}

server.on('connection', (socket) => {
  console.log('Player connected');

  const player = {
    name: 'Player',

    seat: null,

    matchId: null,

    inMatch: false,

    isBot: false,

    socket: socket,
  };

  socket.player = player;

  send(player, {
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

      if (
        data.type ===
        'find_match'
      ) {
        if (player.inMatch) {
          return;
        }

        player.name =
          data.name || 'Player';

        if (
          !waitingPlayers.includes(
            player
          )
        ) {
          waitingPlayers.push(
            player
          );

          send(player, {
            type: 'searching',

            playersWaiting: 1,

            message:
              TEST_MODE
                ? 'Starting test game...'
                : 'Searching for players...',
          });

          console.log(
            `${player.name} joined matchmaking`
          );

          tryMatchPlayers();
        }

        return;
      }

      if (
        data.type ===
        'cancel_search'
      ) {
        const index =
          waitingPlayers.indexOf(
            player
          );

        if (index !== -1) {
          waitingPlayers.splice(
            index,
            1
          );
        }

        send(player, {
          type:
            'search_cancelled',
        });

        return;
      }

      if (
        data.type === 'play'
      ) {
        if (!player.inMatch) {
          send(player, {
            type: 'error',

            message:
              'You are not in a match.',
          });

          return;
        }

        const match =
          matches.get(
            player.matchId
          );

        if (!match) {
          send(player, {
            type: 'error',

            message:
              'Match not found.',
          });

          return;
        }

        playCard(
          match,
          player,
          data
        );

        return;
      }

      if (
        data.type ===
        'next_deal'
      ) {
        return;
      }

      if (
        data.type === 'ping'
      ) {
        send(player, {
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
    const index =
      waitingPlayers.indexOf(
        player
      );

    if (index !== -1) {
      waitingPlayers.splice(
        index,
        1
      );
    }

    if (player.inMatch) {
      const match =
        matches.get(
          player.matchId
        );

      if (
        match &&
        !match.finished
      ) {
        match.finished = true;

        match.players.forEach(
          (p) => {
            if (!p.isBot) {
              send(p, {
                type:
                  'disconnected',

                message:
                  'A player disconnected.',
              });
            }
          }
        );

        matches.delete(
          player.matchId
        );
      }
    }

    console.log(
      `${player.name} disconnected`
    );
  });

  socket.on('error', (error) => {
    console.error(
      'Socket error:',
      error.message
    );
  });
});
