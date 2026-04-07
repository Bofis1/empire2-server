const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const players = new Map();
const games   = new Map();
let nextGameId = 1;

function broadcast(data, exclude=null){
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if(client !== exclude && client.readyState === 1) client.send(msg);
  });
}

function sendGameList(ws){
  const list = [...games.values()].map(g => ({
    id:g.id, name:g.name, host:g.host, hostPeer:g.hostPeer,
    zone:g.zone, players:g.players.length, max:g.maxPlayers, hasPass:!!g.password
  }));
  ws.send(JSON.stringify({ type:'game_list', games:list }));
}

wss.on('connection', ws => {
  players.set(ws, { name:'', gameId:null });

  ws.on('message', raw => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }
    const player = players.get(ws);

    switch(data.type){

      case 'login':
        player.name = (data.name||'').slice(0,20).replace(/[<>]/g,'') || 'Adventurer';
        ws.send(JSON.stringify({ type:'logged_in', name:player.name }));
        sendGameList(ws);
        ws.send(JSON.stringify({ type:'player_count', count:players.size }));
        broadcast({ type:'lobby_chat', name:'SERVER',
          msg:player.name+' entered the lobby.', system:true }, ws);
        broadcast({ type:'player_count', count:players.size });
        break;

      case 'lobby_chat':
        if(!player.name) break;
        const msg = (data.msg||'').slice(0,200).replace(/[<>]/g,'');
        if(!msg) break;
        broadcast({ type:'lobby_chat', name:player.name, msg });
        break;

      case 'create_game':
        const gId = nextGameId++;
        const game = {
          id:gId,
          name:(data.name||player.name+"'s Game").slice(0,40),
          host:player.name, hostPeer:data.hostPeer,
          zone:data.zone||'XU Outpost',
          password:data.password||'',
          maxPlayers:Math.min(data.max||4,4),
          players:[player.name]
        };
        games.set(gId, game);
        player.gameId = gId;
        ws.send(JSON.stringify({ type:'game_created', game }));
        broadcast({ type:'game_list_update' });
        break;

      case 'join_game':
        const jGame = games.get(data.id);
        if(!jGame){ ws.send(JSON.stringify({type:'join_error',msg:'Game not found.'})); break; }
        if(jGame.players.length >= jGame.maxPlayers){ ws.send(JSON.stringify({type:'join_error',msg:'Game is full.'})); break; }
        if(jGame.password && jGame.password !== data.password){ ws.send(JSON.stringify({type:'join_error',msg:'Wrong password.'})); break; }
        jGame.players.push(player.name);
        player.gameId = data.id;
        ws.send(JSON.stringify({ type:'join_success', hostPeer:jGame.hostPeer, game:jGame }));
        broadcast({ type:'game_list_update' });
        break;

      case 'leave_game':
        if(player.gameId){
          const lg = games.get(player.gameId);
          if(lg){
            lg.players = lg.players.filter(n => n !== player.name);
            if(lg.host === player.name) games.delete(player.gameId);
            broadcast({ type:'game_list_update' });
          }
          player.gameId = null;
        }
        break;

      case 'request_game_list':
        sendGameList(ws);
        break;
    }
  });

  ws.on('close', () => {
    const player = players.get(ws);
    if(player){
      if(player.gameId){
        const g = games.get(player.gameId);
        if(g){
          g.players = g.players.filter(n => n !== player.name);
          if(g.host === player.name) games.delete(player.gameId);
          broadcast({ type:'game_list_update' });
        }
      }
      if(player.name){
        broadcast({ type:'lobby_chat', name:'SERVER',
          msg:player.name+' left the lobby.', system:true });
      }
      players.delete(ws);
      broadcast({ type:'player_count', count:players.size });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Empire 2 Lobby running on port '+PORT));