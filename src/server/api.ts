/*
 * Copyright 2018 The boardgame.io Authors
 *
 * Use of this source code is governed by a MIT-style
 * license that can be found in the LICENSE file or at
 * https://opensource.org/licenses/MIT.
 */

import Koa from 'koa';
import Router from 'koa-router';
import koaBody from 'koa-body';
import { generate as uuid } from 'shortid';
import cors from '@koa/cors';

import { InitializeGame } from '../core/initialize';
import * as StorageAPI from './db/base';
import { Server, Game } from '../types';

/**
 * Creates a new game.
 *
 * @param {object} db - The storage API.
 * @param {object} game - The game config object.
 * @param {number} numPlayers - The number of players.
 * @param {object} setupData - User-defined object that's available
 *                             during game setup.
 * @param {object } lobbyConfig - Configuration options for the lobby.
 * @param {boolean} unlisted - Whether the game should be excluded from public listing.
 */
export const CreateGame = async (
  db: StorageAPI.Sync | StorageAPI.Async,
  game: Game,
  numPlayers: number,
  setupData: any,
  lobbyConfig: Server.LobbyConfig,
  unlisted: boolean
) => {
  if (!numPlayers || typeof numPlayers !== 'number') numPlayers = 2;

  const metadata: Server.GameMetadata = {
    gameName: game.name,
    unlisted: !!unlisted,
    players: {},
  };
  if (setupData !== undefined) metadata.setupData = setupData;
  for (let playerIndex = 0; playerIndex < numPlayers; playerIndex++) {
    metadata.players[playerIndex] = { id: playerIndex };
  }

  const gameID = lobbyConfig.uuid();
  const initialState = InitializeGame({ game, numPlayers, setupData });

  await db.createGame(gameID, { metadata, initialState });

  return gameID;
};

export const createApiServer = ({
  db,
  games,
  lobbyConfig,
  generateCredentials,
}: {
  db: StorageAPI.Sync | StorageAPI.Async;
  games: Game[];
  lobbyConfig?: Server.LobbyConfig;
  generateCredentials?: Server.GenerateCredentials;
}) => {
  const app = new Koa();
  return addApiToServer({ app, db, games, lobbyConfig, generateCredentials });
};

