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

function broadcastGameList(){
  broadcast({ type:'game_list_update' });
}

function removePlayer(ws){
  const player = players.get(ws);
  if(!player) return;
  console.log(`[DISCONNECT] ${player.name} disconnected, gameId=${player.gameId}`);
  if(player.gameId){
    const g = games.get(player.gameId);
    if(g){
      g.players = g.players.filter(n => n !== player.name);
      // NEVER delete game on disconnect — only leave_game with isHost:true does that
      console.log(`[DISCONNECT] Game "${g.name}" still alive, players: ${g.players.join(',')}`);
      broadcastGameList();
    }
    player.gameId = null;
  }
  if(player.name){
    broadcast({ type:'lobby_chat', name:'SERVER',
      msg:player.name+' left the lobby.', system:true });
  }
  players.delete(ws);
  broadcast({ type:'player_count', count:players.size });
}

setInterval(()=>{
  wss.clients.forEach(ws=>{
    if(ws.isAlive === false){ removePlayer(ws); return ws.terminate(); }
    ws.isAlive = false;
    ws.ping();
  });
}, 20000);

wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', ()=>{ ws.isAlive = true; });
  players.set(ws, { name:'', gameId:null });

  ws.on('message', raw => {
    ws.isAlive = true;
    let data;
    try { data = JSON.parse(raw); } catch { return; }
    const player = players.get(ws);
    console.log(`[MSG] ${player.name}: ${data.type}`, data.isHost !== undefined ? `isHost=${data.isHost}` : '');

    switch(data.type){
      case 'login':
        player.name = (data.name||'').slice(0,20).replace(/[<>]/g,'') || 'Adventurer';
        ws.send(JSON.stringify({ type:'logged_in', name:player.name }));
        sendGameList(ws);
        ws.send(JSON.stringify({ type:'player_count', count:players.size }));
        broadcast({ type:'lobby_chat', name:'SERVER', msg:player.name+' entered the lobby.', system:true }, ws);
        broadcast({ type:'player_count', count:players.size });
        break;

      case 'lobby_chat':
        if(!player.name) break;
        const msg = (data.msg||'').slice(0,200).replace(/[<>]/g,'');
        if(!msg) break;
        broadcast({ type:'lobby_chat', name:player.name, msg });
        break;

      case 'create_game':
        if(player.gameId){
          const old=games.get(player.gameId);
          if(old && old.host===player.name) games.delete(player.gameId);
          player.gameId=null;
        }
        const gId = nextGameId++;
        const game = {
          id:gId, name:(data.name||player.name+"'s Game").slice(0,40),
          host:player.name, hostPeer:data.hostPeer,
          zone:data.zone||'XU Outpost', password:data.password||'',
          maxPlayers:Math.min(data.max||4,4), players:[player.name], createdAt:Date.now()
        };
        games.set(gId, game);
        player.gameId = gId;
        console.log(`[CREATE] "${game.name}" by ${player.name}`);
        ws.send(JSON.stringify({ type:'game_created', game }));
        broadcastGameList();
        break;

      case 'update_game':
        if(player.gameId){
          const ug=games.get(player.gameId);
          if(ug && ug.host===player.name){
            if(data.zone) ug.zone=data.zone.slice(0,40);
            broadcastGameList();
          }
        }
        break;

      case 'join_game':
        const jGame = games.get(data.id);
        if(!jGame){ ws.send(JSON.stringify({type:'join_error',msg:'Game not found.'})); break; }
        if(jGame.players.length>=jGame.maxPlayers){ ws.send(JSON.stringify({type:'join_error',msg:'Game is full.'})); break; }
        if(jGame.password&&jGame.password!==data.password){ ws.send(JSON.stringify({type:'join_error',msg:'Wrong password.'})); break; }
        if(!jGame.players.includes(player.name)) jGame.players.push(player.name);
        player.gameId = data.id;
        ws.send(JSON.stringify({ type:'join_success', hostPeer:jGame.hostPeer, game:jGame }));
        broadcastGameList();
        break;

      case 'leave_game':
        console.log(`[LEAVE] ${player.name} isHost=${data.isHost} gameId=${player.gameId}`);
        if(player.gameId){
          const lg=games.get(player.gameId);
          if(lg){
            lg.players=lg.players.filter(n=>n!==player.name);
            if(data.isHost === true && lg.host === player.name){
              console.log(`[LEAVE] Deleting game "${lg.name}" - host left`);
              games.delete(player.gameId);
              broadcast({type:'lobby_chat',name:'SERVER',msg:lg.name+' ended.',system:true});
            } else {
              console.log(`[LEAVE] Client left game "${lg.name}" - game stays`);
            }
            broadcastGameList();
          }
          player.gameId=null;
        }
        break;

      case 'request_game_list':
        sendGameList(ws);
        break;
    }
  });

  ws.on('close', ()=>removePlayer(ws));
  ws.on('error', ()=>removePlayer(ws));
});

setInterval(()=>{
  const now=Date.now();
  games.forEach((g,id)=>{ if(now-g.createdAt>6*60*60*1000) games.delete(id); });
  broadcastGameList();
}, 60*60*1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, ()=>console.log('Empire 2 Lobby running on port '+PORT));
