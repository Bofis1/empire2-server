const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
// a481 — SERVER-2: cap frame size. The default maxPayload is 100MB, which lets a
//   single client send a giant frame (e.g. a bloated sv_cloud_save) and force a
//   full synchronous disk rewrite, or just exhaust memory. 256KB is far larger than
//   any legitimate message (the biggest is a full character save) with headroom.
const wss = new WebSocketServer({ server, maxPayload: 256 * 1024 });

const players = new Map(); // ws -> player obj
const games   = new Map(); // gameId -> game obj
let nextGameId = 1;

// ══════════════════════════════════════════════════════════
// GUILD SYSTEM
// Guilds stored in guilds.json on disk — persists across restarts
// ══════════════════════════════════════════════════════════
// Persistent data directory — defaults to app root, but can be overridden via DATA_DIR env var
// On Railway, set DATA_DIR to a mounted volume path (e.g. /data) so saves/guilds survive redeploys.
const DATA_DIR = process.env.DATA_DIR || __dirname;
try { if(!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, {recursive:true}); } catch(e){}
console.log(`[init] Data directory: ${DATA_DIR}`);

const GUILDS_FILE = path.join(DATA_DIR, 'guilds.json');
let guilds = {}; // guildIdLowercase -> guild obj

try {
  if (fs.existsSync(GUILDS_FILE)) {
    guilds = JSON.parse(fs.readFileSync(GUILDS_FILE, 'utf8'));
    console.log(`[guilds] Loaded ${Object.keys(guilds).length} guilds from disk.`);
  }
} catch(e) {
  console.warn('[guilds] Could not load guilds.json:', e.message);
  guilds = {};
}

let _guildsDirtyTimer = null;
function flushGuilds() {
  if (_guildsDirtyTimer) return;
  _guildsDirtyTimer = setTimeout(() => {
    _guildsDirtyTimer = null;
    // a481 — SERVER-3/4: async, atomic write (temp + rename), same as flushSaves.
    const payload = JSON.stringify(guilds);
    const tmp = GUILDS_FILE + '.tmp';
    fs.writeFile(tmp, payload, 'utf8', (err) => {
      if (err) { console.warn('[guilds] Failed to write temp file:', err.message); return; }
      fs.rename(tmp, GUILDS_FILE, (err2) => {
        if (err2) console.warn('[guilds] Failed to rename guilds file:', err2.message);
      });
    });
  }, 5000);
}

// Guild XP required for each level
const GUILD_XP_PER_LVL = [0, 100, 500, 1500, 5000, 15000, 40000, 100000, 250000, 500000];
function guildLvlFromXp(xp){
  let lvl = 1;
  for(let i=1;i<GUILD_XP_PER_LVL.length;i++){
    if(xp >= GUILD_XP_PER_LVL[i]) lvl = i;
    else break;
  }
  return lvl;
}

// Get guild a player belongs to (by character name)
function findPlayerGuild(charName){
  if(!charName) return null;
  const lcName = charName.toLowerCase();
  for(const [gid, g] of Object.entries(guilds)){
    if(g.members && g.members[charName]) return {id:gid, guild:g};
    // Case-insensitive fallback
    for(const mname of Object.keys(g.members||{})){
      if(mname.toLowerCase() === lcName) return {id:gid, guild:g};
    }
  }
  return null;
}

// v93.0-a258 — sanitized guild tag for a character, from the PERSISTED registry.
// The lobby player list uses this so tags are server-authoritative: the client
// can't reliably send its own tag at login (its myGuild isn't populated until the
// server replies with guild_info), so we resolve it here by character name instead.
function _serverGuildTag(charName){
  const pg = findPlayerGuild(charName);
  if(!pg || !pg.guild || !pg.guild.tag) return null;
  return String(pg.guild.tag).replace(/[^A-Za-z0-9]/g,'').slice(0,4).toUpperCase() || null;
}

// Broadcast guild update to all online members
function broadcastGuildUpdate(guildId){
  const g = guilds[guildId];
  if(!g) return;
  const payload = {type:'guild_update', guildId, guild:g};
  for(const [ws, p] of players){
    if(!p.name) continue;
    if(g.members && g.members[p.name]){
      send(ws, payload);
    }
  }
}

// Broadcast guild chat to all online members
function broadcastGuildChat(guildId, fromName, msg){
  const g = guilds[guildId];
  if(!g) return;
  const payload = {type:'guild_chat', guildId, from:fromName, msg, ts:Date.now()};
  for(const [ws, p] of players){
    if(!p.name) continue;
    if(g.members && g.members[p.name]){
      send(ws, payload);
    }
  }
}

// Add XP to a player's guild (if they're in one)
function awardGuildXp(charName, xp){
  const found = findPlayerGuild(charName);
  if(!found) return;
  const {id, guild} = found;
  const oldLvl = guild.level || 1;
  guild.xp = (guild.xp || 0) + xp;
  const newLvl = guildLvlFromXp(guild.xp);
  if(newLvl > oldLvl){
    guild.level = newLvl;
    console.log(`[guild] ${guild.name} reached level ${newLvl}!`);
  }
  flushGuilds();
  // Don't broadcast every XP tick — batched by periodic send
}

// ══════════════════════════════════════════════════════════
// CLOUD SAVE SYSTEM
// Saves stored in saves.json on disk — persists across restarts
// Structure: { "username_raceid_class": { ...saveData, ts } }
// ══════════════════════════════════════════════════════════
const SAVES_FILE = path.join(DATA_DIR, 'saves.json');
let cloudSaves = {};
let saveOwners = {}; // a481 — saveKey -> owner token (declared before load block that uses it)

// Load saves from disk on startup
try {
  if (fs.existsSync(SAVES_FILE)) {
    const _parsed = JSON.parse(fs.readFileSync(SAVES_FILE, 'utf8'));
    // a481 — file shape migration. New format is { saves:{...}, owners:{...} }.
    //   Legacy files were the flat saves object with no owners — detect that (no
    //   `saves` key) and load it as saves with an empty owners map, so every legacy
    //   save is un-owned and gets grandfather-claimed on its owner's next save/load.
    if (_parsed && _parsed.saves && typeof _parsed.saves === 'object') {
      cloudSaves  = _parsed.saves;
      saveOwners  = (_parsed.owners && typeof _parsed.owners === 'object') ? _parsed.owners : {};
    } else {
      cloudSaves  = _parsed || {};
      saveOwners  = {};
    }
    console.log(`[saves] Loaded ${Object.keys(cloudSaves).length} cloud saves (${Object.keys(saveOwners).length} owned) from disk.`);
  }
} catch(e) {
  console.warn('[saves] Could not load saves.json:', e.message);
  cloudSaves = {};
  saveOwners = {};
}

// Write saves to disk (debounced — max once per 10s)
let _saveDirtyTimer = null;
function flushSaves() {
  if (_saveDirtyTimer) return;
  _saveDirtyTimer = setTimeout(() => {
    _saveDirtyTimer = null;
    // a481 — SERVER-3/4: async, atomic write. Old code used writeFileSync of the
    //   whole object, which blocks the event loop for every player during the flush
    //   and, if the process dies mid-write (Railway redeploy, OOM), leaves a
    //   truncated saves.json that takes ALL cloud saves with it. Now we serialize
    //   the {saves, owners} envelope, write to a temp file, then rename() — which is
    //   atomic on the same filesystem, so a crash never leaves a half-written file.
    const payload = JSON.stringify({ saves: cloudSaves, owners: saveOwners });
    const tmp = SAVES_FILE + '.tmp';
    fs.writeFile(tmp, payload, 'utf8', (err) => {
      if (err) { console.warn('[saves] Failed to write temp file:', err.message); return; }
      fs.rename(tmp, SAVES_FILE, (err2) => {
        if (err2) console.warn('[saves] Failed to rename save file:', err2.message);
      });
    });
  }, 10000);
}

function getSaveKey(name, raceId, cls) {
  return (name + '_' + raceId + '_' + cls).toLowerCase();
}

// a481 — SERVER-1: save ownership tokens. Without these, login trusts any name and
//   the save handlers trust data.name, so anyone could load (steal) or overwrite
//   (grief) another player's character just by knowing the handle. We record an
//   opaque owner token per save key. The client generates a random token once,
//   stores it locally, and sends it with every save/load. First contact with an
//   un-owned key (new save, or a legacy save from before this system) CLAIMS it for
//   the presenting token — so existing players are grandfathered on their next save
//   or load from their own machine. After that, only the matching token can
//   overwrite or load that save. Tokens live in a sibling map persisted in the same
//   file as the saves, so ownership survives restarts.
function _validToken(t){ return typeof t === 'string' && t.length >= 8 && t.length <= 128; }
function mintToken(){ return crypto.randomBytes(24).toString('hex'); }

function getAllSavesForUser(name) {
  const prefix = name.toLowerCase() + '_';
  return Object.entries(cloudSaves)
    .filter(([k]) => k.startsWith(prefix))
    .map(([k, v]) => ({ key: k, data: v }));
}

// ══════════════════════════════════════════════════════════
// ENEMY STATS — mirrors spawnZoneEnemies in the client
// ══════════════════════════════════════════════════════════
const ENEMY_STATS = {
  drone:             {hp:150,   atk:8,   spd:0.04,  aggroRange:6,  reward:15,   expR:4,    dmgReduction:0},
  soldier:           {hp:270,   atk:16,  spd:0.032, aggroRange:6,  reward:35,   expR:10,   dmgReduction:0},
  elite:             {hp:540,   atk:28,  spd:0.038, aggroRange:9,  reward:80,   expR:22,   dmgReduction:0},
  sniper:            {hp:195,   atk:22,  spd:0.024, aggroRange:14, reward:55,   expR:15,   dmgReduction:0},
  shield:            {hp:780,   atk:24,  spd:0.020, aggroRange:7,  reward:90,   expR:25,   dmgReduction:0},
  berserker:         {hp:1800,  atk:68,  spd:0.060, aggroRange:10, reward:140,  expR:72,   dmgReduction:0},
  bomber:            {hp:135,   atk:55,  spd:0.055, aggroRange:9,  reward:50,   expR:14,   dmgReduction:0},
  crawler:           {hp:210,   atk:18,  spd:0.055, aggroRange:7,  reward:40,   expR:12,   dmgReduction:0},
  brute:             {hp:960,   atk:38,  spd:0.022, aggroRange:8,  reward:110,  expR:30,   dmgReduction:0},
  wraith:            {hp:480,   atk:32,  spd:0.045, aggroRange:9,  reward:80,   expR:28,   dmgReduction:0},
  void_stalker:      {hp:660,   atk:42,  spd:0.038, aggroRange:11, reward:150,  expR:60,   dmgReduction:0},
  void_eye:          {hp:390,   atk:30,  spd:0.035, aggroRange:10, reward:110,  expR:45,   dmgReduction:0},
  iron_guard:        {hp:6500,  atk:165, spd:0.025, aggroRange:8,  reward:420,  expR:145,  dmgReduction:0},
  citadel_mage:      {hp:5200,  atk:150, spd:0.030, aggroRange:13, reward:380,  expR:130,  dmgReduction:0},
  rift_stalker:      {hp:24000, atk:280, spd:0.055, aggroRange:13, reward:900,  expR:650,  dmgReduction:0},
  psyche_horror:     {hp:18000, atk:260, spd:0.045, aggroRange:14, reward:800,  expR:600,  dmgReduction:0},
  void_colossus:     {hp:54000, atk:380, spd:0.018, aggroRange:10, reward:1400, expR:1100, dmgReduction:0},
  rift_weaver:       {hp:15000, atk:240, spd:0.060, aggroRange:12, reward:750,  expR:550,  dmgReduction:0},
  fire_demon:        {hp:36000, atk:320, spd:0.040, aggroRange:12, reward:1200, expR:400,  dmgReduction:0},
  wyvern:            {hp:27000, atk:260, spd:0.058, aggroRange:14, reward:1000, expR:350,  dmgReduction:0},
  void_spider:       {hp:21000, atk:220, spd:0.068, aggroRange:10, reward:850,  expR:290,  dmgReduction:0},
  inferno_golem:     {hp:66000, atk:400, spd:0.018, aggroRange:9,  reward:1500, expR:500,  dmgReduction:0},
  // a209 — Convergence Depth 3 electric tier (mirror of client ENEMY_STATS)
  arc_sentinel:      {hp:52000, atk:420, spd:0.034, aggroRange:13, reward:1700, expR:560,  dmgReduction:0},
  tesla_golem:       {hp:74000, atk:460, spd:0.020, aggroRange:10, reward:1900, expR:620,  dmgReduction:0.3},
  storm_wraith:      {hp:46000, atk:400, spd:0.062, aggroRange:14, reward:1600, expR:540,  dmgReduction:0},
  volt_hound:        {hp:48000, atk:430, spd:0.072, aggroRange:12, reward:1650, expR:560,  dmgReduction:0},
  // a211 — Convergence Depth 4 reptilian/geometric tier
  saurian_brute:     {hp:88000, atk:520, spd:0.038, aggroRange:12, reward:2200, expR:760,  dmgReduction:0.25},
  geo_basilisk:      {hp:70000, atk:500, spd:0.050, aggroRange:13, reward:2000, expR:720,  dmgReduction:0},
  cube_drake:        {hp:64000, atk:480, spd:0.058, aggroRange:14, reward:1950, expR:700,  dmgReduction:0},
  raptor_shard:      {hp:60000, atk:520, spd:0.080, aggroRange:12, reward:1900, expR:700,  dmgReduction:0},
  // a212 — Convergence Depth 5 technology tier
  sentry_mech:       {hp:108000, atk:600, spd:0.030, aggroRange:13, reward:2600, expR:900,  dmgReduction:0.3},
  hunter_drone:      {hp:80000,  atk:560, spd:0.085, aggroRange:15, reward:2300, expR:840,  dmgReduction:0},
  plasma_bot:        {hp:92000,  atk:620, spd:0.046, aggroRange:14, reward:2450, expR:880,  dmgReduction:0},
  cube_sentinel:     {hp:86000,  atk:580, spd:0.052, aggroRange:13, reward:2400, expR:860,  dmgReduction:0},
  // a215 — Convergence Depth 6 nature tier
  thorn_brute:       {hp:128000, atk:680, spd:0.034, aggroRange:12, reward:3000, expR:1050, dmgReduction:0.35},
  spore_fiend:       {hp:96000,  atk:640, spd:0.056, aggroRange:14, reward:2700, expR:980,  dmgReduction:0},
  vine_lasher:       {hp:104000, atk:660, spd:0.048, aggroRange:14, reward:2800, expR:1000, dmgReduction:0},
  bloom_wisp:        {hp:90000,  atk:620, spd:0.078, aggroRange:15, reward:2650, expR:960,  dmgReduction:0},
  // a220 — THE REACH elite "mini-boss" mobs (mirror client ENEMY_STATS)
  void_cube_warden:  {hp:340000, atk:900,  spd:0.022, aggroRange:18, reward:9000,  expR:4200, dmgReduction:0.4},
  sphere_disruptor:  {hp:260000, atk:980,  spd:0.030, aggroRange:22, reward:8200,  expR:3800, dmgReduction:0.2},
  cubic_annihilator: {hp:380000, atk:1100, spd:0.040, aggroRange:16, reward:9600,  expR:4400, dmgReduction:0.35},
  harbinger_sphere:  {hp:300000, atk:920,  spd:0.026, aggroRange:22, reward:9200,  expR:4200, dmgReduction:0.25},
  omega_observer:    {hp:440000, atk:1200, spd:0.028, aggroRange:24, reward:12000, expR:5200, dmgReduction:0.4},
  xu_miner:          {hp:820,   atk:68,  spd:0.048, aggroRange:9,  reward:220,  expR:72,   dmgReduction:0},
  xu_overseer:       {hp:1400,  atk:95,  spd:0.040, aggroRange:11, reward:340,  expR:110,  dmgReduction:0},
  // a540 — these two existed ONLY in the client stat tables; the server's unknown-type
  //   fallback is soldier (hp:270), so migrating the caves without them would have spawned
  //   half the mine at 270 HP (the a495 void_construct bug). Values mirror the client table.
  blast_sapper:      {hp:950,   atk:80,  spd:0.055, aggroRange:12, reward:300,  expR:95,   dmgReduction:0},
  crystal_lurker:    {hp:1600,  atk:88,  spd:0.044, aggroRange:7,  reward:380,  expR:120,  dmgReduction:0.15},
  wyvern_warlord:    {hp:55000, atk:400, spd:0.065, aggroRange:15, reward:1600, expR:550,  dmgReduction:0},
  elder_dragon:      {hp:90000, atk:480, spd:0.040, aggroRange:14, reward:2000, expR:680,  dmgReduction:0},
  deep_wyrm:         {hp:75000, atk:440, spd:0.030, aggroRange:11, reward:1800, expR:600,  dmgReduction:0},
  xu_titan:          {hp:36000, atk:360, spd:0.042, aggroRange:12, reward:1800, expR:600,  dmgReduction:0.38},
  xu_enforcer:       {hp:24000, atk:300, spd:0.100, aggroRange:14, reward:1500, expR:520,  dmgReduction:0.32},
  xu_annihilator:    {hp:70000, atk:420, spd:0.012, aggroRange:10, reward:2400, expR:620,  dmgReduction:0.42},
  xu_supreme:        {hp:30000, atk:340, spd:0.055, aggroRange:15, reward:2000, expR:650,  dmgReduction:0.36},
  xu_scout:          {hp:320,   atk:28,  spd:0.068, aggroRange:12, reward:75,   expR:24,   dmgReduction:0},
  xu_siege_bot:      {hp:2800,  atk:80,  spd:0.014, aggroRange:9,  reward:320,  expR:100,  dmgReduction:0.20},
  xu_commander:      {hp:480,   atk:38,  spd:0.036, aggroRange:11, reward:110,  expR:22,   dmgReduction:0},
  bandit:            {hp:220,   atk:18,  spd:0.038, aggroRange:7,  reward:40,   expR:12,   dmgReduction:0},
  bandit_archer:     {hp:180,   atk:22,  spd:0.030, aggroRange:12, reward:45,   expR:13,   dmgReduction:0},
  xu_rebel:          {hp:200,   atk:16,  spd:0.035, aggroRange:7,  reward:38,   expR:11,   dmgReduction:0},
  xu_shieldbot:      {hp:2200,  atk:110, spd:0.020, aggroRange:8,  reward:280,  expR:88,   dmgReduction:0.30},
  xu_sniper_elite:   {hp:1400,  atk:160, spd:0.025, aggroRange:16, reward:260,  expR:82,   dmgReduction:0},
  xu_commander_elite:{hp:1800,  atk:130, spd:0.030, aggroRange:10, reward:340,  expR:108,  dmgReduction:0},
  sand_scorpion:     {hp:3200,  atk:155, spd:0.058, aggroRange:9,  reward:320,  expR:105,  dmgReduction:0},
  desert_snake:      {hp:2400,  atk:170, spd:0.075, aggroRange:10, reward:280,  expR:92,   dmgReduction:0},
  sand_mummy:        {hp:6500,  atk:185, spd:0.022, aggroRange:8,  reward:560,  expR:180,  dmgReduction:0},
  dune_skeleton:     {hp:4800,  atk:195, spd:0.032, aggroRange:9,  reward:480,  expR:156,  dmgReduction:0},
  sand_worm:         {hp:22000, atk:280, spd:0.012, aggroRange:10, reward:1200, expR:360,  dmgReduction:0.25},
  mushroom_man:      {hp:880,   atk:52,  spd:0.028, aggroRange:8,  reward:140,  expR:44,   dmgReduction:0},
  spore_walker:      {hp:480,   atk:42,  spd:0.072, aggroRange:9,  reward:100,  expR:32,   dmgReduction:0},
  mycelium_horror:   {hp:2200,  atk:78,  spd:0.018, aggroRange:8,  reward:320,  expR:100,  dmgReduction:0},
  polar_bear:        {hp:1800,  atk:88,  spd:0.038, aggroRange:10, reward:280,  expR:90,   dmgReduction:0},
  ice_golem:         {hp:3200,  atk:95,  spd:0.016, aggroRange:7,  reward:380,  expR:120,  dmgReduction:0},
  frost_specter:     {hp:680,   atk:62,  spd:0.052, aggroRange:11, reward:160,  expR:52,   dmgReduction:0},
  ash_wraith:        {hp:2200,  atk:88,  spd:0.048, aggroRange:10, reward:200,  expR:80,   dmgReduction:0},
  magma_crab:        {hp:2400,  atk:82,  spd:0.020, aggroRange:7,  reward:340,  expR:108,  dmgReduction:0},
  void_phantom:      {hp:720,   atk:65,  spd:0.062, aggroRange:11, reward:170,  expR:55,   dmgReduction:0},
  stone_sentinel:    {hp:2800,  atk:88,  spd:0.016, aggroRange:8,  reward:360,  expR:115,  dmgReduction:0},
  vine_horror:       {hp:1400,  atk:72,  spd:0.026, aggroRange:9,  reward:260,  expR:82,   dmgReduction:0},
  skeleton_warrior:  {hp:720,   atk:52,  spd:0.028, aggroRange:8,  reward:120,  expR:38,   dmgReduction:0},
  grave_crawler:     {hp:600,   atk:44,  spd:0.065, aggroRange:9,  reward:95,   expR:32,   dmgReduction:0},
  bone_mage:         {hp:820,   atk:68,  spd:0.022, aggroRange:14, reward:150,  expR:48,   dmgReduction:0},
  death_knight:      {hp:1800,  atk:95,  spd:0.024, aggroRange:10, reward:280,  expR:55,   dmgReduction:0},
  fungal_shambler:   {hp:1200,  atk:65,  spd:0.025, aggroRange:8,  reward:200,  expR:65,   dmgReduction:0},
  frost_wraith:      {hp:680,   atk:62,  spd:0.052, aggroRange:11, reward:160,  expR:52,   dmgReduction:0},
  ancient_guardian:  {hp:2800,  atk:88,  spd:0.016, aggroRange:8,  reward:360,  expR:115,  dmgReduction:0},
  lava_golem:        {hp:2200,  atk:78,  spd:0.018, aggroRange:8,  reward:320,  expR:100,  dmgReduction:0},
  necro_specter:     {hp:45000, atk:580, spd:0.062, aggroRange:14, reward:3200, expR:1100, dmgReduction:0.30},
  necro_wight:       {hp:72000, atk:640, spd:0.038, aggroRange:10, reward:3800, expR:1250, dmgReduction:0.35},
  necro_abomination: {hp:130000,atk:820, spd:0.022, aggroRange:9,  reward:5200, expR:1600, dmgReduction:0.45},
  necro_lich_mage:   {hp:58000, atk:720, spd:0.030, aggroRange:16, reward:4400, expR:1400, dmgReduction:0.28},
  xf_titan_elite:    {hp:60000, atk:780, spd:0.048, aggroRange:13, reward:4200, expR:1400, dmgReduction:0.44},
  xf_fortress_drone: {hp:39000, atk:660, spd:0.110, aggroRange:15, reward:3600, expR:1200, dmgReduction:0.36},
  xf_siege_walker:   {hp:120000,atk:900, spd:0.014, aggroRange:11, reward:5400, expR:1600, dmgReduction:0.50},
  xf_warlord:        {hp:51000, atk:720, spd:0.062, aggroRange:16, reward:4800, expR:1500, dmgReduction:0.40},
  void_spike_horror:  {hp:3600,  atk:180, spd:0.040, aggroRange:12, reward:420, expR:140,  dmgReduction:0.15},
  // sanctuary
  sanctuary_guardian:  {hp:2400,  atk:95,  spd:0.025, aggroRange:8,  reward:280, expR:90,   dmgReduction:0},
  // ── VOID CITADEL — LV.70+ DIMENSIONAL FORTRESS ──
  void_construct:   {hp:32000, atk:320, spd:0.040, aggroRange:11, reward:1100, expR:820,  dmgReduction:0},
  void_sentinel:    {hp:44000, atk:360, spd:0.015, aggroRange:16, reward:1300, expR:950,  dmgReduction:0.10},
  // ── NEON HOLLOW — POST-CAP AA-GATED HARDEST ZONE ──
  sentinel_drone:      {hp:65000,  atk:480, spd:0.060, aggroRange:14, reward:1800, expR:1350, dmgReduction:0},
  maintenance_striker: {hp:95000,  atk:580, spd:0.048, aggroRange:10, reward:2200, expR:1600, dmgReduction:0.05},
  skybridge_sniper:    {hp:55000,  atk:720, spd:0.028, aggroRange:20, reward:2000, expR:1500, dmgReduction:0},
  hollow_enforcer:     {hp:140000, atk:640, spd:0.032, aggroRange:12, reward:3200, expR:2400, dmgReduction:0.15},
  neon_wraith:         {hp:80000,  atk:620, spd:0.060, aggroRange:13, reward:2600, expR:1900, dmgReduction:0},
  crash_car:           {hp:110000, atk:450, spd:0.085, aggroRange:15, reward:2400, expR:1800, dmgReduction:0},
  // ── VEILED SANCTUARY (v92.41) ──
  veiled_acolyte:      {hp:42000,  atk:280, spd:0.052, aggroRange:11, reward:900,  expR:680,  dmgReduction:0},
  censer_bearer:       {hp:62000,  atk:380, spd:0.040, aggroRange:10, reward:1200, expR:900,  dmgReduction:0.10},
  stone_inquisitor:    {hp:130000, atk:520, spd:0.020, aggroRange:9,  reward:2400, expR:1800, dmgReduction:0.30},
  choir_wraith:        {hp:38000,  atk:340, spd:0.058, aggroRange:13, reward:1100, expR:850,  dmgReduction:0},
  ritual_guardian:     {hp:95000,  atk:440, spd:0.026, aggroRange:10, reward:1800, expR:1400, dmgReduction:0.20},
  penitent_striker:    {hp:55000,  atk:480, spd:0.072, aggroRange:11, reward:1300, expR:1000, dmgReduction:0.05},
  veiled_cardinal:     {hp:240000, atk:560, spd:0.038, aggroRange:14, reward:5000, expR:3800, dmgReduction:0.15},
  forsaken_abbot:      {hp:280000, atk:620, spd:0.034, aggroRange:14, reward:5500, expR:4200, dmgReduction:0.20},
  // ── BLOOMING WILDS (v92.49) — Lv 10+ fey garden ──
  bloom_sprite:        {hp:380,    atk:32,  spd:0.058, aggroRange:11, reward:60,   expR:55,   dmgReduction:0},
  glimmer_fairy:       {hp:280,    atk:26,  spd:0.080, aggroRange:13, reward:55,   expR:50,   dmgReduction:0},
  mushroom_brute:      {hp:880,    atk:42,  spd:0.030, aggroRange:9,  reward:120,  expR:110,  dmgReduction:0.10},
  vine_stalker:        {hp:550,    atk:36,  spd:0.044, aggroRange:11, reward:100,  expR:90,   dmgReduction:0},
  pollen_wraith:       {hp:420,    atk:28,  spd:0.052, aggroRange:12, reward:80,   expR:75,   dmgReduction:0},
  thorn_knight:        {hp:3200,   atk:60,  spd:0.038, aggroRange:13, reward:600,  expR:550,  dmgReduction:0.20},
  // ── XERON (v92.55) — Lv 100+ orbital citadel, the final zone ──
  corrupted_xu:        {hp:65000,  atk:480, spd:0.046, aggroRange:13, reward:2200, expR:1700, dmgReduction:0.10},
  void_marine:         {hp:95000,  atk:580, spd:0.038, aggroRange:14, reward:2800, expR:2200, dmgReduction:0.18},
  holo_wraith:         {hp:48000,  atk:380, spd:0.064, aggroRange:14, reward:1600, expR:1300, dmgReduction:0},
  laser_turret:        {hp:70000,  atk:520, spd:0.000, aggroRange:18, reward:2000, expR:1500, dmgReduction:0.35},
  cyber_ogre:          {hp:180000, atk:720, spd:0.030, aggroRange:11, reward:5500, expR:4400, dmgReduction:0.25},
  shard_assassin:      {hp:55000,  atk:620, spd:0.085, aggroRange:14, reward:3000, expR:2400, dmgReduction:0.05},
  // ── LUCIDWILDE (a297) — Lv 100+ uberzone, on par with The Reach ──
  // a554 — RESYNCED to the client stat table (80_zone_defs.part). The server has never
  //   spawned Lucidwilde (no ZONE_SPAWNS entry existed until now), so these three
  //   entries were never kept in step and had drifted badly: HP was exactly a third of
  //   the client's, dmgReduction was 0.05/0.30/0 against the client's 0.25/0.45/0.20,
  //   and expR was roughly a quarter. Migrating against the stale values would have put
  //   paper mobs in a Lv100+ uberzone. All three types are EXCLUSIVE to Lucidwilde, so
  //   correcting the globals is safe — nothing else spawns them.
  // a555 — THE FORGE. These four were MISSING from ENEMY_STATS altogether, not merely
  //   stale: the server has never spawned this zone, so nothing ever required them to
  //   exist. createZoneEnemies falls back to ENEMY_STATS.soldier for an unknown type —
  //   270 hp and 16 atk — so creating the spawn slot without these would have put
  //   level-1 grunts in a Lv95 foundry. Values taken from the client stat table
  //   (80_zone_defs.part); all four types are exclusive to 'forge'.
  molten_crawler:        {hp:95000,  atk:480, spd:0.078, aggroRange:12, reward:2000, expR:2800, dmgReduction:0.08},
  lava_forged_sentinel:  {hp:220000, atk:620, spd:0.030, aggroRange:18, reward:3000, expR:4300, dmgReduction:0.20},
  forge_technician:      {hp:140000, atk:380, spd:0.046, aggroRange:14, reward:2400, expR:3600, dmgReduction:0.10},
  industrial_devastator: {hp:280000, atk:720, spd:0.026, aggroRange:20, reward:3600, expR:4800, dmgReduction:0.22},
  prismaraptor:        {hp:255000, atk:460, spd:0.082, aggroRange:14, reward:1600, expR:5000, dmgReduction:0.25},
  sporegon:            {hp:660000, atk:400, spd:0.022, aggroRange:9,  reward:2600, expR:7500, dmgReduction:0.45},
  vortexwisp:          {hp:180000, atk:520, spd:0.070, aggroRange:15, reward:1500, expR:4500, dmgReduction:0.20},
  // ── AVIA CANYON (a347) — Lv30 cybernetic birds (client-authoritative; here for parity) ──
  skyscout:            {hp:2800,   atk:95,  spd:0.052, aggroRange:17, reward:240,  expR:200,  dmgReduction:0},
  beakdrone:           {hp:4200,   atk:120, spd:0.070, aggroRange:14, reward:280,  expR:230,  dmgReduction:0.10},
  wingguard:           {hp:9000,   atk:110, spd:0.030, aggroRange:11, reward:420,  expR:340,  dmgReduction:0.35},
  spiraldive:          {hp:3400,   atk:130, spd:0.075, aggroRange:16, reward:320,  expR:270,  dmgReduction:0.05},
};

// Zone scale multipliers — matches client scaleMap
const ZONE_SCALE = {
  outpost:1.0, patrol:1.0, void:1.6, citadel:2.2, ashlands:2.8,
  sunken_sands:1.0, fungal:3.2, frostveil:3.6, ancient:4.0,
  sanctuary:1.0, dragonlair:1.0, riftvale:1.0, xumen:1.0,
  xumen_fortress:1.0, caves_of_despair:2.8, wyvernwastes:1.0, cemetery:1.4,
  necropolis:1.0, void_citadel:1.0, neon_hollow:1.0,
  veiled_sanctuary:1.0,  // v92.41
  blooming_wilds:1.0,    // v92.49
  xeron:1.0,             // v92.55
  convergence:2.0,       // v93.0 phase 3 — endgame procedural zone; enemies already at xeron-tier stats so 2.0x is plenty
  lucidwilde:1.0,        // a297 — Lucidwilde uberzone (mobs already endgame-tier)
  xulcan:1.0,            // a332 — Xulcan Prime (client-authoritative mobs; see ZONE_SPAWNS note)
  aviacanyon:1.0,        // a347 — Avia Canyon (client-authoritative birds; boss server-side)
  forge:1.0,             // a361 — THE FORGE (client-authoritative foundry mobs; boss server-side)
};

// ══════════════════════════════════════════════════════════
// ZONE ENEMY SPAWNS — mirrors ZONE_DEFS.enemySpawns
// Only the spawn positions and types; stats come from ENEMY_STATS
// ══════════════════════════════════════════════════════════
const TILE = 1.5; // a486 — MUST equal the client TILE (10_core_setup: const TILE=1.5). Was 1.6 — the comment claimed it matched, and every server→client world coordinate was skewed +6.7% because of it.

// ══════════════════════════════════════════════════════════
// ZONE BOSS HP — server-authoritative boss HP per zone
// ══════════════════════════════════════════════════════════
const ZONE_BOSS_HP = {
  patrol:           { hp:18000,    name:'SERPENT TITAN MK-VII' },
  cemetery:         { hp:64000,    name:'THE LICH KING' },
  void:             { hp:54000,    name:'VOID WRAITH PRIME' },
  citadel:          { hp:70000,    name:'GENERAL VORRAKH' },
  caves_of_despair: { hp:80000,    name:'FOREMAN DRAX' },
  ashlands:         { hp:75000,    name:'INFERNO COLOSSUS' },
  sunken_sands:     { hp:150000,   name:'KHEPRI THE SAND COLOSSUS' },
  fungal:           { hp:84000,    name:'MYCELIUM QUEEN' },
  frostveil:        { hp:96000,    name:'FROSTVEIL COLOSSUS' },
  ancient:          { hp:120000,   name:'THE ELDER ARCHITECT' },
  dragonlair:       { hp:375000,   name:'VAELTHARAX THE UNDYING' },
  riftvale:         { hp:400000,   name:'THE RIFT SOVEREIGN' },
  wyvernwastes:     { hp:500000,   name:'CRYOTHAR' },
  xumen:            { hp:675000,   name:'THE XU SUPREME OVERLORD' },
  necropolis:       { hp:1400000,  name:'THE BONE COLOSSUS' },
  xumen_fortress:   { hp:1200000,  name:'THE APEX PYRAMID' },
  void_citadel:     { hp:800000,   name:'COMMANDANT XERATH' },
  neon_hollow:      { hp:1600000,  name:'THE CURATOR' },
  veiled_sanctuary: { hp:850000,   name:'THE FINAL ABBOT' },  // v92.41
  blooming_wilds:   { hp:35000,    name:'THE WILDMOTHER' },   // v92.49
  xeron:            { hp:3000000,  name:'OVERSEER ZERO' },    // v92.55 — the final boss, the king of HP
  convergence:      { hp:2000000,  name:'THE DEPTH SENTINEL' },// v93.0 phase 3 — placeholder depth boss; phase 3.5 will add depth-tier progression
  the_reach:        { hp:5000000,  name:'KEEPER OF THE END' }, // a219 — final boss of the final zone
  lucidwilde:       { hp:5000000,  name:'THE PIXIELORD' },     // a297 — Lucidwilde uberzone apex
  xulcan:           { hp:2000000,  name:'XU ZET-HORAK' },      // a342 — Lv 90 apex, below Overseer Zero's 3M
  aviacanyon:       { hp:600000,   name:'XUBERRY' },          // a347 — Lv 30 parrot-warlord apex
  forge:            { hp:1500000,  name:'THE FURNACE CORE' },  // a361 — Lv 95 foundry titan (client-auth mobs, server-auth boss)
};

// ══════════════════════════════════════════════════════════
// WORLD BOSS DEFS — server-authoritative (a146).
// Mirrors the client's WORLD_BOSS_DEFS (in game.html ~L75833). Keep in sync.
// World bosses are EPHEMERAL — one active at a time per game, spawned on
// demand or by a server-side timer, killable by multiple players together.
// Stats are intentionally close to the client's so the HP bar matches what
// players see. Damage is server-authoritative once a game enters MP mode.
// ══════════════════════════════════════════════════════════
// a486 — TABLE SYNCED TO THE CLIENT (WORLD_BOSS_DEFS in 80_zone_defs.part, a458
//   anchors, post-240×240 coordinates). The old table was ancient: it filed the
//   Hollow Reaper under 'cemetery' at tile (25,25) while the client placed it in
//   'necropolis' at (56,120) — so the server's authoritative boss and the mesh
//   players saw were in DIFFERENT ZONES. The fight could never work: the server
//   boss idled unhit in an empty zone while players chased a local ghost.
//   Zones/coords now mirror the client exactly; server hp/atk tuning kept.
const WORLD_BOSS_DEFS = [
  { id:'forge_tyrant',     name:'The Forge Tyrant',       zone:'citadel',      tx:120,tz:56, hp:280000, atk:115, atkCooldown:90,  aggroRange:22, color:0xff6020, lootTier:3 },
  { id:'ancient_wyrm',     name:'Eyexor',                 zone:'dragonlair',   tx:40, tz:64, hp:320000, atk:120, atkCooldown:85,  aggroRange:22, color:0xaa44ff, lootTier:5 },
  { id:'hollow_reaper',    name:'The Hollow Reaper',      zone:'necropolis',   tx:56, tz:120,hp:360000, atk:130, atkCooldown:90,  aggroRange:22, color:0x44ddff, lootTier:4 },
  { id:'void_behemoth',    name:'The Void Behemoth',      zone:'neon_hollow',  tx:56, tz:120,hp:440000, atk:145, atkCooldown:95,  aggroRange:22, color:0xff00ff, lootTier:6 },
  { id:'abacus_of_flesh',  name:'The Abacus of Flesh',    zone:'void_citadel', tx:56, tz:120,hp:520000, atk:160, atkCooldown:100, aggroRange:24, color:0xcc1810, lootTier:7 },
  { id:'overseer_of_discord', name:'The Overseer of Discord', zone:'arena',    tx:120,tz:120,hp:680000, atk:175, atkCooldown:80,  aggroRange:26, color:0xffd84a, lootTier:8 },
  { id:'electronoid',      name:'Electronoid',            zone:'forge',        tx:120,tz:150,hp:960000, atk:190, atkCooldown:85,  aggroRange:24, color:0x46b4ff, lootTier:9 },   // a486 — existed client-side (a411) but the server never learned it
];
// id -> def lookup
const WORLD_BOSS_BY_ID = {};
WORLD_BOSS_DEFS.forEach(d => { WORLD_BOSS_BY_ID[d.id] = d; });
// Despawn timer after kill before another world boss can be summoned (ms)
const WORLD_BOSS_RESPAWN_MS = 2 * 60 * 1000; // 2 min
// Auto-despawn an active boss that's been idle (no hits) for this long (ms)
const WORLD_BOSS_IDLE_MS = 5 * 60 * 1000; // 5 min

const ZONE_SPAWNS = {
  outpost: [],
  sanctuary: [], // Safe hub — no enemies
  // a529 — MULTIPLAYER MIGRATION: Xu Patrol is now server-authoritative (bespoke patrol AI server-side).
  patrol: [
    {type:'xu_rebel', tx:20, tz:27},
    {type:'xu_rebel', tx:19, tz:32},
    {type:'xu_rebel', tx:25, tz:29},
    {type:'bandit', tx:23, tz:33},
    {type:'bandit', tx:25, tz:31},
    {type:'bandit', tx:25, tz:32},
    {type:'bandit_archer', tx:25, tz:22},
    {type:'bandit_archer', tx:33, tz:11},
    {type:'bandit_archer', tx:25, tz:10},
    {type:'sniper', tx:30, tz:22},
    {type:'sniper', tx:24, tz:12},
    {type:'sniper', tx:22, tz:29},
    {type:'xu_siege_bot', tx:20, tz:16},
    {type:'xu_siege_bot', tx:31, tz:30},
    {type:'xu_siege_bot', tx:24, tz:10},
    {type:'xu_rebel', tx:187, tz:33},
    {type:'xu_rebel', tx:185, tz:16},
    {type:'xu_rebel', tx:192, tz:25},
    {type:'bandit', tx:190, tz:33},
    {type:'bandit', tx:203, tz:11},
    {type:'bandit', tx:209, tz:19},
    {type:'bandit_archer', tx:199, tz:33},
    {type:'bandit_archer', tx:200, tz:18},
    {type:'bandit_archer', tx:185, tz:14},
    {type:'sniper', tx:204, tz:24},
    {type:'sniper', tx:208, tz:11},
    {type:'sniper', tx:184, tz:29},
    {type:'xu_siege_bot', tx:202, tz:31},
    {type:'xu_siege_bot', tx:184, tz:11},
    {type:'xu_siege_bot', tx:203, tz:21},
    {type:'xu_rebel', tx:17, tz:200},
    {type:'xu_rebel', tx:21, tz:192},
    {type:'xu_rebel', tx:18, tz:185},
    {type:'bandit', tx:33, tz:197},
    {type:'bandit', tx:21, tz:195},
    {type:'bandit', tx:11, tz:185},
    {type:'bandit_archer', tx:10, tz:189},
    {type:'bandit_archer', tx:11, tz:201},
    {type:'bandit_archer', tx:19, tz:190},
    {type:'sniper', tx:29, tz:193},
    {type:'sniper', tx:27, tz:188},
    {type:'sniper', tx:23, tz:202},
    {type:'xu_siege_bot', tx:33, tz:200},
    {type:'xu_siege_bot', tx:17, tz:192},
    {type:'xu_siege_bot', tx:13, tz:203},
    {type:'xu_rebel', tx:203, tz:192},
    {type:'xu_rebel', tx:215, tz:190},
    {type:'xu_rebel', tx:213, tz:205},
    {type:'bandit', tx:193, tz:205},
    {type:'bandit', tx:206, tz:192},
    {type:'bandit', tx:191, tz:199},
    {type:'bandit_archer', tx:193, tz:202},
    {type:'bandit_archer', tx:201, tz:199},
    {type:'bandit_archer', tx:202, tz:213},
    {type:'sniper', tx:208, tz:196},
    {type:'sniper', tx:205, tz:193},
    {type:'sniper', tx:206, tz:204},
    {type:'xu_siege_bot', tx:191, tz:189},
    {type:'xu_siege_bot', tx:202, tz:203},
    {type:'xu_siege_bot', tx:216, tz:193},
    {type:'xu_scout', tx:42, tz:35},
    {type:'xu_siege_bot', tx:207, tz:205},
    {type:'xu_commander', tx:20, tz:155},
    {type:'wraith', tx:152, tz:195},
    {type:'xu_scout', tx:42, tz:205},
    {type:'xu_siege_bot', tx:155, tz:108},
    {type:'xu_commander', tx:196, tz:165},
    {type:'wraith', tx:155, tz:174},
    {type:'xu_scout', tx:35, tz:64},
    {type:'xu_siege_bot', tx:35, tz:42},
    {type:'xu_commander', tx:174, tz:125},
    {type:'wraith', tx:165, tz:53},
    {type:'xu_scout', tx:75, tz:141},
    {type:'xu_siege_bot', tx:205, tz:97},
    {type:'xu_commander', tx:97, tz:45},
    {type:'wraith', tx:205, tz:108},
    {type:'xu_scout', tx:218, tz:35},
    {type:'xu_siege_bot', tx:35, tz:196},
    {type:'xu_commander', tx:115, tz:75},
    {type:'wraith', tx:31, tz:125},
    {type:'xu_scout', tx:35, tz:97},
    {type:'xu_siege_bot', tx:75, tz:207},
    {type:'xu_commander', tx:75, tz:31},
    {type:'wraith', tx:75, tz:86},
    {type:'xu_scout', tx:45, tz:174},
    {type:'xu_siege_bot', tx:130, tz:45},
    {type:'xu_commander', tx:155, tz:64},
    {type:'wraith', tx:195, tz:185},
    {type:'xu_scout', tx:86, tz:165},
    {type:'xu_siege_bot', tx:53, tz:115},
    {type:'xu_commander', tx:53, tz:205},
    {type:'wraith', tx:155, tz:42},
    {type:'xu_scout', tx:42, tz:165},
    {type:'xu_siege_bot', tx:218, tz:115},
    {type:'xu_commander', tx:119, tz:85},
    {type:'wraith', tx:155, tz:20},
    {type:'xu_scout', tx:64, tz:35},
    {type:'xu_siege_bot', tx:205, tz:152},
    {type:'xu_commander', tx:152, tz:165},
    {type:'wraith', tx:165, tz:152},
    {type:'xu_scout', tx:141, tz:75},
    {type:'xu_siege_bot', tx:35, tz:218},
    {type:'xu_commander', tx:195, tz:31},
    {type:'wraith', tx:165, tz:130},
    {type:'xu_scout', tx:207, tz:45},
    {type:'xu_siege_bot', tx:108, tz:165},
    {type:'xu_commander', tx:205, tz:119},
    {type:'wraith', tx:85, tz:64},
    {type:'xu_scout', tx:20, tz:45},
    {type:'xu_siege_bot', tx:185, tz:75},
    {type:'xu_commander', tx:42, tz:75},
    {type:'xu_scout', tx:155, tz:196},
    {type:'xu_siege_bot', tx:75, tz:125},
    {type:'xu_commander', tx:163, tz:155},
    {type:'xu_scout', tx:45, tz:86},
    {type:'xu_scout', tx:205, tz:174},
    {type:'xu_scout', tx:86, tz:115},
    {type:'xu_scout', tx:35, tz:141},
    {type:'xu_scout', tx:196, tz:85},
    {type:'xu_scout', tx:125, tz:207},
    {type:'xu_scout', tx:125, tz:152},
    {type:'xu_scout', tx:205, tz:53},
    {type:'xu_scout', tx:196, tz:45},
    {type:'xu_scout', tx:75, tz:97},
    {type:'xu_scout', tx:75, tz:174},
    {type:'xu_scout', tx:85, tz:218},
    {type:'xu_scout', tx:35, tz:185},
    {type:'xu_scout', tx:45, tz:20},
    {type:'xu_scout', tx:155, tz:31},
    {type:'xu_scout', tx:195, tz:64},
    {type:'xu_scout', tx:205, tz:141},
    {type:'xu_scout', tx:152, tz:45},
    {type:'xu_scout', tx:130, tz:165},
    {type:'xu_scout', tx:20, tz:205},
    {type:'xu_rebel', tx:48, tz:116},
    {type:'xu_rebel', tx:178, tz:110},
    {type:'xu_rebel', tx:32, tz:51},
    {type:'xu_rebel', tx:213, tz:152},
    {type:'xu_rebel', tx:134, tz:69},
    {type:'xu_rebel', tx:109, tz:30},
    {type:'xu_rebel', tx:175, tz:129},
    {type:'xu_rebel', tx:228, tz:143},
    {type:'xu_rebel', tx:126, tz:37},
    {type:'xu_rebel', tx:94, tz:223},
    {type:'xu_rebel', tx:144, tz:173},
    {type:'xu_rebel', tx:100, tz:226},
    {type:'bandit', tx:78, tz:191},
    {type:'bandit', tx:26, tz:68},
    {type:'bandit', tx:156, tz:20},
    {type:'bandit', tx:154, tz:103}
  ],
  // a538 — MULTIPLAYER MIGRATION: Xu Cemetery is now server-authoritative.
  cemetery: [
    {type:'death_knight', tx:160, tz:144},
    {type:'death_knight', tx:157, tz:144},
    {type:'death_knight', tx:157, tz:145},
    {type:'death_knight', tx:158, tz:144},
    {type:'death_knight', tx:158, tz:146},
    {type:'death_knight', tx:157, tz:147},
    {type:'death_knight', tx:147, tz:79},
    {type:'death_knight', tx:143, tz:81},
    {type:'death_knight', tx:141, tz:80},
    {type:'death_knight', tx:146, tz:83},
    {type:'death_knight', tx:146, tz:79},
    {type:'death_knight', tx:144, tz:81},
    {type:'death_knight', tx:175, tz:113},
    {type:'death_knight', tx:175, tz:115},
    {type:'death_knight', tx:176, tz:112},
    {type:'death_knight', tx:172, tz:112},
    {type:'death_knight', tx:174, tz:115},
    {type:'death_knight', tx:171, tz:111},
    {type:'death_knight', tx:123, tz:173},
    {type:'death_knight', tx:121, tz:178},
    {type:'death_knight', tx:124, tz:179},
    {type:'death_knight', tx:124, tz:174},
    {type:'death_knight', tx:123, tz:174},
    {type:'death_knight', tx:123, tz:180},
    {type:'death_knight', tx:121, tz:62},
    {type:'death_knight', tx:118, tz:61},
    {type:'death_knight', tx:119, tz:64},
    {type:'bone_mage', tx:120, tz:63},
    {type:'bone_mage', tx:119, tz:62},
    {type:'bone_mage', tx:120, tz:62},
    {type:'bone_mage', tx:144, tz:68},
    {type:'bone_mage', tx:148, tz:67},
    {type:'bone_mage', tx:146, tz:68},
    {type:'bone_mage', tx:148, tz:68},
    {type:'bone_mage', tx:142, tz:67},
    {type:'bone_mage', tx:146, tz:66},
    {type:'bone_mage', tx:177, tz:146},
    {type:'bone_mage', tx:179, tz:145},
    {type:'bone_mage', tx:179, tz:143},
    {type:'bone_mage', tx:180, tz:145},
    {type:'bone_mage', tx:177, tz:142},
    {type:'bone_mage', tx:176, tz:144},
    {type:'bone_mage', tx:176, tz:98},
    {type:'bone_mage', tx:182, tz:97},
    {type:'bone_mage', tx:177, tz:96},
    {type:'bone_mage', tx:178, tz:95},
    {type:'bone_mage', tx:180, tz:96},
    {type:'bone_mage', tx:178, tz:96},
    {type:'bone_mage', tx:55, tz:127},
    {type:'bone_mage', tx:54, tz:129},
    {type:'bone_mage', tx:55, tz:131},
    {type:'bone_mage', tx:58, tz:129},
    {type:'bone_mage', tx:52, tz:129},
    {type:'bone_mage', tx:55, tz:132},
    {type:'bone_mage', tx:87, tz:177},
    {type:'bone_mage', tx:86, tz:180},
    {type:'bone_mage', tx:85, tz:174},
    {type:'bone_mage', tx:87, tz:178},
    {type:'bone_mage', tx:84, tz:175},
    {type:'bone_mage', tx:86, tz:178},
    {type:'bone_mage', tx:59, tz:83},
    {type:'bone_mage', tx:58, tz:84},
    {type:'bone_mage', tx:60, tz:81},
    {type:'bone_mage', tx:64, tz:83},
    {type:'bone_mage', tx:60, tz:85},
    {type:'bone_mage', tx:59, tz:80},
    {type:'bone_mage', tx:96, tz:55},
    {type:'bone_mage', tx:98, tz:55},
    {type:'bone_mage', tx:99, tz:52},
    {type:'bone_mage', tx:97, tz:56},
    {type:'bone_mage', tx:100, tz:51},
    {type:'bone_mage', tx:54, tz:142},
    {type:'wraith', tx:52, tz:142},
    {type:'wraith', tx:53, tz:143},
    {type:'wraith', tx:49, tz:140},
    {type:'wraith', tx:50, tz:141},
    {type:'wraith', tx:159, tz:185},
    {type:'wraith', tx:155, tz:191},
    {type:'wraith', tx:155, tz:187},
    {type:'wraith', tx:158, tz:190},
    {type:'wraith', tx:155, tz:188},
    {type:'wraith', tx:176, tz:179},
    {type:'wraith', tx:175, tz:184},
    {type:'wraith', tx:174, tz:180},
    {type:'wraith', tx:175, tz:181},
    {type:'wraith', tx:177, tz:182},
    {type:'wraith', tx:120, tz:31},
    {type:'wraith', tx:117, tz:35},
    {type:'wraith', tx:120, tz:33},
    {type:'wraith', tx:122, tz:34},
    {type:'wraith', tx:117, tz:33},
    {type:'wraith', tx:54, tz:67},
    {type:'wraith', tx:54, tz:65},
    {type:'wraith', tx:56, tz:66},
    {type:'wraith', tx:55, tz:69},
    {type:'wraith', tx:54, tz:66},
    {type:'wraith', tx:31, tz:101},
    {type:'wraith', tx:33, tz:99},
    {type:'wraith', tx:34, tz:97},
    {type:'wraith', tx:33, tz:97},
    {type:'wraith', tx:35, tz:99},
    {type:'wraith', tx:210, tz:123},
    {type:'wraith', tx:213, tz:120},
    {type:'wraith', tx:211, tz:119},
    {type:'wraith', tx:214, tz:119},
    {type:'wraith', tx:209, tz:121},
    {type:'wraith', tx:57, tz:186},
    {type:'wraith', tx:54, tz:190},
    {type:'wraith', tx:56, tz:189},
    {type:'wraith', tx:58, tz:190},
    {type:'wraith', tx:56, tz:190},
    {type:'wraith', tx:142, tz:209},
    {type:'wraith', tx:140, tz:215},
    {type:'wraith', tx:142, tz:210},
    {type:'grave_crawler', tx:143, tz:213},
    {type:'grave_crawler', tx:142, tz:213},
    {type:'grave_crawler', tx:28, tz:117},
    {type:'grave_crawler', tx:24, tz:116},
    {type:'grave_crawler', tx:23, tz:119},
    {type:'grave_crawler', tx:25, tz:118},
    {type:'grave_crawler', tx:24, tz:118},
    {type:'grave_crawler', tx:189, tz:51},
    {type:'grave_crawler', tx:191, tz:53},
    {type:'grave_crawler', tx:188, tz:52},
    {type:'grave_crawler', tx:188, tz:54},
    {type:'grave_crawler', tx:186, tz:54},
    {type:'grave_crawler', tx:26, tz:143},
    {type:'grave_crawler', tx:26, tz:141},
    {type:'grave_crawler', tx:26, tz:142},
    {type:'grave_crawler', tx:24, tz:140},
    {type:'grave_crawler', tx:25, tz:144},
    {type:'grave_crawler', tx:80, tz:29},
    {type:'grave_crawler', tx:83, tz:29},
    {type:'grave_crawler', tx:82, tz:31},
    {type:'grave_crawler', tx:84, tz:30},
    {type:'grave_crawler', tx:81, tz:31},
    {type:'grave_crawler', tx:216, tz:149},
    {type:'grave_crawler', tx:216, tz:148},
    {type:'grave_crawler', tx:213, tz:149},
    {type:'grave_crawler', tx:212, tz:149},
    {type:'grave_crawler', tx:216, tz:151},
    {type:'grave_crawler', tx:213, tz:84},
    {type:'grave_crawler', tx:217, tz:84},
    {type:'grave_crawler', tx:214, tz:80},
    {type:'grave_crawler', tx:214, tz:81},
    {type:'grave_crawler', tx:215, tz:80},
    {type:'grave_crawler', tx:91, tz:218},
    {type:'grave_crawler', tx:94, tz:219},
    {type:'grave_crawler', tx:88, tz:222},
    {type:'grave_crawler', tx:91, tz:219},
    {type:'grave_crawler', tx:91, tz:223},
    {type:'grave_crawler', tx:155, tz:23},
    {type:'grave_crawler', tx:154, tz:23},
    {type:'grave_crawler', tx:155, tz:18},
    {type:'grave_crawler', tx:157, tz:20},
    {type:'grave_crawler', tx:154, tz:18},
    {type:'skeleton_warrior', tx:66, tz:30},
    {type:'skeleton_warrior', tx:66, tz:28},
    {type:'skeleton_warrior', tx:62, tz:28},
    {type:'skeleton_warrior', tx:66, tz:31},
    {type:'skeleton_warrior', tx:64, tz:32},
    {type:'skeleton_warrior', tx:27, tz:170},
    {type:'skeleton_warrior', tx:28, tz:169},
    {type:'skeleton_warrior', tx:25, tz:173},
    {type:'skeleton_warrior', tx:27, tz:174},
    {type:'skeleton_warrior', tx:26, tz:171},
    {type:'skeleton_warrior', tx:33, tz:63},
    {type:'skeleton_warrior', tx:28, tz:64},
    {type:'skeleton_warrior', tx:32, tz:62},
    {type:'skeleton_warrior', tx:33, tz:61},
    {type:'skeleton_warrior', tx:29, tz:61},
    {type:'skeleton_warrior', tx:184, tz:207},
    {type:'skeleton_warrior', tx:183, tz:206},
    {type:'skeleton_warrior', tx:184, tz:208},
    {type:'skeleton_warrior', tx:185, tz:207},
    {type:'skeleton_warrior', tx:184, tz:204},
    {type:'skeleton_warrior', tx:55, tz:204},
    {type:'skeleton_warrior', tx:55, tz:205},
    {type:'skeleton_warrior', tx:54, tz:207},
    {type:'skeleton_warrior', tx:58, tz:207},
    {type:'skeleton_warrior', tx:55, tz:210},
    {type:'skeleton_warrior', tx:185, tz:30},
    {type:'skeleton_warrior', tx:182, tz:33},
    {type:'skeleton_warrior', tx:182, tz:32},
    {type:'skeleton_warrior', tx:183, tz:34},
    {type:'skeleton_warrior', tx:183, tz:31},
    {type:'skeleton_warrior', tx:210, tz:56},
    {type:'skeleton_warrior', tx:209, tz:60},
    {type:'skeleton_warrior', tx:207, tz:58},
    {type:'skeleton_warrior', tx:212, tz:60},
    {type:'skeleton_warrior', tx:207, tz:56},
    {type:'skeleton_warrior', tx:210, tz:185},
    {type:'skeleton_warrior', tx:209, tz:182},
    {type:'skeleton_warrior', tx:211, tz:187},
    {type:'skeleton_warrior', tx:211, tz:182},
    {type:'skeleton_warrior', tx:208, tz:184},
    {type:'skeleton_warrior', tx:211, tz:26},
    {type:'skeleton_warrior', tx:205, tz:27},
    {type:'skeleton_warrior', tx:210, tz:29},
    {type:'skeleton_warrior', tx:206, tz:27},
    {type:'skeleton_warrior', tx:209, tz:26},
    {type:'skeleton_warrior', tx:219, tz:203},
    {type:'skeleton_warrior', tx:220, tz:204},
    {type:'skeleton_warrior', tx:220, tz:206},
    {type:'skeleton_warrior', tx:221, tz:205},
    {type:'skeleton_warrior', tx:218, tz:202},
    {type:'skeleton_warrior', tx:22, tz:29},
    {type:'skeleton_warrior', tx:27, tz:26},
    {type:'skeleton_warrior', tx:25, tz:27},
    {type:'skeleton_warrior', tx:26, tz:26},
    {type:'skeleton_warrior', tx:26, tz:30},
    {type:'skeleton_warrior', tx:20, tz:221},
    {type:'skeleton_warrior', tx:18, tz:219},
    {type:'skeleton_warrior', tx:19, tz:219},
    {type:'skeleton_warrior', tx:22, tz:220},
    {type:'skeleton_warrior', tx:21, tz:221}
  ],
  // a531 — MULTIPLAYER MIGRATION: Void Wastes is now server-authoritative.
  void: [
    {type:'void_stalker', tx:14, tz:25},
    {type:'void_sentinel', tx:14, tz:18},
    {type:'void_eye', tx:16, tz:27},
    {type:'void_sentinel', tx:15, tz:28},
    {type:'void_stalker', tx:63, tz:16},
    {type:'void_stalker', tx:57, tz:17},
    {type:'void_eye', tx:57, tz:15},
    {type:'void_stalker', tx:62, tz:13},
    {type:'void_sentinel', tx:82, tz:21},
    {type:'void_construct', tx:78, tz:24},
    {type:'wraith', tx:78, tz:23},
    {type:'void_construct', tx:82, tz:20},
    {type:'void_sentinel', tx:157, tz:23},
    {type:'void_construct', tx:160, tz:25},
    {type:'void_stalker', tx:181, tz:25},
    {type:'void_sentinel', tx:186, tz:30},
    {type:'void_spike_horror', tx:219, tz:18},
    {type:'void_phantom', tx:222, tz:18},
    {type:'void_stalker', tx:213, tz:15},
    {type:'void_phantom', tx:215, tz:15},
    {type:'void_eye', tx:26, tz:59},
    {type:'void_eye', tx:28, tz:59},
    {type:'void_phantom', tx:60, tz:51},
    {type:'void_eye', tx:57, tz:51},
    {type:'void_spike_horror', tx:79, tz:60},
    {type:'void_phantom', tx:86, tz:55},
    {type:'void_stalker', tx:80, tz:57},
    {type:'void_phantom', tx:80, tz:59},
    {type:'void_stalker', tx:113, tz:52},
    {type:'void_sentinel', tx:118, tz:47},
    {type:'void_eye', tx:115, tz:49},
    {type:'void_spike_horror', tx:151, tz:57},
    {type:'void_phantom', tx:153, tz:54},
    {type:'void_phantom', tx:151, tz:51},
    {type:'void_phantom', tx:182, tz:60},
    {type:'void_eye', tx:180, tz:59},
    {type:'void_sentinel', tx:227, tz:50},
    {type:'void_construct', tx:226, tz:51},
    {type:'wraith', tx:226, tz:48},
    {type:'wraith', tx:20, tz:88},
    {type:'void_phantom', tx:19, tz:90},
    {type:'void_spike_horror', tx:53, tz:85},
    {type:'void_phantom', tx:51, tz:89},
    {type:'void_sentinel', tx:89, tz:90},
    {type:'void_construct', tx:85, tz:88},
    {type:'void_stalker', tx:121, tz:94},
    {type:'void_sentinel', tx:123, tz:94},
    {type:'void_eye', tx:123, tz:91},
    {type:'void_stalker', tx:154, tz:94},
    {type:'void_sentinel', tx:154, tz:97},
    {type:'void_eye', tx:158, tz:91},
    {type:'void_spike_horror', tx:185, tz:79},
    {type:'void_phantom', tx:176, tz:82},
    {type:'void_sentinel', tx:222, tz:85},
    {type:'void_construct', tx:223, tz:84},
    {type:'wraith', tx:224, tz:90},
    {type:'void_construct', tx:223, tz:91},
    {type:'void_stalker', tx:63, tz:118},
    {type:'void_stalker', tx:61, tz:113},
    {type:'void_eye', tx:57, tz:115},
    {type:'void_stalker', tx:86, tz:115},
    {type:'void_stalker', tx:80, tz:119},
    {type:'void_eye', tx:81, tz:116},
    {type:'void_stalker', tx:80, tz:114},
    {type:'void_stalker', tx:157, tz:116},
    {type:'void_stalker', tx:162, tz:117},
    {type:'void_sentinel', tx:185, tz:112},
    {type:'void_construct', tx:188, tz:119},
    {type:'wraith', tx:192, tz:113},
    {type:'void_stalker', tx:17, tz:146},
    {type:'void_stalker', tx:15, tz:144},
    {type:'void_stalker', tx:56, tz:154},
    {type:'void_stalker', tx:52, tz:152},
    {type:'void_eye', tx:58, tz:157},
    {type:'void_stalker', tx:55, tz:156},
    {type:'void_stalker', tx:86, tz:146},
    {type:'void_sentinel', tx:91, tz:143},
    {type:'void_eye', tx:90, tz:150},
    {type:'void_sentinel', tx:86, tz:150},
    {type:'void_sentinel', tx:117, tz:150},
    {type:'void_construct', tx:122, tz:153},
    {type:'wraith', tx:120, tz:154},
    {type:'void_construct', tx:119, tz:150},
    {type:'void_stalker', tx:149, tz:162},
    {type:'void_stalker', tx:149, tz:164},
    {type:'void_eye', tx:147, tz:163},
    {type:'void_construct', tx:185, tz:149},
    {type:'void_stalker', tx:178, tz:149},
    {type:'void_eye', tx:187, tz:148},
    {type:'void_stalker', tx:183, tz:146},
    {type:'void_sentinel', tx:220, tz:158},
    {type:'void_construct', tx:221, tz:152},
    {type:'wraith', tx:214, tz:157},
    {type:'void_spike_horror', tx:20, tz:185},
    {type:'void_phantom', tx:16, tz:181},
    {type:'void_spike_horror', tx:49, tz:194},
    {type:'void_phantom', tx:49, tz:190},
    {type:'void_stalker', tx:47, tz:190},
    {type:'void_eye', tx:85, tz:186},
    {type:'void_eye', tx:87, tz:180},
    {type:'void_phantom', tx:94, tz:187},
    {type:'void_stalker', tx:118, tz:189},
    {type:'void_sentinel', tx:112, tz:191},
    {type:'void_eye', tx:112, tz:194},
    {type:'void_sentinel', tx:116, tz:190},
    {type:'void_eye', tx:150, tz:192},
    {type:'void_eye', tx:156, tz:195},
    {type:'void_stalker', tx:178, tz:184},
    {type:'void_sentinel', tx:183, tz:187},
    {type:'void_eye', tx:185, tz:189},
    {type:'void_sentinel', tx:181, tz:185},
    {type:'void_construct', tx:215, tz:182},
    {type:'void_stalker', tx:219, tz:185},
    {type:'void_eye', tx:216, tz:185},
    {type:'void_stalker', tx:212, tz:184},
    {type:'void_construct', tx:28, tz:223},
    {type:'void_stalker', tx:27, tz:223},
    {type:'void_eye', tx:20, tz:221},
    {type:'void_stalker', tx:28, tz:225},
    {type:'void_construct', tx:48, tz:225},
    {type:'void_stalker', tx:45, tz:219},
    {type:'void_eye', tx:50, tz:222},
    {type:'void_eye', tx:89, tz:219},
    {type:'void_phantom', tx:91, tz:221},
    {type:'void_eye', tx:149, tz:214},
    {type:'void_eye', tx:151, tz:217},
    {type:'void_phantom', tx:187, tz:222},
    {type:'void_stalker', tx:185, tz:222}
  ],
  // a541 — MULTIPLAYER MIGRATION: Xu Citadel is now server-authoritative.
  citadel: [
    {type:'xu_commander_elite', tx:97, tz:98},
    {type:'xu_commander_elite', tx:98, tz:99},
    {type:'xu_commander_elite', tx:110, tz:87},
    {type:'xu_commander_elite', tx:108, tz:87},
    {type:'xu_commander_elite', tx:150, tz:142},
    {type:'xu_commander_elite', tx:151, tz:139},
    {type:'xu_commander_elite', tx:83, tz:112},
    {type:'xu_commander_elite', tx:83, tz:110},
    {type:'xu_commander_elite', tx:160, tz:119},
    {type:'xu_commander_elite', tx:162, tz:117},
    {type:'xu_commander_elite', tx:82, tz:110},
    {type:'xu_commander_elite', tx:83, tz:109},
    {type:'xu_shieldbot', tx:130, tz:80},
    {type:'xu_shieldbot', tx:130, tz:78},
    {type:'xu_shieldbot', tx:76, tz:133},
    {type:'xu_shieldbot', tx:75, tz:133},
    {type:'xu_shieldbot', tx:120, tz:164},
    {type:'xu_shieldbot', tx:120, tz:166},
    {type:'xu_shieldbot', tx:147, tz:157},
    {type:'xu_shieldbot', tx:144, tz:156},
    {type:'xu_shieldbot', tx:147, tz:84},
    {type:'xu_shieldbot', tx:149, tz:86},
    {type:'xu_shieldbot', tx:102, tz:165},
    {type:'xu_shieldbot', tx:101, tz:165},
    {type:'xu_shieldbot', tx:161, tz:95},
    {type:'xu_shieldbot', tx:162, tz:95},
    {type:'xu_shieldbot', tx:153, tz:160},
    {type:'xu_shieldbot', tx:156, tz:161},
    {type:'xu_shieldbot', tx:67, tz:111},
    {type:'xu_shieldbot', tx:66, tz:113},
    {type:'xu_shieldbot', tx:102, tz:171},
    {type:'xu_shieldbot', tx:102, tz:173},
    {type:'xu_shieldbot', tx:161, tz:80},
    {type:'xu_shieldbot', tx:161, tz:81},
    {type:'xu_shieldbot', tx:177, tz:104},
    {type:'xu_shieldbot', tx:175, tz:103},
    {type:'xu_sniper_elite', tx:179, tz:128},
    {type:'xu_sniper_elite', tx:179, tz:127},
    {type:'xu_sniper_elite', tx:98, tz:65},
    {type:'xu_sniper_elite', tx:100, tz:65},
    {type:'xu_sniper_elite', tx:119, tz:58},
    {type:'xu_sniper_elite', tx:121, tz:57},
    {type:'xu_sniper_elite', tx:77, tz:163},
    {type:'xu_sniper_elite', tx:74, tz:161},
    {type:'xu_sniper_elite', tx:168, tz:83},
    {type:'xu_sniper_elite', tx:169, tz:82},
    {type:'xu_sniper_elite', tx:177, tz:146},
    {type:'xu_sniper_elite', tx:178, tz:143},
    {type:'xu_sniper_elite', tx:127, tz:181},
    {type:'xu_sniper_elite', tx:125, tz:181},
    {type:'xu_sniper_elite', tx:132, tz:57},
    {type:'xu_sniper_elite', tx:133, tz:54},
    {type:'xu_sniper_elite', tx:75, tz:71},
    {type:'xu_sniper_elite', tx:77, tz:73},
    {type:'xu_sniper_elite', tx:57, tz:130},
    {type:'xu_sniper_elite', tx:55, tz:132},
    {type:'xu_sniper_elite', tx:180, tz:152},
    {type:'xu_sniper_elite', tx:176, tz:153},
    {type:'xu_sniper_elite', tx:67, tz:79},
    {type:'xu_sniper_elite', tx:67, tz:82},
    {type:'xu_sniper_elite', tx:57, tz:98},
    {type:'xu_sniper_elite', tx:58, tz:99},
    {type:'citadel_mage', tx:138, tz:186},
    {type:'citadel_mage', tx:134, tz:184},
    {type:'citadel_mage', tx:65, tz:161},
    {type:'citadel_mage', tx:65, tz:164},
    {type:'citadel_mage', tx:166, tz:65},
    {type:'citadel_mage', tx:164, tz:64},
    {type:'citadel_mage', tx:162, tz:177},
    {type:'citadel_mage', tx:165, tz:176},
    {type:'citadel_mage', tx:50, tz:144},
    {type:'citadel_mage', tx:50, tz:142},
    {type:'citadel_mage', tx:81, tz:182},
    {type:'citadel_mage', tx:83, tz:183},
    {type:'citadel_mage', tx:70, tz:173},
    {type:'citadel_mage', tx:72, tz:173},
    {type:'citadel_mage', tx:135, tz:193},
    {type:'citadel_mage', tx:133, tz:191},
    {type:'citadel_mage', tx:47, tz:111},
    {type:'citadel_mage', tx:47, tz:113},
    {type:'citadel_mage', tx:125, tz:196},
    {type:'citadel_mage', tx:125, tz:194},
    {type:'citadel_mage', tx:153, tz:192},
    {type:'citadel_mage', tx:151, tz:189},
    {type:'citadel_mage', tx:175, tz:175},
    {type:'citadel_mage', tx:176, tz:175},
    {type:'citadel_mage', tx:77, tz:57},
    {type:'citadel_mage', tx:77, tz:56},
    {type:'citadel_mage', tx:145, tz:47},
    {type:'citadel_mage', tx:48, tz:92},
    {type:'citadel_mage', tx:103, tz:42},
    {type:'citadel_mage', tx:198, tz:121},
    {type:'citadel_mage', tx:118, tz:42},
    {type:'citadel_mage', tx:195, tz:146},
    {type:'citadel_mage', tx:176, tz:62},
    {type:'citadel_mage', tx:61, tz:66},
    {type:'iron_guard', tx:43, tz:148},
    {type:'iron_guard', tx:191, tz:77},
    {type:'iron_guard', tx:82, tz:192},
    {type:'iron_guard', tx:105, tz:203},
    {type:'iron_guard', tx:170, tz:48},
    {type:'iron_guard', tx:159, tz:43},
    {type:'iron_guard', tx:196, tz:162},
    {type:'iron_guard', tx:205, tz:98},
    {type:'iron_guard', tx:74, tz:43},
    {type:'iron_guard', tx:212, tz:124},
    {type:'iron_guard', tx:174, tz:196},
    {type:'iron_guard', tx:149, tz:209},
    {type:'iron_guard', tx:35, tz:76},
    {type:'iron_guard', tx:124, tz:215},
    {type:'iron_guard', tx:98, tz:27},
    {type:'iron_guard', tx:199, tz:172},
    {type:'iron_guard', tx:71, tz:39},
    {type:'iron_guard', tx:46, tz:62},
    {type:'iron_guard', tx:28, tz:145},
    {type:'iron_guard', tx:216, tz:97},
    {type:'iron_guard', tx:36, tz:171},
    {type:'iron_guard', tx:150, tz:25},
    {type:'iron_guard', tx:85, tz:212},
    {type:'iron_guard', tx:166, tz:212},
    {type:'iron_guard', tx:62, tz:202},
    {type:'iron_guard', tx:20, tz:114},
    {type:'iron_guard', tx:70, tz:30},
    {type:'iron_guard', tx:190, tz:47},
    {type:'iron_guard', tx:42, tz:187},
    {type:'iron_guard', tx:172, tz:206},
    {type:'iron_guard', tx:138, tz:20},
    {type:'iron_guard', tx:19, tz:104},
    {type:'iron_guard', tx:208, tz:174},
    {type:'iron_guard', tx:29, tz:69},
    {type:'iron_guard', tx:225, tz:138},
    {type:'iron_guard', tx:101, tz:223},
    {type:'iron_guard', tx:204, tz:56},
    {type:'iron_guard', tx:89, tz:16},
    {type:'iron_guard', tx:217, tz:73},
    {type:'iron_guard', tx:226, tz:159},
    {type:'iron_guard', tx:18, tz:160},
    {type:'iron_guard', tx:16, tz:81},
    {type:'iron_guard', tx:67, tz:220},
    {type:'iron_guard', tx:205, tz:197},
    {type:'iron_guard', tx:180, tz:25},
    {type:'iron_guard', tx:193, tz:209},
    {type:'iron_guard', tx:216, tz:54},
    {type:'iron_guard', tx:22, tz:183},
    {type:'iron_guard', tx:32, tz:38},
    {type:'iron_guard', tx:51, tz:20},
    {type:'iron_guard', tx:211, tz:203},
    {type:'iron_guard', tx:198, tz:25},
    {type:'iron_guard', tx:20, tz:39},
    {type:'iron_guard', tx:24, tz:204},
    {type:'iron_guard', tx:39, tz:223},
    {type:'iron_guard', tx:222, tz:37},
    {type:'iron_guard', tx:214, tz:27},
    {type:'iron_guard', tx:32, tz:20},
    {type:'iron_guard', tx:17, tz:208},
    {type:'iron_guard', tx:224, tz:215}
  ],
  // a540 — MULTIPLAYER MIGRATION: Caves of Despair is now server-authoritative.
  caves_of_despair: [
    {type:'xu_miner', tx:8, tz:8},
    {type:'xu_overseer', tx:14, tz:6},
    {type:'blast_sapper', tx:18, tz:10},
    {type:'crystal_lurker', tx:22, tz:8},
    {type:'xu_miner', tx:26, tz:10},
    {type:'xu_overseer', tx:30, tz:6},
    {type:'blast_sapper', tx:44, tz:8},
    {type:'crystal_lurker', tx:52, tz:6},
    {type:'xu_miner', tx:60, tz:10},
    {type:'xu_overseer', tx:68, tz:8},
    {type:'blast_sapper', tx:74, tz:12},
    {type:'crystal_lurker', tx:6, tz:16},
    {type:'xu_miner', tx:8, tz:18},
    {type:'xu_overseer', tx:10, tz:16},
    {type:'blast_sapper', tx:6, tz:20},
    {type:'crystal_lurker', tx:10, tz:20},
    {type:'xu_miner', tx:32, tz:14},
    {type:'xu_overseer', tx:34, tz:16},
    {type:'blast_sapper', tx:36, tz:14},
    {type:'crystal_lurker', tx:32, tz:18},
    {type:'xu_miner', tx:62, tz:16},
    {type:'xu_overseer', tx:64, tz:18},
    {type:'blast_sapper', tx:66, tz:16},
    {type:'crystal_lurker', tx:62, tz:20},
    {type:'xu_miner', tx:14, tz:26},
    {type:'xu_overseer', tx:16, tz:28},
    {type:'blast_sapper', tx:18, tz:26},
    {type:'crystal_lurker', tx:14, tz:30},
    {type:'xu_miner', tx:18, tz:30},
    {type:'xu_overseer', tx:50, tz:26},
    {type:'blast_sapper', tx:52, tz:28},
    {type:'crystal_lurker', tx:54, tz:26},
    {type:'xu_miner', tx:50, tz:30},
    {type:'xu_overseer', tx:54, tz:30},
    {type:'blast_sapper', tx:24, tz:24},
    {type:'crystal_lurker', tx:30, tz:26},
    {type:'xu_miner', tx:40, tz:28},
    {type:'xu_overseer', tx:44, tz:26},
    {type:'blast_sapper', tx:60, tz:26},
    {type:'crystal_lurker', tx:68, tz:28},
    {type:'xu_miner', tx:74, tz:26},
    {type:'xu_overseer', tx:6, tz:28},
    {type:'blast_sapper', tx:8, tz:32},
    {type:'crystal_lurker', tx:22, tz:34},
    {type:'xu_miner', tx:28, tz:32},
    {type:'xu_overseer', tx:70, tz:32},
    {type:'blast_sapper', tx:74, tz:34},
    {type:'crystal_lurker', tx:6, tz:40},
    {type:'xu_miner', tx:10, tz:42},
    {type:'xu_overseer', tx:14, tz:40},
    {type:'blast_sapper', tx:16, tz:42},
    {type:'crystal_lurker', tx:60, tz:40},
    {type:'xu_miner', tx:64, tz:42},
    {type:'xu_overseer', tx:70, tz:40},
    {type:'blast_sapper', tx:74, tz:42},
    {type:'crystal_lurker', tx:10, tz:50},
    {type:'xu_miner', tx:12, tz:52},
    {type:'xu_overseer', tx:14, tz:50},
    {type:'blast_sapper', tx:10, tz:54},
    {type:'crystal_lurker', tx:14, tz:54},
    {type:'xu_miner', tx:36, tz:50},
    {type:'xu_overseer', tx:38, tz:52},
    {type:'blast_sapper', tx:40, tz:50},
    {type:'crystal_lurker', tx:36, tz:54},
    {type:'xu_miner', tx:40, tz:54},
    {type:'xu_overseer', tx:64, tz:50},
    {type:'blast_sapper', tx:66, tz:52},
    {type:'crystal_lurker', tx:68, tz:50},
    {type:'xu_miner', tx:64, tz:54},
    {type:'xu_overseer', tx:68, tz:54},
    {type:'blast_sapper', tx:22, tz:48},
    {type:'crystal_lurker', tx:26, tz:52},
    {type:'xu_miner', tx:30, tz:48},
    {type:'xu_overseer', tx:48, tz:48},
    {type:'blast_sapper', tx:54, tz:52},
    {type:'crystal_lurker', tx:58, tz:48},
    {type:'xu_miner', tx:22, tz:58},
    {type:'xu_overseer', tx:28, tz:60},
    {type:'blast_sapper', tx:48, tz:58},
    {type:'crystal_lurker', tx:54, tz:60},
    {type:'xu_miner', tx:10, tz:66},
    {type:'xu_overseer', tx:12, tz:68},
    {type:'blast_sapper', tx:14, tz:66},
    {type:'crystal_lurker', tx:10, tz:70},
    {type:'xu_miner', tx:14, tz:70},
    {type:'xu_overseer', tx:36, tz:68},
    {type:'blast_sapper', tx:38, tz:66},
    {type:'crystal_lurker', tx:40, tz:68},
    {type:'xu_miner', tx:36, tz:70},
    {type:'xu_overseer', tx:40, tz:70},
    {type:'blast_sapper', tx:38, tz:72},
    {type:'crystal_lurker', tx:62, tz:66},
    {type:'xu_miner', tx:64, tz:68},
    {type:'xu_overseer', tx:66, tz:66},
    {type:'blast_sapper', tx:62, tz:70},
    {type:'crystal_lurker', tx:66, tz:70},
    {type:'xu_miner', tx:20, tz:64},
    {type:'xu_overseer', tx:26, tz:68},
    {type:'blast_sapper', tx:48, tz:66},
    {type:'crystal_lurker', tx:54, tz:68},
    {type:'xu_miner', tx:24, tz:74},
    {type:'xu_overseer', tx:50, tz:74},
    {type:'blast_sapper', tx:72, tz:72}
  ],
  // a539 — MULTIPLAYER MIGRATION: The Ashlands is now server-authoritative.
  ashlands: [
    {type:'lava_golem', tx:93, tz:139},
    {type:'lava_golem', tx:97, tz:139},
    {type:'lava_golem', tx:125, tz:87},
    {type:'lava_golem', tx:128, tz:88},
    {type:'lava_golem', tx:85, tz:136},
    {type:'lava_golem', tx:85, tz:137},
    {type:'lava_golem', tx:81, tz:123},
    {type:'lava_golem', tx:83, tz:122},
    {type:'lava_golem', tx:126, tz:160},
    {type:'lava_golem', tx:124, tz:162},
    {type:'lava_golem', tx:159, tz:105},
    {type:'lava_golem', tx:156, tz:105},
    {type:'lava_golem', tx:99, tz:157},
    {type:'lava_golem', tx:99, tz:156},
    {type:'lava_golem', tx:163, tz:127},
    {type:'lava_golem', tx:163, tz:126},
    {type:'lava_golem', tx:80, tz:110},
    {type:'lava_golem', tx:77, tz:109},
    {type:'lava_golem', tx:133, tz:165},
    {type:'lava_golem', tx:132, tz:166},
    {type:'lava_golem', tx:139, tz:77},
    {type:'lava_golem', tx:135, tz:76},
    {type:'lava_golem', tx:162, tz:145},
    {type:'lava_golem', tx:163, tz:142},
    {type:'lava_golem', tx:102, tz:76},
    {type:'lava_golem', tx:99, tz:76},
    {type:'lava_golem', tx:86, tz:160},
    {type:'lava_golem', tx:83, tz:161},
    {type:'lava_golem', tx:122, tz:67},
    {type:'lava_golem', tx:122, tz:68},
    {type:'lava_golem', tx:119, tz:175},
    {type:'lava_golem', tx:117, tz:173},
    {type:'lava_golem', tx:162, tz:159},
    {type:'lava_golem', tx:159, tz:156},
    {type:'berserker', tx:177, tz:120},
    {type:'berserker', tx:177, tz:119},
    {type:'berserker', tx:61, tz:117},
    {type:'berserker', tx:61, tz:119},
    {type:'berserker', tx:137, tz:174},
    {type:'berserker', tx:136, tz:177},
    {type:'berserker', tx:78, tz:80},
    {type:'berserker', tx:80, tz:80},
    {type:'berserker', tx:139, tz:65},
    {type:'berserker', tx:136, tz:64},
    {type:'berserker', tx:173, tz:94},
    {type:'berserker', tx:175, tz:94},
    {type:'berserker', tx:64, tz:101},
    {type:'berserker', tx:65, tz:102},
    {type:'berserker', tx:161, tz:79},
    {type:'berserker', tx:162, tz:79},
    {type:'berserker', tx:107, tz:177},
    {type:'berserker', tx:104, tz:178},
    {type:'berserker', tx:177, tz:142},
    {type:'berserker', tx:178, tz:139},
    {type:'berserker', tx:93, tz:63},
    {type:'berserker', tx:93, tz:64},
    {type:'berserker', tx:56, tz:141},
    {type:'berserker', tx:56, tz:140},
    {type:'berserker', tx:65, tz:161},
    {type:'berserker', tx:67, tz:157},
    {type:'berserker', tx:157, tz:179},
    {type:'berserker', tx:154, tz:179},
    {type:'berserker', tx:157, tz:60},
    {type:'berserker', tx:154, tz:60},
    {type:'berserker', tx:189, tz:119},
    {type:'berserker', tx:192, tz:119},
    {type:'berserker', tx:184, tz:86},
    {type:'berserker', tx:182, tz:89},
    {type:'berserker', tx:180, tz:155},
    {type:'berserker', tx:183, tz:155},
    {type:'berserker', tx:117, tz:192},
    {type:'berserker', tx:120, tz:193},
    {type:'berserker', tx:83, tz:58},
    {type:'berserker', tx:85, tz:56},
    {type:'berserker', tx:56, tz:77},
    {type:'berserker', tx:55, tz:80},
    {type:'berserker', tx:146, tz:46},
    {type:'berserker', tx:145, tz:46},
    {type:'berserker', tx:196, tz:102},
    {type:'berserker', tx:194, tz:100},
    {type:'berserker', tx:102, tz:193},
    {type:'berserker', tx:46, tz:144},
    {type:'magma_crab', tx:75, tz:182},
    {type:'magma_crab', tx:150, tz:50},
    {type:'magma_crab', tx:153, tz:192},
    {type:'magma_crab', tx:40, tz:117},
    {type:'magma_crab', tx:181, tz:67},
    {type:'magma_crab', tx:177, tz:178},
    {type:'magma_crab', tx:193, tz:157},
    {type:'magma_crab', tx:98, tz:42},
    {type:'magma_crab', tx:201, tz:131},
    {type:'magma_crab', tx:38, tz:107},
    {type:'magma_crab', tx:197, tz:84},
    {type:'magma_crab', tx:62, tz:178},
    {type:'magma_crab', tx:121, tz:37},
    {type:'magma_crab', tx:80, tz:45},
    {type:'magma_crab', tx:83, tz:196},
    {type:'magma_crab', tx:140, tz:201},
    {type:'magma_crab', tx:46, tz:165},
    {type:'magma_crab', tx:58, tz:60},
    {type:'magma_crab', tx:43, tz:78},
    {type:'magma_crab', tx:125, tz:209},
    {type:'magma_crab', tx:171, tz:195},
    {type:'magma_crab', tx:212, tz:121},
    {type:'magma_crab', tx:175, tz:47},
    {type:'magma_crab', tx:140, tz:210},
    {type:'magma_crab', tx:85, tz:212},
    {type:'magma_crab', tx:43, tz:178},
    {type:'magma_crab', tx:40, tz:62},
    {type:'magma_crab', tx:64, tz:40},
    {type:'magma_crab', tx:212, tz:151},
    {type:'magma_crab', tx:145, tz:24},
    {type:'magma_crab', tx:21, tz:145},
    {type:'magma_crab', tx:156, tz:27},
    {type:'magma_crab', tx:102, tz:22},
    {type:'magma_crab', tx:23, tz:151},
    {type:'ash_wraith', tx:218, tz:140},
    {type:'ash_wraith', tx:204, tz:63},
    {type:'ash_wraith', tx:97, tz:221},
    {type:'ash_wraith', tx:57, tz:200},
    {type:'ash_wraith', tx:218, tz:82},
    {type:'ash_wraith', tx:222, tz:108},
    {type:'ash_wraith', tx:202, tz:185},
    {type:'ash_wraith', tx:19, tz:86},
    {type:'ash_wraith', tx:210, tz:174},
    {type:'ash_wraith', tx:212, tz:64},
    {type:'ash_wraith', tx:86, tz:18},
    {type:'ash_wraith', tx:192, tz:40},
    {type:'ash_wraith', tx:27, tz:61},
    {type:'ash_wraith', tx:158, tz:223},
    {type:'ash_wraith', tx:40, tz:192},
    {type:'ash_wraith', tx:181, tz:211},
    {type:'ash_wraith', tx:200, tz:196},
    {type:'ash_wraith', tx:66, tz:215},
    {type:'ash_wraith', tx:178, tz:27},
    {type:'ash_wraith', tx:66, tz:24},
    {type:'ash_wraith', tx:46, tz:35},
    {type:'ash_wraith', tx:19, tz:172},
    {type:'ash_wraith', tx:29, tz:48},
    {type:'ash_wraith', tx:50, tz:210},
    {type:'ash_wraith', tx:41, tz:28},
    {type:'ash_wraith', tx:204, tz:210},
    {type:'ash_wraith', tx:219, tz:44},
    {type:'ash_wraith', tx:218, tz:198},
    {type:'ash_wraith', tx:198, tz:21},
    {type:'ash_wraith', tx:19, tz:203},
    {type:'ash_wraith', tx:28, tz:219},
    {type:'ash_wraith', tx:24, tz:27},
    {type:'ash_wraith', tx:221, tz:209},
    {type:'ash_wraith', tx:217, tz:19}
  ],
  // a519 — SERVER-AUTHORITATIVE again (multiplayer migration): the server owns
  //   simulation/positions/HP for Sunken Sands. Transcribed from the client
  //   ZONE_DEFS.sunken_sands.enemySpawns (150 mobs). The client sv_zone_snapshot
  //   fallback self-disables once this snapshot arrives non-empty.
  sunken_sands: [
    {tx:153,tz:80,type:'sand_worm'}, {tx:109,tz:82,type:'sand_worm'}, {tx:119,tz:86,type:'sand_worm'}, {tx:139,tz:88,type:'sand_worm'},
    {tx:83,tz:96,type:'sand_worm'}, {tx:157,tz:106,type:'sand_worm'}, {tx:171,tz:114,type:'sand_worm'}, {tx:65,tz:117,type:'sand_worm'},
    {tx:154,tz:121,type:'sand_worm'}, {tx:85,tz:125,type:'sand_worm'}, {tx:88,tz:136,type:'sand_worm'}, {tx:156,tz:140,type:'sand_worm'},
    {tx:143,tz:141,type:'sand_worm'}, {tx:100,tz:145,type:'sand_worm'}, {tx:142,tz:157,type:'sand_worm'}, {tx:84,tz:158,type:'sand_worm'},
    {tx:120,tz:159,type:'sand_worm'}, {tx:103,tz:167,type:'sand_worm'}, {tx:100,tz:46,type:'sand_mummy'}, {tx:137,tz:48,type:'sand_mummy'},
    {tx:80,tz:49,type:'sand_mummy'}, {tx:142,tz:60,type:'sand_mummy'}, {tx:101,tz:61,type:'sand_mummy'}, {tx:165,tz:62,type:'sand_mummy'},
    {tx:76,tz:63,type:'sand_mummy'}, {tx:64,tz:77,type:'sand_mummy'}, {tx:177,tz:79,type:'sand_mummy'}, {tx:80,tz:82,type:'sand_mummy'},
    {tx:48,tz:97,type:'sand_mummy'}, {tx:64,tz:100,type:'sand_mummy'}, {tx:178,tz:101,type:'sand_mummy'}, {tx:196,tz:116,type:'sand_mummy'},
    {tx:60,tz:137,type:'sand_mummy'}, {tx:181,tz:138,type:'sand_mummy'}, {tx:196,tz:141,type:'sand_mummy'}, {tx:179,tz:151,type:'sand_mummy'},
    {tx:60,tz:163,type:'sand_mummy'}, {tx:165,tz:166,type:'sand_mummy'}, {tx:137,tz:172,type:'sand_mummy'}, {tx:155,tz:174,type:'sand_mummy'},
    {tx:87,tz:175,type:'sand_mummy'}, {tx:102,tz:177,type:'sand_mummy'}, {tx:61,tz:178,type:'sand_mummy'}, {tx:122,tz:182,type:'sand_mummy'},
    {tx:141,tz:196,type:'sand_mummy'}, {tx:106,tz:201,type:'sand_mummy'}, {tx:116,tz:24,type:'dune_skeleton'}, {tx:105,tz:26,type:'dune_skeleton'},
    {tx:121,tz:37,type:'dune_skeleton'}, {tx:179,tz:40,type:'dune_skeleton'}, {tx:159,tz:46,type:'dune_skeleton'}, {tx:184,tz:59,type:'dune_skeleton'},
    {tx:64,tz:63,type:'dune_skeleton'}, {tx:196,tz:80,type:'dune_skeleton'}, {tx:44,tz:87,type:'dune_skeleton'}, {tx:198,tz:97,type:'dune_skeleton'},
    {tx:31,tz:99,type:'dune_skeleton'}, {tx:37,tz:115,type:'dune_skeleton'}, {tx:218,tz:115,type:'dune_skeleton'}, {tx:29,tz:119,type:'dune_skeleton'},
    {tx:208,tz:134,type:'dune_skeleton'}, {tx:24,tz:138,type:'dune_skeleton'}, {tx:41,tz:143,type:'dune_skeleton'}, {tx:212,tz:154,type:'dune_skeleton'},
    {tx:39,tz:156,type:'dune_skeleton'}, {tx:199,tz:164,type:'dune_skeleton'}, {tx:181,tz:177,type:'dune_skeleton'}, {tx:67,tz:190,type:'dune_skeleton'},
    {tx:85,tz:196,type:'dune_skeleton'}, {tx:155,tz:198,type:'dune_skeleton'}, {tx:114,tz:201,type:'dune_skeleton'}, {tx:101,tz:212,type:'dune_skeleton'},
    {tx:134,tz:18,type:'desert_snake'}, {tx:43,tz:21,type:'desert_snake'}, {tx:60,tz:23,type:'desert_snake'}, {tx:181,tz:24,type:'desert_snake'},
    {tx:165,tz:25,type:'desert_snake'}, {tx:82,tz:29,type:'desert_snake'}, {tx:59,tz:41,type:'desert_snake'}, {tx:195,tz:43,type:'desert_snake'},
    {tx:42,tz:45,type:'desert_snake'}, {tx:216,tz:50,type:'desert_snake'}, {tx:41,tz:57,type:'desert_snake'}, {tx:224,tz:57,type:'desert_snake'},
    {tx:200,tz:63,type:'desert_snake'}, {tx:26,tz:67,type:'desert_snake'}, {tx:221,tz:76,type:'desert_snake'}, {tx:29,tz:78,type:'desert_snake'},
    {tx:217,tz:94,type:'desert_snake'}, {tx:28,tz:164,type:'desert_snake'}, {tx:19,tz:178,type:'desert_snake'}, {tx:219,tz:184,type:'desert_snake'},
    {tx:201,tz:185,type:'desert_snake'}, {tx:39,tz:187,type:'desert_snake'}, {tx:23,tz:197,type:'desert_snake'}, {tx:201,tz:197,type:'desert_snake'},
    {tx:48,tz:199,type:'desert_snake'}, {tx:210,tz:199,type:'desert_snake'}, {tx:180,tz:201,type:'desert_snake'}, {tx:181,tz:212,type:'desert_snake'},
    {tx:84,tz:215,type:'desert_snake'}, {tx:156,tz:215,type:'desert_snake'}, {tx:194,tz:217,type:'desert_snake'}, {tx:44,tz:218,type:'desert_snake'},
    {tx:69,tz:221,type:'desert_snake'}, {tx:139,tz:221,type:'desert_snake'}, {tx:210,tz:21,type:'sand_scorpion'}, {tx:203,tz:22,type:'sand_scorpion'},
    {tx:21,tz:27,type:'sand_scorpion'}, {tx:23,tz:40,type:'sand_scorpion'}, {tx:133,tz:49,type:'sand_scorpion'}, {tx:102,tz:59,type:'sand_scorpion'},
    {tx:142,tz:59,type:'sand_scorpion'}, {tx:166,tz:60,type:'sand_scorpion'}, {tx:78,tz:63,type:'sand_scorpion'}, {tx:63,tz:76,type:'sand_scorpion'},
    {tx:177,tz:77,type:'sand_scorpion'}, {tx:106,tz:81,type:'sand_scorpion'}, {tx:78,tz:82,type:'sand_scorpion'}, {tx:153,tz:82,type:'sand_scorpion'},
    {tx:119,tz:85,type:'sand_scorpion'}, {tx:140,tz:88,type:'sand_scorpion'}, {tx:86,tz:98,type:'sand_scorpion'}, {tx:64,tz:103,type:'sand_scorpion'},
    {tx:178,tz:103,type:'sand_scorpion'}, {tx:158,tz:105,type:'sand_scorpion'}, {tx:175,tz:115,type:'sand_scorpion'}, {tx:70,tz:118,type:'sand_scorpion'},
    {tx:155,tz:124,type:'sand_scorpion'}, {tx:88,tz:127,type:'sand_scorpion'}, {tx:61,tz:138,type:'sand_scorpion'}, {tx:87,tz:139,type:'sand_scorpion'},
    {tx:183,tz:139,type:'sand_scorpion'}, {tx:153,tz:140,type:'sand_scorpion'}, {tx:146,tz:142,type:'sand_scorpion'}, {tx:98,tz:143,type:'sand_scorpion'},
    {tx:177,tz:153,type:'sand_scorpion'}, {tx:121,tz:158,type:'sand_scorpion'}, {tx:139,tz:158,type:'sand_scorpion'}, {tx:84,tz:160,type:'sand_scorpion'},
    {tx:106,tz:164,type:'sand_scorpion'}, {tx:165,tz:165,type:'sand_scorpion'}, {tx:134,tz:170,type:'sand_scorpion'}, {tx:101,tz:173,type:'sand_scorpion'},
    {tx:88,tz:174,type:'sand_scorpion'}, {tx:155,tz:177,type:'sand_scorpion'}, {tx:123,tz:181,type:'sand_scorpion'}, {tx:139,tz:195,type:'sand_scorpion'},
    {tx:21,tz:212,type:'sand_scorpion'}, {tx:214,tz:219,type:'sand_scorpion'}
  ],
  // a542 — MULTIPLAYER MIGRATION: Frostveil Tundra is now server-authoritative.
  frostveil: [
    {type:'ice_golem', tx:200, tz:133},
    {type:'ice_golem', tx:201, tz:133},
    {type:'ice_golem', tx:199, tz:132},
    {type:'ice_golem', tx:200, tz:132},
    {type:'ice_golem', tx:43, tz:153},
    {type:'ice_golem', tx:42, tz:154},
    {type:'ice_golem', tx:41, tz:155},
    {type:'ice_golem', tx:41, tz:153},
    {type:'ice_golem', tx:201, tz:90},
    {type:'ice_golem', tx:200, tz:87},
    {type:'ice_golem', tx:198, tz:89},
    {type:'ice_golem', tx:200, tz:88},
    {type:'ice_golem', tx:136, tz:203},
    {type:'ice_golem', tx:136, tz:202},
    {type:'ice_golem', tx:140, tz:204},
    {type:'ice_golem', tx:138, tz:206},
    {type:'ice_golem', tx:103, tz:36},
    {type:'ice_golem', tx:107, tz:34},
    {type:'ice_golem', tx:105, tz:35},
    {type:'ice_golem', tx:107, tz:35},
    {type:'ice_golem', tx:88, tz:201},
    {type:'ice_golem', tx:89, tz:206},
    {type:'ice_golem', tx:91, tz:200},
    {type:'ice_golem', tx:89, tz:205},
    {type:'frost_wraith', tx:146, tz:204},
    {type:'frost_wraith', tx:147, tz:204},
    {type:'frost_wraith', tx:149, tz:202},
    {type:'frost_wraith', tx:147, tz:203},
    {type:'frost_wraith', tx:81, tz:38},
    {type:'frost_wraith', tx:81, tz:34},
    {type:'frost_wraith', tx:81, tz:35},
    {type:'frost_wraith', tx:80, tz:39},
    {type:'frost_wraith', tx:214, tz:130},
    {type:'frost_wraith', tx:214, tz:126},
    {type:'frost_wraith', tx:215, tz:131},
    {type:'frost_wraith', tx:64, tz:43},
    {type:'frost_wraith', tx:68, tz:42},
    {type:'frost_wraith', tx:66, tz:41},
    {type:'frost_wraith', tx:72, tz:202},
    {type:'frost_wraith', tx:69, tz:203},
    {type:'frost_wraith', tx:68, tz:201},
    {type:'frost_wraith', tx:139, tz:18},
    {type:'frost_wraith', tx:140, tz:21},
    {type:'frost_wraith', tx:138, tz:21},
    {type:'frost_wraith', tx:25, tz:79},
    {type:'frost_wraith', tx:24, tz:80},
    {type:'frost_wraith', tx:27, tz:78},
    {type:'frost_wraith', tx:144, tz:218},
    {type:'frost_wraith', tx:148, tz:216},
    {type:'frost_wraith', tx:147, tz:217},
    {type:'frost_wraith', tx:19, tz:154},
    {type:'frost_wraith', tx:22, tz:155},
    {type:'frost_wraith', tx:21, tz:153},
    {type:'frost_wraith', tx:221, tz:148},
    {type:'frost_wraith', tx:219, tz:153},
    {type:'frost_wraith', tx:221, tz:150},
    {type:'frost_wraith', tx:137, tz:224},
    {type:'frost_wraith', tx:136, tz:227},
    {type:'frost_wraith', tx:134, tz:223},
    {type:'frost_wraith', tx:82, tz:218},
    {type:'frost_wraith', tx:85, tz:220},
    {type:'frost_wraith', tx:82, tz:219},
    {type:'frost_wraith', tx:172, tz:213},
    {type:'frost_wraith', tx:171, tz:213},
    {type:'frost_wraith', tx:175, tz:214},
    {type:'frost_wraith', tx:224, tz:95},
    {type:'polar_bear', tx:226, tz:95},
    {type:'polar_bear', tx:225, tz:94},
    {type:'polar_bear', tx:40, tz:194},
    {type:'polar_bear', tx:38, tz:193},
    {type:'polar_bear', tx:40, tz:192},
    {type:'polar_bear', tx:83, tz:17},
    {type:'polar_bear', tx:83, tz:14},
    {type:'polar_bear', tx:82, tz:18},
    {type:'polar_bear', tx:159, tz:15},
    {type:'polar_bear', tx:158, tz:15},
    {type:'polar_bear', tx:161, tz:15},
    {type:'polar_bear', tx:199, tz:38},
    {type:'polar_bear', tx:197, tz:36},
    {type:'polar_bear', tx:198, tz:40},
    {type:'polar_bear', tx:44, tz:38},
    {type:'polar_bear', tx:45, tz:39},
    {type:'polar_bear', tx:49, tz:38},
    {type:'polar_bear', tx:58, tz:20},
    {type:'polar_bear', tx:61, tz:23},
    {type:'polar_bear', tx:59, tz:24},
    {type:'polar_bear', tx:20, tz:62},
    {type:'polar_bear', tx:18, tz:63},
    {type:'polar_bear', tx:21, tz:66},
    {type:'polar_bear', tx:189, tz:26},
    {type:'polar_bear', tx:190, tz:29},
    {type:'polar_bear', tx:189, tz:27},
    {type:'polar_bear', tx:215, tz:191},
    {type:'polar_bear', tx:214, tz:191},
    {type:'polar_bear', tx:215, tz:192},
    {type:'polar_bear', tx:222, tz:181},
    {type:'polar_bear', tx:220, tz:181},
    {type:'polar_bear', tx:222, tz:178},
    {type:'frost_specter', tx:60, tz:223},
    {type:'frost_specter', tx:61, tz:223},
    {type:'frost_specter', tx:61, tz:222},
    {type:'frost_specter', tx:226, tz:64},
    {type:'frost_specter', tx:226, tz:66},
    {type:'frost_specter', tx:224, tz:65},
    {type:'frost_specter', tx:179, tz:15},
    {type:'frost_specter', tx:176, tz:17},
    {type:'frost_specter', tx:176, tz:16},
    {type:'frost_specter', tx:49, tz:214},
    {type:'frost_specter', tx:48, tz:218},
    {type:'frost_specter', tx:50, tz:215},
    {type:'frost_specter', tx:13, tz:174},
    {type:'frost_specter', tx:16, tz:176},
    {type:'frost_specter', tx:12, tz:177},
    {type:'frost_specter', tx:49, tz:25},
    {type:'frost_specter', tx:50, tz:24},
    {type:'frost_specter', tx:45, tz:22},
    {type:'frost_specter', tx:18, tz:194},
    {type:'frost_specter', tx:19, tz:193},
    {type:'frost_specter', tx:18, tz:192},
    {type:'frost_specter', tx:222, tz:39},
    {type:'frost_specter', tx:219, tz:39},
    {type:'frost_specter', tx:219, tz:40},
    {type:'frost_specter', tx:195, tz:227},
    {type:'frost_specter', tx:193, tz:231},
    {type:'frost_specter', tx:193, tz:229},
    {type:'frost_specter', tx:15, tz:38},
    {type:'frost_specter', tx:18, tz:36},
    {type:'frost_specter', tx:17, tz:37},
    {type:'frost_specter', tx:27, tz:217},
    {type:'frost_specter', tx:28, tz:217},
    {type:'frost_specter', tx:26, tz:217},
    {type:'frost_specter', tx:215, tz:215},
    {type:'frost_specter', tx:219, tz:213},
    {type:'frost_specter', tx:221, tz:213},
    {type:'frost_specter', tx:219, tz:18},
    {type:'frost_specter', tx:221, tz:21},
    {type:'frost_specter', tx:217, tz:24},
    {type:'frost_specter', tx:15, tz:17},
    {type:'frost_specter', tx:15, tz:19},
    {type:'frost_specter', tx:15, tz:16}
  ],
  // a543 — MULTIPLAYER MIGRATION: Ancient Realm is now server-authoritative.
  ancient: [
    {type:'ancient_guardian', tx:33, tz:67},
    {type:'ancient_guardian', tx:31, tz:81},
    {type:'stone_sentinel', tx:42, tz:64},
    {type:'stone_sentinel', tx:45, tz:63},
    {type:'vine_horror', tx:40, tz:77},
    {type:'vine_horror', tx:36, tz:65},
    {type:'ancient_guardian', tx:31, tz:71},
    {type:'ancient_guardian', tx:32, tz:64},
    {type:'void_stalker', tx:35, tz:79},
    {type:'void_stalker', tx:41, tz:75},
    {type:'ancient_guardian', tx:69, tz:36},
    {type:'ancient_guardian', tx:81, tz:32},
    {type:'stone_sentinel', tx:80, tz:47},
    {type:'stone_sentinel', tx:69, tz:46},
    {type:'vine_horror', tx:71, tz:38},
    {type:'vine_horror', tx:79, tz:48},
    {type:'ancient_guardian', tx:69, tz:42},
    {type:'ancient_guardian', tx:81, tz:39},
    {type:'void_stalker', tx:70, tz:40},
    {type:'void_stalker', tx:74, tz:42},
    {type:'ancient_guardian', tx:63, tz:74},
    {type:'ancient_guardian', tx:81, tz:73},
    {type:'stone_sentinel', tx:78, tz:63},
    {type:'stone_sentinel', tx:67, tz:72},
    {type:'vine_horror', tx:73, tz:66},
    {type:'vine_horror', tx:77, tz:70},
    {type:'ancient_guardian', tx:63, tz:71},
    {type:'ancient_guardian', tx:77, tz:78},
    {type:'void_stalker', tx:67, tz:71},
    {type:'void_stalker', tx:79, tz:78},
    {type:'ancient_guardian', tx:192, tz:64},
    {type:'ancient_guardian', tx:203, tz:67},
    {type:'stone_sentinel', tx:191, tz:66},
    {type:'stone_sentinel', tx:209, tz:75},
    {type:'vine_horror', tx:204, tz:80},
    {type:'vine_horror', tx:191, tz:64},
    {type:'ancient_guardian', tx:206, tz:74},
    {type:'ancient_guardian', tx:197, tz:71},
    {type:'void_stalker', tx:193, tz:69},
    {type:'void_stalker', tx:193, tz:80},
    {type:'ancient_guardian', tx:165, tz:48},
    {type:'ancient_guardian', tx:165, tz:34},
    {type:'stone_sentinel', tx:168, tz:42},
    {type:'stone_sentinel', tx:167, tz:40},
    {type:'vine_horror', tx:161, tz:48},
    {type:'vine_horror', tx:173, tz:45},
    {type:'ancient_guardian', tx:176, tz:38},
    {type:'ancient_guardian', tx:169, tz:47},
    {type:'void_stalker', tx:159, tz:35},
    {type:'void_stalker', tx:177, tz:45},
    {type:'ancient_guardian', tx:165, tz:63},
    {type:'ancient_guardian', tx:162, tz:63},
    {type:'stone_sentinel', tx:160, tz:78},
    {type:'stone_sentinel', tx:177, tz:68},
    {type:'vine_horror', tx:163, tz:76},
    {type:'vine_horror', tx:159, tz:68},
    {type:'ancient_guardian', tx:173, tz:75},
    {type:'ancient_guardian', tx:167, tz:78},
    {type:'void_stalker', tx:168, tz:72},
    {type:'void_stalker', tx:177, tz:67},
    {type:'ancient_guardian', tx:41, tz:162},
    {type:'ancient_guardian', tx:39, tz:170},
    {type:'stone_sentinel', tx:45, tz:164},
    {type:'stone_sentinel', tx:35, tz:173},
    {type:'vine_horror', tx:47, tz:175},
    {type:'vine_horror', tx:36, tz:164},
    {type:'ancient_guardian', tx:31, tz:173},
    {type:'ancient_guardian', tx:33, tz:160},
    {type:'void_stalker', tx:42, tz:160},
    {type:'void_stalker', tx:47, tz:162},
    {type:'ancient_guardian', tx:74, tz:205},
    {type:'ancient_guardian', tx:80, tz:200},
    {type:'stone_sentinel', tx:74, tz:206},
    {type:'stone_sentinel', tx:70, tz:200},
    {type:'vine_horror', tx:79, tz:193},
    {type:'vine_horror', tx:69, tz:191},
    {type:'ancient_guardian', tx:64, tz:208},
    {type:'ancient_guardian', tx:71, tz:200},
    {type:'void_stalker', tx:75, tz:192},
    {type:'void_stalker', tx:66, tz:206},
    {type:'ancient_guardian', tx:75, tz:171},
    {type:'ancient_guardian', tx:70, tz:162},
    {type:'stone_sentinel', tx:74, tz:163},
    {type:'stone_sentinel', tx:76, tz:172},
    {type:'vine_horror', tx:76, tz:176},
    {type:'vine_horror', tx:68, tz:169},
    {type:'ancient_guardian', tx:78, tz:166},
    {type:'ancient_guardian', tx:78, tz:168},
    {type:'void_stalker', tx:68, tz:166},
    {type:'void_stalker', tx:81, tz:160},
    {type:'ancient_guardian', tx:201, tz:175},
    {type:'ancient_guardian', tx:197, tz:176},
    {type:'stone_sentinel', tx:206, tz:167},
    {type:'stone_sentinel', tx:205, tz:161},
    {type:'vine_horror', tx:203, tz:160},
    {type:'vine_horror', tx:205, tz:176},
    {type:'ancient_guardian', tx:191, tz:160},
    {type:'ancient_guardian', tx:196, tz:177},
    {type:'void_stalker', tx:194, tz:175},
    {type:'void_stalker', tx:201, tz:167},
    {type:'ancient_guardian', tx:166, tz:201},
    {type:'ancient_guardian', tx:176, tz:198},
    {type:'stone_sentinel', tx:167, tz:201},
    {type:'stone_sentinel', tx:168, tz:191},
    {type:'vine_horror', tx:174, tz:196},
    {type:'vine_horror', tx:165, tz:202},
    {type:'ancient_guardian', tx:169, tz:193},
    {type:'ancient_guardian', tx:168, tz:207},
    {type:'void_stalker', tx:171, tz:209},
    {type:'void_stalker', tx:173, tz:206},
    {type:'ancient_guardian', tx:176, tz:159},
    {type:'ancient_guardian', tx:163, tz:177},
    {type:'stone_sentinel', tx:165, tz:164},
    {type:'stone_sentinel', tx:163, tz:168},
    {type:'vine_horror', tx:172, tz:163},
    {type:'vine_horror', tx:164, tz:172},
    {type:'ancient_guardian', tx:172, tz:161},
    {type:'ancient_guardian', tx:164, tz:169},
    {type:'void_stalker', tx:169, tz:160},
    {type:'void_stalker', tx:171, tz:175},
    {type:'ancient_guardian', tx:87, tz:97},
    {type:'ancient_guardian', tx:94, tz:103},
    {type:'stone_sentinel', tx:102, tz:91},
    {type:'stone_sentinel', tx:87, tz:89},
    {type:'vine_horror', tx:101, tz:101},
    {type:'vine_horror', tx:97, tz:100},
    {type:'ancient_guardian', tx:94, tz:90},
    {type:'ancient_guardian', tx:104, tz:92},
    {type:'void_stalker', tx:95, tz:88},
    {type:'void_stalker', tx:91, tz:104},
    {type:'ancient_guardian', tx:140, tz:101},
    {type:'ancient_guardian', tx:135, tz:98},
    {type:'stone_sentinel', tx:143, tz:92},
    {type:'stone_sentinel', tx:137, tz:96},
    {type:'vine_horror', tx:142, tz:104},
    {type:'vine_horror', tx:137, tz:89},
    {type:'ancient_guardian', tx:146, tz:91},
    {type:'ancient_guardian', tx:144, tz:94},
    {type:'void_stalker', tx:148, tz:105},
    {type:'void_stalker', tx:148, tz:92},
    {type:'ancient_guardian', tx:90, tz:137},
    {type:'ancient_guardian', tx:98, tz:143},
    {type:'stone_sentinel', tx:98, tz:145},
    {type:'stone_sentinel', tx:94, tz:142},
    {type:'vine_horror', tx:97, tz:140},
    {type:'vine_horror', tx:100, tz:137},
    {type:'ancient_guardian', tx:97, tz:145},
    {type:'ancient_guardian', tx:88, tz:142},
    {type:'void_stalker', tx:90, tz:153},
    {type:'void_stalker', tx:92, tz:144},
    {type:'stone_sentinel', tx:147, tz:150},
    {type:'stone_sentinel', tx:151, tz:148},
    {type:'vine_horror', tx:147, tz:138},
    {type:'vine_horror', tx:142, tz:143},
    {type:'void_stalker', tx:141, tz:152},
    {type:'void_stalker', tx:143, tz:141},
    {type:'stone_sentinel', tx:157, tz:115},
    {type:'void_stalker', tx:103, tz:223},
    {type:'vine_horror', tx:114, tz:178},
    {type:'stone_sentinel', tx:28, tz:163},
    {type:'void_stalker', tx:40, tz:205},
    {type:'vine_horror', tx:144, tz:159},
    {type:'stone_sentinel', tx:176, tz:80},
    {type:'void_stalker', tx:55, tz:117},
    {type:'vine_horror', tx:132, tz:155},
    {type:'void_stalker', tx:132, tz:144},
    {type:'vine_horror', tx:98, tz:20},
    {type:'stone_sentinel', tx:155, tz:24},
    {type:'vine_horror', tx:37, tz:156},
    {type:'stone_sentinel', tx:161, tz:36},
    {type:'vine_horror', tx:201, tz:53},
    {type:'stone_sentinel', tx:113, tz:56},
    {type:'vine_horror', tx:96, tz:101},
    {type:'stone_sentinel', tx:35, tz:67},
    {type:'vine_horror', tx:26, tz:72},
    {type:'stone_sentinel', tx:84, tz:175},
    {type:'vine_horror', tx:20, tz:35},
    {type:'stone_sentinel', tx:80, tz:144},
    {type:'vine_horror', tx:218, tz:115},
    {type:'stone_sentinel', tx:87, tz:67},
    {type:'vine_horror', tx:65, tz:42},
    {type:'stone_sentinel', tx:178, tz:38},
    {type:'vine_horror', tx:43, tz:171},
    {type:'stone_sentinel', tx:208, tz:43},
    {type:'vine_horror', tx:68, tz:80},
    {type:'stone_sentinel', tx:36, tz:188},
    {type:'vine_horror', tx:204, tz:81},
    {type:'stone_sentinel', tx:24, tz:223},
    {type:'vine_horror', tx:55, tz:218},
    {type:'stone_sentinel', tx:215, tz:193},
    {type:'vine_horror', tx:133, tz:80},
    {type:'stone_sentinel', tx:101, tz:158},
    {type:'vine_horror', tx:114, tz:37},
    {type:'stone_sentinel', tx:207, tz:112},
    {type:'vine_horror', tx:54, tz:65},
    {type:'stone_sentinel', tx:22, tz:116},
    {type:'stone_sentinel', tx:189, tz:222},
    {type:'stone_sentinel', tx:73, tz:205},
    {type:'stone_sentinel', tx:208, tz:130},
    {type:'stone_sentinel', tx:67, tz:103}
  ],
  // a546 — MULTIPLAYER MIGRATION: Vaeltharax's Lair is now server-authoritative.
  dragonlair: [
    {type:'ancient_guardian', tx:12, tz:8},
    {type:'citadel_mage', tx:16, tz:6},
    {type:'ancient_guardian', tx:8, tz:20},
    {type:'iron_guard', tx:20, tz:8},
    {type:'fire_demon', tx:30, tz:15},
    {type:'fire_demon', tx:45, tz:20},
    {type:'fire_demon', tx:35, tz:40},
    {type:'fire_demon', tx:55, tz:30},
    {type:'fire_demon', tx:25, tz:55},
    {type:'fire_demon', tx:50, tz:55},
    {type:'wyvern', tx:38, tz:12},
    {type:'wyvern', tx:55, tz:18},
    {type:'wyvern', tx:22, tz:35},
    {type:'wyvern', tx:60, tz:45},
    {type:'wyvern', tx:40, tz:65},
    {type:'void_spider', tx:8, tz:35},
    {type:'void_spider', tx:15, tz:50},
    {type:'void_spider', tx:65, tz:25},
    {type:'void_spider', tx:70, tz:50},
    {type:'void_spider', tx:30, tz:68},
    {type:'void_spider', tx:55, tz:68},
    {type:'inferno_golem', tx:45, tz:40},
    {type:'inferno_golem', tx:60, tz:60},
    {type:'inferno_golem', tx:30, tz:50}
  ],
  // a547 — MULTIPLAYER MIGRATION: Rift Vale is now server-authoritative.
  riftvale: [
    {type:'rift_stalker', tx:41, tz:47},
    {type:'rift_stalker', tx:44, tz:40},
    {type:'rift_weaver', tx:49, tz:49},
    {type:'rift_weaver', tx:32, tz:45},
    {type:'psyche_horror', tx:35, tz:44},
    {type:'psyche_horror', tx:43, tz:46},
    {type:'rift_stalker', tx:44, tz:32},
    {type:'rift_stalker', tx:42, tz:41},
    {type:'void_colossus', tx:42, tz:42},
    {type:'void_colossus', tx:39, tz:42},
    {type:'rift_stalker', tx:75, tz:49},
    {type:'rift_stalker', tx:78, tz:35},
    {type:'rift_weaver', tx:68, tz:44},
    {type:'rift_weaver', tx:73, tz:49},
    {type:'psyche_horror', tx:72, tz:48},
    {type:'psyche_horror', tx:67, tz:41},
    {type:'rift_stalker', tx:76, tz:44},
    {type:'rift_stalker', tx:71, tz:44},
    {type:'void_colossus', tx:76, tz:47},
    {type:'void_colossus', tx:69, tz:41},
    {type:'rift_stalker', tx:42, tz:63},
    {type:'rift_stalker', tx:48, tz:65},
    {type:'rift_weaver', tx:49, tz:80},
    {type:'rift_weaver', tx:41, tz:79},
    {type:'psyche_horror', tx:39, tz:65},
    {type:'psyche_horror', tx:47, tz:72},
    {type:'rift_stalker', tx:36, tz:65},
    {type:'rift_stalker', tx:47, tz:80},
    {type:'void_colossus', tx:31, tz:70},
    {type:'void_colossus', tx:33, tz:66},
    {type:'rift_stalker', tx:209, tz:43},
    {type:'rift_stalker', tx:195, tz:49},
    {type:'rift_weaver', tx:197, tz:46},
    {type:'rift_weaver', tx:197, tz:41},
    {type:'psyche_horror', tx:204, tz:37},
    {type:'psyche_horror', tx:192, tz:45},
    {type:'rift_stalker', tx:193, tz:34},
    {type:'rift_stalker', tx:194, tz:44},
    {type:'void_colossus', tx:195, tz:43},
    {type:'void_colossus', tx:199, tz:45},
    {type:'rift_stalker', tx:167, tz:36},
    {type:'rift_stalker', tx:164, tz:38},
    {type:'rift_weaver', tx:177, tz:49},
    {type:'rift_weaver', tx:164, tz:36},
    {type:'psyche_horror', tx:173, tz:43},
    {type:'psyche_horror', tx:161, tz:38},
    {type:'rift_stalker', tx:172, tz:36},
    {type:'rift_stalker', tx:163, tz:39},
    {type:'void_colossus', tx:169, tz:45},
    {type:'void_colossus', tx:168, tz:36},
    {type:'rift_stalker', tx:207, tz:70},
    {type:'rift_stalker', tx:205, tz:69},
    {type:'rift_weaver', tx:194, tz:71},
    {type:'rift_weaver', tx:197, tz:69},
    {type:'psyche_horror', tx:191, tz:79},
    {type:'psyche_horror', tx:206, tz:70},
    {type:'rift_stalker', tx:208, tz:80},
    {type:'rift_stalker', tx:193, tz:67},
    {type:'void_colossus', tx:204, tz:73},
    {type:'void_colossus', tx:198, tz:73},
    {type:'rift_stalker', tx:44, tz:205},
    {type:'rift_stalker', tx:32, tz:202},
    {type:'rift_weaver', tx:46, tz:193},
    {type:'rift_weaver', tx:33, tz:194},
    {type:'psyche_horror', tx:33, tz:205},
    {type:'psyche_horror', tx:38, tz:203},
    {type:'rift_stalker', tx:36, tz:192},
    {type:'rift_stalker', tx:43, tz:191},
    {type:'void_colossus', tx:46, tz:208},
    {type:'void_colossus', tx:42, tz:197},
    {type:'rift_stalker', tx:64, tz:199},
    {type:'rift_stalker', tx:81, tz:192},
    {type:'rift_weaver', tx:81, tz:202},
    {type:'rift_weaver', tx:81, tz:201},
    {type:'psyche_horror', tx:74, tz:193},
    {type:'psyche_horror', tx:69, tz:192},
    {type:'rift_stalker', tx:76, tz:201},
    {type:'rift_stalker', tx:78, tz:198},
    {type:'void_colossus', tx:73, tz:201},
    {type:'void_colossus', tx:75, tz:196},
    {type:'rift_stalker', tx:38, tz:174},
    {type:'rift_stalker', tx:49, tz:177},
    {type:'rift_weaver', tx:31, tz:176},
    {type:'rift_weaver', tx:46, tz:169},
    {type:'psyche_horror', tx:42, tz:164},
    {type:'psyche_horror', tx:40, tz:166},
    {type:'rift_stalker', tx:33, tz:167},
    {type:'rift_stalker', tx:33, tz:174},
    {type:'void_colossus', tx:35, tz:172},
    {type:'void_colossus', tx:46, tz:165},
    {type:'rift_stalker', tx:207, tz:194},
    {type:'rift_stalker', tx:196, tz:194},
    {type:'rift_weaver', tx:193, tz:204},
    {type:'rift_weaver', tx:202, tz:203},
    {type:'psyche_horror', tx:196, tz:196},
    {type:'psyche_horror', tx:199, tz:209},
    {type:'rift_stalker', tx:196, tz:201},
    {type:'rift_stalker', tx:197, tz:208},
    {type:'void_colossus', tx:198, tz:200},
    {type:'void_colossus', tx:195, tz:205},
    {type:'rift_stalker', tx:174, tz:193},
    {type:'rift_stalker', tx:175, tz:205},
    {type:'rift_weaver', tx:162, tz:194},
    {type:'rift_weaver', tx:163, tz:205},
    {type:'psyche_horror', tx:176, tz:195},
    {type:'psyche_horror', tx:161, tz:191},
    {type:'rift_stalker', tx:172, tz:200},
    {type:'rift_stalker', tx:177, tz:209},
    {type:'void_colossus', tx:160, tz:201},
    {type:'void_colossus', tx:159, tz:206},
    {type:'rift_stalker', tx:198, tz:162},
    {type:'rift_stalker', tx:209, tz:164},
    {type:'rift_weaver', tx:197, tz:166},
    {type:'rift_weaver', tx:191, tz:171},
    {type:'psyche_horror', tx:204, tz:171},
    {type:'psyche_horror', tx:204, tz:164},
    {type:'rift_stalker', tx:194, tz:169},
    {type:'rift_stalker', tx:192, tz:160},
    {type:'void_colossus', tx:192, tz:161},
    {type:'void_colossus', tx:196, tz:159},
    {type:'rift_stalker', tx:128, tz:61},
    {type:'rift_stalker', tx:120, tz:53},
    {type:'rift_weaver', tx:121, tz:43},
    {type:'rift_weaver', tx:113, tz:56},
    {type:'psyche_horror', tx:112, tz:45},
    {type:'psyche_horror', tx:128, tz:59},
    {type:'rift_stalker', tx:118, tz:51},
    {type:'rift_stalker', tx:120, tz:49},
    {type:'rift_stalker', tx:123, tz:187},
    {type:'rift_stalker', tx:129, tz:195},
    {type:'rift_weaver', tx:116, tz:186},
    {type:'rift_weaver', tx:126, tz:194},
    {type:'psyche_horror', tx:113, tz:188},
    {type:'psyche_horror', tx:122, tz:189},
    {type:'rift_stalker', tx:128, tz:180},
    {type:'rift_stalker', tx:128, tz:191},
    {type:'rift_stalker', tx:57, tz:118},
    {type:'rift_stalker', tx:48, tz:116},
    {type:'rift_weaver', tx:63, tz:127},
    {type:'rift_weaver', tx:53, tz:121},
    {type:'psyche_horror', tx:53, tz:115},
    {type:'psyche_horror', tx:58, tz:114},
    {type:'rift_stalker', tx:64, tz:118},
    {type:'rift_stalker', tx:51, tz:112},
    {type:'rift_stalker', tx:193, tz:121},
    {type:'rift_stalker', tx:180, tz:124},
    {type:'rift_weaver', tx:189, tz:129},
    {type:'rift_weaver', tx:175, tz:111},
    {type:'psyche_horror', tx:188, tz:124},
    {type:'psyche_horror', tx:182, tz:124},
    {type:'rift_stalker', tx:191, tz:128},
    {type:'rift_stalker', tx:189, tz:122},
    {type:'psyche_horror', tx:121, tz:217},
    {type:'rift_weaver', tx:132, tz:23},
    {type:'psyche_horror', tx:188, tz:40},
    {type:'rift_weaver', tx:184, tz:203},
    {type:'psyche_horror', tx:90, tz:187},
    {type:'rift_weaver', tx:213, tz:151},
    {type:'psyche_horror', tx:117, tz:155},
    {type:'rift_weaver', tx:58, tz:74},
    {type:'psyche_horror', tx:153, tz:44},
    {type:'rift_weaver', tx:167, tz:37},
    {type:'psyche_horror', tx:71, tz:138},
    {type:'rift_weaver', tx:36, tz:100},
    {type:'psyche_horror', tx:86, tz:216},
    {type:'rift_weaver', tx:150, tz:26},
    {type:'psyche_horror', tx:137, tz:198},
    {type:'rift_weaver', tx:43, tz:215},
    {type:'psyche_horror', tx:104, tz:217},
    {type:'rift_weaver', tx:215, tz:73},
    {type:'psyche_horror', tx:38, tz:140},
    {type:'rift_weaver', tx:170, tz:214},
    {type:'psyche_horror', tx:164, tz:166},
    {type:'rift_weaver', tx:92, tz:20},
    {type:'psyche_horror', tx:119, tz:59},
    {type:'rift_weaver', tx:54, tz:140},
    {type:'rift_weaver', tx:75, tz:200},
    {type:'rift_weaver', tx:182, tz:89},
    {type:'rift_weaver', tx:167, tz:183},
    {type:'rift_weaver', tx:148, tz:138}
  ],
  // a548 — WYVERN WASTES is now SERVER-AUTHORITATIVE (was client-side since a488).
  //   190 spawns lifted verbatim from the client's enemySpawns in 80_zone_defs.part.
  //   HP is intentionally UNCHANGED (no ZONE_HP_MULT entry) — ENEMY_STATS already
  //   carries the E11.5 values (55k/75k/90k) and the client kit applies no bump.
  wyvernwastes: [
    {type:'wyvern_warlord', tx:43, tz:49},
    {type:'wyvern_warlord', tx:43, tz:36},
    {type:'deep_wyrm', tx:37, tz:43},
    {type:'deep_wyrm', tx:39, tz:39},
    {type:'elder_dragon', tx:32, tz:35},
    {type:'elder_dragon', tx:38, tz:41},
    {type:'wyvern_warlord', tx:42, tz:48},
    {type:'wyvern_warlord', tx:38, tz:32},
    {type:'deep_wyrm', tx:36, tz:39},
    {type:'deep_wyrm', tx:35, tz:36},
    {type:'wyvern_warlord', tx:66, tz:38},
    {type:'wyvern_warlord', tx:81, tz:46},
    {type:'deep_wyrm', tx:73, tz:38},
    {type:'deep_wyrm', tx:72, tz:43},
    {type:'elder_dragon', tx:67, tz:31},
    {type:'elder_dragon', tx:73, tz:43},
    {type:'wyvern_warlord', tx:71, tz:37},
    {type:'wyvern_warlord', tx:75, tz:45},
    {type:'deep_wyrm', tx:74, tz:39},
    {type:'deep_wyrm', tx:75, tz:46},
    {type:'wyvern_warlord', tx:37, tz:73},
    {type:'wyvern_warlord', tx:37, tz:81},
    {type:'deep_wyrm', tx:41, tz:71},
    {type:'deep_wyrm', tx:42, tz:65},
    {type:'elder_dragon', tx:32, tz:65},
    {type:'elder_dragon', tx:40, tz:79},
    {type:'wyvern_warlord', tx:37, tz:78},
    {type:'wyvern_warlord', tx:37, tz:67},
    {type:'deep_wyrm', tx:47, tz:63},
    {type:'deep_wyrm', tx:47, tz:79},
    {type:'wyvern_warlord', tx:207, tz:35},
    {type:'wyvern_warlord', tx:204, tz:39},
    {type:'deep_wyrm', tx:194, tz:33},
    {type:'deep_wyrm', tx:209, tz:43},
    {type:'elder_dragon', tx:193, tz:39},
    {type:'elder_dragon', tx:192, tz:48},
    {type:'wyvern_warlord', tx:195, tz:45},
    {type:'wyvern_warlord', tx:200, tz:39},
    {type:'deep_wyrm', tx:198, tz:39},
    {type:'deep_wyrm', tx:201, tz:32},
    {type:'wyvern_warlord', tx:166, tz:40},
    {type:'wyvern_warlord', tx:177, tz:34},
    {type:'deep_wyrm', tx:168, tz:39},
    {type:'deep_wyrm', tx:173, tz:42},
    {type:'elder_dragon', tx:171, tz:39},
    {type:'elder_dragon', tx:174, tz:48},
    {type:'wyvern_warlord', tx:171, tz:49},
    {type:'wyvern_warlord', tx:169, tz:44},
    {type:'deep_wyrm', tx:159, tz:46},
    {type:'deep_wyrm', tx:173, tz:36},
    {type:'wyvern_warlord', tx:205, tz:73},
    {type:'wyvern_warlord', tx:194, tz:76},
    {type:'deep_wyrm', tx:192, tz:66},
    {type:'deep_wyrm', tx:205, tz:78},
    {type:'elder_dragon', tx:206, tz:73},
    {type:'elder_dragon', tx:202, tz:66},
    {type:'wyvern_warlord', tx:203, tz:70},
    {type:'wyvern_warlord', tx:192, tz:70},
    {type:'deep_wyrm', tx:204, tz:70},
    {type:'deep_wyrm', tx:203, tz:68},
    {type:'wyvern_warlord', tx:34, tz:204},
    {type:'wyvern_warlord', tx:49, tz:206},
    {type:'deep_wyrm', tx:47, tz:200},
    {type:'deep_wyrm', tx:31, tz:201},
    {type:'elder_dragon', tx:42, tz:204},
    {type:'elder_dragon', tx:42, tz:199},
    {type:'wyvern_warlord', tx:43, tz:191},
    {type:'wyvern_warlord', tx:35, tz:208},
    {type:'deep_wyrm', tx:49, tz:207},
    {type:'deep_wyrm', tx:37, tz:198},
    {type:'wyvern_warlord', tx:70, tz:202},
    {type:'wyvern_warlord', tx:66, tz:203},
    {type:'deep_wyrm', tx:63, tz:200},
    {type:'deep_wyrm', tx:70, tz:207},
    {type:'elder_dragon', tx:64, tz:209},
    {type:'elder_dragon', tx:65, tz:202},
    {type:'wyvern_warlord', tx:67, tz:206},
    {type:'wyvern_warlord', tx:65, tz:192},
    {type:'deep_wyrm', tx:75, tz:194},
    {type:'deep_wyrm', tx:79, tz:193},
    {type:'wyvern_warlord', tx:38, tz:171},
    {type:'wyvern_warlord', tx:36, tz:165},
    {type:'deep_wyrm', tx:46, tz:161},
    {type:'deep_wyrm', tx:35, tz:166},
    {type:'elder_dragon', tx:41, tz:170},
    {type:'elder_dragon', tx:45, tz:176},
    {type:'wyvern_warlord', tx:31, tz:172},
    {type:'wyvern_warlord', tx:39, tz:168},
    {type:'deep_wyrm', tx:31, tz:160},
    {type:'deep_wyrm', tx:31, tz:171},
    {type:'wyvern_warlord', tx:204, tz:203},
    {type:'wyvern_warlord', tx:195, tz:205},
    {type:'deep_wyrm', tx:194, tz:197},
    {type:'deep_wyrm', tx:202, tz:203},
    {type:'elder_dragon', tx:198, tz:205},
    {type:'elder_dragon', tx:203, tz:203},
    {type:'wyvern_warlord', tx:196, tz:199},
    {type:'wyvern_warlord', tx:209, tz:204},
    {type:'deep_wyrm', tx:202, tz:202},
    {type:'deep_wyrm', tx:195, tz:207},
    {type:'wyvern_warlord', tx:177, tz:207},
    {type:'wyvern_warlord', tx:176, tz:201},
    {type:'deep_wyrm', tx:169, tz:192},
    {type:'deep_wyrm', tx:168, tz:208},
    {type:'elder_dragon', tx:177, tz:194},
    {type:'elder_dragon', tx:163, tz:194},
    {type:'wyvern_warlord', tx:177, tz:193},
    {type:'wyvern_warlord', tx:175, tz:209},
    {type:'deep_wyrm', tx:160, tz:203},
    {type:'deep_wyrm', tx:175, tz:192},
    {type:'wyvern_warlord', tx:200, tz:162},
    {type:'wyvern_warlord', tx:208, tz:161},
    {type:'deep_wyrm', tx:205, tz:166},
    {type:'deep_wyrm', tx:194, tz:172},
    {type:'elder_dragon', tx:195, tz:162},
    {type:'elder_dragon', tx:209, tz:177},
    {type:'wyvern_warlord', tx:192, tz:174},
    {type:'wyvern_warlord', tx:192, tz:177},
    {type:'deep_wyrm', tx:208, tz:164},
    {type:'deep_wyrm', tx:193, tz:159},
    {type:'wyvern_warlord', tx:123, tz:54},
    {type:'wyvern_warlord', tx:125, tz:51},
    {type:'deep_wyrm', tx:113, tz:51},
    {type:'deep_wyrm', tx:124, tz:52},
    {type:'elder_dragon', tx:120, tz:58},
    {type:'elder_dragon', tx:127, tz:45},
    {type:'wyvern_warlord', tx:120, tz:51},
    {type:'wyvern_warlord', tx:128, tz:54},
    {type:'deep_wyrm', tx:111, tz:56},
    {type:'deep_wyrm', tx:127, tz:44},
    {type:'wyvern_warlord', tx:114, tz:179},
    {type:'wyvern_warlord', tx:112, tz:188},
    {type:'deep_wyrm', tx:115, tz:186},
    {type:'deep_wyrm', tx:125, tz:186},
    {type:'elder_dragon', tx:115, tz:180},
    {type:'elder_dragon', tx:112, tz:194},
    {type:'wyvern_warlord', tx:119, tz:193},
    {type:'wyvern_warlord', tx:124, tz:192},
    {type:'deep_wyrm', tx:125, tz:191},
    {type:'deep_wyrm', tx:116, tz:187},
    {type:'wyvern_warlord', tx:59, tz:122},
    {type:'wyvern_warlord', tx:63, tz:117},
    {type:'deep_wyrm', tx:64, tz:111},
    {type:'deep_wyrm', tx:61, tz:115},
    {type:'elder_dragon', tx:61, tz:113},
    {type:'elder_dragon', tx:50, tz:127},
    {type:'wyvern_warlord', tx:64, tz:116},
    {type:'wyvern_warlord', tx:47, tz:111},
    {type:'deep_wyrm', tx:54, tz:116},
    {type:'deep_wyrm', tx:47, tz:117},
    {type:'wyvern_warlord', tx:186, tz:118},
    {type:'wyvern_warlord', tx:192, tz:116},
    {type:'deep_wyrm', tx:183, tz:128},
    {type:'deep_wyrm', tx:181, tz:129},
    {type:'elder_dragon', tx:182, tz:114},
    {type:'elder_dragon', tx:175, tz:111},
    {type:'wyvern_warlord', tx:181, tz:120},
    {type:'wyvern_warlord', tx:183, tz:119},
    {type:'deep_wyrm', tx:185, tz:127},
    {type:'deep_wyrm', tx:179, tz:115},
    {type:'wyvern_warlord', tx:53, tz:197},
    {type:'elder_dragon', tx:187, tz:86},
    {type:'wyvern_warlord', tx:150, tz:43},
    {type:'wyvern_warlord', tx:216, tz:21},
    {type:'elder_dragon', tx:70, tz:212},
    {type:'wyvern_warlord', tx:39, tz:101},
    {type:'wyvern_warlord', tx:56, tz:28},
    {type:'elder_dragon', tx:42, tz:152},
    {type:'wyvern_warlord', tx:41, tz:58},
    {type:'wyvern_warlord', tx:148, tz:59},
    {type:'elder_dragon', tx:87, tz:119},
    {type:'wyvern_warlord', tx:171, tz:200},
    {type:'elder_dragon', tx:180, tz:56},
    {type:'elder_dragon', tx:58, tz:87},
    {type:'elder_dragon', tx:120, tz:151},
    {type:'elder_dragon', tx:197, tz:135},
    {type:'elder_dragon', tx:100, tz:40},
    {type:'elder_dragon', tx:118, tz:184},
    {type:'elder_dragon', tx:148, tz:27},
    {type:'elder_dragon', tx:133, tz:53},
    {type:'elder_dragon', tx:107, tz:54},
    {type:'elder_dragon', tx:154, tz:172},
    {type:'elder_dragon', tx:86, tz:22},
    {type:'elder_dragon', tx:187, tz:138},
    {type:'elder_dragon', tx:90, tz:105},
    {type:'elder_dragon', tx:197, tz:24},
    {type:'elder_dragon', tx:169, tz:148},
    {type:'elder_dragon', tx:44, tz:72},
    {type:'elder_dragon', tx:214, tz:52},
    {type:'elder_dragon', tx:37, tz:200}
  ],
  // a551 — XUMEN is now SERVER-AUTHORITATIVE (was client-side since a489).
  //   150 spawns lifted verbatim from the client's enemySpawns in 80_zone_defs.part.
  //   HP intentionally UNCHANGED. All four types are py:0, so no altitude sync.
  xumen: [
    {type:'xu_supreme', tx:139, tz:98},
    {type:'xu_supreme', tx:139, tz:97},
    {type:'xu_supreme', tx:87, tz:115},
    {type:'xu_supreme', tx:85, tz:118},
    {type:'xu_supreme', tx:98, tz:143},
    {type:'xu_supreme', tx:97, tz:146},
    {type:'xu_supreme', tx:143, tz:146},
    {type:'xu_supreme', tx:146, tz:145},
    {type:'xu_supreme', tx:92, tz:98},
    {type:'xu_supreme', tx:94, tz:99},
    {type:'xu_supreme', tx:152, tz:138},
    {type:'xu_supreme', tx:152, tz:137},
    {type:'xu_supreme', tx:159, tz:127},
    {type:'xu_supreme', tx:160, tz:123},
    {type:'xu_supreme', tx:135, tz:159},
    {type:'xu_supreme', tx:135, tz:158},
    {type:'xu_supreme', tx:111, tz:78},
    {type:'xu_supreme', tx:113, tz:80},
    {type:'xu_supreme', tx:137, tz:82},
    {type:'xu_supreme', tx:139, tz:83},
    {type:'xu_supreme', tx:100, tz:161},
    {type:'xu_supreme', tx:99, tz:162},
    {type:'xu_supreme', tx:110, tz:164},
    {type:'xu_supreme', tx:109, tz:165},
    {type:'xu_supreme', tx:78, tz:142},
    {type:'xu_supreme', tx:77, tz:141},
    {type:'xu_supreme', tx:156, tz:90},
    {type:'xu_supreme', tx:155, tz:93},
    {type:'xu_supreme', tx:98, tz:79},
    {type:'xu_supreme', tx:98, tz:81},
    {type:'xu_titan', tx:156, tz:86},
    {type:'xu_titan', tx:155, tz:89},
    {type:'xu_titan', tx:81, tz:152},
    {type:'xu_titan', tx:80, tz:153},
    {type:'xu_titan', tx:72, tz:97},
    {type:'xu_titan', tx:75, tz:97},
    {type:'xu_titan', tx:115, tz:68},
    {type:'xu_titan', tx:114, tz:67},
    {type:'xu_titan', tx:103, tz:65},
    {type:'xu_titan', tx:101, tz:64},
    {type:'xu_titan', tx:65, tz:143},
    {type:'xu_titan', tx:64, tz:142},
    {type:'xu_titan', tx:82, tz:76},
    {type:'xu_titan', tx:84, tz:75},
    {type:'xu_titan', tx:59, tz:119},
    {type:'xu_titan', tx:59, tz:121},
    {type:'xu_titan', tx:164, tz:157},
    {type:'xu_titan', tx:163, tz:159},
    {type:'xu_titan', tx:180, tz:121},
    {type:'xu_titan', tx:180, tz:120},
    {type:'xu_titan', tx:147, tz:177},
    {type:'xu_titan', tx:146, tz:177},
    {type:'xu_titan', tx:140, tz:59},
    {type:'xu_titan', tx:137, tz:61},
    {type:'xu_titan', tx:62, tz:98},
    {type:'xu_titan', tx:60, tz:98},
    {type:'xu_titan', tx:155, tz:66},
    {type:'xu_titan', tx:157, tz:68},
    {type:'xu_titan', tx:172, tz:81},
    {type:'xu_titan', tx:174, tz:81},
    {type:'xu_titan', tx:98, tz:182},
    {type:'xu_titan', tx:96, tz:178},
    {type:'xu_titan', tx:122, tz:185},
    {type:'xu_titan', tx:123, tz:186},
    {type:'xu_titan', tx:186, tz:106},
    {type:'xu_titan', tx:184, tz:108},
    {type:'xu_titan', tx:186, tz:141},
    {type:'xu_titan', tx:184, tz:140},
    {type:'xu_titan', tx:79, tz:61},
    {type:'xu_titan', tx:77, tz:63},
    {type:'xu_titan', tx:65, tz:166},
    {type:'xu_titan', tx:65, tz:167},
    {type:'xu_annihilator', tx:158, tz:183},
    {type:'xu_annihilator', tx:158, tz:184},
    {type:'xu_annihilator', tx:83, tz:181},
    {type:'xu_annihilator', tx:82, tz:184},
    {type:'xu_annihilator', tx:48, tz:144},
    {type:'xu_annihilator', tx:50, tz:145},
    {type:'xu_annihilator', tx:45, tz:114},
    {type:'xu_annihilator', tx:137, tz:47},
    {type:'xu_annihilator', tx:185, tz:159},
    {type:'xu_annihilator', tx:55, tz:82},
    {type:'xu_annihilator', tx:195, tz:118},
    {type:'xu_annihilator', tx:142, tz:194},
    {type:'xu_annihilator', tx:119, tz:196},
    {type:'xu_annihilator', tx:47, tz:102},
    {type:'xu_annihilator', tx:107, tz:44},
    {type:'xu_annihilator', tx:199, tz:105},
    {type:'xu_annihilator', tx:176, tz:64},
    {type:'xu_annihilator', tx:92, tz:195},
    {type:'xu_annihilator', tx:121, tz:41},
    {type:'xu_annihilator', tx:193, tz:151},
    {type:'xu_annihilator', tx:191, tz:84},
    {type:'xu_annihilator', tx:83, tz:194},
    {type:'xu_annihilator', tx:202, tz:133},
    {type:'xu_annihilator', tx:179, tz:177},
    {type:'xu_annihilator', tx:59, tz:63},
    {type:'xu_annihilator', tx:54, tz:174},
    {type:'xu_annihilator', tx:80, tz:42},
    {type:'xu_annihilator', tx:41, tz:82},
    {type:'xu_annihilator', tx:172, tz:195},
    {type:'xu_annihilator', tx:159, tz:40},
    {type:'xu_annihilator', tx:35, tz:156},
    {type:'xu_annihilator', tx:193, tz:176},
    {type:'xu_annihilator', tx:99, tz:209},
    {type:'xu_annihilator', tx:175, tz:41},
    {type:'xu_annihilator', tx:29, tz:143},
    {type:'xu_annihilator', tx:163, tz:205},
    {type:'xu_annihilator', tx:23, tz:116},
    {type:'xu_annihilator', tx:155, tz:211},
    {type:'xu_annihilator', tx:69, tz:36},
    {type:'xu_annihilator', tx:199, tz:61},
    {type:'xu_annihilator', tx:219, tz:101},
    {type:'xu_annihilator', tx:79, tz:213},
    {type:'xu_annihilator', tx:33, tz:62},
    {type:'xu_annihilator', tx:39, tz:185},
    {type:'xu_annihilator', tx:52, tz:200},
    {type:'xu_annihilator', tx:214, tz:160},
    {type:'xu_enforcer', tx:223, tz:130},
    {type:'xu_enforcer', tx:219, tz:87},
    {type:'xu_enforcer', tx:142, tz:15},
    {type:'xu_enforcer', tx:143, tz:223},
    {type:'xu_enforcer', tx:104, tz:15},
    {type:'xu_enforcer', tx:197, tz:192},
    {type:'xu_enforcer', tx:160, tz:19},
    {type:'xu_enforcer', tx:46, tz:44},
    {type:'xu_enforcer', tx:75, tz:22},
    {type:'xu_enforcer', tx:27, tz:64},
    {type:'xu_enforcer', tx:203, tz:48},
    {type:'xu_enforcer', tx:17, tz:160},
    {type:'xu_enforcer', tx:42, tz:200},
    {type:'xu_enforcer', tx:174, tz:222},
    {type:'xu_enforcer', tx:176, tz:16},
    {type:'xu_enforcer', tx:47, tz:31},
    {type:'xu_enforcer', tx:224, tz:175},
    {type:'xu_enforcer', tx:53, tz:217},
    {type:'xu_enforcer', tx:21, tz:183},
    {type:'xu_enforcer', tx:60, tz:19},
    {type:'xu_enforcer', tx:225, tz:57},
    {type:'xu_enforcer', tx:218, tz:48},
    {type:'xu_enforcer', tx:195, tz:22},
    {type:'xu_enforcer', tx:212, tz:202},
    {type:'xu_enforcer', tx:25, tz:201},
    {type:'xu_enforcer', tx:39, tz:220},
    {type:'xu_enforcer', tx:205, tz:220},
    {type:'xu_enforcer', tx:18, tz:34},
    {type:'xu_enforcer', tx:25, tz:219},
    {type:'xu_enforcer', tx:18, tz:31},
    {type:'xu_enforcer', tx:212, tz:221},
    {type:'xu_enforcer', tx:224, tz:24}
  ],
  // a544 — MULTIPLAYER MIGRATION: Necropolis is now server-authoritative.
  necropolis: [
    {type:'necro_wight', tx:40, tz:32},
    {type:'necro_wight', tx:24, tz:33},
    {type:'necro_abomination', tx:24, tz:31},
    {type:'necro_abomination', tx:28, tz:41},
    {type:'necro_lich_mage', tx:25, tz:30},
    {type:'necro_lich_mage', tx:29, tz:33},
    {type:'necro_specter', tx:28, tz:23},
    {type:'necro_specter', tx:24, tz:38},
    {type:'necro_wight', tx:34, tz:29},
    {type:'necro_wight', tx:30, tz:34},
    {type:'necro_wight', tx:56, tz:48},
    {type:'necro_wight', tx:58, tz:46},
    {type:'necro_abomination', tx:72, tz:35},
    {type:'necro_abomination', tx:60, tz:32},
    {type:'necro_lich_mage', tx:66, tz:47},
    {type:'necro_lich_mage', tx:64, tz:44},
    {type:'necro_specter', tx:67, tz:35},
    {type:'necro_specter', tx:71, tz:40},
    {type:'necro_wight', tx:63, tz:32},
    {type:'necro_wight', tx:61, tz:49},
    {type:'necro_wight', tx:38, tz:73},
    {type:'necro_wight', tx:38, tz:67},
    {type:'necro_abomination', tx:46, tz:62},
    {type:'necro_abomination', tx:45, tz:67},
    {type:'necro_lich_mage', tx:48, tz:65},
    {type:'necro_lich_mage', tx:32, tz:75},
    {type:'necro_specter', tx:45, tz:64},
    {type:'necro_specter', tx:40, tz:73},
    {type:'necro_wight', tx:45, tz:63},
    {type:'necro_wight', tx:37, tz:64},
    {type:'necro_wight', tx:202, tz:24},
    {type:'necro_wight', tx:199, tz:25},
    {type:'necro_abomination', tx:203, tz:40},
    {type:'necro_abomination', tx:199, tz:38},
    {type:'necro_lich_mage', tx:213, tz:37},
    {type:'necro_lich_mage', tx:210, tz:25},
    {type:'necro_specter', tx:216, tz:24},
    {type:'necro_specter', tx:209, tz:40},
    {type:'necro_wight', tx:214, tz:27},
    {type:'necro_wight', tx:214, tz:39},
    {type:'necro_wight', tx:177, tz:62},
    {type:'necro_wight', tx:186, tz:49},
    {type:'necro_abomination', tx:189, tz:49},
    {type:'necro_abomination', tx:181, tz:53},
    {type:'necro_lich_mage', tx:177, tz:56},
    {type:'necro_lich_mage', tx:181, tz:52},
    {type:'necro_specter', tx:193, tz:64},
    {type:'necro_specter', tx:183, tz:58},
    {type:'necro_wight', tx:189, tz:47},
    {type:'necro_wight', tx:189, tz:62},
    {type:'necro_wight', tx:219, tz:78},
    {type:'necro_wight', tx:209, tz:73},
    {type:'necro_abomination', tx:202, tz:69},
    {type:'necro_abomination', tx:211, tz:72},
    {type:'necro_lich_mage', tx:215, tz:72},
    {type:'necro_lich_mage', tx:213, tz:80},
    {type:'necro_specter', tx:213, tz:69},
    {type:'necro_specter', tx:205, tz:83},
    {type:'necro_wight', tx:201, tz:83},
    {type:'necro_wight', tx:201, tz:72},
    {type:'necro_wight', tx:29, tz:209},
    {type:'necro_wight', tx:37, tz:208},
    {type:'necro_abomination', tx:25, tz:211},
    {type:'necro_abomination', tx:35, tz:203},
    {type:'necro_lich_mage', tx:40, tz:214},
    {type:'necro_lich_mage', tx:33, tz:204},
    {type:'necro_specter', tx:25, tz:207},
    {type:'necro_specter', tx:24, tz:201},
    {type:'necro_wight', tx:39, tz:208},
    {type:'necro_wight', tx:36, tz:204},
    {type:'necro_wight', tx:55, tz:185},
    {type:'necro_wight', tx:60, tz:187},
    {type:'necro_abomination', tx:59, tz:181},
    {type:'necro_abomination', tx:59, tz:176},
    {type:'necro_lich_mage', tx:61, tz:180},
    {type:'necro_lich_mage', tx:50, tz:176},
    {type:'necro_specter', tx:57, tz:178},
    {type:'necro_specter', tx:63, tz:187},
    {type:'necro_wight', tx:55, tz:177},
    {type:'necro_wight', tx:50, tz:177},
    {type:'necro_wight', tx:35, tz:210},
    {type:'necro_wight', tx:37, tz:219},
    {type:'necro_abomination', tx:44, tz:212},
    {type:'necro_abomination', tx:48, tz:205},
    {type:'necro_lich_mage', tx:40, tz:202},
    {type:'necro_lich_mage', tx:43, tz:217},
    {type:'necro_specter', tx:34, tz:209},
    {type:'necro_specter', tx:43, tz:208},
    {type:'necro_wight', tx:49, tz:208},
    {type:'necro_wight', tx:46, tz:212},
    {type:'necro_wight', tx:209, tz:205},
    {type:'necro_wight', tx:200, tz:199},
    {type:'necro_abomination', tx:215, tz:211},
    {type:'necro_abomination', tx:209, tz:216},
    {type:'necro_lich_mage', tx:206, tz:212},
    {type:'necro_lich_mage', tx:205, tz:217},
    {type:'necro_specter', tx:217, tz:201},
    {type:'necro_specter', tx:215, tz:213},
    {type:'necro_wight', tx:202, tz:206},
    {type:'necro_wight', tx:207, tz:214},
    {type:'necro_wight', tx:182, tz:189},
    {type:'necro_wight', tx:171, tz:195},
    {type:'necro_abomination', tx:167, tz:191},
    {type:'necro_abomination', tx:184, tz:193},
    {type:'necro_lich_mage', tx:174, tz:192},
    {type:'necro_lich_mage', tx:183, tz:195},
    {type:'necro_specter', tx:171, tz:181},
    {type:'necro_specter', tx:167, tz:185},
    {type:'necro_wight', tx:173, tz:195},
    {type:'necro_wight', tx:178, tz:177},
    {type:'necro_wight', tx:218, tz:176},
    {type:'necro_wight', tx:201, tz:171},
    {type:'necro_abomination', tx:207, tz:170},
    {type:'necro_abomination', tx:201, tz:173},
    {type:'necro_lich_mage', tx:208, tz:166},
    {type:'necro_lich_mage', tx:205, tz:169},
    {type:'necro_specter', tx:219, tz:177},
    {type:'necro_specter', tx:203, tz:174},
    {type:'necro_wight', tx:204, tz:178},
    {type:'necro_wight', tx:207, tz:174},
    {type:'necro_wight', tx:124, tz:41},
    {type:'necro_wight', tx:112, tz:45},
    {type:'necro_abomination', tx:122, tz:39},
    {type:'necro_abomination', tx:122, tz:43},
    {type:'necro_lich_mage', tx:127, tz:39},
    {type:'necro_lich_mage', tx:120, tz:38},
    {type:'necro_specter', tx:118, tz:42},
    {type:'necro_specter', tx:116, tz:48},
    {type:'necro_wight', tx:115, tz:51},
    {type:'necro_wight', tx:115, tz:44},
    {type:'necro_wight', tx:127, tz:200},
    {type:'necro_wight', tx:125, tz:202},
    {type:'necro_abomination', tx:120, tz:197},
    {type:'necro_abomination', tx:120, tz:195},
    {type:'necro_lich_mage', tx:117, tz:199},
    {type:'necro_lich_mage', tx:115, tz:190},
    {type:'necro_specter', tx:129, tz:195},
    {type:'necro_specter', tx:113, tz:196},
    {type:'necro_wight', tx:112, tz:203},
    {type:'necro_wight', tx:123, tz:201},
    {type:'necro_abomination', tx:79, tz:124},
    {type:'necro_abomination', tx:80, tz:124},
    {type:'necro_lich_mage', tx:77, tz:126},
    {type:'necro_lich_mage', tx:63, tz:125},
    {type:'necro_specter', tx:65, tz:121},
    {type:'necro_specter', tx:80, tz:127},
    {type:'necro_abomination', tx:164, tz:123},
    {type:'necro_abomination', tx:166, tz:119},
    {type:'necro_lich_mage', tx:159, tz:116},
    {type:'necro_lich_mage', tx:172, tz:125},
    {type:'necro_specter', tx:168, tz:128},
    {type:'necro_specter', tx:159, tz:111},
    {type:'necro_specter', tx:91, tz:180},
    {type:'necro_lich_mage', tx:72, tz:42},
    {type:'necro_abomination', tx:117, tz:88},
    {type:'necro_specter', tx:219, tz:52},
    {type:'necro_lich_mage', tx:132, tz:148},
    {type:'necro_abomination', tx:168, tz:52},
    {type:'necro_specter', tx:21, tz:169},
    {type:'necro_lich_mage', tx:105, tz:86},
    {type:'necro_abomination', tx:133, tz:89},
    {type:'necro_specter', tx:92, tz:134},
    {type:'necro_lich_mage', tx:21, tz:36},
    {type:'necro_abomination', tx:152, tz:100},
    {type:'necro_specter', tx:204, tz:87},
    {type:'necro_lich_mage', tx:43, tz:123},
    {type:'necro_abomination', tx:182, tz:42},
    {type:'necro_specter', tx:212, tz:70},
    {type:'necro_lich_mage', tx:181, tz:212},
    {type:'necro_abomination', tx:215, tz:166},
    {type:'necro_specter', tx:169, tz:136},
    {type:'necro_lich_mage', tx:73, tz:60},
    {type:'necro_abomination', tx:118, tz:40},
    {type:'necro_specter', tx:180, tz:105},
    {type:'necro_lich_mage', tx:69, tz:164},
    {type:'necro_abomination', tx:135, tz:164},
    {type:'necro_specter', tx:84, tz:54},
    {type:'necro_lich_mage', tx:180, tz:166},
    {type:'necro_abomination', tx:75, tz:186},
    {type:'necro_specter', tx:57, tz:104},
    {type:'necro_lich_mage', tx:196, tz:27},
    {type:'necro_abomination', tx:58, tz:165},
    {type:'necro_specter', tx:41, tz:59},
    {type:'necro_lich_mage', tx:167, tz:183},
    {type:'necro_abomination', tx:105, tz:201},
    {type:'necro_specter', tx:71, tz:72},
    {type:'necro_lich_mage', tx:155, tz:150},
    {type:'necro_abomination', tx:165, tz:36},
    {type:'necro_abomination', tx:108, tz:40},
    {type:'necro_abomination', tx:137, tz:70},
    {type:'necro_abomination', tx:188, tz:22},
    {type:'necro_abomination', tx:138, tz:140}
  ],
  // a552 — XUMEN FORTRESS is now SERVER-AUTHORITATIVE (was client-side since a490).
  //   200 spawns lifted verbatim from the client's enemySpawns in 80_zone_defs.part.
  //   HP intentionally UNCHANGED. All four types are py:0, so no altitude sync.
  xumen_fortress: [
    {type:'xf_titan_elite', tx:38, tz:49},
    {type:'xf_titan_elite', tx:46, tz:32},
    {type:'xf_warlord', tx:38, tz:40},
    {type:'xf_warlord', tx:42, tz:47},
    {type:'xf_siege_walker', tx:35, tz:43},
    {type:'xf_siege_walker', tx:39, tz:49},
    {type:'xf_titan_elite', tx:34, tz:33},
    {type:'xf_titan_elite', tx:46, tz:47},
    {type:'xf_fortress_drone', tx:38, tz:36},
    {type:'xf_fortress_drone', tx:37, tz:48},
    {type:'xf_titan_elite', tx:69, tz:32},
    {type:'xf_titan_elite', tx:69, tz:31},
    {type:'xf_warlord', tx:74, tz:35},
    {type:'xf_warlord', tx:64, tz:35},
    {type:'xf_siege_walker', tx:79, tz:35},
    {type:'xf_siege_walker', tx:76, tz:34},
    {type:'xf_titan_elite', tx:73, tz:37},
    {type:'xf_titan_elite', tx:79, tz:41},
    {type:'xf_fortress_drone', tx:76, tz:36},
    {type:'xf_fortress_drone', tx:75, tz:36},
    {type:'xf_titan_elite', tx:46, tz:65},
    {type:'xf_titan_elite', tx:38, tz:64},
    {type:'xf_warlord', tx:42, tz:75},
    {type:'xf_warlord', tx:36, tz:78},
    {type:'xf_siege_walker', tx:49, tz:79},
    {type:'xf_siege_walker', tx:48, tz:63},
    {type:'xf_titan_elite', tx:46, tz:78},
    {type:'xf_titan_elite', tx:42, tz:79},
    {type:'xf_fortress_drone', tx:36, tz:76},
    {type:'xf_fortress_drone', tx:32, tz:64},
    {type:'xf_titan_elite', tx:198, tz:33},
    {type:'xf_titan_elite', tx:192, tz:34},
    {type:'xf_warlord', tx:204, tz:39},
    {type:'xf_warlord', tx:200, tz:37},
    {type:'xf_siege_walker', tx:192, tz:40},
    {type:'xf_siege_walker', tx:205, tz:33},
    {type:'xf_titan_elite', tx:195, tz:35},
    {type:'xf_titan_elite', tx:200, tz:33},
    {type:'xf_fortress_drone', tx:192, tz:38},
    {type:'xf_fortress_drone', tx:191, tz:35},
    {type:'xf_titan_elite', tx:167, tz:37},
    {type:'xf_titan_elite', tx:166, tz:42},
    {type:'xf_warlord', tx:169, tz:31},
    {type:'xf_warlord', tx:162, tz:34},
    {type:'xf_siege_walker', tx:159, tz:41},
    {type:'xf_siege_walker', tx:177, tz:40},
    {type:'xf_titan_elite', tx:170, tz:33},
    {type:'xf_titan_elite', tx:159, tz:32},
    {type:'xf_fortress_drone', tx:172, tz:41},
    {type:'xf_fortress_drone', tx:171, tz:40},
    {type:'xf_titan_elite', tx:195, tz:81},
    {type:'xf_titan_elite', tx:193, tz:81},
    {type:'xf_warlord', tx:202, tz:65},
    {type:'xf_warlord', tx:198, tz:76},
    {type:'xf_siege_walker', tx:206, tz:76},
    {type:'xf_siege_walker', tx:194, tz:64},
    {type:'xf_titan_elite', tx:193, tz:70},
    {type:'xf_titan_elite', tx:207, tz:72},
    {type:'xf_fortress_drone', tx:197, tz:72},
    {type:'xf_fortress_drone', tx:194, tz:63},
    {type:'xf_titan_elite', tx:45, tz:204},
    {type:'xf_titan_elite', tx:33, tz:195},
    {type:'xf_warlord', tx:38, tz:195},
    {type:'xf_warlord', tx:35, tz:204},
    {type:'xf_siege_walker', tx:31, tz:203},
    {type:'xf_siege_walker', tx:41, tz:201},
    {type:'xf_titan_elite', tx:48, tz:201},
    {type:'xf_titan_elite', tx:45, tz:197},
    {type:'xf_fortress_drone', tx:44, tz:201},
    {type:'xf_fortress_drone', tx:31, tz:205},
    {type:'xf_titan_elite', tx:70, tz:196},
    {type:'xf_titan_elite', tx:80, tz:196},
    {type:'xf_warlord', tx:76, tz:197},
    {type:'xf_warlord', tx:75, tz:191},
    {type:'xf_siege_walker', tx:63, tz:196},
    {type:'xf_siege_walker', tx:72, tz:199},
    {type:'xf_titan_elite', tx:65, tz:207},
    {type:'xf_titan_elite', tx:65, tz:201},
    {type:'xf_fortress_drone', tx:76, tz:204},
    {type:'xf_fortress_drone', tx:68, tz:191},
    {type:'xf_titan_elite', tx:45, tz:167},
    {type:'xf_titan_elite', tx:46, tz:168},
    {type:'xf_warlord', tx:32, tz:165},
    {type:'xf_warlord', tx:40, tz:175},
    {type:'xf_siege_walker', tx:48, tz:159},
    {type:'xf_siege_walker', tx:44, tz:174},
    {type:'xf_titan_elite', tx:35, tz:174},
    {type:'xf_titan_elite', tx:33, tz:172},
    {type:'xf_fortress_drone', tx:42, tz:162},
    {type:'xf_fortress_drone', tx:43, tz:175},
    {type:'xf_titan_elite', tx:200, tz:202},
    {type:'xf_titan_elite', tx:208, tz:199},
    {type:'xf_warlord', tx:196, tz:197},
    {type:'xf_warlord', tx:209, tz:194},
    {type:'xf_siege_walker', tx:202, tz:208},
    {type:'xf_siege_walker', tx:199, tz:207},
    {type:'xf_titan_elite', tx:203, tz:199},
    {type:'xf_titan_elite', tx:197, tz:206},
    {type:'xf_fortress_drone', tx:203, tz:206},
    {type:'xf_fortress_drone', tx:192, tz:208},
    {type:'xf_titan_elite', tx:162, tz:206},
    {type:'xf_titan_elite', tx:160, tz:206},
    {type:'xf_warlord', tx:160, tz:199},
    {type:'xf_warlord', tx:170, tz:196},
    {type:'xf_siege_walker', tx:174, tz:206},
    {type:'xf_siege_walker', tx:175, tz:194},
    {type:'xf_titan_elite', tx:173, tz:208},
    {type:'xf_titan_elite', tx:160, tz:191},
    {type:'xf_fortress_drone', tx:176, tz:195},
    {type:'xf_fortress_drone', tx:177, tz:195},
    {type:'xf_titan_elite', tx:196, tz:170},
    {type:'xf_titan_elite', tx:209, tz:161},
    {type:'xf_warlord', tx:208, tz:171},
    {type:'xf_warlord', tx:199, tz:167},
    {type:'xf_siege_walker', tx:205, tz:168},
    {type:'xf_siege_walker', tx:209, tz:160},
    {type:'xf_titan_elite', tx:193, tz:175},
    {type:'xf_titan_elite', tx:193, tz:163},
    {type:'xf_fortress_drone', tx:200, tz:166},
    {type:'xf_fortress_drone', tx:209, tz:173},
    {type:'xf_titan_elite', tx:128, tz:56},
    {type:'xf_titan_elite', tx:126, tz:57},
    {type:'xf_warlord', tx:111, tz:60},
    {type:'xf_warlord', tx:118, tz:44},
    {type:'xf_siege_walker', tx:119, tz:50},
    {type:'xf_siege_walker', tx:125, tz:52},
    {type:'xf_titan_elite', tx:111, tz:53},
    {type:'xf_titan_elite', tx:127, tz:54},
    {type:'xf_fortress_drone', tx:119, tz:44},
    {type:'xf_fortress_drone', tx:124, tz:57},
    {type:'xf_titan_elite', tx:120, tz:182},
    {type:'xf_titan_elite', tx:122, tz:191},
    {type:'xf_warlord', tx:126, tz:194},
    {type:'xf_warlord', tx:114, tz:196},
    {type:'xf_siege_walker', tx:119, tz:182},
    {type:'xf_siege_walker', tx:125, tz:179},
    {type:'xf_titan_elite', tx:112, tz:180},
    {type:'xf_titan_elite', tx:115, tz:190},
    {type:'xf_fortress_drone', tx:118, tz:190},
    {type:'xf_fortress_drone', tx:114, tz:190},
    {type:'xf_titan_elite', tx:61, tz:116},
    {type:'xf_titan_elite', tx:53, tz:111},
    {type:'xf_warlord', tx:50, tz:127},
    {type:'xf_warlord', tx:48, tz:112},
    {type:'xf_siege_walker', tx:60, tz:114},
    {type:'xf_siege_walker', tx:49, tz:123},
    {type:'xf_titan_elite', tx:50, tz:128},
    {type:'xf_titan_elite', tx:51, tz:113},
    {type:'xf_fortress_drone', tx:65, tz:112},
    {type:'xf_fortress_drone', tx:65, tz:115},
    {type:'xf_titan_elite', tx:189, tz:119},
    {type:'xf_titan_elite', tx:178, tz:125},
    {type:'xf_warlord', tx:176, tz:127},
    {type:'xf_warlord', tx:180, tz:118},
    {type:'xf_siege_walker', tx:180, tz:129},
    {type:'xf_siege_walker', tx:187, tz:119},
    {type:'xf_fortress_drone', tx:183, tz:115},
    {type:'xf_fortress_drone', tx:177, tz:119},
    {type:'xf_siege_walker', tx:98, tz:68},
    {type:'xf_warlord', tx:157, tz:161},
    {type:'xf_fortress_drone', tx:203, tz:52},
    {type:'xf_siege_walker', tx:72, tz:127},
    {type:'xf_warlord', tx:36, tz:176},
    {type:'xf_fortress_drone', tx:20, tz:84},
    {type:'xf_siege_walker', tx:117, tz:155},
    {type:'xf_warlord', tx:98, tz:98},
    {type:'xf_fortress_drone', tx:215, tz:146},
    {type:'xf_siege_walker', tx:71, tz:186},
    {type:'xf_warlord', tx:203, tz:132},
    {type:'xf_fortress_drone', tx:155, tz:145},
    {type:'xf_siege_walker', tx:222, tz:38},
    {type:'xf_warlord', tx:118, tz:26},
    {type:'xf_fortress_drone', tx:188, tz:157},
    {type:'xf_siege_walker', tx:70, tz:172},
    {type:'xf_warlord', tx:66, tz:72},
    {type:'xf_fortress_drone', tx:188, tz:28},
    {type:'xf_siege_walker', tx:223, tz:125},
    {type:'xf_warlord', tx:205, tz:40},
    {type:'xf_siege_walker', tx:100, tz:143},
    {type:'xf_warlord', tx:66, tz:37},
    {type:'xf_siege_walker', tx:188, tz:117},
    {type:'xf_warlord', tx:175, tz:163},
    {type:'xf_siege_walker', tx:186, tz:97},
    {type:'xf_warlord', tx:102, tz:188},
    {type:'xf_siege_walker', tx:144, tz:97},
    {type:'xf_warlord', tx:57, tz:131},
    {type:'xf_siege_walker', tx:161, tz:86},
    {type:'xf_warlord', tx:126, tz:206},
    {type:'xf_siege_walker', tx:162, tz:203},
    {type:'xf_warlord', tx:170, tz:217},
    {type:'xf_siege_walker', tx:99, tz:28},
    {type:'xf_warlord', tx:35, tz:126},
    {type:'xf_siege_walker', tx:142, tz:161},
    {type:'xf_warlord', tx:25, tz:97},
    {type:'xf_siege_walker', tx:67, tz:98},
    {type:'xf_warlord', tx:132, tz:87},
    {type:'xf_warlord', tx:132, tz:51},
    {type:'xf_warlord', tx:97, tz:39},
    {type:'xf_warlord', tx:156, tz:56},
    {type:'xf_warlord', tx:208, tz:192}
  ],
  fungal: [],   // a471 — client-authoritative (bespoke spore AI client-side); server no longer spawns/owns these mobs.
  // a553 — VOID CITADEL is now SERVER-AUTHORITATIVE (was client-side since a492).
  //   204 spawns lifted verbatim from the client's enemySpawns in 80_zone_defs.part.
  //   HP is NOT unchanged here — this is the first migrated zone that needs it. See
  //   ZONE_TYPE_HP above; without those entries these four would ship at a sixth to a
  //   their intended health.
  void_citadel: [
    {type:'void_construct', tx:44, tz:31},
    {type:'void_construct', tx:46, tz:35},
    {type:'void_sentinel', tx:44, tz:39},
    {type:'void_sentinel', tx:36, tz:44},
    {type:'rift_stalker', tx:49, tz:42},
    {type:'rift_stalker', tx:44, tz:46},
    {type:'void_construct', tx:33, tz:48},
    {type:'void_construct', tx:42, tz:41},
    {type:'rift_weaver', tx:37, tz:36},
    {type:'rift_weaver', tx:47, tz:48},
    {type:'void_construct', tx:67, tz:37},
    {type:'void_construct', tx:79, tz:38},
    {type:'void_sentinel', tx:73, tz:39},
    {type:'void_sentinel', tx:80, tz:44},
    {type:'rift_stalker', tx:81, tz:43},
    {type:'rift_stalker', tx:71, tz:33},
    {type:'void_construct', tx:67, tz:48},
    {type:'void_construct', tx:64, tz:49},
    {type:'rift_weaver', tx:69, tz:40},
    {type:'rift_weaver', tx:65, tz:44},
    {type:'void_construct', tx:31, tz:66},
    {type:'void_construct', tx:49, tz:78},
    {type:'void_sentinel', tx:32, tz:69},
    {type:'void_sentinel', tx:31, tz:75},
    {type:'rift_stalker', tx:40, tz:74},
    {type:'rift_stalker', tx:48, tz:72},
    {type:'void_construct', tx:37, tz:75},
    {type:'void_construct', tx:34, tz:64},
    {type:'rift_weaver', tx:48, tz:68},
    {type:'rift_weaver', tx:40, tz:76},
    {type:'void_construct', tx:196, tz:44},
    {type:'void_construct', tx:209, tz:42},
    {type:'void_sentinel', tx:195, tz:49},
    {type:'void_sentinel', tx:199, tz:41},
    {type:'rift_stalker', tx:202, tz:41},
    {type:'rift_stalker', tx:200, tz:43},
    {type:'void_construct', tx:198, tz:48},
    {type:'void_construct', tx:208, tz:36},
    {type:'rift_weaver', tx:200, tz:41},
    {type:'rift_weaver', tx:194, tz:46},
    {type:'void_construct', tx:160, tz:37},
    {type:'void_construct', tx:166, tz:32},
    {type:'void_sentinel', tx:163, tz:48},
    {type:'void_sentinel', tx:164, tz:44},
    {type:'rift_stalker', tx:174, tz:31},
    {type:'rift_stalker', tx:169, tz:46},
    {type:'void_construct', tx:173, tz:38},
    {type:'void_construct', tx:169, tz:39},
    {type:'rift_weaver', tx:168, tz:42},
    {type:'rift_weaver', tx:174, tz:49},
    {type:'void_construct', tx:193, tz:68},
    {type:'void_construct', tx:203, tz:64},
    {type:'void_sentinel', tx:194, tz:80},
    {type:'void_sentinel', tx:194, tz:76},
    {type:'rift_stalker', tx:206, tz:77},
    {type:'rift_stalker', tx:195, tz:79},
    {type:'void_construct', tx:196, tz:65},
    {type:'void_construct', tx:196, tz:73},
    {type:'rift_weaver', tx:203, tz:80},
    {type:'rift_weaver', tx:196, tz:69},
    {type:'void_construct', tx:36, tz:201},
    {type:'void_construct', tx:36, tz:203},
    {type:'void_sentinel', tx:36, tz:204},
    {type:'void_sentinel', tx:49, tz:200},
    {type:'rift_stalker', tx:43, tz:204},
    {type:'rift_stalker', tx:39, tz:205},
    {type:'void_construct', tx:44, tz:203},
    {type:'void_construct', tx:42, tz:201},
    {type:'rift_weaver', tx:35, tz:209},
    {type:'rift_weaver', tx:43, tz:194},
    {type:'void_construct', tx:69, tz:205},
    {type:'void_construct', tx:70, tz:205},
    {type:'void_sentinel', tx:80, tz:196},
    {type:'void_sentinel', tx:65, tz:192},
    {type:'rift_stalker', tx:71, tz:205},
    {type:'rift_stalker', tx:65, tz:193},
    {type:'void_construct', tx:78, tz:201},
    {type:'void_construct', tx:70, tz:202},
    {type:'rift_weaver', tx:79, tz:207},
    {type:'rift_weaver', tx:75, tz:205},
    {type:'void_construct', tx:44, tz:177},
    {type:'void_construct', tx:48, tz:159},
    {type:'void_sentinel', tx:36, tz:174},
    {type:'void_sentinel', tx:33, tz:171},
    {type:'rift_stalker', tx:47, tz:169},
    {type:'rift_stalker', tx:43, tz:161},
    {type:'void_construct', tx:44, tz:163},
    {type:'void_construct', tx:40, tz:167},
    {type:'rift_weaver', tx:38, tz:176},
    {type:'rift_weaver', tx:41, tz:166},
    {type:'void_construct', tx:200, tz:202},
    {type:'void_construct', tx:202, tz:209},
    {type:'void_sentinel', tx:203, tz:197},
    {type:'void_sentinel', tx:206, tz:198},
    {type:'rift_stalker', tx:200, tz:195},
    {type:'rift_stalker', tx:209, tz:193},
    {type:'void_construct', tx:198, tz:208},
    {type:'void_construct', tx:194, tz:192},
    {type:'rift_weaver', tx:204, tz:192},
    {type:'rift_weaver', tx:209, tz:206},
    {type:'void_construct', tx:161, tz:209},
    {type:'void_construct', tx:176, tz:201},
    {type:'void_sentinel', tx:169, tz:196},
    {type:'void_sentinel', tx:166, tz:204},
    {type:'rift_stalker', tx:171, tz:205},
    {type:'rift_stalker', tx:173, tz:205},
    {type:'void_construct', tx:176, tz:209},
    {type:'void_construct', tx:164, tz:207},
    {type:'rift_weaver', tx:168, tz:193},
    {type:'rift_weaver', tx:176, tz:193},
    {type:'void_construct', tx:199, tz:170},
    {type:'void_construct', tx:193, tz:165},
    {type:'void_sentinel', tx:209, tz:171},
    {type:'void_sentinel', tx:200, tz:177},
    {type:'rift_stalker', tx:194, tz:159},
    {type:'rift_stalker', tx:203, tz:168},
    {type:'void_construct', tx:199, tz:161},
    {type:'void_construct', tx:196, tz:174},
    {type:'rift_weaver', tx:200, tz:162},
    {type:'rift_weaver', tx:204, tz:166},
    {type:'void_construct', tx:117, tz:50},
    {type:'void_construct', tx:113, tz:58},
    {type:'void_sentinel', tx:126, tz:53},
    {type:'void_sentinel', tx:123, tz:57},
    {type:'rift_stalker', tx:124, tz:54},
    {type:'rift_stalker', tx:116, tz:52},
    {type:'void_construct', tx:129, tz:56},
    {type:'void_construct', tx:115, tz:48},
    {type:'rift_weaver', tx:117, tz:43},
    {type:'rift_weaver', tx:120, tz:44},
    {type:'void_construct', tx:126, tz:189},
    {type:'void_construct', tx:121, tz:182},
    {type:'void_sentinel', tx:112, tz:191},
    {type:'void_sentinel', tx:115, tz:196},
    {type:'rift_stalker', tx:119, tz:185},
    {type:'rift_stalker', tx:127, tz:185},
    {type:'void_construct', tx:121, tz:197},
    {type:'void_construct', tx:121, tz:192},
    {type:'rift_weaver', tx:117, tz:184},
    {type:'rift_weaver', tx:129, tz:191},
    {type:'void_construct', tx:51, tz:118},
    {type:'void_construct', tx:65, tz:123},
    {type:'void_sentinel', tx:54, tz:124},
    {type:'void_sentinel', tx:48, tz:124},
    {type:'rift_stalker', tx:64, tz:123},
    {type:'rift_stalker', tx:49, tz:115},
    {type:'void_construct', tx:63, tz:121},
    {type:'void_construct', tx:65, tz:115},
    {type:'rift_weaver', tx:60, tz:111},
    {type:'rift_weaver', tx:53, tz:113},
    {type:'void_construct', tx:180, tz:121},
    {type:'void_construct', tx:178, tz:116},
    {type:'void_sentinel', tx:177, tz:120},
    {type:'void_sentinel', tx:176, tz:111},
    {type:'rift_stalker', tx:190, tz:115},
    {type:'rift_stalker', tx:184, tz:116},
    {type:'void_construct', tx:186, tz:124},
    {type:'void_construct', tx:181, tz:114},
    {type:'rift_weaver', tx:178, tz:127},
    {type:'rift_weaver', tx:184, tz:118},
    {type:'void_construct', tx:148, tz:160},
    {type:'void_sentinel', tx:140, tz:98},
    {type:'rift_stalker', tx:52, tz:118},
    {type:'rift_weaver', tx:218, tz:224},
    {type:'void_construct', tx:104, tz:166},
    {type:'void_sentinel', tx:182, tz:208},
    {type:'rift_stalker', tx:109, tz:67},
    {type:'rift_weaver', tx:121, tz:70},
    {type:'void_sentinel', tx:94, tz:148},
    {type:'rift_stalker', tx:220, tz:39},
    {type:'void_sentinel', tx:26, tz:218},
    {type:'rift_stalker', tx:224, tz:49},
    {type:'void_sentinel', tx:182, tz:217},
    {type:'rift_stalker', tx:203, tz:149},
    {type:'void_sentinel', tx:119, tz:161},
    {type:'rift_stalker', tx:79, tz:150},
    {type:'void_sentinel', tx:95, tz:39},
    {type:'rift_stalker', tx:160, tz:79},
    {type:'void_sentinel', tx:21, tz:55},
    {type:'rift_stalker', tx:84, tz:67},
    {type:'void_sentinel', tx:192, tz:153},
    {type:'void_sentinel', tx:108, tz:193},
    {type:'void_sentinel', tx:216, tz:160},
    {type:'void_sentinel', tx:221, tz:27},
    {type:'void_sentinel', tx:53, tz:206},
    {type:'void_sentinel', tx:54, tz:56},
    {type:'void_sentinel', tx:209, tz:133},
    {type:'void_sentinel', tx:96, tz:51},
    {type:'void_sentinel', tx:91, tz:94},
    {type:'void_sentinel', tx:53, tz:134},
    {type:'void_sentinel', tx:95, tz:82},
    {type:'void_sentinel', tx:164, tz:138},
    {type:'void_sentinel', tx:36, tz:34},
    {type:'void_sentinel', tx:138, tz:178},
    {type:'void_sentinel', tx:204, tz:162},
    {type:'void_sentinel', tx:176, tz:65},
    {type:'void_sentinel', tx:216, tz:65},
    {type:'void_sentinel', tx:193, tz:49},
    {type:'void_sentinel', tx:53, tz:181},
    {type:'void_sentinel', tx:26, tz:146},
    {type:'void_sentinel', tx:76, tz:91},
    {type:'void_sentinel', tx:137, tz:68},
    {type:'void_sentinel', tx:124, tz:217},
    {type:'void_sentinel', tx:149, tz:177}
  ],
  // ── NEON HOLLOW — POST-CAP AA-GATED (matches client ZONE_DEFS.neon_hollow) ──
  // a549 — NEON HOLLOW is now SERVER-AUTHORITATIVE (was client-side since a487).
  //   196 spawns lifted verbatim from the client's enemySpawns in 80_zone_defs.part.
  //   HP intentionally UNCHANGED (no ZONE_HP_MULT entry) — ENEMY_STATS already carries
  //   the E12 values and the client kit applies no bump. Altitude needs no sync here:
  //   the drone/wraith/crash-car hover heights are STATIC py values applied by the
  //   client at mesh creation, and nothing in the kit animates Y.
  neon_hollow: [
    {type:'hollow_enforcer', tx:33, tz:34},
    {type:'hollow_enforcer', tx:34, tz:37},
    {type:'maintenance_striker', tx:45, tz:46},
    {type:'maintenance_striker', tx:37, tz:36},
    {type:'sentinel_drone', tx:47, tz:41},
    {type:'sentinel_drone', tx:41, tz:33},
    {type:'neon_wraith', tx:31, tz:36},
    {type:'neon_wraith', tx:49, tz:41},
    {type:'skybridge_sniper', tx:44, tz:46},
    {type:'skybridge_sniper', tx:37, tz:39},
    {type:'hollow_enforcer', tx:73, tz:47},
    {type:'hollow_enforcer', tx:76, tz:38},
    {type:'maintenance_striker', tx:66, tz:37},
    {type:'maintenance_striker', tx:63, tz:44},
    {type:'sentinel_drone', tx:67, tz:47},
    {type:'sentinel_drone', tx:68, tz:42},
    {type:'neon_wraith', tx:74, tz:49},
    {type:'neon_wraith', tx:76, tz:42},
    {type:'skybridge_sniper', tx:78, tz:37},
    {type:'skybridge_sniper', tx:67, tz:43},
    {type:'hollow_enforcer', tx:41, tz:76},
    {type:'hollow_enforcer', tx:49, tz:72},
    {type:'maintenance_striker', tx:40, tz:76},
    {type:'maintenance_striker', tx:34, tz:81},
    {type:'sentinel_drone', tx:38, tz:77},
    {type:'sentinel_drone', tx:33, tz:81},
    {type:'neon_wraith', tx:33, tz:63},
    {type:'neon_wraith', tx:38, tz:73},
    {type:'skybridge_sniper', tx:44, tz:63},
    {type:'skybridge_sniper', tx:37, tz:67},
    {type:'hollow_enforcer', tx:196, tz:33},
    {type:'hollow_enforcer', tx:206, tz:35},
    {type:'maintenance_striker', tx:193, tz:38},
    {type:'maintenance_striker', tx:194, tz:37},
    {type:'sentinel_drone', tx:191, tz:35},
    {type:'sentinel_drone', tx:199, tz:35},
    {type:'neon_wraith', tx:208, tz:36},
    {type:'neon_wraith', tx:208, tz:42},
    {type:'skybridge_sniper', tx:203, tz:32},
    {type:'skybridge_sniper', tx:207, tz:45},
    {type:'hollow_enforcer', tx:169, tz:45},
    {type:'hollow_enforcer', tx:173, tz:38},
    {type:'maintenance_striker', tx:169, tz:34},
    {type:'maintenance_striker', tx:171, tz:42},
    {type:'sentinel_drone', tx:171, tz:44},
    {type:'sentinel_drone', tx:173, tz:37},
    {type:'neon_wraith', tx:167, tz:44},
    {type:'neon_wraith', tx:176, tz:45},
    {type:'skybridge_sniper', tx:177, tz:44},
    {type:'skybridge_sniper', tx:160, tz:31},
    {type:'hollow_enforcer', tx:202, tz:79},
    {type:'hollow_enforcer', tx:203, tz:78},
    {type:'maintenance_striker', tx:205, tz:70},
    {type:'maintenance_striker', tx:194, tz:74},
    {type:'sentinel_drone', tx:193, tz:74},
    {type:'sentinel_drone', tx:208, tz:75},
    {type:'neon_wraith', tx:207, tz:69},
    {type:'neon_wraith', tx:200, tz:71},
    {type:'skybridge_sniper', tx:196, tz:67},
    {type:'skybridge_sniper', tx:196, tz:65},
    {type:'hollow_enforcer', tx:37, tz:201},
    {type:'hollow_enforcer', tx:40, tz:192},
    {type:'maintenance_striker', tx:39, tz:198},
    {type:'maintenance_striker', tx:44, tz:206},
    {type:'sentinel_drone', tx:43, tz:194},
    {type:'sentinel_drone', tx:49, tz:208},
    {type:'neon_wraith', tx:40, tz:199},
    {type:'neon_wraith', tx:44, tz:205},
    {type:'skybridge_sniper', tx:48, tz:201},
    {type:'skybridge_sniper', tx:48, tz:206},
    {type:'hollow_enforcer', tx:74, tz:200},
    {type:'hollow_enforcer', tx:71, tz:203},
    {type:'maintenance_striker', tx:81, tz:202},
    {type:'maintenance_striker', tx:70, tz:205},
    {type:'sentinel_drone', tx:69, tz:206},
    {type:'sentinel_drone', tx:78, tz:204},
    {type:'neon_wraith', tx:74, tz:201},
    {type:'neon_wraith', tx:65, tz:209},
    {type:'skybridge_sniper', tx:64, tz:200},
    {type:'skybridge_sniper', tx:72, tz:203},
    {type:'hollow_enforcer', tx:49, tz:164},
    {type:'hollow_enforcer', tx:40, tz:165},
    {type:'maintenance_striker', tx:48, tz:168},
    {type:'maintenance_striker', tx:41, tz:162},
    {type:'sentinel_drone', tx:32, tz:167},
    {type:'sentinel_drone', tx:40, tz:168},
    {type:'neon_wraith', tx:44, tz:163},
    {type:'neon_wraith', tx:35, tz:172},
    {type:'skybridge_sniper', tx:45, tz:177},
    {type:'skybridge_sniper', tx:41, tz:176},
    {type:'hollow_enforcer', tx:203, tz:194},
    {type:'hollow_enforcer', tx:199, tz:201},
    {type:'maintenance_striker', tx:199, tz:203},
    {type:'maintenance_striker', tx:199, tz:199},
    {type:'sentinel_drone', tx:200, tz:200},
    {type:'sentinel_drone', tx:194, tz:202},
    {type:'neon_wraith', tx:202, tz:199},
    {type:'neon_wraith', tx:202, tz:201},
    {type:'skybridge_sniper', tx:201, tz:192},
    {type:'skybridge_sniper', tx:206, tz:194},
    {type:'hollow_enforcer', tx:159, tz:209},
    {type:'hollow_enforcer', tx:175, tz:199},
    {type:'maintenance_striker', tx:169, tz:209},
    {type:'maintenance_striker', tx:166, tz:196},
    {type:'sentinel_drone', tx:172, tz:198},
    {type:'sentinel_drone', tx:173, tz:209},
    {type:'neon_wraith', tx:171, tz:201},
    {type:'neon_wraith', tx:165, tz:196},
    {type:'skybridge_sniper', tx:162, tz:203},
    {type:'skybridge_sniper', tx:170, tz:205},
    {type:'hollow_enforcer', tx:209, tz:163},
    {type:'hollow_enforcer', tx:207, tz:164},
    {type:'maintenance_striker', tx:192, tz:162},
    {type:'maintenance_striker', tx:205, tz:168},
    {type:'sentinel_drone', tx:198, tz:168},
    {type:'sentinel_drone', tx:196, tz:177},
    {type:'neon_wraith', tx:197, tz:177},
    {type:'neon_wraith', tx:203, tz:161},
    {type:'skybridge_sniper', tx:202, tz:167},
    {type:'skybridge_sniper', tx:209, tz:159},
    {type:'hollow_enforcer', tx:117, tz:58},
    {type:'hollow_enforcer', tx:129, tz:54},
    {type:'maintenance_striker', tx:126, tz:59},
    {type:'maintenance_striker', tx:125, tz:49},
    {type:'sentinel_drone', tx:121, tz:56},
    {type:'sentinel_drone', tx:114, tz:47},
    {type:'neon_wraith', tx:125, tz:51},
    {type:'neon_wraith', tx:115, tz:59},
    {type:'skybridge_sniper', tx:124, tz:56},
    {type:'skybridge_sniper', tx:124, tz:45},
    {type:'hollow_enforcer', tx:121, tz:181},
    {type:'hollow_enforcer', tx:129, tz:194},
    {type:'maintenance_striker', tx:123, tz:192},
    {type:'maintenance_striker', tx:115, tz:196},
    {type:'sentinel_drone', tx:129, tz:182},
    {type:'sentinel_drone', tx:114, tz:196},
    {type:'neon_wraith', tx:121, tz:186},
    {type:'neon_wraith', tx:115, tz:184},
    {type:'skybridge_sniper', tx:114, tz:189},
    {type:'skybridge_sniper', tx:125, tz:196},
    {type:'hollow_enforcer', tx:65, tz:115},
    {type:'hollow_enforcer', tx:47, tz:114},
    {type:'maintenance_striker', tx:65, tz:128},
    {type:'maintenance_striker', tx:61, tz:112},
    {type:'sentinel_drone', tx:51, tz:111},
    {type:'sentinel_drone', tx:65, tz:116},
    {type:'neon_wraith', tx:64, tz:117},
    {type:'neon_wraith', tx:58, tz:118},
    {type:'hollow_enforcer', tx:191, tz:118},
    {type:'hollow_enforcer', tx:183, tz:112},
    {type:'maintenance_striker', tx:189, tz:117},
    {type:'maintenance_striker', tx:192, tz:121},
    {type:'sentinel_drone', tx:190, tz:121},
    {type:'sentinel_drone', tx:175, tz:128},
    {type:'neon_wraith', tx:177, tz:129},
    {type:'neon_wraith', tx:180, tz:123},
    {type:'sentinel_drone', tx:155, tz:170},
    {type:'neon_wraith', tx:56, tz:117},
    {type:'hollow_enforcer', tx:52, tz:169},
    {type:'crash_car', tx:148, tz:199},
    {type:'sentinel_drone', tx:103, tz:213},
    {type:'neon_wraith', tx:42, tz:52},
    {type:'hollow_enforcer', tx:181, tz:169},
    {type:'crash_car', tx:213, tz:54},
    {type:'sentinel_drone', tx:135, tz:20},
    {type:'neon_wraith', tx:138, tz:165},
    {type:'hollow_enforcer', tx:204, tz:220},
    {type:'crash_car', tx:41, tz:101},
    {type:'sentinel_drone', tx:107, tz:149},
    {type:'neon_wraith', tx:24, tz:59},
    {type:'hollow_enforcer', tx:58, tz:184},
    {type:'crash_car', tx:181, tz:26},
    {type:'sentinel_drone', tx:218, tz:124},
    {type:'neon_wraith', tx:169, tz:186},
    {type:'crash_car', tx:70, tz:184},
    {type:'sentinel_drone', tx:68, tz:153},
    {type:'neon_wraith', tx:182, tz:90},
    {type:'crash_car', tx:204, tz:166},
    {type:'sentinel_drone', tx:218, tz:101},
    {type:'neon_wraith', tx:181, tz:70},
    {type:'crash_car', tx:151, tz:100},
    {type:'sentinel_drone', tx:119, tz:91},
    {type:'neon_wraith', tx:187, tz:58},
    {type:'crash_car', tx:108, tz:187},
    {type:'sentinel_drone', tx:86, tz:133},
    {type:'crash_car', tx:87, tz:154},
    {type:'sentinel_drone', tx:153, tz:75},
    {type:'crash_car', tx:168, tz:36},
    {type:'sentinel_drone', tx:219, tz:180},
    {type:'crash_car', tx:204, tz:40},
    {type:'sentinel_drone', tx:84, tz:100},
    {type:'crash_car', tx:183, tz:105},
    {type:'sentinel_drone', tx:20, tz:103},
    {type:'sentinel_drone', tx:57, tz:26},
    {type:'sentinel_drone', tx:69, tz:102},
    {type:'sentinel_drone', tx:149, tz:155}
  ],
  // ── VEILED SANCTUARY (v92.41) — matches client ZONE_DEFS.veiled_sanctuary ──
  // a545 — MULTIPLAYER MIGRATION: The Veiled Sanctuary is now server-authoritative.
  veiled_sanctuary: [
    {type:'veiled_acolyte', tx:14, tz:36},
    {type:'veiled_acolyte', tx:16, tz:42},
    {type:'censer_bearer', tx:18, tz:38},
    {type:'penitent_striker', tx:20, tz:44},
    {type:'veiled_acolyte', tx:22, tz:36},
    {type:'choir_wraith', tx:24, tz:42},
    {type:'stone_inquisitor', tx:28, tz:30},
    {type:'censer_bearer', tx:30, tz:36},
    {type:'choir_wraith', tx:32, tz:42},
    {type:'penitent_striker', tx:34, tz:48},
    {type:'ritual_guardian', tx:36, tz:30},
    {type:'veiled_acolyte', tx:38, tz:42},
    {type:'stone_inquisitor', tx:40, tz:36},
    {type:'censer_bearer', tx:42, tz:48},
    {type:'choir_wraith', tx:44, tz:30},
    {type:'penitent_striker', tx:46, tz:42},
    {type:'veiled_cardinal', tx:50, tz:40},
    {type:'veiled_acolyte', tx:52, tz:34},
    {type:'veiled_acolyte', tx:52, tz:46},
    {type:'ritual_guardian', tx:54, tz:38},
    {type:'ritual_guardian', tx:54, tz:42},
    {type:'choir_wraith', tx:60, tz:34},
    {type:'choir_wraith', tx:60, tz:46},
    {type:'forsaken_abbot', tx:62, tz:40},
    {type:'stone_inquisitor', tx:64, tz:36},
    {type:'stone_inquisitor', tx:64, tz:44},
    {type:'penitent_striker', tx:66, tz:38},
    {type:'penitent_striker', tx:66, tz:42},
    {type:'ritual_guardian', tx:70, tz:38},
    {type:'ritual_guardian', tx:70, tz:42},
    {type:'censer_bearer', tx:72, tz:40}
  ],
  // ── BLOOMING WILDS (v92.49+v92.50) — matches client ZONE_DEFS.blooming_wilds ──
  // a535 — MULTIPLAYER MIGRATION: The Blooming Wilds is now server-authoritative.
  blooming_wilds: [
    {type:'thorn_knight', tx:144, tz:101},
    {type:'thorn_knight', tx:147, tz:101},
    {type:'thorn_knight', tx:147, tz:140},
    {type:'thorn_knight', tx:147, tz:142},
    {type:'mushroom_brute', tx:100, tz:148},
    {type:'mushroom_brute', tx:99, tz:147},
    {type:'mushroom_brute', tx:155, tz:139},
    {type:'mushroom_brute', tx:153, tz:137},
    {type:'mushroom_brute', tx:85, tz:103},
    {type:'mushroom_brute', tx:86, tz:103},
    {type:'mushroom_brute', tx:127, tz:78},
    {type:'mushroom_brute', tx:126, tz:81},
    {type:'mushroom_brute', tx:108, tz:158},
    {type:'mushroom_brute', tx:106, tz:159},
    {type:'mushroom_brute', tx:162, tz:105},
    {type:'mushroom_brute', tx:160, tz:106},
    {type:'mushroom_brute', tx:85, tz:147},
    {type:'mushroom_brute', tx:86, tz:146},
    {type:'mushroom_brute', tx:94, tz:82},
    {type:'mushroom_brute', tx:97, tz:82},
    {type:'mushroom_brute', tx:77, tz:114},
    {type:'mushroom_brute', tx:74, tz:112},
    {type:'mushroom_brute', tx:166, tz:119},
    {type:'mushroom_brute', tx:165, tz:118},
    {type:'mushroom_brute', tx:112, tz:167},
    {type:'mushroom_brute', tx:113, tz:167},
    {type:'mushroom_brute', tx:140, tz:164},
    {type:'mushroom_brute', tx:144, tz:165},
    {type:'vine_stalker', tx:145, tz:75},
    {type:'vine_stalker', tx:146, tz:75},
    {type:'vine_stalker', tx:156, tz:82},
    {type:'vine_stalker', tx:157, tz:83},
    {type:'vine_stalker', tx:83, tz:161},
    {type:'vine_stalker', tx:84, tz:159},
    {type:'vine_stalker', tx:102, tz:67},
    {type:'vine_stalker', tx:105, tz:69},
    {type:'vine_stalker', tx:128, tz:64},
    {type:'vine_stalker', tx:126, tz:66},
    {type:'vine_stalker', tx:113, tz:175},
    {type:'vine_stalker', tx:116, tz:175},
    {type:'vine_stalker', tx:134, tz:61},
    {type:'vine_stalker', tx:130, tz:63},
    {type:'vine_stalker', tx:61, tz:100},
    {type:'vine_stalker', tx:61, tz:102},
    {type:'vine_stalker', tx:168, tz:161},
    {type:'vine_stalker', tx:165, tz:161},
    {type:'vine_stalker', tx:184, tz:126},
    {type:'vine_stalker', tx:183, tz:129},
    {type:'vine_stalker', tx:63, tz:143},
    {type:'vine_stalker', tx:64, tz:143},
    {type:'vine_stalker', tx:152, tz:68},
    {type:'vine_stalker', tx:153, tz:65},
    {type:'vine_stalker', tx:181, tz:104},
    {type:'vine_stalker', tx:183, tz:106},
    {type:'vine_stalker', tx:57, tz:116},
    {type:'vine_stalker', tx:56, tz:115},
    {type:'vine_stalker', tx:183, tz:132},
    {type:'vine_stalker', tx:182, tz:134},
    {type:'vine_stalker', tx:75, tz:73},
    {type:'vine_stalker', tx:76, tz:75},
    {type:'vine_stalker', tx:146, tz:181},
    {type:'vine_stalker', tx:144, tz:180},
    {type:'pollen_wraith', tx:103, tz:182},
    {type:'pollen_wraith', tx:101, tz:186},
    {type:'pollen_wraith', tx:82, tz:62},
    {type:'pollen_wraith', tx:83, tz:64},
    {type:'pollen_wraith', tx:165, tz:176},
    {type:'pollen_wraith', tx:164, tz:177},
    {type:'pollen_wraith', tx:65, tz:167},
    {type:'pollen_wraith', tx:67, tz:169},
    {type:'pollen_wraith', tx:58, tz:79},
    {type:'pollen_wraith', tx:60, tz:82},
    {type:'pollen_wraith', tx:180, tz:163},
    {type:'pollen_wraith', tx:178, tz:165},
    {type:'pollen_wraith', tx:82, tz:187},
    {type:'pollen_wraith', tx:82, tz:185},
    {type:'pollen_wraith', tx:42, tz:117},
    {type:'pollen_wraith', tx:44, tz:117},
    {type:'pollen_wraith', tx:127, tz:199},
    {type:'pollen_wraith', tx:125, tz:198},
    {type:'pollen_wraith', tx:95, tz:198},
    {type:'pollen_wraith', tx:94, tz:197},
    {type:'pollen_wraith', tx:44, tz:144},
    {type:'pollen_wraith', tx:43, tz:139},
    {type:'pollen_wraith', tx:133, tz:198},
    {type:'pollen_wraith', tx:133, tz:200},
    {type:'pollen_wraith', tx:182, tz:174},
    {type:'pollen_wraith', tx:183, tz:175},
    {type:'pollen_wraith', tx:188, tz:74},
    {type:'pollen_wraith', tx:186, tz:74},
    {type:'glimmer_fairy', tx:203, tz:103},
    {type:'glimmer_fairy', tx:201, tz:103},
    {type:'glimmer_fairy', tx:65, tz:62},
    {type:'glimmer_fairy', tx:100, tz:39},
    {type:'glimmer_fairy', tx:41, tz:101},
    {type:'glimmer_fairy', tx:47, tz:152},
    {type:'glimmer_fairy', tx:135, tz:35},
    {type:'glimmer_fairy', tx:204, tz:118},
    {type:'glimmer_fairy', tx:122, tz:35},
    {type:'glimmer_fairy', tx:42, tz:85},
    {type:'glimmer_fairy', tx:84, tz:199},
    {type:'glimmer_fairy', tx:87, tz:37},
    {type:'glimmer_fairy', tx:209, tz:139},
    {type:'glimmer_fairy', tx:67, tz:47},
    {type:'glimmer_fairy', tx:188, tz:59},
    {type:'glimmer_fairy', tx:152, tz:32},
    {type:'glimmer_fairy', tx:162, tz:201},
    {type:'glimmer_fairy', tx:177, tz:46},
    {type:'glimmer_fairy', tx:195, tz:64},
    {type:'glimmer_fairy', tx:190, tz:178},
    {type:'glimmer_fairy', tx:124, tz:24},
    {type:'glimmer_fairy', tx:53, tz:185},
    {type:'glimmer_fairy', tx:25, tz:113},
    {type:'glimmer_fairy', tx:103, tz:212},
    {type:'glimmer_fairy', tx:205, tz:81},
    {type:'glimmer_fairy', tx:201, tz:167},
    {type:'glimmer_fairy', tx:103, tz:25},
    {type:'glimmer_fairy', tx:28, tz:98},
    {type:'glimmer_fairy', tx:212, tz:96},
    {type:'glimmer_fairy', tx:215, tz:123},
    {type:'bloom_sprite', tx:136, tz:216},
    {type:'bloom_sprite', tx:217, tz:142},
    {type:'bloom_sprite', tx:215, tz:160},
    {type:'bloom_sprite', tx:35, tz:61},
    {type:'bloom_sprite', tx:67, tz:208},
    {type:'bloom_sprite', tx:184, tz:201},
    {type:'bloom_sprite', tx:192, tz:197},
    {type:'bloom_sprite', tx:158, tz:22},
    {type:'bloom_sprite', tx:15, tz:140},
    {type:'bloom_sprite', tx:220, tz:78},
    {type:'bloom_sprite', tx:17, tz:154},
    {type:'bloom_sprite', tx:18, tz:81},
    {type:'bloom_sprite', tx:34, tz:186},
    {type:'bloom_sprite', tx:75, tz:22},
    {type:'bloom_sprite', tx:43, tz:46},
    {type:'bloom_sprite', tx:213, tz:63},
    {type:'bloom_sprite', tx:215, tz:176},
    {type:'bloom_sprite', tx:81, tz:222},
    {type:'bloom_sprite', tx:145, tz:11},
    {type:'bloom_sprite', tx:35, tz:195},
    {type:'bloom_sprite', tx:204, tz:50},
    {type:'bloom_sprite', tx:163, tz:224},
    {type:'bloom_sprite', tx:21, tz:182},
    {type:'bloom_sprite', tx:180, tz:220},
    {type:'bloom_sprite', tx:57, tz:221},
    {type:'bloom_sprite', tx:193, tz:26},
    {type:'bloom_sprite', tx:63, tz:15},
    {type:'bloom_sprite', tx:27, tz:45},
    {type:'bloom_sprite', tx:16, tz:60},
    {type:'bloom_sprite', tx:185, tz:12},
    {type:'bloom_sprite', tx:42, tz:22},
    {type:'bloom_sprite', tx:218, tz:202},
    {type:'bloom_sprite', tx:15, tz:199},
    {type:'bloom_sprite', tx:40, tz:226},
    {type:'bloom_sprite', tx:205, tz:224},
    {type:'bloom_sprite', tx:21, tz:26},
    {type:'bloom_sprite', tx:227, tz:34},
    {type:'bloom_sprite', tx:228, tz:27},
    {type:'bloom_sprite', tx:14, tz:217},
    {type:'bloom_sprite', tx:222, tz:220}
  ],
  // ── XERON (v93.0-a94) — matches client ZONE_DEFS.xeron ──
  // Cut from 86 → 51 mobs to address dense-combat feedback.
  // Also incorporates a92's docking spire pushback (entry now tx 18-30, not 10-22).
  // a537 — MULTIPLAYER MIGRATION: Avia Canyon birds are now server-authoritative WITH maze
  //   collision (see _aviaWalkable). Spawn tiles generated from the deterministic maze grid;
  //   every tile verified walkable. XUBERRY stays server-authoritative via ZONE_BOSS_HP.
  aviacanyon: [
    {type:'skyscout', tx:99, tz:18},
    {type:'beakdrone', tx:58, tz:26},
    {type:'spiraldive', tx:146, tz:26},
    {type:'skyscout', tx:42, tz:34},
    {type:'beakdrone', tx:130, tz:34},
    {type:'wingguard', tx:26, tz:42},
    {type:'spiraldive', tx:130, tz:42},
    {type:'skyscout', tx:26, tz:50},
    {type:'skyscout', tx:114, tz:50},
    {type:'beakdrone', tx:202, tz:50},
    {type:'spiraldive', tx:98, tz:58},
    {type:'skyscout', tx:186, tz:58},
    {type:'beakdrone', tx:82, tz:66},
    {type:'wingguard', tx:170, tz:66},
    {type:'spiraldive', tx:66, tz:74},
    {type:'skyscout', tx:154, tz:74},
    {type:'skyscout', tx:50, tz:82},
    {type:'beakdrone', tx:138, tz:82},
    {type:'spiraldive', tx:33, tz:89},
    {type:'skyscout', tx:122, tz:90},
    {type:'beakdrone', tx:210, tz:90},
    {type:'wingguard', tx:106, tz:98},
    {type:'spiraldive', tx:194, tz:98},
    {type:'skyscout', tx:87, tz:103},
    {type:'skyscout', tx:177, tz:105},
    {type:'beakdrone', tx:76, tz:112},
    {type:'spiraldive', tx:159, tz:112},
    {type:'skyscout', tx:58, tz:122},
    {type:'beakdrone', tx:146, tz:122},
    {type:'wingguard', tx:42, tz:130},
    {type:'spiraldive', tx:130, tz:130},
    {type:'skyscout', tx:26, tz:138},
    {type:'skyscout', tx:114, tz:138},
    {type:'beakdrone', tx:202, tz:138},
    {type:'spiraldive', tx:98, tz:146},
    {type:'skyscout', tx:186, tz:146},
    {type:'beakdrone', tx:82, tz:154},
    {type:'wingguard', tx:170, tz:154},
    {type:'spiraldive', tx:63, tz:159},
    {type:'skyscout', tx:151, tz:159},
    {type:'skyscout', tx:50, tz:170},
    {type:'beakdrone', tx:138, tz:170},
    {type:'spiraldive', tx:33, tz:177},
    {type:'skyscout', tx:121, tz:177},
    {type:'beakdrone', tx:210, tz:178},
    {type:'wingguard', tx:106, tz:186},
    {type:'spiraldive', tx:194, tz:186},
    {type:'skyscout', tx:90, tz:194},
    {type:'skyscout', tx:178, tz:194},
    {type:'beakdrone', tx:104, tz:32},
    {type:'beakdrone', tx:136, tz:32},
    {type:'wingguard', tx:100, tz:48},
    {type:'wingguard', tx:140, tz:48},
    {type:'skyscout', tx:114, tz:26},
    {type:'skyscout', tx:126, tz:26},
    {type:'spiraldive', tx:110, tz:56},
    {type:'spiraldive', tx:130, tz:56},
    {type:'skyscout', tx:120, tz:60},
    {type:'beakdrone', tx:120, tz:28}
  ],
  // a550 — XERON is now SERVER-AUTHORITATIVE (was client-side since a491).
  //   200 spawns lifted verbatim from the client's enemySpawns in 80_zone_defs.part.
  //   HP intentionally UNCHANGED (no ZONE_HP_MULT entry). No altitude sync needed:
  //   the hover heights are static py values applied at mesh creation.
  xeron: [
    {type:'laser_turret', tx:96, tz:108},
    {type:'laser_turret', tx:96, tz:132},
    {type:'laser_turret', tx:144, tz:108},
    {type:'laser_turret', tx:144, tz:132},
    {type:'laser_turret', tx:108, tz:96},
    {type:'laser_turret', tx:132, tz:96},
    {type:'laser_turret', tx:108, tz:144},
    {type:'laser_turret', tx:132, tz:144},
    {type:'laser_turret', tx:40, tz:40},
    {type:'laser_turret', tx:200, tz:40},
    {type:'laser_turret', tx:40, tz:200},
    {type:'laser_turret', tx:200, tz:200},
    {type:'laser_turret', tx:80, tz:120},
    {type:'laser_turret', tx:160, tz:120},
    {type:'laser_turret', tx:120, tz:80},
    {type:'laser_turret', tx:120, tz:160},
    {type:'laser_turret', tx:60, tz:60},
    {type:'laser_turret', tx:180, tz:60},
    {type:'laser_turret', tx:60, tz:180},
    {type:'laser_turret', tx:180, tz:180},
    {type:'laser_turret', tx:40, tz:160},
    {type:'laser_turret', tx:200, tz:80},
    {type:'laser_turret', tx:80, tz:200},
    {type:'laser_turret', tx:160, tz:40},
    {type:'void_marine', tx:53, tz:55},
    {type:'void_marine', tx:54, tz:41},
    {type:'corrupted_xu', tx:40, tz:41},
    {type:'corrupted_xu', tx:50, tz:44},
    {type:'cyber_ogre', tx:54, tz:52},
    {type:'cyber_ogre', tx:46, tz:43},
    {type:'void_marine', tx:48, tz:46},
    {type:'void_marine', tx:55, tz:47},
    {type:'corrupted_xu', tx:53, tz:51},
    {type:'corrupted_xu', tx:42, tz:54},
    {type:'void_marine', tx:78, tz:47},
    {type:'void_marine', tx:71, tz:47},
    {type:'corrupted_xu', tx:79, tz:47},
    {type:'corrupted_xu', tx:72, tz:35},
    {type:'cyber_ogre', tx:64, tz:46},
    {type:'cyber_ogre', tx:65, tz:39},
    {type:'void_marine', tx:78, tz:39},
    {type:'void_marine', tx:73, tz:46},
    {type:'corrupted_xu', tx:69, tz:35},
    {type:'corrupted_xu', tx:80, tz:40},
    {type:'void_marine', tx:43, tz:71},
    {type:'void_marine', tx:35, tz:70},
    {type:'corrupted_xu', tx:43, tz:77},
    {type:'corrupted_xu', tx:37, tz:75},
    {type:'cyber_ogre', tx:39, tz:80},
    {type:'cyber_ogre', tx:32, tz:65},
    {type:'void_marine', tx:44, tz:74},
    {type:'void_marine', tx:40, tz:65},
    {type:'corrupted_xu', tx:35, tz:77},
    {type:'corrupted_xu', tx:46, tz:67},
    {type:'void_marine', tx:189, tz:48},
    {type:'void_marine', tx:195, tz:47},
    {type:'corrupted_xu', tx:187, tz:55},
    {type:'corrupted_xu', tx:195, tz:52},
    {type:'cyber_ogre', tx:185, tz:41},
    {type:'cyber_ogre', tx:187, tz:43},
    {type:'void_marine', tx:195, tz:45},
    {type:'void_marine', tx:184, tz:42},
    {type:'corrupted_xu', tx:195, tz:50},
    {type:'corrupted_xu', tx:189, tz:45},
    {type:'void_marine', tx:173, tz:35},
    {type:'void_marine', tx:169, tz:47},
    {type:'corrupted_xu', tx:164, tz:35},
    {type:'corrupted_xu', tx:166, tz:36},
    {type:'cyber_ogre', tx:176, tz:34},
    {type:'cyber_ogre', tx:165, tz:43},
    {type:'void_marine', tx:164, tz:40},
    {type:'void_marine', tx:174, tz:40},
    {type:'corrupted_xu', tx:171, tz:46},
    {type:'corrupted_xu', tx:174, tz:41},
    {type:'void_marine', tx:192, tz:64},
    {type:'void_marine', tx:208, tz:65},
    {type:'corrupted_xu', tx:194, tz:66},
    {type:'corrupted_xu', tx:195, tz:72},
    {type:'cyber_ogre', tx:197, tz:80},
    {type:'cyber_ogre', tx:206, tz:71},
    {type:'void_marine', tx:203, tz:70},
    {type:'void_marine', tx:207, tz:66},
    {type:'corrupted_xu', tx:192, tz:76},
    {type:'corrupted_xu', tx:204, tz:67},
    {type:'void_marine', tx:44, tz:186},
    {type:'void_marine', tx:40, tz:190},
    {type:'corrupted_xu', tx:56, tz:187},
    {type:'corrupted_xu', tx:56, tz:186},
    {type:'cyber_ogre', tx:56, tz:196},
    {type:'cyber_ogre', tx:50, tz:196},
    {type:'void_marine', tx:56, tz:188},
    {type:'void_marine', tx:55, tz:198},
    {type:'corrupted_xu', tx:50, tz:194},
    {type:'corrupted_xu', tx:44, tz:187},
    {type:'void_marine', tx:79, tz:200},
    {type:'void_marine', tx:69, tz:194},
    {type:'corrupted_xu', tx:77, tz:197},
    {type:'corrupted_xu', tx:77, tz:204},
    {type:'void_marine', tx:75, tz:207},
    {type:'void_marine', tx:79, tz:207},
    {type:'corrupted_xu', tx:66, tz:207},
    {type:'corrupted_xu', tx:73, tz:196},
    {type:'void_marine', tx:48, tz:170},
    {type:'void_marine', tx:48, tz:160},
    {type:'corrupted_xu', tx:38, tz:163},
    {type:'corrupted_xu', tx:41, tz:163},
    {type:'void_marine', tx:35, tz:163},
    {type:'void_marine', tx:42, tz:163},
    {type:'corrupted_xu', tx:47, tz:168},
    {type:'corrupted_xu', tx:41, tz:175},
    {type:'void_marine', tx:193, tz:186},
    {type:'void_marine', tx:190, tz:192},
    {type:'corrupted_xu', tx:197, tz:198},
    {type:'corrupted_xu', tx:194, tz:196},
    {type:'void_marine', tx:188, tz:184},
    {type:'void_marine', tx:188, tz:194},
    {type:'corrupted_xu', tx:186, tz:198},
    {type:'corrupted_xu', tx:184, tz:193},
    {type:'void_marine', tx:168, tz:203},
    {type:'void_marine', tx:161, tz:202},
    {type:'corrupted_xu', tx:176, tz:205},
    {type:'corrupted_xu', tx:161, tz:199},
    {type:'void_marine', tx:169, tz:195},
    {type:'void_marine', tx:168, tz:205},
    {type:'corrupted_xu', tx:176, tz:206},
    {type:'corrupted_xu', tx:168, tz:208},
    {type:'corrupted_xu', tx:204, tz:163},
    {type:'corrupted_xu', tx:202, tz:165},
    {type:'corrupted_xu', tx:204, tz:164},
    {type:'corrupted_xu', tx:207, tz:163},
    {type:'corrupted_xu', tx:120, tz:46},
    {type:'corrupted_xu', tx:116, tz:48},
    {type:'corrupted_xu', tx:112, tz:59},
    {type:'corrupted_xu', tx:118, tz:55},
    {type:'corrupted_xu', tx:124, tz:186},
    {type:'corrupted_xu', tx:113, tz:191},
    {type:'corrupted_xu', tx:122, tz:187},
    {type:'corrupted_xu', tx:112, tz:185},
    {type:'corrupted_xu', tx:61, tz:124},
    {type:'corrupted_xu', tx:53, tz:127},
    {type:'corrupted_xu', tx:62, tz:128},
    {type:'corrupted_xu', tx:59, tz:118},
    {type:'corrupted_xu', tx:179, tz:124},
    {type:'corrupted_xu', tx:183, tz:120},
    {type:'corrupted_xu', tx:192, tz:125},
    {type:'corrupted_xu', tx:180, tz:128},
    {type:'holo_wraith', tx:136, tz:153},
    {type:'shard_assassin', tx:134, tz:41},
    {type:'holo_wraith', tx:135, tz:203},
    {type:'holo_wraith', tx:138, tz:166},
    {type:'shard_assassin', tx:41, tz:70},
    {type:'holo_wraith', tx:58, tz:171},
    {type:'holo_wraith', tx:200, tz:106},
    {type:'shard_assassin', tx:217, tz:149},
    {type:'holo_wraith', tx:100, tz:212},
    {type:'holo_wraith', tx:122, tz:149},
    {type:'shard_assassin', tx:185, tz:140},
    {type:'holo_wraith', tx:28, tz:26},
    {type:'holo_wraith', tx:218, tz:74},
    {type:'shard_assassin', tx:156, tz:215},
    {type:'holo_wraith', tx:215, tz:204},
    {type:'holo_wraith', tx:150, tz:70},
    {type:'shard_assassin', tx:28, tz:153},
    {type:'holo_wraith', tx:170, tz:212},
    {type:'holo_wraith', tx:219, tz:92},
    {type:'shard_assassin', tx:92, tz:84},
    {type:'holo_wraith', tx:21, tz:58},
    {type:'holo_wraith', tx:220, tz:212},
    {type:'shard_assassin', tx:88, tz:42},
    {type:'holo_wraith', tx:58, tz:25},
    {type:'holo_wraith', tx:23, tz:168},
    {type:'shard_assassin', tx:92, tz:20},
    {type:'holo_wraith', tx:43, tz:100},
    {type:'holo_wraith', tx:89, tz:68},
    {type:'shard_assassin', tx:84, tz:168},
    {type:'holo_wraith', tx:187, tz:217},
    {type:'holo_wraith', tx:216, tz:24},
    {type:'shard_assassin', tx:154, tz:107},
    {type:'holo_wraith', tx:214, tz:54},
    {type:'holo_wraith', tx:72, tz:172},
    {type:'shard_assassin', tx:91, tz:122},
    {type:'holo_wraith', tx:154, tz:88},
    {type:'holo_wraith', tx:196, tz:216},
    {type:'shard_assassin', tx:20, tz:88},
    {type:'holo_wraith', tx:171, tz:90},
    {type:'holo_wraith', tx:213, tz:104},
    {type:'shard_assassin', tx:151, tz:139},
    {type:'holo_wraith', tx:187, tz:53},
    {type:'holo_wraith', tx:213, tz:118},
    {type:'shard_assassin', tx:57, tz:200},
    {type:'holo_wraith', tx:196, tz:138},
    {type:'holo_wraith', tx:132, tz:90},
    {type:'shard_assassin', tx:104, tz:87},
    {type:'holo_wraith', tx:202, tz:186},
    {type:'holo_wraith', tx:152, tz:149},
    {type:'shard_assassin', tx:152, tz:187},
    {type:'holo_wraith', tx:88, tz:215},
    {type:'holo_wraith', tx:71, tz:119},
    {type:'shard_assassin', tx:218, tz:171},
    {type:'holo_wraith', tx:59, tz:54}
  ],
  // ── v93.0 phase 3 — THE CONVERGENCE ──
  // Empty array marker. createZoneEnemies() special-cases 'convergence' and
  // generates ~100 procedural spawns at game-create time via generateConvergenceSpawns().
  convergence: [],
  // ── a220 — THE REACH — 5 elite "mini-boss" mobs spread across the regions,
  //   plus a few duplicates so the zone isn't empty after a kill. Kept clear of
  //   the apex boss arena (~22 tiles of 120,78).
  the_reach: [
    // a223 — ~20 elite spawns spread across all regions. Clear of the apex boss
    //   arena (~18 tiles of 120,78) and the west spawn lane (~30,120). One Omega
    //   Observer (the "ultimate" — strongest, so only one).
    // West — The Expanse
    {tx:48,tz:120, type:'void_cube_warden'},  {tx:55,tz:95,  type:'cubic_annihilator'},
    {tx:40,tz:150, type:'sphere_disruptor'},  {tx:65,tz:135, type:'harbinger_sphere'},
    // NW — The Fallen Spheres
    {tx:60,tz:55,  type:'sphere_disruptor'},  {tx:85,tz:45,  type:'void_cube_warden'},
    {tx:45,tz:40,  type:'harbinger_sphere'},
    // N — mid-north
    {tx:115,tz:35, type:'cubic_annihilator'}, {tx:150,tz:50, type:'sphere_disruptor'},
    // E — The Overgrowth
    {tx:175,tz:90, type:'harbinger_sphere'},  {tx:200,tz:70, type:'void_cube_warden'},
    {tx:195,tz:120,type:'sphere_disruptor'},  {tx:215,tz:150,type:'cubic_annihilator'},
    // S — The Collapse
    {tx:115,tz:170,type:'cubic_annihilator'}, {tx:90,tz:185, type:'harbinger_sphere'},
    {tx:150,tz:180,type:'void_cube_warden'},
    // SE — deep end (the ultimate watcher)
    {tx:185,tz:160,type:'omega_observer'},    {tx:205,tz:195,type:'harbinger_sphere'},
    // mid-fill
    {tx:95,tz:140, type:'sphere_disruptor'},  {tx:160,tz:135,type:'cubic_annihilator'},
    {tx:70,tz:75,  type:'void_cube_warden'},
  ],
  // a554 — LUCIDWILDE is now SERVER-AUTHORITATIVE (was deliberately client-side since
  //   a299, which is why this zone had no ZONE_SPAWNS entry at all until now).
  //   52 spawns lifted verbatim from the client's enemySpawns in 80_zone_defs.part.
  //   ENEMY_STATS for all three types was resynced in the same patch — see the note there.
  lucidwilde: [
    {type:'prismaraptor', tx:108, tz:204},
    {type:'prismaraptor', tx:132, tz:204},
    {type:'vortexwisp', tx:120, tz:200},
    {type:'sporegon', tx:96, tz:198},
    {type:'sporegon', tx:144, tz:198},
    {type:'prismaraptor', tx:120, tz:194},
    {type:'prismaraptor', tx:82, tz:190},
    {type:'vortexwisp', tx:158, tz:190},
    {type:'vortexwisp', tx:104, tz:188},
    {type:'prismaraptor', tx:136, tz:188},
    {type:'sporegon', tx:66, tz:182},
    {type:'sporegon', tx:174, tz:182},
    {type:'prismaraptor', tx:120, tz:178},
    {type:'prismaraptor', tx:90, tz:174},
    {type:'vortexwisp', tx:150, tz:174},
    {type:'sporegon', tx:108, tz:170},
    {type:'prismaraptor', tx:132, tz:170},
    {type:'vortexwisp', tx:72, tz:164},
    {type:'prismaraptor', tx:168, tz:164},
    {type:'vortexwisp', tx:120, tz:162},
    {type:'prismaraptor', tx:88, tz:158},
    {type:'sporegon', tx:152, tz:158},
    {type:'prismaraptor', tx:104, tz:156},
    {type:'vortexwisp', tx:136, tz:156},
    {type:'sporegon', tx:70, tz:140},
    {type:'sporegon', tx:170, tz:140},
    {type:'prismaraptor', tx:120, tz:142},
    {type:'prismaraptor', tx:92, tz:136},
    {type:'vortexwisp', tx:148, tz:136},
    {type:'vortexwisp', tx:108, tz:134},
    {type:'prismaraptor', tx:132, tz:134},
    {type:'prismaraptor', tx:78, tz:128},
    {type:'prismaraptor', tx:162, tz:128},
    {type:'sporegon', tx:120, tz:130},
    {type:'vortexwisp', tx:96, tz:124},
    {type:'vortexwisp', tx:144, tz:124},
    {type:'prismaraptor', tx:108, tz:122},
    {type:'prismaraptor', tx:132, tz:122},
    {type:'sporegon', tx:84, tz:118},
    {type:'sporegon', tx:156, tz:118},
    {type:'prismaraptor', tx:100, tz:128},
    {type:'vortexwisp', tx:140, tz:128},
    {type:'prismaraptor', tx:36, tz:120},
    {type:'prismaraptor', tx:204, tz:120},
    {type:'vortexwisp', tx:36, tz:170},
    {type:'vortexwisp', tx:204, tz:170},
    {type:'sporegon', tx:200, tz:200},
    {type:'prismaraptor', tx:60, tz:210},
    {type:'prismaraptor', tx:180, tz:210},
    {type:'sporegon', tx:120, tz:150},
    {type:'vortexwisp', tx:110, tz:160},
    {type:'vortexwisp', tx:130, tz:160}
  ],
  // a332 — XULCAN PRIME mobs are likewise CLIENT-AUTHORITATIVE (bespoke Xu Dominion AI
  //   + abilities run client-side). No ZONE_SPAWNS entry on purpose: the server sends an
  //   empty xulcan snapshot and the client spawns + owns the five Xu units. (The boss
  //   XU ZET-HORAK will become server-authoritative when added — ZONE_BOSS_HP.xulcan.)
  // a537 — AVIA CANYON birds are now SERVER-AUTHORITATIVE (ZONE_SPAWNS.aviacanyon + maze
  //   collision via _aviaWalkable). The XUBERRY boss remains server-authoritative (ZONE_BOSS_HP.aviacanyon).
  // a555 — THE FORGE is now SERVER-AUTHORITATIVE (was deliberately client-side since a361,
  //   which is why this zone had no ZONE_SPAWNS entry). 31 spawns lifted verbatim from the
  //   client's enemySpawns. ENEMY_STATS entries for all four types were ADDED in the same
  //   patch — they did not exist at all. See the note there.
  forge: [
    {type:'molten_crawler', tx:108, tz:214},
    {type:'molten_crawler', tx:132, tz:214},
    {type:'molten_crawler', tx:70, tz:172},
    {type:'molten_crawler', tx:90, tz:172},
    {type:'molten_crawler', tx:150, tz:172},
    {type:'molten_crawler', tx:170, tz:172},
    {type:'lava_forged_sentinel', tx:60, tz:172},
    {type:'forge_technician', tx:182, tz:172},
    {type:'molten_crawler', tx:118, tz:190},
    {type:'lava_forged_sentinel', tx:122, tz:184},
    {type:'forge_technician', tx:60, tz:122},
    {type:'molten_crawler', tx:92, tz:122},
    {type:'molten_crawler', tx:150, tz:122},
    {type:'industrial_devastator', tx:182, tz:122},
    {type:'forge_technician', tx:118, tz:122},
    {type:'industrial_devastator', tx:120, tz:150},
    {type:'molten_crawler', tx:114, tz:144},
    {type:'molten_crawler', tx:126, tz:144},
    {type:'lava_forged_sentinel', tx:60, tz:88},
    {type:'molten_crawler', tx:92, tz:88},
    {type:'lava_forged_sentinel', tx:150, tz:88},
    {type:'industrial_devastator', tx:182, tz:88},
    {type:'forge_technician', tx:118, tz:88},
    {type:'lava_forged_sentinel', tx:120, tz:78},
    {type:'molten_crawler', tx:114, tz:72},
    {type:'molten_crawler', tx:126, tz:72},
    {type:'industrial_devastator', tx:106, tz:64},
    {type:'industrial_devastator', tx:134, tz:64},
    {type:'lava_forged_sentinel', tx:114, tz:63},
    {type:'lava_forged_sentinel', tx:126, tz:63},
    {type:'forge_technician', tx:120, tz:66}
  ],
};
;

// ══════════════════════════════════════════════════════════
// GAME ZONE STATE
// Each game has zones. Each zone has enemies[].
// ══════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════
// v93.0 Phase 3 — Convergence procedural enemy generator
// Mirrors the client-side BSP logic conceptually but doesn't need exact layout
// match — server enemies are positioned by AREA buckets across the 240x240 zone,
// in a "spread evenly + cluster in chambers" pattern. Client sees BSP rooms;
// server places enemies in those general areas. Close enough that combat feels
// coherent (you walk into a chamber and there's enemies there).
//
// Pool: 8 broken-reality types matching the client side.
// Density: ~80 enemies across the 240x240 zone (excluding the 60-tile spawn buffer).
// ══════════════════════════════════════════════════════════
// a197 — Per-depth enemy pools (server side, mirrors the client _CONV_ENEMY_POOLS).
// Each Convergence depth gets its own mob set. Depth 1 = the original
// "broken reality" Xu-tier mix. Depth 2 = the CINDER depth (matches the red
// walls) — a fire/ash roster. All types must exist in ENEMY_STATS above.
// Any depth without an explicit pool falls back to Depth 1's.
const CONV_ENEMY_POOLS = {
  1: ['corrupted_xu', 'void_marine', 'holo_wraith', 'ash_wraith'],
  2: ['fire_demon', 'inferno_golem', 'lava_golem', 'magma_crab', 'ash_wraith'],
  3: ['arc_sentinel', 'tesla_golem', 'storm_wraith', 'volt_hound'],  // a209 — electric (no newbie mobs)
  4: ['saurian_brute', 'geo_basilisk', 'cube_drake', 'raptor_shard'],  // a211 — reptilian/geometric (no newbie mobs)
  5: ['sentry_mech', 'hunter_drone', 'plasma_bot', 'cube_sentinel'],  // a212 — technology (no newbie mobs)
  6: ['thorn_brute', 'spore_fiend', 'vine_lasher', 'bloom_wisp'],  // a215 — nature (no newbie mobs)
};

// a206 — Bofis: a "newbie" mob population existed at ALL depths of the
//   Convergence — basically free kills. Cause: three pool members carry their
//   ORIGINAL low-tier HP from their home zones — ash_wraith (2200, in BOTH
//   depth pools = every depth), lava_golem (2200) and magma_crab (2400, depth 2)
//   — vs pool-mates at 36k-95k. After the x2 convergence scale they were only
//   ~4-5k HP, one-shot by a Lv100 player. We must NOT raise their global
//   ENEMY_STATS HP (they appear at appropriate levels in dragonlair/ashlands).
//   Instead, floor the BASE hp used for convergence spawns to the pool tier
//   (40k, in line with holo_wraith/fire_demon — the low end of the intended
//   tier) BEFORE the convergence scale/depth multipliers apply, so they end up
//   on par with the rest of the pool and still scale identically.
const CONV_MIN_BASE_HP = 40000;
function convBaseHp(type, rawHp){
  return Math.max(rawHp, CONV_MIN_BASE_HP);
}

function generateConvergenceSpawns(depth) {
  // v93.0-a18 — Pool restricted to Xu-tier (48k-95k HP) + ash_wraith (2200 HP tier).
  // Previous pool included crawler (210 HP), elite (540), wraith (480), void_eye (390),
  // which a Lv 100 player 1-shots — completely defeating the endgame difficulty.
  // ash_wraith stays as the lower-tier variety (still meaningful at 4400 HP after 2x scale).
  // a197 — pool is now depth-aware.
  const _d = Math.max(1, parseInt(depth, 10) || 1);
  const POOL = CONV_ENEMY_POOLS[_d] || CONV_ENEMY_POOLS[1];
  const spawns = [];
  const W = 240;
  const SPAWN_BUFFER_Z = 60; // no enemies in the top 60 tiles (spawn chamber + breathing room)

  // Place enemies in clusters spread across the zone south of the spawn buffer.
  // Use a coarse grid: divide the playable area into ~24x24 chunks and place
  // 3-5 enemies in each chunk at random offsets. ~9x9 = 81 chunks south of buffer.
  const CHUNK = 24;
  for (let cz = SPAWN_BUFFER_Z; cz < W - CHUNK; cz += CHUNK) {
    for (let cx = CHUNK; cx < W - CHUNK; cx += CHUNK) {
      // Some chunks left empty for variety (~25% skip rate)
      if (Math.random() < 0.25) continue;
      const count = 3 + Math.floor(Math.random() * 3); // 3-5
      for (let n = 0; n < count; n++) {
        const ex = cx + 4 + Math.floor(Math.random() * (CHUNK - 8));
        const ez = cz + 4 + Math.floor(Math.random() * (CHUNK - 8));
        const etype = POOL[Math.floor(Math.random() * POOL.length)];
        spawns.push({tx: ex, tz: ez, type: etype});
      }
    }
  }
  console.log(`[convergence] Generated ${spawns.length} enemy spawns across 240x240 zone`);
  return spawns;
}

// a528 — per-zone HP multiplier (HP ONLY — atk/reward/expR untouched). Lets a zone
//   feel dangerous for its level band without inflating damage or loot. The sand worm
//   is already the tankiest, so its buff is scaled down so it doesn't become a slog.
const ZONE_HP_MULT = { sunken_sands: 6, void: 1.15, blooming_wilds: 1.2, cemetery: 1.8, ashlands: 1.5, citadel: 1.6, frostveil: 6.0, ancient: 7.0, riftvale: 1.5 };   // a538 — cemetery mirrors the client's zone-local 1.8x undead bump (on top of ZONE_SCALE 1.4)
// a537 — AVIA CANYON walkable grid. The canyon maze is generated client-side from a
//   FIXED seed (10_core_setup _buildAviaCanyonTerrain, seed 30421987), so it's identical
//   every load. We embed the resulting 240x240 wall bitmap (bit=1 => wall) so the server
//   can collide birds against the cliffs exactly like the client's walkableR. Built by
//   the offline gen script (faithful port of the carve). See _aviaWalkable below.
const _AVIA_W = 240, _AVIA_TILE = 1.5;
const _aviaBits = Buffer.from('////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////HwAAAADw////////////////////////////////DwAAAADg////////////////////////////////BwAAAADA////////////////////////////////AwAAAACA////////////////////////////////AQAAAAAA////////////////////////////////AAAAAAAA/v////////////////8/AAAAAADADwAAAAAAAAAADAAAAAAA8APA//////8/AAAAAADADwAAAAAAAAAACAAAAAAA8APA//////8/AAAAAADADwAAAAAAAAAAAAAAAAAA8APA//////8/AAAAAADADwAAAAAAAAAAAAAAAAAA8APA//////8/AAAAAADADwAAAAAAAAAAAAAAAAAA8APA//////8/AAAAAADADwAAAAAAAAAAAAAAAAAA8APA//////8/AAAAAADADwAAAAAAAAAAAAAAAAAA8APA//////8/AAAAAADADwAAAAAAAAAAAAAAAAAA8APA//////8/AAAAAADADwAAAAAAAAAAAAAAAAAA8APA//////8/AAAAAADADwAAAAAAAAAAAAAAAAAA8APA//////8/AAAAAADADwAAAAAAAAAAAAAAAAAA8APA//////8/AAAAAADADwAAAAAAAAAAAAAAAAAA8APA//////8/APwA8APA//8BAAAAAAAAAAD///8A8APA//////8/APwA8APA//8BAAAAAAAAAAD///8A8APA//////8/APwA8APA//8BAAAAAAAAAAD///8A8APA//////8/APwA8APA//8AAAAAAAAAAAD///8A8APA//////8/APwA8APA//8AAAAAAAAAAAD///8A8APA//////8/APwA8APA//8AAAAAAAAAAAD///8A8APA//////8/AAAA8AMAAAAAAAAAAAAAAAA/APwA8APA//////8/AAAA8AMAAAAAAAAAAAAAAAA/APwA8APA//////8/AAAA8AMAAAAAAAAAAAAAAAA/APwA8APA//////8/AAAA8AMAAAAAAAAAAAAAAAA/APwA8APA//////8/AAAA8AMAAAAAAAAAAAAAAAA/APwA8APA//////8/AAAA8AMAAAAAAAAAAAAAAAA/APwA8APA//////8/AAAA8AMAAAAAAAAAAAAAAAA/APwA8APA//////8/AAAA8AMAAAAAAAAAAAAAAAA/APwA8APA//////8/AAAA8AMAAAABAAAAAAAAAAA/APwA8APA//////8/AAAA8AMAAAABAAAAAAAAAAA/APwA8APA//////8/AAAA8AMAAAABAAAAAAAAAAA/APwA8APA//////8/AAAA8AMAAAABAAAAAAAAAAA/APwA8APA//////////8A8P//DwADAAAAAAAAgP8/APwA8APA//////////8A8P//DwADAAAAAAAAgP8/APwA8APA//////////8A8P//DwADAAAAAAAAgP8/APwA8APA//////////8A8P//DwAHAAAAAAAAwP8/APwA8APA//////////8A8P//DwAHAAAAAAAAwP8/APwA8APA//////////8A8P//DwAPAAAAAAAA4P8/APwA8APA//////8/AAAAAAAAAAAPAAAAAAAAAAAAAPwAAADA//////8/AAAAAAAAAAAfAAAAAAAAAAAAAPwAAADA//////8/AAAAAAAAAAAfAAAAAAAAAAAAAPwAAADA//////8/AAAAAAAAAAA/AAAAAAAAAAAAAPwAAADA//////8/AAAAAAAAAAA/AAAAAAAAAAAAAPwAAADA//////8/AAAAAAAAAAA/AAAAAAAAAAAAAPwAAADA//////8/AAAAAAAAAAA/AAAAAAAAAAAAAPwAAADA//////8/AAAAAAAAAAA/AAAAAAAAAAAAAPwAAADA//////8/AAAAAAAAAAA/AAAAAAAAAAAAAPwAAADA//////8/AAAAAAAAAAA/AAAAAAAAAAAAAPwAAADA//////8/AAAAAAAAAAA/AAAAAAAAAAAAAPwAAADA//////8/AAAAAAAAAAA/AAAAAAAAAAAAAPwAAADA//////8/APz//wPADwA/AAAAAAD+DwA/APwA8APA//////8/APz//wPADwA/AAAAAID/DwA/APwA8APA//////8/APz//wPADwA/AAwAAOD/DwA/APwA8APA//////8/APz//wPADwA/AHwAAPz/DwA/APwA8APA//////8/APz//wPADwA/APwAgP//DwA/APwA8APA//////8/APz//wPADwA/APwAgP//DwA/APwA8APA//////8/APwA8APADwAAAPwAgAPADwA/APwA8APA//////8/APwA8APADwAAAPwAgAPADwA/APwA8APA//////8/APwA8APADwAAAPwAgAPADwA/APwA8APA//////8/APwA8APADwAAAPwAgAPADwA/APwA8APA//////8/APwA8APADwAAAPwAgAPADwA/APwA8APA//////8/APwA8APADwAAAPwAgAPADwA/APwA8APA//////8/APwA8APADwAAAPwAgAPADwA/APwA8APA//////8/APwA8APADwAAAPwAgAPADwA/APwA8APA//////8/APwA8APADwAAAPwAgAPADwA/APwA8APA//////8/APwA8APADwAAAPwAgAPADwA/APwA8APA//////8/APwA8APADwAAAPwAgAPADwA/APwA8APA//////8/APwA8APADwAAAPwAgAPADwA/APwA8APA//////8/APwA8APADwD///8AgAPADwD///8A8APA//////8/APwA8APADwD///8AgAPADwD///8A8APA//////8/APwA8APADwD///8AgAPADwD///8A8APA//////8/APwA8APADwD///8AgAPADwD///8A8APA//////8/APwA8APADwD///8AgAPADwD///8A8APA//////8/APwA8APADwD///8A8APADwD///8A8APA//////8/APwAAADADwA/AAAAAADADwAAAAAAAADA//////8/APwAAADADwA/AAAAAADADwAAAAAAAADA//////8/APwAAADADwA/AAAAAADADwAAAAAAAADA//////8/APwAAADADwA/AAAAAADADwAAAAAAAADA//////8/APwAAADADwA/AAAAAADADwAAAAAAAADA//////8/APwAAADADwA/AAAAAADADwAAAAAAAADA//////8/APwAAADADwA/AAAAAADADwAAAAAAAADA//////8/APwAAADADwA/AAAAAADADwAAAAAAAADA//////8/APwAAADADwA/AAAAAADADwAAAAAAAADA//////8/APwAAADADwA/AAAAAADADwAAAAAAAADA//////8/APwAAADADwA/AAAAAADADwAAAAAAAADA//////8/APwAAADADwA/AAAAAADADwAAAAAAAADA//////8/APz//wPADwD//////wPA//8/APwA8APA//////8/APz//wPADwD//////wPA//8/APwA8APA//////8/APz//wPADwD//////wPA//8/APwA8APA//////8/APz//wPADwD//////wPA//8/APwA8APA//////8/APz//wPADwD//////wPA//8/APwA8APA//////8/APz//wPADwD//////wPA//8/APwA8APA//////8/AAAA8APADwAAAPwAAAAAAAA/AAAA8APA//////8/AAAA8APADwAAAPwAAAAAAAA/AAAA8APA//////8/AAAA8APADwAAAPwAAAAAAAA/AAAA8APA//////8/AAAA8APADwAAAPwAAAAAAAA/AAAA8APA//////8/AAAA8APADwAAAPwAAAAAAAA/AAAA8APA//////8/AAAA8APADwAAAPwAAAAAAAA/AAAA8APA//////8/AAAA8APADwAAAPwAAAAAAAA/AAAA8APA//////8/AAAA8APADwAAAPwAAAAAAAA/AAAA8APA//////8/AAAA8APADwAAAPwAAAAAAAA/AAAA8APA//////8/AAAA8APADwAAAPwAAAAAAAA/AAAA8APA//////8/AAAA8APADwAAAPwAAAAAAAA/AAAA8APA//////8/AAAA8APADwAAAPwAAAAAAAA/AAAA8APA//////8/APwA8APA//8/APwA8P////8/APwA8APA//////8/APwA8APA//8/APwA8P////8/APwA8APA//////8/APwA8APA//8/APwA8P////8/APwA8APA//////8/APwA8APA//8/APwA8P////8/APwA8APA//////8/APwA8APA//8/APwA8P////8/APwA8APA//////8/APwA8APA//8/APwA8P////8/APwA8APA//////8/AAAAAAAAAAA/APwAAAAAAAA/APwAAADA//////8/AAAAAAAAAAA/APwAAAAAAAA/APwAAADA//////8/AAAAAAAAAAA/APwAAAAAAAA/APwAAADA//////8/AAAAAAAAAAA/APwAAAAAAAA/APwAAADA//////8/AAAAAAAAAAA/APwAAAAAAAA/APwAAADA//////8/AAAAAAAAAAA/APwAAAAAAAA/APwAAADA//////8/AAAAAAAAAAA/APwAAAAAAAA/APwAAADA//////8/AAAAAAAAAAA/APwAAAAAAAA/APwAAADA//////8/AAAAAAAAAAA/APwAAAAAAAA/APwAAADA//////8/AAAAAAAAAAA/APwAAAAAAAA/APwAAADA//////8/AAAAAAAAAAA/APwAAAAAAAA/APwAAADA//////8/AAAAAAAAAAA/APwAAAAAAAA/APwAAADA//////////8A8P//DwA/APwA8P//DwA/APwA8APA//////////8A8P//DwA/APwA8P//DwA/APwA8APA//////////8A8P//DwA/APwA8P//DwA/APwA8APA//////////8A8P//DwA/APwA8P//DwA/APwA8APA//////////8A8P//DwA/APwA8P//DwA/APwA8APA//////////8A8P//DwA/APwA8P//DwA/APwA8APA//////8/AAAA8AMAAAAAAPwA8AMAAAA/APwAAADA//////8/AAAA8AMAAAAAAPwA8AMAAAA/APwAAADA//////8/AAAA8AMAAAAAAPwA8AMAAAA/APwAAADA//////8/AAAA8AMAAAAAAPwA8AMAAAA/APwAAADA//////8/AAAA8AMAAAAAAPwA8AMAAAA/APwAAADA//////8/AAAA8AMAAAAAAPwA8AMAAAA/APwAAADA//////8/AAAA8AMAAAAAAPwA8AMAAAA/APwAAADA//////8/AAAA8AMAAAAAAPwA8AMAAAA/APwAAADA//////8/AAAA8AMAAAAAAPwA8AMAAAA/APwAAADA//////8/AAAA8AMAAAAAAPwA8AMAAAA/APwAAADA//////8/AAAA8AMAAAAAAPwA8AMAAAA/APwAAADA//////8/AAAA8AMAAAAAAPwA8AMAAAA/APwAAADA//////8/APwA8P////////8A8APA//8/APz//wPA//////8/APwA8P////////8A8APA//8/APz//wPA//////8/APwA8P////////8A8APA//8/APz//wPA//////8/APwA8P////////8A8APA//8/APz//wPA//////8/APwA8P////////8A8APA//8/APz//wPA//////8/APwA8P////////8A8APA//8/APz//wPA//////8/AAAA8AMAAAAAAAAAAADADwAAAAAAAADA//////8/AAAA8AMAAAAAAAAAAADADwAAAAAAAADA//////8/AAAA8AMAAAAAAAAAAADADwAAAAAAAADA//////8/AAAA8AMAAAAAAAAAAADADwAAAAAAAADA//////8/AAAA8AMAAAAAAAAAAADADwAAAAAAAADA//////8/AAAA8AMAAAAAAAAAAADADwAAAAAAAADA//////8/AAAA8AMAAAAAAAAAAADADwAAAAAAAADA//////8/AAAA8AMAAAAAAAAAAADADwAAAAAAAADA//////8/AAAA8AMAAAAAAAAAAADADwAAAAAAAADA//////8/AAAA8AMAAAAAAAAAAADADwAAAAAAAADA//////8/AAAA8AMAAAAAAAAAAADADwAAAAAAAADA//////8/AAAA8AMAAAAAAAAAAADADwAAAAAAAADA//////8/APz//wPADwD//////wPADwA/APwA8APA//////8/APz//wPADwD//////wPADwA/APwA8APA//////8/APz//wPADwD//////wPADwA/APwA8APA//////8/APz//wPADwD//////wPADwA/APwA8APA//////8/APz//wPADwD//////wPADwA/APwA8APA//////8/APz//wPADwD//////wPADwA/APwA8APA//////8/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAADA//////8/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAADA//////8/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAADA//////8/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAADA//////8/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAADA//////8/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAADA//////8/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAADA//////8/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAADA//////8/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAADA//////8/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAADA//////8/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAADA//////8/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAADA//////////////////////8DgP////////////////////////////////////8DgP////////////////////////////////////8DgP////////////////////////////////////8DgP////////////////////////////////////8DgP////////////////////////////////////8DgP////////////////////////////////////8DgP////////////////////////////////////8DgP////////////////////////////////////8DgP////////////////////////////////////8DgP////////////////////////////////////8DgP////////////////////////////////////8DgP////////////////////////////////////8DgP////////////////////////////////////8DgP////////////////////////////////////8DgP////////////////////////////////////8DgP////////////////////////////////////8DgP////////////////////////////////////8DgP////////////////////////////////////8DgP////////////////////////////////////8DgP////////////////////////////////////8DgP////////////////////////////////////8DgP////////////////////////////////////8DgP////////////////////////////////////8DgP////////////////////////////////////8DgP////////////////////////////////////8DgP////////////////////////////////////8DgP////////////////////////////////////8DgP////////////////////////////////////8DgP////////////////////////////////////8DgP////////////////////////////////////8DgP////////////////////////////////////8DgP////////////////////////////////////8DgP////////////////////////////////////8DgP////////////////////////////////////8DgP////////////////////////////////////8DgP////////////////////////////////////8DgP////////////////////////////////////8DgP////////////////////////////////////8DgP////////////////////////////////////8DgP////////////////////////////////////8DgP////////////////////////////////////8DgP////////////////////////////////////8DgP////////////////////////////////////8DgP//////////////////', 'base64');
function _aviaWall(tx, tz){ if(tx<0||tz<0||tx>=_AVIA_W||tz>=_AVIA_W) return true; const idx=tz*_AVIA_W+tx; return (_aviaBits[idx>>3] & (1<<(idx&7)))!==0; }
function _aviaWalkable(wx, wz, r){ r=r||0.3;
  return !_aviaWall(((wx-r)/_AVIA_TILE)|0, ((wz-r)/_AVIA_TILE)|0)
      && !_aviaWall(((wx+r)/_AVIA_TILE)|0, ((wz-r)/_AVIA_TILE)|0)
      && !_aviaWall(((wx-r)/_AVIA_TILE)|0, ((wz+r)/_AVIA_TILE)|0)
      && !_aviaWall(((wx+r)/_AVIA_TILE)|0, ((wz+r)/_AVIA_TILE)|0); }
// a532 — per-zone-per-type HP override. void_sentinel/void_construct carry boss-tier HP
//   that is correct for VOID CITADEL but far too tanky for the lvl15-28 VOID WASTES where
//   they also spawn. Scope a zone-appropriate HP to Void Wastes only (base stats untouched,
//   so the Citadel versions keep their heavy HP). Their damage already uses VW_PWR, not atk.
// a553 — VOID CITADEL entries added. These four types share one stat table across three
//   zones, and each zone needs a different tier of them: Void Wastes wants them weak
//   (the entries above), Rift Vale takes the base stats via ZONE_HP_MULT, and the Citadel
//   wants them heavy. The client kit applied the Citadel's own boost inside _tickVcMob —
//   gated by _isVcMob precisely so the globals wouldn't inflate the other two zones — and
//   the server has to honour the same scoping now that it owns the spawns. The figures
//   below are the client kit's multipliers (7x/6x/8x/12x) resolved against base stats,
//   and match its own stated results exactly.
const ZONE_TYPE_HP = {
  void:         { void_sentinel: 4500,   void_construct: 3600 },
  void_citadel: { void_construct: 224000, void_sentinel: 264000, rift_stalker: 192000, rift_weaver: 180000 },
};
function createZoneEnemies(zoneName) {
  // v93.0 phase 3 — special-case convergence: generate spawns procedurally
  // per game-instance instead of using the static ZONE_SPAWNS entry.
  const spawns = (zoneName === 'convergence')
    ? generateConvergenceSpawns()
    : (ZONE_SPAWNS[zoneName] || []);
  const scale  = ZONE_SCALE[zoneName]  || 1.0;
  return spawns.map((s, i) => {
    const st = ENEMY_STATS[s.type] || ENEMY_STATS.soldier;
    // a206 — convergence under-tier HP floor (see convBaseHp). Only convergence.
    const _ovHp = ZONE_TYPE_HP[zoneName] && ZONE_TYPE_HP[zoneName][s.type];
    const _baseHp = _ovHp || ((zoneName === 'convergence') ? convBaseHp(s.type, st.hp) : st.hp);
    const _hpMul = (ZONE_HP_MULT[zoneName] || 1) * (s.type === 'sand_worm' ? 0.6 : 1); // a528
    return {
      id: i,
      type: s.type,
      x: s.tx * TILE,
      z: s.tz * TILE,
      spawnX: s.tx * TILE,
      spawnZ: s.tz * TILE,
      hp: Math.round(_baseHp * scale * _hpMul),
      maxHp: Math.round(_baseHp * scale * _hpMul),
      atk: Math.round(st.atk * scale),
      spd: st.spd,
      aggroRange: st.aggroRange,
      reward: Math.round(st.reward * scale),
      expR: Math.round(st.expR * scale),
      dmgReduction: st.dmgReduction || 0,
      active: true,
      aggroed: false,
      attackTimer: Math.floor(Math.random() * 60),
      respawnTimer: 0,
    };
  });
}

function getOrCreateZone(game, zoneName) {
  if (!game.zones[zoneName]) {
    game.zones[zoneName] = {
      enemies: createZoneEnemies(zoneName),
      lastActivity: Date.now(),
      // v93.0 phase 3.3 — Convergence-specific depth tracking
      convergenceDepth: zoneName === 'convergence' ? 1 : undefined,
      // a233 — CO-OP: server-authoritative run seed for the procedural zones
      //   (Convergence + The Reach). The client BSP layout is deterministic on
      //   this seed; every player in the game must build the SAME map, so the
      //   seed is owned by the server and handed to each player on entry. Without
      //   this each client used its own Date.now() seed and got a different map —
      //   players literally standing in each other's walls. The_reach is a fixed
      //   layout but we still carry a seed for parity / future use.
      runSeed: (zoneName === 'convergence' || zoneName === 'the_reach')
        ? ((Date.now() ^ (Math.random()*0x7fffffff)) & 0x7fffffff)
        : undefined,
      activeModIds: (zoneName === 'convergence') ? [] : undefined,
      // v93.0-a116 -- ALSO populate boss field. Previously this function created
      // zones WITHOUT a boss, so any game that didn\'t go through the create_game
      // path (e.g. join_game or any indirect zone init) had zone.boss=undefined.
      // sv_hit_boss then hit "if (!zone.boss) break;" and silently dropped hits.
      // Symptom: client renders boss + sends hits, server never responds with
      // sv_boss_hp updates, boss bar stays at 100% forever -> "immortal boss."
      boss: ZONE_BOSS_HP[zoneName] ? {
        hp: ZONE_BOSS_HP[zoneName].hp,
        maxHp: ZONE_BOSS_HP[zoneName].hp,
        phase: 1,
        spawned: false,
        name: ZONE_BOSS_HP[zoneName].name,
      } : null,
    };
  }
  return game.zones[zoneName];
}

// a233 — CO-OP run-state broadcast. Tells every client the authoritative seed +
//   depth + modifiers for a procedural zone so they all build the identical map
//   and share the same depth/boss. Sent to one ws (on entry) or whole zone (on
//   depth change / first descent).
function buildRunState(zone, zoneName) {
  return {
    type: 'sv_run_state',
    zone: zoneName,
    seed: zone.runSeed || 1,
    depth: (zoneName === 'convergence') ? (zone.convergenceDepth || 1) : 1,
    modIds: (zone.activeModIds || []),
  };
}

// ══════════════════════════════════════════════════════════
// SEND HELPERS
// ══════════════════════════════════════════════════════════

function send(ws, data) {
  if (ws.readyState === 1) ws.send(JSON.stringify(data));
}

function broadcastToGame(gameId, data, exclude = null) {
  const msg = JSON.stringify(data);
  players.forEach((p, ws) => {
    if (p.gameId === gameId && ws !== exclude && ws.readyState === 1) {
      ws.send(msg);
    }
  });
}

function broadcastToZone(gameId, zone, data, exclude = null) {
  const msg = JSON.stringify(data);
  players.forEach((p, ws) => {
    if (p.gameId === gameId && p.zone === zone && ws !== exclude && ws.readyState === 1) {
      ws.send(msg);
    }
  });
}

function getPlayersInZone(gameId, zone) {
  const result = [];
  players.forEach((p, ws) => {
    if (p.gameId === gameId && p.zone === zone && p.x !== undefined) result.push(p);
  });
  return result;
}

// ══════════════════════════════════════════════════════════
// ENEMY AI TICK
// Runs at 10Hz for all active game zones
// ══════════════════════════════════════════════════════════

const ATTACK_COOLDOWN = 60; // frames at 10Hz = 6 seconds... adjusted to ticks
const ATTACK_RANGE   = 2.5;
const RESPAWN_TICKS  = 300; // 30 seconds at 10Hz

// ──────────────────────────────────────────────────────────
// a146 — WORLD BOSS HELPERS (server-authoritative)
// One active world boss per game. Multiple players can damage it; the server
// tracks every contributor by name + total damage dealt so loot can be awarded
// proportionally on kill.
// ──────────────────────────────────────────────────────────
function spawnWorldBoss(game, def) {
  if (!game || !def) return null;
  // If a world boss is already active, refuse
  if (game.worldBoss && game.worldBoss.spawned) return null;
  // Convert tx,tz tile coords to world coords (TILE constant from line ~293)
  const wx = def.tx * TILE;
  const wz = def.tz * TILE;
  game.worldBoss = {
    id: def.id,
    name: def.name,
    zone: def.zone,
    x: wx, z: wz,
    spawnX: wx, spawnZ: wz,
    hp: def.hp,
    maxHp: def.hp,
    atk: def.atk,
    atkCooldown: def.atkCooldown || 90,
    aggroRange: def.aggroRange || 22,
    color: def.color,
    lootTier: def.lootTier,
    phase: 1,
    spawned: true,
    attackTimer: 0,
    aggroed: false,
    contributors: {}, // name -> damage total
    spawnedAt: Date.now(),
    lastHitAt: Date.now(),
  };
  // Broadcast spawn to everyone in the game (not just the zone — it's an event)
  broadcastToGame(game.id, {
    type: 'sv_worldboss_spawned',
    id: def.id,
    name: def.name,
    zone: def.zone,
    x: +wx.toFixed(2),
    z: +wz.toFixed(2),
    hp: def.hp,
    maxHp: def.hp,
    color: def.color,
    lootTier: def.lootTier,
  });
  // Global announce
  broadcastToGame(game.id, {
    type: 'sv_world_announce',
    msg: `⚡ ${def.name} HAS APPEARED IN ${def.zone.replace(/_/g,' ').toUpperCase()}!`,
    zone: def.zone,
    worldBoss: true,
    bossName: def.name,
  });
  return game.worldBoss;
}

function despawnWorldBoss(game, killed, killerName, bx, bz) {
  if (!game || !game.worldBoss) return;
  const wb = game.worldBoss;
  // Mark dead and broadcast the outcome
  if (killed) {
    // Pick the top damage contributor as primary killer (already passed in as killerName
    // which is the player who landed the killing blow). All contributors get rewarded.
    const contribsList = Object.entries(wb.contributors || {})
      .sort((a, b) => b[1] - a[1])
      .map(([name, dmg]) => ({ name, dmg }));
    broadcastToGame(game.id, {
      type: 'sv_worldboss_killed',
      id: wb.id,
      name: wb.name,
      zone: wb.zone,
      killer: killerName,
      bx: bx || +wb.x.toFixed(2),
      bz: bz || +wb.z.toFixed(2),
      lootTier: wb.lootTier,
      contributors: contribsList,
    });
    broadcastToGame(game.id, {
      type: 'sv_world_announce',
      msg: `⚔ ${killerName} SLEW ${wb.name}!`,
      zone: wb.zone,
      worldBoss: true,
      bossName: wb.name,
      killer: killerName,
    });
    // Award guild XP to every contributor in proportion to damage
    const total = contribsList.reduce((s, c) => s + c.dmg, 0) || 1;
    contribsList.forEach(c => {
      const share = c.dmg / total;
      const xp = Math.max(50, Math.floor((wb.maxHp / 400) * share));
      awardGuildXp(c.name, xp);
    });
  } else {
    // Idle despawn / forced
    broadcastToGame(game.id, {
      type: 'sv_worldboss_despawn',
      id: wb.id,
      name: wb.name,
      zone: wb.zone,
      reason: killed ? 'killed' : 'idle',
    });
  }
  // Hold a cooldown before another world boss can be summoned
  game.worldBossLastDespawnAt = Date.now();
  game.worldBoss = null;
}

// Per-tick AI + broadcast for the current world boss in a game (called from tickGame)
// ════════════════════════════════════════════════════════════════════════════
// a548/a549 — SERVER-AUTHORITATIVE ZONE BOSSES.
//   Before a548, zone bosses shared only HP and phase (sv_hit_boss / sv_boss_hp /
//   sv_boss_phase). Position, attack SELECTION and damage were client-local, so in
//   co-op every player saw the boss standing somewhere different doing something
//   different. HP was the only thing the party agreed on.
//   a549 generalises the a548 spine: the common parts (nearest target, phase ladder,
//   march, telegraph, cadence, broadcast) live in tickZoneBoss, and each boss supplies
//   a config with its own ladder, cadences, attack picker and handlers. Adding the next
//   boss is now a config entry, not a new subsystem.
//   Damage rides the SAME battle-tested spine the migrated mobs use (_sdGeyser /
//   _sdSpawnProj / sv_enemy_attack); sv_enemy_attack ignores eid for damage, so the
//   sentinel id -1 is safe. AoE hits EVERY player in radius — the whole point of co-op.
//   Timings converted 60fps -> 10Hz (frame counters /6, per-frame speeds *6).
const ZBOSS_SERVER = {

  // ── CRYOTHAR (a548). Sequential 5-attack rotation.
  //    NOTE: 20_enemy_factory.part carries a SECOND, conflicting CRYOTHAR ladder
  //    (3 phases at .75/.50/.25). Both ran client-side and fought each other; the
  //    server settles it on the AI block's ladder. See the a548 changelog note.
  wyvernwastes: {
    x: 180, z: 180,                                   // tile (120,120) * TILE 1.5 — central ice arena
    spd:    [0, 0.016, 0.022, 0.028, 0.036, 0.044],
    dmg:    [0, 1.0,   1.5,   2.0,   2.8,   3.8],
    phases: [0.75, 0.50, 0.25, 0.10],
    acd:    [0, 20, 22, 19, 17, 15],                  // max(90,160-ph*15)/6
    tele:   11,                                       // 65 frames
    pick:   (b) => { b.atkIdx = (b.atkIdx || 0) + 1; return b.atkIdx % 5; },
    attack: (c) => {
      const { atk, b, mult, ang, nd, aoe, fx, proj, geyser } = c;
      if (atk === 0) { fx('cr_slam'); aoe(8.0, Math.floor(320 * mult)); }
      else if (atk === 1) { fx('cr_bite');
        if (nd < 4.5) aoe(4.5, Math.floor(240 * mult));
        else for (let i = 0; i < 3; i++) proj(ang + (i-1)*0.4, 0xcc4400, Math.floor(180 * mult), 'plasma'); }
      else if (atk === 2) { fx('cr_coil');
        // NOTE: the client scaled Coil Crush's PARTICLES by the phase multiplier but the
        // actual hit was (200 - r*15) UNSCALED. Preserved verbatim — see a548 changelog.
        [2,4,6].forEach((r,i) => geyser(b.x, b.z, 2 + i*2, r*1.5, Math.floor(200 - r*15), 0xff4400, { shake:3 })); }
      else if (atk === 3) { fx('cr_burst');
        for (let i = 0; i < 8; i++) proj(i/8*Math.PI*2, 0x88cc00, Math.floor(160 * mult), 'plasma'); }
      else { fx('cr_tremor'); aoe(10.0, Math.floor(260 * mult)); }
    },
    passive: (c) => {
      const { b, ph, mult, aoe, fx } = c;
      if (ph >= 2 && b._vt % 4 === 0)  { fx('cr_venom_cloud'); aoe(5.0, Math.floor(45 * mult)); }
      if (ph >= 4 && b._vt % 20 === 0) { fx('cr_tail');        aoe(7.0, Math.floor(200 * mult)); }
    },
  },







  // ── THE FURNACE CORE (a555). Three phases, no fixed rotation — a pool that grows and
  //    re-weights with phase, drawn at random. The client rolled that draw on each machine
  //    independently, so no two players saw the same ability.
  //    She is TETHERED to her socket: she tracks toward you but never leaves a 10-unit
  //    leash around home, so 'drift' and 'chase' both fit badly and the movement is done
  //    in passive() under 'hold'.
  //    Her signature is the WEAK POINT WINDOW — the core exposes on its own cycle and
  //    takes 1.6x damage, applied in sv_hit_boss above.
  forge: {
    x: 180, z: 60,                                     // tile (120,40) — the core-reactor arena
    spd:    [0,0,0,0],
    dmg:    [0, 1, 1, 1],
    phases: [0.70, 0.30],
    acd:    [0, 18, 14, 11],                           // 110 then max(54,130-P*22), / 6
    tele:   0,
    move:   'hold',
    pick:   (b, ph) => {
      const pool = ['meteor', 'drones', 'eruption'];
      if (ph >= 2) pool.push('eruption', 'meteor', 'overclock');
      if (ph >= 3) pool.push('eruption', 'meteor', 'eruption', 'meteor');
      b._fcPick = pool[Math.floor(Math.random() * pool.length)];
      return 0;
    },
    attack: (c) => {
      const { b, ph, np, zone, zoneName, game, fx } = c;
      const ATK = 360;                                  // _FC_ATK
      let kind = b._fcPick || 'meteor';
      if (kind === 'overclock' && b._fcRage > 0) kind = 'meteor';   // already raging

      if (kind === 'eruption') {
        // CORE ERUPTION — expanding rings from the socket. Crossing-tested, as with the
        //   PIXIELORD's nova: a fixed band would be stepped over at 10Hz.
        b._erR = 1.0; b._erDmg = Math.floor(ATK * (0.7 + ph*0.1)); b._erHit = 0;
        fx('fc_eruption', { p:ph });

      } else if (kind === 'meteor') {
        // MOLTEN METEOR — a scatter of orbital strikes around the target
        const n = 4 + ph*2;
        fx('fc_meteor', { n:n });
        for (let i = 0; i < n; i++) {
          const tx = np.x + (Math.random()-0.5)*26, tz = np.z + (Math.random()-0.5)*26;
          if (tx < 2 || tx > 358 || tz < 2 || tz > 358) continue;
          const ent = _fgSpawnEnt(game, zoneName, zone,
            { kind:'meteor', x:tx, z:tz, r:3.4, life:999, fall:6 + i, dmg:Math.floor(ATK*0.85) });
          if (ent) broadcastToZone(game.id, zoneName, { type:'sv_fx', vt:'fg_meteor', zone:zoneName,
            did:ent.eid, ex:+tx.toFixed(2), ez:+tz.toFixed(2), r:3.4, fall:ent.fall });
        }

      } else if (kind === 'drones') {
        // SALVAGE DRONES — homing charges that arm, close, and detonate
        const n = 2 + ph;
        fx('fc_drones', { n:n });
        for (let i = 0; i < n; i++) {
          const a = Math.random()*6.28, r = 6 + Math.random()*4;
          const dx2 = b.x + Math.cos(a)*r, dz2 = b.z + Math.sin(a)*r;
          const ent = _fgSpawnEnt(game, zoneName, zone,
            { kind:'drone', x:dx2, z:dz2, life:100, armed:5, dmg:Math.floor(ATK*0.6) });
          if (ent) broadcastToZone(game.id, zoneName, { type:'sv_fx', vt:'fg_drone', zone:zoneName,
            did:ent.eid, ex:+dx2.toFixed(2), ez:+dz2.toFixed(2) });
        }

      } else {
        // OVERCLOCK — she runs hot: faster cadence for a while
        b._fcRage = 70;                                 // 420 frames
        fx('fc_overclock');
      }
    },
    passive: (c) => {
      const { b, ph, np, nd, ang, zoneName, game, fx } = c;
      const ATK = 360;

      // Tether: she tracks toward you but stays within 10 units of her socket.
      if (b._homeX === undefined) { b._homeX = b.x; b._homeZ = b.z; }
      const hdx = np.x - b._homeX, hdz = np.z - b._homeZ;
      const hd = Math.sqrt(hdx*hdx + hdz*hdz);
      if (hd > 6) {
        const reach = Math.min(hd - 4, 10);
        const tx = b._homeX + (hdx/hd)*reach, tz = b._homeZ + (hdz/hd)*reach;
        b.x += (tx - b.x) * 0.06; b.z += (tz - b.z) * 0.06;
      }

      if (b._fcRage > 0) b._fcRage--;

      // WEAK POINT WINDOW — the core opens on its own cycle, wider during meltdown.
      if (b._fcWeak) {
        b._fcWeakT--;
        if (b._fcWeakT <= 0) { b._fcWeak = 0; fx('fc_weak_end'); }
      } else {
        b._fcWeakCD = (b._fcWeakCD != null ? b._fcWeakCD : 50) - 1;
        if (b._fcWeakCD <= 0) {
          b._fcWeak = 1;
          b._fcWeakT  = (ph >= 3 ? 43 : 30);            // 260 / 180 frames
          b._fcWeakCD = (ph >= 3 ? 43 : 77);            // 260 / 460 frames
          fx('fc_weak', { ms:(ph >= 3 ? 4300 : 3000) });
        }
      }

      // CORE ERUPTION rings — expand outward, hit once as they cross
      if (b._erR > 0) {
        const prevR = b._erR;
        b._erR += 0.55 * 6;
        if (!b._erHit) {
          players.forEach((p, ws) => {
            if (p.gameId !== game.id || p.zone !== zoneName || p.x === undefined) return;
            const qx = p.x - b.x, qz = p.z - b.z, pd = Math.sqrt(qx*qx + qz*qz);
            if (pd >= prevR - 2.0 && pd <= b._erR + 2.0) {
              send(ws, { type:'sv_enemy_attack', eid:-1, dmg:b._erDmg,
                         ex:+b.x.toFixed(2), ez:+b.z.toFixed(2), zone:zoneName });
            }
          });
        }
        fx('fc_eruption_ring', { r:+b._erR.toFixed(2) });
        if (b._erR >= 22) { b._erR = 0; b._erHit = 0; }
      }

      // Meltdown aura — phase 3 cooks anything close to the socket
      if (ph >= 3 && b._vt % 4 === 0) {
        players.forEach((p, ws) => {
          if (p.gameId !== game.id || p.zone !== zoneName || p.x === undefined) return;
          const qx = p.x - b.x, qz = p.z - b.z;
          if (qx*qx + qz*qz < 81) send(ws, { type:'sv_enemy_attack', eid:-1,
            dmg:Math.floor(ATK*0.18), ex:+b.x.toFixed(2), ez:+b.z.toFixed(2), zone:zoneName });
        });
      }
    },
  },

  // ── THE PIXIELORD (a554). 5M HP, the largest health pool in the game, across five
  //    themed phases. She does not chase: she hovers, backs off if you crowd her, and
  //    BLINKS to a flanking spot on a wall-clock cadence that tightens with phase.
  //    Her ability is drawn at random from a pool that GROWS with phase — the client
  //    rolled that pool on each machine independently, so no two players in a party
  //    ever saw the same ability. The server rolls once.
  //    Her damage numbers are absolute and already fold the phase in (280 + P*80 etc.),
  //    so `dmg` stays flat at 1 and each handler computes from ph directly.
  lucidwilde: {
    x: 180, z: 144,                                    // tile (120,96) — the Dreaming Canopy heart
    spd:    [0,0,0,0,0,0],
    dmg:    [0, 1, 1, 1, 1, 1],
    phases: [0.80, 0.60, 0.40, 0.20],
    acd:    [0, 20, 16, 14, 11, 9],                    // 120 then max(56,120-P*13), / 6
    tele:   0,                                         // she has her own cast tell
    move:   'hold',
    pick:   (b, ph) => {
      // pool grows with phase, exactly as the client built it
      const pool = ['lance', 'bloom'];
      if (ph >= 2) pool.push('nova');
      if (ph >= 3) { pool.push('break'); pool.push('lance'); }
      if (ph >= 5) { pool.push('break'); pool.push('nova'); }
      b._pixPick = pool[Math.floor(Math.random() * pool.length)];
      return 0;
    },
    attack: (c) => {
      const { b, ph, np, fx, geyser } = c;
      const kind = b._pixPick || 'lance';
      if (kind === 'lance') {
        // PRISM LANCE — three sweeping fans, each re-aimed live at the target
        b._lanceW = 3; b._lanceT = 0; b._lanceDmg = 280 + ph*80;
        fx('px_lance');
      } else if (kind === 'bloom') {
        // KALEIDO BLOOM — four rotating petals of orbs
        b._bloomW = 4; b._bloomT = 0; b._bloomDmg = 300 + ph*80;
        fx('px_bloom');
      } else if (kind === 'nova') {
        // CHROMATIC NOVA — a vast expanding rainbow ring. Hits once, as it passes you.
        b._novaR = 1.0; b._novaHit = 0; b._novaDmg = 650 + ph*130;
        fx('px_nova');
      } else {
        // REALITY BREAK — the ground fractures into a hex grid, then SHATTERS
        b._rbT = 12; b._rbX = np.x; b._rbZ = np.z; b._rbDmg = 850 + ph*180;
        fx('px_break', { cx:+np.x.toFixed(2), cz:+np.z.toFixed(2) });
      }
    },
    passive: (c) => {
      const { b, ph, np, nd, ang, zoneName, game, aoe, fx, proj } = c;

      // She backs away if you crowd her, and otherwise holds station.
      if (nd < 4) {
        const bx = b.x - Math.sin(ang)*0.24, bz = b.z - Math.cos(ang)*0.24;
        if (bx > 2 && bx < 358 && bz > 2 && bz < 358) { b.x = bx; b.z = bz; }
      }

      // BLINK — wall-clock cadence so it holds regardless of tick jitter, tightening
      //   with phase, to a flanking spot 8-14 units off the target.
      if (!b._tpAt) b._tpAt = Date.now() + 3500;
      if (Date.now() >= b._tpAt) {
        b._tpAt = Date.now() + Math.max(3000, 6000 - ph*600);
        const a = Math.random()*6.283, r = 8 + Math.random()*6;
        const tx = np.x + Math.sin(a)*r, tz = np.z + Math.cos(a)*r;
        if (tx > 2 && tx < 358 && tz > 2 && tz < 358) { b.x = tx; b.z = tz; }
        fx('px_blink', { ex:+b.x.toFixed(2), ez:+b.z.toFixed(2) });
      }

      // PRISM LANCE waves — 9 oversized bolts per wave, re-aimed each time
      if (b._lanceW > 0) {
        b._lanceT--;
        if (b._lanceT <= 0) {
          b._lanceT = 2;
          const w = 3 - b._lanceW;
          const aim = Math.atan2(np.x - b.x, np.z - b.z), sweep = (w-1)*0.14;
          for (let i = -4; i <= 4; i++) proj(aim + i*0.16 + sweep, _lwCol(i+4+w), b._lanceDmg, 'magic');
          fx('px_lance_wave', { w:w });
          b._lanceW--;
        }
      }

      // KALEIDO BLOOM petals — 12 orbs per wave, rotating between waves
      if (b._bloomW > 0) {
        b._bloomT--;
        if (b._bloomT <= 0) {
          b._bloomT = 2;
          const w = 4 - b._bloomW, N = 12, rot = w*0.26;
          for (let i = 0; i < N; i++) proj((i/N)*6.283 + rot, _LW_PRISM[(i+w)%_LW_PRISM.length], b._bloomDmg, 'magic');
          fx('px_bloom_wave', { w:w });
          b._bloomW--;
        }
      }

      // CHROMATIC NOVA ring — expands outward and hits once as it crosses you.
      //   The client tested a 1.5-wide band each frame; at 10Hz the ring advances 3.7
      //   units a tick and would step straight over that band, so this tests whether the
      //   ring CROSSED the target between ticks instead. Same feel, no skipped hits.
      if (b._novaR > 0) {
        const prevR = b._novaR;
        b._novaR += 0.62 * 6;
        if (!b._novaHit) {
          players.forEach((p, ws) => {
            if (p.gameId !== game.id || p.zone !== zoneName || p.x === undefined) return;
            const qx = p.x - b.x, qz = p.z - b.z, pd = Math.sqrt(qx*qx + qz*qz);
            if (pd >= prevR - 1.5 && pd <= b._novaR + 1.5) {
              send(ws, { type:'sv_enemy_attack', eid:-1, dmg:b._novaDmg,
                         ex:+b.x.toFixed(2), ez:+b.z.toFixed(2), zone:zoneName });
            }
          });
        }
        fx('px_nova_ring', { r:+b._novaR.toFixed(2) });
        if (b._novaR >= 19) { b._novaR = 0; b._novaHit = 0; }
      }

      // REALITY BREAK — the grid holds, then shatters
      if (b._rbT > 0) {
        b._rbT--;
        if (b._rbT === 0) {
          fx('px_break_shatter', { cx:+b._rbX.toFixed(2), cz:+b._rbZ.toFixed(2) });
          players.forEach((p, ws) => {
            if (p.gameId !== game.id || p.zone !== zoneName || p.x === undefined) return;
            const qx = p.x - b._rbX, qz = p.z - b._rbZ;
            if (qx*qx + qz*qz < 121) send(ws, { type:'sv_enemy_attack', eid:-1, dmg:b._rbDmg,
              ex:+b._rbX.toFixed(2), ez:+b._rbZ.toFixed(2), zone:zoneName });
          });
        }
      }
    },
  },

  // ── COMMANDANT XERATH (a553). Five phases, a SIX-attack rotation picked from each
  //    client's own clock (Math.floor(gameTime/bACD)%6) — the same divergence CRYOTHAR
  //    and the Overlord had. Also summons, so it reuses the a551 shared-spawn path.
  //    NOTE: a third boss with TWO phase ladders in the client — the AI block's
  //    (bACD = max(75,150-phase*15)) and 20_enemy_factory.part's (85/65/50/38). Same
  //    thresholds, different cadences. Ported the AI block's, as with CRYOTHAR (a548)
  //    and THE XU SUPREME OVERLORD (a551).
  void_citadel: {
    x: 180, z: 180,                                    // tile (120,120) — central void arena
    spd:    [0, 0.032, 0.042, 0.054, 0.068, 0.082],
    dmg:    [0, 1.0,   1.5,   2.2,   3.0,   3.8],
    phases: [0.80, 0.60, 0.40, 0.20],
    acd:    [0, 20, 20, 18, 15, 13],                   // 120 then max(75,150-ph*15), / 6
    tele:   10,                                        // 60 frames
    pick:   (b) => { b.atkIdx = (b.atkIdx || 0) + 1; return b.atkIdx % 6; },
    attack: (c) => {
      const { atk, b, ph, mult, ang, np, nd, zone, zoneName, game, aoe, fx, proj, geyser } = c;

      if (atk === 0) {
        // VOID BLADE SLASH — a close cleave with a shockwave
        fx('xe_blade'); aoe(6.0, Math.floor(460 * mult));

      } else if (atk === 1) {
        // COMMAND ORBS — a widening fan, more orbs each phase
        fx('xe_orbs');
        const n = [0, 3, 5, 7, 9, 11][ph];
        for (let i = 0; i < n; i++) proj(ang + (i - (n-1)*0.5) * 0.20, 0xaa00ff, Math.floor(160 * mult), 'void');
        aoe(6.0, Math.floor(220 * mult));

      } else if (atk === 2) {
        // VOID SURGE — reality bows outward
        fx('xe_surge'); aoe(8.5, Math.floor(380 * mult));

      } else if (atk === 3) {
        // RIFT STRIKE — teleports BEHIND you, then backstabs. Phase 3+ strikes twice.
        const btx = np.x - Math.sin(ang) * 1.6, btz = np.z - Math.cos(ang) * 1.6;
        if (btx > 2 && btx < 358 && btz > 2 && btz < 358) { b.x = btx; b.z = btz; }
        fx('xe_rift', { ex:+b.x.toFixed(2), ez:+b.z.toFixed(2) });
        aoe(5.5, Math.floor(540 * mult));
        if (ph >= 3) { b._rsFollow = 4; b._rsDmg = Math.floor(380 * mult); }

      } else if (atk === 4) {
        // SUMMON VOID LEGION — real adds in the SHARED zone (a551 pattern).
        //   These carry their own small HP on purpose and are NOT touched by
        //   ZONE_TYPE_HP, which only applies to ZONE_SPAWNS entries.
        fx('xe_legion');
        const n = ph >= 4 ? 4 : 3;
        for (let si = 0; si < n; si++) {
          const sa = Math.random() * Math.PI * 2, sr = 3.3 + Math.random() * 2.7;
          const ssx = b.x + Math.sin(sa) * sr, ssz = b.z + Math.cos(sa) * sr;
          if (ssx < 2 || ssx > 358 || ssz < 2 || ssz > 358) continue;
          const useConstruct = si % 2 === 0;
          zone._nextEid = (zone._nextEid || 100000) + 1;
          const add = {
            id: zone._nextEid,
            type: useConstruct ? 'void_construct' : 'void_sentinel',
            x: ssx, z: ssz, spawnX: ssx, spawnZ: ssz,
            hp: useConstruct ? 1800 : 2200, maxHp: useConstruct ? 1800 : 2200,
            atk: useConstruct ? 130 : 160, spd: 0.055, aggroRange: 14,
            reward: 280, expR: 110, dmgReduction: useConstruct ? 0 : 0.10,
            active: true, aggroed: true, respawnTimer: 0, attackTimer: 0,
            _summoned: 1,
          };
          zone.enemies.push(add);
          broadcastToZone(game.id, zoneName, { type:'sv_enemy_state', zone:zoneName,
            ids:[add.id], xs:[+ssx.toFixed(2)], zs:[+ssz.toFixed(2)],
            hps:[add.hp], acts:[1], types:[add.type] });
          fx('xe_legion_drop', { ex:+ssx.toFixed(2), ez:+ssz.toFixed(2) });
        }

      } else {
        // FULL VOID MERGE — the showpiece
        fx('xe_merge');
        const n = ph >= 4 ? 12 : 8;
        for (let vi = 0; vi < n; vi++) proj(vi/n*Math.PI*2, 0xcc44ff, Math.floor(170 * mult), 'void');
        aoe(10.0, Math.floor(460 * mult));
      }
    },
    passive: (c) => {
      const { b, ph, mult, ang, np, nd, zoneName, game, aoe, fx, proj, geyser } = c;

      // RIFT STRIKE follow-up (phase 3+), scheduled by the attack above
      if (b._rsFollow > 0) {
        b._rsFollow--;
        if (b._rsFollow === 0) {
          fx('xe_rift_followup');
          aoe(5.0, b._rsDmg || Math.floor(380 * mult));
        }
      }

      // Void Commander Aura — always on
      if (b._vt % 5 === 0) aoe(5.5, Math.floor(45 * mult));
      // P2+ Rift Lightning — strikes scattered around the target
      if (ph >= 2 && b._vt % 9 === 0)
        geyser(np.x + (Math.random()-0.5)*10.5, np.z + (Math.random()-0.5)*10.5, 3, 3.3, Math.floor(95 * mult), 0xcc00ff);
      // P3+ Void Rain — drops across the arena
      if (ph >= 3 && b._vt % 7 === 0)
        geyser(b.x + (Math.random()-0.5)*15, b.z + (Math.random()-0.5)*15, 3, 2.7, Math.floor(100 * mult), 0x8800ff);
      // P4+ autoshot command orb
      if (ph >= 4 && b._vt % 8 === 0 && nd < 16) proj(ang, 0xaa00ff, Math.floor(110 * mult), 'void');
      // P5 Reality Collapse — continuous ring pulse
      if (ph >= 5 && b._vt % 5 === 0) { fx('xe_collapse'); aoe(5.5, Math.floor(90 * mult)); }
    },
  },

  // ── THE APEX PYRAMID (a552). Structurally unlike every boss migrated so far: it has
  //    NO attack rotation. It hovers motionless over the fortress arena and runs five
  //    abilities on five independent cooldowns, so everything lives in passive() and the
  //    rotation machinery is left unused. Damage scales linearly with phase (X * phase),
  //    which is why `dmg` is just the phase number.
  xumen_fortress: {
    x: 180, z: 180,                                    // tile (120,120) — central laser arena
    spd:    [0,0,0,0,0],                               // unused under 'hold'
    dmg:    [0, 1, 2, 3, 4],
    phases: [0.75, 0.50, 0.25],
    acd:    [0, 20, 20, 20, 20],                       // unused — no rotation
    tele:   0,
    move:   'hold',
    passive: (c) => {
      const { b, ph, mult, np, nd, zoneName, game, aoe, fx, proj, geyser } = c;
      const pang = Math.atan2(np.x - b.x, np.z - b.z);

      // CANNON SALVO — four projectiles fired outward from the rotating hull
      const salvoRate = Math.max(3, Math.round(Math.max(20, 50 - ph*8) / 6));
      if (b._vt % salvoRate === 0) {
        fx('ap_salvo');
        b._hullSpin = (b._hullSpin || 0) + 0.072;
        for (let ci = 0; ci < 4; ci++) proj(b._hullSpin + ci/4*Math.PI*2, 0xff2200, Math.floor(180 * mult), 'plasma');
      }

      // TRACTOR BEAM — drags everyone in the arena toward the hull, then burns them
      if (b._tbOn) {
        b._tbT = (b._tbT || 0) + 1;
        players.forEach((p, ws) => {
          if (p.gameId !== game.id || p.zone !== zoneName || p.x === undefined) return;
          const dx = b.x - p.x, dz = b.z - p.z, d = Math.sqrt(dx*dx + dz*dz);
          if (d > 1.5) send(ws, { type:'sv_player_fx', zone:zoneName, eff:'pull',
                                  px:+b.x.toFixed(2), pz:+b.z.toFixed(2), pull:0.12*6 });
          if (d < 4.5) send(ws, { type:'sv_enemy_attack', eid:-1, dmg:Math.floor(60 * mult),
                                  ex:+b.x.toFixed(2), ez:+b.z.toFixed(2), zone:zoneName });
        });
        if (b._tbT >= 30) { b._tbOn = 0; b._tbT = 0; fx('ap_tractor_end'); }
      } else {
        b._tbCd = (b._tbCd || 0) - 1;
        if (b._tbCd <= 0 && nd < 18) {
          b._tbCd = 30 + Math.floor(Math.random() * 20);
          b._tbOn = 1; b._tbT = 0;
          fx('ap_tractor');
        }
      }

      // ORBITAL STRIKE — P2+, a telegraphed pillar on your position
      if (ph >= 2) {
        b._obCd = (b._obCd || 0) - 1;
        if (b._obCd <= 0) {
          b._obCd = Math.max(5, Math.round((240 - ph*30) / 6));
          fx('ap_orbital', { tx:+np.x.toFixed(2), tz:+np.z.toFixed(2) });
          geyser(np.x, np.z, 10, 6.75, Math.floor(320 * mult), 0x00ffff, { shake:14 });
        }
      }

      // DISINTEGRATION BEAM — P3+, a continuous aimed lance
      if (ph >= 3 && b._vt % 2 === 0) proj(pang, 0x00ffff, Math.floor(80 * mult), 'plasma');

      // VOID SHOCKWAVE — P4, area denial around the hull
      if (ph >= 4) {
        b._vsCd = (b._vsCd || 0) - 1;
        if (b._vsCd <= 0) {
          b._vsCd = 20;
          fx('ap_void'); aoe(10.5, Math.floor(200 * mult));
        }
      }
    },
  },

  // ── THE XU SUPREME OVERLORD (a551). Top of the Xu command chain, 5 phases, a
  //    SEVEN-attack rotation — the longest rotation of any zone boss so far. The client
  //    picked it with Math.floor(gameTime/bACD)%7 off each client's own clock, the same
  //    divergence CRYOTHAR had. Attack 3 summons real adds, which are now spawned into
  //    the shared zone rather than privately on each client.
  //    NOTE: like CRYOTHAR, this boss has TWO phase ladders in the client — the AI block's
  //    (bACD = max(80,162-phase*16)) and a second in 20_enemy_factory.part with cadences
  //    90/70/55/40. Same thresholds, different cadences. Ported the AI block's, as with
  //    CRYOTHAR in a548 — see the changelog note.
  xumen: {
    x: 180, z: 180,                                    // tile (120,120) — central plaza
    spd:    [0, 0.022, 0.030, 0.040, 0.052, 0.066],
    dmg:    [0, 1.0,   1.5,   2.2,   3.0,   4.0],
    phases: [0.80, 0.60, 0.40, 0.20],
    acd:    [0, 20, 22, 19, 16, 14],                   // 120 then max(80,162-ph*16), / 6
    tele:   10,                                        // 62 frames
    pick:   (b) => { b.atkIdx = (b.atkIdx || 0) + 1; return b.atkIdx % 7; },
    attack: (c) => {
      const { atk, b, ph, mult, ang, np, nd, zone, zoneName, game, aoe, fx, proj, geyser } = c;

      if (atk === 0) {
        // DOMINION STRIKE — a calculated two-handed cleave
        fx('ov_strike'); aoe(6.0, Math.floor(520 * mult));

      } else if (atk === 1) {
        // COMMAND CANNON — a walking burst, heavier with phase
        fx('ov_cannon');
        const shots = ph >= 3 ? 8 : ph >= 2 ? 6 : 4;
        for (let i = 0; i < shots; i++) proj(ang + (i - (shots-1)/2) * 0.16, 0xff8800, Math.floor(160 * mult), 'plasma');
        aoe(6.0, Math.floor(280 * mult));

      } else if (atk === 2) {
        // STRATEGIC WITHDRAWAL — teleports, then flanks
        fx('ov_withdraw');
        b.x = np.x + (Math.random()-0.5) * 9;
        b.z = np.z + (Math.random()-0.5) * 9;
        fx('ov_flank', { ex:+b.x.toFixed(2), ez:+b.z.toFixed(2) });
        aoe(6.75, Math.floor(280 * mult));

      } else if (atk === 3) {
        // CALL ENFORCERS — two real adds, spawned into the SHARED zone.
        //   Client-side these were pushed straight into the local enemies array, so every
        //   player fought their own private pair that nobody else could see or damage.
        //   These are tagged _summoned so the respawn loop reaps them instead of
        //   resurrecting them forever at their drop point.
        fx('ov_summon');
        for (let i = 0; i < 2; i++) {
          const a = Math.random() * Math.PI * 2, r = 3.75 + Math.random() * 3.0;
          const ex = b.x + Math.sin(a) * r, ez = b.z + Math.cos(a) * r;
          if (ex < 2 || ex > 358 || ez < 2 || ez > 358) continue;
          zone._nextEid = (zone._nextEid || 100000) + 1;
          const add = {
            id: zone._nextEid, type:'xu_enforcer',
            x: ex, z: ez, spawnX: ex, spawnZ: ez,
            hp: 3200, maxHp: 3200, atk: 160, spd: 0.090, aggroRange: 16,
            reward: 300, expR: 100, dmgReduction: 0.32,
            active: true, aggroed: true, respawnTimer: 0, attackTimer: 0,
            _summoned: 1,
          };
          zone.enemies.push(add);
          broadcastToZone(game.id, zoneName, { type:'sv_enemy_state', zone:zoneName,
            ids:[add.id], xs:[+ex.toFixed(2)], zs:[+ez.toFixed(2)],
            hps:[add.hp], acts:[1], types:[add.type] });
          fx('ov_drop', { ex:+ex.toFixed(2), ez:+ez.toFixed(2) });
        }

      } else if (atk === 4) {
        // ORBITAL BOMBARDMENT — four overlapping strikes
        fx('ov_orbital');
        for (let ob = 0; ob < 4; ob++)
          geyser(np.x + (Math.random()-0.5) * 7.5, np.z + (Math.random()-0.5) * 7.5,
                 6 + ob*6, 6.0, Math.floor(360 * mult), 0x00ffff, { shake:10 });

      } else if (atk === 5) {
        // VOID SUPPRESSION FIELD — a ring of plasma spirals outward
        fx('ov_suppress');
        const n = ph >= 3 ? 12 : 8;
        for (let si = 0; si < n; si++) proj(si/n*Math.PI*2, 0x00ccff, Math.floor(120 * mult), 'plasma');
        aoe(7.0, Math.floor(280 * mult));

      } else {
        if (ph >= 3) {
          // ABSOLUTE AUTHORITY — reality-warping detonation
          fx('ov_authority'); aoe(11.0, Math.floor(440 * mult));
        } else {
          // PRECISION BURST — phases 1-2
          fx('ov_precision');
          for (let i = 0; i < 3; i++) proj(ang, 0x00ffff, Math.floor(200 * mult), 'plasma');
          aoe(8.0, Math.floor(300 * mult));
        }
      }
    },
    passive: (c) => {
      const { b, ph, mult, ang, aoe, fx, proj } = c;
      // Command aura — void energy radiates at all times
      if (b._vt % 4 === 0) aoe(5.5, Math.floor(30 * mult));
      // P2+: shoulder-cannon auto-fire
      if (ph >= 2 && b._vt % 5 === 0) proj(ang, 0x00ccff, Math.floor(80 * mult), 'plasma');
      // P4+: void field shrinks the arena
      if (ph >= 4 && b._vt % 7 === 0) { fx('ov_field'); aoe(7.0, Math.floor(40 * mult)); }
      // P5: continuous void suppression fire
      if (ph >= 5 && b._vt % 3 === 0) proj(ang, 0x00ffff, Math.floor(55 * mult), 'plasma');
    },
  },

  // ── OVERSEER ZERO (a550). The dominion's last AI: 3M HP across EIGHT phases, the
  //    longest fight in the game. She holds the throne and rains fire rather than
  //    chasing, so she uses 'drift' rather than the marching spine.
  //    _ozHit(flat, pct) = flat*(1+(p-1)*0.22) + maxHP*pct*(1+(p-1)*0.16). The server
  //    can't see player maxHP, so `dmg` below IS the flat scalar (1+(p-1)*0.22) and we
  //    mirror the flat term only — same discipline as every migrated zone.
  xeron: {
    x: 180, z: 180,                                    // tile (120,120) — central command arena
    spd:    [0,0,0,0,0,0,0,0,0],                       // unused under 'drift'
    dmg:    [0, 1.00, 1.22, 1.44, 1.66, 1.88, 2.10, 2.32, 2.54],
    phases: [0.87, 0.75, 0.62, 0.50, 0.37, 0.25, 0.12],
    acd:    [0, 20, 13, 12, 10, 8, 7, 6, 5],           // 120/80/70/60/50/42/35/28 frames / 6
    tele:   0,                                         // she charges her own rails
    move:   'drift', driftR: 1.6, driftPer: 0.18, driftSpd: 0.05,
    range:  39,                                        // 26 * TILE
    pick:   () => 0,                                   // not a rotation — a phase-scaling combo
    attack: (c) => {
      const { b, ph, mult, np, fx, geyser } = c;
      // TWIN RAILGUN — always. Aim locks now, lance lands 360ms later, so it is dodgeable.
      fx('oz_railgun_charge', { tx:+np.x.toFixed(2), tz:+np.z.toFixed(2) });
      geyser(np.x, np.z, 6, 4.5, Math.floor(160 * mult), 0x00ffff, { shake:12 });
      // P5+: THE PROTOCOL — orbital bombardment scattered around the target
      if (ph >= 5) {
        fx('oz_protocol');
        const shots = 5 + ph;
        for (let i = 0; i < shots; i++) {
          const a = (i/shots)*Math.PI*2 + Math.random()*0.4, r = 2 + Math.random()*5;
          geyser(np.x + Math.cos(a)*r, np.z + Math.sin(a)*r, 6 + i, 4.2, Math.floor(170 * mult), i%2?0xff44ff:0x00ffff);
        }
      }
      // P7+: PHOTON CONVERGENCE — a screen-clearing lance down your line
      if (ph >= 7) {
        const pa = Math.atan2(np.x - b.x, np.z - b.z);
        fx('oz_photon', { dir:+pa.toFixed(3), len:34 });
        for (let i = 1; i <= 10; i++)
          geyser(b.x + Math.sin(pa)*i*3.4, b.z + Math.cos(pa)*i*3.4, 14, 4.8, Math.floor(460 * mult), 0xffffff);
      }
    },
    passive: (c) => {
      const { b, ph, mult, np, aoe, fx, proj, geyser } = c;
      const pang = Math.atan2(np.x - b.x, np.z - b.z);
      // constant aimed bolt stream from the eye, ramping with phase
      const rate = Math.max(2, Math.round(Math.max(10, 30 - ph*2) / 6));
      if (b._vt % rate === 0) proj(pang, 0x00ffff, Math.floor(55 * mult), 'plasma');
      // P2+: lead micro-missile pair
      if (ph >= 2 && b._vt % Math.max(4, Math.round(Math.max(26, 60 - ph*4) / 6)) === 0) {
        proj(pang - 0.10, 0x00ffff, Math.floor(48 * mult), 'plasma');
        proj(pang + 0.10, 0xff44ff, Math.floor(48 * mult), 'plasma');
      }
      // P3+: rotating bullet-ring from the core (the bullet-hell layer)
      if (ph >= 3 && b._vt % Math.max(7, Math.round(Math.max(40, 90 - ph*6) / 6)) === 0) {
        b._ozSpin = (b._ozSpin || 0) + 0.35;
        const n = 8 + ph;
        for (let r = 0; r < n; r++) proj(b._ozSpin + (r/n)*Math.PI*2, r%2?0xff44ff:0x00ffff, Math.floor(42 * mult), 'plasma');
      }
      // P6+: searing aura punishes facetanking
      if (ph >= 6 && b._vt % 3 === 0) aoe(10.5, Math.floor(35 * mult));
      // P3+: SATELLITE SALVO on its own cooldown, so the sky stays busy
      if (ph >= 3) {
        b._salvoCd = (b._salvoCd || 0) - 1;
        if (b._salvoCd <= 0) {
          b._salvoCd = Math.max(15, Math.round(Math.max(90, 200 - ph*12) / 6));
          fx('oz_salvo');
          for (let i = 0; i < 6; i++) proj(pang + (i-2.5)*0.14, i%2?0x00ffff:0xff44ff, Math.floor(85 * mult), 'plasma');
        }
      }
      // P4+: HOLOGRAPHIC KILL-GRID on its own cooldown. Lethal on the LINES, not the
      //   cells — so the lattice hit test is done exactly, not approximated by circles.
      if (ph >= 4) {
        if (b._kgOn) {
          b._kgT = (b._kgT || 0) + 1;
          if (b._kgT >= 8) {
            b._kgOn = 0; b._kgT = 0;
            fx('oz_killgrid_fire', { cx:+b._kgX.toFixed(2), cz:+b._kgZ.toFixed(2) });
            const span = 13.5, n = 5, step = span / n;
            players.forEach((p, ws) => {
              if (p.gameId !== c.game.id || p.zone !== c.zoneName || p.x === undefined) return;
              if (Math.abs(p.x - b._kgX) >= span/2 || Math.abs(p.z - b._kgZ) >= span/2) return;
              let nearZ = 99, nearX = 99;
              for (let i = 0; i < n; i++) {
                const o = (i - (n-1)/2) * step;
                nearZ = Math.min(nearZ, Math.abs((p.z - b._kgZ) - o));
                nearX = Math.min(nearX, Math.abs((p.x - b._kgX) - o));
              }
              if (nearZ < 1.35 || nearX < 1.35)
                send(ws, { type:'sv_enemy_attack', eid:-1, dmg:Math.floor(180 * mult),
                           ex:+b.x.toFixed(2), ez:+b.z.toFixed(2), zone:c.zoneName });
            });
          }
        } else {
          b._kgCd = (b._kgCd || 0) - 1;
          if (b._kgCd <= 0) {
            b._kgCd = Math.max(25, Math.round(Math.max(150, 300 - ph*14) / 6));
            b._kgOn = 1; b._kgT = 0; b._kgX = np.x; b._kgZ = np.z;
            fx('oz_killgrid', { cx:+np.x.toFixed(2), cz:+np.z.toFixed(2), span:13.5, n:5 });
          }
        }
      }
    },
  },

  // ── THE CURATOR (a549). The city's last citizen: hovers, processes, does not chase.
  //    Attack choice is RANDOM and phase-gated (the client rolled Math.random() per
  //    client, so no two players ever saw the same attack — worse than CRYOTHAR's
  //    clock-derived rotation). The server now rolls once, authoritatively.
  neon_hollow: {
    x: 180, z: 180,                                   // tile (120,120) — central laser arena
    spd:    [0, 0.012, 0.018, 0.024, 0.028, 0.032],
    dmg:    [0, 1.0,   1.4,   1.9,   2.5,   3.4],
    phases: [0.80, 0.60, 0.40, 0.20],
    acd:    [0, 20, 14, 11, 8, 6],                    // 120/85/65/50/38 frames / 6
    tele:   9,                                        // 55 frames
    pick:   (b, ph) => Math.floor(Math.random() * Math.min(5, ph + 1)),
    attack: (c) => {
      const { atk, b, ph, mult, ang, np, aoe, fx, proj, geyser } = c;
      if (atk === 1) {
        // DISINTEGRATION BEAM — 1.5s painted line, then an 18-long lance along it.
        // Rendered on the spine as overlapping segments (same trick as the marching
        // flamebreath) so it reuses the geyser resolver instead of a bespoke line test.
        fx('cu_beam_charge', { dir:+ang.toFixed(3), len:18 });
        for (let i = 1; i <= 9; i++)
          geyser(b.x + Math.sin(ang)*i*2, b.z + Math.cos(ang)*i*2, 15, 1.0, Math.floor(320 * mult), 0x00e0ff);
      } else if (atk === 2 && ph >= 3) {
        // HOVER-TELEPORT — vanish, reappear in the arena corner furthest from the target.
        const corners = [[159,159],[201,159],[159,201],[201,201]];
        let best = corners[0], bestD = -1;
        corners.forEach(cn => { const dx=cn[0]-np.x, dz=cn[1]-np.z, d=dx*dx+dz*dz; if (d > bestD) { bestD=d; best=cn; } });
        fx('cu_blink_out');
        b.x = best[0]; b.z = best[1];
        fx('cu_blink_in', { ex:+b.x.toFixed(2), ez:+b.z.toFixed(2) });
        const na = Math.atan2(np.x - b.x, np.z - b.z);
        for (let vi = 0; vi < 5; vi++) proj(na + (vi-2)*0.25, 0xff3cff, Math.floor(140 * mult), 'plasma');
      } else if (atk === 3 && ph >= 4) {
        // CRASH CAR SUMMON — the traffic grid weaponises itself, two cars onto the target
        fx('cu_traffic', { ex:+np.x.toFixed(2), ez:+np.z.toFixed(2) });
        geyser(np.x, np.z, 15, 4.5, Math.floor(250 * mult), 0xffa000, { shake:12 });
        geyser(np.x, np.z, 21, 4.5, Math.floor(250 * mult), 0xffa000, { shake:12 });
      } else if (atk === 4 && ph >= 5) {
        // "THE CITY PROTECTS" — ten beams rain across the arena over ~4s
        fx('cu_city_protects');
        for (let bi = 0; bi < 10; bi++)
          geyser(b.x + (Math.random()-0.5)*21, b.z + (Math.random()-0.5)*21,
                 4 + bi*4, 3.0, Math.floor(200 * mult), 0xff2040);
      } else {
        // DRONE SWARM VOLLEY (also the fallback when the roll outruns the phase)
        fx('cu_drones');
        const n = (atk === 0) ? (4 + ph*2) : 4;
        for (let di = 0; di < n; di++) proj(di/n*Math.PI*2, 0x00e0ff, Math.floor(95 * mult), 'plasma');
      }
    },
    passive: (c) => {
      const { b, ph, mult, ang, np, aoe, fx, proj, geyser } = c;
      // P1 — Hardlight Field: the security field reads you as an anomaly (all phases)
      if (b._vt % 5 === 0) { fx('cu_hardlight'); aoe(5.0, Math.floor(55 * mult)); }
      // P2 — hatch drones
      if (ph >= 2 && b._vt % 15 === 0) { for (let i = 0; i < 2; i++) proj(ang, 0x00e0ff, Math.floor(85 * mult), 'plasma'); }
      // P3 — City Beam Grid: towers rain telegraphed beams around the arena
      if (ph >= 3 && b._vt % 8 === 0)
        geyser(b.x + (Math.random()-0.5)*16.5, b.z + (Math.random()-0.5)*16.5, 9, 3.3, Math.floor(140 * mult), 0xff2040);
      // P4 — autonomous paired plasma cannons
      if (ph >= 4 && b._vt % 7 === 0) { proj(ang - 0.12, 0xff3cff, Math.floor(130 * mult), 'plasma');
                                        proj(ang + 0.12, 0xff3cff, Math.floor(130 * mult), 'plasma'); }
      // P5 — zone-wide grid pulse
      if (ph >= 5 && b._vt % 10 === 0) { fx('cu_pulse'); aoe(8.0, Math.floor(160 * mult)); }
    },
  },
};

function tickZoneBoss(game, zoneName, zone) {
  const cfg = ZBOSS_SERVER[zoneName];
  if (!cfg) return;
  const b = zone.boss;
  if (!b || !b.spawned || b.hp <= 0) return;
  const zonePlayers = getPlayersInZone(game.id, zoneName);
  if (zonePlayers.length === 0) return;
  if (b.x === undefined) { b.x = cfg.x; b.z = cfg.z; }

  let np = null, nd = Infinity;
  zonePlayers.forEach(p => {
    if (p.x === undefined) return;
    const dx = p.x - b.x, dz = p.z - b.z, d = Math.sqrt(dx*dx + dz*dz);
    if (d < nd) { nd = d; np = p; }
  });
  if (!np) return;

  // ── Phase escalation from the config's HP ladder
  const th = cfg.phases;
  let nph = 1;
  for (let i = 0; i < th.length; i++) if (b.hp <= b.maxHp * th[i]) nph = i + 2;
  if (nph > (b.phase || 1)) {
    b.phase = nph;
    b.acd = cfg.acd[Math.min(nph, cfg.acd.length - 1)] || 15;
    broadcastToZone(game.id, zoneName, { type:'sv_boss_phase', zone:zoneName, phase:nph });
    broadcastToZone(game.id, zoneName, { type:'sv_fx', vt:'zb_phase', zone:zoneName,
                                         ex:+b.x.toFixed(2), ez:+b.z.toFixed(2), phase:nph });
  }
  const ph = Math.min(b.phase || 1, cfg.dmg.length - 1);   // a550 — was hardcoded 5; OVERSEER ZERO runs 8
  if (!b.acd) b.acd = cfg.acd[1] || 20;
  const mult = cfg.dmg[ph];
  const ang = Math.atan2(np.x - b.x, np.z - b.z);

  // ── Shared helpers handed to the config's attack/passive handlers
  const aoe = (radius, dmg) => {
    players.forEach((p, ws) => {
      if (p.gameId !== game.id || p.zone !== zoneName || p.x === undefined) return;
      const dx = p.x - b.x, dz = p.z - b.z;
      if (dx*dx + dz*dz < radius*radius)
        send(ws, { type:'sv_enemy_attack', eid:-1, dmg:dmg, ex:+b.x.toFixed(2), ez:+b.z.toFixed(2), zone:zoneName });
    });
  };
  const fx = (vt, extra) => broadcastToZone(game.id, zoneName,
    Object.assign({ type:'sv_fx', vt:vt, zone:zoneName, ex:+b.x.toFixed(2), ez:+b.z.toFixed(2) }, extra || {}));
  const proj = (a, col, dmg, kind) => _sdSpawnProj(game, zoneName, { id:-1, x:b.x, z:b.z }, a, col, dmg, kind, null, 0);
  const geyser = (gx, gz, fuse, radius, dmg, col, extra) => {
    if (!game._sdGeyser) game._sdGeyser = [];
    game._sdGeyser.push(Object.assign({ zone:zoneName, x:gx, z:gz, fuse:fuse, dmg:dmg,
                                        eid:-1, col:col, radius:radius }, extra || {}));
    broadcastToZone(game.id, zoneName, { type:'sv_fx', vt:'sd_geyser_warn', zone:zoneName,
                                         ex:+gx.toFixed(2), ez:+gz.toFixed(2), col:col });
  };
  const ctx = { game, zoneName, zone, b, np, nd, ang, ph, mult, aoe, fx, proj, geyser, atk:0 };

  // ── Movement. The server has no nav grid for these arenas; clamp to world bounds.
  //    a550 — 'drift' added for OVERSEER ZERO, who holds the throne and rains fire
  //    rather than chasing: a slow Lissajous wander around the spawn anchor, widening
  //    with phase. Marching her at the player would be wrong for the fight.
  let nx, nz;
  if (cfg.move === 'hold') {
    // a552 — THE APEX PYRAMID never moves at all: it hovers over its arena and spins.
    nx = b.x; nz = b.z;
  } else if (cfg.move === 'drift') {
    if (b._anchorX === undefined) { b._anchorX = b.x; b._anchorZ = b.z; }
    b._drift = (b._drift || 0) + (cfg.driftSpd || 0.05);
    const dr = (cfg.driftR || 1.6) + ph * (cfg.driftPer || 0.18);
    nx = b._anchorX + Math.cos(b._drift) * dr;
    nz = b._anchorZ + Math.sin(b._drift * 0.8) * dr;
  } else {
    const spd = cfg.spd[ph] * 6;
    nx = b.x + Math.sin(ang)*spd; nz = b.z + Math.cos(ang)*spd;
  }
  if (nx > 2 && nx < 358 && nz > 2 && nz < 358) { b.x = nx; b.z = nz; }

  // ── Range gate. a550 — OVERSEER ZERO only engages inside her citadel's firing
  //    envelope; outside it she just drifts and the fight pauses, as client-side.
  const inRange = (cfg.range === undefined) || (nd <= cfg.range);

  // ── Passive layer
  b._vt = (b._vt || 0) + 1;
  if (cfg.passive && inRange) cfg.passive(ctx);

  // ── Telegraph + attack cadence. cfg.tele === 0 opts out of the generic telegraph
  //    for bosses that stage their own (OVERSEER ZERO charges her rails instead).
  if (inRange) {
    b.atkT = (b.atkT || 0) + 1;
    if (cfg.tele !== 0 && b.atkT === Math.max(1, b.acd - (cfg.tele || 10))) {
      const alt = ((b.atkIdx || 0) % 2 === 0);
      broadcastToZone(game.id, zoneName, { type:'sv_fx', vt:'zb_telegraph', zone:zoneName,
        ex:+(alt ? b.x : np.x).toFixed(2), ez:+(alt ? b.z : np.z).toFixed(2) });
    }
    // a552 — cfg.attack is optional. THE APEX PYRAMID has no rotation at all; every one
    //   of its abilities runs on its own independent cooldown inside passive().
    if (cfg.attack && b.atkT >= b.acd) {
      b.atkT = 0;
      ctx.atk = cfg.pick ? cfg.pick(b, ph) : 0;
      cfg.attack(ctx);
    }
  }

  // ── Position + phase broadcast. Deliberately NOT sv_boss_state: that message carries
  //    hp and runs through the client's heal-jump watchdog, which has a long bug history.
  broadcastToZone(game.id, zoneName, {
    type:'sv_zboss', zone:zoneName,
    x:+b.x.toFixed(2), z:+b.z.toFixed(2), phase:ph,
  });
}

function tickWorldBoss(game) {
  const wb = game.worldBoss;
  if (!wb || !wb.spawned) return;
  // a486 — players PRESENT in the boss's zone count as activity. The idle
  //   despawn exists for abandoned bosses, not for ones players are still
  //   traveling to or actively kiting between hits.
  if (getPlayersInZone(game.id, wb.zone).length > 0) wb.lastHitAt = Date.now();
  // a504 — SPAWN GRACE. Root cause of the instant-retreat: a world boss spawned
  //   while the only player's server-side zone/position hadn't been reported yet
  //   (client sends sv_player_state on its own cadence; a boss requested right
  //   after a zone change can tick before the first state arrives). With nobody
  //   detected "in zone", lastHitAt never refreshed, and on a server that had
  //   been up a while Date.now()-lastHitAt could already exceed the window on
  //   the very first tick — instant idle-despawn. Never idle-despawn a boss
  //   that's existed for less than its full idle window measured from SPAWN,
  //   and clamp lastHitAt so it can't be read as stale on tick one.
  const _wbAge = Date.now() - (wb.spawnedAt || 0);
  // Idle despawn — no damage taken in the cutoff window (and boss is past grace)
  if (_wbAge > WORLD_BOSS_IDLE_MS && Date.now() - wb.lastHitAt > WORLD_BOSS_IDLE_MS) {
    despawnWorldBoss(game, false, null, wb.x, wb.z);
    return;
  }
  const zonePlayers = getPlayersInZone(game.id, wb.zone);
  if (zonePlayers.length === 0) {
    // No one in zone — reset aggro, freeze position
    if (wb.aggroed) { wb.aggroed = false; }
    return;
  }
  // Find nearest player in the boss's zone
  let nearest = null, nearestDist = Infinity;
  zonePlayers.forEach(p => {
    const dx = p.x - wb.x, dz = p.z - wb.z;
    const d = Math.sqrt(dx*dx + dz*dz);
    if (d < nearestDist) { nearestDist = d; nearest = p; }
  });
  if (!nearest) return;

  // Aggro check
  if (nearestDist <= wb.aggroRange) wb.aggroed = true;

  let posChanged = false;
  if (wb.aggroed) {
    // Slow but inexorable march — world bosses aren't twitchy, they're heavy
    if (nearestDist > ATTACK_RANGE + 1.2) {
      const dx = nearest.x - wb.x, dz = nearest.z - wb.z;
      const len = Math.sqrt(dx*dx + dz*dz) || 1;
      const speed = 0.035; // a touch faster than xu_supreme, slower than berserker
      wb.x += (dx / len) * speed * 1.6;
      wb.z += (dz / len) * speed * 1.6;
      posChanged = true;
    }
    // Melee swing — server does damage to the nearest player only, but broadcasts
    // the swing animation cue to everyone in the zone so the boss looks alive.
    wb.attackTimer++;
    if (wb.attackTimer >= wb.atkCooldown && nearestDist <= ATTACK_RANGE + 1.8) {
      wb.attackTimer = 0;
      const dmg = Math.floor(wb.atk * (0.85 + Math.random() * 0.3));
      players.forEach((p, ws) => {
        if (p === nearest) {
          send(ws, {
            type: 'sv_worldboss_attack',
            id: wb.id, dmg,
            ex: +wb.x.toFixed(2), ez: +wb.z.toFixed(2),
            zone: wb.zone,
          });
        }
      });
      broadcastToZone(game.id, wb.zone, {
        type: 'sv_worldboss_anim',
        id: wb.id, a: 'attack',
        ex: +wb.x.toFixed(2), ez: +wb.z.toFixed(2),
        tx: +nearest.x.toFixed(2), tz: +nearest.z.toFixed(2),
        zone: wb.zone,
      });
    }
  }

  // Position broadcast — only when changed, and only to players in zone
  if (posChanged) {
    broadcastToZone(game.id, wb.zone, {
      type: 'sv_worldboss_state',
      id: wb.id,
      x: +wb.x.toFixed(2),
      z: +wb.z.toFixed(2),
      hp: wb.hp,
      maxHp: wb.maxHp,
      phase: wb.phase,
      zone: wb.zone,
    });
  }
}

function tickGame(game) {
  Object.entries(game.zones).forEach(([zoneName, zone]) => {
    const zonePlayers = getPlayersInZone(game.id, zoneName);
    const hasPlayers = zonePlayers.length > 0;
    if (hasPlayers) zone.lastActivity = Date.now();

    // a233 — CO-OP: when the Convergence empties, end the shared run so the next
    //   group starts fresh (new seed, Depth 1). Grace period avoids resetting
    //   during the brief gap between a player leaving and another descending.
    if (zoneName === 'convergence' && zone._runEstablished && !hasPlayers) {
      if (!zone._emptySince) zone._emptySince = Date.now();
      else if (Date.now() - zone._emptySince > 20000) {
        zone._runEstablished = false;
        zone.convergenceDepth = 1;
        zone.activeModIds = [];
        zone.runSeed = ((Date.now() ^ (Math.random()*0x7fffffff)) & 0x7fffffff);
        zone._emptySince = 0;
        console.log(`[convergence] Run reset (zone empty) — fresh seed ${zone.runSeed} for next group.`);
      }
    } else if (zoneName === 'convergence' && hasPlayers) {
      zone._emptySince = 0;
    }

    const changed = [];

    // a551 — reap dead SUMMONED adds (boss CALL ENFORCERS). They were never in
    //   ZONE_SPAWNS, so the respawn loop below would resurrect them at their drop
    //   point forever and the plaza would slowly fill with enforcers.
    for (let i = zone.enemies.length - 1; i >= 0; i--) {
      const se = zone.enemies[i];
      if (se && se._summoned && !se.active) zone.enemies.splice(i, 1);
    }

    zone.enemies.forEach(e => {
      // Always tick respawns
      if (!e.active) {
        e.respawnTimer++;
        if (e.respawnTimer >= RESPAWN_TICKS) {
          e.active = true; e.hp = e.maxHp;
          e.x = e.spawnX; e.z = e.spawnZ;
          e.respawnTimer = 0; e.aggroed = false;
          changed.push(e);
        }
        return;
      }

      // Skip movement AI when no players in zone (save CPU) but reset aggro
      if (!hasPlayers) {
        if (e.aggroed) { e.aggroed = false; e.x = e.spawnX; e.z = e.spawnZ; changed.push(e); }
        return;
      }

      // Find nearest player in zone
      let nearestPlayer = null, nearestDist = Infinity;
      zonePlayers.forEach(p => {
        const dx = p.x - e.x, dz = p.z - e.z;
        const d = Math.sqrt(dx*dx + dz*dz);
        if (d < nearestDist) { nearestDist = d; nearestPlayer = p; }
      });
      if (!nearestPlayer) return;

      // Aggro check
      // a548 — the Wyvern Wastes kit forces AGG = max(aggroRange, 24) client-side, but
      //   ENEMY_STATS carries 11-15 for these types. Without this floor the server would
      //   aggro the pack noticeably later than the client ever did, and ALPHA'S CALL
      //   (which force-aggros packmates within 20u) could pull mobs that then immediately
      //   fall back out of range. Mirror the client's floor for this zone only.
      const _aggroR = ((zoneName === 'wyvernwastes' && WW_BESPOKE[e.type]) || (zoneName === 'neon_hollow' && NH_BESPOKE[e.type])
                    || (zoneName === 'xeron' && XR_BESPOKE[e.type]) || (zoneName === 'xumen' && XM_BESPOKE[e.type])
                    || (zoneName === 'xumen_fortress' && XF_BESPOKE[e.type])
                    || (zoneName === 'void_citadel' && VC_BESPOKE[e.type]))
        ? Math.max(e.aggroRange || 12, 24)
        : (zoneName === 'lucidwilde' && LW_BESPOKE[e.type])   // a554 — canopy uses a wider 28u floor
        ? Math.max(e.aggroRange || 14, 28)
        : (zoneName === 'forge' && FG_BESPOKE[e.type])        // a555 — foundry floor is 22u
        ? Math.max(e.aggroRange || 14, 22) : e.aggroRange;   // a548-a553 — those kits force a 24u floor client-side
      if (nearestDist <= _aggroR) e.aggroed = true;
      if (!e.aggroed) return;

      // a529 — this mob runs bespoke server AI? (sand types anywhere; patrol types only in patrol)
      const _bespoke = SD_BESPOKE[e.type] || (zoneName === 'patrol' && PATROL_BESPOKE[e.type]) || (zoneName === 'void' && VW_BESPOKE[e.type]) || (zoneName === 'blooming_wilds' && BW_BESPOKE[e.type]) || (zoneName === 'aviacanyon' && AV_BESPOKE[e.type]) || (zoneName === 'cemetery' && CM_BESPOKE[e.type]) || (zoneName === 'ashlands' && AL_BESPOKE[e.type]) || (zoneName === 'caves_of_despair' && CD_BESPOKE[e.type]) || (zoneName === 'citadel' && CT_BESPOKE[e.type]) || (zoneName === 'frostveil' && FZ_BESPOKE[e.type]) || (zoneName === 'ancient' && ELD_BESPOKE[e.type]) || (zoneName === 'necropolis' && NP_BESPOKE[e.type]) || (zoneName === 'veiled_sanctuary' && VS_BESPOKE[e.type]) || (zoneName === 'dragonlair' && DL_BESPOKE[e.type]) || (zoneName === 'riftvale' && RV_BESPOKE[e.type]) || (zoneName === 'wyvernwastes' && WW_BESPOKE[e.type]) || (zoneName === 'neon_hollow' && NH_BESPOKE[e.type]) || (zoneName === 'xeron' && XR_BESPOKE[e.type]) || (zoneName === 'xumen' && XM_BESPOKE[e.type]) || (zoneName === 'xumen_fortress' && XF_BESPOKE[e.type]) || (zoneName === 'void_citadel' && VC_BESPOKE[e.type]) || (zoneName === 'lucidwilde' && LW_BESPOKE[e.type]) || (zoneName === 'forge' && FG_BESPOKE[e.type]);
      // Move toward player (generic chase — bespoke mobs use their own movement below)
      if (!_bespoke && nearestDist > ATTACK_RANGE) {
        const dx = nearestPlayer.x - e.x, dz = nearestPlayer.z - e.z;
        const len = Math.sqrt(dx*dx + dz*dz) || 1;
        e.x += (dx/len) * e.spd * 1.6; // 1.6 = server tick scale
        e.z += (dz/len) * e.spd * 1.6;
        changed.push(e);
      }

      // Attack
      e.attackTimer++;
      if (!_bespoke && e.attackTimer >= ATTACK_COOLDOWN && nearestDist <= ATTACK_RANGE + 0.8) {
        e.attackTimer = 0;
        const dmg = Math.floor(e.atk * (0.85 + Math.random() * 0.3));
        // Send damage directly to the nearest player only
        players.forEach((p, ws) => {
          if (p === nearestPlayer) {
            send(ws, { type:'sv_enemy_attack', eid:e.id, dmg, ex:+e.x.toFixed(2), ez:+e.z.toFixed(2), zone:zoneName });
          }
        });
        // Broadcast attack-animation cue to ALL players in zone (no damage, just visual)
        // so party members see the mob's wind-up pose, not just the one being hit.
        broadcastToZone(game.id, zoneName, {
          type:'sv_enemy_anim', eid:e.id, a:'attack',
          ex:+e.x.toFixed(2), ez:+e.z.toFixed(2),
          tx:+nearestPlayer.x.toFixed(2), tz:+nearestPlayer.z.toFixed(2),
          zone:zoneName
        });
      }

      // ══════════════════════════════════════════════════════════
      // a519 — MULTIPLAYER MIGRATION: Sunken Sands server-authoritative kit.
      //   First ported special — the DUNE SCORPION's STINGER IMPALE. The server
      //   owns the hit test: it locks a thrust direction, telegraphs it (sv_fx),
      //   and 3 ticks (~0.3s) later tests a lead point against LIVE player
      //   positions — so a sidestep out of the committed lane avoids it. On a hit
      //   it deals damage (reused sv_enemy_attack) and commands the player-effect
      //   root+poison+flash+shake via the new sv_player_fx channel. This is the
      //   reusable spine every subsequent kit ability rides on.
      // ══════════════════════════════════════════════════════════
      if (e.type === 'sand_scorpion' && e.aggroed) {
        // ── a526: DUNE SCORPION bespoke locomotion + light attacks (ported from the
        //   client kit, re-timed 60fps->10Hz). Skitter-approach with a strafe weave,
        //   circle-strafe when point-blank, fast pincer nips (~1/s), and a scuttle
        //   sidestep dart. The stinger impale (below) is the heavy hit.
        {
          const sdx = nearestPlayer.x - e.x, sdz = nearestPlayer.z - e.z;
          const sdd = Math.sqrt(sdx*sdx + sdz*sdz) || 0.0001;
          const sSin = sdx/sdd, sCos = sdz/sdd;   // unit vector toward player
          const sPr = sCos, sPq = -sSin;          // perpendicular = strafe axis
          if (e._strafe === undefined) e._strafe = Math.random() < 0.5 ? 1 : -1;
          if (Math.random() < 0.04) e._strafe = -e._strafe;
          const MSs = 0.31;                        // ~3 u/s @10Hz (client MS 0.052/frame)
          if (sdd > 2.2) { e.x += (sSin*0.85 + sPr*e._strafe*0.5)*MSs; e.z += (sCos*0.85 + sPq*e._strafe*0.5)*MSs; }
          else           { e.x += (sPr*e._strafe)*MSs;                 e.z += (sPq*e._strafe)*MSs; }
          changed.push(e);
          // pincer nips — fast, light melee
          e._nip = (e._nip || 0) + 1;
          if (nearestDist < 2.6 && e._nip >= 9) {
            e._nip = 0;
            const ndmg = Math.floor(e.atk * 0.85);
            players.forEach((p, ws) => { if (p === nearestPlayer) send(ws, { type:'sv_enemy_attack', eid:e.id, dmg:ndmg, ex:+e.x.toFixed(2), ez:+e.z.toFixed(2), zone:zoneName }); });
            broadcastToZone(game.id, zoneName, { type:'sv_enemy_anim', eid:e.id, a:'attack', ex:+e.x.toFixed(2), ez:+e.z.toFixed(2), tx:+nearestPlayer.x.toFixed(2), tz:+nearestPlayer.z.toFixed(2), zone:zoneName });
          }
          // scuttle sidestep — darts 2.2u perpendicular when point-blank (~every 2.2s)
          e._scut = (e._scut || 0) + 1;
          if (nearestDist < 2.2 && e._scut >= 22) {
            e._scut = 0;
            const ca = Math.atan2(sdx, sdz) + 1.5708 * (Math.random() < 0.5 ? 1 : -1);
            e.x += Math.sin(ca) * 2.2; e.z += Math.cos(ca) * 2.2; // position already in `changed` from the move above
            broadcastToZone(game.id, zoneName, { type:'sv_fx', vt:'sd_scuttle', zone:zoneName, ex:+e.x.toFixed(2), ez:+e.z.toFixed(2) });
          }
        }

        if (e._sdImpFire > 0) {
          e._sdImpFire--;
          if (e._sdImpFire === 0) {
            const la = e._sdImpAng || 0;
            const hx = e.x + Math.sin(la) * 2.3, hz = e.z + Math.cos(la) * 2.3;
            // the barb strikes the ground point — everyone in the zone sees it
            broadcastToZone(game.id, zoneName, {
              type:'sv_fx', vt:'sd_stinger', zone:zoneName,
              ex:+hx.toFixed(2), ez:+hz.toFixed(2)
            });
            let victim = null;
            zonePlayers.forEach(p => {
              if (p.x === undefined) return;
              const ddx = p.x - hx, ddz = p.z - hz;
              if (ddx*ddx + ddz*ddz < 2.2*2.2) victim = p; // a524 widened hit radius
            });
            if (victim) {
              const idmg = Math.floor(e.atk * 1.3);
              players.forEach((p, ws) => {
                if (p === victim) {
                  send(ws, { type:'sv_enemy_attack', eid:e.id, dmg:idmg, ex:+e.x.toFixed(2), ez:+e.z.toFixed(2), zone:zoneName });
                  send(ws, { type:'sv_player_fx', zone:zoneName, eff:'impale', root:600, slow:0.1, status:'poison', statusDur:180, flash:'rgba(154,220,60,.42)', shake:12 }); // a521 stronger flash+shake
                }
              });
            }
          }
        } else {
          if (e._sdImpCd === undefined) e._sdImpCd = 20 + Math.floor(Math.random()*15); // a526 ~2-3.5s first
          e._sdImpCd--;
          if (e._sdImpCd <= 0) { // a524 — fire on cooldown once AGGROED; hit-test at resolve decides the hit (no fragile distance gate)
            e._sdImpCd = 28 + Math.floor(Math.random()*16); // a526 ~2.8-4.4s between impales
            e._sdImpAng = Math.atan2(nearestPlayer.x - e.x, nearestPlayer.z - e.z);
            e._sdImpFire = 5; // a521 ~0.5s telegraph (more visible)
            broadcastToZone(game.id, zoneName, {
              type:'sv_fx', vt:'sd_stinger_windup', zone:zoneName, eid:e.id,
              ex:+e.x.toFixed(2), ez:+e.z.toFixed(2)
            });
          }
        }
      }

      // ── a527: DESERT SNAKE — sidewind weave, venom spit, bite+poison, coiled strike ──
      if (e.type === 'desert_snake' && e.aggroed) {
        const dx2=nearestPlayer.x-e.x, dz2=nearestPlayer.z-e.z, dd=Math.sqrt(dx2*dx2+dz2*dz2)||0.0001;
        const s2=dx2/dd, c2=dz2/dd, pr2=c2, pq2=-s2, ang=Math.atan2(dx2,dz2);
        const MSs=0.42;
        e._sw=(e._sw||0)+1; const wob=Math.sin(e._sw*0.15)*1.2;
        if (e._co==='wind') {
          e._ct=(e._ct||0)+1;
          if (e._ct%2===0) broadcastToZone(game.id, zoneName, { type:'sv_fx', vt:'sd_motes', zone:zoneName, ex:+e.x.toFixed(2), ez:+e.z.toFixed(2), col:0x9ac832, n:2 });
          if (e._ct>=4){ e._co='go'; e._ct=0; e._cdir=ang; e._chit=0; }
        } else if (e._co==='go') {
          e._ct=(e._ct||0)+1;
          e.x+=Math.sin(e._cdir)*MSs*3.0; e.z+=Math.cos(e._cdir)*MSs*3.0; changed.push(e);
          if (nearestDist<2.4 && !e._chit){ e._chit=1; const cd=Math.floor(e.atk*1.2);
            players.forEach((p,ws)=>{ if(p===nearestPlayer){ send(ws,{type:'sv_enemy_attack',eid:e.id,dmg:cd,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),zone:zoneName}); send(ws,{type:'sv_player_fx',zone:zoneName,eff:'status',status:'poison',statusDur:150}); } });
            broadcastToZone(game.id, zoneName, { type:'sv_fx', vt:'sd_motes', zone:zoneName, ex:+nearestPlayer.x.toFixed(2), ez:+nearestPlayer.z.toFixed(2), col:0x9ac832, n:6 });
          }
          if (e._ct>=2){ e._co=0; e._ct=0; }
        } else {
          if (dd>2.0){ e.x+=(s2*0.8+pr2*wob*0.5)*MSs; e.z+=(c2*0.8+pq2*wob*0.5)*MSs; changed.push(e); }
          e._bite=(e._bite||0)+1;
          if (nearestDist<2.4 && e._bite>=8){ e._bite=0; const bd=Math.floor(e.atk*0.8);
            players.forEach((p,ws)=>{ if(p===nearestPlayer){ send(ws,{type:'sv_enemy_attack',eid:e.id,dmg:bd,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),zone:zoneName}); send(ws,{type:'sv_player_fx',zone:zoneName,eff:'status',status:'poison',statusDur:120}); } });
          }
          e._spit=(e._spit||0)+1;
          if (dd>2.5 && dd<11 && e._spit>=12){ e._spit=0; _sdSpawnProj(game, zoneName, e, ang, 0x9ac832, Math.floor(e.atk*0.6), 'plasma', 'poison', 120); }
          e._cs=(e._cs||0)+1;
          if (dd>3 && dd<8 && e._cs>=28){ e._cs=0; e._co='wind'; e._ct=0; }
        }
      }

      // ── a527: DUNE SKELETON — bone javelin, mirage step, HEAT RAY channel ──
      if (e.type === 'dune_skeleton' && e.aggroed) {
        const dx2=nearestPlayer.x-e.x, dz2=nearestPlayer.z-e.z, dd=Math.sqrt(dx2*dx2+dz2*dz2)||0.0001;
        const s2=dx2/dd, c2=dz2/dd, pr2=c2, pq2=-s2, ang=Math.atan2(dx2,dz2);
        if (e._strafe===undefined) e._strafe=Math.random()<0.5?1:-1;
        const MSs=0.19;
        if (dd>2.8){ e.x+=(s2*0.9+pr2*e._strafe*0.3)*MSs; e.z+=(c2*0.9+pq2*e._strafe*0.3)*MSs; changed.push(e); }
        e._sm=(e._sm||0)+1;
        if (nearestDist<3.0 && e._sm>=10){ e._sm=0; const md=Math.floor(e.atk*0.95);
          players.forEach((p,ws)=>{ if(p===nearestPlayer) send(ws,{type:'sv_enemy_attack',eid:e.id,dmg:md,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),zone:zoneName}); });
          broadcastToZone(game.id, zoneName, { type:'sv_fx', vt:'sd_motes', zone:zoneName, ex:+e.x.toFixed(2), ez:+e.z.toFixed(2), col:0xf0e6c8, n:3 });
        }
        e._jav=(e._jav||0)+1;
        if (dd>2.6 && dd<13 && e._jav>=13){ e._jav=0; _sdSpawnProj(game, zoneName, e, ang, 0xf0e6c8, Math.floor(e.atk*0.65), 'bolt', null, 0); }
        e._mg=(e._mg||0)+1;
        if (dd<9 && e._mg>=37){ e._mg=0;
          broadcastToZone(game.id, zoneName, { type:'sv_fx', vt:'sd_poof', zone:zoneName, ex:+e.x.toFixed(2), ez:+e.z.toFixed(2), col:0xffdf70, n:5 });
          const ma=ang+(Math.random()<0.5?1.4:-1.4); e.x+=Math.sin(ma)*3.5; e.z+=Math.cos(ma)*3.5; changed.push(e);
          broadcastToZone(game.id, zoneName, { type:'sv_fx', vt:'sd_poof', zone:zoneName, ex:+e.x.toFixed(2), ez:+e.z.toFixed(2), col:0xffdf70, n:5 });
        }
        if (e._hrOn) {
          e._hrT=(e._hrT||0)+1;
          if (e._hrT%3===0){ e._hrK=(e._hrK||0)+1;
            broadcastToZone(game.id, zoneName, { type:'sv_fx', vt:'sd_beam', zone:zoneName, eid:e.id, ex:+e.x.toFixed(2), ey:1.4, ez:+e.z.toFixed(2), tx:+nearestPlayer.x.toFixed(2), tz:+nearestPlayer.z.toFixed(2), col:(e._hrK%2?0xffdf70:0xff8c2a), w:0.16 });
            if (nearestDist<14){ const hd=Math.floor(e.atk*0.42);
              players.forEach((p,ws)=>{ if(p===nearestPlayer){ send(ws,{type:'sv_enemy_attack',eid:e.id,dmg:hd,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),zone:zoneName}); if(e._hrK===3) send(ws,{type:'sv_player_fx',zone:zoneName,eff:'status',status:'burn',statusDur:140}); } });
            }
            if (e._hrK>=4){ e._hrOn=0; e._hrK=0; e._hrT=0; }
          }
        } else {
          e._hr=(e._hr||Math.floor(Math.random()*24))+1;
          if (dd>2.5 && dd<13 && e._hr>=44){ e._hr=0; e._hrOn=1; e._hrK=0; e._hrT=0; }
        }
      }

      // ── a527: SAND MUMMY — curse melee, curse of the tomb (root), SANDSTORM SHROUD ──
      if (e.type === 'sand_mummy' && e.aggroed) {
        const dx2=nearestPlayer.x-e.x, dz2=nearestPlayer.z-e.z, dd=Math.sqrt(dx2*dx2+dz2*dz2)||0.0001;
        const s2=dx2/dd, c2=dz2/dd;
        if (e._shT>0){ e._shT--; if (e._shT<=0){ e._ssOn=0; if(e._ssBase!==undefined) e.dmgReduction=e._ssBase; } }
        const MSs = 0.144 * (e._shT>0 ? 1.6 : 1);
        if (dd>2.4){ e.x+=s2*MSs; e.z+=c2*MSs; changed.push(e); }
        e._mm=(e._mm||0)+1;
        if (nearestDist<2.8 && e._mm>=11){ e._mm=0; const md=Math.floor(e.atk*1.05);
          players.forEach((p,ws)=>{ if(p===nearestPlayer) send(ws,{type:'sv_enemy_attack',eid:e.id,dmg:md,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),zone:zoneName}); });
          broadcastToZone(game.id, zoneName, { type:'sv_fx', vt:'sd_motes', zone:zoneName, ex:+e.x.toFixed(2), ez:+e.z.toFixed(2), col:0x6a4dc8, n:4 });
        }
        e._ct2=(e._ct2||0)+1;
        if (dd>2 && dd<8 && e._ct2>=35){ e._ct2=0;
          broadcastToZone(game.id, zoneName, { type:'sv_fx', vt:'sd_beam', zone:zoneName, eid:e.id, ex:+e.x.toFixed(2), ey:1.1, ez:+e.z.toFixed(2), tx:+nearestPlayer.x.toFixed(2), tz:+nearestPlayer.z.toFixed(2), col:0xf0e6c8, w:0.22 });
          const cd=Math.floor(e.atk*0.9);
          players.forEach((p,ws)=>{ if(p===nearestPlayer){ send(ws,{type:'sv_enemy_attack',eid:e.id,dmg:cd,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),zone:zoneName}); send(ws,{type:'sv_player_fx',zone:zoneName,eff:'curse',root:900,slow:0.15}); } });
          broadcastToZone(game.id, zoneName, { type:'sv_fx', vt:'sd_motes', zone:zoneName, ex:+nearestPlayer.x.toFixed(2), ez:+nearestPlayer.z.toFixed(2), col:0x6a4dc8, n:7 });
        }
        if (!e._ssOn){
          e._ss=(e._ss||Math.floor(Math.random()*30))+1;
          if (dd<10 && e._ss>=63){ e._ss=0; e._ssOn=1; e._shT=50;
            if (e._ssBase===undefined) e._ssBase=e.dmgReduction||0;
            e.dmgReduction=Math.min(0.8, e._ssBase+0.35);
            broadcastToZone(game.id, zoneName, { type:'sv_fx', vt:'sd_shroud', zone:zoneName, eid:e.id, ex:+e.x.toFixed(2), ez:+e.z.toFixed(2) });
          }
        }
      }

      // ── a528: SAND WORM — surfaced spouts + geyser volleys, then DIVE into a
      //   racing wake and BREACH up under you. The "thing under the dunes."
      if (e.type === 'sand_worm' && e.aggroed) {
        const dx2=nearestPlayer.x-e.x, dz2=nearestPlayer.z-e.z, dd=Math.sqrt(dx2*dx2+dz2*dz2)||0.0001;
        const s2=dx2/dd, c2=dz2/dd, ang=Math.atan2(dx2,dz2);
        if (e._wk==='wake') {
          e._wt=(e._wt||0)+1;
          e.x += s2*0.66; e.z += c2*0.66; changed.push(e);   // the mound races
          if (e._wt%2===0) broadcastToZone(game.id, zoneName, { type:'sv_fx', vt:'sd_poof', zone:zoneName, ex:+e.x.toFixed(2), ez:+e.z.toFixed(2), col:0xb08d42, n:3 });
          if (dd<2.0 || e._wt>=18){ e._wk='breach'; e._wt=0;
            e.x=nearestPlayer.x; e.z=nearestPlayer.z; changed.push(e);   // surfaces under the player
            broadcastToZone(game.id, zoneName, { type:'sv_fx', vt:'sd_geyser_warn', zone:zoneName, ex:+e.x.toFixed(2), ez:+e.z.toFixed(2) });
          }
        } else if (e._wk==='breach') {
          e._wt=(e._wt||0)+1;
          if (e._wt>=5){ e._wk=0; e._wt=0;
            broadcastToZone(game.id, zoneName, { type:'sv_fx', vt:'sd_worm_surface', zone:zoneName, eid:e.id, ex:+e.x.toFixed(2), ez:+e.z.toFixed(2) });
            const bd=Math.floor(e.atk*1.4);
            zonePlayers.forEach(p=>{ if(p.x===undefined)return; const px=p.x-e.x, pz=p.z-e.z; if(px*px+pz*pz<2.8*2.8){ players.forEach((pp,ws)=>{ if(pp===p){ send(ws,{type:'sv_enemy_attack',eid:e.id,dmg:bd,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),zone:zoneName}); send(ws,{type:'sv_player_fx',zone:zoneName,eff:'shake',shake:8}); } }); } });
          }
        } else {
          if (dd>2.6){ e.x += s2*0.12; e.z += c2*0.12; changed.push(e); }
          e._wm=(e._wm||0)+1;
          if (nearestDist<3.2 && e._wm>=12){ e._wm=0; const md=Math.floor(e.atk*1.15);
            players.forEach((p,ws)=>{ if(p===nearestPlayer){ send(ws,{type:'sv_enemy_attack',eid:e.id,dmg:md,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),zone:zoneName}); send(ws,{type:'sv_player_fx',zone:zoneName,eff:'shake',shake:4}); } });
          }
          e._sp=(e._sp||0)+1;
          if (dd>2.8 && dd<13 && e._sp>=11){ e._sp=0;
            _sdSpawnProj(game, zoneName, e, ang-0.18, 0xd8b45e, Math.floor(e.atk*0.6), 'plasma', null, 0);
            _sdSpawnProj(game, zoneName, e, ang+0.18, 0xd8b45e, Math.floor(e.atk*0.6), 'plasma', null, 0);
          }
          e._gv=(e._gv||0)+1;
          if (dd>3 && dd<14 && e._gv>=37){ e._gv=0;
            if(!game._sdGeyser) game._sdGeyser=[];
            for (let gi=0; gi<3; gi++){
              const gx=nearestPlayer.x+(Math.random()-0.5)*4, gz=nearestPlayer.z+(Math.random()-0.5)*4;
              game._sdGeyser.push({ zone:zoneName, x:gx, z:gz, fuse:5+gi*3, dmg:Math.floor(e.atk*0.8), eid:e.id, col:0xd8b45e, radius:2.3 });
              broadcastToZone(game.id, zoneName, { type:'sv_fx', vt:'sd_geyser_warn', zone:zoneName, ex:+gx.toFixed(2), ez:+gz.toFixed(2) });
            }
          }
          e._wc=(e._wc||Math.floor(Math.random()*27))+1;
          if (dd>4 && dd<16 && e._wc>=50){ e._wc=0; e._wk='wake'; e._wt=0;
            broadcastToZone(game.id, zoneName, { type:'sv_fx', vt:'sd_worm_dive', zone:zoneName, eid:e.id, ex:+e.x.toFixed(2), ez:+e.z.toFixed(2) });
          }
        }
      }

      // ── a529: XU PATROL squad AI (zone-gated to 'patrol'; these types also live in
      //   other zones). Reuses the projectile / beam(laser) / telegraph / shock spine.
      //   Frame counters from the client kit are re-timed 60fps -> 10Hz (~/6).
      if (zoneName === 'patrol' && e.aggroed && PATROL_BESPOKE[e.type]) {
        const dxp=nearestPlayer.x-e.x, dzp=nearestPlayer.z-e.z, dd=Math.sqrt(dxp*dxp+dzp*dzp)||0.0001;
        const sin=dxp/dd, cos=dzp/dd, pr=cos, pq=-sin, ang=Math.atan2(dxp,dzp);
        if(e._strafe===undefined) e._strafe=Math.random()<0.5?1:-1;
        if(Math.random()<0.036) e._strafe=-e._strafe;
        const strafe=e._strafe;
        e._ab=(e._ab||0)+1;
        if(e._pmBuff>0) e._pmBuff--;
        const bspd = e._pmBuff>0 ? 1.35 : 1.0, bdmg = e._pmBuff>0 ? 1.30 : 1.0;
        let _moved=false;
        const mv=(vx,vz,sp)=>{ e.x+=vx*sp; e.z+=vz*sp; _moved=true; };
        const hit=(dmg)=>{ players.forEach((p,ws)=>{ if(p===nearestPlayer) send(ws,{type:'sv_enemy_attack',eid:e.id,dmg:dmg,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),zone:zoneName}); }); };
        const pmRally=(col)=>{ for(let ri=0;ri<zone.enemies.length;ri++){ const o=zone.enemies[ri]; if(!o||!o.active||o===e||!PATROL_BESPOKE[o.type]) continue; const odx=o.x-e.x, odz=o.z-e.z; if(odx*odx+odz*odz<196){ o._pmBuff=40; broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_beam',zone:zoneName,eid:e.id,ex:+e.x.toFixed(2),ey:1.7,ez:+e.z.toFixed(2),tx:+o.x.toFixed(2),tz:+o.z.toFixed(2),col:col,w:0.14}); } } e._pmBuff=40; };

        if(e.type==='xu_rebel'){
          const MSs=0.31;
          if(dd>3.0) mv(sin*0.7+pr*strafe*0.7, cos*0.7+pq*strafe*0.7, MSs*bspd); else mv(pr*strafe, pq*strafe, MSs*bspd);
          e._m1=(e._m1||0)+1; if(dd<3.2 && e._m1>=8){ e._m1=0; hit(_pmDmg(e,bdmg)); }
          if(dd>3 && dd<18 && e._ab>=18){ e._ab=0; e._burst=3; }
          if(e._burst>0){ e._burst--; _sdSpawnProj(game,zoneName,e,ang,0x6cff7a,_pmDmg(e,0.5*bdmg),'bolt',null,0); }
          e._roll=(e._roll||0)+1; if(dd<9 && e._roll>=25){ e._roll=0; mv(pr*strafe,pq*strafe,MSs*9); broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_poof',zone:zoneName,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),col:0x6cff7a,n:5}); }
        }
        else if(e.type==='bandit'){
          const MSs=0.35;
          if(e._lunge==='wind'){ if(e._ab>=2){ e._lunge='go'; e._ab=0; e._ldir=ang; e._lhit=0; } }
          else if(e._lunge==='go'){
            mv(Math.sin(e._ldir),Math.cos(e._ldir),MSs*2.6);
            if(dd<2.4 && !e._lhit){ e._lhit=1; hit(_pmDmg(e,1.5*bdmg)); _pmShock(game,zoneName,e,e.x,e.z,1.8,0,0xff4030,players,send); }
            if(e._ab>=2){ e._lunge=0; e._ab=0; }
          } else {
            if(dd>2.6) mv(sin*0.6+pr*strafe*0.8, cos*0.6+pq*strafe*0.8, MSs*bspd); else mv(pr*strafe, pq*strafe, MSs*bspd);
            e._m1=(e._m1||0)+1; if(dd<2.8 && e._m1>=7){ e._m1=0; hit(_pmDmg(e,bdmg)); }
            if(dd>3 && dd<14 && e._ab>=22){ e._lunge='wind'; e._ab=0; broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_motes',zone:zoneName,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),col:0xff4030,n:6}); }
          }
        }
        else if(e.type==='bandit_archer'){
          const MSs=0.30;
          if(dd<7) mv(-sin*0.8+pr*strafe*0.7,-cos*0.8+pq*strafe*0.7,MSs*bspd); else if(dd>13) mv(sin*0.6,cos*0.6,MSs*bspd); else mv(pr*strafe,pq*strafe,MSs*bspd);
          e._s1=(e._s1||0)+1; if(dd>2.5 && dd<20 && e._s1>=9){ e._s1=0; _sdSpawnProj(game,zoneName,e,ang,0xff8020,_pmDmg(e,0.7*bdmg),'bolt',null,0); }
          if(dd<22 && e._ab>=27){ e._ab=0; for(let mi=0;mi<5;mi++){ _sdSpawnProj(game,zoneName,e,ang+(mi-2)*0.16,0xff8020,_pmDmg(e,0.55*bdmg),'bolt',null,0); } }
        }
        else if(e.type==='sniper'){
          const MSs=0.20;
          if(e._rail==='aim'){
            e._rt=(e._rt||0)+1;
            broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_beam',zone:zoneName,eid:e.id,ex:+e.x.toFixed(2),ey:1.6,ez:+e.z.toFixed(2),tx:+nearestPlayer.x.toFixed(2),tz:+nearestPlayer.z.toFixed(2),col:0xff4030,w:0.04});
            if(e._rt>=7){ e._rail='fire'; e._rt=0; e._rlx=nearestPlayer.x; e._rlz=nearestPlayer.z; }
          } else if(e._rail==='fire'){
            broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_beam',zone:zoneName,eid:e.id,ex:+e.x.toFixed(2),ey:1.6,ez:+e.z.toFixed(2),tx:+e._rlx.toFixed(2),tz:+e._rlz.toFixed(2),col:0xffffff,w:0.10});
            broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_beam',zone:zoneName,eid:e.id,ex:+e.x.toFixed(2),ey:1.6,ez:+e.z.toFixed(2),tx:+e._rlx.toFixed(2),tz:+e._rlz.toFixed(2),col:0xff4030,w:0.18});
            const rdx=nearestPlayer.x-e._rlx, rdz=nearestPlayer.z-e._rlz;
            if(rdx*rdx+rdz*rdz < 4.84){ hit(_pmDmg(e,2.2*bdmg)); players.forEach((p,ws)=>{ if(p===nearestPlayer) send(ws,{type:'sv_player_fx',zone:zoneName,eff:'shake',shake:5}); }); }
            e._rail='reloc'; e._rt=0;
          } else if(e._rail==='reloc'){
            e._rt=(e._rt||0)+1; mv(pr*strafe,pq*strafe,MSs*2.2); if(e._rt>=3){ e._rail=0; e._rt=0; }
          } else {
            if(dd<10) mv(-sin*0.7,-cos*0.7,MSs*bspd); else if(dd>18) mv(sin*0.6,cos*0.6,MSs*bspd); else mv(pr*strafe*0.7,pq*strafe*0.7,MSs*bspd);
            if(dd>5 && dd<26 && e._ab>=20){ e._rail='aim'; e._ab=0; e._rt=0; broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_motes',zone:zoneName,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),col:0xff4030,n:5}); }
            e._s1=(e._s1||0)+1; if(dd<22 && e._s1>=15){ e._s1=0; _sdSpawnProj(game,zoneName,e,ang,0xff4030,_pmDmg(e,0.6*bdmg),'bolt',null,0); }
          }
        }
        else if(e.type==='wraith'){
          const MSs=0.37;
          if(dd>2.4) mv(sin*0.7+pr*strafe*0.9, cos*0.7+pq*strafe*0.9, MSs*bspd); else mv(pr*strafe, pq*strafe, MSs*bspd);
          e._m1=(e._m1||0)+1; if(dd<2.8 && e._m1>=7){ e._m1=0; hit(_pmDmg(e,bdmg)); }
          if(e._ab>=23){ e._ab=0;
            broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_poof',zone:zoneName,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),col:0xb060ff,n:12});
            const ba=ang+(Math.random()<0.5?1:-1)*1.4, br=3.5+Math.random()*2.5;
            e.x=nearestPlayer.x-Math.sin(ba)*br; e.z=nearestPlayer.z-Math.cos(ba)*br; _moved=true;
            broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_poof',zone:zoneName,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),col:0xb060ff,n:12});
          }
          e._wail=(e._wail||0)+1; if(dd<8 && e._wail>=37){ e._wail=0; _pmShock(game,zoneName,e,e.x,e.z,5,_pmDmg(e,1.2*bdmg),0xb060ff,players,send,0.55,1500); }
        }
        else if(e.type==='xu_scout'){
          const MSs=0.47, band=5;
          mv(pr*strafe + (dd>band?sin:-sin)*0.5, pq*strafe + (dd>band?cos:-cos)*0.5, MSs*bspd);
          e._m1=(e._m1||0)+1; if(dd<3.0 && e._m1>=8){ e._m1=0; hit(_pmDmg(e,bdmg)); }
          if(dd<24 && e._ab>=25){ e._ab=0; _pmTelegraph(game,zoneName,e,nearestPlayer.x,nearestPlayer.z,5,2.6,_pmDmg(e,1.0*bdmg),0x40d0ff); }
          e._rally=(e._rally||0)+1; if(e._rally>=50){ e._rally=0; pmRally(0x40d0ff); }
        }
        else if(e.type==='xu_siege_bot'){
          const MSs=0.144;
          if(dd>9) mv(sin,cos,MSs*bspd);
          e._m1=(e._m1||0)+1; if(dd<3.4 && e._m1>=12){ e._m1=0; hit(_pmDmg(e,bdmg)); }
          if(dd>4 && dd<28 && e._ab>=22){ e._ab=0; for(let mk=0;mk<3;mk++){ const mtx=nearestPlayer.x+(Math.random()-0.5)*8, mtz=nearestPlayer.z+(Math.random()-0.5)*8; _pmTelegraph(game,zoneName,e,mtx,mtz,5+mk*2,3.0,_pmDmg(e,0.9*bdmg),0xff8020); } }
          e._stomp=(e._stomp||0)+1; if(dd<5 && e._stomp>=30){ e._stomp=0; _pmShock(game,zoneName,e,e.x,e.z,5.5,_pmDmg(e,1.4*bdmg),0xffcf3a,players,send,0.6,1200); players.forEach((p,ws)=>{ if(p===nearestPlayer) send(ws,{type:'sv_player_fx',zone:zoneName,eff:'shake',shake:6}); }); }
        }
        else if(e.type==='xu_commander'){
          const MSs=0.28;
          if(dd>6) mv(sin*0.6+pr*strafe*0.6, cos*0.6+pq*strafe*0.6, MSs*bspd); else mv(pr*strafe, pq*strafe, MSs*bspd);
          e._m1=(e._m1||0)+1; if(dd<3.2 && e._m1>=9){ e._m1=0; hit(_pmDmg(e,bdmg)); }
          e._v1=(e._v1||0)+1; if(dd>3 && dd<20 && e._v1>=12){ e._v1=0; for(let ci=0;ci<3;ci++){ _sdSpawnProj(game,zoneName,e,ang+(ci-1)*0.14,0xffcf3a,_pmDmg(e,0.6*bdmg),'plasma',null,0); } }
          e._rally=(e._rally||0)+1; if(e._rally>=47){ e._rally=0; pmRally(0xffcf3a); }
          if(dd<26 && e._ab>=35){ e._ab=0; _pmTelegraph(game,zoneName,e,nearestPlayer.x,nearestPlayer.z,7,4.2,_pmDmg(e,1.8*bdmg),0xff4030); }
        }

        if(_moved) changed.push(e);
      }

      // ── a531: VOID WASTES bespoke AI (zone-gated to 'void'). Reuses the projectile /
      //   beam(laser) / telegraph / shock / rift spine. Frame counters re-timed 60->10Hz.
      if (zoneName === 'void' && e.aggroed && VW_BESPOKE[e.type]) {
        const dxp=nearestPlayer.x-e.x, dzp=nearestPlayer.z-e.z, dd=Math.sqrt(dxp*dxp+dzp*dzp)||0.0001;
        const sin=dxp/dd, cos=dzp/dd, pr=cos, pq=-sin, ang=Math.atan2(dxp,dzp);
        if(e._strafe===undefined) e._strafe=Math.random()<0.5?1:-1;
        if(Math.random()<0.036) e._strafe=-e._strafe;
        const strafe=e._strafe;
        e._ab=(e._ab||0)+1;
        let _moved=false;
        const mv=(vx,vz,sp)=>{ e.x+=vx*sp; e.z+=vz*sp; _moved=true; };
        const hit=(dmg)=>{ players.forEach((p,ws)=>{ if(p===nearestPlayer) send(ws,{type:'sv_enemy_attack',eid:e.id,dmg:dmg,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),zone:zoneName}); }); };
        const rift=(col)=>{ broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_rift',zone:zoneName,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),col:col}); };

        if(e.type==='void_stalker'){
          const MSs=0.36;
          if(e._dash==='go'){ e._dst=(e._dst||0)+1; mv(Math.sin(e._ddir),Math.cos(e._ddir),MSs*2.8);
            if(dd<2.4 && !e._dhit){ hit(_vwDmg(e,1.3)); e._dhit=1; rift(0xc850ff); }
            if(e._dst>=3){ e._dash=0; e._dst=0; } }
          else {
            if(dd>2.6) mv(sin*0.7+pr*strafe*0.7, cos*0.7+pq*strafe*0.7, MSs); else mv(pr*strafe,pq*strafe,MSs);
            e._m1=(e._m1||0)+1; if(dd<2.8 && e._m1>=7){ e._m1=0; hit(_vwDmg(e,1.0)); }
            if(dd>4 && dd<16 && e._ab>=20){ e._ab=0; e._dash='go'; e._dst=0; e._ddir=ang; e._dhit=0; rift(0x6a2cff); }
          }
        }
        else if(e.type==='void_eye'){
          const MSs=0.26;
          if(dd<8) mv(-sin*0.7+pr*strafe*0.6,-cos*0.7+pq*strafe*0.6,MSs); else if(dd>16) mv(sin*0.6,cos*0.6,MSs); else mv(pr*strafe*0.7,pq*strafe*0.7,MSs);
          e._s1=(e._s1||0)+1; if(dd<22 && e._s1>=12){ e._s1=0; for(let oi=0;oi<3;oi++) _sdSpawnProj(game,zoneName,e,ang+(oi-1)*0.18,0xc850ff,_vwDmg(e,0.6),'plasma',null,0); }
          if(e._gaze==='aim'){ e._gt=(e._gt||0)+1;
            broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_beam',zone:zoneName,eid:e.id,ex:+e.x.toFixed(2),ey:1.4,ez:+e.z.toFixed(2),tx:+nearestPlayer.x.toFixed(2),tz:+nearestPlayer.z.toFixed(2),col:0x9b30ff,w:0.05});
            if(e._gt>=7){ e._gaze='fire'; e._gt=0; e._gx=nearestPlayer.x; e._gz=nearestPlayer.z; } }
          else if(e._gaze==='fire'){
            broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_beam',zone:zoneName,eid:e.id,ex:+e.x.toFixed(2),ey:1.4,ez:+e.z.toFixed(2),tx:+e._gx.toFixed(2),tz:+e._gz.toFixed(2),col:0xe0c0ff,w:0.12});
            broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_beam',zone:zoneName,eid:e.id,ex:+e.x.toFixed(2),ey:1.4,ez:+e.z.toFixed(2),tx:+e._gx.toFixed(2),tz:+e._gz.toFixed(2),col:0x9b30ff,w:0.22});
            const gdx=nearestPlayer.x-e._gx, gdz=nearestPlayer.z-e._gz;
            if(gdx*gdx+gdz*gdz<5.76){ hit(_vwDmg(e,1.8)); players.forEach((p,ws)=>{ if(p===nearestPlayer) send(ws,{type:'sv_player_fx',zone:zoneName,eff:'shake',shake:2}); }); }
            e._gaze=0; e._gt=0; }
          else if(dd>5 && dd<24 && e._ab>=23){ e._gaze='aim'; e._ab=0; e._gt=0; broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_motes',zone:zoneName,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),col:0x9b30ff,n:5}); }
        }
        else if(e.type==='void_phantom'){
          const MSs=0.42;
          if(dd>2.4) mv(sin*0.7+pr*strafe*0.9, cos*0.7+pq*strafe*0.9, MSs); else mv(pr*strafe,pq*strafe,MSs);
          e._m1=(e._m1||0)+1; if(dd<2.8 && e._m1>=7){ e._m1=0; hit(_vwDmg(e,1.0)); }
          if(e._ab>=22){ e._ab=0; rift(0x6a2cff); const ba=ang+(Math.random()<0.5?1:-1)*1.3, br=4+Math.random()*3; e.x=nearestPlayer.x-Math.sin(ba)*br; e.z=nearestPlayer.z-Math.cos(ba)*br; _moved=true; rift(0x6a2cff); }
          e._drain=(e._drain||0)+1; if(dd<10 && e._drain>=30){ e._drain=0;
            broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_beam',zone:zoneName,eid:e.id,ex:+e.x.toFixed(2),ey:1.3,ez:+e.z.toFixed(2),tx:+nearestPlayer.x.toFixed(2),tz:+nearestPlayer.z.toFixed(2),col:0x66ff99,w:0.14});
            hit(_vwDmg(e,1.1)); players.forEach((p,ws)=>{ if(p===nearestPlayer) send(ws,{type:'sv_player_fx',zone:zoneName,eff:'slow',slow:0.6,root:1000}); });
          }
        }
        else if(e.type==='void_sentinel'){
          const MSs=0.12;
          if(dd>10) mv(sin,cos,MSs);
          e._m1=(e._m1||0)+1; if(dd<3.6 && e._m1>=13){ e._m1=0; hit(_vwDmg(e,1.0)); }
          e._s1=(e._s1||0)+1; if(dd>3 && dd<24 && e._s1>=11){ e._s1=0; for(let oi=0;oi<2;oi++) _sdSpawnProj(game,zoneName,e,ang+(oi-0.5)*0.14,0x9b30ff,_vwDmg(e,0.55),'plasma',null,0); }
          if(dd<22 && e._ab>=28){ e._ab=0;
            if(!game._sdGeyser) game._sdGeyser=[];
            game._sdGeyser.push({ zone:zoneName, x:e.x, z:e.z, fuse:7, dmg:_vwDmg(e,1.0), eid:e.id, col:0x6a2cff, radius:6, pull:3, slow:0.5, slowDur:900 });
            broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_geyser_warn',zone:zoneName,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),col:0x6a2cff});
          }
          e._nova=(e._nova||0)+1; if(dd<9 && e._nova>=37){ e._nova=0; _pmTelegraph(game,zoneName,e,e.x,e.z,7,6.0,_vwDmg(e,1.5),0x6a2cff); }
        }
        else if(e.type==='void_construct'){
          const MSs=0.20;
          if(dd>5) mv(sin*0.7+pr*strafe*0.4, cos*0.7+pq*strafe*0.4, MSs); else mv(pr*strafe,pq*strafe,MSs);
          e._m1=(e._m1||0)+1; if(dd<3.4 && e._m1>=12){ e._m1=0; hit(_vwDmg(e,1.0)); }
          e._s1=(e._s1||0)+1; if(dd>3 && dd<20 && e._s1>=10){ e._s1=0; for(let oi=0;oi<3;oi++) _sdSpawnProj(game,zoneName,e,ang+(oi-1)*0.1,0xc850ff,_vwDmg(e,0.55),'plasma',null,0); }
          if(dd<24 && e._ab>=25){ e._ab=0; for(let k=0;k<3;k++){ const tx=nearestPlayer.x+(Math.random()-0.5)*7, tz=nearestPlayer.z+(Math.random()-0.5)*7; _pmTelegraph(game,zoneName,e,tx,tz,4+k*2,2.8,_vwDmg(e,1.1),0x66ff99); } }
        }
        else if(e.type==='void_spike_horror'){
          const MSs=0.24;
          if(e._charge){ e._cst=(e._cst||0)+1;
            if(e._charge==='wind'){ if(e._cst>=3){ e._charge='go'; e._cst=0; e._cdir=ang; e._chit=0; } }
            else { mv(Math.sin(e._cdir),Math.cos(e._cdir),MSs*3.0);
              if(dd<2.6 && !e._chit){ hit(_vwDmg(e,1.4)); e._chit=1; rift(0xc850ff); }
              if(e._cst>=3){ e._charge=0; e._cst=0; } }
          } else {
            if(dd>3.0) mv(sin*0.7+pr*strafe*0.5, cos*0.7+pq*strafe*0.5, MSs); else mv(pr*strafe,pq*strafe,MSs);
            e._m1=(e._m1||0)+1; if(dd<3.4 && e._m1>=9){ e._m1=0; hit(_vwDmg(e,1.0)); }
            if(dd<14 && e._ab>=25){ e._ab=0; const N=10; for(let i=0;i<N;i++) _sdSpawnProj(game,zoneName,e,(i/N)*Math.PI*2,0xc850ff,_vwDmg(e,0.5),'plasma',null,0); rift(0xc850ff); }
            e._sc=(e._sc||0)+1; if(dd>5 && dd<16 && e._sc>=28){ e._sc=0; e._charge='wind'; e._cst=0; broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_motes',zone:zoneName,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),col:0xc850ff,n:6}); }
          }
        }
        else if(e.type==='wraith'){
          const MSs=0.35;
          if(dd>2.4) mv(sin*0.7+pr*strafe*0.8, cos*0.7+pq*strafe*0.8, MSs); else mv(pr*strafe,pq*strafe,MSs);
          e._m1=(e._m1||0)+1; if(dd<2.8 && e._m1>=7){ e._m1=0; hit(_vwDmg(e,1.0)); }
          if(e._ab>=23){ e._ab=0; rift(0x9b30ff); const ba=ang+(Math.random()<0.5?1:-1)*1.3, br=4+Math.random()*3; e.x=nearestPlayer.x-Math.sin(ba)*br; e.z=nearestPlayer.z-Math.cos(ba)*br; _moved=true; rift(0x9b30ff); }
          e._wail=(e._wail||0)+1; if(dd<8 && e._wail>=35){ e._wail=0; _pmShock(game,zoneName,e,e.x,e.z,4.5,_vwDmg(e,1.1),0x9b30ff,players,send,0.55,1400); }
        }

        if(_moved) changed.push(e);
      }

      // ── a535: BLOOMING WILDS fey-garden AI (zone-gated to 'blooming_wilds'). Reuses the
      //   projectile / beam / telegraph / cloud / shock / rift spine. Re-timed 60->10Hz.
      if (zoneName === 'blooming_wilds' && e.aggroed && BW_BESPOKE[e.type]) {
        const dxp=nearestPlayer.x-e.x, dzp=nearestPlayer.z-e.z, dd=Math.sqrt(dxp*dxp+dzp*dzp)||0.0001;
        const sin=dxp/dd, cos=dzp/dd, pr=cos, pq=-sin, ang=Math.atan2(dxp,dzp);
        if(e._strafe===undefined) e._strafe=Math.random()<0.5?1:-1;
        if(Math.random()<0.03) e._strafe=-e._strafe;
        const strafe=e._strafe;
        e._ab=(e._ab||0)+1;
        if(e._bwHealCD>0) e._bwHealCD--;
        let _moved=false;
        const mv=(vx,vz,sp)=>{ e.x+=vx*sp; e.z+=vz*sp; _moved=true; };
        const hit=(dmg)=>{ players.forEach((p,ws)=>{ if(p===nearestPlayer) send(ws,{type:'sv_enemy_attack',eid:e.id,dmg:dmg,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),zone:zoneName}); }); };
        const shoot=(baseAng,col,mult,kind,spread,count)=>{ for(let i=0;i<count;i++){ const a=baseAng+(count>1?(i-(count-1)/2)*spread:0); _sdSpawnProj(game,zoneName,e,a,col,_bwDmg(e,mult),kind,null,0); } };
        const tele=(tx,tz,fuse,radius,mult,col,slow,slowDur)=>{ if(!game._sdGeyser) game._sdGeyser=[]; game._sdGeyser.push({ zone:zoneName, x:tx, z:tz, fuse:fuse, dmg:_bwDmg(e,mult), eid:e.id, col:col, radius:radius, slow:(slow||0), slowDur:(slowDur||1000) }); broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_geyser_warn',zone:zoneName,ex:+tx.toFixed(2),ez:+tz.toFixed(2),col:col}); };
        const bwCloud=(tx,tz,ticks,mult,col,slow,poison)=>{ if(!game._sdGeyser) game._sdGeyser=[]; broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_geyser_warn',zone:zoneName,ex:+tx.toFixed(2),ez:+tz.toFixed(2),col:col}); for(let i=0;i<ticks;i++){ game._sdGeyser.push({ zone:zoneName, x:tx, z:tz, fuse:3+i*3, dmg:_bwDmg(e,mult), eid:e.id, col:col, radius:3.4, soft:1, slow:(slow||0), slowDur:400, status:(poison?'poison':null), statusDur:120 }); } };
        const bwBlink=()=>{ broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_rift',zone:zoneName,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),col:0xff44aa}); const a=ang+(Math.random()<0.5?1:-1)*1.4, r=4+Math.random()*3; e.x=nearestPlayer.x-Math.sin(a)*r; e.z=nearestPlayer.z-Math.cos(a)*r; _moved=true; broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_rift',zone:zoneName,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),col:0xff44aa}); };
        const bwPull=()=>{ broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_beam',zone:zoneName,eid:e.id,ex:+e.x.toFixed(2),ey:0.8,ez:+e.z.toFixed(2),tx:+nearestPlayer.x.toFixed(2),tz:+nearestPlayer.z.toFixed(2),col:0x6cff7a,w:0.16}); players.forEach((p,ws)=>{ if(p===nearestPlayer){ send(ws,{type:'sv_player_fx',zone:zoneName,eff:'pull',px:+e.x.toFixed(2),pz:+e.z.toFixed(2),pull:1.6}); send(ws,{type:'sv_player_fx',zone:zoneName,eff:'slow',slow:0.0,root:600}); if(dd<5) send(ws,{type:'sv_enemy_attack',eid:e.id,dmg:_bwDmg(e,0.9),ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),zone:zoneName}); } }); };
        const feyBless=()=>{ let best=null, bestFrac=0.6; for(let i=0;i<zone.enemies.length;i++){ const o=zone.enemies[i]; if(!o||!o.active||o===e||!BW_BESPOKE[o.type]) continue; if((o._bwHealCD||0)>0) continue; if(Math.hypot(o.x-e.x,o.z-e.z)>12) continue; const fr=o.hp/o.maxHp; if(fr<bestFrac){ bestFrac=fr; best=o; } } if(best){ best.hp=Math.min(best.maxHp, best.hp+Math.floor(best.maxHp*0.03)); best._bwHealCD=20; changed.push(best); broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_beam',zone:zoneName,eid:e.id,ex:+e.x.toFixed(2),ey:1.4,ez:+e.z.toFixed(2),tx:+best.x.toFixed(2),tz:+best.z.toFixed(2),col:0x6cff7a,w:0.12}); } };

        if(e.type==='bloom_sprite'){ const MSs=0.35;
          mv(pr*strafe+(dd>5?sin:-sin)*0.5+(Math.random()-0.5)*0.3, pq*strafe+(dd>5?cos:-cos)*0.5+(Math.random()-0.5)*0.3, MSs);
          e._m1=(e._m1||0)+1; if(dd<2.6 && e._m1>=9){ e._m1=0; hit(_bwDmg(e,0.8)); broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_motes',zone:zoneName,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),col:0xff88cc,n:4}); }
          if(dd>2.5 && dd<16 && e._ab>=15){ e._ab=0; shoot(ang,0xff88cc,0.55,'plasma',0.22,3); }
        }
        else if(e.type==='glimmer_fairy'){ const MSs=0.40;
          if(dd<6) mv(-sin*0.8+pr*strafe*0.7,-cos*0.8+pq*strafe*0.7,MSs); else if(dd>12) mv(sin*0.6,cos*0.6,MSs); else mv(pr*strafe,pq*strafe,MSs);
          e._s1=(e._s1||0)+1; if(dd>2.5 && dd<18 && e._s1>=8){ e._s1=0; shoot(ang,0xffe060,0.6,'plasma',0,1); }
          if(e._ab>=22){ e._ab=0; bwBlink(); }
          e._hex=(e._hex||7)+1; if(dd<20 && e._hex>=33){ e._hex=0; tele(nearestPlayer.x,nearestPlayer.z,6,2.4,1.1,0xffe060,0.5,1400); }
          if(e._bless===undefined) e._bless=Math.floor(Math.random()*80);
          e._bless++; if(e._bless>=80){ e._bless=0; feyBless(); }
        }
        else if(e.type==='mushroom_brute'){ const MSs=0.144;
          if(dd>3.2) mv(sin,cos,MSs);
          e._m1=(e._m1||0)+1; if(dd<3.6 && e._m1>=13){ e._m1=0; hit(_bwDmg(e,1.0)); }
          if(dd<22 && e._ab>=25){ e._ab=0; bwCloud(nearestPlayer.x,nearestPlayer.z,8,0.45,0x88ff44,0.7,true); }
          e._slam=(e._slam||7)+1; if(dd<5 && e._slam>=28){ e._slam=0; tele(e.x,e.z,6,2.88,1.4,0xccaa66,0,0); players.forEach((p,ws)=>{ if(p===nearestPlayer) send(ws,{type:'sv_player_fx',zone:zoneName,eff:'shake',shake:3}); }); }
          e._lob=(e._lob||0)+1; if(dd>5 && dd<20 && e._lob>=18){ e._lob=0; shoot(ang,0x88ff44,0.7,'plasma',0,1); }
        }
        else if(e.type==='pollen_wraith'){ const MSs=0.29;
          if(dd<7) mv(-sin*0.6+pr*strafe*0.8,-cos*0.6+pq*strafe*0.8,MSs); else mv(pr*strafe*0.9+sin*0.3,pq*strafe*0.9+cos*0.3,MSs);
          e._s1=(e._s1||0)+1; if(dd>2.5 && dd<18 && e._s1>=10){ e._s1=0; shoot(ang,0xb060ff,0.55,'plasma',0.12,2); }
          if(dd<20 && e._ab>=23){ e._ab=0; bwCloud(nearestPlayer.x,nearestPlayer.z,7,0.4,0xb060ff,0.55,false); }
          e._drift=(e._drift||8)+1; if(e._drift>=35){ e._drift=0; bwBlink(); }
        }
        else if(e.type==='thorn_knight'){ const MSs=0.24;
          if(e._charge){ e._cst=(e._cst||0)+1;
            if(e._charge==='wind'){ if(e._cst>=3){ e._charge='go'; e._cst=0; e._cdir=ang; e._chit=0; } }
            else { mv(Math.sin(e._cdir),Math.cos(e._cdir),MSs*3.0);
              if(dd<2.6 && !e._chit){ hit(_bwDmg(e,1.5)); e._chit=1; _pmShock(game,zoneName,e,e.x,e.z,2.2,0,0x6cff7a,players,send); }
              if(e._cst>=3){ e._charge=0; e._cst=0; } }
          } else {
            if(dd>3.0) mv(sin*0.7+pr*strafe*0.5,cos*0.7+pq*strafe*0.5,MSs); else mv(pr*strafe,pq*strafe,MSs);
            e._m1=(e._m1||0)+1; if(dd<3.6 && e._m1>=10){ e._m1=0; hit(_bwDmg(e,1.0)); }
            e._vw=(e._vw||0)+1; if(dd>3 && dd<9 && e._vw>=20){ e._vw=0; bwPull(); }
            e._nova=(e._nova||0)+1; if(dd<8 && e._nova>=33){ e._nova=0; tele(e.x,e.z,6,3.6,1.3,0x6cff7a,0,0); }
            e._tc=(e._tc||0)+1; if(dd>5 && dd<16 && e._tc>=30){ e._tc=0; e._charge='wind'; e._cst=0; broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_motes',zone:zoneName,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),col:0x6cff7a,n:6}); }
          }
        }
        else if(e.type==='vine_stalker'){ const MSs=0.34;
          if(dd>2.8) mv(sin*0.7+pr*strafe*0.7,cos*0.7+pq*strafe*0.7,MSs); else mv(pr*strafe,pq*strafe,MSs);
          e._m1=(e._m1||0)+1; if(dd<3.0 && e._m1>=8){ e._m1=0; hit(_bwDmg(e,1.0)); }
          e._grab=(e._grab||5)+1; if(dd>3 && dd<11 && e._grab>=22){ e._grab=0; bwPull(); }
          e._lash=(e._lash||0)+1; if(dd>3 && dd<15 && e._lash>=12){ e._lash=0; shoot(ang,0x6cff7a,0.6,'bolt',0,1); }
        }

        if(_moved) changed.push(e);
      }

      // ── a537: AVIA CANYON cyber-birds — SERVER-AUTHORITATIVE with real MAZE COLLISION.
      //   The server owns x/z + abilities + wingguard's shield dmgReduction. Flight ALTITUDE
      //   (hover/dive) is rendered client-side (server birds carry no y). mvA() collides against
      //   the embedded canyon grid exactly like the client's walkableR, so birds respect cliffs.
      //   Re-timed 60->10Hz; speeds use e.spd*6 to match the client's per-frame velocity.
      if (zoneName === 'aviacanyon' && e.aggroed && AV_BESPOKE[e.type]) {
        const dxp=nearestPlayer.x-e.x, dzp=nearestPlayer.z-e.z, dd=Math.sqrt(dxp*dxp+dzp*dzp)||0.0001;
        const sinp=dxp/dd, cosp=dzp/dd, ang=Math.atan2(dxp,dzp);
        const SP=e.spd*6;
        e._ab=(e._ab||0)+1;   // a556 — attackTimer is incremented by the generic enemy loop
          //   above (it runs for bespoke mobs too); incrementing it here as well ran every
          //   %-based attack check in this zone off a counter advancing 2 per tick.
        let _moved=false;
        const mvA=(vx,vz,sp)=>{ const nx=e.x+vx*sp, nz=e.z+vz*sp; if(_aviaWalkable(nx,nz,0.3)){ e.x=nx; e.z=nz; _moved=true; } };
        const hitA=(dmg)=>{ players.forEach((p,ws)=>{ if(p===nearestPlayer) send(ws,{type:'sv_enemy_attack',eid:e.id,dmg:dmg,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),zone:zoneName}); }); };

        if(e.type==='skyscout'){
          // RANGED KITER — holds range, strafes, 3-round feather-dart burst
          if(dd<9) mvA(-sinp,-cosp,SP);
          else if(dd>15) mvA(sinp,cosp,SP*0.85);
          else mvA(cosp,-sinp,SP*0.5);
          if(dd<20 && e._ab>=13){ e._ab=0; e._burst=3; }
          if(e._burst>0 && e.attackTimer%2===0){ e._burst--; const a=ang+(Math.random()-0.5)*0.10; _sdSpawnProj(game,zoneName,e,a,0x5ce4f0,_avDmg(e,0.8),'plasma',null,0); }
        }
        else if(e.type==='beakdrone'){
          // MELEE CHARGER — fast pecks + lunge-peck on a cd
          if(e._lunge==='wind'){ if(e._ab>=2){ e._lunge='go'; e._ab=0; e._ldir=ang; e._lhit=0; } }
          else if(e._lunge==='go'){
            mvA(Math.sin(e._ldir),Math.cos(e._ldir),SP*3.2);
            if(dd<1.9 && !e._lhit){ hitA(_avDmg(e,1.4)); e._lhit=1; _pmShock(game,zoneName,e,e.x,e.z,1.8,0,0xffc24a,players,send); }
            if(e._ab>=3){ e._lunge=null; e._ab=0; }
          } else {
            if(dd>2.0) mvA(sinp,cosp,SP);
            if(dd<2.4 && e.attackTimer%7===0){ hitA(_avDmg(e,1.0)); }
            if(dd<13 && e._ab>=25){ e._lunge='wind'; e._ab=0; }
          }
        }
        else if(e.type==='wingguard'){
          // SHIELD-CYCLER TANK — guard (near-immune, advances) -> drop guard (punish window) -> bash.
          //   Server owns e.dmgReduction; hits resolve against it in sv_hit_enemy.
          if(e._gp===undefined){ e._gp='guard'; e._gt=0; e.dmgReduction=0.85; }
          e._gt++;
          if(e._gp==='guard'){
            if(dd>2.4) mvA(sinp,cosp,SP*1.4);
            if(e._gt>=28 && dd<6){ e._gp='wind'; e._gt=0; }
          } else if(e._gp==='wind'){
            e.dmgReduction=0.10;
            if(e._gt>=4){ e._gp='bash'; e._gt=0; e._bhit=0; e._bdir=ang; }
          } else {
            mvA(Math.sin(e._bdir),Math.cos(e._bdir),SP*2.6);
            if(dd<2.6 && !e._bhit){ hitA(_avDmg(e,1.6)); e._bhit=1; _pmShock(game,zoneName,e,e.x,e.z,2.4,0,0x46d8e6,players,send); }
            if(e._gt>=4){ e._gp='guard'; e._gt=0; e.dmgReduction=0.85; }
          }
        }
        else { // spiraldive — AERIAL DIVE-BOMBER (altitude cue sent to client)
          if(e._dive==='wind'){
            if(e._ab>=3){ e._dive='go'; e._ab=0; e._ddir=ang; e._dhit=0; e._dtx=nearestPlayer.x; e._dtz=nearestPlayer.z;
              broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'av_dive',zone:zoneName,eid:e.id,dur:900}); }
          } else if(e._dive==='go'){
            const tdx=e._dtx-e.x, tdz=e._dtz-e.z, td=Math.hypot(tdx,tdz)||0.001;
            mvA(tdx/td, tdz/td, SP*3.6);
            if((dd<2.2||td<1.4) && !e._dhit){ hitA(_avDmg(e,1.5)); e._dhit=1; _pmShock(game,zoneName,e,e.x,e.z,2.2,0,0x6ceaff,players,send); }
            if(td<1.2 || e._ab>=4){ e._dive='rise'; e._ab=0; }
          } else if(e._dive==='rise'){
            mvA(-sinp,-cosp,SP*1.2);
            if(e._ab>=3){ e._dive=null; e._ab=0; }
          } else {
            if(dd>11) mvA(sinp,cosp,SP*0.9);
            else mvA(cosp,-sinp,SP*0.8);
            if(dd<16 && e._ab>=20){ e._dive='wind'; e._ab=0; }
          }
        }
        if(_moved) changed.push(e);
      }

      // ── a538: XU CEMETERY necro AI (zone-gated to 'cemetery'). Full undead kit ported to
      //   the shared projectile / beam / telegraph / cloud / shock / rift spine. Re-timed 60->10Hz.
      if (zoneName === 'cemetery' && e.aggroed && CM_BESPOKE[e.type]) {
        const dxp=nearestPlayer.x-e.x, dzp=nearestPlayer.z-e.z, dd=Math.sqrt(dxp*dxp+dzp*dzp)||0.0001;
        const sin=dxp/dd, cos=dzp/dd, pr=cos, pq=-sin, ang=Math.atan2(dxp,dzp);
        const _CMB=0xe8e0c8, _CMN=0x55dd55, _CMT=0x9aff5a, _CMS=0x88ffe0, _CMD=0x7a3a9a;
        if(e._strafe===undefined) e._strafe=Math.random()<0.5?1:-1;
        if(Math.random()<0.03) e._strafe=-e._strafe;
        const strafe=e._strafe;
        e._ab=(e._ab||0)+1;   // a556 — attackTimer is incremented by the generic enemy loop
          //   above (it runs for bespoke mobs too); incrementing it here as well ran every
          //   %-based attack check in this zone off a counter advancing 2 per tick.
        let _moved=false;
        const mv=(vx,vz,sp)=>{ e.x+=vx*sp; e.z+=vz*sp; _moved=true; };
        const hit=(dmg)=>{ players.forEach((p,ws)=>{ if(p===nearestPlayer) send(ws,{type:'sv_enemy_attack',eid:e.id,dmg:dmg,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),zone:zoneName}); }); };
        const shoot=(baseAng,col,mult,kind,spread,count,status,sdur)=>{ for(let i=0;i<count;i++){ const a=baseAng+(count>1?(i-(count-1)/2)*spread:0); _sdSpawnProj(game,zoneName,e,a,col,_cmDmgS(e,mult),kind,(status||null),(sdur||0)); } };
        const tele=(tx,tz,fuse,radius,mult,col,slow,slowDur)=>{ if(!game._sdGeyser) game._sdGeyser=[]; game._sdGeyser.push({ zone:zoneName, x:tx, z:tz, fuse:fuse, dmg:_cmDmgS(e,mult), eid:e.id, col:col, radius:radius, slow:(slow||0), slowDur:(slowDur||1000) }); broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_geyser_warn',zone:zoneName,ex:+tx.toFixed(2),ez:+tz.toFixed(2),col:col}); };
        // CURSED GROUND — lingering necro DoT + slow (soft cloud, like the wilds spore clouds)
        const cmCloud=(tx,tz,ticks,mult,col)=>{ if(!game._sdGeyser) game._sdGeyser=[]; broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_geyser_warn',zone:zoneName,ex:+tx.toFixed(2),ez:+tz.toFixed(2),col:col}); for(let i=0;i<ticks;i++){ game._sdGeyser.push({ zone:zoneName, x:tx, z:tz, fuse:3+i*3, dmg:_cmDmgS(e,mult), eid:e.id, col:col, radius:3.4, soft:1, slow:0.6, slowDur:400 }); } };
        // GRAVE GRASP — skeletal hands erupt under the player: telegraphed root + damage
        const cmGrab=()=>{ if(!game._sdGeyser) game._sdGeyser=[]; game._sdGeyser.push({ zone:zoneName, x:nearestPlayer.x, z:nearestPlayer.z, fuse:5, dmg:_cmDmgS(e,1.0), eid:e.id, col:_CMN, radius:2.2, slow:0.0, slowDur:700 }); broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_geyser_warn',zone:zoneName,ex:+nearestPlayer.x.toFixed(2),ez:+nearestPlayer.z.toFixed(2),col:_CMN}); };
        // BLINK — soul-burst teleport to a flank
        const cmBlink=()=>{ broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_rift',zone:zoneName,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),col:_CMS}); const a=ang+(Math.random()<0.5?1:-1)*1.3, r=4+Math.random()*3; e.x=nearestPlayer.x-Math.sin(a)*r; e.z=nearestPlayer.z-Math.cos(a)*r; _moved=true; broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_rift',zone:zoneName,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),col:_CMS}); };

        if(e.type==='skeleton_warrior'){
          // BONE-SLASH · BONE TOSS · RATTLING CHARGE
          const MS=0.24;
          if(e._charge){ e._cst=(e._cst||0)+1;
            if(e._charge==='wind'){ if(e._cst>=3){ e._charge='go'; e._cst=0; e._cdir=ang; e._chit=0; } }
            else { mv(Math.sin(e._cdir),Math.cos(e._cdir),MS*2.6);
              if(dd<2.4 && !e._chit){ hit(_cmDmgS(e,1.3)); e._chit=1; _pmShock(game,zoneName,e,e.x,e.z,2.2,0,_CMB,players,send); }
              if(e._cst>=3){ e._charge=0; e._cst=0; } }
          } else {
            if(dd>2.6) mv(sin*0.7+pr*strafe*0.5, cos*0.7+pq*strafe*0.5, MS); else mv(pr*strafe,pq*strafe,MS);
            if(dd<2.8 && e.attackTimer%8===0){ hit(_cmDmgS(e,1.0)); }
            if(dd>3 && dd<16 && e.attackTimer%12===0){ shoot(ang,_CMB,0.55,'bolt',0.08,2); }
            e._rc=(e._rc||0)+1; if(dd>5 && dd<14 && e._rc>=27){ e._rc=0; e._charge='wind'; e._cst=0; broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_motes',zone:zoneName,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),col:_CMB,n:6}); }
          }
        }
        else if(e.type==='bone_mage'){
          // NECROTIC BOLTS · BONE SPIKE FIELD (3 staggered) · SOUL DRAIN (beam + slow)
          const MS=0.18;
          if(dd<7) mv(-sin*0.8+pr*strafe*0.6,-cos*0.8+pq*strafe*0.6,MS);
          else if(dd>15) mv(sin*0.6,cos*0.6,MS);
          else mv(pr*strafe*0.7,pq*strafe*0.7,MS);
          if(dd>2.5 && dd<20 && e.attackTimer%9===0){ shoot(ang,_CMN,0.6,'plasma',0.12,2); }
          if(dd<24 && e._ab>=25){ e._ab=0;
            for(let k=0;k<3;k++){ const tx=nearestPlayer.x+(Math.random()-0.5)*7, tz=nearestPlayer.z+(Math.random()-0.5)*7; tele(tx,tz,5+k*2,2.6,1.0,_CMB,0,0); } }
          e._drain=(e._drain||10)+1; if(dd<12 && e._drain>=35){ e._drain=0;
            broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_beam',zone:zoneName,eid:e.id,ex:+e.x.toFixed(2),ey:1.3,ez:+e.z.toFixed(2),tx:+nearestPlayer.x.toFixed(2),tz:+nearestPlayer.z.toFixed(2),col:_CMS,w:0.14});
            players.forEach((p,ws)=>{ if(p===nearestPlayer){ send(ws,{type:'sv_enemy_attack',eid:e.id,dmg:_cmDmgS(e,1.1),ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),zone:zoneName}); send(ws,{type:'sv_player_fx',zone:zoneName,eff:'slow',slow:0.6,root:1100}); } }); }
        }
        else if(e.type==='grave_crawler'){
          // FAST ERRATIC · ICHOR SPIT (poison) · GRAVE GRASP (root)
          const MS=0.40;
          if(dd>2.6) mv(sin*0.7+pr*strafe*0.8+(Math.random()-0.5)*0.2, cos*0.7+pq*strafe*0.8+(Math.random()-0.5)*0.2, MS);
          else mv(pr*strafe,pq*strafe,MS);
          if(dd<2.8 && e.attackTimer%7===0){ hit(_cmDmgS(e,1.0)); }
          if(dd>3 && dd<14 && e.attackTimer%13===0){ shoot(ang,_CMT,0.55,'plasma',0,1,'poison',150); }
          e._grasp=(e._grasp||5)+1; if(dd>3 && dd<12 && e._grasp>=23){ e._grasp=0; cmGrab(); }
        }
        else if(e.type==='death_knight'){
          // DEATH-CLEAVE · CURSED GROUND · DARK PULSE · UNHOLY CHARGE
          const MS=0.204;
          if(e._charge){ e._cst=(e._cst||0)+1;
            if(e._charge==='wind'){ if(e._cst>=3){ e._charge='go'; e._cst=0; e._cdir=ang; e._chit=0; } }
            else { mv(Math.sin(e._cdir),Math.cos(e._cdir),MS*3.0);
              if(dd<2.6 && !e._chit){ hit(_cmDmgS(e,1.5)); e._chit=1; _pmShock(game,zoneName,e,e.x,e.z,2.4,0,_CMD,players,send); }
              if(e._cst>=3){ e._charge=0; e._cst=0; } }
          } else {
            if(dd>3.0) mv(sin*0.7+pr*strafe*0.4, cos*0.7+pq*strafe*0.4, MS); else mv(pr*strafe,pq*strafe,MS);
            if(dd<3.6 && e.attackTimer%10===0){ hit(_cmDmgS(e,1.0)); }
            if(dd<20 && e._ab>=25){ e._ab=0; cmCloud(nearestPlayer.x, nearestPlayer.z, 7, 0.4, _CMN); }
            e._pulse=(e._pulse||10)+1; if(dd<8 && e._pulse>=33){ e._pulse=0; tele(e.x,e.z,6,5.0,1.3,_CMD,0,0); players.forEach((p,ws)=>{ if(p===nearestPlayer) send(ws,{type:'sv_player_fx',zone:zoneName,eff:'shake',shake:3}); }); }
            e._uc=(e._uc||0)+1; if(dd>5 && dd<16 && e._uc>=30){ e._uc=0; e._charge='wind'; e._cst=0; broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_motes',zone:zoneName,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),col:_CMD,n:6}); }
          }
        }
        else { // wraith — GRAVE WRAITH: blink + SOUL WAIL (slow)
          const MS=0.336;
          if(dd>2.4) mv(sin*0.7+pr*strafe*0.8, cos*0.7+pq*strafe*0.8, MS); else mv(pr*strafe,pq*strafe,MS);
          if(dd<2.8 && e.attackTimer%7===0){ hit(_cmDmgS(e,1.0)); }
          if(e._ab>=23){ e._ab=0; cmBlink(); }
          e._wail=(e._wail||8)+1; if(dd<8 && e._wail>=35){ e._wail=0; _pmShock(game,zoneName,e,e.x,e.z,4.5,_cmDmgS(e,1.1),_CMS,players,send,0.55,1400); }
        }

        if(_moved) changed.push(e);
      }

      // ── a539: THE ASHLANDS fire/volcanic AI (zone-gated to 'ashlands'). Full lava kit on the
      //   shared projectile / telegraph / pool / shock spine, with burn DoT. Re-timed 60->10Hz.
      if (zoneName === 'ashlands' && e.aggroed && AL_BESPOKE[e.type]) {
        const dxp=nearestPlayer.x-e.x, dzp=nearestPlayer.z-e.z, dd=Math.sqrt(dxp*dxp+dzp*dzp)||0.0001;
        const sin=dxp/dd, cos=dzp/dd, pr=cos, pq=-sin, ang=Math.atan2(dxp,dzp);
        const _ALL=0xff5a1e, _ALF=0xff8c1a, _ALE=0xffd24a, _ALD=0xcc2200;
        if(e._strafe===undefined) e._strafe=Math.random()<0.5?1:-1;
        if(Math.random()<0.03) e._strafe=-e._strafe;
        const strafe=e._strafe;
        e._ab=(e._ab||0)+1;   // a556 — attackTimer is incremented by the generic enemy loop
          //   above (it runs for bespoke mobs too); incrementing it here as well ran every
          //   %-based attack check in this zone off a counter advancing 2 per tick.
        let _moved=false;
        const mv=(vx,vz,sp)=>{ e.x+=vx*sp; e.z+=vz*sp; _moved=true; };
        // melee/ability hit that also applies BURN
        const hitB=(dmg,burnDur)=>{ players.forEach((p,ws)=>{ if(p===nearestPlayer){ send(ws,{type:'sv_enemy_attack',eid:e.id,dmg:dmg,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),zone:zoneName}); if(burnDur) send(ws,{type:'sv_player_fx',zone:zoneName,eff:'status',status:'burn',statusDur:burnDur}); } }); };
        const shoot=(baseAng,col,mult,kind,spread,count)=>{ for(let i=0;i<count;i++){ const a=baseAng+(count>1?(i-(count-1)/2)*spread:0); _sdSpawnProj(game,zoneName,e,a,col,_alDmgS(e,mult),kind,'burn',90); } };
        // ERUPTION — telegraphed ground slam / meteor
        const erupt=(tx,tz,fuse,radius,mult)=>{ if(!game._sdGeyser) game._sdGeyser=[]; game._sdGeyser.push({ zone:zoneName, x:tx, z:tz, fuse:fuse, dmg:_alDmgS(e,mult), eid:e.id, col:_ALL, radius:radius, status:'burn', statusDur:150 }); broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_geyser_warn',zone:zoneName,ex:+tx.toFixed(2),ez:+tz.toFixed(2),col:_ALL}); };
        // LAVA POOL — lingering burn DoT patch (soft, like the spore/cursed clouds)
        const pool=(tx,tz,ticks,mult)=>{ if(!game._sdGeyser) game._sdGeyser=[]; broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_geyser_warn',zone:zoneName,ex:+tx.toFixed(2),ez:+tz.toFixed(2),col:_ALL}); for(let i=0;i<ticks;i++){ game._sdGeyser.push({ zone:zoneName, x:tx, z:tz, fuse:3+i*3, dmg:_alDmgS(e,mult), eid:e.id, col:_ALL, radius:3.0, soft:1, status:'burn', statusDur:90 }); } };
        const alBlink=()=>{ broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_rift',zone:zoneName,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),col:_ALF}); const a=ang+(Math.random()<0.5?1:-1)*1.3, r=4+Math.random()*3; e.x=nearestPlayer.x-Math.sin(a)*r; e.z=nearestPlayer.z-Math.cos(a)*r; _moved=true; broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_rift',zone:zoneName,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),col:_ALF}); };

        if(e.type==='ash_wraith'){
          // EMBER BARRAGE · ASH BLINK · IGNITING TOUCH
          const MS=0.312;
          if(dd>2.4) mv(sin*0.7+pr*strafe*0.8, cos*0.7+pq*strafe*0.8, MS); else mv(pr*strafe,pq*strafe,MS);
          if(dd<2.8 && e.attackTimer%7===0){ hitB(_alDmgS(e,1.0),120); }
          if(dd>3 && dd<18 && e.attackTimer%12===0){ shoot(ang,_ALF,0.6,'plasma',0.18,3); }
          if(e._ab>=22){ e._ab=0; alBlink(); }
        }
        else if(e.type==='berserker'){
          // FLAME CHARGE (lays a lava trail) · FIRE WHIRLWIND · LOW-HP ENRAGE
          const enr = (e.hp>0 && e.maxHp>0 && e.hp/e.maxHp < 0.35);
          const MS = 0.396 * (enr?1.25:1);
          if(e._charge){ e._cst=(e._cst||0)+1;
            if(e._charge==='wind'){ if(e._cst>=2){ e._charge='go'; e._cst=0; e._cdir=ang; e._chit=0; } }
            else { mv(Math.sin(e._cdir),Math.cos(e._cdir),MS*2.8);
              if(e._cst%1===0) pool(e.x, e.z, 3, 0.35);                       // burning trail
              if(dd<2.5 && !e._chit){ hitB(_alDmgS(e,1.4),150); e._chit=1; _pmShock(game,zoneName,e,e.x,e.z,2.4,0,_ALL,players,send); }
              if(e._cst>=3){ e._charge=0; e._cst=0; } }
          } else {
            if(dd>2.6) mv(sin*0.8+pr*strafe*0.5, cos*0.8+pq*strafe*0.5, MS); else mv(pr*strafe,pq*strafe,MS);
            if(dd<2.8 && e.attackTimer%(enr?5:7)===0){ hitB(_alDmgS(e,1.0),0); }
            if(dd<4 && e._ab>=18){ e._ab=0; _pmShock(game,zoneName,e,e.x,e.z,4.0,(dd<4.5?_alDmgS(e,1.2):0),_ALF,players,send); if(dd<4.5) players.forEach((p,ws)=>{ if(p===nearestPlayer) send(ws,{type:'sv_player_fx',zone:zoneName,eff:'status',status:'burn',statusDur:120}); }); }
            e._fc=(e._fc||0)+1; if(dd>5 && dd<18 && e._fc>=23){ e._fc=0; e._charge='wind'; e._cst=0; broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_motes',zone:zoneName,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),col:_ALL,n:6}); }
          }
        }
        else if(e.type==='lava_golem'){
          // GROUND ERUPTION · LOBBED MAGMA BOMB -> LAVA POOL
          const MS=0.12;
          if(dd>3.5) mv(sin,cos,MS);
          if(dd<4.0 && e.attackTimer%13===0){ hitB(_alDmgS(e,1.0),0); }
          if(dd<4.5 && e._ab>=20){ e._ab=0; erupt(e.x,e.z,5,4.5,1.3); players.forEach((p,ws)=>{ if(p===nearestPlayer) send(ws,{type:'sv_player_fx',zone:zoneName,eff:'shake',shake:3}); }); }
          e._bomb=(e._bomb||8)+1; if(dd>4 && dd<22 && e._bomb>=25){ e._bomb=0;
            const tx=nearestPlayer.x+(Math.random()-0.5)*3, tz=nearestPlayer.z+(Math.random()-0.5)*3;
            shoot(ang,_ALL,0.5,'bolt',0,1);
            pool(tx,tz,9,0.4); }
        }
        else { // magma_crab — LAVA-SPIT FAN · SHELL SLAM · MOLTEN-BURST NOVA
          const MS=0.144;
          if(dd>3.2) mv(sin*0.8+pr*strafe*0.3, cos*0.8+pq*strafe*0.3, MS); else mv(pr*strafe*0.6,pq*strafe*0.6,MS);
          if(dd<3.6 && e.attackTimer%12===0){ hitB(_alDmgS(e,1.0),0); }
          if(dd>3 && dd<20 && e.attackTimer%11===0){ shoot(ang,_ALL,0.55,'plasma',0.16,5); }
          if(dd<7 && e._ab>=25){ e._ab=0; const N=12; for(let i=0;i<N;i++){ const a=(i/N)*Math.PI*2; _sdSpawnProj(game,zoneName,e,a,_ALE,_alDmgS(e,0.5),'plasma','burn',90); } _pmShock(game,zoneName,e,e.x,e.z,2.4,0,_ALL,players,send); players.forEach((p,ws)=>{ if(p===nearestPlayer) send(ws,{type:'sv_player_fx',zone:zoneName,eff:'shake',shake:2}); }); }
        }

        if(_moved) changed.push(e);
      }

      // ── a540: CAVES OF DESPAIR mine AI (zone-gated to 'caves_of_despair'). Full kit on the
      //   shared spine: ambush wake, ore toss, panic lantern, whip crack, overseer's bellow,
      //   bomb toss, planted blasting charge (outlives its owner), crystal spike rows,
      //   resonance armor. Re-timed 60->10Hz.
      if (zoneName === 'caves_of_despair' && CD_BESPOKE[e.type]) {
        const dxp=nearestPlayer.x-e.x, dzp=nearestPlayer.z-e.z, dd=Math.sqrt(dxp*dxp+dzp*dzp)||0.0001;
        const sin=dxp/dd, cos=dzp/dd, pr=cos, pq=-sin, ang=Math.atan2(dxp,dzp);
        const _CDA=0x8a5adf, _CDT=0x35e0c8, _CDF=0xff8c2a, _CDR=0x9a8468, _CDL=0xffb040;
        // CRYSTAL LURKER AMBUSH — dormant rock until the player closes. Server owns the wake
        //   so every player sees the same lurkers sleeping/waking; the client mirrors the flare.
        if(e.type==='crystal_lurker' && !e._cdAwake){
          if(dd<6){ e._cdAwake=1; e.aggroed=true;
            broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'cd_wake',zone:zoneName,eid:e.id,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),col:_CDA});
          } else { return; }   // it is a rock. nothing is here.
        }
        if(!e.aggroed) return;
        if(e._pkT>0) e._pkT--;                       // OVERSEER'S BELLOW surge
        const _pk = (e._pkT>0) ? 1.25 : 1;
        if(e._strafe===undefined) e._strafe=Math.random()<0.5?1:-1;
        if(Math.random()<0.03) e._strafe=-e._strafe;
        const strafe=e._strafe;
        e._ab=(e._ab||0)+1;   // a556 — attackTimer is incremented by the generic enemy loop
          //   above (it runs for bespoke mobs too); incrementing it here as well ran every
          //   %-based attack check in this zone off a counter advancing 2 per tick.
        let _moved=false;
        const mv=(vx,vz,sp)=>{ e.x+=vx*sp; e.z+=vz*sp; _moved=true; };
        const hit=(dmg)=>{ players.forEach((p,ws)=>{ if(p===nearestPlayer) send(ws,{type:'sv_enemy_attack',eid:e.id,dmg:dmg,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),zone:zoneName}); }); };
        const shoot=(baseAng,col,mult,count,spread)=>{ for(let i=0;i<count;i++){ const a=baseAng+(count>1?(i-(count-1)/2)*spread:0); _sdSpawnProj(game,zoneName,e,a,col,_cdDmgS(e,mult),'bolt',null,0); } };
        const tele=(tx,tz,fuse,radius,mult,col,status,sdur)=>{ if(!game._sdGeyser) game._sdGeyser=[]; game._sdGeyser.push({ zone:zoneName, x:tx, z:tz, fuse:fuse, dmg:_cdDmgS(e,mult), eid:e.id, col:col, radius:radius, status:(status||null), statusDur:(sdur||0) }); broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_geyser_warn',zone:zoneName,ex:+tx.toFixed(2),ez:+tz.toFixed(2),col:col}); };

        if(e.type==='xu_miner'){
          // PIT WORKER — pickaxe, ORE TOSS, PANIC (drops a burning lantern and flees)
          const MS=0.276*_pk;
          if(e._fl>0){ e._fl--; mv(-sin,-cos,MS*1.3); if(_moved) changed.push(e); return; }   // fleeing
          if(dd>2.4) mv(sin*0.9+pr*strafe*0.3, cos*0.9+pq*strafe*0.3, MS);
          if(dd<2.6 && e.attackTimer%(e._pkT>0?7:10)===0){ hit(_cdDmgS(e,0.9)); }
          if(dd>3 && dd<11 && e._ab>=28){ e._ab=0; tele(nearestPlayer.x,nearestPlayer.z,6,2.0,0.85,_CDR,null,0); }
          // PANIC — badly hurt: drop the lantern (burning oil pool) and run into the dark
          if(!e._pd && (e.hp/e.maxHp)<0.30){ e._pd=1; e._fl=12;
            if(!game._sdGeyser) game._sdGeyser=[];
            const lx=e.x, lz=e.z;
            broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_geyser_warn',zone:zoneName,ex:+lx.toFixed(2),ez:+lz.toFixed(2),col:_CDL});
            for(let i=0;i<10;i++) game._sdGeyser.push({ zone:zoneName, x:lx, z:lz, fuse:3+i*3, dmg:_cdDmgS(e,0.35), eid:e.id, col:_CDL, radius:1.8, soft:1, status:(i%4===0?'burn':null), statusDur:100 });
          }
        }
        else if(e.type==='xu_overseer'){
          // PIT BOSS — whip crack (hobble), lantern lob, OVERSEER'S BELLOW (rallies the mine)
          const MS=0.228*_pk;
          if(dd>2.6) mv(sin*0.85+pr*strafe*0.35, cos*0.85+pq*strafe*0.35, MS);
          if(dd<3.0 && e.attackTimer%10===0){ hit(_cdDmgS(e,1.0)); }
          e._wc2=(e._wc2||0)+1;
          if(dd>2 && dd<7 && e._wc2>=30){ e._wc2=0;
            broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_beam',zone:zoneName,eid:e.id,ex:+e.x.toFixed(2),ey:1.3,ez:+e.z.toFixed(2),tx:+nearestPlayer.x.toFixed(2),tz:+nearestPlayer.z.toFixed(2),col:_CDR,w:0.14});
            players.forEach((p,ws)=>{ if(p===nearestPlayer){ send(ws,{type:'sv_enemy_attack',eid:e.id,dmg:_cdDmgS(e,1.0),ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),zone:zoneName}); send(ws,{type:'sv_player_fx',zone:zoneName,eff:'slow',slow:0.5,root:700,flash:'rgba(154,132,104,.12)'}); } }); }
          if(dd>3 && dd<11 && e._ab>=36){ e._ab=0; tele(nearestPlayer.x,nearestPlayer.z,6,2.4,0.9,_CDL,'burn',120); }
          // OVERSEER'S BELLOW — back to work, all of you
          if(e._ob===undefined) e._ob=Math.floor(Math.random()*34);
          e._ob++;
          if(dd<12 && e._ob>=63){ e._ob=0;
            _pmShock(game,zoneName,e,e.x,e.z,4.0,0,_CDR,players,send);
            for(let ri=0;ri<zone.enemies.length;ri++){ const o=zone.enemies[ri];
              if(!o||!o.active||o===e||!CD_BESPOKE[o.type]) continue;
              const odx=o.x-e.x, odz=o.z-e.z; if(odx*odx+odz*odz>196) continue;
              o.aggroed=true; o._pkT=47;
              broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_beam',zone:zoneName,eid:e.id,ex:+e.x.toFixed(2),ey:1.7,ez:+e.z.toFixed(2),tx:+o.x.toFixed(2),tz:+o.z.toFixed(2),col:_CDR,w:0.12}); } }
        }
        else if(e.type==='blast_sapper'){
          // DEMOLITION XU — keeps its distance, lobs bombs, PLANTS A BLASTING CHARGE
          const MS=0.30*_pk;
          if(dd<4) mv(-sin*0.9+pr*strafe*0.5, -cos*0.9+pq*strafe*0.5, MS);
          else if(dd>10) mv(sin*0.8, cos*0.8, MS);
          else mv(pr*strafe, pq*strafe, MS);
          if(dd>3 && dd<11 && e.attackTimer%18===0){ tele(nearestPlayer.x,nearestPlayer.z,6,2.4,1.0,_CDF,'burn',100); }
          // PLANTED CHARGE — a real bomb on an accelerating fuse. Pushed to the zone geyser
          //   list, NOT tied to the sapper's life: it detonates even if the sapper dies.
          if(e._pc===undefined) e._pc=Math.floor(Math.random()*25);
          e._pc++;
          if(dd>2 && dd<9 && e._pc>=43){ e._pc=0;
            if(!game._sdGeyser) game._sdGeyser=[];
            const bx=e.x, bz=e.z;
            broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'cd_charge',zone:zoneName,ex:+bx.toFixed(2),ez:+bz.toFixed(2),col:_CDF,dur:1800});
            game._sdGeyser.push({ zone:zoneName, x:bx, z:bz, fuse:18, dmg:_cdDmgS(e,1.5), eid:e.id, col:_CDF, radius:3.2, status:'burn', statusDur:120, shake:3 }); }
        }
        else { // crystal_lurker — THE MINE ITSELF
          const MS=0.252*_pk;
          if(dd>2.2) mv(sin*0.9+pr*strafe*0.4, cos*0.9+pq*strafe*0.4, MS);
          if(dd<2.6 && e.attackTimer%10===0){ hit(_cdDmgS(e,1.05)); }
          if(dd>2.4 && dd<10 && e.attackTimer%13===0){ shoot(ang,_CDA,0.6,2,0.16); }
          // CRYSTAL SPIKE ROW — the floor grows teeth, marching toward the player
          if(dd>2.5 && dd<10 && e._ab>=35){ e._ab=0;
            for(let si=0;si<4;si++){ const fr=(si+1)/4;
              tele(e.x+(nearestPlayer.x-e.x)*fr, e.z+(nearestPlayer.z-e.z)*fr, 3+si*2, 1.4, 0.8, _CDA, null, 0); } }
          // RESONANCE — shard nova, and its back hardens for a beat
          e._rn=(e._rn||0)+1;
          if(dd<5 && e._rn>=40){ e._rn=0;
            _pmShock(game,zoneName,e,e.x,e.z,3.0,(dd<3.4?_cdDmgS(e,1.1):0),_CDA,players,send);
            if(e._rnBase===undefined) e._rnBase=e.dmgReduction||0;
            e.dmgReduction=Math.min(0.7, e._rnBase+0.30); e._rnT=18; }
          if(e._rnT>0){ e._rnT--; if(e._rnT===0 && e._rnBase!==undefined) e.dmgReduction=e._rnBase; }
        }

        if(_moved) changed.push(e);
      }

      // ── a541: XU CITADEL Dominion-tech AI (zone-gated to 'citadel'). Repulsor knockback,
      //   singularity pull, phase swap, orbital lock, tesla tether, drone swarm, time dilation,
      //   overclock rally. Player-displacement effects ride sv_player_fx (push / swap / pull).
      //   Re-timed 60->10Hz.
      if (zoneName === 'citadel' && e.aggroed && CT_BESPOKE[e.type]) {
        const dxp=nearestPlayer.x-e.x, dzp=nearestPlayer.z-e.z, dd=Math.sqrt(dxp*dxp+dzp*dzp)||0.0001;
        const sin=dxp/dd, cos=dzp/dd, pr=cos, pq=-sin, ang=Math.atan2(dxp,dzp);
        const _CTC=0x33e6ff, _CTB=0x2a6bff, _CTM=0xff3cf0, _CTP=0x9a4cff, _CTW=0xeaffff, _CTV=0x6a2cff, _CTG=0xffd24a;
        if(e._strafe===undefined) e._strafe=Math.random()<0.5?1:-1;
        if(Math.random()<0.03) e._strafe=-e._strafe;
        const strafe=e._strafe;
        if(e._ovr>0) e._ovr--;                          // OVERCLOCK RALLY speed buff
        const OVR = (e._ovr>0) ? 1.22 : 1.0;
        e._ab=(e._ab||0)+1;   // a556 — attackTimer is incremented by the generic enemy loop
          //   above (it runs for bespoke mobs too); incrementing it here as well ran every
          //   %-based attack check in this zone off a counter advancing 2 per tick.
        let _moved=false;
        const mv=(vx,vz,sp)=>{ e.x+=vx*sp*OVR; e.z+=vz*sp*OVR; _moved=true; };
        const hit=(dmg)=>{ players.forEach((p,ws)=>{ if(p===nearestPlayer) send(ws,{type:'sv_enemy_attack',eid:e.id,dmg:dmg,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),zone:zoneName}); }); };
        const shoot=(baseAng,col,mult,kind,spread,count)=>{ for(let i=0;i<count;i++){ const a=baseAng+(count>1?(i-(count-1)/2)*spread:0); _sdSpawnProj(game,zoneName,e,a,col,_ctDmgS(e,mult),kind,null,0); } };
        const toPlayer=(msg)=>{ players.forEach((p,ws)=>{ if(p===nearestPlayer) send(ws, Object.assign({type:'sv_player_fx',zone:zoneName},msg)); }); };
        // REPULSOR SLAM — damage + physical knockback AWAY from the mob
        const ctRepulsor=(force,mult)=>{ _pmShock(game,zoneName,e,e.x,e.z,4.5,0,_CTC,players,send);
          if(dd<5.0){ hit(_ctDmgS(e,mult||1.0)); toPlayer({ eff:'push', px:+e.x.toFixed(2), pz:+e.z.toFixed(2), push:(force||5.5), shake:3 }); } };
        // ORBITAL LOCK — tracking reticle, re-locks late, then a top-down strike
        const ctOrbital=(fuse,radius,mult)=>{ if(!game._sdGeyser) game._sdGeyser=[];
          game._sdGeyser.push({ zone:zoneName, x:nearestPlayer.x, z:nearestPlayer.z, fuse:fuse, dmg:_ctDmgS(e,mult), eid:e.id, col:_CTM, radius:radius, shake:4, relock:Math.max(1,Math.floor(fuse*0.3)), orbital:1 });
          broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_geyser_warn',zone:zoneName,ex:+nearestPlayer.x.toFixed(2),ez:+nearestPlayer.z.toFixed(2),col:_CTM}); };

        if(e.type==='iron_guard'){
          // DOMINION HEAVY — plasma cannon + REPULSOR SLAM
          const MS=0.156;
          if(dd>3.4) mv(sin,cos,MS);
          if(dd<3.8 && e.attackTimer%12===0){ hit(_ctDmgS(e,1.0)); }
          if(dd>3 && dd<22 && e.attackTimer%11===0){ shoot(ang,_CTB,0.5,'bolt',0.1,2); }
          if(dd<5 && e._ab>=20){ e._ab=0; ctRepulsor(5.5,1.2); }
        }
        else if(e.type==='citadel_mage'){
          // DATA-MAGE — data bolts, SINGULARITY (drags you in, then collapses), PHASE SWAP
          const MS=0.192;
          if(dd<7) mv(-sin*0.8+pr*strafe*0.6,-cos*0.8+pq*strafe*0.6,MS);
          else if(dd>16) mv(sin*0.6,cos*0.6,MS);
          else mv(pr*strafe*0.7,pq*strafe*0.7,MS);
          if(dd>2.5 && dd<22 && e.attackTimer%9===0){ shoot(ang,_CTM,0.55,'plasma',0.12,3); }
          if(dd<20 && e._ab>=30){ e._ab=0;
            // singularity: a well spawns midway, drags for 4 beats, then detonates
            const sx=e.x+(nearestPlayer.x-e.x)*0.5, sz=e.z+(nearestPlayer.z-e.z)*0.5;
            if(!game._sdGeyser) game._sdGeyser=[];
            broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_rift',zone:zoneName,ex:+sx.toFixed(2),ez:+sz.toFixed(2),col:_CTV});
            broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_geyser_warn',zone:zoneName,ex:+sx.toFixed(2),ez:+sz.toFixed(2),col:_CTV});
            for(let k=0;k<4;k++) game._sdGeyser.push({ zone:zoneName, x:sx, z:sz, fuse:2+k*2, dmg:0, eid:e.id, col:_CTP, radius:6.0, soft:1, pull:0.9 });
            game._sdGeyser.push({ zone:zoneName, x:sx, z:sz, fuse:10, dmg:_ctDmgS(e,1.6), eid:e.id, col:_CTP, radius:4.0, shake:3 }); }
          e._swap=(e._swap||10)+1;
          if(dd<6 && e._swap>=40){ e._swap=0;
            // PHASE SWAP — the mage and the player trade places
            const ex=e.x, ez=e.z;
            broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_rift',zone:zoneName,ex:+ex.toFixed(2),ez:+ez.toFixed(2),col:_CTP});
            e.x=nearestPlayer.x; e.z=nearestPlayer.z; _moved=true;
            toPlayer({ eff:'swap', px:+ex.toFixed(2), pz:+ez.toFixed(2), flash:'rgba(120,80,255,0.18)' });
            broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_rift',zone:zoneName,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),col:_CTC}); }
        }
        else if(e.type==='xu_sniper_elite'){
          // RAIL SNIPER — kites, charged railshot, ORBITAL LOCK
          const MS=0.18;
          if(dd<10) mv(-sin*0.8+pr*strafe*0.5,-cos*0.8+pq*strafe*0.5,MS);
          else if(dd>22) mv(sin*0.6,cos*0.6,MS);
          else mv(pr*strafe*0.5,pq*strafe*0.5,MS*0.6);
          if(e._rail==='aim'){
            if(e._ab%2===0) broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_beam',zone:zoneName,eid:e.id,ex:+e.x.toFixed(2),ey:1.4,ez:+e.z.toFixed(2),tx:+nearestPlayer.x.toFixed(2),tz:+nearestPlayer.z.toFixed(2),col:_CTC,w:0.04});
            if(e._ab>=6){ e._rail='fire'; e._ab=0; }
          } else if(e._rail==='fire'){
            shoot(ang,_CTW,1.4,'bolt',0,1);
            broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_beam',zone:zoneName,eid:e.id,ex:+e.x.toFixed(2),ey:1.4,ez:+e.z.toFixed(2),tx:+nearestPlayer.x.toFixed(2),tz:+nearestPlayer.z.toFixed(2),col:_CTW,w:0.18});
            e._rail=0; e._ab=0;
          } else if(dd>6 && dd<26 && e._ab>=20){ e._rail='aim'; e._ab=0; }
          e._orb=(e._orb||7)+1; if(dd<26 && e._orb>=33){ e._orb=0; ctOrbital(11,3.0,1.7); }
        }
        else if(e.type==='xu_shieldbot'){
          // DEPLOYER DRONE — DRONE SWARM (6 converging orbs), TESLA TETHER, close repulsor
          const MS=0.204;
          if(dd>6) mv(sin*0.7+pr*strafe*0.5, cos*0.7+pq*strafe*0.5, MS);
          else mv(pr*strafe*0.7,pq*strafe*0.7,MS);
          if(dd<3.6 && e.attackTimer%11===0){ hit(_ctDmgS(e,1.0)); }
          if(dd<20 && e._ab>=22){ e._ab=0;
            const N=6; for(let i=0;i<N;i++){ const oa=(i/N)*Math.PI*2; const ox=e.x+Math.cos(oa)*1.6, oz=e.z+Math.sin(oa)*1.6;
              const ddx=nearestPlayer.x-ox, ddz=nearestPlayer.z-oz, dl=Math.hypot(ddx,ddz)||0.001;
              _sdSpawnProj(game,zoneName,{id:e.id,x:ox,z:oz,type:e.type,atk:e.atk}, Math.atan2(ddx/dl,ddz/dl), _CTC, _ctDmgS(e,0.4), 'plasma', null, 0); } }
          e._tesla=(e._tesla||5)+1;
          if(dd<14 && e._tesla>=25){ e._tesla=0;
            broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_beam',zone:zoneName,eid:e.id,ex:+e.x.toFixed(2),ey:1.3,ez:+e.z.toFixed(2),tx:+nearestPlayer.x.toFixed(2),tz:+nearestPlayer.z.toFixed(2),col:_CTC,w:0.12});
            hit(_ctDmgS(e,1.0)); }
          e._rep=(e._rep||0)+1; if(dd<3.2 && e._rep>=15){ e._rep=0; ctRepulsor(4.0,0.6); }
        }
        else { // xu_commander_elite — TIME-DILATION FIELD, ORBITAL BARRAGE, OVERCLOCK RALLY, blink
          const MS=0.228;
          if(dd>3.0) mv(sin*0.7+pr*strafe*0.6, cos*0.7+pq*strafe*0.6, MS); else mv(pr*strafe,pq*strafe,MS);
          if(dd<3.4 && e.attackTimer%10===0){ hit(_ctDmgS(e,1.0)); }
          if(dd>3 && dd<22 && e.attackTimer%10===0){ shoot(ang,_CTG,0.55,'plasma',0.14,3); }
          e._rally=(e._rally||0)+1;
          if(e._rally>=43){ e._rally=0;
            _pmShock(game,zoneName,e,e.x,e.z,6.0,0,_CTG,players,send);
            for(let ri=0;ri<zone.enemies.length;ri++){ const o=zone.enemies[ri];
              if(!o||!o.active||o===e||!CT_BESPOKE[o.type]) continue;
              const odx=o.x-e.x, odz=o.z-e.z; if(odx*odx+odz*odz>196) continue;
              o._ovr=100;
              broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_beam',zone:zoneName,eid:e.id,ex:+e.x.toFixed(2),ey:1.3,ez:+e.z.toFixed(2),tx:+o.x.toFixed(2),tz:+o.z.toFixed(2),col:_CTG,w:0.06}); } }
          // TIME-DILATION FIELD — a lingering zone that slows you while you stand in it
          e._tdf=(e._tdf||13)+1;
          if(dd<16 && e._tdf>=50){ e._tdf=0;
            if(!game._sdGeyser) game._sdGeyser=[];
            const fx=e.x, fz=e.z;
            broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_geyser_warn',zone:zoneName,ex:+fx.toFixed(2),ez:+fz.toFixed(2),col:_CTG});
            for(let k=0;k<10;k++) game._sdGeyser.push({ zone:zoneName, x:fx, z:fz, fuse:2+k*3, dmg:0, eid:e.id, col:_CTG, radius:7.0, soft:1, slow:0.4, slowDur:420 }); }
          e._barr=(e._barr||20)+1;
          if(dd<24 && e._barr>=47){ e._barr=0; for(let k=0;k<3;k++) ctOrbital(9+k*4, 2.6, 1.2); }
          if(dd<5 && (e._blk=(e._blk||0)+1)>=33){ e._blk=0;
            broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_rift',zone:zoneName,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),col:_CTC});
            const a=ang+(Math.random()<0.5?1:-1)*1.2, r=7;
            e.x=nearestPlayer.x-Math.sin(a)*r; e.z=nearestPlayer.z-Math.cos(a)*r; _moved=true;
            broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_rift',zone:zoneName,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),col:_CTC}); }
        }

        if(_moved) changed.push(e);
      }

      // ── a542: FROSTVEIL TUNDRA ice AI (zone-gated to 'frostveil'). Glacial slams, frost-nova
      //   hard freezes, ice armor, frost-trail charges, the winter-nightmare blizzard whiteout,
      //   ice-lance volleys, shard novas, freeze beams, phase blinks. Re-timed 60->10Hz.
      if (zoneName === 'frostveil' && e.aggroed && FZ_BESPOKE[e.type]) {
        const dxp=nearestPlayer.x-e.x, dzp=nearestPlayer.z-e.z, dd=Math.sqrt(dxp*dxp+dzp*dzp)||0.0001;
        const sin=dxp/dd, cos=dzp/dd, pr=cos, pq=-sin, ang=Math.atan2(dxp,dzp);
        const _FZI=0xbfe8ff, _FZC=0x66ccff, _FZW=0xffffff, _FZP=0xa8d8f0, _FZD=0x2a6ad0, _FZF=0xd0f0ff;
        if(e._strafe===undefined) e._strafe=Math.random()<0.5?1:-1;
        if(Math.random()<0.03) e._strafe=-e._strafe;
        const strafe=e._strafe;
        e._ab=(e._ab||0)+1;   // a556 — attackTimer is incremented by the generic enemy loop
          //   above (it runs for bespoke mobs too); incrementing it here as well ran every
          //   %-based attack check in this zone off a counter advancing 2 per tick.
        let _moved=false;
        const mv=(vx,vz,sp)=>{ e.x+=vx*sp; e.z+=vz*sp; _moved=true; };
        const hit=(dmg)=>{ players.forEach((p,ws)=>{ if(p===nearestPlayer) send(ws,{type:'sv_enemy_attack',eid:e.id,dmg:dmg,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),zone:zoneName}); }); };
        const toPlayer=(msg)=>{ players.forEach((p,ws)=>{ if(p===nearestPlayer) send(ws, Object.assign({type:'sv_player_fx',zone:zoneName},msg)); }); };
        const shootIce=(baseAng,mult,count,spread)=>{ const col=(Math.random()<0.5)?_FZC:_FZI; for(let i=0;i<count;i++){ const a=baseAng+(count>1?(i-(count-1)/2)*spread:0); _sdSpawnProj(game,zoneName,e,a,col,_fzDmgS(e,mult),'plasma',null,0); } };
        // ICE SPIKES — telegraphed eruption that also chills (slow)
        const iceSpikes=(tx,tz,mult)=>{ if(!game._sdGeyser) game._sdGeyser=[];
          game._sdGeyser.push({ zone:zoneName, x:tx, z:tz, fuse:5, dmg:_fzDmgS(e,mult), eid:e.id, col:_FZI, radius:3.4, slow:0.5, slowDur:900 });
          broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_geyser_warn',zone:zoneName,ex:+tx.toFixed(2),ez:+tz.toFixed(2),col:_FZC}); };
        // FROST NOVA — radial burst that HARD FREEZES (root, slow 0.0)
        const frostNova=(mult)=>{ if(!game._sdGeyser) game._sdGeyser=[];
          game._sdGeyser.push({ zone:zoneName, x:e.x, z:e.z, fuse:5, dmg:_fzDmgS(e,mult), eid:e.id, col:_FZC, radius:5.5, slow:0.0, slowDur:620, shake:2, freeze:1 });
          broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_geyser_warn',zone:zoneName,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),col:_FZD}); };
        // SNOWSTORM — winter-nightmare whiteout + heavy slow + chip damage while in range
        const snowstorm=(ticks,chipMult)=>{ if(!game._sdGeyser) game._sdGeyser=[];
          broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'fz_blizzard',zone:zoneName,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),ms:ticks*300,r:18});
          for(let k=0;k<ticks;k++) game._sdGeyser.push({ zone:zoneName, x:e.x, z:e.z, fuse:2+k*3, dmg:(k%2===0?_fzDmgS(e,chipMult):0), eid:e.id, col:_FZW, radius:16.0, soft:1, slow:0.45, slowDur:420 }); };
        const fzBlink=(distB)=>{ broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_rift',zone:zoneName,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),col:_FZC});
          e.x-=Math.sin(ang)*distB; e.z-=Math.cos(ang)*distB; _moved=true;
          broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_rift',zone:zoneName,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),col:_FZI}); };

        if(e.type==='ice_golem'){
          // GLACIAL TANK — ground ice-spike slam, FROST NOVA root, ICE ARMOR
          const MS=0.096;
          if(dd>3.6) mv(sin,cos,MS);
          if(dd<4.2 && e.attackTimer%13===0){ hit(_fzDmgS(e,1.0)); toPlayer({ eff:'shake', shake:2 }); }
          if(dd>3 && dd<16 && e._ab>=27){ e._ab=0; iceSpikes(nearestPlayer.x,nearestPlayer.z,1.2); }
          e._nova=(e._nova||10)+1; if(dd<7 && e._nova>=35){ e._nova=0; frostNova(1.1); }
          // ICE ARMOR — periodic self-shield (server owns the dmgReduction)
          e._arm=(e._arm||0)+1;
          if(e._arm>=50){ e._arm=0;
            if(e._fzArmBase===undefined) e._fzArmBase=e.dmgReduction||0;
            e.dmgReduction=Math.min(0.6,(e.dmgReduction||0)+0.15); e._armT=40;
            broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_geyser_warn',zone:zoneName,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),col:_FZI}); }
          if(e._armT>0){ e._armT--; if(e._armT===0 && e._fzArmBase!==undefined) e.dmgReduction=e._fzArmBase; }
        }
        else if(e.type==='polar_bear'){
          // BEAST — frost-trail CHARGE, maul, BLIZZARD ROAR
          const MS=0.228;
          if(e._charge){ e._cst=(e._cst||0)+1;
            mv(Math.sin(e._cdir),Math.cos(e._cdir),MS*2.6);
            if(dd<2.6 && !e._chit){ hit(_fzDmgS(e,1.3)); e._chit=1; toPlayer({ eff:'slow', slow:0.5, root:900 }); }
            if(e._cst>=3){ e._charge=0; e._cst=0; }
          } else {
            if(dd>2.8) mv(sin*0.9+pr*strafe*0.3, cos*0.9+pq*strafe*0.3, MS); else mv(pr*strafe,pq*strafe,MS);
            if(dd<3.0 && e.attackTimer%8===0){ hit(_fzDmgS(e,1.0)); }
            if(dd>5 && dd<15 && e._ab>=23){ e._ab=0; e._charge=1; e._cst=0; e._cdir=ang; e._chit=0;
              broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_motes',zone:zoneName,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),col:_FZI,n:6}); }
            e._roar=(e._roar||0)+1; if(dd<16 && e._roar>=53){ e._roar=0; snowstorm(10,0.35); }
          }
        }
        else if(e.type==='frost_wraith'){
          // RANGED — ICE-LANCE volleys, SHARD NOVA, frost blink
          const MS=0.312;
          if(dd<6) mv(-sin*0.7+pr*strafe*0.6,-cos*0.7+pq*strafe*0.6,MS);
          else if(dd>16) mv(sin*0.6,cos*0.6,MS);
          else mv(pr*strafe*0.7,pq*strafe*0.7,MS);
          if(dd>2.5 && dd<20 && e.attackTimer%8===0){ shootIce(ang,0.55,3,0.16); }
          if(dd<12 && e._ab>=28){ e._ab=0; for(let i=0;i<8;i++){ _sdSpawnProj(game,zoneName,e,i*0.785,_FZI,_fzDmgS(e,0.7),'plasma',null,0); }
            broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_poof',zone:zoneName,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),col:_FZC,n:8}); }
          if(dd<4 && (e._blk=(e._blk||0)+1)>=25){ e._blk=0; fzBlink(7); }
        }
        else { // frost_specter — NIGHTMARE CASTER
          const MS=0.30;
          if(dd<7) mv(-sin*0.6+pr*strafe*0.7,-cos*0.6+pq*strafe*0.7,MS);
          else if(dd>17) mv(sin*0.6,cos*0.6,MS);
          else mv(pr*strafe*0.6,pq*strafe*0.6,MS);
          if(dd>2.5 && dd<18 && e.attackTimer%10===0){ shootIce(ang,0.5,1,0); }
          // SPECTRAL BLIZZARD — the winter nightmare
          if(dd<17 && e._ab>=40){ e._ab=0; snowstorm(11,0.4); }
          // FREEZE BEAM — telegraphed HARD ROOT
          e._beam=(e._beam||15)+1;
          if(dd<14 && e._beam>=43){ e._beam=0;
            const tx=nearestPlayer.x, tz=nearestPlayer.z;
            broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_beam',zone:zoneName,eid:e.id,ex:+e.x.toFixed(2),ey:1.4,ez:+e.z.toFixed(2),tx:+tx.toFixed(2),tz:+tz.toFixed(2),col:_FZC,w:0.5});
            if(!game._sdGeyser) game._sdGeyser=[];
            game._sdGeyser.push({ zone:zoneName, x:tx, z:tz, fuse:6, dmg:_fzDmgS(e,1.2), eid:e.id, col:_FZD, radius:3.0, slow:0.0, slowDur:680, freeze:1 });
            broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_geyser_warn',zone:zoneName,ex:+tx.toFixed(2),ez:+tz.toFixed(2),col:_FZD}); }
          if(dd<4 && (e._ph=(e._ph||0)+1)>=28){ e._ph=0; fzBlink(8); }
        }

        if(_moved) changed.push(e);
      }

      // ── a543: ANCIENT REALM arcane AI (zone-gated to 'ancient'). Runic slams, sweeping ritual
      //   beams, arcane wards, orbiting stone shards, seismic stomps, the petrify gaze, entangling
      //   roots, verdant novas with regrowth, mirages, spectral lunges. Re-timed 60->10Hz.
      if (zoneName === 'ancient' && e.aggroed && ELD_BESPOKE[e.type]) {
        const dxp=nearestPlayer.x-e.x, dzp=nearestPlayer.z-e.z, dd=Math.sqrt(dxp*dxp+dzp*dzp)||0.0001;
        const sin=dxp/dd, cos=dzp/dd, pr=cos, pq=-sin, ang=Math.atan2(dxp,dzp);
        const _EG=0xffd24a, _EA=0xffa030, _ET=0x40e0d0, _EJ=0x66dd88, _EC=0xc088ff, _ES=0xc9b98a, _EW=0xfff4d0;
        if(e._strafe===undefined) e._strafe=Math.random()<0.5?1:-1;
        if(Math.random()<0.03) e._strafe=-e._strafe;
        const strafe=e._strafe;
        e._ab=(e._ab||0)+1;   // a556 — attackTimer is incremented by the generic enemy loop
          //   above (it runs for bespoke mobs too); incrementing it here as well ran every
          //   %-based attack check in this zone off a counter advancing 2 per tick.
        if(e._eldHealCD>0) e._eldHealCD--;
        let _moved=false;
        const mv=(vx,vz,sp)=>{ e.x+=vx*sp; e.z+=vz*sp; _moved=true; };
        const hit=(dmg)=>{ players.forEach((p,ws)=>{ if(p===nearestPlayer) send(ws,{type:'sv_enemy_attack',eid:e.id,dmg:dmg,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),zone:zoneName}); }); };
        const toPlayer=(msg)=>{ players.forEach((p,ws)=>{ if(p===nearestPlayer) send(ws, Object.assign({type:'sv_player_fx',zone:zoneName},msg)); }); };
        const shoot=(baseAng,col,mult,count,spread)=>{ for(let i=0;i<count;i++){ const a=baseAng+(count>1?(i-(count-1)/2)*spread:0); _sdSpawnProj(game,zoneName,e,a,col,_eldDmgS(e,mult),'plasma',null,0); } };
        const tele=(tx,tz,fuse,radius,mult,col,slow,slowDur,shake)=>{ if(!game._sdGeyser) game._sdGeyser=[];
          game._sdGeyser.push({ zone:zoneName, x:tx, z:tz, fuse:fuse, dmg:_eldDmgS(e,mult), eid:e.id, col:col, radius:radius, slow:(slow===undefined?0:slow), slowDur:(slowDur||0), shake:(shake||0) });
          broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_geyser_warn',zone:zoneName,ex:+tx.toFixed(2),ez:+tz.toFixed(2),col:col}); };
        const eldBlink=(distB)=>{ broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_rift',zone:zoneName,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),col:_EC});
          e.x-=Math.sin(ang)*distB; e.z-=Math.cos(ang)*distB; _moved=true;
          broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_rift',zone:zoneName,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),col:_EG}); };

        if(e.type==='ancient_guardian'){
          // COLOSSUS — RUNIC SLAM, sweeping RITUAL BEAM, ARCANE WARD
          const MS=0.096;
          if(dd>3.8) mv(sin,cos,MS);
          if(dd<4.4 && e.attackTimer%13===0){ hit(_eldDmgS(e,1.0)); toPlayer({ eff:'shake', shake:2 }); }
          if(dd>3 && dd<16 && e._ab>=27){ e._ab=0; tele(nearestPlayer.x,nearestPlayer.z,6,3.6,1.2,_EG,0.5,900,0); }
          // RITUAL BEAM — tracks, then fires; still clips you for a reduced hit if you slip it
          e._beam=(e._beam||13)+1;
          if(dd<22 && e._beam>=38){ e._beam=0;
            broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_geyser_warn',zone:zoneName,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),col:_ET});
            e._beamFire=6; e._beamMult=1.1; }
          if(e._beamFire>0){ e._beamFire--;
            if(e._beamFire===0){
              broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_beam',zone:zoneName,eid:e.id,ex:+e.x.toFixed(2),ey:1.5,ez:+e.z.toFixed(2),tx:+nearestPlayer.x.toFixed(2),tz:+nearestPlayer.z.toFixed(2),col:_ET,w:0.6});
              hit(_eldDmgS(e, dd<22 ? 1.1 : 0.66)); } }
          e._ward=(e._ward||0)+1;
          if(e._ward>=50){ e._ward=0;
            if(e._eldWardBase===undefined) e._eldWardBase=e.dmgReduction||0;
            e.dmgReduction=Math.min(0.6,(e.dmgReduction||0)+0.15); e._wardT=40;
            broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_geyser_warn',zone:zoneName,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),col:_EG}); }
          if(e._wardT>0){ e._wardT--; if(e._wardT===0 && e._eldWardBase!==undefined) e.dmgReduction=e._eldWardBase; }
        }
        else if(e.type==='stone_sentinel'){
          // SENTINEL — orbiting STONE SHARDS, SEISMIC STOMP (hard root), PETRIFY GAZE
          const MS=0.096;
          if(dd>3.6) mv(sin,cos,MS);
          if(dd>2.5 && dd<18 && e.attackTimer%9===0){ shoot(ang,_ES,0.55,3,0.15); }
          if(dd<8 && e._ab>=28){ e._ab=0;
            _pmShock(game,zoneName,e,e.x,e.z,5.5,0,_EA,players,send);
            if(dd<5.5){ hit(_eldDmgS(e,1.1)); toPlayer({ eff:'slow', slow:0.0, root:700, shake:3 }); } }
          // PETRIFY GAZE — the screen turns to stone + hard root
          e._gaze=(e._gaze||15)+1;
          if(dd<16 && e._gaze>=47){ e._gaze=0;
            broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_beam',zone:zoneName,eid:e.id,ex:+e.x.toFixed(2),ey:1.5,ez:+e.z.toFixed(2),tx:+nearestPlayer.x.toFixed(2),tz:+nearestPlayer.z.toFixed(2),col:_ES,w:0.5});
            broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'eld_petrify',zone:zoneName,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),ms:2400,r:16});
            if(dd<16){ hit(_eldDmgS(e,0.9)); toPlayer({ eff:'slow', slow:0.0, root:1000 }); } }
        }
        else if(e.type==='vine_horror'){
          // ANCIENT OVERGROWTH — thorn lash, ENTANGLE (hard root), VERDANT NOVA + regrowth
          const MS=0.156;
          if(dd>3.0) mv(sin*0.85+pr*strafe*0.4, cos*0.85+pq*strafe*0.4, MS); else mv(pr*strafe,pq*strafe,MS);
          if(dd>2.5 && dd<16 && e.attackTimer%8===0){ shoot(ang,_EJ,0.55,2,0.12); }
          if(dd<3.0 && e.attackTimer%8===0){ hit(_eldDmgS(e,1.0)); }
          if(dd>2 && dd<13 && e._ab>=25){ e._ab=0; tele(nearestPlayer.x,nearestPlayer.z,6,2.6,1.0,_EJ,0.0,800,0); }
          // VERDANT NOVA + regrowth. The self-heal is capped and on its own cooldown so a
          //   cluster of these can't out-heal a party (cf. the a535 glimmer fairies).
          e._verd=(e._verd||0)+1;
          if(e._verd>=43){ e._verd=0;
            _pmShock(game,zoneName,e,e.x,e.z,4.0,(dd<4.5?_eldDmgS(e,0.9):0),_EJ,players,send);
            if(!(e._eldHealCD>0) && e.hp<e.maxHp){ e.hp=Math.min(e.maxHp, e.hp+Math.floor(e.maxHp*0.06)); e._eldHealCD=40; changed.push(e); } }
        }
        else { // void_stalker (ANCIENT PHANTOM — a different kit from the Void Wastes stalker)
          const MS=0.27;
          if(e._lunge){ e._lst=(e._lst||0)+1;
            mv(Math.sin(e._ldir),Math.cos(e._ldir),MS*2.4);
            if(dd<2.3 && !e._lhit){ hit(_eldDmgS(e,1.2)); e._lhit=1; }
            if(e._lst>=3){ e._lunge=0; e._lst=0; }
          } else {
            if(dd<6) mv(-sin*0.6+pr*strafe*0.7,-cos*0.6+pq*strafe*0.7,MS);
            else if(dd>15) mv(sin*0.7,cos*0.7,MS);
            else mv(pr*strafe*0.7,pq*strafe*0.7,MS);
            if(dd>2.5 && dd<19 && e.attackTimer%8===0){ shoot(ang,_EC,0.55,1,0); }
            // MIRAGE — arcane after-images ring
            if(dd<14 && e._ab>=33){ e._ab=0;
              broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'eld_mirage',zone:zoneName,eid:e.id,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),col:_EC}); }
            if(dd>4 && dd<13 && (e._lg=(e._lg||0)+1)>=22){ e._lg=0; e._lunge=1; e._lst=0; e._ldir=ang; e._lhit=0;
              broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_motes',zone:zoneName,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),col:_EC,n:5}); }
            if(dd<3.5 && (e._blk=(e._blk||0)+1)>=24){ e._blk=0; eldBlink(7); }
          }
        }

        if(_moved) changed.push(e);
      }

      // ── a544: NECROPOLIS plague/death AI (zone-gated to 'necropolis'). Plague vomit + pools,
      //   disease aura, pestilent slam, skull barrage, corpse explosion, DEATH MARK (a doom
      //   timer that re-targets you before it detonates), spectral wail, bone storm, cadaver
      //   toss. Every hit applies poison/disease. Re-timed 60->10Hz.
      if (zoneName === 'necropolis' && e.aggroed && NP_BESPOKE[e.type]) {
        const dxp=nearestPlayer.x-e.x, dzp=nearestPlayer.z-e.z, dd=Math.sqrt(dxp*dxp+dzp*dzp)||0.0001;
        const sin=dxp/dd, cos=dzp/dd, pr=cos, pq=-sin, ang=Math.atan2(dxp,dzp);
        const _NB=0xe8e0c8, _NPL=0x9aca34, _NTX=0xb6ff3a, _NRT=0x6b8e23, _NNC=0x8a2be2, _NSK=0x88ff66;
        if(e._strafe===undefined) e._strafe=Math.random()<0.5?1:-1;
        if(Math.random()<0.03) e._strafe=-e._strafe;
        const strafe=e._strafe;
        e._ab=(e._ab||0)+1;   // a556 — attackTimer is incremented by the generic enemy loop
          //   above (it runs for bespoke mobs too); incrementing it here as well ran every
          //   %-based attack check in this zone off a counter advancing 2 per tick.
        let _moved=false;
        const mv=(vx,vz,sp)=>{ e.x+=vx*sp; e.z+=vz*sp; _moved=true; };
        // every necropolis hit carries the plague
        const plagueHit=(mult)=>{ players.forEach((p,ws)=>{ if(p===nearestPlayer){
          send(ws,{type:'sv_enemy_attack',eid:e.id,dmg:_npDmgS(e,mult),ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),zone:zoneName});
          send(ws,{type:'sv_player_fx',zone:zoneName,eff:'status',status:'poison',statusDur:150}); } }); };
        const toPlayer=(msg)=>{ players.forEach((p,ws)=>{ if(p===nearestPlayer) send(ws, Object.assign({type:'sv_player_fx',zone:zoneName},msg)); }); };
        const shoot=(baseAng,col,mult,count,spread)=>{ for(let i=0;i<count;i++){ const a=baseAng+(count>1?(i-(count-1)/2)*spread:0); _sdSpawnProj(game,zoneName,e,a,col,_npDmgS(e,mult),'plasma','poison',150); } };
        // lingering PLAGUE POOL — poison DoT patch
        const plagueCloud=(tx,tz,ticks,mult)=>{ if(!game._sdGeyser) game._sdGeyser=[];
          broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_geyser_warn',zone:zoneName,ex:+tx.toFixed(2),ez:+tz.toFixed(2),col:_NPL});
          for(let i=0;i<ticks;i++) game._sdGeyser.push({ zone:zoneName, x:tx, z:tz, fuse:3+i*3, dmg:_npDmgS(e,mult), eid:e.id, col:_NPL, radius:3.4, soft:1, status:'poison', statusDur:150 }); };
        const npBlink=(distB)=>{ broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_rift',zone:zoneName,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),col:_NNC});
          e.x-=Math.sin(ang)*distB; e.z-=Math.cos(ang)*distB; _moved=true;
          broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_rift',zone:zoneName,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),col:_NPL}); };

        if(e.type==='necro_abomination'){
          // PLAGUE TITAN — plague vomit -> cloud, DISEASE AURA, PESTILENT SLAM
          const MS=0.132;
          if(dd>4.0) mv(sin,cos,MS);
          if(dd<4.6 && e.attackTimer%12===0){ plagueHit(1.0); toPlayer({ eff:'shake', shake:2 }); }
          if(dd<3.4 && e.attackTimer%7===0){ plagueHit(0.35); }                       // festering aura
          if(dd>3 && dd<15 && e._ab>=25){ e._ab=0; shoot(ang,_NTX,0.6,5,0.22); plagueCloud(nearestPlayer.x,nearestPlayer.z,7,0.5); }
          e._slam=(e._slam||23)+1;
          if(dd<10 && e._slam>=33){ e._slam=0;
            _pmShock(game,zoneName,e,e.x,e.z,6.0,0,_NRT,players,send);
            for(let i=0;i<3;i++){ const a=Math.random()*6.283, r=2+Math.random()*4; plagueCloud(e.x+Math.cos(a)*r, e.z+Math.sin(a)*r, 6, 0.4); }
            if(dd<6){ plagueHit(1.1); toPlayer({ eff:'shake', shake:3 });
              broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'np_plague',zone:zoneName,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),ms:2200,r:6}); } }
        }
        else if(e.type==='necro_lich_mage'){
          // PLAGUE CASTER — plague bolts, SKULL BARRAGE, CORPSE EXPLOSION
          const MS=0.18;
          if(dd<7) mv(-sin*0.6+pr*strafe*0.7,-cos*0.6+pq*strafe*0.7,MS);
          else if(dd>17) mv(sin*0.6,cos*0.6,MS);
          else mv(pr*strafe*0.7,pq*strafe*0.7,MS);
          if(dd>2.5 && dd<20 && e.attackTimer%9===0){ shoot(ang,_NPL,0.55,2,0.16); }
          if(dd<20 && e._ab>=28){ e._ab=0; shoot(ang,_NSK,0.6,5,0.16);                 // flaming skulls
            broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_poof',zone:zoneName,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),col:_NB,n:6}); }
          e._corpse=(e._corpse||13)+1;
          if(dd<18 && e._corpse>=40){ e._corpse=0;
            const cx=nearestPlayer.x, cz=nearestPlayer.z;
            if(!game._sdGeyser) game._sdGeyser=[];
            broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'np_crossbones',zone:zoneName,ex:+cx.toFixed(2),ez:+cz.toFixed(2),col:_NSK,ms:640});
            game._sdGeyser.push({ zone:zoneName, x:cx, z:cz, fuse:7, dmg:_npDmgS(e,1.2), eid:e.id, col:_NSK, radius:4.0, status:'poison', statusDur:150 }); }
        }
        else if(e.type==='necro_specter'){
          // DEATH SPECTER — DEATH MARK, SPECTRAL WAIL, plague touch, phase blink
          const MS=0.372;
          if(dd<6) mv(-sin*0.6+pr*strafe*0.7,-cos*0.6+pq*strafe*0.7,MS);
          else if(dd>16) mv(sin*0.65,cos*0.65,MS);
          else mv(pr*strafe*0.7,pq*strafe*0.7,MS);
          if(dd>2.5 && dd<18 && e.attackTimer%8===0){ shoot(ang,_NNC,0.5,1,0); }
          if(dd<3.0 && e.attackTimer%8===0){ plagueHit(0.8); }
          // DEATH MARK — the crossbones brand follows you, then detonates (relock late)
          if(dd<16 && e._ab>=38){ e._ab=0;
            if(!game._sdGeyser) game._sdGeyser=[];
            broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'np_deathmark',zone:zoneName,ex:+nearestPlayer.x.toFixed(2),ez:+nearestPlayer.z.toFixed(2),col:_NNC,ms:900});
            game._sdGeyser.push({ zone:zoneName, x:nearestPlayer.x, z:nearestPlayer.z, fuse:9, dmg:_npDmgS(e,1.3), eid:e.id, col:_NSK, radius:4.0, shake:3, relock:3, status:'poison', statusDur:150, deathmark:1 }); }
          e._wail=(e._wail||18)+1;
          if(dd<8 && e._wail>=32){ e._wail=0;
            _pmShock(game,zoneName,e,e.x,e.z,6.0,0,_NNC,players,send);
            if(dd<6){ plagueHit(0.7); toPlayer({ eff:'slow', slow:0.5, root:1300 }); } }
          if(dd<3.5 && (e._ph=(e._ph||0)+1)>=25){ e._ph=0; npBlink(8); }
        }
        else { // necro_wight — BONE BRUISER
          const MS=0.228;
          if(dd>2.8) mv(sin*0.9+pr*strafe*0.3, cos*0.9+pq*strafe*0.3, MS); else mv(pr*strafe,pq*strafe,MS);
          if(dd<3.4 && e.attackTimer%6===0){ plagueHit(1.0); toPlayer({ eff:'slow', slow:0.55, root:900 }); }   // crippling strike
          if(dd<3.8 && e._ab>=20){ e._ab=0;                                                                      // BONE STORM burst
            _pmShock(game,zoneName,e,e.x,e.z,4.0,0,_NB,players,send); plagueHit(1.0); }
          e._toss=(e._toss||18)+1;
          if(dd>4 && dd<15 && e._toss>=32){ e._toss=0;                                                            // CADAVER TOSS
            broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_motes',zone:zoneName,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),col:_NRT,n:6});
            plagueCloud(nearestPlayer.x, nearestPlayer.z, 6, 0.5); }
        }

        if(_moved) changed.push(e);
      }

      // ── a545: VEILED SANCTUARY ritual AI (zone-gated to 'veiled_sanctuary'). Eight types:
      //   liturgists, censer processionals, flagellants, dissonant choirs, lithic judges,
      //   seal-wardens, and the two elites (Cardinal / Forsaken Abbot). Re-timed 60->10Hz.
      if (zoneName === 'veiled_sanctuary' && e.aggroed && VS_BESPOKE[e.type]) {
        const dxp=nearestPlayer.x-e.x, dzp=nearestPlayer.z-e.z, dd=Math.sqrt(dxp*dxp+dzp*dzp)||0.0001;
        const sin=dxp/dd, cos=dzp/dd, pr=cos, pq=-sin, ang=Math.atan2(dxp,dzp);
        const _VG=0xffd76a, _VV=0x8a4cff, _VE=0xff8844, _VGH=0xbfe8ff, _VST=0xc9b98a, _VAS=0xb8a888, _VBL=0xcc2244, _VDI=0x6a3aa0;
        if(e._strafe===undefined) e._strafe=Math.random()<0.5?1:-1;
        if(Math.random()<0.03) e._strafe=-e._strafe;
        const strafe=e._strafe;
        e._ab=(e._ab||0)+1;   // a556 — attackTimer is incremented by the generic enemy loop
          //   above (it runs for bespoke mobs too); incrementing it here as well ran every
          //   %-based attack check in this zone off a counter advancing 2 per tick.
        if(e._vsHealCD>0) e._vsHealCD--;
        let _moved=false;
        const mv=(vx,vz,sp)=>{ e.x+=vx*sp; e.z+=vz*sp; _moved=true; };
        const hit=(mult,status,sdur)=>{ players.forEach((p,ws)=>{ if(p===nearestPlayer){
          send(ws,{type:'sv_enemy_attack',eid:e.id,dmg:_vsDmgS(e,mult),ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),zone:zoneName});
          if(status) send(ws,{type:'sv_player_fx',zone:zoneName,eff:'status',status:status,statusDur:(sdur||120)}); } }); };
        const toPlayer=(msg)=>{ players.forEach((p,ws)=>{ if(p===nearestPlayer) send(ws, Object.assign({type:'sv_player_fx',zone:zoneName},msg)); }); };
        const shoot=(baseAng,col,mult,count,spread)=>{ for(let i=0;i<count;i++){ const a=baseAng+(count>1?(i-(count-1)/2)*spread:0); _sdSpawnProj(game,zoneName,e,a,col,_vsDmgS(e,mult),'plasma',null,0); } };
        // telegraphed ground eruption
        const tele=(tx,tz,fuse,radius,mult,col,slow,slowDur,shake,status)=>{ if(!game._sdGeyser) game._sdGeyser=[];
          game._sdGeyser.push({ zone:zoneName, x:tx, z:tz, fuse:fuse, dmg:_vsDmgS(e,mult), eid:e.id, col:col, radius:radius, slow:(slow===undefined?0:slow), slowDur:(slowDur||0), shake:(shake||0), status:(status||null), statusDur:120 });
          broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'vs_halo',zone:zoneName,ex:+tx.toFixed(2),ez:+tz.toFixed(2),col:col,ms:fuse*100}); };
        // incense / void cloud
        const cloud=(tx,tz,ticks,mult,col,burn,slowF)=>{ if(!game._sdGeyser) game._sdGeyser=[];
          broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_geyser_warn',zone:zoneName,ex:+tx.toFixed(2),ez:+tz.toFixed(2),col:col});
          for(let i=0;i<ticks;i++) game._sdGeyser.push({ zone:zoneName, x:tx, z:tz, fuse:3+i*3, dmg:_vsDmgS(e,mult), eid:e.id, col:col, radius:3.4, soft:1, status:(burn&&i%3===0?'burn':null), statusDur:120, slow:(slowF||0), slowDur:(slowF?420:0) }); };
        // sustained channel beam that re-aims each tick
        const channel=(ticks,mult,col)=>{ e._chan=ticks; e._chanMult=mult; e._chanCol=col; };
        const vsBlink=(distB,toward)=>{ broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_rift',zone:zoneName,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),col:_VV});
          const s=toward?1:-1; e.x+=s*Math.sin(ang)*distB; e.z+=s*Math.cos(ang)*distB; _moved=true;
          broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_rift',zone:zoneName,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),col:_VV}); };

        // resolve any active channel beam (choir verse / seal beam) — re-aims every tick
        if(e._chan>0){ e._chan--;
          broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_beam',zone:zoneName,eid:e.id,ex:+e.x.toFixed(2),ey:1.6,ez:+e.z.toFixed(2),tx:+nearestPlayer.x.toFixed(2),tz:+nearestPlayer.z.toFixed(2),col:(e._chanCol||_VGH),w:0.16});
          if(dd<18) hit(e._chanMult||0.4); }

        if(e.type==='veiled_acolyte'){
          // FROZEN LITURGIST — crystal bolts, LITANY OF THE SEAL, CENSURE brand, panic blink
          const MS=0.288;
          if(dd<5) mv(-sin*0.7+pr*strafe*0.6,-cos*0.7+pq*strafe*0.6,MS);
          else if(dd>14) mv(sin*0.7,cos*0.7,MS);
          else mv(pr*strafe,pq*strafe,MS);
          if(dd<2.4 && e.attackTimer%10===0){ hit(0.75); }
          if(dd>2.2 && dd<16 && e.attackTimer%9===0){ shoot(ang,_VG,0.55,1,0); }
          if(dd>3 && dd<16 && e._ab>=27){ e._ab=0; shoot(ang,_VV,0.5,3,0.2); }                  // LITANY
          e._cen=(e._cen||13)+1;
          if(dd<18 && e._cen>=43){ e._cen=0; tele(nearestPlayer.x,nearestPlayer.z,7,3.2,1.15,_VG,0,0,0,null); }   // CENSURE
          e._bl=(e._bl||0)+1;
          if(dd<3 && e._bl>=23){ e._bl=0; vsBlink(5+Math.random()*2,false); }
        }
        else if(e.type==='censer_bearer'){
          // EMBERWARD PROCESSIONAL — burning censer, SMOTHERING INCENSE, CENSER WHIRL
          const MS=0.204;
          if(dd>2.8) mv(sin*0.9+pr*strafe*0.3, cos*0.9+pq*strafe*0.3, MS);
          if(dd<3.2 && e.attackTimer%11===0){ hit(1.0,'burn',120); }
          if(dd<15 && e._ab>=31){ e._ab=0; cloud(nearestPlayer.x,nearestPlayer.z,7,0.45,_VE,true,0.7); }
          e._wh=(e._wh||17)+1;
          if(dd<5 && e._wh>=33){ e._wh=0; tele(e.x,e.z,6,4.2,1.3,_VE,0,0,2,'burn'); }
          if(dd>4 && dd<18 && e.attackTimer%17===0){ shoot(ang,_VE,0.65,1,0); }
        }
        else if(e.type==='penitent_striker'){
          // FLAGELLANT — chain-mace, PENITENT RUSH, CHAIN LASH (pull), SELF-SCOURGE frenzy
          if(e._frz>0) e._frz--;
          const _fr=e._frz>0;
          const MS=0.348*(_fr?1.3:1);
          if(e._charge){ e._cst=(e._cst||0)+1;
            if(e._charge==='wind'){ if(e._cst>=3){ e._charge='go'; e._cst=0; e._cdir=ang; e._chit=0; } }
            else { mv(Math.sin(e._cdir),Math.cos(e._cdir),MS*3.1);
              if(dd<2.6 && !e._chit){ hit(1.5); e._chit=1; _pmShock(game,zoneName,e,e.x,e.z,2.2,0,_VAS,players,send); }
              if(e._cst>=3){ e._charge=0; e._cst=0; } }
          } else {
            if(dd>2.6) mv(sin*0.8+pr*strafe*0.5, cos*0.8+pq*strafe*0.5, MS); else mv(pr*strafe,pq*strafe,MS);
            if(dd<3.0 && e.attackTimer%(_fr?6:9)===0){ hit(0.95); }
            e._tc=(e._tc||0)+1; if(dd>5 && dd<15 && e._tc>=32){ e._tc=0; e._charge='wind'; e._cst=0;
              broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_motes',zone:zoneName,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),col:_VAS,n:6}); }
            // CHAIN LASH — yanks you in on the censer chain
            e._vw=(e._vw||0)+1;
            if(dd>3 && dd<9 && e._vw>=28){ e._vw=0;
              broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_beam',zone:zoneName,eid:e.id,ex:+e.x.toFixed(2),ey:1.0,ez:+e.z.toFixed(2),tx:+nearestPlayer.x.toFixed(2),tz:+nearestPlayer.z.toFixed(2),col:_VAS,w:0.18});
              toPlayer({ eff:'pull', px:+e.x.toFixed(2), pz:+e.z.toFixed(2), pull:1.8 });
              toPlayer({ eff:'slow', slow:0.15, root:500 });
              if(dd<5) hit(0.85); }
            // SELF-SCOURGE — bleeds itself into a frenzy
            e._sc=(e._sc||0)+1;
            if(dd<20 && e._sc>=70 && !_fr){ e._sc=0; e._frz=50;
              e.hp=Math.max(1, e.hp-Math.floor(e.maxHp*0.015)); changed.push(e);
              _pmShock(game,zoneName,e,e.x,e.z,2.4,0,_VBL,players,send); }
          }
        }
        else if(e.type==='choir_wraith'){
          // DISSONANT CHOIR — sound-wave bolts, VERSE OF UNMAKING (channel), REQUIEM, drift-blink
          const MS=0.312;
          if(dd<7) mv(-sin*0.7+pr*strafe*0.7,-cos*0.7+pq*strafe*0.7,MS);
          else if(dd>13) mv(sin*0.6,cos*0.6,MS);
          else mv(pr*strafe,pq*strafe,MS);
          if(dd>2.5 && dd<17 && e.attackTimer%10===0){ shoot(ang,_VGH,0.55,2,0.14); }
          if(dd>3 && dd<16 && e._ab>=32 && !(e._chan>0)){ e._ab=0; channel(3,0.4,_VGH); }        // VERSE OF UNMAKING
          e._rq=(e._rq||12)+1;
          if(dd<9 && e._rq>=40){ e._rq=0;
            _pmShock(game,zoneName,e,e.x,e.z,4.6,0,_VDI,players,send);
            hit(0.9); toPlayer({ eff:'slow', slow:0.45, root:1200, shake:2 }); }                  // REQUIEM
          e._drift=(e._drift||10)+1; if(e._drift>=37){ e._drift=0; vsBlink(4+Math.random()*3,true); }
        }
        else if(e.type==='stone_inquisitor'){
          // LITHIC JUDGE — crushing blows, GAZE OF STONE (petrify), VERDICT, JUDGMENT SLAM
          const MS=0.12;
          if(dd>2.8) mv(sin,cos,MS);
          if(dd<3.4 && e.attackTimer%13===0){ hit(1.15); toPlayer({ eff:'shake', shake:2 }); }
          e._gz=(e._gz||10)+1;
          if(dd>3 && dd<14 && e._gz>=38){ e._gz=0;
            broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_beam',zone:zoneName,eid:e.id,ex:+e.x.toFixed(2),ey:2.6,ez:+e.z.toFixed(2),tx:+nearestPlayer.x.toFixed(2),tz:+nearestPlayer.z.toFixed(2),col:_VST,w:0.30});
            if(!game._sdGeyser) game._sdGeyser=[];
            game._sdGeyser.push({ zone:zoneName, x:nearestPlayer.x, z:nearestPlayer.z, fuse:6, dmg:_vsDmgS(e,1.0), eid:e.id, col:_VST, radius:3.4, slow:0.0, slowDur:900, petrify:1 });
            broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'vs_halo',zone:zoneName,ex:+nearestPlayer.x.toFixed(2),ez:+nearestPlayer.z.toFixed(2),col:_VST,ms:520}); }
          e._vd=(e._vd||8)+1;
          if(dd<12 && e._vd>=43){ e._vd=0;                                                        // VERDICT — 3 marching eruptions
            for(let vi=0;vi<3;vi++){ const fr2=(vi+1)/3;
              tele(e.x+(nearestPlayer.x-e.x)*fr2, e.z+(nearestPlayer.z-e.z)*fr2, 5+vi*3, 3.0, 0.8, _VG, 0,0,0,null); } }
          e._slam=(e._slam||7)+1;
          if(dd<5 && e._slam>=32){ e._slam=0; tele(e.x,e.z,6,4.6,1.5,_VST,0,0,4,null); }
        }
        else if(e.type==='ritual_guardian'){
          // WARDEN OF THE SEAL — rune bolts, RUNE PRISON, SEAL BEAM (channel), WARD PULSE
          const MS=0.156;
          if(dd>3.0) mv(sin*0.8+pr*strafe*0.3, cos*0.8+pq*strafe*0.3, MS);
          if(dd<3.4 && e.attackTimer%12===0){ hit(1.0); }
          if(dd>2.6 && dd<16 && e.attackTimer%11===0){ shoot(ang,_VV,0.6,2,0.16); }
          if(dd<14 && e._ab>=35){ e._ab=0;                                                        // RUNE PRISON
            if(!game._sdGeyser) game._sdGeyser=[];
            game._sdGeyser.push({ zone:zoneName, x:nearestPlayer.x, z:nearestPlayer.z, fuse:7, dmg:_vsDmgS(e,1.1), eid:e.id, col:_VV, radius:2.8, slow:0.0, slowDur:700 });
            broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'vs_halo',zone:zoneName,ex:+nearestPlayer.x.toFixed(2),ez:+nearestPlayer.z.toFixed(2),col:_VV,ms:700}); }
          e._sb=(e._sb||10)+1;
          if(dd>3 && dd<15 && e._sb>=37 && !(e._chan>0)){ e._sb=0; channel(3,0.45,_VV); }          // SEAL BEAM
          // WARD PULSE — mend the single most-wounded brother (per-target cooldown; no chain-healing)
          if(e._wd===undefined) e._wd=Math.floor(Math.random()*70);
          e._wd++;
          if(e._wd>=70){ e._wd=0;
            let best=null, bestFrac=0.6;
            for(let i=0;i<zone.enemies.length;i++){ const o=zone.enemies[i];
              if(!o||!o.active||o===e||!VS_BESPOKE[o.type]) continue;
              if((o._vsHealCD||0)>0) continue;
              if(Math.hypot(o.x-e.x,o.z-e.z)>12) continue;
              const fr3=o.hp/o.maxHp; if(fr3<bestFrac){ bestFrac=fr3; best=o; } }
            if(best){ best.hp=Math.min(best.maxHp, best.hp+Math.floor(best.maxHp*0.03)); best._vsHealCD=20; changed.push(best);
              broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_beam',zone:zoneName,eid:e.id,ex:+e.x.toFixed(2),ey:1.6,ez:+e.z.toFixed(2),tx:+best.x.toFixed(2),tz:+best.z.toFixed(2),col:_VG,w:0.14});
              broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'vs_halo',zone:zoneName,ex:+best.x.toFixed(2),ez:+best.z.toFixed(2),col:_VG,ms:320}); } }
        }
        else if(e.type==='veiled_cardinal'){
          // HERALD OF THE HALO (elite) — BENEDICTION OF RUIN, HALO FLARE, EXCOMMUNICATION
          const MS=0.216;
          if(dd<6) mv(-sin*0.6+pr*strafe*0.7,-cos*0.6+pq*strafe*0.7,MS);
          else if(dd>13) mv(sin*0.6,cos*0.6,MS);
          else mv(pr*strafe,pq*strafe,MS);
          if(dd>2.5 && dd<18 && e.attackTimer%8===0){ shoot(ang,_VG,0.6,1,0); }
          if(dd>3 && dd<20 && e._ab>=35){ e._ab=0; e._bene=4; }                                    // BENEDICTION — 4 stones in sequence
          if(e._bene>0){ e._bene--;
            const oa2=e._bene*1.5708 + e.attackTimer*0.02;
            const sx=e.x+Math.cos(oa2)*1.6, sz=e.z+Math.sin(oa2)*1.6;
            const ddx=nearestPlayer.x-sx, ddz=nearestPlayer.z-sz, dl=Math.hypot(ddx,ddz)||0.001;
            _sdSpawnProj(game,zoneName,{id:e.id,x:sx,z:sz,type:e.type,atk:e.atk}, Math.atan2(ddx/dl,ddz/dl), _VG, _vsDmgS(e,0.55), 'plasma', null, 0); }
          e._hf=(e._hf||10)+1;
          if(dd<7 && e._hf>=33){ e._hf=0; tele(e.x,e.z,6,5.0,1.3,_VG,0,0,2,null); }                // HALO FLARE
          e._ex=(e._ex||20)+1;
          if(dd<22 && e._ex>=63){ e._ex=0;                                                          // EXCOMMUNICATION — brand then judgment
            if(!game._sdGeyser) game._sdGeyser=[];
            broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'vs_excom',zone:zoneName,ex:+nearestPlayer.x.toFixed(2),ez:+nearestPlayer.z.toFixed(2),col:_VV,ms:900});
            game._sdGeyser.push({ zone:zoneName, x:nearestPlayer.x, z:nearestPlayer.z, fuse:9, dmg:_vsDmgS(e,1.6), eid:e.id, col:_VG, radius:4.2, shake:3, relock:3, excom:1 }); }
        }
        else { // forsaken_abbot (elite) — TWIN INCENSE, MISERERE, THE SEAL FAILS
          const MS=0.18;
          if(dd>3.4) mv(sin*0.8+pr*strafe*0.4, cos*0.8+pq*strafe*0.4, MS); else mv(pr*strafe,pq*strafe,MS);
          if(dd<4.0 && e.attackTimer%10===0){ e._side=!e._side;
            if(e._side) hit(1.05,'burn',120); else hit(1.05); }                                     // alternating fire/void censers
          if(dd>3 && dd<18 && e.attackTimer%12===0){ shoot(ang,_VE,0.55,1,0); shoot(ang+0.12,_VV,0.55,1,0); }
          if(dd<16 && e._ab>=33){ e._ab=0;                                                          // TWIN INCENSE
            cloud(nearestPlayer.x,nearestPlayer.z,7,0.45,_VE,true,0);
            const oa3=Math.random()*6.283;
            cloud(nearestPlayer.x+Math.cos(oa3)*3, nearestPlayer.z+Math.sin(oa3)*3, 7, 0.45, _VV, false, 0.7); }
          e._mi=(e._mi||25)+1;
          if(dd<14 && e._mi>=70){ e._mi=0;                                                          // MISERERE — the dirge of despair
            broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'vs_dirge',zone:zoneName,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),ms:2400,r:14});
            _pmShock(game,zoneName,e,e.x,e.z,6.0,0,_VDI,players,send);
            if(dd<12){ hit(1.2); toPlayer({ eff:'slow', slow:0.55, root:1600, shake:3 }); } }
          e._sf=(e._sf||13)+1;
          if(dd<14 && e._sf>=50){ e._sf=0;                                                          // THE SEAL FAILS
            for(let si=0;si<5;si++){ const sa=Math.random()*6.283, sr=3+Math.random()*4;
              tele(e.x+Math.cos(sa)*sr, e.z+Math.sin(sa)*sr, 6, 3.0, 0.9, _VV, 0,0,0,null); } }
        }

        if(_moved) changed.push(e);
      }

      // ── a546: VAELTHARAX'S LAIR volcanic AI (zone-gated to 'dragonlair'). Fissure eruptions,
      //   aerial firebomb strafing runs, magma webs, lingering lava pools, the golem's
      //   damage-triggered eruption, and the ceiling meteor storm. Re-timed 60->10Hz.
      //   NOTE: only the four DL_BESPOKE types run this; the lair's generic guardians/mages
      //   fall through to the ordinary server move/attack path, matching the client.
      if (zoneName === 'dragonlair' && e.aggroed && DL_BESPOKE[e.type]) {
        const dxp=nearestPlayer.x-e.x, dzp=nearestPlayer.z-e.z, dd=Math.sqrt(dxp*dxp+dzp*dzp)||0.0001;
        const sin=dxp/dd, cos=dzp/dd, pr=cos, pq=-sin, ang=Math.atan2(dxp,dzp);
        const _DLV=0xff5410, _DEM=0xff8a30, _DCO=0xffd040, _DVE=0x9ad040, _DDK=0x2a0e04;
        if(e._strafe===undefined) e._strafe=Math.random()<0.5?1:-1;
        if(Math.random()<0.03) e._strafe=-e._strafe;
        const strafe=e._strafe;
        e._ab=(e._ab||0)+1;   // a556 — attackTimer is incremented by the generic enemy loop
          //   above (it runs for bespoke mobs too); incrementing it here as well ran every
          //   %-based attack check in this zone off a counter advancing 2 per tick.
        let _moved=false;
        const mv=(vx,vz,sp)=>{ e.x+=vx*sp; e.z+=vz*sp; _moved=true; };
        const hit=(mult,burnDur)=>{ players.forEach((p,ws)=>{ if(p===nearestPlayer){
          send(ws,{type:'sv_enemy_attack',eid:e.id,dmg:_dlDmgS(e,mult),ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),zone:zoneName});
          if(burnDur) send(ws,{type:'sv_player_fx',zone:zoneName,eff:'status',status:'burn',statusDur:burnDur}); } }); };
        const toPlayer=(msg)=>{ players.forEach((p,ws)=>{ if(p===nearestPlayer) send(ws, Object.assign({type:'sv_player_fx',zone:zoneName},msg)); }); };
        const shoot=(baseAng,col,mult,count,spread)=>{ for(let i=0;i<count;i++){ const a=baseAng+(count>1?(i-(count-1)/2)*spread:0); _sdSpawnProj(game,zoneName,e,a,col,_dlDmgS(e,mult),'plasma','burn',90); } };
        // FIRE COLUMN — a pillar of flame erupts from marked ground
        const fireCol=(tx,tz,fuse,mult)=>{ if(!game._sdGeyser) game._sdGeyser=[];
          game._sdGeyser.push({ zone:zoneName, x:tx, z:tz, fuse:fuse, dmg:_dlDmgS(e,mult), eid:e.id, col:_DLV, radius:2.2, status:'burn', statusDur:120 });
          broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'dl_firecol',zone:zoneName,ex:+tx.toFixed(2),ez:+tz.toFixed(2),col:_DLV,fuse:fuse*100}); };
        // LAVA POOL — a glowing molten patch that lingers and burns
        const lavaPool=(tx,tz,ticks)=>{ if(!game._sdGeyser) game._sdGeyser=[];
          broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'dl_lavapool',zone:zoneName,ex:+tx.toFixed(2),ez:+tz.toFixed(2),ms:ticks*300});
          for(let i=0;i<ticks;i++) game._sdGeyser.push({ zone:zoneName, x:tx, z:tz, fuse:2+i*3, dmg:_dlDmgS(e,0.30), eid:e.id, col:_DLV, radius:1.9, soft:1, status:(i%3===0?'burn':null), statusDur:80 }); };

        if(e.type==='fire_demon'){
          // BRIMSTONE FIEND — flame lash, cinder bolts, FISSURE ERUPTION
          const MS=0.264;
          if(dd>2.8) mv(sin*0.9+pr*strafe*0.35, cos*0.9+pq*strafe*0.35, MS); else mv(pr*strafe,pq*strafe,MS);
          if(dd<3.0 && e.attackTimer%10===0){ hit(1.0,90); }
          if(dd>2.6 && dd<14 && e.attackTimer%12===0){ shoot(ang,_DEM,0.55,2,0.16); }
          e._fs=(e._fs||Math.floor(Math.random()*25))+1;
          if(dd>2 && dd<15 && e._fs>=47){ e._fs=0;                                   // cracks race out toward you
            for(let fi=0;fi<5;fi++){ const d2=3+fi*2.2;
              fireCol(e.x+Math.sin(ang)*d2, e.z+Math.cos(ang)*d2, 3+fi*2, 0.75); } }
        }
        else if(e.type==='wyvern'){
          // ASH WYVERN — aerial; STRAFING FIREBOMB RUN, wing-buffet knockback
          const MS=0.36;
          if(e._run==='strafe'){
            e._rt=(e._rt||0)+1;
            mv(Math.sin(e._runDir), Math.cos(e._runDir), MS*2.4);
            if(e._rt%1===0){ fireCol(e.x, e.z, 2, 0.6); }                            // craters along the run
            if(e._rt>=3){ e._run=0; e._rt=0;
              broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'dl_wyvern_land',zone:zoneName,eid:e.id}); }
            if(_moved) changed.push(e);
          } else {
            if(dd>3.0) mv(sin*0.85+pr*strafe*0.5, cos*0.85+pq*strafe*0.5, MS);
            else mv(pr*strafe*1.1, pq*strafe*1.1, MS);
            if(dd<3.4 && e.attackTimer%10===0){ hit(1.05,0);
              toPlayer({ eff:'push', px:+e.x.toFixed(2), pz:+e.z.toFixed(2), push:1.6 }); }   // wing buffet
            if(dd>2.8 && dd<13 && e.attackTimer%13===0){ shoot(ang,_DLV,0.55,1,0); }
            e._fr=(e._fr||Math.floor(Math.random()*28))+1;
            if(dd>4 && dd<18 && e._fr>=50){ e._fr=0; e._run='strafe'; e._rt=0;
              e._runDir=Math.atan2(nearestPlayer.x-e.x, nearestPlayer.z-e.z);
              broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'dl_wyvern_climb',zone:zoneName,eid:e.id,dir:+e._runDir.toFixed(3),dur:900}); }
          }
        }
        else if(e.type==='void_spider'){
          // CINDER BROODLING — flanking lunges, venomous magma spit, MAGMA WEB
          const MS=0.396;
          if(dd<3.0 && !(e._lunge>0) && e._ab>=15){ e._ab=0; e._lunge=2; e._ldir=ang; }
          if(e._lunge>0){ e._lunge--; mv(Math.sin(e._ldir),Math.cos(e._ldir),MS*2.0);
            if(dd<2.0){ hit(0.9,0); e._lunge=0; }
          } else {
            if(dd>2.4) mv(sin*0.8+pr*strafe*0.7, cos*0.8+pq*strafe*0.7, MS); else mv(pr*strafe,pq*strafe,MS);
          }
          if(dd<2.6 && e.attackTimer%9===0){ hit(0.85,0); }
          if(dd>2.4 && dd<12 && e.attackTimer%12===0){ shoot(ang,_DVE,0.5,1,0); }
          e._wb=(e._wb||Math.floor(Math.random()*27))+1;
          if(dd>3 && dd<12 && e._wb>=43){ e._wb=0;                                    // MAGMA WEB — snare + burning patch
            const wx=nearestPlayer.x, wz=nearestPlayer.z;
            if(!game._sdGeyser) game._sdGeyser=[];
            game._sdGeyser.push({ zone:zoneName, x:wx, z:wz, fuse:4, dmg:_dlDmgS(e,0.7), eid:e.id, col:_DVE, radius:2.2, slow:0.12, slowDur:1100, status:'burn', statusDur:150 });
            broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_geyser_warn',zone:zoneName,ex:+wx.toFixed(2),ez:+wz.toFixed(2),col:_DVE});
            lavaPool(wx, wz, 5); }
        }
        else { // inferno_golem — MOLTEN COLOSSUS
          const MS=0.12;
          if(dd>3.4) mv(sin,cos,MS);
          if(dd<3.8 && e.attackTimer%13===0){ hit(1.25,110); toPlayer({ eff:'shake', shake:2 }); }
          e._st2=(e._st2||0)+1;
          if(dd>2 && dd<12 && e._st2>=25){ e._st2=0;                                   // molten stomp -> lingering pool
            broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_geyser_warn',zone:zoneName,ex:+nearestPlayer.x.toFixed(2),ez:+nearestPlayer.z.toFixed(2),col:_DLV});
            lavaPool(nearestPlayer.x, nearestPlayer.z, 9); }
          // ERUPTION — it blasts everything nearby when it takes heavy damage
          if(e._lastHp===undefined) e._lastHp=e.hp;
          if(e.hp < e._lastHp - e.maxHp*0.08){ e._lastHp=e.hp;
            if(!(e._eruptCd>0)){ e._eruptCd=40;
              _pmShock(game,zoneName,e,e.x,e.z,4.4,0,_DLV,players,send);
              if(dd<4.5){ hit(0.9,0); toPlayer({ eff:'shake', shake:3 }); } } }
          if(e._lastHp>e.hp) e._lastHp=e.hp;
          if(e._eruptCd>0) e._eruptCd--;
          // METEOR STORM — rocks fall from the lair ceiling onto marked ground
          e._ms3=(e._ms3||Math.floor(Math.random()*33))+1;
          if(dd<16 && e._ms3>=60){ e._ms3=0;
            broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'dl_ashfall',zone:zoneName,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),ms:2600,r:16});
            for(let mi=0;mi<5;mi++){
              const tx=nearestPlayer.x+(Math.random()-0.5)*8, tz=nearestPlayer.z+(Math.random()-0.5)*8;
              if(!game._sdGeyser) game._sdGeyser=[];
              game._sdGeyser.push({ zone:zoneName, x:tx, z:tz, fuse:5+mi*3, dmg:_dlDmgS(e,0.9), eid:e.id, col:_DLV, radius:2.4, status:'burn', statusDur:120, shake:2 });
              broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'dl_meteor',zone:zoneName,ex:+tx.toFixed(2),ez:+tz.toFixed(2),fall:(5+mi*3)*100}); } }
        }

        if(_moved) changed.push(e);
      }

      // ── a547: RIFT VALE void/rift AI (zone-gated to 'riftvale'). Gravity singularities that
      //   drag you in then collapse, rift tears, reality crush, rift dashes, phase strikes,
      //   MIND SHATTER (breaks your controls), terror-scream knockback, void weave, entangling
      //   void. Re-timed 60->10Hz.
      if (zoneName === 'riftvale' && e.aggroed && RV_BESPOKE[e.type]) {
        const dxp=nearestPlayer.x-e.x, dzp=nearestPlayer.z-e.z, dd=Math.sqrt(dxp*dxp+dzp*dzp)||0.0001;
        const sin=dxp/dd, cos=dzp/dd, pr=cos, pq=-sin, ang=Math.atan2(dxp,dzp);
        const _RP=0x9b30ff, _RM=0xd040ff, _RD=0x4b0082, _RC=0x30ffe0;
        if(e._strafe===undefined) e._strafe=Math.random()<0.5?1:-1;
        if(Math.random()<0.03) e._strafe=-e._strafe;
        const strafe=e._strafe;
        e._ab=(e._ab||0)+1;   // a556 — attackTimer is incremented by the generic enemy loop
          //   above (it runs for bespoke mobs too); incrementing it here as well ran every
          //   %-based attack check in this zone off a counter advancing 2 per tick.
        let _moved=false;
        const mv=(vx,vz,sp)=>{ e.x+=vx*sp; e.z+=vz*sp; _moved=true; };
        const hit=(mult)=>{ players.forEach((p,ws)=>{ if(p===nearestPlayer) send(ws,{type:'sv_enemy_attack',eid:e.id,dmg:_rvDmgS(e,mult),ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),zone:zoneName}); }); };
        const toPlayer=(msg)=>{ players.forEach((p,ws)=>{ if(p===nearestPlayer) send(ws, Object.assign({type:'sv_player_fx',zone:zoneName},msg)); }); };
        const shoot=(baseAng,mult,count,spread)=>{ for(let i=0;i<count;i++){ const a=baseAng+(count>1?(i-(count-1)/2)*spread:0); _sdSpawnProj(game,zoneName,e,a,_RP,_rvDmgS(e,mult),'plasma',null,0); } };
        // RIFT TEAR — telegraphed void eruption
        const riftTear=(tx,tz,mult)=>{ if(!game._sdGeyser) game._sdGeyser=[];
          game._sdGeyser.push({ zone:zoneName, x:tx, z:tz, fuse:6, dmg:_rvDmgS(e,mult), eid:e.id, col:_RP, radius:3.6, slow:0.4, slowDur:700 });
          broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'rv_tear',zone:zoneName,ex:+tx.toFixed(2),ez:+tz.toFixed(2),col:_RP,ms:540}); };

        if(e.type==='void_colossus'){
          // WORLD-ENDER — GRAVITY SINGULARITY, VOID SLAM, REALITY CRUSH
          const MS=0.108;
          if(dd>4.0) mv(sin,cos,MS);
          if(dd<4.6 && e.attackTimer%13===0){ hit(1.0); toPlayer({ eff:'shake', shake:3 }); }
          // GRAVITY SINGULARITY — a black hole that drags for ~18 ticks then collapses
          if(dd>4 && dd<26 && e._ab>=37){ e._ab=0;
            const cx=nearestPlayer.x + (e.x-nearestPlayer.x)*0.22, cz=nearestPlayer.z + (e.z-nearestPlayer.z)*0.22;
            if(!game._sdGeyser) game._sdGeyser=[];
            broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'rv_singularity',zone:zoneName,ex:+cx.toFixed(2),ez:+cz.toFixed(2),col:_RP,ms:1900});
            for(let k=0;k<9;k++) game._sdGeyser.push({ zone:zoneName, x:cx, z:cz, fuse:2+k*2, dmg:0, eid:e.id, col:_RP, radius:9.0, soft:1, pull:1.1 });
            game._sdGeyser.push({ zone:zoneName, x:cx, z:cz, fuse:19, dmg:_rvDmgS(e,1.4), eid:e.id, col:_RP, radius:6.5, shake:4 }); }
          e._slam=(e._slam||10)+1;
          if(dd>3 && dd<16 && e._slam>=25){ e._slam=0; riftTear(nearestPlayer.x, nearestPlayer.z, 1.2); }
          e._crush=(e._crush||20)+1;
          if(dd<18 && e._crush>=57){ e._crush=0;                                        // REALITY CRUSH
            broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'rv_crush',zone:zoneName,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),ms:2600,r:18});
            _pmShock(game,zoneName,e,e.x,e.z,7.0,0,_RP,players,send);
            if(dd<7){ hit(1.3); toPlayer({ eff:'shake', shake:2 }); } }
        }
        else if(e.type==='rift_stalker'){
          // RELENTLESS HUNTER — RIFT DASH, PHASE STRIKE, dimensional rake
          const MS=0.33;
          if(e._phase){ e._pst=(e._pst||0)+1;
            mv(Math.sin(e._pdir),Math.cos(e._pdir),MS*2.6);
            if(dd<2.4 && !e._phit){ hit(1.3); e._phit=1; }
            if(e._pst>=3){ e._phase=0; e._pst=0; }
          } else {
            if(dd>2.6) mv(sin*0.9+pr*strafe*0.35, cos*0.9+pq*strafe*0.35, MS); else mv(pr*strafe,pq*strafe,MS);
            if(dd<3.0 && e.attackTimer%7===0){ hit(1.0); }
            // RIFT DASH — blink through a tear to close a long gap
            if(dd>10 && dd<40 && e._ab>=20){ e._ab=0;
              const dstep=Math.min(dd-3,14);
              broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'rv_blink',zone:zoneName,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),col:_RP});
              e.x+=Math.sin(ang)*dstep; e.z+=Math.cos(ang)*dstep; _moved=true;
              broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'rv_blink',zone:zoneName,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),col:_RM}); }
            if(dd>4 && dd<12 && (e._pg=(e._pg||0)+1)>=18){ e._pg=0; e._phase=1; e._pst=0; e._pdir=ang; e._phit=0;
              broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_motes',zone:zoneName,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),col:_RP,n:6}); }
          }
        }
        else if(e.type==='psyche_horror'){
          // PSYCHIC TERROR — psychic lances, MIND SHATTER, TERROR SCREAM
          const MS=0.27;
          if(dd<7) mv(-sin*0.6+pr*strafe*0.7,-cos*0.6+pq*strafe*0.7,MS);
          else if(dd>16) mv(sin*0.6,cos*0.6,MS);
          else mv(pr*strafe*0.7,pq*strafe*0.7,MS);
          if(dd>2.5 && dd<20 && e.attackTimer%9===0){ shoot(ang,0.55,2,0.18); }
          // MIND SHATTER — reality warps AND the player's controls break
          if(dd<15 && e._ab>=42){ e._ab=0;
            broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'rv_mindshatter',zone:zoneName,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),ms:2200,r:15});
            if(dd<15){ hit(0.7); toPlayer({ eff:'confuse', dur:150 }); toPlayer({ eff:'slow', slow:0.55, root:2000 }); } }
          e._scream=(e._scream||12)+1;
          if(dd<9 && e._scream>=34){ e._scream=0;                                        // TERROR SCREAM — fear knockback
            _pmShock(game,zoneName,e,e.x,e.z,7.0,0,_RM,players,send);
            if(dd<7){ hit(0.9);
              toPlayer({ eff:'push', px:+e.x.toFixed(2), pz:+e.z.toFixed(2), push:3.2, shake:2 });
              toPlayer({ eff:'slow', slow:0.5, root:1200 }); } }
        }
        else { // rift_weaver — WEAVER OF THE BREACH
          const MS=0.36;
          if(dd<7) mv(-sin*0.6+pr*strafe*0.7,-cos*0.6+pq*strafe*0.7,MS);
          else if(dd>17) mv(sin*0.7,cos*0.7,MS);
          else mv(pr*strafe*0.7,pq*strafe*0.7,MS);
          if(dd>2.5 && dd<20 && e.attackTimer%8===0){ shoot(ang,0.5,3,0.14); }
          // RIFT TEARS — several void eruptions around the player
          if(dd<18 && e._ab>=32){ e._ab=0;
            for(let i=0;i<3;i++){ const a=Math.random()*6.283, r=2+Math.random()*4;
              riftTear(nearestPlayer.x+Math.cos(a)*r, nearestPlayer.z+Math.sin(a)*r, 0.9); } }
          e._weave=(e._weave||7)+1;
          if(dd<20 && e._weave>=35){ e._weave=0;                                          // VOID WEAVE — radiating beams
            for(let i=0;i<6;i++){ const a=i*1.047;
              broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'sd_beam',zone:zoneName,eid:e.id,ex:+e.x.toFixed(2),ey:1.3,ez:+e.z.toFixed(2),tx:+(e.x+Math.sin(a)*10).toFixed(2),tz:+(e.z+Math.cos(a)*10).toFixed(2),col:_RC,w:0.35}); }
            if(dd<10) hit(1.0); }
          e._ent=(e._ent||15)+1;
          if(dd>2 && dd<13 && e._ent>=40){ e._ent=0;                                      // ENTANGLING VOID — hard root
            if(!game._sdGeyser) game._sdGeyser=[];
            game._sdGeyser.push({ zone:zoneName, x:nearestPlayer.x, z:nearestPlayer.z, fuse:6, dmg:_rvDmgS(e,1.0), eid:e.id, col:_RD, radius:2.6, slow:0.0, slowDur:900 });
            broadcastToZone(game.id,zoneName,{type:'sv_fx',vt:'rv_tear',zone:zoneName,ex:+nearestPlayer.x.toFixed(2),ez:+nearestPlayer.z.toFixed(2),col:_RD,ms:520}); }
        }

        if(_moved) changed.push(e);
      }

        // ── a548: WYVERN WASTES pack AI (zone-gated to 'wyvernwastes'; all three types also
        //    appear in 'mirrored', which is NOT migrated). ALPHA'S CALL pack surge, talon
        //    dives, deep-wyrm burrow ambush, glacial flamebreath, tail sweep, frostfire roar.
        //    Re-timed 60fps -> 10Hz: frame counters /6, per-frame speeds *6.
        //    HP intentionally UNCHANGED — the client kit applies no zone-local bump.
        if (zoneName === 'wyvernwastes' && e.aggroed && WW_BESPOKE[e.type]) {
          const dxp=nearestPlayer.x-e.x, dzp=nearestPlayer.z-e.z, dd=Math.sqrt(dxp*dxp+dzp*dzp)||0.0001;
          const sin=dxp/dd, cos=dzp/dd, pr=cos, pq=-sin, ang=Math.atan2(dxp,dzp);
          if(e._strafe===undefined) e._strafe=Math.random()<0.5?1:-1;
          if(Math.random()<0.036) e._strafe=-e._strafe;          // 0.006/frame -> ~0.036/tick
          const strafe=e._strafe;
          if(e._packT>0) e._packT--;                             // ALPHA'S CALL surge timer
          const _pk=(e._packT>0)?1.2:1;                          // surge scales SPEED only, never damage
          e._ab=(e._ab||0)+1;   // a556 — attackTimer is incremented by the generic enemy loop
          //   above (it runs for bespoke mobs too); incrementing it here as well ran every
          //   %-based attack check in this zone off a counter advancing 2 per tick.
          let _moved=false;
          const mv=(vx,vz,sp)=>{ e.x+=vx*sp; e.z+=vz*sp; _moved=true; };
          const hit=(mult)=>{ players.forEach((p,ws)=>{ if(p===nearestPlayer)
            send(ws,{type:'sv_enemy_attack',eid:e.id,dmg:_wwDmgS(e,mult),ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),zone:zoneName}); }); };
          const toPlayer=(msg)=>{ players.forEach((p,ws)=>{ if(p===nearestPlayer)
            send(ws, Object.assign({type:'sv_player_fx',zone:zoneName},msg)); }); };
          const fx=(vt,extra)=>{ broadcastToZone(game.id,zoneName, Object.assign({type:'sv_fx',vt:vt,zone:zoneName},extra||{})); };
          const shoot=(baseAng,col,mult,count,spread,st,sd)=>{ for(let i=0;i<count;i++){
            const a=baseAng+(count>1?(i-(count-1)/2)*spread:0);
            _sdSpawnProj(game,zoneName,e,a,col,_wwDmgS(e,mult),'plasma',st||null,sd||0); } };
          const tele=(tx,tz,fuse,radius,mult,col,push)=>{ if(!game._sdGeyser) game._sdGeyser=[];
            game._sdGeyser.push({zone:zoneName,x:tx,z:tz,fuse:fuse,dmg:_wwDmgS(e,mult),eid:e.id,col:col,radius:radius,push:(push||0)});
            fx('sd_geyser_warn',{ex:+tx.toFixed(2),ez:+tz.toFixed(2),col:col}); };

          if(e.type==='wyvern_warlord'){
            // ALPHA WYVERN — strafing flight, fire fans, TALON DIVE, ALPHA'S CALL
            const MS=0.36*_pk;
            if(e._dv==='climb'){
              e._dt=(e._dt||0)+1;
              if(e._dt>=3){ e._dv='dive'; e._dt=0; e._ddir=ang; e._dhit=0;
                fx('ww_dive',{eid:e.id,dir:+ang.toFixed(3)}); }
            } else if(e._dv==='dive'){
              e._dt=(e._dt||0)+1;
              mv(Math.sin(e._ddir),Math.cos(e._ddir),MS*3.2);
              if(dd<2.6 && !e._dhit){ e._dhit=1; hit(1.3);
                toPlayer({eff:'shake',shake:2});
                fx('sd_shock',{ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),col:_WW_FIRE,r:2.4}); }
              if(e._dt>=3){ e._dv=0; e._dt=0; fx('ww_land',{eid:e.id}); }
            } else {
              // strafing orbit at rake range
              if(dd<3.2) mv(-sin*0.4+pr*strafe*0.8, -cos*0.4+pq*strafe*0.8, MS);
              else if(dd>10) mv(sin*0.9, cos*0.9, MS);
              else mv(sin*0.3+pr*strafe*0.8, cos*0.3+pq*strafe*0.8, MS);
              // talon rake (burn on contact)
              if(dd<3.0 && e.attackTimer%11===0){ hit(0.95); toPlayer({eff:'status',status:'burn',statusDur:100});
                fx('sd_motes',{ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),col:_WW_FIRE,n:5}); }
              // fire spread fan
              if(dd>2.5 && dd<15 && e._ab>=25){ e._ab=0; shoot(ang,_WW_FIRE,0.55,5,0.20); }
              // TALON DIVE setup
              e._dc2=(e._dc2||Math.floor(Math.random()*20))+1;
              if(dd>4 && dd<13 && e._dc2>=35){ e._dc2=0; e._dv='climb'; e._dt=0; fx('ww_climb',{eid:e.id}); }
              // ALPHA'S CALL — the pack answers.
              // a548: the client gated only the ANNOUNCE on an 8s cooldown while the surge
              //   itself fired every time. Solo that's invisible; with 72 warlords and a party
              //   the surges would overlap and hold most of the zone at 1.2x speed permanently.
              //   Here the SURGE shares the 8s zone cooldown, so it stays a burst, not a state.
              e._ac=(e._ac||Math.floor(Math.random()*50))+1;
              if(dd<14 && e._ac>=70){ e._ac=0;
                const _now=Date.now();
                if(!zone._wwCallCd || _now>zone._wwCallCd){
                  zone._wwCallCd=_now+8000;
                  fx('ww_call',{ex:+e.x.toFixed(2),ez:+e.z.toFixed(2)});
                  for(let i=0;i<zone.enemies.length;i++){ const o=zone.enemies[i];
                    if(!o||!o.active||!WW_BESPOKE[o.type]||o===e) continue;
                    const odx=o.x-e.x, odz=o.z-e.z;
                    if(odx*odx+odz*odz>400) continue;            // 20u radius
                    o.aggroed=true; o._packT=50;                 // 300 frames -> 50 ticks
                  }
                  e._packT=50;
                }
              }
            }
          }
          else if(e.type==='deep_wyrm'){
            // BURROW AMBUSH — submerge, tunnel under the player as a moving mound, erupt.
            // The server owns x/z but carries no visibility, so the dig/erupt transitions are
            // broadcast as cues and the client hides/reveals + snaps the mesh (see 40_enemy_ai).
            const MS=0.204*_pk;
            if(e._bw==='dig'){
              e._bt=(e._bt||0)+1;
              if(e._bt>=3){ e._bw='tunnel'; e._bt=0; e._wwHidden=1;
                fx('ww_burrow',{eid:e.id,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),col:_WW_EARTH}); }
            } else if(e._bw==='tunnel'){
              e._bt=(e._bt||0)+1;
              mv(sin,cos,0.84);                                   // 0.14/frame -> 0.84/tick
              if(e._bt%1===0) fx('sd_motes',{ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),col:_WW_EARTH,n:2});
              if(dd<1.8 || e._bt>=15){ e._bw='erupt'; e._bt=0;
                e.x=nearestPlayer.x; e.z=nearestPlayer.z; _moved=true;   // surfaces beneath the target
                fx('sd_geyser_warn',{ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),col:_WW_EARTH}); }
            } else if(e._bw==='erupt'){
              e._bt=(e._bt||0)+1;
              if(e._bt>=6){ e._bw=0; e._bt=0; e._wwHidden=0;
                fx('ww_erupt',{eid:e.id,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),col:_WW_EARTH});
                const _edx=nearestPlayer.x-e.x, _edz=nearestPlayer.z-e.z;
                if(Math.sqrt(_edx*_edx+_edz*_edz)<2.6){ hit(1.3); toPlayer({eff:'shake',shake:3}); }
              }
            } else {
              // surface behavior
              if(dd>1.8) mv(sin*0.9+pr*strafe*0.3, cos*0.9+pq*strafe*0.3, MS);
              if(dd<2.6 && e.attackTimer%12===0){ hit(1.0);
                fx('sd_motes',{ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),col:_WW_EARTH,n:4}); }
              // venom spit — twin bolts, poisons
              if(dd>2.2 && dd<14 && e.attackTimer%14===0) shoot(ang,_WW_VENOM,0.55,2,0.14,'poison',150);
              // CONSTRICT — lunging bite that snares
              e._cl=(e._cl||0)+1;
              if(dd>2 && dd<6 && e._cl>=32){ e._cl=0;
                mv(sin,cos,1.6);                                  // one-shot lunge displacement
                const _cdx=nearestPlayer.x-e.x, _cdz=nearestPlayer.z-e.z;
                if(Math.sqrt(_cdx*_cdx+_cdz*_cdz)<3.0){ hit(1.1);
                  toPlayer({eff:'status',status:'poison',statusDur:150});
                  toPlayer({eff:'slow',slow:0.5,root:600}); }
                fx('sd_shock',{ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),col:_WW_VENOM,r:1.8}); }
              // BURROW cycle
              e._bc=(e._bc||Math.floor(Math.random()*33))+1;
              if(dd>4 && dd<18 && e._bc>=47){ e._bc=0; e._bw='dig'; e._bt=0;
                fx('sd_motes',{ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),col:_WW_EARTH,n:3}); }
            }
          }
          else {
            // ELDER OF THE WASTES — stomps, GLACIAL FLAMEBREATH, TAIL SWEEP, FROSTFIRE ROAR
            const MS=0.192*_pk;
            if(dd>3.2) mv(sin,cos,MS);
            if(dd<3.8 && e.attackTimer%14===0){ hit(1.2); toPlayer({eff:'shake',shake:2});
              fx('sd_shock',{ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),col:_WW_FIRE,r:2.4}); }
            // GLACIAL FLAMEBREATH — three eruptions march down the line at you.
            //   Client staggered them 220ms apart with a 480ms telegraph each; at 10Hz that
            //   is fuse 5, 7, 9.
            if(dd>3 && dd<14 && e._ab>=38){ e._ab=0;
              for(let fi=0;fi<3;fi++){ const fr2=(fi+1)/3;
                tele(e.x+(nearestPlayer.x-e.x)*fr2, e.z+(nearestPlayer.z-e.z)*fr2, 5+fi*2, 2.8, 0.75, _WW_FIRE); } }
            // TAIL SWEEP — telegraphed, then launches you (delayed push rides the geyser)
            e._ts=(e._ts||0)+1;
            if(dd<5 && e._ts>=37){ e._ts=0; tele(e.x, e.z, 6, 4.5, 1.2, _WW_EMBER, 2.4); }
            // FROSTFIRE ROAR — twin ice/fire shockwaves + slow, the zone's signature
            e._rr=(e._rr||17)+1;
            if(dd<9 && e._rr>=57){ e._rr=0;
              fx('sd_shock',{ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),col:_WW_ICE,r:6.0});
              fx('sd_shock',{ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),col:_WW_FIRE,r:4.2});
              fx('ww_roar',{ex:+e.x.toFixed(2),ez:+e.z.toFixed(2)});
              if(dd<6){ hit(1.0); toPlayer({eff:'slow',slow:0.55,root:1400}); toPlayer({eff:'shake',shake:3}); } }
          }

          if(_moved) changed.push(e);
        }

        // ── a549: NEON HOLLOW dead-city machine AI (zone-gated to 'neon_hollow'; every type
        //    also appears in 'mirrored', which is NOT migrated). The city classifies you as
        //    an anomaly and hunts accordingly. Re-timed 60fps -> 10Hz (counters /6, speeds *6).
        //    HP intentionally UNCHANGED. Altitude needs no sync — hover heights are static py.
        if (zoneName === 'neon_hollow' && e.aggroed && NH_BESPOKE[e.type]) {
          const dxp=nearestPlayer.x-e.x, dzp=nearestPlayer.z-e.z, dd=Math.sqrt(dxp*dxp+dzp*dzp)||0.0001;
          const sin=dxp/dd, cos=dzp/dd, pr=cos, pq=-sin, ang=Math.atan2(dxp,dzp);
          if(e._strafe===undefined) e._strafe=Math.random()<0.5?1:-1;
          if(Math.random()<0.036) e._strafe=-e._strafe;
          const strafe=e._strafe;
          const _tg=_nhIsTagged(nearestPlayer);
          e._ab=(e._ab||0)+1;   // a556 — attackTimer is incremented by the generic enemy loop
          //   above (it runs for bespoke mobs too); incrementing it here as well ran every
          //   %-based attack check in this zone off a counter advancing 2 per tick.
          if(e._nhHealCD>0) e._nhHealCD--;
          let _moved=false;
          const mv=(vx,vz,sp)=>{ e.x+=vx*sp; e.z+=vz*sp; _moved=true; };
          const hit=(mult)=>{ players.forEach((p,ws)=>{ if(p===nearestPlayer)
            send(ws,{type:'sv_enemy_attack',eid:e.id,dmg:_nhDmgS(e,mult,nearestPlayer),ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),zone:zoneName}); }); };
          const toPlayer=(msg)=>{ players.forEach((p,ws)=>{ if(p===nearestPlayer)
            send(ws, Object.assign({type:'sv_player_fx',zone:zoneName},msg)); }); };
          const fx=(vt,extra)=>{ broadcastToZone(game.id,zoneName, Object.assign({type:'sv_fx',vt:vt,zone:zoneName},extra||{})); };
          const shoot=(baseAng,col,mult,count,spread,kind)=>{ for(let i=0;i<count;i++){
            const a=baseAng+(count>1?(i-(count-1)/2)*spread:0);
            _sdSpawnProj(game,zoneName,e,a,col,_nhDmgS(e,mult,nearestPlayer),kind||'magic',null,0); } };
          const tele=(tx,tz,fuse,radius,mult,col,push,slow,slowDur)=>{ if(!game._sdGeyser) game._sdGeyser=[];
            game._sdGeyser.push({zone:zoneName,x:tx,z:tz,fuse:fuse,dmg:_nhDmgS(e,mult,nearestPlayer),eid:e.id,col:col,
                                 radius:radius,push:(push||0),slow:(slow||0),slowDur:(slowDur||0)});
            fx('sd_geyser_warn',{ex:+tx.toFixed(2),ez:+tz.toFixed(2),col:col}); };
          // Blink/teleport: the client lerps toward the server position, so a blink has to be
          // broadcast as a SNAP cue or the machine visibly slides instead of glitching.
          const blink=(a,dist,toward)=>{ const sg=toward?1:-1;
            const nx=e.x+sg*Math.sin(a)*dist, nz=e.z+sg*Math.cos(a)*dist;
            if(nx>2 && nx<358 && nz>2 && nz<358){ e.x=nx; e.z=nz; _moved=true; }
            fx('nh_blink',{eid:e.id,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2)}); };

          if(e.type==='sentinel_drone'){
            // SURVEILLANCE UNIT — hovering eye of the city. Tags anomalies.
            const MS=0.336;
            if(dd<5) mv(-sin*0.7+pr*strafe*0.7, -cos*0.7+pq*strafe*0.7, MS);
            else if(dd>12) mv(sin*0.7, cos*0.7, MS);
            else mv(pr*strafe, pq*strafe, MS);
            // twin ion bolts — faster against a tagged anomaly
            if(dd>2.4 && dd<16 && e.attackTimer%(_tg?6:9)===0) shoot(ang,_NH_CYN,0.5,2,0.14,'magic');
            // ANOMALY SCAN — magenta lock beam; completing the lock BRANDS you for 6s
            if(e._scOn){
              e._scT=(e._scT||0)+1;
              fx('nh_scan_beam',{eid:e.id,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),
                                 tx:+nearestPlayer.x.toFixed(2),tz:+nearestPlayer.z.toFixed(2)});
              if(e._scT>=7){ e._scOn=0; e._scT=0;
                const sdx=nearestPlayer.x-e.x, sdz=nearestPlayer.z-e.z;
                if(Math.sqrt(sdx*sdx+sdz*sdz)<17){
                  hit(0.5); _nhTag(game, zoneName, nearestPlayer);
                  fx('nh_tagged',{ex:+nearestPlayer.x.toFixed(2),ez:+nearestPlayer.z.toFixed(2)}); } }
            } else {
              e._scan=(e._scan||Math.floor(Math.random()*27))+1;
              if(dd<15 && e._scan>=40){ e._scan=0; e._scOn=1; e._scT=0; }
            }
            // evasive thruster burst when cornered
            e._ev=(e._ev||0)+1;
            if(dd<3 && e._ev>=25){ e._ev=0; blink(ang+1.5708*(Math.random()<0.5?1:-1), 4.5, true); }
          }
          else if(e.type==='maintenance_striker'){
            // SERVICE UNIT — welding torch, arc beam, thruster lunge, ally repair
            const MS=0.30;
            if(e._charge){
              e._cst=(e._cst||0)+1;
              if(e._charge==='wind'){ if(e._cst>=2){ e._charge='go'; e._cst=0; e._cdir=ang; e._chit=0;
                fx('nh_lunge',{eid:e.id,dir:+ang.toFixed(3)}); } }
              else { mv(Math.sin(e._cdir),Math.cos(e._cdir),MS*3.0);
                if(dd<2.6 && !e._chit){ e._chit=1; hit(1.2);
                  fx('sd_shock',{ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),col:_NH_AMBER,r:2.0}); }
                if(e._cst>=2){ e._charge=0; e._cst=0; } }
            } else {
              if(dd>2.6) mv(sin*0.85+pr*strafe*0.4, cos*0.85+pq*strafe*0.4, MS);
              else mv(pr*strafe, pq*strafe, MS);
              if(dd<3.0 && e.attackTimer%10===0){ hit(1.0);
                toPlayer({eff:'status',status:'burn',statusDur:120});
                fx('sd_motes',{ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),col:_NH_AMBER,n:5}); }
              e._tl=(e._tl||0)+1;
              if(dd>4 && dd<11 && e._tl>=37){ e._tl=0; e._charge='wind'; e._cst=0; }
            }
            // ARC WELDER — sustained cyan weld beam, re-aims each tick
            if(e._awOn){
              e._awT=(e._awT||0)+1;
              if(e._awT%3===0){
                fx('nh_weld_beam',{eid:e.id,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),
                                   tx:+nearestPlayer.x.toFixed(2),tz:+nearestPlayer.z.toFixed(2)});
                if(dd<14) hit(0.4); }
              if(e._awT>=9){ e._awOn=0; e._awT=0; }
            } else {
              e._aw=(e._aw||0)+1;
              if(dd>2 && dd<10 && e._aw>=33){ e._aw=0; e._awOn=1; e._awT=0; }
            }
            // REPAIR PROTOCOL — mend the single most-damaged nearby machine.
            //   Client discipline preserved verbatim: desynced start, <60% HP only, 12u range,
            //   +3% maxHp, and a per-TARGET cooldown. That per-target cooldown is what keeps
            //   32 strikers from out-healing a party — it caps any one machine's intake.
            if(e._wd==null) e._wd=Math.floor(Math.random()*70);
            e._wd++;
            if(e._wd>=70){ e._wd=0;
              let best=null, bestFrac=0.6;
              for(let i=0;i<zone.enemies.length;i++){ const o=zone.enemies[i];
                if(!o||!o.active||o===e||!NH_BESPOKE[o.type]) continue;
                if((o._nhHealCD||0)>0) continue;
                const odx=o.x-e.x, odz=o.z-e.z;
                if(odx*odx+odz*odz>144) continue;
                const fr2=o.hp/o.maxHp; if(fr2<bestFrac){ bestFrac=fr2; best=o; }
              }
              if(best){ best.hp=Math.min(best.maxHp, best.hp+Math.floor(best.maxHp*0.03));
                best._nhHealCD=20;
                changed.push(best);
                fx('nh_repair',{eid:e.id,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),
                                tx:+best.x.toFixed(2),tz:+best.z.toFixed(2)}); }
            }
          }
          else if(e.type==='hollow_enforcer'){
            // LOCKDOWN WALKER — shield arm, plasma cannon, containment protocol
            const MS=0.18;
            if(dd>3.0) mv(sin,cos,MS);
            if(dd<3.6 && e.attackTimer%13===0){ hit(1.2); toPlayer({eff:'shake',shake:2});
              fx('sd_motes',{ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),col:_NH_CHROME,n:4}); }
            // SHIELD RAM — telegraphed plate slam that launches you back
            e._sr=(e._sr||0)+1;
            if(dd<4.5 && e._sr>=35){ e._sr=0; tele(e.x, e.z, 5, 3.6, 1.3, _NH_CYN, 3.0); }
            // PLASMA BARRAGE — 4 aimed cannon shots, ~1 tick apart
            if(dd>3 && dd<16 && e._ab>=30){ e._ab=0; e._pb=4; }
            if(e._pb>0){ e._pb--; shoot(ang,_NH_MAG,0.55,1,0,'plasma'); }
            // SUPPRESSION LOCKDOWN — amber containment ring clamps you where you stand
            e._ld=(e._ld||10)+1;
            if(dd<13 && e._ld>=48){ e._ld=0;
              tele(nearestPlayer.x, nearestPlayer.z, 7, 2.8, 1.1, _NH_AMBER, 0, 0.0, 800); }
          }
          else if(e.type==='neon_wraith'){
            // RESIDENT.ECHO — corrupted hologram of an old citizen
            const MS=0.33;
            if(dd<6) mv(-sin*0.7+pr*strafe*0.7, -cos*0.7+pq*strafe*0.7, MS);
            else if(dd>12) mv(sin*0.6, cos*0.6, MS);
            else mv(pr*strafe, pq*strafe, MS);
            if(dd>2.4 && dd<16 && e.attackTimer%10===0) shoot(ang,_NH_MAG,0.55,2,0.16,'magic');
            // GLITCH STEP — teleports with a double afterimage
            e._gs=(e._gs||Math.floor(Math.random()*15))+1;
            if(e._gs>=30){ e._gs=0; blink(ang+(Math.random()<0.5?1.2:-1.2), 3.5+Math.random()*3, true); }
            // STATIC SCREAM — chromatic burst + snare
            e._ss=(e._ss||12)+1;
            if(dd<8 && e._ss>=42){ e._ss=0;
              fx('nh_scream',{ex:+e.x.toFixed(2),ez:+e.z.toFixed(2)});
              hit(0.9); toPlayer({eff:'slow',slow:0.5,root:1200}); }
            // DATA CORRUPTION — the zone's signature scanline glitch
            e._dc=(e._dc||20)+1;
            if(dd<14 && e._dc>=60){ e._dc=0;
              fx('nh_corrupt',{ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),ms:1600});
              shoot(ang,_NH_MAG,0.5,3,0.22,'void');
              if(dd<10) hit(1.1); }
          }
          else if(e.type==='skybridge_sniper'){
            // RAILGUN PERCH — a laser sight paints you; then the slug arrives
            const MS=0.168;
            if(dd>24) mv(sin,cos,MS);   // shuffle into range only — otherwise HOLD the perch
            // SCUTTLE HOP — relocate when the anomaly closes in
            e._sh=(e._sh||0)+1;
            if(dd<4 && e._sh>=33){ e._sh=0;
              blink(ang+(Math.random()<0.5?2.4:-2.4), 6+Math.random()*2, false);
              shoot(ang,_NH_CYN,0.6,1,0,'bolt'); }
            // sidearm — keeps pressure between railgun cycles
            if(dd>3 && dd<14 && e.attackTimer%15===0) shoot(ang,_NH_CYN,0.5,1,0,'bolt');
            // RAILGUN CYCLE — laser sight paints a SPOT, then the slug hits that spot.
            //   a549 FIX: the client captured the aim point in the same instant it resolved the
            //   hit (fx2 = playerPos, then measured playerPos against fx2 — distance always 0),
            //   so the railgun could never be dodged despite the 750ms sight and the kit header
            //   calling it dodgeable. The paint point is now locked when the sight comes ON and
            //   the slug resolves against THAT spot, so stepping off the mark actually works.
            if(e._rgOn){
              e._rgT=(e._rgT||0)+1;
              fx('nh_laser_sight',{eid:e.id,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),
                                   tx:+e._rgX.toFixed(2),tz:+e._rgZ.toFixed(2)});
              if(e._rgT>=8){ e._rgOn=0; e._rgT=0;
                const fa=Math.atan2(e._rgX-e.x, e._rgZ-e.z);
                _sdSpawnProj(game,zoneName,e,fa,_NH_WHITE,_nhDmgS(e,0.9,nearestPlayer),'lightning',null,0);
                fx('nh_railgun',{eid:e.id,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),
                                 tx:+e._rgX.toFixed(2),tz:+e._rgZ.toFixed(2)});
                const rdx=nearestPlayer.x-e._rgX, rdz=nearestPlayer.z-e._rgZ;
                if(Math.sqrt(rdx*rdx+rdz*rdz)<2.0){
                  hit(1.8); toPlayer({eff:'shake',shake:3});
                  _nhTag(game, zoneName, nearestPlayer);
                  fx('nh_tagged',{ex:+nearestPlayer.x.toFixed(2),ez:+nearestPlayer.z.toFixed(2)}); } }
            } else {
              e._rg=(e._rg||Math.floor(Math.random()*20))+1;
              if(dd>5 && dd<24 && e._rg>=38){ e._rg=0; e._rgOn=1; e._rgT=0;
                e._rgX=nearestPlayer.x; e._rgZ=nearestPlayer.z; }
            }
          }
          else {
            // crash_car — KAMIKAZE UNIT. Circles the block, strobes, then RAMS.
            const MS=0.48;
            if(e._kmode==='strobe'){
              e._kt=(e._kt||0)+1;
              fx('nh_strobe',{eid:e.id,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),
                              tx:+nearestPlayer.x.toFixed(2),tz:+nearestPlayer.z.toFixed(2)});
              if(e._kt>=6){ e._kmode='run'; e._kt=0; e._kdir=ang; e._khit=0;
                fx('nh_ram',{eid:e.id,dir:+ang.toFixed(3)}); }
            } else if(e._kmode==='run'){
              e._kt=(e._kt||0)+1;
              mv(Math.sin(e._kdir),Math.cos(e._kdir),MS*3.4);
              if(dd<2.8 && !e._khit){ e._khit=1; hit(1.5); toPlayer({eff:'shake',shake:3});
                fx('sd_shock',{ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),col:_NH_AMBER,r:3.0}); }
              if(e._kt>=4){ e._kmode=0; e._kt=0;
                fx('sd_motes',{ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),col:_NH_CHROME,n:6}); }
            } else {
              if(dd<8) mv(-sin*0.5+pr*strafe*1.0, -cos*0.5+pq*strafe*1.0, MS);
              else if(dd>14) mv(sin*0.8+pr*strafe*0.5, cos*0.8+pq*strafe*0.5, MS);
              else mv(pr*strafe, pq*strafe, MS);
              if(dd<3.0 && e.attackTimer%12===0){ hit(0.9);
                fx('sd_motes',{ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),col:_NH_CHROME,n:4}); }
              e._kr=(e._kr||Math.floor(Math.random()*23))+1;
              if(dd>5 && dd<18 && e._kr>=42){ e._kr=0; e._kmode='strobe'; e._kt=0; }
            }
          }

          if(_moved) changed.push(e);
        }

        // ── a550: XERON orbital-citadel garrison (zone-gated to 'xeron'). The dominion's
        //    last garrison bends time and space. Re-timed 60fps -> 10Hz (counters /6,
        //    speeds *6). HP intentionally UNCHANGED.
        //    Several abilities here are SUSTAINED rather than instant — singularity drag,
        //    event-horizon pull, time-dilation fields, wormhole relays — so they run as
        //    state machines on the mob and emit per-tick player effects, instead of the
        //    fire-and-forget geyser the other zones lean on.
        if (zoneName === 'xeron' && e.aggroed && XR_BESPOKE[e.type]) {
          const dxp=nearestPlayer.x-e.x, dzp=nearestPlayer.z-e.z, dd=Math.sqrt(dxp*dxp+dzp*dzp)||0.0001;
          const sin=dxp/dd, cos=dzp/dd, pr=cos, pq=-sin, ang=Math.atan2(dxp,dzp);
          if(e._strafe===undefined) e._strafe=Math.random()<0.5?1:-1;
          if(Math.random()<0.036) e._strafe=-e._strafe;
          const strafe=e._strafe;
          e._ab=(e._ab||0)+1;   // a556 — attackTimer is incremented by the generic enemy loop
          //   above (it runs for bespoke mobs too); incrementing it here as well ran every
          //   %-based attack check in this zone off a counter advancing 2 per tick.
          let _moved=false;
          const mv=(vx,vz,sp)=>{ e.x+=vx*sp; e.z+=vz*sp; _moved=true; };
          const hit=(mult)=>{ players.forEach((p,ws)=>{ if(p===nearestPlayer)
            send(ws,{type:'sv_enemy_attack',eid:e.id,dmg:_xrDmgS(e,mult),ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),zone:zoneName}); }); };
          const hitAt=(mult,hx,hz,radius)=>{ players.forEach((p,ws)=>{
            if(p.gameId!==game.id || p.zone!==zoneName || p.x===undefined) return;
            const qx=p.x-hx, qz=p.z-hz; if(qx*qx+qz*qz < radius*radius)
              send(ws,{type:'sv_enemy_attack',eid:e.id,dmg:_xrDmgS(e,mult),ex:+hx.toFixed(2),ez:+hz.toFixed(2),zone:zoneName}); }); };
          const toPlayer=(msg)=>{ players.forEach((p,ws)=>{ if(p===nearestPlayer)
            send(ws, Object.assign({type:'sv_player_fx',zone:zoneName},msg)); }); };
          // Sustained gravity drag — every player inside the well, not just the tracked one
          const dragAll=(gx,gz,amt,range)=>{ players.forEach((p,ws)=>{
            if(p.gameId!==game.id || p.zone!==zoneName || p.x===undefined) return;
            const qx=gx-p.x, qz=gz-p.z, q=Math.sqrt(qx*qx+qz*qz);
            if(q<range && q>0.8) send(ws,{type:'sv_player_fx',zone:zoneName,eff:'pull',
              px:+gx.toFixed(2),pz:+gz.toFixed(2),pull:amt}); }); };
          const fx=(vt,extra)=>{ broadcastToZone(game.id,zoneName, Object.assign({type:'sv_fx',vt:vt,zone:zoneName},extra||{})); };
          const shoot=(baseAng,col,mult,count,spread,kind)=>{ for(let i=0;i<count;i++){
            const a=baseAng+(count>1?(i-(count-1)/2)*spread:0);
            _sdSpawnProj(game,zoneName,e,a,col,_xrDmgS(e,mult),kind||'magic',null,0); } };
          const shootFrom=(sx,sz,baseAng,col,mult,kind)=>{
            _sdSpawnProj(game,zoneName,{id:e.id,x:sx,z:sz},baseAng,col,_xrDmgS(e,mult),kind||'magic',null,0); };
          const tele=(tx,tz,fuse,radius,mult,col)=>{ if(!game._sdGeyser) game._sdGeyser=[];
            game._sdGeyser.push({zone:zoneName,x:tx,z:tz,fuse:fuse,dmg:_xrDmgS(e,mult),eid:e.id,col:col,radius:radius});
            fx('sd_geyser_warn',{ex:+tx.toFixed(2),ez:+tz.toFixed(2),col:col}); };
          const blink=(nx,nz)=>{ if(nx>2 && nx<358 && nz>2 && nz<358){ e.x=nx; e.z=nz; _moved=true; }
            fx('xr_blink',{eid:e.id,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2)}); };

          if(e.type==='corrupted_xu'){
            // GLITCHING REMNANT — records its own timeline and snaps back along it
            if(e._rwSurge>0) e._rwSurge--;
            const MS=0.288*(e._rwSurge>0?1.3:1);
            if(dd>2.6) mv(sin*0.85+pr*strafe*0.45, cos*0.85+pq*strafe*0.45, MS);
            else mv(pr*strafe, pq*strafe, MS);
            // rolling timeline sample (~2.5s back)
            if(e.attackTimer%25===0){ e._rwX=e.x; e._rwZ=e.z; }
            if(dd<2.8 && e.attackTimer%10===0) hit(1.0);
            if(dd>2.4 && dd<15 && e.attackTimer%9===0) shoot(ang,_XR_PURPLE,0.5,2,0.16,'void');
            // TIME REWIND — snap back along the ghost trail, then surge
            e._rw=(e._rw||Math.floor(Math.random()*23))+1;
            if(dd<12 && e._rw>=47 && e._rwX!=null){ e._rw=0;
              fx('xr_rewind',{eid:e.id,fx2:+e.x.toFixed(2),fz2:+e.z.toFixed(2),
                              ex:+e._rwX.toFixed(2),ez:+e._rwZ.toFixed(2)});
              blink(e._rwX, e._rwZ);
              e._rwSurge=30; }
          }
          else if(e.type==='void_marine'){
            // GRAVITY INFANTRY — rifle volleys and singularity grenades
            const MS=0.24;
            if(dd>3.0) mv(sin*0.8+pr*strafe*0.4, cos*0.8+pq*strafe*0.4, MS);
            else mv(pr*strafe, pq*strafe, MS);
            if(dd<3.2 && e.attackTimer%11===0) hit(1.1);
            if(dd>2.6 && dd<15 && e.attackTimer%11===0){ e._rb=3; }
            if(e._rb>0){ e._rb--; shoot(ang,_XR_CYAN,0.4,1,0,'bolt'); }
            // SINGULARITY GRENADE — a black hole opens at your feet, drags, then collapses
            if(e._sgOn){
              e._sgT=(e._sgT||0)+1;
              dragAll(e._sgX, e._sgZ, 0.13*6, 8);       // 0.13/frame -> per tick
              fx('xr_singularity_tick',{ex:+e._sgX.toFixed(2),ez:+e._sgZ.toFixed(2),t:e._sgT});
              if(e._sgT>=20){ e._sgOn=0; e._sgT=0;
                fx('xr_singularity_collapse',{ex:+e._sgX.toFixed(2),ez:+e._sgZ.toFixed(2)});
                hitAt(1.2, e._sgX, e._sgZ, 3.0); }
            } else {
              e._sg=(e._sg||Math.floor(Math.random()*27))+1;
              if(dd>3 && dd<15 && e._sg>=50){ e._sg=0; e._sgOn=1; e._sgT=0;
                e._sgX=nearestPlayer.x; e._sgZ=nearestPlayer.z;
                fx('xr_singularity_open',{ex:+e._sgX.toFixed(2),ez:+e._sgZ.toFixed(2)}); }
            }
          }
          else if(e.type==='holo_wraith'){
            // PROJECTION GHOST — drifts, phases, and draws killing constellations
            const MS=0.348;
            if(dd<6) mv(-sin*0.7+pr*strafe*0.7, -cos*0.7+pq*strafe*0.7, MS);
            else if(dd>12) mv(sin*0.6, cos*0.6, MS);
            else mv(pr*strafe, pq*strafe, MS);
            if(dd>2.4 && dd<16 && e.attackTimer%9===0) shoot(ang,_XR_STAR,0.5,2,0.15,'magic');
            e._ph=(e._ph||10)+1;
            if(e._ph>=33){ e._ph=0;
              const pa2=ang+(Math.random()<0.5?1.3:-1.3);
              blink(e.x+Math.sin(pa2)*4, e.z+Math.cos(pa2)*4); }
            // CONSTELLATION VOLLEY — five stars ignite around you, the pentagram draws
            // itself point to point, then every point of it detonates at once.
            e._cv=(e._cv||Math.floor(Math.random()*30))+1;
            if(dd>2 && dd<16 && e._cv>=57){ e._cv=0;
              const cx=nearestPlayer.x, cz=nearestPlayer.z, R=3.2, pts=[];
              for(let pi=0;pi<5;pi++){ const a2=pi*1.2566-1.5708;
                pts.push([cx+Math.cos(a2)*R, cz+Math.sin(a2)*R]); }
              fx('xr_constellation',{cx:+cx.toFixed(2),cz:+cz.toFixed(2),r:R,
                                     pts:pts.map(p=>[+p[0].toFixed(2),+p[1].toFixed(2)])});
              for(let pi=0;pi<5;pi++) tele(pts[pi][0],pts[pi][1],12,2.0,0.7,_XR_STAR);
              tele(cx,cz,12,R*0.8,0.8,_XR_STAR); }
          }
          else if(e.type==='laser_turret'){
            // FIXED EMPLACEMENT — it does not move. Space moves for it.
            if(dd>2 && dd<19 && e.attackTimer%8===0)
              shoot(ang+Math.sin(e.attackTimer*0.3)*0.25,_XR_CYAN,0.45,1,0,'bolt');
            if(dd<2.8 && e.attackTimer%12===0) hit(0.9);
            // WORMHOLE RELAY — a portal opens BESIDE you and the turret fires through it,
            // so the shots arrive out of local space at point blank. The ring is the warning.
            if(e._whOn){
              e._whT=(e._whT||0)+1;
              if(e._whT===5 || e._whT===10 || e._whT===15){
                const da=Math.atan2(nearestPlayer.x-e._whX, nearestPlayer.z-e._whZ);
                shootFrom(e._whX, e._whZ, da, _XR_CYAN, 0.65, 'plasma');
                fx('xr_wormhole_shot',{eid:e.id,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),
                                       bx:+e._whX.toFixed(2),bz:+e._whZ.toFixed(2)}); }
              if(e._whT>=22){ e._whOn=0; e._whT=0; fx('xr_wormhole_close',{eid:e.id}); }
            } else {
              e._wh=(e._wh||Math.floor(Math.random()*27))+1;
              if(dd>4 && dd<19 && e._wh>=47){ e._wh=0; e._whOn=1; e._whT=0;
                const oa2=Math.random()*6.283;
                e._whX=nearestPlayer.x+Math.cos(oa2)*3.4;
                e._whZ=nearestPlayer.z+Math.sin(oa2)*3.4;
                fx('xr_wormhole_open',{eid:e.id,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),
                                       bx:+e._whX.toFixed(2),bz:+e._whZ.toFixed(2)}); } }
          }
          else if(e.type==='cyber_ogre'){
            // MASS-DRIVER BRUTE — it doesn't chase you; it makes the universe smaller
            const MS=0.168;
            if(dd>3.2) mv(sin,cos,MS);
            if(dd<3.8 && e.attackTimer%13===0){ hit(1.25); toPlayer({eff:'shake',shake:2}); }
            // EVENT HORIZON SLAM — drag you in, then the ground answers
            if(e._ehOn){
              e._ehT=(e._ehT||0)+1;
              if(e._ehT<=13) dragAll(e.x, e.z, 0.24*6, 12);
              if(e._ehT===14) tele(e.x, e.z, 4, 4.0, 1.4, _XR_PURPLE);
              if(e._ehT>=18){ e._ehOn=0; e._ehT=0; }
            } else {
              e._eh=(e._eh||Math.floor(Math.random()*23))+1;
              if(dd>3 && dd<11 && e._eh>=43){ e._eh=0; e._ehOn=1; e._ehT=0;
                fx('xr_event_horizon',{eid:e.id,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2)}); } }
            // TIME DILATION DOME — inside the field, your seconds run slow (4s)
            if(e._tdOn){
              e._tdT=(e._tdT||0)+1;
              players.forEach((p,ws)=>{
                if(p.gameId!==game.id || p.zone!==zoneName || p.x===undefined) return;
                const qx=p.x-e._tdX, qz=p.z-e._tdZ;
                const inside = (qx*qx+qz*qz) < 4.2*4.2;
                if(inside) send(ws,{type:'sv_player_fx',zone:zoneName,eff:'slow',slow:0.45,root:250});
              });
              if(e._tdT>=40){ e._tdOn=0; e._tdT=0; fx('xr_dilation_end',{eid:e.id}); }
            } else {
              e._td=(e._td||0)+1;
              if(dd<9 && e._td>=63){ e._td=0; e._tdOn=1; e._tdT=0; e._tdX=e.x; e._tdZ=e.z;
                fx('xr_dilation',{eid:e.id,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),r:4.2}); } }
            // METEOR STOMP — debris falls from orbit onto marked ground
            e._ms2=(e._ms2||10)+1;
            if(dd<14 && e._ms2>=53){ e._ms2=0;
              fx('xr_meteor',{eid:e.id,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2)});
              for(let mi2=0;mi2<3;mi2++){
                const tx=nearestPlayer.x+(Math.random()-0.5)*5, tz=nearestPlayer.z+(Math.random()-0.5)*5;
                tele(tx,tz,12+mi2*3,2.4,0.85,_XR_PINK); } }
          }
          else {
            // shard_assassin — SPACETIME KNIFE: freezes your seconds, folds behind you, cuts
            const MS=0.468;
            if(e._bs==='strike'){
              e._bt=(e._bt||0)+1;
              if(e._bt>=2){ e._bs=0; e._bt=0; }
            } else {
              if(dd<3.2) mv(-sin*0.4+pr*strafe*1.0, -cos*0.4+pq*strafe*1.0, MS);
              else if(dd>11) mv(sin*0.9, cos*0.9, MS);
              else mv(sin*0.25+pr*strafe*0.9, cos*0.25+pq*strafe*0.9, MS);
            }
            if(dd<2.6 && e.attackTimer%9===0) hit(1.05);
            if(dd>2.4 && dd<13 && e._ab>=23){ e._ab=0; shoot(ang,_XR_WHITE,0.45,3,0.22,'bolt'); }
            // STASIS LOCK — your seconds freeze inside a contracting ring; it folds space
            // to stand behind you mid-freeze, and then it cuts.
            if(e._slOn){
              e._slT=(e._slT||0)+1;
              if(e._slT===10){
                const qx=nearestPlayer.x-e._slX, qz=nearestPlayer.z-e._slZ;
                if(Math.sqrt(qx*qx+qz*qz)<2.6){
                  toPlayer({eff:'slow',slow:0,root:1000});
                  fx('xr_stasis_lock',{ex:+nearestPlayer.x.toFixed(2),ez:+nearestPlayer.z.toFixed(2)});
                  // the fold — it is already behind you
                  const fa=Math.atan2(e.x-nearestPlayer.x, e.z-nearestPlayer.z);
                  blink(nearestPlayer.x+Math.sin(fa+Math.PI)*1.6, nearestPlayer.z+Math.cos(fa+Math.PI)*1.6);
                  e._bs='strike'; e._bt=0; e._slHit=1;
                } else { e._slOn=0; e._slT=0; }
              }
              if(e._slHit && e._slT>=13){ e._slHit=0; e._slOn=0; e._slT=0;
                if(dd<3.0){ hit(1.5); toPlayer({eff:'shake',shake:3}); } }
              if(e._slT>=16){ e._slOn=0; e._slT=0; e._slHit=0; }
            } else {
              e._sl=(e._sl||Math.floor(Math.random()*30))+1;
              if(dd>2 && dd<12 && e._sl>=50){ e._sl=0; e._slOn=1; e._slT=0;
                e._slX=nearestPlayer.x; e._slZ=nearestPlayer.z;
                fx('xr_stasis_ring',{ex:+e._slX.toFixed(2),ez:+e._slZ.toFixed(2)}); } }
          }

          if(_moved) changed.push(e);
        }

        // ── a551: XUMEN capital guard (zone-gated to 'xumen'). The empire's home guard:
        //    jet-pack skirmishers, heavy mechs, tracked artillery and the commanders that
        //    shield and surge them. Re-timed 60fps -> 10Hz. HP intentionally UNCHANGED.
        //    This zone owns DEFENSIVE state server-side for the first time — ARMOR LOCK
        //    and AEGIS PROJECTOR mutate e.dmgReduction, which is what the server uses to
        //    resolve every player hit.
        if (zoneName === 'xumen' && e.aggroed && XM_BESPOKE[e.type]) {
          const dxp=nearestPlayer.x-e.x, dzp=nearestPlayer.z-e.z, dd=Math.sqrt(dxp*dxp+dzp*dzp)||0.0001;
          const sin=dxp/dd, cos=dzp/dd, pr=cos, pq=-sin, ang=Math.atan2(dxp,dzp);
          if(e._strafe===undefined) e._strafe=Math.random()<0.5?1:-1;
          if(Math.random()<0.036) e._strafe=-e._strafe;
          const strafe=e._strafe;
          if(e._pkT>0) e._pkT--;                       // COMMAND OVERRIDE surge timer
          const _pk=(e._pkT>0)?1.22:1;                 // surge scales SPEED only, never damage
          e._ab=(e._ab||0)+1;   // a556 — attackTimer is incremented by the generic enemy loop
          //   above (it runs for bespoke mobs too); incrementing it here as well ran every
          //   %-based attack check in this zone off a counter advancing 2 per tick.
          let _moved=false;
          const mv=(vx,vz,sp)=>{ e.x+=vx*sp; e.z+=vz*sp; _moved=true; };
          const hit=(mult)=>{ players.forEach((p,ws)=>{ if(p===nearestPlayer)
            send(ws,{type:'sv_enemy_attack',eid:e.id,dmg:_xmDmgS(e,mult),ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),zone:zoneName}); }); };
          const hitAt=(mult,hx,hz,radius)=>{ players.forEach((p,ws)=>{
            if(p.gameId!==game.id || p.zone!==zoneName || p.x===undefined) return;
            const qx=p.x-hx, qz=p.z-hz; if(qx*qx+qz*qz < radius*radius)
              send(ws,{type:'sv_enemy_attack',eid:e.id,dmg:_xmDmgS(e,mult),ex:+hx.toFixed(2),ez:+hz.toFixed(2),zone:zoneName}); }); };
          const toPlayer=(msg)=>{ players.forEach((p,ws)=>{ if(p===nearestPlayer)
            send(ws, Object.assign({type:'sv_player_fx',zone:zoneName},msg)); }); };
          const dragAll=(gx,gz,amt,range)=>{ players.forEach((p,ws)=>{
            if(p.gameId!==game.id || p.zone!==zoneName || p.x===undefined) return;
            const qx=gx-p.x, qz=gz-p.z, q=Math.sqrt(qx*qx+qz*qz);
            if(q<range && q>2.2) send(ws,{type:'sv_player_fx',zone:zoneName,eff:'pull',
              px:+gx.toFixed(2),pz:+gz.toFixed(2),pull:amt}); }); };
          const fx=(vt,extra)=>{ broadcastToZone(game.id,zoneName, Object.assign({type:'sv_fx',vt:vt,zone:zoneName},extra||{})); };
          const shoot=(baseAng,col,mult,count,spread,kind,ox,oz)=>{ for(let i=0;i<count;i++){
            const a=baseAng+(count>1?(i-(count-1)/2)*spread:0);
            _sdSpawnProj(game,zoneName,{id:e.id,x:e.x+(ox||0),z:e.z+(oz||0)},a,col,_xmDmgS(e,mult),kind||'plasma',null,0); } };
          const tele=(tx,tz,fuse,radius,mult,col)=>{ if(!game._sdGeyser) game._sdGeyser=[];
            game._sdGeyser.push({zone:zoneName,x:tx,z:tz,fuse:fuse,dmg:_xmDmgS(e,mult),eid:e.id,col:col,radius:radius});
            fx('sd_geyser_warn',{ex:+tx.toFixed(2),ez:+tz.toFixed(2),col:col}); };
          const blink=(a,dist)=>{ const nx=e.x+Math.sin(a)*dist, nz=e.z+Math.cos(a)*dist;
            if(nx>2 && nx<358 && nz>2 && nz<358){ e.x=nx; e.z=nz; _moved=true; }
            fx('xm_blink',{eid:e.id,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2)}); };

          if(e.type==='xu_enforcer'){
            // JET-PACK SKIRMISHER — the fastest thing in the empire
            const _od=(e.hp/e.maxHp)<0.35;             // OVERDRIVE — safety governors off
            if(_od && !e._odOn){ e._odOn=1; fx('xm_overdrive',{eid:e.id}); }
            const MS=0.528*_pk*(_od?1.35:1);
            if(e._jd==='go'){
              e._jt=(e._jt||0)+1;
              mv(Math.sin(e._jdir),Math.cos(e._jdir),MS*2.6);
              if(e._jt>=2){ e._jd=0; e._jt=0; }
            } else {
              if(dd<3.5) mv(-sin*0.5+pr*strafe*0.9, -cos*0.5+pq*strafe*0.9, MS);
              else if(dd>11) mv(sin*0.9, cos*0.9, MS);
              else mv(sin*0.2+pr*strafe*0.9, cos*0.2+pq*strafe*0.9, MS);
              // JET BURST — sudden vector change, hard to track
              e._jb=(e._jb||0)+1;
              if(e._jb>=(_od?15:23)){ e._jb=0; e._jd='go'; e._jt=0;
                e._jdir=ang+(Math.random()<0.5?1.3:-1.3)+Math.random()*0.6;
                fx('xm_jet',{eid:e.id,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2)}); }
            }
            // TWIN BLASTERS — alternating left/right arm muzzles
            if(dd>2.2 && dd<15 && e.attackTimer%(_od?4:6)===0){
              e._arm=!e._arm; const mo=e._arm?0.45:-0.45;
              shoot(ang,_XM_CYAN,0.45,1,0,'bolt', pr*mo, pq*mo); }
            // SHOCK BATON — stun-flash
            e._sb=(e._sb||0)+1;
            if(dd<2.6 && e._sb>=22){ e._sb=0; hit(1.1);
              toPlayer({eff:'slow',slow:0,root:450});
              fx('xm_baton',{eid:e.id,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),
                             tx:+nearestPlayer.x.toFixed(2),tz:+nearestPlayer.z.toFixed(2)}); }
          }
          else if(e.type==='xu_titan'){
            // HEAVY MECH — graviton singularity, sweeping chest laser, shoulder cannons
            const MS=0.228*_pk;
            // ARMOR LOCK — one-time plating clamp below 40%. Server-owned, so it actually
            //   reduces the damage players deal rather than only drawing the flare.
            if(!e._alDone && (e.hp/e.maxHp)<0.40){ e._alDone=1;
              e.dmgReduction=Math.min(0.85,(e.dmgReduction||0)+0.18);
              fx('xm_armorlock',{eid:e.id,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2)}); }
            if(dd>3.0) mv(sin,cos,MS);
            if(dd<3.6 && e.attackTimer%13===0){ hit(1.2); toPlayer({eff:'shake',shake:2}); }
            if(dd>3 && dd<15 && e.attackTimer%11===0){
              shoot(ang,_XM_VIOLET,0.55,1,0,'plasma', pr*0.6, pq*0.6);
              shoot(ang,_XM_VIOLET,0.55,1,0,'plasma', -pr*0.6, -pq*0.6); }
            // GRAVITON WELL — a singularity drags you in, then the slam lands
            if(e._gwOn){
              e._gwT=(e._gwT||0)+1;
              if(e._gwT<=13) dragAll(e.x, e.z, 0.22*6, 12);
              if(e._gwT===14) tele(e.x, e.z, 4, 3.8, 1.4, _XM_VIOLET);
              if(e._gwT>=18){ e._gwOn=0; e._gwT=0; }
            } else {
              e._gw=(e._gw||Math.floor(Math.random()*20))+1;
              if(dd>3 && dd<11 && e._gw>=42){ e._gw=0; e._gwOn=1; e._gwT=0;
                fx('xm_graviton',{eid:e.id,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2)}); } }
            // LASER SWEEP — the chest core carves a 216° arc. Caught in it = hit, once.
            //   Exact point-to-beam-segment test, same as the client: approximating a
            //   sweeping beam with circles would leave gaps you could stand in.
            if(e._lsOn){
              e._lsT=(e._lsT||0)+1;
              for(let sub=0; sub<2; sub++){
                const step=(e._lsT-1)*2+sub+1; if(step>18) break;
                const a2=e._lsA+step*(3.8/18);
                if(!e._swHit){
                  players.forEach((p,ws)=>{
                    if(p.gameId!==game.id || p.zone!==zoneName || p.x===undefined) return;
                    const rx=p.x-e.x, rz=p.z-e.z;
                    const dxn=Math.sin(a2), dzn=Math.cos(a2);
                    const prj=rx*dxn+rz*dzn;
                    if(prj>0 && prj<7 && Math.abs(rx*dzn - rz*dxn)<1.1){
                      e._swHit=1;
                      send(ws,{type:'sv_enemy_attack',eid:e.id,dmg:_xmDmgS(e,0.9),
                               ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),zone:zoneName}); }
                  }); }
              }
              fx('xm_sweep_tick',{eid:e.id,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),
                                  a:+(e._lsA+e._lsT*2*(3.8/18)).toFixed(3)});
              if(e._lsT>=9){ e._lsOn=0; e._lsT=0; }
            } else {
              e._ls=(e._ls||10)+1;
              if(dd>2 && dd<9 && e._ls>=48){ e._ls=0; e._lsOn=1; e._lsT=0; e._swHit=0;
                e._lsA=ang-1.9;
                fx('xm_sweep',{eid:e.id,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),a0:+e._lsA.toFixed(3)}); } }
          }
          else if(e.type==='xu_annihilator'){
            // TRACKED ARTILLERY — a living turret. Barely moves; the sky does the work.
            const MS=0.072*_pk;
            if(dd>8) mv(sin,cos,MS);
            if(dd<3.4 && e.attackTimer%14===0){ hit(1.1); toPlayer({eff:'shake',shake:2}); }
            // ORBITAL DESIGNATOR — the lock is on the GROUND, so moving off it works
            e._ods=(e._ods||Math.floor(Math.random()*23))+1;
            if(dd>3 && dd<20 && e._ods>=43){ e._ods=0;
              const lx=nearestPlayer.x, lz=nearestPlayer.z;
              fx('xm_designator',{eid:e.id,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),
                                  tx:+lx.toFixed(2),tz:+lz.toFixed(2)});
              tele(lx, lz, 9, 3.0, 1.7, _XM_GOLD); }
            // SPIRAL BARRAGE — rotating bullet-hell from the dual cannons
            if(dd>3 && dd<16 && e._ab>=32){ e._ab=0; e._spN=10; e._spA=ang; }
            if(e._spN>0){ e._spN--; e._spA=(e._spA||0)+0.55*1.5;
              shoot(e._spA,(e._spN%2?_XM_GOLD:_XM_VIOLET),0.45,1,0,'plasma'); }
            // MORTAR RAIN — three lobbed impacts walk toward you
            e._mr=(e._mr||8)+1;
            if(dd>4 && dd<18 && e._mr>=38){ e._mr=0;
              for(let mi2=0;mi2<3;mi2++){
                const tx=nearestPlayer.x+(Math.random()-0.5)*3.5, tz=nearestPlayer.z+(Math.random()-0.5)*3.5;
                tele(tx,tz,5+mi2*3,2.6,0.8,_XM_RED); } }
          }
          else {
            // xu_supreme — SUPREME COMMANDER: drones, prism lance, aegis, command override
            const MS=0.288*_pk;
            if(dd<5) mv(-sin*0.6+pr*strafe*0.7, -cos*0.6+pq*strafe*0.7, MS);
            else if(dd>12) mv(sin*0.7, cos*0.7, MS);
            else mv(pr*strafe, pq*strafe, MS);
            if(dd>2.4 && dd<15 && e.attackTimer%8===0) shoot(ang,_XM_GOLD,0.55,1,0,'magic');
            if(dd<2.6 && e.attackTimer%10===0) hit(1.0);
            // HARDLIGHT DRONES — two orbiting emitters open fire for 8s
            if(e._ddOn){
              e._ddT=(e._ddT||0)+1;
              e._ddA=(e._ddA||0)+0.06*6;
              if(e._ddT%4===0){
                for(let i2=0;i2<2;i2++){
                  const da2=e._ddA+i2*Math.PI;
                  const dx2=e.x+Math.cos(da2)*1.7, dz2=e.z+Math.sin(da2)*1.7;
                  const pd=Math.sqrt((nearestPlayer.x-dx2)**2+(nearestPlayer.z-dz2)**2);
                  if(pd<16 && pd>1){
                    const da3=Math.atan2(nearestPlayer.x-dx2, nearestPlayer.z-dz2);
                    _sdSpawnProj(game,zoneName,{id:e.id,x:dx2,z:dz2},da3,_XM_CYAN,_xmDmgS(e,0.4),'bolt',null,0); } } }
              fx('xm_drones_tick',{eid:e.id,a:+(e._ddA||0).toFixed(3),ex:+e.x.toFixed(2),ez:+e.z.toFixed(2)});
              if(e._ddT>=80){ e._ddOn=0; e._ddT=0; fx('xm_drones_end',{eid:e.id}); }
            } else {
              e._dd=(e._dd||Math.floor(Math.random()*33))+1;
              if(dd<16 && e._dd>=70){ e._dd=0; e._ddOn=1; e._ddT=0; e._ddA=0;
                fx('xm_drones',{eid:e.id,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2)}); } }
            // PRISM LANCE — three beams converge on you
            e._pl=(e._pl||12)+1;
            if(dd>3 && dd<16 && e._pl>=35){ e._pl=0;
              fx('xm_prism',{eid:e.id,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),
                             tx:+nearestPlayer.x.toFixed(2),tz:+nearestPlayer.z.toFixed(2)});
              if(dd<17) hit(1.2); }
            // AEGIS PROJECTOR — visible bubble AND real damage reduction (3s)
            if(e._agOn){
              e._agT=(e._agT||0)+1;
              if(e._agT>=30){ e._agOn=0; e._agT=0;
                if(e._agBase!=null) e.dmgReduction=e._agBase;
                fx('xm_aegis_end',{eid:e.id}); }
            } else {
              e._ag=(e._ag||0)+1;
              if(dd<14 && e._ag>=63){ e._ag=0; e._agOn=1; e._agT=0;
                if(e._agBase==null) e._agBase=e.dmgReduction||0;
                e.dmgReduction=Math.min(0.85, e._agBase+0.45);
                fx('xm_aegis',{eid:e.id,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2)}); } }
            // COMMAND OVERRIDE — the garrison answers its commander.
            //   a551: the client gated only the ANNOUNCE on an 8s cooldown while the surge
            //   itself fired every time — the same defect ALPHA'S CALL had in a548, and worse
            //   here with 30 commanders in the plaza. The SURGE now shares the cooldown.
            e._co=(e._co||Math.floor(Math.random()*43))+1;
            if(dd<14 && e._co>=77){ e._co=0;
              const _now=Date.now();
              if(!zone._xmCallCd || _now>zone._xmCallCd){
                zone._xmCallCd=_now+8000;
                fx('xm_override',{ex:+e.x.toFixed(2),ez:+e.z.toFixed(2)});
                for(let i=0;i<zone.enemies.length;i++){ const o=zone.enemies[i];
                  if(!o||!o.active||!XM_BESPOKE[o.type]) continue;
                  const odx=o.x-e.x, odz=o.z-e.z;
                  if(odx*odx+odz*odz>324) continue;          // 18u radius
                  o.aggroed=true; o._pkT=50;                 // 300 frames -> 50 ticks
                } } }
            // BLINK TACTICS — never where you left him
            e._bl=(e._bl||0)+1;
            if(dd<3 && e._bl>=25){ e._bl=0; blink(ang+(Math.random()<0.5?1.6:-1.6), 5); }
          }

          if(_moved) changed.push(e);
        }

        // ── a552: XUMEN FORTRESS garrison (zone-gated to 'xumen_fortress'). One tier past
        //    the capital in tech and menace. Re-timed 60fps -> 10Hz. HP UNCHANGED.
        if (zoneName === 'xumen_fortress' && e.aggroed && XF_BESPOKE[e.type]) {
          const dxp=nearestPlayer.x-e.x, dzp=nearestPlayer.z-e.z, dd=Math.sqrt(dxp*dxp+dzp*dzp)||0.0001;
          const sin=dxp/dd, cos=dzp/dd, pr=cos, pq=-sin, ang=Math.atan2(dxp,dzp);
          if(e._strafe===undefined) e._strafe=Math.random()<0.5?1:-1;
          if(Math.random()<0.036) e._strafe=-e._strafe;
          e._ab=(e._ab||0)+1;   // a556 — attackTimer is incremented by the generic enemy loop
          //   above (it runs for bespoke mobs too); incrementing it here as well ran every
          //   %-based attack check in this zone off a counter advancing 2 per tick.
          let _moved=false;
          const mv=(vx,vz,sp)=>{ e.x+=vx*sp; e.z+=vz*sp; _moved=true; };
          const hit=(mult)=>{ players.forEach((p,ws)=>{ if(p===nearestPlayer)
            send(ws,{type:'sv_enemy_attack',eid:e.id,dmg:_xfDmgS(e,mult),ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),zone:zoneName}); }); };
          const toPlayer=(msg)=>{ players.forEach((p,ws)=>{ if(p===nearestPlayer)
            send(ws, Object.assign({type:'sv_player_fx',zone:zoneName},msg)); }); };
          const fx=(vt,extra)=>{ broadcastToZone(game.id,zoneName, Object.assign({type:'sv_fx',vt:vt,zone:zoneName},extra||{})); };
          const shoot=(baseAng,col,mult,count,spread,kind,ox,oz)=>{ for(let i=0;i<count;i++){
            const a=baseAng+(count>1?(i-(count-1)/2)*spread:0);
            _sdSpawnProj(game,zoneName,{id:e.id,x:e.x+(ox||0),z:e.z+(oz||0)},a,col,_xfDmgS(e,mult),kind||'plasma',null,0); } };
          const tele=(tx,tz,fuse,radius,mult,col)=>{ if(!game._sdGeyser) game._sdGeyser=[];
            game._sdGeyser.push({zone:zoneName,x:tx,z:tz,fuse:fuse,dmg:_xfDmgS(e,mult),eid:e.id,col:col,radius:radius});
            fx('sd_geyser_warn',{ex:+tx.toFixed(2),ez:+tz.toFixed(2),col:col}); };
          // Exact point-to-beam-segment test, shared by the killzone tether and the pinwheel.
          // Both are "cross the line, take the hit" mechanics — approximating them with
          // circles would leave safe gaps along the beam.
          const beamHits=(ax,az,bx,bz,halfWidth)=>{
            const vx=bx-ax, vz=bz-az, L=Math.sqrt(vx*vx+vz*vz)||1;
            const ux=vx/L, uz=vz/L;
            const out=[];
            players.forEach((p,ws)=>{
              if(p.gameId!==game.id || p.zone!==zoneName || p.x===undefined) return;
              const rx=p.x-ax, rz=p.z-az, prj=rx*ux+rz*uz;
              if(prj>0 && prj<L && Math.abs(rx*uz-rz*ux)<halfWidth) out.push([p,ws]);
            });
            return out;
          };

          if(e.type==='xf_fortress_drone'){
            // GUN-PLATFORM SPRINTER — jinks hard, streams cannon fire, tethers killzones
            const MS=0.57;
            if(Math.random()<0.108) e._strafe=-e._strafe;
            const strafe=e._strafe;
            if(dd<3.5) mv(-sin*0.5+pr*strafe*1.0, -cos*0.5+pq*strafe*1.0, MS);
            else if(dd>12) mv(sin*0.9, cos*0.9, MS);
            else mv(sin*0.2+pr*strafe*1.0, cos*0.2+pq*strafe*1.0, MS);
            if(dd>2.2 && dd<15 && e.attackTimer%5===0){
              e._arm=!e._arm; const mo=e._arm?0.4:-0.4;
              shoot(ang,_XF_CYAN,0.4,1,0,'bolt', pr*mo, pq*mo); }
            // KILLZONE LINK — tether a lethal beam to the nearest free drone and scissor
            // around the player on opposite strafes. Only the LEADER ticks the tether.
            if(e._klOn && e._klLead){
              const p2=zone.enemies.find(o=>o && o.id===e._klPartner);
              if(!p2 || !p2.active || !e.active){ e._klOn=0; e._klLead=0; if(p2) p2._klOn=0; fx('xf_killzone_end',{eid:e.id}); }
              else {
                e._klT=(e._klT||0)+1;
                fx('xf_killzone_tick',{eid:e.id,ax:+e.x.toFixed(2),az:+e.z.toFixed(2),
                                       bx:+p2.x.toFixed(2),bz:+p2.z.toFixed(2),t:e._klT});
                if(!e._klCd || e._klT-e._klCd>=6){
                  const caught=beamHits(e.x,e.z,p2.x,p2.z,0.9);
                  if(caught.length){ e._klCd=e._klT;
                    caught.forEach(([p,ws])=>send(ws,{type:'sv_enemy_attack',eid:e.id,
                      dmg:_xfDmgS(e,0.7),ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),zone:zoneName})); } }
                if(e._klT>=35){ e._klOn=0; e._klLead=0; e._klT=0; p2._klOn=0; fx('xf_killzone_end',{eid:e.id}); }
              }
            } else if(!e._klOn){
              e._kl=(e._kl||Math.floor(Math.random()*37))+1;
              if(dd<16 && e._kl>=50){
                let p2=null, bd=13;
                for(let i=0;i<zone.enemies.length;i++){ const o=zone.enemies[i];
                  if(!o||!o.active||o===e||o.type!=='xf_fortress_drone'||o._klOn) continue;
                  const q=Math.sqrt((o.x-e.x)**2+(o.z-e.z)**2);
                  if(q<bd){ bd=q; p2=o; } }
                if(p2){ e._kl=0; e._klOn=1; e._klLead=1; e._klT=0; e._klCd=0; e._klPartner=p2.id;
                  p2._klOn=1; e._strafe=1; p2._strafe=-1;
                  fx('xf_killzone',{eid:e.id,pid2:p2.id,ax:+e.x.toFixed(2),az:+e.z.toFixed(2),
                                    bx:+p2.x.toFixed(2),bz:+p2.z.toFixed(2)});
                } else { e._kl=33; }      // no free partner — retry soon
              }
            }
          }
          else if(e.type==='xf_siege_walker'){
            // SIEGE PLATFORM — pinwheel lasers, repulsor field, bracketing mortars
            const MS=0.084;
            if(dd>6) mv(sin,cos,MS);
            if(dd>3 && dd<16 && e.attackTimer%10===0) shoot(ang,_XF_GOLD,0.65,1,0,'plasma');
            // REPULSOR PULSE — anti-melee shove
            e._rp=(e._rp||0)+1;
            if(dd<3.5 && e._rp>=15){ e._rp=0;
              toPlayer({eff:'push',px:+e.x.toFixed(2),pz:+e.z.toFixed(2),push:1.8});
              hit(0.5);
              fx('xf_repulsor',{eid:e.id,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2)}); }
            // TRIPLE PINWHEEL — three beams at 120° rotate a full turn. Hits once.
            if(e._pwOn){
              e._pwT=(e._pwT||0)+1;
              for(let sub=0; sub<2; sub++){
                const step=(e._pwT-1)*2+sub+1; if(step>26) break;
                for(let arm=0; arm<3; arm++){
                  if(e._pwHit) break;
                  const a2=e._pwA+step*0.25+arm*2.094;
                  const caught=beamHits(e.x,e.z,e.x+Math.sin(a2)*6.5,e.z+Math.cos(a2)*6.5,1.0);
                  if(caught.length){ e._pwHit=1;
                    caught.forEach(([p,ws])=>send(ws,{type:'sv_enemy_attack',eid:e.id,
                      dmg:_xfDmgS(e,1.0),ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),zone:zoneName})); } } }
              fx('xf_pinwheel_tick',{eid:e.id,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),
                                     a:+(e._pwA+e._pwT*2*0.25).toFixed(3)});
              if(e._pwT>=13){ e._pwOn=0; e._pwT=0; }
            } else {
              e._pw=(e._pw||10)+1;
              if(dd>2 && dd<9 && e._pw>=52){ e._pw=0; e._pwOn=1; e._pwT=0; e._pwHit=0;
                e._pwA=Math.random()*6.283;
                fx('xf_pinwheel',{eid:e.id,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),a0:+e._pwA.toFixed(3)}); } }
            // MORTAR BRACKET — four impacts box you in
            e._mb=(e._mb||8)+1;
            if(dd>4 && dd<18 && e._mb>=43){ e._mb=0;
              fx('xf_mortar',{eid:e.id});
              for(let mi2=0;mi2<4;mi2++){
                const ba2=mi2*1.5708+Math.random()*0.4;
                tele(nearestPlayer.x+Math.cos(ba2)*2.2, nearestPlayer.z+Math.sin(ba2)*2.2,
                     5+mi2*3, 2.6, 0.8, _XF_RED); } }
          }
          else if(e.type==='xf_warlord'){
            // FORTRESS COMMANDER — temporal echoes, sentry pylons, energy-blade rushes
            const MS=0.348;
            const strafe=e._strafe;
            if(e._br==='go'){
              e._bt=(e._bt||0)+1;
              mv(Math.sin(e._bdir),Math.cos(e._bdir),MS*2.9);
              if(dd<2.6 && !e._bhit){ e._bhit=1; hit(1.3); toPlayer({eff:'shake',shake:2}); }
              if(e._bt>=2){ e._br=0; e._bt=0; }
            } else {
              if(dd>2.6) mv(sin*0.8+pr*strafe*0.5, cos*0.8+pq*strafe*0.5, MS);
              else mv(pr*strafe, pq*strafe, MS);
              if(dd<3.0 && e.attackTimer%10===0) hit(1.05);
              e._brc=(e._brc||0)+1;
              if(dd>4 && dd<12 && e._brc>=33){ e._brc=0; e._br='go'; e._bt=0; e._bdir=ang; e._bhit=0;
                fx('xf_blade_rush',{eid:e.id,dir:+ang.toFixed(3)}); } }
            // TEMPORAL ECHO — the fortress fires on where you WERE, three times.
            //   Each sample is taken at cast+k*400ms and strikes (1200-k*100)ms after that,
            //   so camping one spot and running a straight line both get punished.
            e._te=(e._te||Math.floor(Math.random()*30))+1;
            if(dd>3 && dd<17 && e._te>=53){ e._te=0; e._teN=0; e._teT=0;
              fx('xf_echo',{eid:e.id,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2)}); }
            if(e._teN!==undefined && e._teN<3){
              e._teT=(e._teT||0)+1;
              if(e._teT>=1+e._teN*7){
                const k=e._teN; e._teN++;
                const sx=nearestPlayer.x, sz=nearestPlayer.z;
                fx('xf_echo_mark',{ex:+sx.toFixed(2),ez:+sz.toFixed(2),ms:1200-k*100});
                tele(sx,sz,12-k,2.4,0.9,_XF_LIME); }
              if(e._teN>=3) e._teN=undefined;
            }
            // DEPLOY SENTRY PYLON — autonomous turret, lives on the ZONE so it outlives
            //   the warlord that dropped it, exactly as the client kit intends.
            e._py=(e._py||Math.floor(Math.random()*37))+1;
            if(dd<15 && e._py>=63){ e._py=0;
              if(!zone._xfPylons) zone._xfPylons=[];
              if(zone._xfPylons.length < 12){          // sanity cap on a 52-warlord zone
                zone._nextPylonId=(zone._nextPylonId||0)+1;
                const pid=zone._nextPylonId;
                zone._xfPylons.push({pid:pid, x:e.x, z:e.z, t:0, life:60, dmg:_xfDmgS(e,0.4)});
                fx('xf_pylon',{pid:pid,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),ms:6000}); } }
          }
          else {
            // xf_titan_elite — ELITE JUGGERNAUT: teleporting armour with energy veins
            const MS=0.264;
            if(!e._wlOn && dd>3.0) mv(sin,cos,MS);
            // crushing melee — overcharged blows hit 40% harder, three of them
            if(dd<3.6 && e.attackTimer%12===0){
              const _m=(e._ovc>0)?1.4:1.1;
              if(e._ovc>0){ e._ovc--; fx('xf_charged_blow',{eid:e.id}); }
              hit(_m); toPlayer({eff:'shake',shake:2}); }
            if(dd>3 && dd<15 && e.attackTimer%12===6) shoot(ang,_XF_CYAN,0.6,1,0,'plasma');
            // WARP LATTICE — three blinks around you at 120°, a strike after each
            if(e._wlOn){
              e._wlT=(e._wlT||0)+1;
              if(e._wlT%6===0){
                const k=(e._wlT/6)-1;
                const ta2=(k*2.094)+Math.random()*0.5;
                const tx=nearestPlayer.x+Math.sin(ta2)*2.2, tz=nearestPlayer.z+Math.cos(ta2)*2.2;
                if(tx>2 && tx<358 && tz>2 && tz<358){ e.x=tx; e.z=tz; _moved=true; }
                fx('xf_warp',{eid:e.id,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2)});
                const wdx=nearestPlayer.x-e.x, wdz=nearestPlayer.z-e.z;
                if(Math.sqrt(wdx*wdx+wdz*wdz)<3.0) hit(0.8);
                if(k>=2){ e._wlOn=0; e._wlT=0; } }
            } else {
              e._wl=(e._wl||Math.floor(Math.random()*27))+1;
              if(dd>2 && dd<12 && e._wl>=57){ e._wl=0; e._wlOn=1; e._wlT=0; } }
            // VEIN OVERCHARGE — hardened plating AND three charged fists.
            //   Both halves are server-owned: the plating changes e.dmgReduction (which the
            //   server uses to resolve player hits) and the charges change outgoing damage.
            if(e._voOn){
              e._voT=(e._voT||0)+1;
              if(e._voT>=33){ e._voOn=0; e._voT=0;
                if(e._voBase!=null) e.dmgReduction=e._voBase;
                fx('xf_overcharge_end',{eid:e.id}); }
            } else {
              e._vo=(e._vo||0)+1;
              if(dd<12 && e._vo>=67){ e._vo=0; e._voOn=1; e._voT=0; e._ovc=3;
                if(e._voBase==null) e._voBase=e.dmgReduction||0;
                e.dmgReduction=Math.min(0.88, e._voBase+0.30);
                fx('xf_overcharge',{eid:e.id,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2)}); } }
          }

          if(_moved) changed.push(e);
        }

        // ── a553: VOID CITADEL unreality garrison (zone-gated to 'void_citadel'; every type
        //    is shared with an already-migrated zone, so the gate is load-bearing).
        //    Re-timed 60fps -> 10Hz. HP is set at spawn via ZONE_TYPE_HP.
        if (zoneName === 'void_citadel' && e.aggroed && VC_BESPOKE[e.type]) {
          const dxp=nearestPlayer.x-e.x, dzp=nearestPlayer.z-e.z, dd=Math.sqrt(dxp*dxp+dzp*dzp)||0.0001;
          const sin=dxp/dd, cos=dzp/dd, pr=cos, pq=-sin, ang=Math.atan2(dxp,dzp);
          if(e._strafe===undefined) e._strafe=Math.random()<0.5?1:-1;
          if(Math.random()<0.036) e._strafe=-e._strafe;
          const strafe=e._strafe;
          e._ab=(e._ab||0)+1;   // a556 — attackTimer is incremented by the generic enemy loop
          //   above (it runs for bespoke mobs too); incrementing it here as well ran every
          //   %-based attack check in this zone off a counter advancing 2 per tick.
          let _moved=false;
          const mv=(vx,vz,sp)=>{ e.x+=vx*sp; e.z+=vz*sp; _moved=true; };
          const hit=(mult)=>{ players.forEach((p,ws)=>{ if(p===nearestPlayer)
            send(ws,{type:'sv_enemy_attack',eid:e.id,dmg:_vcDmgS(e,mult),ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),zone:zoneName}); }); };
          const hitAt=(mult,hx,hz,radius)=>{ players.forEach((p,ws)=>{
            if(p.gameId!==game.id || p.zone!==zoneName || p.x===undefined) return;
            const qx=p.x-hx, qz=p.z-hz; if(qx*qx+qz*qz < radius*radius)
              send(ws,{type:'sv_enemy_attack',eid:e.id,dmg:_vcDmgS(e,mult),ex:+hx.toFixed(2),ez:+hz.toFixed(2),zone:zoneName}); }); };
          const toPlayer=(msg)=>{ players.forEach((p,ws)=>{ if(p===nearestPlayer)
            send(ws, Object.assign({type:'sv_player_fx',zone:zoneName},msg)); }); };
          const fx=(vt,extra)=>{ broadcastToZone(game.id,zoneName, Object.assign({type:'sv_fx',vt:vt,zone:zoneName},extra||{})); };
          const shoot=(baseAng,col,mult,count,spread)=>{ for(let i=0;i<count;i++){
            const a=baseAng+(count>1?(i-(count-1)/2)*spread:0);
            _sdSpawnProj(game,zoneName,e,a,col,_vcDmgS(e,mult),'void',null,0); } };
          const shootFrom=(sx,sz,a,col,mult)=>{
            _sdSpawnProj(game,zoneName,{id:e.id,x:sx,z:sz},a,col,_vcDmgS(e,mult),'void',null,0); };
          const blink=(nx,nz)=>{ if(nx>2 && nx<358 && nz>2 && nz<358){ e.x=nx; e.z=nz; _moved=true; }
            fx('vc_blink',{eid:e.id,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2)}); };

          if(e.type==='void_construct'){
            // NULL GOLEM — your reflection is its weapon
            const MS=0.228;
            if(dd>2.8) mv(sin*0.9+pr*strafe*0.3, cos*0.9+pq*strafe*0.3, MS);
            if(dd<3.2 && e.attackTimer%12===0) hit(1.1);
            if(dd>2.6 && dd<14 && e.attackTimer%13===0) shoot(ang,_VC_EDGE,0.55,1,0);
            // VOID MIRROR — a dark orb copies you THROUGH the construct in real time
            //   (M = 2*construct - you), locks crimson partway, and then both the orb AND
            //   the spot you stood at the moment of the lock erupt.
            if(e._vmOn){
              e._vmT=(e._vmT||0)+1;
              if(e._vmT<11){                       // still mirroring you live
                e._vmX=2*e.x-nearestPlayer.x; e._vmZ=2*e.z-nearestPlayer.z;
              } else if(e._vmT===11){              // the lock
                e._vmLX=nearestPlayer.x; e._vmLZ=nearestPlayer.z;
                fx('vc_mirror_lock',{eid:e.id,mx:+e._vmX.toFixed(2),mz:+e._vmZ.toFixed(2)});
              }
              fx('vc_mirror_tick',{eid:e.id,mx:+e._vmX.toFixed(2),mz:+e._vmZ.toFixed(2),
                                   locked:(e._vmT>=11)?1:0,t:e._vmT});
              if(e._vmT>=18){ e._vmOn=0; e._vmT=0;
                fx('vc_mirror_erupt',{mx:+e._vmX.toFixed(2),mz:+e._vmZ.toFixed(2),
                                      lx:+e._vmLX.toFixed(2),lz:+e._vmLZ.toFixed(2)});
                hitAt(1.15, e._vmX, e._vmZ, 2.2);
                hitAt(1.15, e._vmLX, e._vmLZ, 2.2);
                toPlayer({eff:'shake',shake:2}); }
            } else {
              e._vm=(e._vm||Math.floor(Math.random()*30))+1;
              if(dd>2 && dd<13 && e._vm>=50){ e._vm=0; e._vmOn=1; e._vmT=0;
                e._vmX=2*e.x-nearestPlayer.x; e._vmZ=2*e.z-nearestPlayer.z;
                e._vmLX=nearestPlayer.x; e._vmLZ=nearestPlayer.z;
                fx('vc_mirror',{eid:e.id,mx:+e._vmX.toFixed(2),mz:+e._vmZ.toFixed(2)}); } }
          }
          else if(e.type==='void_sentinel'){
            // THE WATCHING EYE — near-stationary; its gaze does the walking
            const MS=0.09;
            if(dd>14) mv(sin,cos,MS);
            if(dd>2.4 && dd<17 && e.attackTimer%11===0 && !e._gzOn) shoot(ang,_VC_NULL,0.5,2,0.18);
            // blink-guard when crowded
            e._bg=(e._bg||0)+1;
            if(dd<3 && e._bg>=23){ e._bg=0;
              const ba2=ang+Math.PI+(Math.random()-0.5)*0.8;
              blink(e.x+Math.sin(ba2)*5, e.z+Math.cos(ba2)*5); }
            // GAZE OF THE VOID — a held stare that darkens the screen. BREAK RANGE to end
            //   it: the channel drops the moment the target is past 16 units.
            if(e._gzOn){
              e._gzT=(e._gzT||0)+1;
              if(dd>16){ e._gzOn=0; e._gzT=0; e._gzN=0; fx('vc_gaze_end',{eid:e.id}); }
              else {
                if(e._gzT%3===0){ e._gzN=(e._gzN||0)+1;
                  fx('vc_gaze_tick',{eid:e.id,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),
                                     tx:+nearestPlayer.x.toFixed(2),tz:+nearestPlayer.z.toFixed(2)});
                  hit(0.38); }
                if((e._gzN||0)>=8){ e._gzOn=0; e._gzT=0; e._gzN=0; fx('vc_gaze_end',{eid:e.id}); } }
            } else {
              e._gz=(e._gz||Math.floor(Math.random()*27))+1;
              if(dd>3 && dd<15 && e._gz>=53){ e._gz=0; e._gzOn=1; e._gzT=0; e._gzN=0;
                fx('vc_gaze',{eid:e.id,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2)}); } }
          }
          else if(e.type==='rift_stalker'){
            // THE STEP THAT SKIPS SPACE — it arrives mirrored through you
            const MS=0.372;
            if(dd>2.4) mv(sin*0.8+pr*strafe*0.6, cos*0.8+pq*strafe*0.6, MS);
            else mv(pr*strafe, pq*strafe, MS);
            if(dd<2.8 && e.attackTimer%9===0) hit(1.0);
            // twin rend combo
            if(e._trN>0){ e._trT=(e._trT||0)+1;
              if(e._trT>=3){ e._trN=0; e._trT=0; if(dd<3.4) hit(0.7); } }
            e._tr=(e._tr||0)+1;
            if(dd<3.2 && e._tr>=28 && !e._trN){ e._tr=0; hit(0.7); e._trN=1; e._trT=0;
              fx('vc_rend',{eid:e.id,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2)}); }
            // NON-EUCLIDEAN STEP — front becomes behind without crossing the space
            if(e._neN>0){ e._neT=(e._neT||0)+1;
              if(e._neT>=3){ e._neN=0; e._neT=0;
                const qx=nearestPlayer.x-e.x, qz=nearestPlayer.z-e.z;
                if(Math.sqrt(qx*qx+qz*qz)<3.0){ hit(1.2);
                  fx('vc_step_strike',{ex:+e.x.toFixed(2),ez:+e.z.toFixed(2)}); } } }
            e._ne=(e._ne||Math.floor(Math.random()*25))+1;
            if(dd>2.5 && dd<10 && e._ne>=40 && !e._neN){ e._ne=0;
              blink(2*nearestPlayer.x-e.x, 2*nearestPlayer.z-e.z);
              e._neN=1; e._neT=0; }
          }
          else {
            // rift_weaver — SEAMSTRESS OF UNREALITY: tears reality open, trades places
            const MS=0.252;
            if(dd<5) mv(-sin*0.7+pr*strafe*0.6, -cos*0.7+pq*strafe*0.6, MS);
            else if(dd>13) mv(sin*0.7, cos*0.7, MS);
            else mv(pr*strafe, pq*strafe, MS);
            // woven lattice — two crossing volleys
            if(dd>2.6 && dd<15 && e._ab>=25){ e._ab=0; shoot(ang,_VC_EDGE,0.45,3,0.24); e._wl2=3; }
            if(e._wl2>0){ e._wl2--; if(e._wl2===0) shoot(ang,_VC_PALE,0.45,3,0.24); }
            // REALITY TEAR — a jagged seam perpendicular to you, firing out of both faces
            if(e._rtN!==undefined && e._rtN<3){
              e._rtT=(e._rtT||0)+1;
              if(e._rtT>=2+e._rtN*2){
                const k=e._rtN; e._rtN++;
                const fr2=k/2;
                const sx=e._rtAX+(e._rtBX-e._rtAX)*fr2, sz=e._rtAZ+(e._rtBZ-e._rtAZ)*fr2;
                shootFrom(sx,sz,e._rtAng,_VC_CRIM,0.5);
                shootFrom(sx,sz,e._rtAng+Math.PI,_VC_CRIM,0.5);
                fx('vc_tear_face',{ex:+sx.toFixed(2),ez:+sz.toFixed(2)}); }
              if(e._rtN>=3) e._rtN=undefined;
            }
            e._rt=(e._rt||Math.floor(Math.random()*27))+1;
            if(dd>3 && dd<14 && e._rt>=47 && e._rtN===undefined){ e._rt=0;
              const ta2=ang+1.5708;
              e._rtAX=nearestPlayer.x+Math.sin(ta2)*2.4; e._rtAZ=nearestPlayer.z+Math.cos(ta2)*2.4;
              e._rtBX=nearestPlayer.x-Math.sin(ta2)*2.4; e._rtBZ=nearestPlayer.z-Math.cos(ta2)*2.4;
              e._rtAng=ang; e._rtN=0; e._rtT=0;
              fx('vc_tear',{ax:+e._rtAX.toFixed(2),az:+e._rtAZ.toFixed(2),
                            bx:+e._rtBX.toFixed(2),bz:+e._rtBZ.toFixed(2)}); }
            // VOID SWAP — it trades places with you outright.
            //   a553: the client put only the ANNOUNCE on a 10s cooldown while the swap
            //   itself fired every time. Solo that's a rare shock; with 34 weavers in the
            //   zone and a party it would yank people across the floor almost continuously,
            //   and being teleported is far more disruptive than any speed surge. The SWAP
            //   now shares the cooldown, so it stays the set piece it was written to be.
            e._vs2=(e._vs2||Math.floor(Math.random()*37))+1;
            if(dd>3 && dd<14 && e._vs2>=70){ e._vs2=0;
              const _now=Date.now();
              if(!zone._vcSwapCd || _now>zone._vcSwapCd){
                zone._vcSwapCd=_now+10000;
                const exX=e.x, exZ=e.z, plX=nearestPlayer.x, plZ=nearestPlayer.z;
                e.x=plX; e.z=plZ; _moved=true;
                toPlayer({eff:'swap',px:+exX.toFixed(2),pz:+exZ.toFixed(2)});
                toPlayer({eff:'slow',slow:0.5,root:500});
                fx('vc_swap',{eid:e.id,ax:+exX.toFixed(2),az:+exZ.toFixed(2),
                              bx:+plX.toFixed(2),bz:+plZ.toFixed(2)}); } }
          }

          if(_moved) changed.push(e);
        }

        // ── a554: LUCIDWILDE dreaming canopy (zone-gated to 'lucidwilde'). A Lv100+
        //    uberzone: sticky pursuit, a STOP distance so they halt IN FRONT of you rather
        //    than on top, and psychedelic prism abilities. Re-timed 60fps -> 10Hz.
        //    Damage is e.atk-based, so it's exact rather than the usual flat-PWR mirror.
        if (zoneName === 'lucidwilde' && e.aggroed && LW_BESPOKE[e.type]) {
          const dxp=nearestPlayer.x-e.x, dzp=nearestPlayer.z-e.z, dd=Math.sqrt(dxp*dxp+dzp*dzp)||0.0001;
          const sin=dxp/dd, cos=dzp/dd, ang=Math.atan2(dxp,dzp);
          const SP=(e.spd||0.05)*6;
          e._ab=(e._ab||0)+1;   // a556 — attackTimer is incremented by the generic enemy loop
          //   above (it runs for bespoke mobs too); incrementing it here as well ran every
          //   %-based attack check in this zone off a counter advancing 2 per tick.
          let _moved=false;
          const mv=(vx,vz,sp)=>{ e.x+=vx*sp; e.z+=vz*sp; _moved=true; };
          const hit=(mult)=>{ players.forEach((p,ws)=>{ if(p===nearestPlayer)
            send(ws,{type:'sv_enemy_attack',eid:e.id,dmg:Math.floor((e.atk||300)*mult),
                     ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),zone:zoneName}); }); };
          const fx=(vt,extra)=>{ broadcastToZone(game.id,zoneName, Object.assign({type:'sv_fx',vt:vt,zone:zoneName},extra||{})); };
          const shoot=(baseAng,col,mult,count,spread)=>{ for(let i=0;i<count;i++){
            const a=baseAng+(count>1?(i-(count-1)/2)*spread:0);
            _sdSpawnProj(game,zoneName,e,a,col,Math.floor((e.atk||300)*mult),'magic',null,0); } };

          if(e.type==='prismaraptor'){
            // FAST melee raptor — chases hard, slashes, and PRISM-DASHES through you
            const STOP=2.3;
            if(e._dash==='wind'){
              e._dt=(e._dt||0)+1;
              if(e._dt>=3){ e._dash='go'; e._dt=0; e._ddir=ang; e._dhit=0;
                fx('lw_dash',{eid:e.id,dir:+ang.toFixed(3)}); }
            } else if(e._dash==='go'){
              e._dt=(e._dt||0)+1;
              mv(Math.sin(e._ddir),Math.cos(e._ddir),SP*3.4);
              if(dd<2.0 && !e._dhit){ e._dhit=1; hit(1.5);
                fx('lw_dash_hit',{ex:+e.x.toFixed(2),ez:+e.z.toFixed(2)}); }
              if(e._dt>=3){ e._dash=null; e._dt=0; }
            } else {
              if(dd>STOP) mv(sin,cos,SP);
              if(dd<2.9 && e.attackTimer%10===0){ hit(1.0);
                fx('lw_slash',{eid:e.id,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2)}); }
              e._dc=(e._dc||0)+1;
              if(dd<14 && e._dc>=33){ e._dc=0; e._dash='wind'; e._dt=0;
                fx('lw_dash_wind',{eid:e.id}); }
            }
          }
          else if(e.type==='sporegon'){
            // TANKY bruiser — lumbers in while lobbing SPORE BLOOM from well out
            const STOP=2.6;
            if(dd>STOP) mv(sin,cos,SP*1.7);
            if(dd<3.0 && e.attackTimer%15===0){ hit(1.0);
              fx('lw_maul',{eid:e.id,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2)}); }
            // SPORE BLOOM — telegraph ring on the ground, then a dodgeable burst
            if(dd<24 && e._ab>=25){ e._ab=0;
              const tx=nearestPlayer.x, tz=nearestPlayer.z;
              if(!game._sdGeyser) game._sdGeyser=[];
              game._sdGeyser.push({zone:zoneName,x:tx,z:tz,fuse:9,dmg:Math.floor((e.atk||400)*1.5),
                                   eid:e.id,col:_lwCol(),radius:2.5});
              fx('lw_bloom',{eid:e.id,ex:+tx.toFixed(2),ez:+tz.toFixed(2)}); }
          }
          else {
            // vortexwisp — floating prism caster that kites and fires rainbow spells
            if(dd<6) mv(-sin,-cos,SP*0.9);
            else if(dd>10) mv(sin,cos,SP*0.7);
            // PRISM BEAM — a fan of 5 rainbow orbs
            if(dd>2.5 && dd<18 && e._ab>=20){ e._ab=0;
              shoot(ang,_lwCol(),0.8,5,0.17);
              fx('lw_beam',{eid:e.id,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2)}); }
            // RAINBOW NOVA — a radiating ring of 14 prism orbs
            e._nova=(e._nova||Math.floor(Math.random()*42))+1;
            if(dd<22 && e._nova>=60){ e._nova=0;
              for(let i=0;i<14;i++)
                _sdSpawnProj(game,zoneName,e,(i/14)*6.283,_LW_PRISM[i%_LW_PRISM.length],
                             Math.floor((e.atk||520)*0.55),'magic',null,0);
              fx('lw_nova',{eid:e.id,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2)}); }
          }

          if(_moved) changed.push(e);
        }

        // ── a555: THE FORGE foundry (zone-gated to 'forge'). Lv95 industrial mobs that
        //    reshape the floor: lava pools, turrets, shredder beams and a crawler that
        //    kills itself to hurt you. Re-timed 60fps -> 10Hz. Damage is e.atk-based.
        if (zoneName === 'forge' && e.aggroed && FG_BESPOKE[e.type]) {
          const dxp=nearestPlayer.x-e.x, dzp=nearestPlayer.z-e.z, dd=Math.sqrt(dxp*dxp+dzp*dzp)||0.0001;
          const sin=dxp/dd, cos=dzp/dd, ang=Math.atan2(dxp,dzp);
          e._ab=(e._ab||0)+1;   // a556 — attackTimer is incremented by the generic enemy loop
          //   above (it runs for bespoke mobs too); incrementing it here as well ran every
          //   %-based attack check in this zone off a counter advancing 2 per tick.
          let _moved=false;
          const mv=(vx,vz,sp)=>{ e.x+=vx*sp; e.z+=vz*sp; _moved=true; };
          const fx=(vt,extra)=>{ broadcastToZone(game.id,zoneName, Object.assign({type:'sv_fx',vt:vt,zone:zoneName},extra||{})); };

          // ── Foundry buffs. The technician's field and a crawler's overcharge both raise
          //    outgoing damage, and overheat trades self-damage for it. All server-owned:
          //    they change what players take, so they cannot stay client-local.
          let atkMul=1, spdMul=1;
          if(e._techBuff>0){ e._techBuff--; atkMul*=1.25; }
          if(e._oc>0){ e._oc--; atkMul*=1.3; spdMul*=1.6; }
          if(e._overheat>0){ e._overheat--; atkMul*=1.6;
            if(e._overheat%5===0){ e.hp=Math.max(1, e.hp-Math.floor(e.maxHp*0.01)); changed.push(e); } }
          const SP=(e.spd||0.05)*6*spdMul;
          const hit=(mult)=>{ players.forEach((p,ws)=>{ if(p===nearestPlayer)
            send(ws,{type:'sv_enemy_attack',eid:e.id,dmg:Math.floor((e.atk||400)*mult*atkMul),
                     ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),zone:zoneName}); }); };
          const hitAt=(dmg,hx,hz,radius)=>{ players.forEach((p,ws)=>{
            if(p.gameId!==game.id || p.zone!==zoneName || p.x===undefined) return;
            const qx=p.x-hx, qz=p.z-hz; if(qx*qx+qz*qz < radius*radius)
              send(ws,{type:'sv_enemy_attack',eid:e.id,dmg:dmg,ex:+hx.toFixed(2),ez:+hz.toFixed(2),zone:zoneName}); }); };
          const puddle=(px,pz,r,life,dmg)=>{
            if(_fgSpawnEnt(game,zoneName,zone,{kind:'puddle',x:px,z:pz,r:r,life:life,dmg:dmg,cd:0}))
              fx('fg_puddle',{ex:+px.toFixed(2),ez:+pz.toFixed(2),r:r,life:life}); };

          if(e.type==='lava_forged_sentinel'){
            // FOUNDRY GUARDIAN — hardens and then enrages as it's worn down
            if(!e._shielded && e.hp < e.maxHp*0.5){ e._shielded=1;
              e.dmgReduction=Math.min(0.4,(e.dmgReduction||0.2)+0.12);
              fx('fg_harden',{eid:e.id,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2)}); }
            if(!e._enraged && e.hp < e.maxHp*0.3){ e._enraged=1;
              fx('fg_enrage',{eid:e.id,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2)}); }
            const em=e._enraged?1.3:1;
            if(dd>2.8) mv(sin,cos,SP*em);
            if(dd<3.6 && e.attackTimer%Math.max(2,Math.floor(11/em))===0){ hit(1.0);
              fx('fg_hammer',{eid:e.id,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2)}); }
            // MOLTEN SLAM — a shockwave that leaves the floor burning
            e._slam=(e._slam||20)+1;
            if(dd<6 && e._slam>=Math.max(8,Math.floor(43/em))){ e._slam=0;
              fx('fg_slam',{eid:e.id,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2)});
              hitAt(Math.floor((e.atk||620)*1.5*atkMul), e.x, e.z, 5.5); }
          }
          else if(e.type==='molten_crawler'){
            // SKITTERING BOMB — below a fifth health it lights its own fuse and charges
            if(e._fuse>0){
              e._fuse--;
              mv(sin,cos,SP*1.6);
              if(e._fuse<=0){
                fx('fg_detonate',{eid:e.id,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2)});
                hitAt(Math.floor((e.atk||480)*2.2*atkMul), e.x, e.z, 6.0);
                e.hp=0; e.active=false; e.aggroed=false; e.respawnTimer=0;
                changed.push(e);
                // The crawler killed itself, but it died fighting — the client's local kit
                //   ran it through killEnemy() and paid out, so credit the nearest player
                //   rather than silently voiding the reward for a mechanic nobody chose.
                broadcastToZone(game.id,zoneName,{ type:'sv_enemy_killed',
                  id:e.id, etype:e.type, zone:zoneName,
                  reward:e.reward, expR:e.expR,
                  ex:+e.x.toFixed(2), ez:+e.z.toFixed(2),
                  killer: nearestPlayer && nearestPlayer.name });
                if(nearestPlayer && nearestPlayer.name)
                  awardGuildXp(nearestPlayer.name, Math.max(1, Math.floor((e.expR||1)/2)));
              }
              if(_moved) changed.push(e);
              return;
            }
            if(e.hp < e.maxHp*0.22 && !e._fuse){ e._fuse=8;     // 48 frames
              fx('fg_overload',{eid:e.id,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2)}); }
            // weaving approach
            if(e._sf===undefined) e._sf=Math.random()*6.28;
            const strafe=Math.sin((e._ab*6)*0.06+e._sf)*0.5;
            if(dd>1.6) mv(sin-cos*strafe, cos+sin*strafe, SP);
            if(dd<2.0 && e.attackTimer%6===0) hit(1.0);
            // LAVA SPIT — lands a lingering pool
            e._spit=(e._spit||5)+1;
            if(dd>4 && dd<18 && e._spit>=23){ e._spit=0;
              const tx=nearestPlayer.x, tz=nearestPlayer.z;
              fx('fg_spit',{eid:e.id,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),tx:+tx.toFixed(2),tz:+tz.toFixed(2)});
              puddle(tx,tz,1.8,35,Math.floor((e.atk||480)*0.15)); }
            // OVERCHARGE — it cooks itself hotter
            if(!e._oc && e._ab>=33 && Math.random()<0.04){ e._oc=40;
              fx('fg_overcharge',{eid:e.id,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2)}); }
          }
          else if(e.type==='forge_technician'){
            // SUPPORT UNIT — repairs, buffs, and bolts a turret to the floor
            if(dd<10) mv(-sin,-cos,SP);
            else if(dd>14) mv(sin,cos,SP*0.8);
            if(dd>2.5 && dd<18 && e.attackTimer%12===0){
              _sdSpawnProj(game,zoneName,e,ang,_FG_CYAN,Math.floor((e.atk||380)*atkMul),'bolt',null,0);
              fx('fg_needle',{eid:e.id,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2)}); }
            // REPAIR BEAM — mends every damaged foundry unit within 16u for 5% each.
            //   Client discipline preserved: only hurt units, capped at maxHp. The 30-tick
            //   cadence is what keeps five technicians from out-healing a party.
            e._rep=(e._rep||7)+1;
            if(e._rep>=30){ e._rep=0;
              let healed=0;
              for(let i=0;i<zone.enemies.length;i++){ const o=zone.enemies[i];
                if(!o||!o.active||o===e||!FG_BESPOKE[o.type]) continue;
                const odx=o.x-e.x, odz=o.z-e.z;
                if(odx*odx+odz*odz>256) continue;
                if(o.hp<o.maxHp){ o.hp=Math.min(o.maxHp, o.hp+Math.floor(o.maxHp*0.05));
                  changed.push(o); healed++; } }
              if(healed) fx('fg_repair',{eid:e.id,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),n:healed}); }
            // DEPLOY TURRET — an autonomous emplacement that outlives its builder
            e._tur=(e._tur||15)+1;
            if(dd<22 && e._tur>=53){ e._tur=0;
              const tx=e.x+(Math.random()-0.5)*6, tz=e.z+(Math.random()-0.5)*6;
              if(tx>2 && tx<358 && tz>2 && tz<358){
                const ent=_fgSpawnEnt(game,zoneName,zone,{kind:'turret',x:tx,z:tz,life:60,
                                                          dmg:Math.floor((e.atk||380)*1.4),cd:0});
                if(ent) fx('fg_turret',{did:ent.eid,ex:+tx.toFixed(2),ez:+tz.toFixed(2),life:60}); } }
            // OVERCLOCK FIELD — +25% damage to every unit within 14u
            e._buf=(e._buf||10)+1;
            if(e._buf>=35){ e._buf=0;
              for(let i=0;i<zone.enemies.length;i++){ const o=zone.enemies[i];
                if(!o||!o.active||!FG_BESPOKE[o.type]) continue;
                const odx=o.x-e.x, odz=o.z-e.z;
                if(odx*odx+odz*odz<196) o._techBuff=25; }
              fx('fg_buff',{eid:e.id,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2)}); }
          }
          else {
            // industrial_devastator — SIEGE WALKER: barrages, shredder beams, overheat
            if(!e._overheat && e.hp < e.maxHp*0.4 && e._ab>20 && Math.random()<0.02){
              e._overheat=50;                                   // 300 frames
              fx('fg_overheat',{eid:e.id,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2)}); }
            if(dd<14) mv(-sin,-cos,SP);
            else if(dd>24) mv(sin,cos,SP*0.8);
            if(dd<6 && e.attackTimer%8===0) hit(0.8);
            // CANNON BARRAGE — five shells that leave burning craters
            e._bar=(e._bar||7)+1;
            if(dd<26 && e._bar>=25){ e._bar=0;
              const reach=Math.min(22,Math.max(6,dd));
              fx('fg_barrage',{eid:e.id,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2)});
              for(let i=0;i<5;i++){ const a=ang+(i-2)*0.18;
                _sdSpawnProj(game,zoneName,e,a,_FG_HOT,Math.floor((e.atk||720)*0.7*atkMul),'plasma',null,0);
                const tx=e.x+Math.sin(a)*reach, tz=e.z+Math.cos(a)*reach;
                if(!e._barQ) e._barQ=[];
                e._barQ.push({t:5,x:tx,z:tz,dmg:Math.floor((e.atk||720)*0.12)}); } }
            if(e._barQ && e._barQ.length){
              for(let i=e._barQ.length-1;i>=0;i--){ const q=e._barQ[i]; q.t--;
                if(q.t<=0){ puddle(q.x,q.z,1.6,25,q.dmg); e._barQ.splice(i,1); } } }
            // GROUND SHREDDER — a 30-unit lance down the floor. Exact segment test.
            e._shr=(e._shr||15)+1;
            if(dd<28 && e._shr>=50){ e._shr=0;
              fx('fg_shredder',{eid:e.id,ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),a:+ang.toFixed(3),len:30});
              const ux=Math.sin(ang), uz=Math.cos(ang);
              players.forEach((p,ws)=>{
                if(p.gameId!==game.id || p.zone!==zoneName || p.x===undefined) return;
                const rx=p.x-e.x, rz=p.z-e.z, prj=rx*ux+rz*uz;
                if(prj>-2 && prj<30 && Math.abs(rx*uz-rz*ux)<1.6)
                  send(ws,{type:'sv_enemy_attack',eid:e.id,dmg:Math.floor((e.atk||720)*0.9*atkMul),
                           ex:+e.x.toFixed(2),ez:+e.z.toFixed(2),zone:zoneName}); }); }
          }

          if(_moved) changed.push(e);
        }
    });

    // Broadcast state for changed enemies (positions + HP)
    if (changed.length > 0 && hasPlayers) {
      const ids=[], xs=[], zs=[], hps=[], acts=[], types=[];
      changed.forEach(e => {
        ids.push(e.id);
        xs.push(+e.x.toFixed(2));
        zs.push(+e.z.toFixed(2));
        hps.push(e.hp);
        acts.push(e.active ? 1 : 0);
        types.push(e.type);
      });
      broadcastToZone(game.id, zoneName, { type:'sv_enemy_state', zone:zoneName, ids, xs, zs, hps, acts, types });
    }

    tickZoneBoss(game, zoneName, zone);   // a548 — server-authoritative zone boss (CRYOTHAR)
    if (zoneName === 'xumen_fortress') _xfTickPylons(game, zoneName, zone);   // a552 — sentry pylons outlive their owner
    if (zoneName === 'forge') _fgTickEntities(game, zoneName, zone);          // a555 — puddles / turrets / meteors / drones
  });
  // a527 — advance server-owned SD projectiles once per tick; resolve hits
  if (game._sdProj && game._sdProj.length) {
    const keep = [];
    for (const pr of game._sdProj) {
      pr.x += pr.vx; pr.z += pr.vz; pr.life--;
      let hit = false;
      players.forEach((p, ws) => {
        if (hit || p.gameId !== game.id || p.zone !== pr.zone || p.x === undefined) return;
        const ddx=p.x-pr.x, ddz=p.z-pr.z;
        if (ddx*ddx + ddz*ddz < 1.5*1.5) {
          send(ws, { type:'sv_enemy_attack', eid:pr.eid, dmg:pr.dmg, ex:+pr.x.toFixed(2), ez:+pr.z.toFixed(2), zone:pr.zone });
          if (pr.status) send(ws, { type:'sv_player_fx', zone:pr.zone, eff:'status', status:pr.status, statusDur:pr.statusDur });
          hit = true;
        }
      });
      if (!hit && pr.life > 0) keep.push(pr);
    }
    game._sdProj = keep;
  }
  // a528 — resolve pending SD sand geysers (delayed AoE eruptions)
  if (game._sdGeyser && game._sdGeyser.length) {
    const keepG = [];
    for (const gy of game._sdGeyser) {
      gy.fuse--;
      // a541 — ORBITAL LOCK re-target: the reticle tracks the player, then commits for good.
      if (gy.relock && gy.fuse === gy.relock) {
        let _rp = null, _rbd = 1e9;
        players.forEach((p) => { if (!p || p.gameId !== game.id || p.zone !== gy.zone || p.x === undefined) return;
          const rdx=p.x-gy.x, rdz=p.z-gy.z, r2=rdx*rdx+rdz*rdz; if (r2 < _rbd) { _rbd = r2; _rp = p; } });
        if (_rp) { gy.x = _rp.x; gy.z = _rp.z;
          if (gy.excom) broadcastToZone(game.id, gy.zone, { type:'sv_fx', vt:'vs_halo', zone:gy.zone, ex:+gy.x.toFixed(2), ez:+gy.z.toFixed(2), col:(gy.col||0xffd76a), ms:300 });   // a545 — the brand follows you
          else broadcastToZone(game.id, gy.zone, gy.deathmark
            ? { type:'sv_fx', vt:'np_crossbones', zone:gy.zone, ex:+gy.x.toFixed(2), ez:+gy.z.toFixed(2), col:(gy.col||0x88ff66), ms:300 }   // a544 — the brand follows you
            : { type:'sv_fx', vt:'sd_geyser_warn', zone:gy.zone, ex:+gy.x.toFixed(2), ez:+gy.z.toFixed(2), col:(gy.col||0xff3cf0) }); }
        gy.relock = 0;
      }
      if (gy.fuse <= 0) {
        const _gr = gy.radius || 2.3;
        if (gy.soft) broadcastToZone(game.id, gy.zone, { type:'sv_fx', vt:'sd_motes', zone:gy.zone, ex:+gy.x.toFixed(2), ez:+gy.z.toFixed(2), col:(gy.col||0x88ff44), n:5 });
        else broadcastToZone(game.id, gy.zone, { type:'sv_fx', vt:'sd_geyser_hit', zone:gy.zone, ex:+gy.x.toFixed(2), ez:+gy.z.toFixed(2), col:(gy.col||0xd8b45e), radius:_gr });
        players.forEach((p, ws) => {
          if (p.gameId !== game.id || p.zone !== gy.zone || p.x === undefined) return;
          const ddx=p.x-gy.x, ddz=p.z-gy.z;
          if (ddx*ddx + ddz*ddz < _gr*_gr) {
            if (gy.dmg > 0) send(ws, { type:'sv_enemy_attack', eid:gy.eid, dmg:gy.dmg, ex:+gy.x.toFixed(2), ez:+gy.z.toFixed(2), zone:gy.zone });   // a541 — pure-effect ticks (singularity drag, time field) carry dmg 0
            if (gy.slow) send(ws, { type:'sv_player_fx', zone:gy.zone, eff:'slow', slow:gy.slow, root:(gy.slowDur||1000) });
            if (gy.pull) send(ws, { type:'sv_player_fx', zone:gy.zone, eff:'pull', px:+gy.x.toFixed(2), pz:+gy.z.toFixed(2), pull:gy.pull });
            if (gy.push) send(ws, { type:'sv_player_fx', zone:gy.zone, eff:'push', px:+gy.x.toFixed(2), pz:+gy.z.toFixed(2), push:gy.push });   // a548 — delayed knockback (elder dragon TAIL SWEEP)
            if (gy.status) send(ws, { type:'sv_player_fx', zone:gy.zone, eff:'status', status:gy.status, statusDur:(gy.statusDur||120) });
            if (gy.shake) send(ws, { type:'sv_player_fx', zone:gy.zone, eff:'shake', shake:gy.shake });   // a540 — blasting charge
            if (gy.freeze) send(ws, { type:'sv_player_fx', zone:gy.zone, eff:'freeze', px:+gy.x.toFixed(2), pz:+gy.z.toFixed(2), col:(gy.col||0xbfe8ff) });   // a542 — hard freeze VFX cue
            if (gy.petrify) send(ws, { type:'sv_player_fx', zone:gy.zone, eff:'petrify' });   // a545 — Inquisitor's gaze of stone
          }
        });
      } else keepG.push(gy);
    }
    game._sdGeyser = keepG;
  }
  // a146 — World boss AI tick (one per game, independent of zone enemy loop)
  tickWorldBoss(game);
}

// a527 — Sunken Sands mobs that run bespoke server AI (skip the generic chase/melee).
const SD_BESPOKE = { sand_scorpion:1, desert_snake:1, dune_skeleton:1, sand_mummy:1, sand_worm:1 };
// a529 — XU PATROL bespoke AI (zone-gated: these types also live in other zones,
//   so their patrol kit only runs when zoneName==='patrol'). PM_PWR = damage dials.
const PATROL_BESPOKE = { xu_rebel:1, bandit:1, bandit_archer:1, sniper:1, wraith:1, xu_scout:1, xu_siege_bot:1, xu_commander:1 };
// a531 — VOID WASTES bespoke AI (zone-gated to 'void'; 'wraith' is shared with other zones).
const VW_BESPOKE = { void_stalker:1, void_eye:1, void_phantom:1, void_sentinel:1, void_construct:1, void_spike_horror:1, wraith:1 };
// a535 — BLOOMING WILDS bespoke AI (zone-gated to 'blooming_wilds'). Tier 2, lvl 10-25.
const BW_BESPOKE = { bloom_sprite:1, glimmer_fairy:1, mushroom_brute:1, pollen_wraith:1, thorn_knight:1, vine_stalker:1 };
const BW_PWR = { bloom_sprite:36, glimmer_fairy:38, mushroom_brute:50, pollen_wraith:40, thorn_knight:58, vine_stalker:44 };
// a537 — AVIA CANYON cyber-birds (zone-gated to 'aviacanyon'). They scale straight off
//   e.atk like the client kit (no player-HP term), so the server can mirror the damage 1:1.
const AV_BESPOKE = { skyscout:1, beakdrone:1, wingguard:1, spiraldive:1 };
// a538 — XU CEMETERY necro AI (zone-gated to 'cemetery' — wraith/skeleton_warrior/bone_mage/
//   grave_crawler also live in patrol, void and mirrored, so the gate is mandatory).
//   The client's _cmDmg adds player-maxHP and player-DEF terms the server can't see; we use
//   the same flat _CM_PWR floor it falls back to, so damage stays faithful and level-correct.
const CM_BESPOKE = { skeleton_warrior:1, bone_mage:1, grave_crawler:1, death_knight:1, wraith:1 };
// a539 — THE ASHLANDS fire/volcanic AI (zone-gated to 'ashlands' — berserker/ash_wraith/
//   lava_golem/magma_crab also appear in other zones, so the gate is mandatory). As with the
//   cemetery, the client's _alDmg adds player-maxHP and player-DEF terms the server can't see;
//   we use the same flat _AL_PWR floor it falls back to. Burn DoT rides the spine's status field.
const AL_BESPOKE = { ash_wraith:1, berserker:1, lava_golem:1, magma_crab:1 };
// a540 — CAVES OF DESPAIR mine AI (zone-gated to 'caves_of_despair'). HP intentionally
//   UNCHANGED here (the client kit applies no bump). Same flat-PWR damage mirror as the
//   cemetery/ashlands: the client's _cdDmg adds player-maxHP/DEF terms the server can't see.
const CD_BESPOKE = { xu_miner:1, xu_overseer:1, blast_sapper:1, crystal_lurker:1 };
// a541 — XU CITADEL Dominion-tech AI (zone-gated to 'citadel' — iron_guard/citadel_mage/
//   xu_sniper_elite also appear in dragonlair/mirrored, so the gate is mandatory).
//   The client kit bumps HP x1.6 AND ATK x1.5 zone-locally; HP goes through ZONE_HP_MULT and
//   the ATK bump is folded into CT_PWR below (these PWR values are already the x1.5 figures'
//   base — the client's _ctDmg uses the same flat floor plus player-maxHP/DEF terms the
//   server can't see, so we mirror the floor and apply the 1.5 multiplier explicitly).
const CT_BESPOKE = { iron_guard:1, citadel_mage:1, xu_sniper_elite:1, xu_shieldbot:1, xu_commander_elite:1 };
// a542 — FROSTVEIL TUNDRA ice AI (zone-gated to 'frostveil' — all four types also appear in
//   the mirrored zone, so the gate is mandatory). The client kit bumps HP x6.0 (a474 doubled
//   it from 3.0) AND ATK x2.2 zone-locally: HP rides ZONE_HP_MULT, the ATK bump is folded in
//   below. Same flat-PWR mirror as the other zones (client _fzDmg adds maxHP/DEF terms).
const FZ_BESPOKE = { ice_golem:1, polar_bear:1, frost_wraith:1, frost_specter:1 };
// a543 — ANCIENT REALM arcane AI (zone-gated to 'ancient'). NOTE void_stalker also lives in
//   the (already migrated) Void Wastes with a completely different kit — the zone gate is what
//   keeps the two apart, so never drop it. Client bumps HP x7.0 AND ATK x2.2 zone-locally.
const ELD_BESPOKE = { ancient_guardian:1, stone_sentinel:1, vine_horror:1, void_stalker:1 };
// a544 — NECROPOLIS plague/death AI (zone-gated to 'necropolis'). NO HP or ATK multiplier here:
//   these four are already E13-huge in ENEMY_STATS with baked dmgReduction (0.28-0.45), which
//   the client kit deliberately leaves alone. Damage mirrors the client's flat _NP_PWR floor.
const NP_BESPOKE = { necro_abomination:1, necro_lich_mage:1, necro_specter:1, necro_wight:1 };
// a545 — VEILED SANCTUARY ritual AI (zone-gated to 'veiled_sanctuary'). Eight types, the
//   largest roster yet, two of them elites. NO HP/ATK multiplier: like the necropolis these are
//   already huge in ENEMY_STATS with baked dmgReduction, and the client kit leaves them alone.
const VS_BESPOKE = { veiled_acolyte:1, censer_bearer:1, penitent_striker:1, choir_wraith:1, stone_inquisitor:1, ritual_guardian:1, veiled_cardinal:1, forsaken_abbot:1 };
// a546 — VAELTHARAX'S LAIR volcanic AI (zone-gated to 'dragonlair'). Only these FOUR types get
//   the bespoke kit — the lair also spawns generic guardians/mages/iron guards which keep their
//   existing generic AI, exactly as the client kit does. HP unchanged (already E-raid scale).
const DL_BESPOKE = { fire_demon:1, wyvern:1, void_spider:1, inferno_golem:1 };
// a547 — RIFT VALE void/rift AI (zone-gated to 'riftvale'). CRITICAL: rift_stalker and
//   rift_weaver ALSO live in void_citadel (not yet migrated) — the zone gate is what keeps
//   this kit out of that zone. Client bumps HP x1.5 AND ATK x1.5 zone-locally.
// a548 — WYVERN WASTES pack AI (zone-gated to 'wyvernwastes'; all three types also appear
//   in 'mirrored', which is NOT migrated, so the gate is mandatory). The client's _wwDmg
//   adds player-maxHP and player-DEF terms the server can't see, so we mirror the flat
//   _WW_PWR floor it falls back to. No zone-local ATK multiplier in this kit (the pack
//   surge _pk scales SPEED only, never damage) — so no extra factor is folded in here.
// a549 — NEON HOLLOW dead-city machine AI (zone-gated to 'neon_hollow'; every type also
//   appears in 'mirrored', which is NOT migrated, so the gate is mandatory). Same flat-PWR
//   mirror as the other migrated zones: the client's _nhDmg adds player-maxHP and DEF
//   terms the server can't see, so we use the _NH_PWR floor it falls back to.
//   ANOMALY TAG is the zone mechanic and it lives on the PLAYER, not the mob: a completed
//   scan or a railgun hit brands that player for 6s, during which every machine deals +15%
//   and sentinel drones fire faster. The client tracked this in a single global; the server
//   tracks it per player, so branding one party member no longer buffs the city against
//   everyone standing next to them.
// a550 — XERON orbital-citadel garrison (zone-gated to 'xeron'; these six types are
//   exclusive to this zone, but the gate stays for consistency and for pooled contexts).
//   The garrison bends spacetime: time rewind, singularity grenades, constellation
//   volleys, wormhole relays, event horizons, time dilation and stasis locks. Several
//   of those are MULTI-TICK stateful effects rather than instant hits, so they're driven
//   by state machines on the mob rather than the fire-and-forget geyser spine.
//   Same flat-PWR mirror as every migrated zone (the client adds maxHP/DEF terms the
//   server can't see). This is the hottest PWR table in the game (290-355, E-infinity).
// a551 — XUMEN capital guard (zone-gated to 'xumen'; three of the four types also appear
//   in 'mirrored', which is NOT migrated, so the gate is mandatory).
//   This zone is the first with DEFENSIVE abilities that change dmgReduction: the titan's
//   ARMOR LOCK below 40% HP and the supreme's AEGIS PROJECTOR. The server resolves every
//   player hit through e.dmgReduction, and those buffs were previously applied only to the
//   client's own copy of the mob — so in multiplayer the shield bubble appeared but the
//   damage reduction never actually happened. Owning them here makes them real.
// a552 — XUMEN FORTRESS garrison (zone-gated to 'xumen_fortress'; every type also appears
//   in 'mirrored', which is NOT migrated, so the gate is mandatory).
//   Two structural firsts for the migration here:
//     KILLZONE LINK is mob-to-mob — two live drones tether a lethal beam BETWEEN
//     THEMSELVES and scissor around you. Nothing migrated so far has coupled two mobs
//     into one shared hazard, and it only works if both ends agree on the pairing, which
//     is exactly what a single server tick can guarantee and two clients cannot.
//     SENTRY PYLONS outlive the warlord that dropped them, so they can't live on the mob.
//     They're held on the ZONE and ticked independently — see _xfTickPylons.
// a553 — VOID CITADEL unreality garrison (zone-gated to 'void_citadel'). The citadel's
//   tricks all use YOU as the raw material: reflections through the construct, a gaze
//   that darkens the screen, a step that arrives mirrored through you, and a swap that
//   simply puts you somewhere else.
//   EVERY type here is shared with an ALREADY-MIGRATED zone (void_construct and
//   void_sentinel with Void Wastes, rift_stalker and rift_weaver with Rift Vale, where
//   the latter two are already in RV_BESPOKE). The zone gate is not a formality here —
//   without it this block would fight riftvale's for the same two types.
// a554 — LUCIDWILDE dreaming canopy (zone-gated to 'lucidwilde'; all three types are
//   exclusive to it, but the gate stays for consistency).
//   Unlike every other migrated zone, this kit computes damage straight from e.atk
//   rather than a bespoke PWR table with a player-maxHP term — so there is no flat-PWR
//   approximation here. Server damage matches what the client dealt, exactly.
//   Aggro floor is 28 (not the 24 the Xu zones use) with a 46-unit leash: the canopy is
//   meant to engage you from across the clearing and not let go.
// a555 — THE FORGE foundry (zone-gated to 'forge'; all four types exclusive to it).
//   This zone leans harder on PERSISTENT ZONE ENTITIES than any other: lava puddles that
//   linger and burn, deployed turrets, falling meteors and homing salvage drones. Like the
//   Fortress sentry pylons (a552) these outlive whoever made them, so they live on the
//   zone and tick independently — one list with a `kind` tag rather than four parallel
//   arrays, since they share a lifetime/expiry shape.
//   Damage is e.atk-based, as in Lucidwilde, so there's no flat-PWR approximation here.
const FG_BESPOKE = { molten_crawler:1, lava_forged_sentinel:1, forge_technician:1, industrial_devastator:1 };
const _FG_LAVA=0xff3200, _FG_HOT=0xff6a26, _FG_CYAN=0x32d8ff, _FG_EMBER=0xff7a1e;

function _fgSpawnEnt(game, zoneName, zone, ent){
  if (!zone._fgEnt) zone._fgEnt = [];
  if (zone._fgEnt.length >= 48) return null;          // sanity cap on a busy foundry floor
  zone._fgEntId = (zone._fgEntId || 0) + 1;
  ent.eid = zone._fgEntId; ent.t = 0;
  zone._fgEnt.push(ent);
  return ent;
}

function _fgTickEntities(game, zoneName, zone){
  const list = zone._fgEnt;
  if (!list || list.length === 0) return;
  const zonePlayers = getPlayersInZone(game.id, zoneName);
  const hitP = (ws, dmg, x, z) => send(ws, { type:'sv_enemy_attack', eid:-3, dmg:dmg,
    ex:+x.toFixed(2), ez:+z.toFixed(2), zone:zoneName });

  for (let i = list.length - 1; i >= 0; i--) {
    const h = list[i];
    h.t++; h.life--;
    if (h.cd > 0) h.cd--;

    if (h.kind === 'puddle') {
      // molten pool — burns anything standing in it, on its own re-tick
      if (h.cd <= 0) {
        let struck = false;
        players.forEach((p, ws) => {
          if (p.gameId !== game.id || p.zone !== zoneName || p.x === undefined) return;
          const dx = p.x - h.x, dz = p.z - h.z;
          if (dx*dx + dz*dz < h.r*h.r) { hitP(ws, h.dmg, h.x, h.z); struck = true; }
        });
        if (struck) h.cd = 3;                          // 18 frames
      }

    } else if (h.kind === 'turret') {
      if (h.cd <= 0 && zonePlayers.length) {
        let np = null, nd = Infinity;
        zonePlayers.forEach(p => { if (p.x === undefined) return;
          const dx = p.x - h.x, dz = p.z - h.z, d = Math.sqrt(dx*dx + dz*dz);
          if (d < nd) { nd = d; np = p; } });
        if (np && nd < 22 && nd > 1) {
          h.cd = 8;                                    // 46 frames
          _sdSpawnProj(game, zoneName, { id:-3, x:h.x, z:h.z },
            Math.atan2(np.x - h.x, np.z - h.z), _FG_CYAN, h.dmg, 'bolt', null, 0);
        }
      }

    } else if (h.kind === 'meteor') {
      if (h.t >= h.fall) {
        broadcastToZone(game.id, zoneName, { type:'sv_fx', vt:'fg_meteor_hit', zone:zoneName,
          ex:+h.x.toFixed(2), ez:+h.z.toFixed(2), r:h.r });
        players.forEach((p, ws) => {
          if (p.gameId !== game.id || p.zone !== zoneName || p.x === undefined) return;
          const dx = p.x - h.x, dz = p.z - h.z;
          if (dx*dx + dz*dz < h.r*h.r) hitP(ws, h.dmg, h.x, h.z);
        });
        list.splice(i, 1); continue;
      }

    } else if (h.kind === 'drone') {
      // salvage drone — homes in, then detonates on contact or when it runs dry
      let np = null, nd = Infinity;
      zonePlayers.forEach(p => { if (p.x === undefined) return;
        const dx = p.x - h.x, dz = p.z - h.z, d = Math.sqrt(dx*dx + dz*dz);
        if (d < nd) { nd = d; np = p; } });
      if (np && nd > 0.1) { h.x += ((np.x - h.x)/nd) * 0.96; h.z += ((np.z - h.z)/nd) * 0.96; }
      if (h.armed > 0) h.armed--;
      broadcastToZone(game.id, zoneName, { type:'sv_fx', vt:'fg_drone_move', zone:zoneName,
        did:h.eid, ex:+h.x.toFixed(2), ez:+h.z.toFixed(2) });
      if ((nd < 2.2 && h.armed <= 0) || h.life <= 0) {
        broadcastToZone(game.id, zoneName, { type:'sv_fx', vt:'fg_drone_boom', zone:zoneName,
          did:h.eid, ex:+h.x.toFixed(2), ez:+h.z.toFixed(2) });
        players.forEach((p, ws) => {
          if (p.gameId !== game.id || p.zone !== zoneName || p.x === undefined) return;
          const dx = p.x - h.x, dz = p.z - h.z;
          if (dx*dx + dz*dz < 3.4*3.4) hitP(ws, h.dmg, h.x, h.z);
        });
        list.splice(i, 1); continue;
      }
    }

    if (h.life <= 0) {
      broadcastToZone(game.id, zoneName, { type:'sv_fx', vt:'fg_ent_end', zone:zoneName, did:h.eid, kind:h.kind });
      list.splice(i, 1);
    }
  }
}
const LW_BESPOKE = { prismaraptor:1, sporegon:1, vortexwisp:1 };
const _LW_PRISM = [0xff3cf0,0xc94dff,0x6b7bff,0x39e6ff,0x4dffb0,0xfff04d,0xff8a3c];
function _lwCol(off){ const L=_LW_PRISM.length; return _LW_PRISM[((Math.floor(Date.now()*0.006)+(off|0))%L+L)%L]; }
const VC_BESPOKE = { void_construct:1, void_sentinel:1, rift_stalker:1, rift_weaver:1 };
const VC_PWR = { void_construct:230, void_sentinel:240, rift_stalker:245, rift_weaver:250 };
function _vcDmgS(e, mult){ return Math.floor((VC_PWR[e.type] || e.atk || 235) * mult); }
const _VC_NULL=0x0a0016, _VC_EDGE=0xb44dff, _VC_CRIM=0xff2050, _VC_PALE=0xcfc8ff;
const XF_BESPOKE = { xf_fortress_drone:1, xf_siege_walker:1, xf_warlord:1, xf_titan_elite:1 };
const XF_PWR = { xf_fortress_drone:285, xf_siege_walker:315, xf_warlord:320, xf_titan_elite:335 };
function _xfDmgS(e, mult){ return Math.floor((XF_PWR[e.type] || e.atk || 300) * mult); }
const _XF_CYAN=0x00ffff, _XF_RED=0xff2233, _XF_GOLD=0xffc832, _XF_LIME=0x9dff00;

// Autonomous sentry pylons. Held on the zone rather than the owner, because the client
// kit deliberately lets them outlive the warlord that deployed them.
function _xfTickPylons(game, zoneName, zone){
  const list = zone._xfPylons;
  if (!list || list.length === 0) return;
  const zonePlayers = getPlayersInZone(game.id, zoneName);
  for (let i = list.length - 1; i >= 0; i--) {
    const py = list[i];
    py.t++;
    if (py.t >= py.life) {
      broadcastToZone(game.id, zoneName, { type:'sv_fx', vt:'xf_pylon_end', zone:zoneName, pid:py.pid });
      list.splice(i, 1);
      continue;
    }
    if (py.t % 9 !== 0 || zonePlayers.length === 0) continue;
    let np = null, nd = Infinity;
    zonePlayers.forEach(p => { if (p.x === undefined) return;
      const dx = p.x - py.x, dz = p.z - py.z, d = Math.sqrt(dx*dx + dz*dz);
      if (d < nd) { nd = d; np = p; } });
    if (np && nd < 14 && nd > 1) {
      const a = Math.atan2(np.x - py.x, np.z - py.z);
      _sdSpawnProj(game, zoneName, { id:-2, x:py.x, z:py.z }, a, _XF_LIME, py.dmg, 'bolt', null, 0);
    }
  }
}
const XM_BESPOKE = { xu_enforcer:1, xu_titan:1, xu_annihilator:1, xu_supreme:1 };
const XM_PWR = { xu_enforcer:265, xu_titan:300, xu_annihilator:285, xu_supreme:330 };
function _xmDmgS(e, mult){ return Math.floor((XM_PWR[e.type] || e.atk || 280) * mult); }
const _XM_CYAN=0x22e8ff, _XM_GOLD=0xffd24a, _XM_VIOLET=0x9944ff, _XM_RED=0xff3355, _XM_WHITE=0xffffff;
const XR_BESPOKE = { corrupted_xu:1, void_marine:1, holo_wraith:1, laser_turret:1, cyber_ogre:1, shard_assassin:1 };
const XR_PWR = { corrupted_xu:300, holo_wraith:290, void_marine:320, laser_turret:330, shard_assassin:340, cyber_ogre:355 };
function _xrDmgS(e, mult){ return Math.floor((XR_PWR[e.type] || e.atk || 310) * mult); }
const _XR_STAR=0xfff6c8, _XR_CYAN=0x30e0ff, _XR_PURPLE=0x8a30ff, _XR_PINK=0xff40c8, _XR_WHITE=0xffffff;
const NH_BESPOKE = { sentinel_drone:1, maintenance_striker:1, hollow_enforcer:1, neon_wraith:1, skybridge_sniper:1, crash_car:1 };
const NH_PWR = { sentinel_drone:240, maintenance_striker:260, hollow_enforcer:280, neon_wraith:250, skybridge_sniper:300, crash_car:270 };
const NH_TAG_MS = 6000;
function _nhIsTagged(p){ return !!(p && p._nhTagUntil && Date.now() < p._nhTagUntil); }
function _nhDmgS(e, mult, tgt){
  let base = (NH_PWR[e.type] || e.atk || 250);
  if (_nhIsTagged(tgt)) base *= 1.15;   // the city hits harder while it can see you
  return Math.floor(base * mult);
}
// Brand a player as an anomaly and tell their client, so the local HUD//damage model agrees.
function _nhTag(game, zoneName, tgt){
  if (!tgt) return;
  tgt._nhTagUntil = Date.now() + NH_TAG_MS;
  players.forEach((p, ws) => { if (p === tgt)
    send(ws, { type:'sv_player_fx', zone:zoneName, eff:'nh_tag', ms:NH_TAG_MS }); });
}
const _NH_MAG=0xff3cff, _NH_CYN=0x00e0ff, _NH_CHROME=0xdfe8f0, _NH_AMBER=0xffa000, _NH_WHITE=0xffffff;
const WW_BESPOKE = { wyvern_warlord:1, deep_wyrm:1, elder_dragon:1 };
const WW_PWR = { wyvern_warlord:250, deep_wyrm:240, elder_dragon:265 };
function _wwDmgS(e, mult){ return Math.floor((WW_PWR[e.type] || e.atk || 240) * mult); }
const _WW_FIRE=0xff5500, _WW_EMBER=0xff8830, _WW_ICE=0x80c8ff, _WW_FROST=0xd8ecff, _WW_VENOM=0x88cc00, _WW_EARTH=0xaa6600;
const RV_BESPOKE = { void_colossus:1, rift_stalker:1, psyche_horror:1, rift_weaver:1 };
const RV_PWR = { void_colossus:220, rift_stalker:170, psyche_horror:160, rift_weaver:150 };
function _rvDmgS(e, mult){ return Math.floor((RV_PWR[e.type] || e.atk || 150) * 1.5 * mult); }
const DL_PWR = { void_spider:250, wyvern:270, fire_demon:295, inferno_golem:330 };
function _dlDmgS(e, mult){ return Math.floor((DL_PWR[e.type] || e.atk || 275) * mult); }
const VS_PWR = { veiled_acolyte:185, censer_bearer:205, penitent_striker:215, choir_wraith:195, stone_inquisitor:235, ritual_guardian:220, veiled_cardinal:290, forsaken_abbot:320 };
function _vsDmgS(e, mult){ return Math.floor((VS_PWR[e.type] || e.atk || 200) * mult); }
const NP_PWR = { necro_abomination:240, necro_wight:190, necro_lich_mage:200, necro_specter:170 };
function _npDmgS(e, mult){ return Math.floor((NP_PWR[e.type] || e.atk || 180) * mult); }
const ELD_PWR = { ancient_guardian:170, stone_sentinel:160, vine_horror:130, void_stalker:120 };
function _eldDmgS(e, mult){ return Math.floor((ELD_PWR[e.type] || e.atk || 120) * 2.2 * mult); }
const FZ_PWR = { ice_golem:140, polar_bear:120, frost_wraith:100, frost_specter:95 };
function _fzDmgS(e, mult){ return Math.floor((FZ_PWR[e.type] || e.atk || 90) * 2.2 * mult); }
const CT_PWR = { iron_guard:80, citadel_mage:78, xu_sniper_elite:85, xu_shieldbot:72, xu_commander_elite:95 };
function _ctDmgS(e, mult){ return Math.floor((CT_PWR[e.type] || e.atk || 60) * 1.5 * mult); }
const CD_PWR = { xu_miner:78, xu_overseer:92, blast_sapper:88, crystal_lurker:105 };
function _cdDmgS(e, mult){ return Math.floor((CD_PWR[e.type] || e.atk || 85) * mult); }
const AL_PWR = { ash_wraith:46, berserker:54, lava_golem:58, magma_crab:60 };
function _alDmgS(e, mult){ return Math.floor((AL_PWR[e.type] || e.atk || 40) * mult); }
const CM_PWR = { skeleton_warrior:48, bone_mage:46, grave_crawler:44, death_knight:62, wraith:40 };
function _cmDmgS(e, mult){ return Math.floor((CM_PWR[e.type] || e.atk || 36) * mult); }
function _avDmg(e, mult){ return Math.floor((e.atk || 100) * mult); }
function _bwDmg(e, mult){ return Math.floor((BW_PWR[e.type] || e.atk || 32) * mult); }
const VW_PWR = { void_stalker:42, void_eye:40, void_phantom:48, void_sentinel:60, void_construct:54, void_spike_horror:56, wraith:38 };
function _vwDmg(e, mult){ return Math.floor((VW_PWR[e.type] || e.atk || 36) * mult); }
const PM_PWR = { xu_rebel:38, bandit:40, bandit_archer:34, sniper:36, wraith:38, xu_scout:34, xu_siege_bot:52, xu_commander:50 };
function _pmDmg(e, mult){ return Math.floor((PM_PWR[e.type] || e.atk || 30) * mult); }
// a527 — spawn a server-owned SD projectile (server resolves the hit; client renders the flyer).
// a529 — telegraphed ground strike (recon ping / mortar / airstrike): warning ring now, AoE later.
function _pmTelegraph(game, zoneName, e, tx, tz, fuseTicks, radius, dmg, col){
  if(!game._sdGeyser) game._sdGeyser = [];
  game._sdGeyser.push({ zone:zoneName, x:tx, z:tz, fuse:fuseTicks, dmg:dmg, eid:e.id, col:col, radius:radius });
  broadcastToZone(game.id, zoneName, { type:'sv_fx', vt:'sd_geyser_warn', zone:zoneName, ex:+tx.toFixed(2), ez:+tz.toFixed(2), col:col });
}
// a529 — instant shockwave + AoE (shock stomp / spectral wail / lunge impact).
function _pmShock(game, zoneName, e, cx, cz, radius, dmg, col, players, send, slow, slowDur){
  broadcastToZone(game.id, zoneName, { type:'sv_fx', vt:'sd_shock', zone:zoneName, ex:+cx.toFixed(2), ez:+cz.toFixed(2), col:col, r:radius });
  if(dmg>0){ players.forEach((p, ws)=>{ if(p.gameId!==game.id || p.zone!==zoneName || p.x===undefined) return;
    const ddx=p.x-cx, ddz=p.z-cz; if(ddx*ddx+ddz*ddz < radius*radius){
      send(ws, { type:'sv_enemy_attack', eid:e.id, dmg:dmg, ex:+cx.toFixed(2), ez:+cz.toFixed(2), zone:zoneName });
      if(slow) send(ws, { type:'sv_player_fx', zone:zoneName, eff:'slow', slow:slow, root:(slowDur||1200) });
    } }); }
}
function _sdSpawnProj(game, zoneName, e, ang, col, dmg, kind, status, statusDur){
  if(!game._sdProj) game._sdProj = [];
  game._sdProj.push({ zone:zoneName, x:e.x, z:e.z, vx:Math.sin(ang)*1.4, vz:Math.cos(ang)*1.4, dmg:dmg, status:status||null, statusDur:statusDur||0, life:10, eid:e.id });
  broadcastToZone(game.id, zoneName, { type:'sv_fx', vt:'sd_proj', zone:zoneName, ex:+e.x.toFixed(2), ez:+e.z.toFixed(2), ang:+ang.toFixed(3), col:col, kind:kind });
}

// Full snapshot for a player entering a zone
function sendZoneSnapshot(ws, game, zoneName) {
  const zone = getOrCreateZone(game, zoneName);
  const ids=[], xs=[], zs=[], hps=[], maxhps=[], types=[], acts=[];
  zone.enemies.forEach(e => {
    ids.push(e.id);
    xs.push(+e.x.toFixed(2));
    zs.push(+e.z.toFixed(2));
    hps.push(e.hp);
    maxhps.push(e.maxHp);
    types.push(e.type);
    acts.push(e.active ? 1 : 0);
  });
  const activeCount = acts.filter(a=>a===1).length;
  console.log(`[sendZoneSnapshot] zone=${zoneName} total=${ids.length} active=${activeCount}`);
  send(ws, { type:'sv_zone_snapshot', zone:zoneName, ids, xs, zs, hps, maxhps, types, acts });
  // a146 — also send the active world boss state if one is alive in this zone
  if (game.worldBoss && game.worldBoss.spawned && game.worldBoss.zone === zoneName) {
    const wb = game.worldBoss;
    send(ws, {
      type: 'sv_worldboss_snapshot',
      id: wb.id,
      name: wb.name,
      zone: wb.zone,
      x: +wb.x.toFixed(2),
      z: +wb.z.toFixed(2),
      hp: wb.hp,
      maxHp: wb.maxHp,
      phase: wb.phase,
      color: wb.color,
      lootTier: wb.lootTier,
    });
  }
}

// ══════════════════════════════════════════════════════════
// GLOBAL GAME LOOP — 10Hz
// ══════════════════════════════════════════════════════════
setInterval(() => {
  games.forEach(game => {
    // Tick as soon as a game exists — zones are pre-populated, enemies need ticking from start
    if (game.players.length > 0) tickGame(game);
  });
}, 100);

// ══════════════════════════════════════════════════════════
// LOBBY HELPERS (unchanged from original)
// ══════════════════════════════════════════════════════════

function broadcast(data, exclude=null){
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if(client !== exclude && client.readyState === 1) client.send(msg);
  });
}
function getPlayerNames(){ return [...players.values()].filter(p=>p.name).map(p=>p.name); }
// v93.0-a66 — richer payload: {name, level, cls, raceName} per player.
// Defaults are sane for clients who haven't sent the new fields yet (old client).
function getPlayerSummary(){
  return [...players.values()].filter(p=>p.name).map(p=>({
    name: p.name,
    level: (typeof p.level === 'number') ? p.level : 1,
    cls: p.cls || 'Warrior',
    raceName: p.raceName || 'Xu',
    asc: (typeof p.asc === 'number') ? p.asc : 0,   // v93.0-a256 — ascendancy level
    guildTag: _serverGuildTag(p.name)               // v93.0-a258 — live, server-authoritative (was p.guildTag, always null)
  }));
}
function broadcastPlayerList(){ broadcast({ type:'player_list', players:getPlayerSummary() }); }
function sendGameList(ws){
  const list = [...games.values()].map(g => ({
    id:g.id, name:g.name, host:g.host, hostPeer:g.hostPeer,
    zone:g.zone, players:g.players.length, max:g.maxPlayers, hasPass:!!g.password
  }));
  send(ws, { type:'game_list', games:list });
}
function broadcastGameList(){ broadcast({ type:'game_list_update' }); }

function removePlayer(ws){
  const player = players.get(ws);
  if(!player) return;
  if(player.gameId){
    const g = games.get(player.gameId);
    if(g){
      g.players = g.players.filter(n => n !== player.name);
      // If the host disconnected, delete the game entirely
      if(g.host === player.name){
        games.delete(player.gameId);
        broadcast({ type:'lobby_chat', name:'SERVER',
          msg:g.name+' ended (host disconnected).', system:true });
      } else if(g.players.length === 0){
        // Last player left — clean it up
        games.delete(player.gameId);
      }
      broadcastGameList();
    }
    player.gameId = null;
  }
  if(player.name){
    broadcast({ type:'lobby_chat', name:'SERVER', msg:player.name+' left the lobby.', system:true });
  }
  players.delete(ws);
  broadcast({ type:'player_count', count:players.size });
  broadcastPlayerList();
}

// ══════════════════════════════════════════════════════════
// WEBSOCKET
// ══════════════════════════════════════════════════════════

setInterval(()=>{
  wss.clients.forEach(ws=>{
    if(ws.isAlive === false){ removePlayer(ws); return ws.terminate(); }
    ws.isAlive = false; ws.ping();
  });
}, 20000);

wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', ()=>{ ws.isAlive = true; });
  players.set(ws, { name:'', gameId:null, zone:null, x:undefined, z:undefined });

  ws.on('message', raw => {
    ws.isAlive = true;
    // a481 — SERVER-2: per-connection rate limit. Token bucket, ~30 msg/sec with a
    //   burst allowance of 60. Prevents a single client from flooding the handler
    //   (and, via sv_cloud_save, hammering disk writes). Legitimate play sends a
    //   handful of messages per second; state updates are the most frequent and sit
    //   well under this. Over-budget messages are silently dropped.
    {
      const _now = Date.now();
      if (ws._rlTokens === undefined) { ws._rlTokens = 60; ws._rlLast = _now; }
      ws._rlTokens = Math.min(60, ws._rlTokens + (_now - ws._rlLast) * (30 / 1000));
      ws._rlLast = _now;
      if (ws._rlTokens < 1) return;   // over budget — drop
      ws._rlTokens -= 1;
    }
    let data;
    try { data = JSON.parse(raw); } catch { return; }
    const player = players.get(ws);

    switch(data.type){

      // ── LOBBY ──────────────────────────────────────────
      case 'login':
        player.name = (data.name||'').slice(0,20).replace(/[<>]/g,'') || 'Adventurer';
        // v93.0-a66 — capture level/class/race for the player list display.
        // Sanitize: clamp level, strip dangerous chars from strings, length-limit.
        {
          const _lv = parseInt(data.level, 10);
          player.level = (isFinite(_lv) && _lv >= 1 && _lv <= 200) ? _lv : 1;
          player.cls = (typeof data.cls === 'string' ? data.cls : 'Warrior')
                        .slice(0,16).replace(/[<>&"']/g,'') || 'Warrior';
          player.raceId = (typeof data.raceId === 'string' ? data.raceId : 'xu')
                          .slice(0,16).replace(/[^a-z_]/g,'') || 'xu';
          player.raceName = (typeof data.raceName === 'string' ? data.raceName : 'Xu')
                            .slice(0,16).replace(/[<>&"']/g,'') || 'Xu';
          // v93.0-a256 — ascendancy level for the player list. Clamp to a sane range.
          const _asc = parseInt(data.asc, 10);
          player.asc = (isFinite(_asc) && _asc >= 0 && _asc <= 99999) ? _asc : 0;
          // v93.0-a258 — guild tag is resolved server-side from our persisted guild
          // registry (see getPlayerSummary → _serverGuildTag). We intentionally do NOT
          // trust data.guildTag: the client's myGuild isn't populated until the server
          // sends guild_info (later in this handler), so at login it was always null.
        }
        send(ws, { type:'logged_in', name:player.name });
        sendGameList(ws);
        send(ws, { type:'player_count', count:players.size });
        send(ws, { type:'player_list', players:getPlayerSummary() });
        broadcast({ type:'lobby_chat', name:'SERVER', msg:player.name+' entered the lobby.', system:true }, ws);
        broadcast({ type:'player_count', count:players.size });
        broadcastPlayerList();
        // Send guild info (if any)
        {
          const _g = findPlayerGuild(player.name);
          send(ws, {type:'guild_info', guildId:_g?_g.id:null, guild:_g?_g.guild:null});
        }
        break;

      case 'lobby_chat':
        if(!player.name) break;
        const msg = (data.msg||'').slice(0,200).replace(/[<>]/g,'');
        if(!msg) break;
        broadcast({ type:'lobby_chat', name:player.name, msg });
        break;

      case 'request_player_list':
        send(ws, { type:'player_list', players:getPlayerSummary() });
        break;

      // ── CLOUD SAVES ────────────────────────────────────
      case 'sv_cloud_save': {
        // Client is uploading a save — store it
        if (!data.name || !data.raceId || !data.cls || !data.saveData) break;
        const name = data.name.slice(0,20).replace(/[^a-zA-Z0-9_\- ]/g,'');
        if (!name) break;
        const key = getSaveKey(name, data.raceId, data.cls);
        const incoming = data.saveData;
        // a481 — SERVER-2: per-save size cap. maxPayload already bounds the frame,
        //   but cap the stored blob too so no single save can bloat the file.
        if (JSON.stringify(incoming).length > 200 * 1024) {
          send(ws, { type:'sv_cloud_save_ok', key, skipped:true, error:'save_too_large' });
          break;
        }
        // a481 — SERVER-1: ownership. The client sends a locally-generated token.
        //   If this key has no owner yet (new save, or a legacy pre-token save), the
        //   presenting token CLAIMS it. If it's already owned, the token must match
        //   or we refuse — this is what stops someone overwriting/griefing a save
        //   they don't own just by knowing the character name.
        const token = _validToken(data.token) ? data.token : null;
        const owner = saveOwners[key];
        if (owner) {
          if (!token || token !== owner) {
            send(ws, { type:'sv_cloud_save_denied', key, reason:'not_owner' });
            console.log(`[saves] DENIED overwrite of owned key ${key} (token mismatch)`);
            break;
          }
        } else if (token) {
          saveOwners[key] = token;   // claim
          console.log(`[saves] Key ${key} claimed by presenting token.`);
        }
        const existing = cloudSaves[key];
        // Only overwrite if incoming is newer
        if (!existing || (incoming.ts && incoming.ts > (existing.ts||0))) {
          cloudSaves[key] = incoming;
          flushSaves();
          send(ws, { type:'sv_cloud_save_ok', key, ts: incoming.ts });
          console.log(`[saves] Saved: ${key} (ts=${incoming.ts})`);
        } else {
          send(ws, { type:'sv_cloud_save_ok', key, ts: existing.ts, skipped:true });
        }
        break;
      }

      case 'sv_cloud_load': {
        // Client requesting all saves for a username
        if (!data.name) break;
        const name = data.name.slice(0,20).replace(/[^a-zA-Z0-9_\- ]/g,'');
        if (!name) break;
        // a481 — SERVER-1: ownership-gated load. A save is returned only when the
        //   requester presents its owner token, OR the save is still un-owned (in
        //   which case presenting a valid token claims it — this is how a returning
        //   legacy player, or the same player on a new device with their stored
        //   token, recovers their character). Un-owned + no token still returns the
        //   save (so first-ever load before the client has minted a token works),
        //   but that window closes permanently the moment an owner is recorded.
        const token = _validToken(data.token) ? data.token : null;
        const all = getAllSavesForUser(name);
        const saves = [];
        for (const rec of all) {
          const owner = saveOwners[rec.key];
          if (owner) {
            if (token && token === owner) saves.push(rec);   // owner — allowed
            // else: owned by someone else — silently omit (no theft)
          } else {
            if (token) saveOwners[rec.key] = token;          // claim on load
            saves.push(rec);
          }
        }
        if (Object.keys(saveOwners).length) flushSaves(); // persist any claims
        send(ws, { type:'sv_cloud_load_result', saves, name });
        console.log(`[saves] Load request for '${name}': ${saves.length}/${all.length} save(s) returned (ownership-filtered)`);
        break;
      }

      case 'sv_cloud_load_one': {
        // Client requesting a single specific save key
        if (!data.key) break;
        // a481 — SERVER-1: same ownership gate as bulk load.
        const token = _validToken(data.token) ? data.token : null;
        const owner = saveOwners[data.key];
        if (owner && (!token || token !== owner)) {
          send(ws, { type:'sv_cloud_load_one_result', key: data.key, save: null, denied:true });
          break;
        }
        if (!owner && token && cloudSaves[data.key]) { saveOwners[data.key] = token; flushSaves(); }
        const save = cloudSaves[data.key] || null;
        send(ws, { type:'sv_cloud_load_one_result', key: data.key, save });
        break;
      }

      case 'create_game': {
        if(player.gameId){
          const old = games.get(player.gameId);
          if(old && old.host===player.name) games.delete(player.gameId);
          player.gameId = null;
        }
        const gId = nextGameId++;
        const game = {
          id:gId, name:(data.name||player.name+"'s Game").slice(0,40),
          host:player.name, hostPeer:data.hostPeer,
          zone:data.zone||'XU Outpost', password:data.password||'',
          maxPlayers:Math.min(data.max||4,4), players:[player.name],
          createdAt:Date.now(),
          started: false,
          zones: {}, // pre-populated below
        };
        // Pre-initialize ALL zones immediately so enemies exist before anyone enters
        // This is the MMO-style approach: server owns all zones always
        Object.keys(ZONE_SPAWNS).forEach(zoneName => {
          game.zones[zoneName] = {
            enemies: createZoneEnemies(zoneName),
            lastActivity: Date.now(),
            boss: ZONE_BOSS_HP[zoneName] ? {
              hp: ZONE_BOSS_HP[zoneName].hp,
              maxHp: ZONE_BOSS_HP[zoneName].hp,
              phase: 1,
              spawned: false,
              name: ZONE_BOSS_HP[zoneName].name,
            } : null,
          };
        });
        games.set(gId, game);
        player.gameId = gId;
        send(ws, { type:'game_created', game });
        broadcastGameList();
        break;
      }

      case 'update_game':
        if(player.gameId){
          const ug = games.get(player.gameId);
          if(ug && ug.host===player.name){
            if(data.zone) ug.zone = data.zone.slice(0,40);
            broadcastGameList();
          }
        }
        break;

      case 'join_game': {
        const jGame = games.get(data.id);
        if(!jGame){ send(ws,{type:'join_error',msg:'Game not found.'}); break; }
        if(jGame.players.length>=jGame.maxPlayers){ send(ws,{type:'join_error',msg:'Game is full.'}); break; }
        if(jGame.password&&jGame.password!==data.password){ send(ws,{type:'join_error',msg:'Wrong password.'}); break; }
        if(!jGame.players.includes(player.name)) jGame.players.push(player.name);
        player.gameId = data.id;
        send(ws, { type:'join_success', hostPeer:jGame.hostPeer, game:jGame });
        broadcastGameList();
        break;
      }

      case 'leave_game':
        if(player.gameId){
          const lg = games.get(player.gameId);
          if(lg){
            lg.players = lg.players.filter(n => n !== player.name);
            if(data.isHost===true && lg.host===player.name){
              games.delete(player.gameId);
              broadcast({type:'lobby_chat',name:'SERVER',msg:lg.name+' ended.',system:true});
            }
            broadcastGameList();
          }
          player.gameId = null;
          player.zone   = null;
        }
        break;

      case 'request_game_list':
        sendGameList(ws);
        break;

      // ── IN-GAME: player position & zone ───────────────
      case 'sv_player_state':
        // Client sends position + current zone each tick
        player.x    = data.x;
        player.z    = data.z;
        player.zone = data.zone;
        if (player.gameId) {
          const g = games.get(player.gameId);
          if (g) g.started = true;
        }
        break;

      case 'sv_enter_zone': {
        player.zone = data.zone;
        if(!player.name && data.name) player.name = data.name.slice(0,20).replace(/[<>]/g,'');

        // Recover gameId if lost after WS reconnect
        if (!player.gameId && player.name) {
          games.forEach((g, gid) => {
            if (g.players.includes(player.name)) {
              player.gameId = gid;
              console.log(`[sv_enter_zone] Recovered gameId=${gid} for player ${player.name}`);
            }
          });
        }

        console.log(`[sv_enter_zone] player=${player.name} zone=${data.zone} gameId=${player.gameId} games=${games.size}`);

        if (!player.gameId) {
          console.log(`[sv_enter_zone] DROPPED — no gameId for ${player.name}`);
          break;
        }
        const g = games.get(player.gameId);
        if (!g) {
          console.log(`[sv_enter_zone] DROPPED — game not found for ${player.name} gameId=${player.gameId}`);
          break;
        }
        const zoneEnemyCount = g.zones[data.zone] ? g.zones[data.zone].enemies.length : 0;
        const activeCount = g.zones[data.zone] ? g.zones[data.zone].enemies.filter(e=>e.active).length : 0;
        console.log(`[sv_enter_zone] Sending snapshot: zone=${data.zone} total=${zoneEnemyCount} active=${activeCount}`);
        g.started = true;
        sendZoneSnapshot(ws, g, data.zone);
        // a233 — CO-OP: hand the entering player the authoritative run seed + depth
        //   + mods for procedural zones so they build the SAME map as everyone else
        //   and join the in-progress depth instead of resetting it.
        if (data.zone === 'convergence' || data.zone === 'the_reach') {
          const _pz = getOrCreateZone(g, data.zone);
          send(ws, buildRunState(_pz, data.zone));
        }
        broadcastToZone(g.id, data.zone, {
          type:'sv_player_entered', name:player.name, zone:data.zone
        }, ws);
        // Global announce to all players in the game
        broadcastToGame(g.id, {
          type:'sv_zone_entered_announce',
          name: player.name,
          zone: data.zone,
        }, ws);
        // Send current boss state to the entering player
        const _entBoss = g.zones[data.zone] && g.zones[data.zone].boss;
        if (_entBoss && _entBoss.spawned && _entBoss.hp > 0) {
          send(ws, {
            type:'sv_boss_state',
            zone: data.zone,
            hp: _entBoss.hp,
            maxHp: _entBoss.maxHp,
            phase: _entBoss.phase,
            bossName: _entBoss.name,
          });
        }
        break;
      }

      case 'sv_hit_enemy': {
        if (!player.gameId || !player.zone) break;
        const g = games.get(player.gameId);
        if (!g) break;
        const zone = g.zones[player.zone];
        if (!zone) break;
        const e = zone.enemies.find(en => en.id === data.id && en.active);
        if (!e) break;

        // Anti-cheat distance check — 24 units for ranged/magic, 10 for melee
        if (player.x !== undefined) {
          const dx = player.x - e.x, dz = player.z - e.z;
          const maxRange = (data.ranged || data.magic) ? 24*24 : 10*10;
          if (dx*dx + dz*dz > maxRange) break;
        }

        // Cap incoming damage to reasonable max (anti-hack)
        const cappedDmg = Math.min(data.dmg||1, 999999);
        const rawDmg = Math.max(1, Math.floor(cappedDmg * (1 - (e.dmgReduction||0))));
        e.hp -= rawDmg;

        if (e.hp <= 0) {
          e.hp = 0; e.active = false; e.aggroed = false; e.respawnTimer = 0;
          // Broadcast kill to everyone in zone — include killer so only they get loot
          broadcastToZone(g.id, player.zone, {
            type:'sv_enemy_killed',
            id:e.id, etype:e.type, zone:player.zone,
            reward:e.reward, expR:e.expR,
            ex:+e.x.toFixed(2), ez:+e.z.toFixed(2),
            killer: player.name
          });
          // Award guild XP based on enemy expR value
          awardGuildXp(player.name, Math.max(1, Math.floor((e.expR||1) / 2)));
        } else {
          // Broadcast HP update to everyone in zone
          broadcastToZone(g.id, player.zone, {
            type:'sv_enemy_hit',
            id:e.id, hp:e.hp, maxHp:e.maxHp,
            dmg:rawDmg, ex:+e.x.toFixed(2), ez:+e.z.toFixed(2)
          });
        }
        break;
      }

      // a555 — THE FURNACE CORE's WEAK POINT WINDOW. The core periodically exposes and
      //   takes 1.6x damage, but that multiplier lived only in the client's own hitBoss
      //   path — so in multiplayer the core opened, the flare played, and your damage was
      //   completely unchanged. The server resolves boss HP, so it has to own the window.
      //   Same class of defect as the a551 armour lock, inverted: a vulnerability that
      //   never actually made the boss vulnerable.
      case 'sv_hit_boss': {
        if (!player.gameId || !player.zone) break;
        const g = games.get(player.gameId);
        if (!g) break;
        const zone = g.zones[player.zone];
        if (!zone) break;
        // v93.0-a116 -- defensive: auto-init boss if missing instead of silently dropping
        // the hit. Previously a missing zone.boss caused all hits to be dropped with no
        // error, leading to "immortal boss" reports. Now we lazy-create the boss when
        // the first hit arrives, using the depth scaling that should have been applied.
        if (!zone.boss && ZONE_BOSS_HP[player.zone]) {
          console.warn(`[boss] zone.boss missing for ${player.zone} on first hit. Auto-initializing.`);
          const _curDepth = zone.convergenceDepth || 1;
          const _depthMul = player.zone === 'convergence' ? (1.0 + 0.5 * (_curDepth - 1)) : 1.0;
          const _baseHp = ZONE_BOSS_HP[player.zone].hp;
          zone.boss = {
            hp: Math.round(_baseHp * _depthMul),
            maxHp: Math.round(_baseHp * _depthMul),
            phase: 1,
            spawned: true,
            name: ZONE_BOSS_HP[player.zone].name,
          };
        }
        if (!zone.boss) break;
        const b = zone.boss;
        // v93.0-a116 -- if boss exists but isn\'t marked spawned, mark it spawned NOW.
        // This prevents the case where the boss was reset (e.g. on depth transition)
        // but the client already started attacking and the spawned flag was stale.
        if (!b.spawned) {
          // a298 — INSTANT-RESPAWN FIX. Do NOT resurrect a DEAD boss from a stray
          //   hit. A high-DPS player vs a low-HP boss (the Wildmother is 35k) lands
          //   extra hits in the network round-trip window AFTER the kill; those
          //   arrived here with spawned=false + hp<=0, the old a226 code refilled
          //   HP to full and re-broadcast a spawn -> the boss instantly respawned
          //   (free XP farm) and the 5-minute lock was bypassed. A dead boss now
          //   respawns ONLY via the timed sv_boss_respawn below. A live boss with a
          //   merely-stale spawned flag (reconnect / depth-set / 2nd player) still
          //   auto-spawns and KEEPS its current HP (the a226 heal-to-full fix holds).
          if (b.hp <= 0) break;
          console.warn(`[boss] zone.boss.spawned was false in ${player.zone} on hit; auto-spawning.`);
          b.spawned = true;
          broadcastToZone(g.id, player.zone, {
            type: 'sv_boss_spawned',
            zone: player.zone,
            bossName: b.name,
            hp: b.hp,
            maxHp: b.maxHp,
          });
        }
        if (b.hp <= 0) break;

        // Cap damage (anti-cheat)
        // a555 — THE FURNACE CORE's WEAK POINT WINDOW. The core periodically exposes and
        //   takes 1.6x damage, but that multiplier lived only in the client's own hitBoss
        //   path — so in multiplayer the core opened, the flare played, and the damage was
        //   unchanged. The server resolves boss HP, so it has to own the window. Same class
        //   of defect as the a551 armour lock, inverted: a vulnerability that never made
        //   the boss vulnerable.
        let _inDmg = data.dmg || 1;
        if (player.zone === 'forge' && b._fcWeak) _inDmg = Math.floor(_inDmg * 1.6);
        const bdmg = Math.min(_inDmg, 999999);
        b.hp = Math.max(0, b.hp - bdmg);

        // Broadcast HP update to all players in zone
        broadcastToZone(g.id, player.zone, {
          type: 'sv_boss_hp',
          zone: player.zone,
          hp: b.hp,
          maxHp: b.maxHp,
          phase: b.phase,
          dmg: bdmg,
          hitter: player.name,
        });

        // Phase transitions — broadcast to zone.
        // a555 — SKIP for any zone with a ZBOSS_SERVER config: tickZoneBoss owns the phase
        //   ladder there, and this generic .75/.50/.25/.10 one was running in ADDITION to it.
        //   The two interleaved (each advancing b.phase past the other's guard), so a
        //   migrated boss could skip a phase or overshoot its own maximum — THE FURNACE CORE
        //   has three phases and this drove it to four. Every boss migrated since a548 was
        //   sharing its ladder with this one; the config is the single source of truth now.
        const pct = b.hp / b.maxHp;
        const oldPhase = b.phase;
        if (!ZBOSS_SERVER[player.zone]) {
          if (b.phase === 1 && pct <= 0.75) b.phase = 2;
          else if (b.phase === 2 && pct <= 0.50) b.phase = 3;
          else if (b.phase === 3 && pct <= 0.25) b.phase = 4;
          else if (b.phase === 4 && pct <= 0.10) b.phase = 5;
        }
        if (b.phase !== oldPhase) {
          broadcastToZone(g.id, player.zone, {
            type: 'sv_boss_phase',
            zone: player.zone,
            phase: b.phase,
            bossName: b.name,
          });
        }

        // Boss killed
        if (b.hp <= 0) {
          b.spawned = false;
          b.hp = 0;
          // Broadcast kill to entire zone
          broadcastToZone(g.id, player.zone, {
            type: 'sv_boss_killed',
            zone: player.zone,
            bossName: b.name,
            killer: player.name,
            bx: data.bx || 0,
            bz: data.bz || 0,
          });
          // Global announce to ENTIRE game — everyone sees the kill
          broadcastToGame(g.id, {
            type: 'sv_world_announce',
            msg: `⚔ ${player.name} SLEW ${b.name} in ${player.zone.replace(/_/g,' ').toUpperCase()}!`,
            zone: player.zone,
            killer: player.name,
            bossName: b.name,
          });
          // Award large guild XP for boss kill — scales with boss HP
          awardGuildXp(player.name, Math.max(100, Math.floor((b.maxHp||1000) / 500)));
          b.killedAt = Date.now();
          // a298 — respawn after 5 minutes (was 3) to match the client's hard
          //   BOSS_RESPAWN_MS lock, so server + client agree on the cooldown.
          // Capture bossZone NOW — player.zone may change before the timer fires
          const bossZone = player.zone;
          setTimeout(() => {
            if (g && g.zones[bossZone] && g.zones[bossZone].boss) {
              const rb = g.zones[bossZone].boss;
              rb.hp = rb.maxHp;
              rb.phase = 1;
              rb.spawned = false; // will re-spawn when triggered client-side
              rb.killedAt = 0;    // a298 — clear the death stamp; cooldown is over
              broadcastToZone(g.id, bossZone, {
                type: 'sv_boss_respawn', zone: bossZone, bossName: rb.name,
              });
            }
          }, 5 * 60 * 1000);
        }
        break;
      }

      // ──────────────────────────────────────────────────────
      // a146 — WORLD BOSS HANDLERS (server-authoritative)
      // ──────────────────────────────────────────────────────
      case 'sv_worldboss_spawn': {
        // Client requests a world boss spawn (via console spawnWorldBoss() or
        //   the auto-timer that fires once enough players are online).
        if (!player.gameId) break;
        const g = games.get(player.gameId);
        if (!g) break;
        // Already one active?
        if (g.worldBoss && g.worldBoss.spawned) {
          send(ws, { type:'sv_worldboss_reject', reason:'active', activeId: g.worldBoss.id, name: g.worldBoss.name });
          break;
        }
        // Cooldown after a kill
        if (g.worldBossLastDespawnAt && (Date.now() - g.worldBossLastDespawnAt) < WORLD_BOSS_RESPAWN_MS) {
          const remain = Math.ceil((WORLD_BOSS_RESPAWN_MS - (Date.now() - g.worldBossLastDespawnAt)) / 1000);
          send(ws, { type:'sv_worldboss_reject', reason:'cooldown', remainSec: remain });
          break;
        }
        // Pick def — by id if provided, else random
        let def = null;
        if (data.bossId && WORLD_BOSS_BY_ID[data.bossId]) {
          def = WORLD_BOSS_BY_ID[data.bossId];
        } else if (typeof data.idx === 'number' && data.idx >= 0 && data.idx < WORLD_BOSS_DEFS.length) {
          def = WORLD_BOSS_DEFS[data.idx];
        } else {
          def = WORLD_BOSS_DEFS[Math.floor(Math.random() * WORLD_BOSS_DEFS.length)];
        }
        const spawned = spawnWorldBoss(g, def);
        if (!spawned) send(ws, { type:'sv_worldboss_reject', reason:'failed' });
        break;
      }

      case 'sv_worldboss_hit': {
        if (!player.gameId) break;
        const g = games.get(player.gameId);
        if (!g) break;
        const wb = g.worldBoss;
        if (!wb || !wb.spawned) break;
        if (wb.hp <= 0) break;
        // Player must be in the boss's zone — prevents cross-zone hit exploits
        if (player.zone !== wb.zone) break;
        // Cap damage (anti-cheat) — world bosses can take big hits but not absurd ones
        const dmg = Math.min(Math.max(0, data.dmg|0), 999999);
        if (dmg <= 0) break;
        wb.hp = Math.max(0, wb.hp - dmg);
        wb.lastHitAt = Date.now();
        // Track contributor by name (sum total dmg)
        wb.contributors[player.name] = (wb.contributors[player.name] || 0) + dmg;
        // Broadcast HP update to the zone
        broadcastToZone(g.id, wb.zone, {
          type: 'sv_worldboss_hp',
          id: wb.id,
          hp: wb.hp,
          maxHp: wb.maxHp,
          phase: wb.phase,
          dmg,
          hitter: player.name,
        });
        // Phase transitions
        const pct = wb.hp / wb.maxHp;
        const oldPhase = wb.phase;
        if (wb.phase === 1 && pct <= 0.75) wb.phase = 2;
        else if (wb.phase === 2 && pct <= 0.50) wb.phase = 3;
        else if (wb.phase === 3 && pct <= 0.25) wb.phase = 4;
        if (wb.phase !== oldPhase) {
          broadcastToZone(g.id, wb.zone, {
            type: 'sv_worldboss_phase',
            id: wb.id,
            phase: wb.phase,
            bossName: wb.name,
          });
        }
        // Death
        if (wb.hp <= 0) {
          despawnWorldBoss(g, true, player.name, +wb.x.toFixed(2), +wb.z.toFixed(2));
        }
        break;
      }

      case 'sv_set_depth': {
        // v93.0 phase 3.3/4.2 — Client signals descent + modifier roll.
        // Server bumps depth, applies server-coord mods, regenerates enemies.
        if (!player.gameId || !player.zone) break;
        if (data.zone !== 'convergence') break;
        const g = games.get(player.gameId);
        if (!g) break;
        const zone = g.zones['convergence'];
        if (!zone) break;
        const newDepth = Math.max(1, Math.min(50, parseInt(data.depth, 10) || 1));
        const oldDepth = zone.convergenceDepth || 1;
        // Accept the mod IDs (validated by name match)
        const modIds = Array.isArray(data.modIds) ? data.modIds.slice(0, 5) : [];
        const hasMod = (id) => modIds.includes(id);

        // a233 — CO-OP guard. The Convergence zone is SHARED by everyone in the
        //   game. A late-joiner's client always rolls a "fresh entry at Depth 1"
        //   on zone-load and fires sv_set_depth — which previously regenerated the
        //   entire zone at Depth 1, wiping the in-progress deeper run for everyone
        //   already inside. Rule: a request may only ESTABLISH a run (no one in
        //   yet) or ADVANCE it (deeper than the current live depth). A request at
        //   a depth <= the live depth from someone who isn't actually driving the
        //   run is treated as "I'm joining" — we just (re)send them the live run
        //   state so they sync to the shared seed/depth/mods, and do NOT regen.
        const playersHere = getPlayersInZone(g.id, 'convergence').length;
        const runInProgress = !!zone._runEstablished;
        const isAdvance = newDepth > oldDepth;
        if (runInProgress && !isAdvance) {
          // Joining / re-rolling at or below the live depth → adopt live run.
          send(ws, buildRunState(zone, 'convergence'));
          console.log(`[convergence] ${player.name} requested depth ${newDepth} but live run is at ${oldDepth} (players=${playersHere}) — synced to live run, no regen.`);
          break;
        }

        // This request establishes or advances the shared run. The DRIVER's client
        //   seed is adopted as the authoritative run seed on a fresh establish so
        //   the driver's already-built local map matches the server; on a pure
        //   advance we keep the existing run seed (continuity within a run).
        if (!runInProgress && typeof data.seed === 'number' && isFinite(data.seed)) {
          zone.runSeed = (data.seed & 0x7fffffff) || zone.runSeed;
        }
        zone._runEstablished = true;

        // Skip if depth AND mods both unchanged
        const sameMods = JSON.stringify(modIds.slice().sort()) === JSON.stringify((zone.activeModIds||[]).slice().sort());
        if (newDepth === oldDepth && sameMods) break;

        zone.convergenceDepth = newDepth;
        zone.activeModIds = modIds;

        // v93.0 phase 4.2 — Compute stat multipliers from depth + mods
        const depthMul = 1.0 + 0.5 * (newDepth - 1);
        const baseScale = ZONE_SCALE['convergence'] || 2.0;
        const hpMul = hasMod('vital') ? 2.0 : 1.0;
        const atkMul = hasMod('brutal') ? 1.75 : 1.0;
        const rewardMul = hasMod('bounty') ? 3.0 : 1.0;
        // Hardened Echo: +50% dmg reduction (separate field)
        const extraDR = hasMod('hardened_echo') ? 0.5 : 0;
        // Frenzied: 60% faster attacks — multiplied into spd (lower attackTimer cooldown isn't a stat so we boost spd)
        // Note: server doesn't tick enemy AI for combat; client AI handles. But Frenzied
        // affects movement/positioning indirectly via spd.
        // We pass it through via a custom field; client AI honors it if present.
        const frenzyMul = hasMod('frenzied') ? 1.6 : 1.0;

        // Density: 3x enemy count
        const baseSpawns = generateConvergenceSpawns(newDepth); // a197 — depth-aware pool
        let procSpawns = baseSpawns;
        if (hasMod('density')) {
          procSpawns = baseSpawns.concat(generateConvergenceSpawns(newDepth), generateConvergenceSpawns(newDepth));
          console.log(`[convergence] Density active: ${procSpawns.length} enemies (3x base)`);
        }

        zone.enemies = procSpawns.map((s, i) => {
          const st = ENEMY_STATS[s.type] || ENEMY_STATS.soldier;
          const effectiveScale = baseScale * depthMul;
          // a206 — floor under-tier convergence mobs to the pool tier (see convBaseHp)
          const _baseHp = convBaseHp(s.type, st.hp);
          return {
            id: i,
            type: s.type,
            x: s.tx * TILE,
            z: s.tz * TILE,
            spawnX: s.tx * TILE,
            spawnZ: s.tz * TILE,
            hp: Math.round(_baseHp * effectiveScale * hpMul),
            maxHp: Math.round(_baseHp * effectiveScale * hpMul),
            atk: Math.round(st.atk * effectiveScale * atkMul),
            spd: st.spd * frenzyMul,
            aggroRange: st.aggroRange,
            reward: Math.round(st.reward * effectiveScale * rewardMul),
            expR: Math.round(st.expR * effectiveScale),
            dmgReduction: Math.min(0.85, (st.dmgReduction || 0) + extraDR),
            active: true,
            aggroed: false,
            attackTimer: Math.floor(Math.random() * 60),
            respawnTimer: 0,
            // v93.0 phase 4.2 — Track which mods affect this enemy for client display
            _convergenceMods: modIds,
          };
        });
        // v93.0-a27 — Boss reset for new depth + scaling + respawn broadcast.
        // Previous bug: server set spawned=false but never told the client. Client kept
        // local boss alive, hit it, but server dropped hits ("if (!b.spawned) break").
        // Damage numbers popped client-side, server HP never decreased.
        // a218 — Bofis RED ALERT: Convergence bosses randomly healed to full
        //   mid-fight. CAUSE: this block reset zone.boss.hp = maxHp whenever
        //   sv_set_depth ran with the depth unchanged but the MODS changed
        //   (a re-roll, a second player entering and rolling, a reconnect, etc.)
        //   — refilling an in-progress boss. FIX: only refill the boss when the
        //   DEPTH actually changes. A same-depth mod update still rescales
        //   enemies but must NEVER touch the live boss HP.
        if (zone.boss && newDepth !== oldDepth) {
          // Scale max HP for depth + Vital modifier
          const _baseBossHp = (ZONE_BOSS_HP['convergence'] || {hp: 2000000}).hp;
          const _scaledMaxHp = Math.round(_baseBossHp * depthMul * hpMul);
          zone.boss.maxHp = _scaledMaxHp;
          zone.boss.hp = _scaledMaxHp;
          zone.boss.spawned = true; // mark as actively in world for the new depth
          zone.boss.phase = 1;
          // Broadcast a fresh boss-spawned event so all clients re-sync
          broadcastToZone(g.id, 'convergence', {
            type: 'sv_boss_spawned',
            zone: 'convergence',
            bossName: zone.boss.name,
            hp: zone.boss.hp,
            maxHp: zone.boss.maxHp,
          });
          console.log(`[convergence] Boss reset for Depth ${newDepth}: ${_scaledMaxHp.toLocaleString()} HP (x${depthMul.toFixed(2)} depth, x${hpMul.toFixed(2)} vital)`);
        } else if (zone.boss) {
          console.log(`[convergence] Same-depth mod update at Depth ${newDepth} — boss HP left at ${(zone.boss.hp||0).toLocaleString()} (NOT refilled).`);
        }
        console.log(`[convergence] Depth ${oldDepth} -> ${newDepth}. Mods: [${modIds.join(',')||'none'}]. ${zone.enemies.length} enemies. hpMul=${hpMul} atkMul=${atkMul} dr+${extraDR}`);
        // a233 — CO-OP: tell every player in the zone the new authoritative seed +
        //   depth + mods so they all rebuild the IDENTICAL layout for this depth.
        broadcastToZone(g.id, 'convergence', buildRunState(zone, 'convergence'));
        broadcastToZone(g.id, 'convergence', {
          type: 'sv_zone_snapshot',
          zone: 'convergence',
          ids: zone.enemies.map(e => e.id),
          xs: zone.enemies.map(e => e.x),
          zs: zone.enemies.map(e => e.z),
          hps: zone.enemies.map(e => e.hp),
          maxhps: zone.enemies.map(e => e.maxHp),
          types: zone.enemies.map(e => e.type),
          acts: zone.enemies.map(e => e.active ? 1 : 0),
          rots: zone.enemies.map(() => 0),
        });
        break;
      }

      case 'sv_boss_spawned': {
        // Client tells server boss spawned in their zone
        if (!player.gameId || !player.zone) break;
        const g = games.get(player.gameId);
        if (!g) break;
        const zone = g.zones[player.zone];
        if (!zone || !zone.boss) break;
        if (!zone.boss.spawned) {
          zone.boss.spawned = true;
          // a226 — ONLY refill if the boss is actually dead. The client re-sends
          //   sv_boss_spawned in several situations (proximity re-trigger, local
          //   mesh re-spawn, reconnect). If the server's spawned flag happened to
          //   be false at that moment, this used to slam hp back to maxHp mid-
          //   fight — the random "Archon heals to full" bug. A live boss keeps
          //   its current HP.
          if (zone.boss.hp <= 0) {
            zone.boss.hp = zone.boss.maxHp;
            zone.boss.phase = 1;
          }
          // Announce to zone
          broadcastToZone(g.id, player.zone, {
            type: 'sv_boss_spawned',
            zone: player.zone,
            bossName: zone.boss.name,
            hp: zone.boss.hp,
            maxHp: zone.boss.maxHp,
          });
        }
        break;
      }

      case 'sv_zone_announce':
        // Intentionally ignored — sv_enter_zone already sends sv_player_entered
        // and sv_zone_entered_announce. Handling this separately caused duplicate chat messages.
        break;

      case 'sv_vfx': {
        // Lightweight VFX relay — forwards skill/spell VFX packets to all other players
        // in the same zone. Belt-and-suspenders backup for PeerJS VFX broadcasts so VFX
        // still reaches teammates if the P2P link is flaky or missing.
        if (!player.gameId || !player.zone) break;
        // Basic size guard so we never relay oversized or spammed packets
        if (typeof data !== 'object' || !data.vt) break;
        const relay = {
          type: 'sv_vfx',
          vt: String(data.vt).slice(0, 40),
          zone: player.zone,
          from: player.name,
        };
        // Allow a small fixed set of numeric/string fields only
        ['px','pz','tx','tz','dx','dz','col','skId','wtype','r','br','t','heavy'].forEach(k=>{
          if (data[k] !== undefined) relay[k] = data[k];
        });
        broadcastToZone(player.gameId, player.zone, relay, ws);
        break;
      }

      // ══════════════════════════════════════════════════════════
      // GUILD SYSTEM
      // ══════════════════════════════════════════════════════════
      case 'guild_create': {
        if(!player.name){ send(ws,{type:'guild_err',msg:'Not logged in.'}); break; }
        const already = findPlayerGuild(player.name);
        if(already){ send(ws,{type:'guild_err',msg:'You are already in a guild.'}); break; }
        const gname = (data.name||'').trim().slice(0,32);
        const gtag = (data.tag||'').trim().toUpperCase().slice(0,4);
        if(gname.length < 3 || gtag.length < 2){
          send(ws,{type:'guild_err',msg:'Name must be 3+ chars, tag must be 2-4 chars.'}); break;
        }
        // Name/tag uniqueness
        const gid = gname.toLowerCase().replace(/[^a-z0-9]/g,'');
        if(!gid){ send(ws,{type:'guild_err',msg:'Name must contain letters/numbers.'}); break; }
        if(guilds[gid]){ send(ws,{type:'guild_err',msg:'A guild with that name exists.'}); break; }
        for(const g of Object.values(guilds)){
          if(g.tag === gtag){ send(ws,{type:'guild_err',msg:'That tag is taken.'}); break; }
        }
        // Create
        guilds[gid] = {
          name: gname,
          tag: gtag,
          level: 1,
          xp: 0,
          leader: player.name,
          members: {[player.name]: Date.now()},
          motd: '',
          created: Date.now()
        };
        flushGuilds();
        send(ws,{type:'guild_created', guildId:gid, guild:guilds[gid]});
        console.log(`[guild] ${player.name} created guild "${gname}" [${gtag}]`);
        break;
      }

      case 'guild_list': {
        // Return sorted list (by member count, then by level)
        const list = Object.entries(guilds).map(([id,g])=>({
          id, name:g.name, tag:g.tag, level:g.level||1,
          memberCount: Object.keys(g.members||{}).length,
          leader: g.leader
        })).sort((a,b)=>{
          if(b.level !== a.level) return b.level - a.level;
          return b.memberCount - a.memberCount;
        });
        send(ws,{type:'guild_list', guilds:list});
        break;
      }

      case 'guild_join': {
        if(!player.name){ send(ws,{type:'guild_err',msg:'Not logged in.'}); break; }
        const already = findPlayerGuild(player.name);
        if(already){ send(ws,{type:'guild_err',msg:'You are already in a guild.'}); break; }
        const gid = (data.guildId||'').toLowerCase();
        const g = guilds[gid];
        if(!g){ send(ws,{type:'guild_err',msg:'Guild not found.'}); break; }
        if(!g.members) g.members = {};
        g.members[player.name] = Date.now();
        flushGuilds();
        send(ws,{type:'guild_joined', guildId:gid, guild:g});
        broadcastGuildUpdate(gid);
        broadcastGuildChat(gid, '[SYSTEM]', `${player.name} joined the guild.`);
        console.log(`[guild] ${player.name} joined "${g.name}"`);
        break;
      }

      case 'guild_leave': {
        if(!player.name){ send(ws,{type:'guild_err',msg:'Not logged in.'}); break; }
        const found = findPlayerGuild(player.name);
        if(!found){ send(ws,{type:'guild_err',msg:'You are not in a guild.'}); break; }
        const {id, guild} = found;
        delete guild.members[player.name];
        // If leader leaves, promote earliest-joined member (or delete if empty)
        if(guild.leader === player.name){
          const remaining = Object.entries(guild.members||{}).sort((a,b)=>a[1]-b[1]);
          if(remaining.length === 0){
            delete guilds[id];
            console.log(`[guild] "${guild.name}" disbanded (leader left, no members).`);
          } else {
            guild.leader = remaining[0][0];
            console.log(`[guild] ${guild.leader} is new leader of "${guild.name}"`);
          }
        }
        flushGuilds();
        send(ws,{type:'guild_left'});
        if(guilds[id]){
          broadcastGuildUpdate(id);
          broadcastGuildChat(id, '[SYSTEM]', `${player.name} left the guild.`);
        }
        break;
      }

      case 'guild_chat_send': {
        if(!player.name){ break; }
        const found = findPlayerGuild(player.name);
        if(!found) break;
        const msg = (data.msg||'').trim().slice(0,200);
        if(!msg) break;
        broadcastGuildChat(found.id, player.name, msg);
        break;
      }

      case 'guild_info': {
        // Return current user's guild info (on login)
        if(!player.name) break;
        const found = findPlayerGuild(player.name);
        if(found) send(ws,{type:'guild_info', guildId:found.id, guild:found.guild});
        else send(ws,{type:'guild_info', guildId:null, guild:null});
        break;
      }

      case 'guild_set_motd': {
        if(!player.name) break;
        const found = findPlayerGuild(player.name);
        if(!found){ send(ws,{type:'guild_err',msg:'Not in a guild.'}); break; }
        if(found.guild.leader !== player.name){
          send(ws,{type:'guild_err',msg:'Only the leader can set MOTD.'}); break;
        }
        found.guild.motd = (data.motd||'').slice(0, 200);
        flushGuilds();
        broadcastGuildUpdate(found.id);
        break;
      }

      case 'guild_award_xp': {
        // Solo-mode XP request — client tells server how much XP their kill earned.
        // Server validates player is in a guild, then adds XP (with a safety cap).
        if(!player.name) break;
        const found = findPlayerGuild(player.name);
        if(!found) break;
        // Rate-limit: max 500 XP per request, and track per-connection total to prevent spam
        const requestedXp = Math.min(500, Math.max(0, Math.floor(data.amount||0)));
        if(requestedXp <= 0) break;
        // Per-connection rate limit: max 5000 XP per 10 seconds
        player._guildXpWindow = player._guildXpWindow || {start:Date.now(), total:0};
        const now = Date.now();
        if(now - player._guildXpWindow.start > 10000){
          player._guildXpWindow = {start:now, total:0};
        }
        if(player._guildXpWindow.total + requestedXp > 5000){
          break; // silently drop — likely spam/cheat
        }
        player._guildXpWindow.total += requestedXp;
        const oldLvl = found.guild.level || 1;
        awardGuildXp(player.name, requestedXp);
        // Send authoritative XP sync back to the requester (cheap — no broadcast needed)
        send(ws, {type:'guild_xp_sync', xp:found.guild.xp, level:found.guild.level||1});
        // If they leveled up, broadcast full guild state to ALL members (level changes affect everyone's perks)
        const newLvl = found.guild.level || 1;
        if(newLvl > oldLvl){
          broadcastGuildUpdate(found.id);
        }
        break;
      }
    }
  });

  ws.on('close',  () => removePlayer(ws));
  ws.on('error',  () => removePlayer(ws));
});

// Clean up empty or abandoned games every 2 minutes
setInterval(()=>{
  const now = Date.now();
  games.forEach((g, id) => {
    // Delete if: no players left, or older than 6 hours, or inactive for 30 min with 0 players
    const empty = g.players.length === 0;
    const old   = now - g.createdAt > 6*60*60*1000;
    const stale = empty && (now - g.createdAt > 30*60*1000);
    if(old || stale) games.delete(id);
  });
  broadcastGameList();
}, 2*60*1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Empire 2 server running on port ' + PORT));