export const addApiToServer = ({
  app,
  db,
  games,
  lobbyConfig,
  generateCredentials,
}: {
  app: Koa;
  games: Game[];
  lobbyConfig?: Server.LobbyConfig;
  generateCredentials?: Server.GenerateCredentials;
  db: StorageAPI.Sync | StorageAPI.Async;
}) => {
  if (!lobbyConfig) lobbyConfig = {};
  lobbyConfig = {
    ...lobbyConfig,
    uuid: lobbyConfig.uuid || uuid,
    generateCredentials: generateCredentials || lobbyConfig.uuid || uuid,
  };
  const router = new Router();

  router.get('/games', async ctx => {
    ctx.body = games.map(game => game.name);
  });

  router.post('/games/:name/create', koaBody(), async ctx => {
    // The name of the game (for example: tic-tac-toe).
    const gameName = ctx.params.name;
    // User-data to pass to the game setup function.
    const setupData = ctx.request.body.setupData;
    // Whether the game should be excluded from public listing.
    const unlisted = ctx.request.body.unlisted;
    // The number of players for this game instance.
    let numPlayers = parseInt(ctx.request.body.numPlayers);

    const game = games.find(g => g.name === gameName);
    if (!game) ctx.throw(404, 'Game ' + gameName + ' not found');

    const gameID = await CreateGame(
      db,
      game,
      numPlayers,
      setupData,
      lobbyConfig,
      unlisted
    );

    ctx.body = {
      gameID,
    };
  });

  router.get('/games/:name', async ctx => {
    const gameName = ctx.params.name;
    const gameList = await db.listGames({ gameName });
    let rooms = [];
    for (let gameID of gameList) {
      const { metadata } = await (db as StorageAPI.Async).fetch(gameID, {
        metadata: true,
      });
      if (!metadata.unlisted) {
        rooms.push({
          gameID,
          players: Object.values(metadata.players).map(player => {
            // strip away credentials
            const { credentials, ...strippedInfo } = player;
            return strippedInfo;
          }),
          setupData: metadata.setupData,
        });
      }
    }
    ctx.body = {
      rooms: rooms,
    };
  });

  router.get('/games/:name/:id', async ctx => {
    const gameID = ctx.params.id;
    const { metadata } = await (db as StorageAPI.Async).fetch(gameID, {
      metadata: true,
    });
    if (!metadata) {
      ctx.throw(404, 'Room ' + gameID + ' not found');
    }
    const strippedRoom = {
      roomID: gameID,
      players: Object.values(metadata.players).map(player => {
        const { credentials, ...strippedInfo } = player;
        return strippedInfo;
      }),
      setupData: metadata.setupData,
    };
    ctx.body = strippedRoom;
  });

  router.post('/games/:name/:id/join', koaBody(), async ctx => {
    const playerID = ctx.request.body.playerID;
    const playerName = ctx.request.body.playerName;
    const data = ctx.request.body.data;
    if (typeof playerID === 'undefined' || playerID === null) {
      ctx.throw(403, 'playerID is required');
    }
    if (!playerName) {
      ctx.throw(403, 'playerName is required');
    }
    const gameID = ctx.params.id;
    const { metadata } = await (db as StorageAPI.Async).fetch(gameID, {
      metadata: true,
    });
    if (!metadata) {
      ctx.throw(404, 'Game ' + gameID + ' not found');
    }
    if (!metadata.players[playerID]) {
      ctx.throw(404, 'Player ' + playerID + ' not found');
    }
    if (metadata.players[playerID].name) {
      ctx.throw(409, 'Player ' + playerID + ' not available');
    }

    if (data) {
      metadata.players[playerID].data = data;
    }
    metadata.players[playerID].name = playerName;
    const playerCredentials = await lobbyConfig.generateCredentials(ctx);
    metadata.players[playerID].credentials = playerCredentials;

    await db.setMetadata(gameID, metadata);

    ctx.body = {
      playerCredentials,
    };
  });

  router.post('/games/:name/:id/leave', koaBody(), async ctx => {
    const gameID = ctx.params.id;
    const playerID = ctx.request.body.playerID;
    const credentials = ctx.request.body.credentials;
    const { metadata } = await (db as StorageAPI.Async).fetch(gameID, {
      metadata: true,
    });
    if (typeof playerID === 'undefined' || playerID === null) {
      ctx.throw(403, 'playerID is required');
    }

    if (!metadata) {
      ctx.throw(404, 'Game ' + gameID + ' not found');
    }
    if (!metadata.players[playerID]) {
      ctx.throw(404, 'Player ' + playerID + ' not found');
    }
    if (credentials !== metadata.players[playerID].credentials) {
      ctx.throw(403, 'Invalid credentials ' + credentials);
    }

    delete metadata.players[playerID].name;
    delete metadata.players[playerID].credentials;
    if (Object.values(metadata.players).some(player => player.name)) {
      await db.setMetadata(gameID, metadata);
    } else {
      // remove room
      await db.wipe(gameID);
    }
    ctx.body = {};
  });

  router.post('/games/:name/:id/playAgain', koaBody(), async ctx => {
    const gameName = ctx.params.name;
    const gameID = ctx.params.id;
    const playerID = ctx.request.body.playerID;
    const credentials = ctx.request.body.credentials;
    const unlisted = ctx.request.body.unlisted;
    const { metadata } = await (db as StorageAPI.Async).fetch(gameID, {
      metadata: true,
    });

    if (typeof playerID === 'undefined' || playerID === null) {
      ctx.throw(403, 'playerID is required');
    }

    if (!metadata) {
      ctx.throw(404, 'Game ' + gameID + ' not found');
    }
    if (!metadata.players[playerID]) {
      ctx.throw(404, 'Player ' + playerID + ' not found');
    }
    if (credentials !== metadata.players[playerID].credentials) {
      ctx.throw(403, 'Invalid credentials ' + credentials);
    }

    // Check if nextRoom is already set, if so, return that id.
    if (metadata.nextRoomID) {
      ctx.body = { nextRoomID: metadata.nextRoomID };
      return;
    }

    // User-data to pass to the game setup function.
    const setupData = ctx.request.body.setupData || metadata.setupData;
    // The number of players for this game instance.
    const numPlayers =
      parseInt(ctx.request.body.numPlayers) ||
      Object.keys(metadata.players).length;

    const game = games.find(g => g.name === gameName);
    const nextRoomID = await CreateGame(
      db,
      game,
      numPlayers,
      setupData,
      lobbyConfig,
      unlisted
    );
    metadata.nextRoomID = nextRoomID;

    await db.setMetadata(gameID, metadata);

    ctx.body = {
      nextRoomID,
    };
  });

  const updatePlayerMetadata = async (ctx: Koa.Context) => {
    const gameID = ctx.params.id;
    const playerID = ctx.request.body.playerID;
    const credentials = ctx.request.body.credentials;
    const newName = ctx.request.body.newName;
    const data = ctx.request.body.data;
    const { metadata } = await (db as StorageAPI.Async).fetch(gameID, {
      metadata: true,
    });
    if (typeof playerID === 'undefined') {
      ctx.throw(403, 'playerID is required');
    }
    if (data === undefined && !newName) {
      ctx.throw(403, 'newName or data is required');
    }
    if (newName && typeof newName !== 'string') {
      ctx.throw(403, `newName must be a string, got ${typeof newName}`);
    }
    if (!metadata) {
      ctx.throw(404, 'Game ' + gameID + ' not found');
    }
    if (!metadata.players[playerID]) {
      ctx.throw(404, 'Player ' + playerID + ' not found');
    }
    if (credentials !== metadata.players[playerID].credentials) {
      ctx.throw(403, 'Invalid credentials ' + credentials);
    }

    if (newName) {
      metadata.players[playerID].name = newName;
    }
    if (data) {
      metadata.players[playerID].data = data;
    }
    await db.setMetadata(gameID, metadata);
    ctx.body = {};
  };

  router.post('/games/:name/:id/rename', koaBody(), async ctx => {
    console.warn(
      'This endpoint /rename is deprecated. Please use /update instead.'
    );
    await updatePlayerMetadata(ctx);
  });

  router.post('/games/:name/:id/update', koaBody(), updatePlayerMetadata);
  
  // CREATE TEAM specificando numero di team
  //

  const CreateTeam = async (ctx: Koa.Context) => {
    const gameID = ctx.params.id;
    const numOfTeams = ctx.request.body.numOfTeams;
    const { metadata } = await (db as StorageAPI.Async).fetch(gameID, {
      metadata: true,
    });

    if (typeof numOfTeams === 'undefined') {
      ctx.throw(403, 'Define number of team');
    }
    if (!metadata) {
      ctx.throw(404, 'Game ' + gameID + ' not found');
    }
    let playerArray = []
    let adminArray = []
    let playerLeaderArray = []
    //console.log("keys:", Object.keys(metadata.players))
    for (let id of Object.keys(metadata.players)) {
      if (metadata.players[id].data.player) {
        playerArray = [...playerArray, id]
      }
      if (metadata.players[id].data.admin) {
        adminArray = [...adminArray, id]
      }
    }
    //console.log("playerArray:", playerArray)
    //console.log("adminArray:", adminArray)
    const numPlayer = playerArray.length
    let playersInTeam = Math.floor(numPlayer / numOfTeams);
    const numOfReminder = numPlayer % numOfTeams;
    /*console.log("numero di giocatori", numPlayer)
    console.log("numero di team", numOfTeams)
    console.log("numero non pari", numOfReminder)
    console.log("numero di giocatori in team", playersInTeam)*/

    let teams = [];
    let tmp_playerArray = []
    let playerID = playerArray[0];
    let teamID = 0;

    for (teamID; teamID < numOfTeams; teamID++) {
      //console.log("teamID", teamID)
      let temp_team = {
        teamID: '',
        playersID: []
      };
      temp_team.teamID = teamID.toString();

      for (let id = 0; id < playersInTeam; id++) {
        //console.log("playerID", playerID)
        if (metadata.players[playerID].data.admin) {
          metadata.players[playerID].data.leader = false
          playerID++
        }
        let temp_teamData = {
          teamID: '',
          leader: false
        }
        temp_teamData.teamID = teamID.toString();
        metadata.players[playerID].data.teamData = temp_teamData;
        metadata.players[playerID].data.leader = false
        tmp_playerArray = [...tmp_playerArray, playerID]
        temp_team.playersID = [...temp_team.playersID, playerID.toString()]
        playerID++
      }
      let id_leader = tmp_playerArray[0]
      metadata.players[id_leader].data.teamData.leader = true;
      metadata.players[id_leader].data.leader = true;
      playerLeaderArray = [...playerLeaderArray, id_leader.toString()]
      teams = [...teams, temp_team];
      tmp_playerArray = [];
    }

    if (numOfReminder !== 0) {
      //console.log("qui")
      teamID = 0;
      for (let id = 0; id < numOfReminder; id++) {
        let temp_teamData = {
          teamID: '',
          leader: false
        }
        if (metadata.players[playerID].data.admin) {
          metadata.players[playerID].data.leader = false
          playerID++
        }
        temp_teamData.teamID = teamID.toString();
        let team = teams.find(team => team.teamID === teamID.toString())
        metadata.players[playerID].data.teamData = temp_teamData;
        metadata.players[playerID].data.leader = false
        team.playersID = [...team.playersID, playerID.toString()]
        playerID++
        teamID++
      }
    }
    if (metadata.setupData) {
      metadata.setupData.teams = teams;
      metadata.setupData.adminsID = adminArray;
      metadata.setupData.playersID = playerArray;
      metadata.setupData.leadersID = playerLeaderArray;
    }

    await db.setMetadata(gameID, metadata);
    ctx.body = { teams: teams };
  };

  router.post('/games/:name/:id/teams/create', koaBody(), CreateTeam);


  // UPDATE LEADER
  //
  const UpdateLeader = async (ctx: Koa.Context) => {
    const gameID = ctx.params.id;
    //const teamID = ctx.request.body.teamID;
    const teamID = ctx.params.team;
    const { metadata } = await (db as StorageAPI.Async).fetch(gameID, {
      metadata: true,
    });

    if (typeof teamID === 'undefined') {
      ctx.throw(403, 'Select the team to update');
    }
    if (!metadata) {
      ctx.throw(404, 'Game ' + gameID + ' not found');
    }
    if (metadata.setupData) {
      const team = metadata.setupData.teams.find(team => team.teamID === teamID)
      if (typeof team === 'undefined') {
        ctx.throw(404, 'Team ' + teamID + ' not found');
      }
    }

    const playerID_array = Object.keys(metadata.players);
    let playerID_oldLeader = '';
    let playerID_others = [];

    for (let playerID of playerID_array) {
      console.log
      if (metadata.players[playerID].data.hasOwnProperty('teamData'))
        if (metadata.players[playerID].data.teamData.teamID === teamID) {
          if (metadata.players[playerID].data.teamData.leader) {
            playerID_oldLeader = playerID;
          } else {
            playerID_others = [...playerID_others, playerID]
          }
        }
    }
    if (playerID_others.length > 0) {
      const playerID_newLeader = playerID_others[Math.floor(Math.random() * playerID_others.length)];
      metadata.players[playerID_newLeader].data.teamData.leader = true;
      metadata.players[playerID_newLeader].data.leader = true
      metadata.players[playerID_oldLeader].data.teamData.leader = false;
      metadata.players[playerID_oldLeader].data.leader = false

      let leadersID_array = metadata.setupData.leadersID

      let index_old = leadersID_array.indexOf(playerID_oldLeader)

      if (index_old !== -1) {
          leadersID_array[index_old] = playerID_newLeader;
      }

      await db.setMetadata(gameID, metadata);

      ctx.body = {
        playerName_newLeader: metadata.players[playerID_newLeader].name,
        playerID_newLeader: playerID_newLeader,
        new_leadersID: leadersID_array,
        new_players: metadata.players
      };
    } else {
      console.log("only one player in team " + teamID)
    }
  };

  router.post('/games/:name/:id/teams/update/leader/:team', koaBody(), UpdateLeader);

  // REJOIN GAME
  //
  const RejoinGame = async ctx => {
    const playerName = ctx.request.body.playerName;
    const credentials = ctx.request.body.credentials;
    const gameID = ctx.params.id;
    const { metadata } = await (db as StorageAPI.Async).fetch(gameID, {
      metadata: true,
    });

    if (!playerName) {
      ctx.throw(403, 'playerName is required');
    }
    if (!metadata) {
      ctx.throw(404, 'Game ' + gameID + ' not found');
    }

    const playerID_array = Object.keys(metadata.players);
    const playerID = playerID_array.find(id => metadata.players[id].name === playerName)

    if (typeof playerID === 'undefined') {
      ctx.throw(409, 'Player not available');
    }
    if (credentials !== metadata.players[playerID].credentials) {
      ctx.throw(403, 'Invalid credentials ' + credentials);
    }

    await db.setMetadata(gameID, metadata);
    ctx.body = {
      rejoined: true
    };
  }

  router.post('/games/:name/:id/rejoin', koaBody(), RejoinGame);
  //

  app.use(cors());

  // If API_SECRET is set, then require that requests set an
  // api-secret header that is set to the same value.
  app.use(async (ctx, next) => {
    if (
      !!process.env.API_SECRET &&
      ctx.request.headers['api-secret'] !== process.env.API_SECRET
    ) {
      ctx.throw(403, 'Invalid API secret');
    }

    await next();
  });

  app.use(router.routes()).use(router.allowedMethods());

  return app;
};
