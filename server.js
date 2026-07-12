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
  prismaraptor:        {hp:85000,  atk:460, spd:0.082, aggroRange:14, reward:1600, expR:1300, dmgReduction:0.05},
  sporegon:            {hp:220000, atk:400, spd:0.022, aggroRange:9,  reward:2600, expR:2000, dmgReduction:0.30},
  vortexwisp:          {hp:60000,  atk:520, spd:0.070, aggroRange:15, reward:1500, expR:1200, dmgReduction:0},
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
  cemetery: [],   // a467 — client-authoritative (bespoke necro AI client-side); server no longer spawns/owns these mobs.
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
  citadel: [],   // a470 — client-authoritative (bespoke futuristic AI client-side); server no longer spawns/owns these mobs.
  caves_of_despair: [],   // a498 — client-authoritative now (bespoke mine AI + two new species client-side); server no longer spawns/owns these mobs. See client sv_zone_snapshot fallback.
  ashlands: [],   // a469 — client-authoritative (bespoke fire/volcanic AI client-side); server no longer spawns/owns these mobs.
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
  frostveil: [],   // a473 — client-authoritative (bespoke ice AI client-side); server no longer spawns/owns these mobs.
  ancient: [],   // a475 — client-authoritative (bespoke arcane AI client-side); server no longer spawns/owns these mobs.
  dragonlair: [],   // a506 — client-authoritative now (bespoke volcanic AI client-side); server no longer spawns/owns these mobs. See client sv_zone_snapshot fallback.
  riftvale: [],   // a477 — client-authoritative (bespoke void/rift AI client-side); server no longer spawns/owns these mobs.
  wyvernwastes: [],   // a488 — client-authoritative now (bespoke pack AI client-side); server no longer spawns/owns these mobs. See client sv_zone_snapshot fallback.
  xumen: [],   // a489 — client-authoritative now (bespoke capital-guard AI client-side); server no longer spawns/owns these mobs. See client sv_zone_snapshot fallback.
  necropolis: [],   // a478 — client-authoritative (bespoke plague/death AI client-side); server no longer spawns/owns these mobs.
  xumen_fortress: [],   // a490 — client-authoritative now (bespoke garrison AI client-side); server no longer spawns/owns these mobs. See client sv_zone_snapshot fallback.
  fungal: [],   // a471 — client-authoritative (bespoke spore AI client-side); server no longer spawns/owns these mobs.
  void_citadel: [],   // a492 — client-authoritative now (bespoke unreality AI client-side); server no longer spawns/owns these mobs. See client sv_zone_snapshot fallback.
  // ── NEON HOLLOW — POST-CAP AA-GATED (matches client ZONE_DEFS.neon_hollow) ──
  neon_hollow: [],   // a487 — client-authoritative now (bespoke machine AI client-side); server no longer spawns/owns these mobs. See client sv_zone_snapshot fallback.
  // ── VEILED SANCTUARY (v92.41) — matches client ZONE_DEFS.veiled_sanctuary ──
  veiled_sanctuary: [],   // a484 — client-authoritative now (bespoke ritual AI client-side); server no longer spawns/owns these mobs. See client sv_zone_snapshot fallback.
  // ── BLOOMING WILDS (v92.49+v92.50) — matches client ZONE_DEFS.blooming_wilds ──
  blooming_wilds: [],   // a465 — client-authoritative now (custom client AI); server no longer spawns/owns these mobs. See client sv_zone_snapshot fallback.
  // ── XERON (v93.0-a94) — matches client ZONE_DEFS.xeron ──
  // Cut from 86 → 51 mobs to address dense-combat feedback.
  // Also incorporates a92's docking spire pushback (entry now tx 18-30, not 10-22).
  xeron: [],   // a491 — client-authoritative now (bespoke spacetime AI client-side); server no longer spawns/owns these mobs. See client sv_zone_snapshot fallback.
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
  // a299 — LUCIDWILDE mobs are CLIENT-AUTHORITATIVE (bespoke psychedelic AI + abilities
  //   run client-side). The server intentionally does NOT spawn them, so it sends an
  //   empty Lucidwilde snapshot and the client owns movement + ability damage. The
  //   PIXIELORD boss stays server-authoritative (see ZONE_BOSS_HP.lucidwilde).
  // a332 — XULCAN PRIME mobs are likewise CLIENT-AUTHORITATIVE (bespoke Xu Dominion AI
  //   + abilities run client-side). No ZONE_SPAWNS entry on purpose: the server sends an
  //   empty xulcan snapshot and the client spawns + owns the five Xu units. (The boss
  //   XU ZET-HORAK will become server-authoritative when added — ZONE_BOSS_HP.xulcan.)
  // a347 — AVIA CANYON birds are likewise CLIENT-AUTHORITATIVE (no ZONE_SPAWNS entry); the
  //   XUBERRY boss is server-authoritative (ZONE_BOSS_HP.aviacanyon).
  // a361 — THE FORGE foundry mobs are likewise CLIENT-AUTHORITATIVE (no ZONE_SPAWNS entry); the
  //   FURNACE CORE boss is server-authoritative (ZONE_BOSS_HP.forge).
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
const ZONE_HP_MULT = { sunken_sands: 6, void: 1.15 };
// a532 — per-zone-per-type HP override. void_sentinel/void_construct carry boss-tier HP
//   that is correct for VOID CITADEL but far too tanky for the lvl15-28 VOID WASTES where
//   they also spawn. Scope a zone-appropriate HP to Void Wastes only (base stats untouched,
//   so the Citadel versions keep their heavy HP). Their damage already uses VW_PWR, not atk.
const ZONE_TYPE_HP = { void: { void_sentinel: 4500, void_construct: 3600 } };
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
      if (nearestDist <= e.aggroRange) e.aggroed = true;
      if (!e.aggroed) return;

      // a529 — this mob runs bespoke server AI? (sand types anywhere; patrol types only in patrol)
      const _bespoke = SD_BESPOKE[e.type] || (zoneName === 'patrol' && PATROL_BESPOKE[e.type]) || (zoneName === 'void' && VW_BESPOKE[e.type]);
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
      if (gy.fuse <= 0) {
        const _gr = gy.radius || 2.3;
        broadcastToZone(game.id, gy.zone, { type:'sv_fx', vt:'sd_geyser_hit', zone:gy.zone, ex:+gy.x.toFixed(2), ez:+gy.z.toFixed(2), col:(gy.col||0xd8b45e), radius:_gr });
        players.forEach((p, ws) => {
          if (p.gameId !== game.id || p.zone !== gy.zone || p.x === undefined) return;
          const ddx=p.x-gy.x, ddz=p.z-gy.z;
          if (ddx*ddx + ddz*ddz < _gr*_gr) {
            send(ws, { type:'sv_enemy_attack', eid:gy.eid, dmg:gy.dmg, ex:+gy.x.toFixed(2), ez:+gy.z.toFixed(2), zone:gy.zone });
            if (gy.slow) send(ws, { type:'sv_player_fx', zone:gy.zone, eff:'slow', slow:gy.slow, root:(gy.slowDur||1000) });
            if (gy.pull) send(ws, { type:'sv_player_fx', zone:gy.zone, eff:'pull', px:+gy.x.toFixed(2), pz:+gy.z.toFixed(2), pull:gy.pull });
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
        const bdmg = Math.min(data.dmg || 1, 999999);
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

        // Phase transitions — broadcast to zone
        const pct = b.hp / b.maxHp;
        const oldPhase = b.phase;
        if (b.phase === 1 && pct <= 0.75) b.phase = 2;
        else if (b.phase === 2 && pct <= 0.50) b.phase = 3;
        else if (b.phase === 3 && pct <= 0.25) b.phase = 4;
        else if (b.phase === 4 && pct <= 0.10) b.phase = 5;
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
