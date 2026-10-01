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

  // Shuffle deck
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


/*
========================================================
CURRENT SCORING
========================================================

IMPORTANT:
This is still your old scoring system.

You told me your actual game uses different scoring.
I have NOT changed it because you haven't given the
new scoring rules yet.
*/

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


/*
========================================================
CORRECT TRICK RULE
========================================================

1. First player can play ANY card.

2. That first card establishes the LEAD SUIT.

3. Every following player checks their COMPLETE
   CURRENT HAND.

4. If they have at least one card of the lead suit,
   they MUST play that suit.

5. If they have ZERO cards of the lead suit,
   they can play ANY card.

6. After 4 cards, the trick ends.

7. Winner starts the next trick.

8. The rule resets for every new trick.
========================================================
*/

function legalCard(hand, trick, selectedCard) {
  // --------------------------------------------------
  // 1. Player must actually have the selected card.
  // --------------------------------------------------

  const hasCard = hand.some(
    (card) => sameCard(card, selectedCard)
  );

  if (!hasCard) {
    return false;
  }

  // --------------------------------------------------
  // 2. First player of the trick can play ANY card.
  // --------------------------------------------------

  if (trick.length === 0) {
    return true;
  }

  // --------------------------------------------------
  // 3. First card of this trick establishes the
  //    lead suit.
  // --------------------------------------------------

  const leadSuit = trick[0].card.s;

  // --------------------------------------------------
  // 4. Check the player's COMPLETE CURRENT HAND
  //    for the lead suit.
  // --------------------------------------------------

  const hasLeadSuit = hand.some(
    (card) => card.s === leadSuit
  );

  // --------------------------------------------------
  // 5. If player has the lead suit, they MUST play it.
  // --------------------------------------------------

  if (hasLeadSuit) {
    return selectedCard.s === leadSuit;
  }

  // --------------------------------------------------
  // 6. Player has NO lead-suit card.
  //    Any card is allowed.
  // --------------------------------------------------

  return true;
}


/*
========================================================
BOT LEGAL CARDS
========================================================
*/

function getLegalCards(hand, trick) {
  // --------------------------------------------------
  // First player can play ANY card.
  // --------------------------------------------------

  if (trick.length === 0) {
    return [...hand];
  }

  // --------------------------------------------------
  // Get lead suit from the first card of this trick.
  // --------------------------------------------------

  const leadSuit = trick[0].card.s;

  // --------------------------------------------------
  // Find ALL cards of that suit in the bot's
  // current hand.
  // --------------------------------------------------

  const leadSuitCards = hand.filter(
    (card) => card.s === leadSuit
  );

  // --------------------------------------------------
  // Bot has lead suit.
  // Bot MUST play one of those cards.
  // --------------------------------------------------

  if (leadSuitCards.length > 0) {
    return leadSuitCards;
  }

  // --------------------------------------------------
  // Bot has no lead-suit cards.
  // Bot can play anything.
  // --------------------------------------------------

  return [...hand];
}


/*
========================================================
FIND TRICK WINNER
========================================================
*/

function findTrickWinner(trick) {
  const leadSuit = trick[0].card.s;

  let winner = trick[0];

  for (const played of trick) {
    if (
      played.card.s === leadSuit &&
      played.card.r > winner.card.r
    ) {
      winner = played;
    }
  }

  return winner.seat;
}


/*
========================================================
DEAL 13 CARDS
========================================================
*/

function dealNewRound(match) {
  const deck = createDeck();

  match.hands = [
    [],
    [],
    [],
    [],
  ];

  // 13 cards per player
  for (let seat = 0; seat < 4; seat++) {
    match.hands[seat] = deck.slice(
      seat * 13,
      seat * 13 + 13
    );

    sortHand(match.hands[seat]);
  }

  // New trick
  match.trick = [];

  // Reset tricks for this deal
  match.tricksPlayed = 0;

  // Winner of previous deal starts,
  // otherwise firstSeat.
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


/*
========================================================
CREATE BOT
========================================================
*/

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


/*
========================================================
CREATE TEST MATCH
========================================================
*/

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


/*
========================================================
MATCHMAKING
========================================================
*/

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


/*
========================================================
REAL 4 PLAYER MATCH
========================================================
*/

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


/*
========================================================
FINISH MATCH
========================================================

NOTE:
This is still the old scoring/end-game logic.
Do not use this as your final game rule until
you give me your actual scoring rules.
========================================================
*/

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


/*
========================================================
FINISH TRICK
========================================================
*/

function finishTrick(match) {
  const finishedTrick = [
    ...match.trick,
  ];

  // Find winner of this 4-card trick.
  const winner =
    findTrickWinner(
      finishedTrick
    );

  // Current scoring system.
  let points = 0;

  for (const played of finishedTrick) {
    points += cardPoints(
      played.card
    );
  }

  match.scores[winner] += points;

  match.tricksPlayed++;

  // Winner becomes starter of next trick.
  match.currentSeat = winner;

  const reached100 =
    match.scores.some(
      (score) => score >= 100
    );

  const dealFinished =
    match.tricksPlayed === 13;

  // Clear current trick.
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

  // Old game-ending rule.
  if (reached100) {
    setTimeout(() => {
      finishMatch(match);
    }, 1800);

    return;
  }

  // All 13 tricks completed.
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

  // Winner starts next trick.
  setTimeout(() => {
    playBotIfNeeded(match);
  }, 500);
}


/*
========================================================
PLAY CARD
========================================================
*/

function playCard(match, player, data) {
  if (match.finished) {
    return;
  }

  const seat = player.seat;

  // --------------------------------------------------
  // Check turn.
  // --------------------------------------------------

  if (seat !== match.currentSeat) {
    send(player, {
      type: 'error',

      message:
        'It is not your turn.',
    });

    return;
  }

  const selectedCard = data.card;

  // --------------------------------------------------
  // Validate card data.
  // --------------------------------------------------

  if (
    !selectedCard ||
    typeof selectedCard.s !== 'number' ||
    typeof selectedCard.r !== 'number'
  ) {
    send(player, {
      type: 'error',

      message:
        'Invalid card.',
    });

    return;
  }

  const hand = match.hands[seat];

  // --------------------------------------------------
  // THIS IS THE IMPORTANT RULE CHECK.
  //
  // If the trick already has a card and the player
  // has that lead suit, they MUST play that suit.
  // --------------------------------------------------

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
        'You must follow the lead suit if you have one.',
    });

    return;
  }

  // --------------------------------------------------
  // Find selected card in player's hand.
  // --------------------------------------------------

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

  // --------------------------------------------------
  // Remove card from hand.
  // --------------------------------------------------

  const playedCard =
    hand.splice(
      cardIndex,
      1
    )[0];

  // --------------------------------------------------
  // Add card to current trick.
  // --------------------------------------------------

  match.trick.push({
    seat: seat,

    card: playedCard,
  });

  // --------------------------------------------------
  // Four cards = trick finished.
  // --------------------------------------------------

  if (match.trick.length === 4) {
    finishTrick(match);

    return;
  }

  // --------------------------------------------------
  // Next player.
  // --------------------------------------------------

  match.currentSeat =
    (seat + 1) % 4;

  broadcast(match, {
    type: 'played',

    trick: match.trick,

    currentSeat:
      match.currentSeat,
  });

  // --------------------------------------------------
  // If next player is a bot, let bot play.
  // --------------------------------------------------

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

  // Not a bot.
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
  // choose a random LEGAL card.
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
