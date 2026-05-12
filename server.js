const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const fs   = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

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
    try {
      fs.writeFileSync(GUILDS_FILE, JSON.stringify(guilds), 'utf8');
    } catch(e) {
      console.warn('[guilds] Failed to write guilds.json:', e.message);
    }
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

// Load saves from disk on startup
try {
  if (fs.existsSync(SAVES_FILE)) {
    cloudSaves = JSON.parse(fs.readFileSync(SAVES_FILE, 'utf8'));
    console.log(`[saves] Loaded ${Object.keys(cloudSaves).length} cloud saves from disk.`);
  }
} catch(e) {
  console.warn('[saves] Could not load saves.json:', e.message);
  cloudSaves = {};
}

// Write saves to disk (debounced — max once per 10s)
let _saveDirtyTimer = null;
function flushSaves() {
  if (_saveDirtyTimer) return;
  _saveDirtyTimer = setTimeout(() => {
    _saveDirtyTimer = null;
    try {
      fs.writeFileSync(SAVES_FILE, JSON.stringify(cloudSaves), 'utf8');
    } catch(e) {
      console.warn('[saves] Failed to write saves.json:', e.message);
    }
  }, 10000);
}

function getSaveKey(name, raceId, cls) {
  return (name + '_' + raceId + '_' + cls).toLowerCase();
}

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
};

// ══════════════════════════════════════════════════════════
// ZONE ENEMY SPAWNS — mirrors ZONE_DEFS.enemySpawns
// Only the spawn positions and types; stats come from ENEMY_STATS
// ══════════════════════════════════════════════════════════
const TILE = 1.6; // matches client TILE constant

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
};

const ZONE_SPAWNS = {
  outpost: [],
  sanctuary: [], // Safe hub — no enemies
  patrol: [
    {tx:10,tz:8,type:'xu_scout'},
    {tx:28,tz:6,type:'xu_scout'},
    {tx:8,tz:14,type:'wraith'},
    {tx:26,tz:12,type:'wraith'},
    {tx:30,tz:18,type:'xu_scout'},
    {tx:36,tz:28,type:'xu_scout'},
    {tx:16,tz:34,type:'wraith'},
    {tx:32,tz:32,type:'xu_scout'},
    {tx:22,tz:8,type:'xu_siege_bot'},
    {tx:20,tz:14,type:'xu_siege_bot'},
    {tx:18,tz:20,type:'xu_siege_bot'},
    {tx:24,tz:32,type:'xu_siege_bot'},
    {tx:32,tz:8,type:'bandit_archer'},
    {tx:34,tz:10,type:'bandit_archer'},
    {tx:30,tz:10,type:'bandit'},
    {tx:32,tz:12,type:'bandit'},
    {tx:34,tz:6,type:'bandit'},
    {tx:8,tz:28,type:'xu_rebel'},
    {tx:10,tz:30,type:'xu_rebel'},
    {tx:6,tz:32,type:'xu_rebel'},
    {tx:12,tz:28,type:'xu_rebel'},
    {tx:10,tz:32,type:'xu_rebel'},
    {tx:36,tz:34,type:'sniper'},
    {tx:4,tz:8,type:'sniper'},
    {tx:44,tz:10,type:'xu_scout'},
    {tx:52,tz:8,type:'xu_scout'},
    {tx:60,tz:6,type:'wraith'},
    {tx:68,tz:10,type:'wraith'},
    {tx:48,tz:18,type:'xu_scout'},
    {tx:56,tz:16,type:'xu_scout'},
    {tx:72,tz:14,type:'xu_commander'},
    {tx:76,tz:20,type:'xu_scout'},
    {tx:46,tz:24,type:'xu_siege_bot'},
    {tx:58,tz:22,type:'xu_siege_bot'},
    {tx:64,tz:28,type:'xu_siege_bot'},
    {tx:72,tz:30,type:'xu_siege_bot'},
    {tx:64,tz:8,type:'bandit_archer'},
    {tx:66,tz:6,type:'bandit_archer'},
    {tx:68,tz:8,type:'bandit_archer'},
    {tx:62,tz:10,type:'bandit'},
    {tx:64,tz:12,type:'bandit'},
    {tx:68,tz:12,type:'bandit'},
    {tx:66,tz:10,type:'xu_siege_bot'},
    {tx:50,tz:58,type:'xu_rebel'},
    {tx:52,tz:60,type:'xu_rebel'},
    {tx:48,tz:60,type:'xu_rebel'},
    {tx:54,tz:58,type:'xu_rebel'},
    {tx:50,tz:62,type:'xu_rebel'},
    {tx:46,tz:56,type:'xu_rebel'},
    {tx:56,tz:62,type:'xu_rebel'},
    {tx:52,tz:56,type:'sniper'},
    {tx:48,tz:64,type:'sniper'},
    {tx:44,tz:48,type:'xu_scout'},
    {tx:60,tz:44,type:'xu_scout'},
    {tx:68,tz:50,type:'xu_commander'},
    {tx:56,tz:52,type:'xu_commander'},
    {tx:72,tz:56,type:'xu_scout'},
    {tx:44,tz:64,type:'xu_siege_bot'},
    {tx:74,tz:38,type:'sniper'},
    {tx:76,tz:40,type:'sniper'},
    {tx:72,tz:42,type:'bandit'},
    {tx:42,tz:36,type:'xu_commander'},
    {tx:58,tz:34,type:'xu_scout'},
    {tx:70,tz:36,type:'xu_siege_bot'},
    {tx:46,tz:70,type:'xu_rebel'},
    {tx:62,tz:68,type:'bandit'},
    {tx:74,tz:64,type:'xu_scout'},
    {tx:8,tz:44,type:'xu_scout'},
    {tx:20,tz:46,type:'xu_commander'},
    {tx:34,tz:42,type:'xu_scout'},
    {tx:12,tz:54,type:'xu_siege_bot'},
    {tx:28,tz:52,type:'xu_commander'},
    {tx:6,tz:60,type:'xu_scout'},
    {tx:22,tz:58,type:'xu_siege_bot'},
    {tx:36,tz:56,type:'xu_scout'},
    {tx:16,tz:64,type:'bandit_archer'},
    {tx:18,tz:66,type:'bandit_archer'},
    {tx:14,tz:66,type:'bandit'},
    {tx:20,tz:64,type:'bandit'},
    {tx:16,tz:68,type:'xu_siege_bot'},
    {tx:10,tz:70,type:'xu_rebel'},
    {tx:24,tz:70,type:'xu_rebel'},
    {tx:8,tz:74,type:'sniper'},
    {tx:30,tz:72,type:'xu_commander'},
    {tx:34,tz:68,type:'xu_scout'},
    {tx:20,tz:74,type:'xu_siege_bot'}
  ],
  cemetery: [
    {tx:10,tz:8,type:'skeleton_warrior'},
    {tx:14,tz:7,type:'skeleton_warrior'},
    {tx:18,tz:8,type:'skeleton_warrior'},
    {tx:24,tz:6,type:'skeleton_warrior'},
    {tx:28,tz:8,type:'bone_mage'},
    {tx:12,tz:12,type:'grave_crawler'},
    {tx:16,tz:11,type:'grave_crawler'},
    {tx:22,tz:12,type:'wraith'},
    {tx:26,tz:10,type:'wraith'},
    {tx:10,tz:16,type:'skeleton_warrior'},
    {tx:14,tz:15,type:'bone_mage'},
    {tx:18,tz:16,type:'grave_crawler'},
    {tx:22,tz:18,type:'skeleton_warrior'},
    {tx:26,tz:16,type:'grave_crawler'},
    {tx:30,tz:14,type:'wraith'},
    {tx:8,tz:20,type:'grave_crawler'},
    {tx:12,tz:20,type:'skeleton_warrior'},
    {tx:16,tz:21,type:'bone_mage'},
    {tx:20,tz:20,type:'wraith'},
    {tx:28,tz:20,type:'skeleton_warrior'},
    {tx:14,tz:18,type:'death_knight'},
    {tx:16,tz:17,type:'skeleton_warrior'},
    {tx:18,tz:18,type:'skeleton_warrior'},
    {tx:16,tz:20,type:'bone_mage'},
    {tx:14,tz:20,type:'grave_crawler'},
    {tx:20,tz:18,type:'grave_crawler'},
    {tx:34,tz:8,type:'skeleton_warrior'},
    {tx:38,tz:7,type:'skeleton_warrior'},
    {tx:42,tz:8,type:'bone_mage'},
    {tx:46,tz:6,type:'skeleton_warrior'},
    {tx:50,tz:8,type:'grave_crawler'},
    {tx:54,tz:6,type:'wraith'},
    {tx:36,tz:12,type:'grave_crawler'},
    {tx:40,tz:11,type:'wraith'},
    {tx:44,tz:12,type:'skeleton_warrior'},
    {tx:48,tz:10,type:'bone_mage'},
    {tx:52,tz:12,type:'grave_crawler'},
    {tx:56,tz:10,type:'skeleton_warrior'},
    {tx:34,tz:18,type:'wraith'},
    {tx:38,tz:16,type:'skeleton_warrior'},
    {tx:42,tz:18,type:'bone_mage'},
    {tx:46,tz:16,type:'grave_crawler'},
    {tx:50,tz:18,type:'skeleton_warrior'},
    {tx:54,tz:16,type:'wraith'},
    {tx:36,tz:22,type:'grave_crawler'},
    {tx:40,tz:24,type:'skeleton_warrior'},
    {tx:44,tz:22,type:'death_knight'},
    {tx:48,tz:24,type:'bone_mage'},
    {tx:52,tz:22,type:'grave_crawler'},
    {tx:56,tz:24,type:'wraith'},
    {tx:38,tz:14,type:'bone_mage'},
    {tx:42,tz:14,type:'bone_mage'},
    {tx:46,tz:14,type:'bone_mage'},
    {tx:40,tz:16,type:'death_knight'},
    {tx:44,tz:16,type:'skeleton_warrior'},
    {tx:42,tz:12,type:'wraith'},
    {tx:60,tz:8,type:'skeleton_warrior'},
    {tx:64,tz:6,type:'wraith'},
    {tx:68,tz:8,type:'bone_mage'},
    {tx:72,tz:6,type:'skeleton_warrior'},
    {tx:58,tz:12,type:'grave_crawler'},
    {tx:62,tz:10,type:'skeleton_warrior'},
    {tx:66,tz:12,type:'grave_crawler'},
    {tx:70,tz:10,type:'death_knight'},
    {tx:74,tz:8,type:'wraith'},
    {tx:60,tz:16,type:'bone_mage'},
    {tx:64,tz:16,type:'skeleton_warrior'},
    {tx:68,tz:14,type:'grave_crawler'},
    {tx:72,tz:16,type:'wraith'},
    {tx:58,tz:20,type:'skeleton_warrior'},
    {tx:62,tz:20,type:'bone_mage'},
    {tx:66,tz:20,type:'grave_crawler'},
    {tx:70,tz:20,type:'death_knight'},
    {tx:74,tz:18,type:'skeleton_warrior'},
    {tx:64,tz:12,type:'death_knight'},
    {tx:68,tz:10,type:'death_knight'},
    {tx:70,tz:14,type:'skeleton_warrior'},
    {tx:66,tz:14,type:'skeleton_warrior'},
    {tx:62,tz:14,type:'bone_mage'},
    {tx:72,tz:12,type:'wraith'},
    {tx:10,tz:30,type:'skeleton_warrior'},
    {tx:14,tz:28,type:'grave_crawler'},
    {tx:18,tz:30,type:'wraith'},
    {tx:22,tz:28,type:'bone_mage'},
    {tx:26,tz:30,type:'skeleton_warrior'},
    {tx:30,tz:28,type:'grave_crawler'},
    {tx:34,tz:30,type:'wraith'},
    {tx:38,tz:28,type:'skeleton_warrior'},
    {tx:42,tz:30,type:'bone_mage'},
    {tx:46,tz:28,type:'grave_crawler'},
    {tx:50,tz:30,type:'skeleton_warrior'},
    {tx:54,tz:28,type:'wraith'},
    {tx:12,tz:36,type:'grave_crawler'},
    {tx:16,tz:34,type:'bone_mage'},
    {tx:20,tz:36,type:'skeleton_warrior'},
    {tx:24,tz:34,type:'wraith'},
    {tx:28,tz:36,type:'grave_crawler'},
    {tx:32,tz:34,type:'bone_mage'},
    {tx:36,tz:36,type:'skeleton_warrior'},
    {tx:40,tz:34,type:'death_knight'},
    {tx:44,tz:36,type:'grave_crawler'},
    {tx:48,tz:34,type:'wraith'},
    {tx:52,tz:36,type:'skeleton_warrior'},
    {tx:10,tz:42,type:'wraith'},
    {tx:14,tz:40,type:'skeleton_warrior'},
    {tx:18,tz:42,type:'grave_crawler'},
    {tx:22,tz:40,type:'bone_mage'},
    {tx:26,tz:42,type:'skeleton_warrior'},
    {tx:30,tz:40,type:'wraith'},
    {tx:34,tz:42,type:'grave_crawler'},
    {tx:38,tz:40,type:'death_knight'},
    {tx:42,tz:42,type:'bone_mage'},
    {tx:46,tz:40,type:'skeleton_warrior'},
    {tx:50,tz:42,type:'wraith'},
    {tx:20,tz:36,type:'death_knight'},
    {tx:24,tz:36,type:'death_knight'},
    {tx:22,tz:38,type:'bone_mage'},
    {tx:26,tz:38,type:'bone_mage'},
    {tx:18,tz:38,type:'skeleton_warrior'},
    {tx:28,tz:36,type:'skeleton_warrior'},
    {tx:22,tz:40,type:'grave_crawler'},
    {tx:26,tz:40,type:'grave_crawler'},
    {tx:46,tz:36,type:'wraith'},
    {tx:48,tz:34,type:'wraith'},
    {tx:50,tz:36,type:'wraith'},
    {tx:52,tz:34,type:'wraith'},
    {tx:48,tz:38,type:'bone_mage'},
    {tx:52,tz:38,type:'bone_mage'},
    {tx:50,tz:40,type:'death_knight'},
    {tx:30,tz:48,type:'skeleton_warrior'},
    {tx:34,tz:46,type:'grave_crawler'},
    {tx:38,tz:48,type:'bone_mage'},
    {tx:42,tz:46,type:'skeleton_warrior'},
    {tx:46,tz:48,type:'wraith'},
    {tx:50,tz:46,type:'grave_crawler'},
    {tx:54,tz:48,type:'bone_mage'},
    {tx:58,tz:46,type:'skeleton_warrior'},
    {tx:62,tz:48,type:'death_knight'},
    {tx:66,tz:46,type:'wraith'},
    {tx:70,tz:48,type:'grave_crawler'},
    {tx:28,tz:54,type:'wraith'},
    {tx:32,tz:52,type:'skeleton_warrior'},
    {tx:36,tz:54,type:'grave_crawler'},
    {tx:40,tz:52,type:'death_knight'},
    {tx:44,tz:54,type:'bone_mage'},
    {tx:48,tz:52,type:'skeleton_warrior'},
    {tx:52,tz:54,type:'wraith'},
    {tx:56,tz:52,type:'grave_crawler'},
    {tx:60,tz:54,type:'bone_mage'},
    {tx:64,tz:52,type:'death_knight'},
    {tx:68,tz:54,type:'skeleton_warrior'},
    {tx:72,tz:52,type:'wraith'},
    {tx:30,tz:60,type:'grave_crawler'},
    {tx:34,tz:58,type:'skeleton_warrior'},
    {tx:38,tz:60,type:'wraith'},
    {tx:42,tz:58,type:'bone_mage'},
    {tx:46,tz:60,type:'skeleton_warrior'},
    {tx:50,tz:58,type:'death_knight'},
    {tx:54,tz:60,type:'grave_crawler'},
    {tx:58,tz:58,type:'bone_mage'},
    {tx:62,tz:60,type:'death_knight'},
    {tx:66,tz:58,type:'wraith'},
    {tx:70,tz:60,type:'skeleton_warrior'},
    {tx:28,tz:66,type:'skeleton_warrior'},
    {tx:32,tz:64,type:'bone_mage'},
    {tx:36,tz:66,type:'death_knight'},
    {tx:40,tz:64,type:'grave_crawler'},
    {tx:44,tz:66,type:'wraith'},
    {tx:48,tz:64,type:'skeleton_warrior'},
    {tx:52,tz:66,type:'bone_mage'},
    {tx:56,tz:64,type:'death_knight'},
    {tx:60,tz:66,type:'grave_crawler'},
    {tx:64,tz:64,type:'wraith'},
    {tx:68,tz:66,type:'skeleton_warrior'},
    {tx:72,tz:64,type:'bone_mage'},
    {tx:44,tz:50,type:'death_knight'},
    {tx:48,tz:50,type:'death_knight'},
    {tx:52,tz:50,type:'death_knight'},
    {tx:56,tz:50,type:'death_knight'},
    {tx:42,tz:52,type:'bone_mage'},
    {tx:46,tz:52,type:'bone_mage'},
    {tx:50,tz:52,type:'bone_mage'},
    {tx:54,tz:52,type:'bone_mage'},
    {tx:58,tz:52,type:'skeleton_warrior'},
    {tx:44,tz:54,type:'skeleton_warrior'},
    {tx:48,tz:54,type:'wraith'},
    {tx:52,tz:54,type:'wraith'},
    {tx:56,tz:54,type:'grave_crawler'},
    {tx:62,tz:62,type:'bone_mage'},
    {tx:64,tz:60,type:'bone_mage'},
    {tx:66,tz:62,type:'bone_mage'},
    {tx:64,tz:64,type:'death_knight'},
    {tx:68,tz:62,type:'death_knight'},
    {tx:62,tz:64,type:'wraith'},
    {tx:66,tz:64,type:'grave_crawler'},
    {tx:70,tz:62,type:'skeleton_warrior'},
    {tx:8,tz:50,type:'skeleton_warrior'},
    {tx:12,tz:48,type:'grave_crawler'},
    {tx:16,tz:50,type:'wraith'},
    {tx:20,tz:48,type:'bone_mage'},
    {tx:24,tz:50,type:'skeleton_warrior'},
    {tx:8,tz:56,type:'grave_crawler'},
    {tx:12,tz:54,type:'bone_mage'},
    {tx:16,tz:56,type:'death_knight'},
    {tx:20,tz:54,type:'wraith'},
    {tx:24,tz:56,type:'skeleton_warrior'},
    {tx:8,tz:62,type:'wraith'},
    {tx:12,tz:60,type:'skeleton_warrior'},
    {tx:16,tz:62,type:'grave_crawler'},
    {tx:20,tz:60,type:'bone_mage'},
    {tx:24,tz:62,type:'death_knight'},
    {tx:8,tz:68,type:'skeleton_warrior'},
    {tx:12,tz:66,type:'wraith'},
    {tx:16,tz:68,type:'grave_crawler'},
    {tx:20,tz:66,type:'bone_mage'},
    {tx:24,tz:68,type:'skeleton_warrior'}
  ],
  void: [
    {tx:10,tz:8,type:'void_stalker'},
    {tx:16,tz:6,type:'void_eye'},
    {tx:22,tz:8,type:'void_stalker'},
    {tx:28,tz:6,type:'void_eye'},
    {tx:8,tz:15,type:'void_phantom'},
    {tx:14,tz:14,type:'void_stalker'},
    {tx:20,tz:14,type:'void_eye'},
    {tx:26,tz:12,type:'void_stalker'},
    {tx:10,tz:22,type:'void_eye'},
    {tx:18,tz:20,type:'void_stalker'},
    {tx:24,tz:20,type:'wraith'},
    {tx:30,tz:18,type:'void_eye'},
    {tx:12,tz:28,type:'void_stalker'},
    {tx:20,tz:28,type:'void_eye'},
    {tx:28,tz:26,type:'void_stalker'},
    {tx:34,tz:24,type:'void_phantom'},
    {tx:16,tz:34,type:'void_eye'},
    {tx:24,tz:34,type:'void_stalker'},
    {tx:32,tz:32,type:'void_stalker'},
    {tx:36,tz:30,type:'void_eye'},
    {tx:44,tz:8,type:'void_stalker'},
    {tx:50,tz:10,type:'void_eye'},
    {tx:58,tz:8,type:'void_stalker'},
    {tx:64,tz:6,type:'void_eye'},
    {tx:70,tz:10,type:'void_stalker'},
    {tx:76,tz:8,type:'wraith'},
    {tx:46,tz:18,type:'void_eye'},
    {tx:54,tz:16,type:'void_stalker'},
    {tx:62,tz:18,type:'void_phantom'},
    {tx:70,tz:20,type:'void_eye'},
    {tx:56,tz:28,type:'void_stalker'},
    {tx:58,tz:30,type:'void_stalker'},
    {tx:54,tz:30,type:'void_eye'},
    {tx:60,tz:28,type:'void_eye'},
    {tx:56,tz:32,type:'wraith'},
    {tx:52,tz:28,type:'void_stalker'},
    {tx:62,tz:32,type:'void_stalker'},
    {tx:44,tz:40,type:'void_eye'},
    {tx:52,tz:44,type:'void_stalker'},
    {tx:60,tz:40,type:'void_phantom'},
    {tx:68,tz:44,type:'void_eye'},
    {tx:74,tz:38,type:'void_stalker'},
    {tx:46,tz:52,type:'void_stalker'},
    {tx:56,tz:56,type:'void_eye'},
    {tx:66,tz:54,type:'wraith'},
    {tx:58,tz:60,type:'void_phantom'},
    {tx:60,tz:62,type:'wraith'},
    {tx:56,tz:62,type:'void_phantom'},
    {tx:64,tz:60,type:'void_stalker'},
    {tx:62,tz:64,type:'void_eye'},
    {tx:42,tz:62,type:'void_stalker'},
    {tx:70,tz:66,type:'void_stalker'},
    {tx:74,tz:58,type:'wraith'},
    {tx:48,tz:70,type:'void_eye'},
    {tx:64,tz:72,type:'void_stalker'},
    {tx:72,tz:74,type:'void_phantom'},
    {tx:8,tz:44,type:'void_stalker'},
    {tx:20,tz:42,type:'void_eye'},
    {tx:32,tz:46,type:'wraith'},
    {tx:12,tz:52,type:'void_stalker'},
    {tx:26,tz:54,type:'void_eye'},
    {tx:6,tz:60,type:'void_phantom'},
    {tx:18,tz:58,type:'void_stalker'},
    {tx:34,tz:56,type:'void_eye'},
    {tx:14,tz:64,type:'void_stalker'},
    {tx:16,tz:66,type:'void_stalker'},
    {tx:12,tz:66,type:'void_eye'},
    {tx:18,tz:64,type:'void_eye'},
    {tx:14,tz:68,type:'wraith'},
    {tx:8,tz:72,type:'void_stalker'},
    {tx:28,tz:70,type:'void_eye'},
    {tx:22,tz:74,type:'void_phantom'},
    {tx:36,tz:68,type:'void_stalker'},
    {tx:10,tz:76,type:'void_eye'},
    {tx:30,tz:74,type:'wraith'},
    {tx:38,tz:14,type:'void_spike_horror'},
    {tx:66,tz:14,type:'void_spike_horror'},
    {tx:24,tz:38,type:'void_spike_horror'},
    {tx:58,tz:42,type:'void_spike_horror'},
    {tx:12,tz:56,type:'void_spike_horror'},
    {tx:44,tz:62,type:'void_spike_horror'},
    {tx:70,tz:52,type:'void_spike_horror'},
    {tx:36,tz:72,type:'void_spike_horror'}
  ],
  citadel: [
    {tx:8,tz:6,type:'iron_guard'},
    {tx:14,tz:6,type:'iron_guard'},
    {tx:20,tz:6,type:'iron_guard'},
    {tx:12,tz:10,type:'citadel_mage'},
    {tx:18,tz:10,type:'xu_shieldbot'},
    {tx:8,tz:14,type:'iron_guard'},
    {tx:14,tz:14,type:'xu_commander_elite'},
    {tx:22,tz:14,type:'citadel_mage'},
    {tx:10,tz:18,type:'iron_guard'},
    {tx:18,tz:18,type:'xu_sniper_elite'},
    {tx:48,tz:6,type:'iron_guard'},
    {tx:54,tz:6,type:'xu_sniper_elite'},
    {tx:60,tz:6,type:'iron_guard'},
    {tx:66,tz:6,type:'citadel_mage'},
    {tx:52,tz:10,type:'xu_shieldbot'},
    {tx:60,tz:10,type:'iron_guard'},
    {tx:56,tz:14,type:'xu_commander_elite'},
    {tx:64,tz:12,type:'xu_sniper_elite'},
    {tx:50,tz:16,type:'citadel_mage'},
    {tx:68,tz:16,type:'iron_guard'},
    {tx:6,tz:28,type:'iron_guard'},
    {tx:12,tz:26,type:'xu_shieldbot'},
    {tx:18,tz:28,type:'citadel_mage'},
    {tx:8,tz:34,type:'iron_guard'},
    {tx:14,tz:32,type:'xu_sniper_elite'},
    {tx:20,tz:34,type:'iron_guard'},
    {tx:10,tz:38,type:'xu_commander_elite'},
    {tx:18,tz:40,type:'citadel_mage'},
    {tx:6,tz:42,type:'iron_guard'},
    {tx:22,tz:38,type:'xu_shieldbot'},
    {tx:30,tz:28,type:'xu_sniper_elite'},
    {tx:38,tz:26,type:'iron_guard'},
    {tx:46,tz:28,type:'citadel_mage'},
    {tx:32,tz:34,type:'xu_shieldbot'},
    {tx:42,tz:32,type:'xu_commander_elite'},
    {tx:50,tz:34,type:'iron_guard'},
    {tx:28,tz:40,type:'iron_guard'},
    {tx:48,tz:42,type:'xu_sniper_elite'},
    {tx:36,tz:46,type:'citadel_mage'},
    {tx:44,tz:46,type:'iron_guard'},
    {tx:56,tz:26,type:'iron_guard'},
    {tx:64,tz:24,type:'xu_sniper_elite'},
    {tx:70,tz:26,type:'citadel_mage'},
    {tx:58,tz:32,type:'xu_shieldbot'},
    {tx:66,tz:30,type:'iron_guard'},
    {tx:74,tz:28,type:'xu_commander_elite'},
    {tx:60,tz:38,type:'iron_guard'},
    {tx:68,tz:38,type:'citadel_mage'},
    {tx:56,tz:44,type:'xu_sniper_elite'},
    {tx:72,tz:44,type:'iron_guard'},
    {tx:8,tz:52,type:'iron_guard'},
    {tx:16,tz:50,type:'xu_shieldbot'},
    {tx:22,tz:52,type:'citadel_mage'},
    {tx:10,tz:58,type:'iron_guard'},
    {tx:18,tz:56,type:'xu_commander_elite'},
    {tx:24,tz:60,type:'xu_sniper_elite'},
    {tx:8,tz:64,type:'iron_guard'},
    {tx:14,tz:64,type:'citadel_mage'},
    {tx:20,tz:66,type:'iron_guard'},
    {tx:26,tz:62,type:'xu_shieldbot'},
    {tx:26,tz:70,type:'iron_guard'},
    {tx:32,tz:68,type:'xu_sniper_elite'},
    {tx:50,tz:68,type:'iron_guard'},
    {tx:56,tz:70,type:'citadel_mage'},
    {tx:52,tz:52,type:'xu_shieldbot'},
    {tx:60,tz:50,type:'iron_guard'},
    {tx:68,tz:52,type:'citadel_mage'},
    {tx:54,tz:58,type:'xu_commander_elite'},
    {tx:62,tz:56,type:'iron_guard'},
    {tx:70,tz:58,type:'xu_sniper_elite'},
    {tx:56,tz:64,type:'iron_guard'},
    {tx:66,tz:64,type:'xu_shieldbot'},
    {tx:72,tz:62,type:'citadel_mage'},
    {tx:60,tz:68,type:'iron_guard'},
    {tx:36,tz:8,type:'iron_guard'},
    {tx:44,tz:8,type:'iron_guard'},
    {tx:30,tz:14,type:'citadel_mage'},
    {tx:50,tz:14,type:'xu_sniper_elite'},
    {tx:76,tz:14,type:'xu_sniper_elite'},
    {tx:76,tz:22,type:'citadel_mage'},
    {tx:76,tz:44,type:'iron_guard'},
    {tx:76,tz:52,type:'xu_sniper_elite'},
    {tx:4,tz:56,type:'iron_guard'},
    {tx:4,tz:64,type:'citadel_mage'},
    {tx:34,tz:72,type:'iron_guard'},
    {tx:48,tz:76,type:'iron_guard'}
  ],
  caves_of_despair: [
    {tx: 8,tz: 8,type:'xu_miner'}, {tx:14,tz: 6,type:'xu_miner'},
    {tx:18,tz:10,type:'xu_miner'}, {tx:22,tz: 8,type:'xu_overseer'},
    {tx:26,tz:10,type:'xu_miner'}, {tx:30,tz: 6,type:'xu_miner'},
    {tx:44,tz: 8,type:'xu_miner'}, {tx:52,tz: 6,type:'xu_overseer'},
    {tx:60,tz:10,type:'xu_miner'}, {tx:68,tz: 8,type:'xu_miner'},
    {tx:74,tz:12,type:'xu_miner'}, {tx: 6,tz:16,type:'xu_miner'},
    {tx: 8,tz:18,type:'xu_overseer'}, {tx:10,tz:16,type:'xu_miner'},
    {tx: 6,tz:20,type:'xu_miner'}, {tx:10,tz:20,type:'xu_miner'},
    {tx:32,tz:14,type:'xu_miner'}, {tx:34,tz:16,type:'xu_overseer'},
    {tx:36,tz:14,type:'xu_miner'}, {tx:32,tz:18,type:'xu_miner'},
    {tx:62,tz:16,type:'xu_miner'}, {tx:64,tz:18,type:'xu_overseer'},
    {tx:66,tz:16,type:'xu_miner'}, {tx:62,tz:20,type:'xu_miner'},
    {tx:14,tz:26,type:'xu_miner'}, {tx:16,tz:28,type:'xu_overseer'},
    {tx:18,tz:26,type:'xu_miner'}, {tx:14,tz:30,type:'xu_miner'},
    {tx:18,tz:30,type:'xu_miner'}, {tx:50,tz:26,type:'xu_miner'},
    {tx:52,tz:28,type:'xu_overseer'}, {tx:54,tz:26,type:'xu_miner'},
    {tx:50,tz:30,type:'xu_miner'}, {tx:54,tz:30,type:'xu_miner'},
    {tx:24,tz:24,type:'xu_miner'}, {tx:30,tz:26,type:'xu_miner'},
    {tx:40,tz:28,type:'xu_overseer'}, {tx:44,tz:26,type:'xu_miner'},
    {tx:60,tz:26,type:'xu_miner'}, {tx:68,tz:28,type:'xu_overseer'},
    {tx:74,tz:26,type:'xu_miner'}, {tx: 6,tz:28,type:'xu_overseer'},
    {tx: 8,tz:32,type:'xu_miner'}, {tx:22,tz:34,type:'xu_miner'},
    {tx:28,tz:32,type:'xu_miner'}, {tx:70,tz:32,type:'xu_overseer'},
    {tx:74,tz:34,type:'xu_miner'}, {tx: 6,tz:40,type:'xu_overseer'},
    {tx:10,tz:42,type:'xu_miner'}, {tx:14,tz:40,type:'xu_miner'},
    {tx:16,tz:42,type:'xu_overseer'}, {tx:60,tz:40,type:'xu_miner'},
    {tx:64,tz:42,type:'xu_overseer'}, {tx:70,tz:40,type:'xu_miner'},
    {tx:74,tz:42,type:'xu_miner'}, {tx:10,tz:50,type:'xu_miner'},
    {tx:12,tz:52,type:'xu_overseer'}, {tx:14,tz:50,type:'xu_miner'},
    {tx:10,tz:54,type:'xu_miner'}, {tx:14,tz:54,type:'xu_miner'},
    {tx:36,tz:50,type:'xu_overseer'}, {tx:38,tz:52,type:'xu_overseer'},
    {tx:40,tz:50,type:'xu_miner'}, {tx:36,tz:54,type:'xu_miner'},
    {tx:40,tz:54,type:'xu_miner'}, {tx:64,tz:50,type:'xu_miner'},
    {tx:66,tz:52,type:'xu_overseer'}, {tx:68,tz:50,type:'xu_miner'},
    {tx:64,tz:54,type:'xu_miner'}, {tx:68,tz:54,type:'xu_miner'},
    {tx:22,tz:48,type:'xu_miner'}, {tx:26,tz:52,type:'xu_miner'},
    {tx:30,tz:48,type:'xu_overseer'}, {tx:48,tz:48,type:'xu_miner'},
    {tx:54,tz:52,type:'xu_overseer'}, {tx:58,tz:48,type:'xu_miner'},
    {tx:22,tz:58,type:'xu_miner'}, {tx:28,tz:60,type:'xu_miner'},
    {tx:48,tz:58,type:'xu_overseer'}, {tx:54,tz:60,type:'xu_miner'},
    {tx:10,tz:66,type:'xu_overseer'}, {tx:12,tz:68,type:'xu_miner'},
    {tx:14,tz:66,type:'xu_overseer'}, {tx:10,tz:70,type:'xu_miner'},
    {tx:14,tz:70,type:'xu_miner'}, {tx:36,tz:68,type:'xu_overseer'},
    {tx:38,tz:66,type:'xu_overseer'}, {tx:40,tz:68,type:'xu_overseer'},
    {tx:36,tz:70,type:'xu_miner'}, {tx:40,tz:70,type:'xu_miner'},
    {tx:38,tz:72,type:'xu_miner'}, {tx:62,tz:66,type:'xu_overseer'},
    {tx:64,tz:68,type:'xu_miner'}, {tx:66,tz:66,type:'xu_overseer'},
    {tx:62,tz:70,type:'xu_miner'}, {tx:66,tz:70,type:'xu_miner'},
    {tx:20,tz:64,type:'xu_miner'}, {tx:26,tz:68,type:'xu_miner'},
    {tx:48,tz:66,type:'xu_miner'}, {tx:54,tz:68,type:'xu_overseer'},
    {tx:24,tz:74,type:'xu_miner'}, {tx:50,tz:74,type:'xu_miner'},
    {tx:72,tz:72,type:'xu_miner'},
  ],
  ashlands: [
    {tx:10,tz:8,type:'berserker'},
    {tx:22,tz:8,type:'berserker'},
    {tx:8,tz:15,type:'ash_wraith'},
    {tx:24,tz:20,type:'ash_wraith'},
    {tx:28,tz:26,type:'ash_wraith'},
    {tx:36,tz:30,type:'ash_wraith'},
    {tx:16,tz:34,type:'berserker'},
    {tx:38,tz:14,type:'berserker'},
    {tx:18,tz:12,type:'lava_golem'},
    {tx:22,tz:14,type:'lava_golem'},
    {tx:14,tz:18,type:'lava_golem'},
    {tx:30,tz:10,type:'lava_golem'},
    {tx:28,tz:30,type:'magma_crab'},
    {tx:32,tz:28,type:'magma_crab'},
    {tx:30,tz:32,type:'magma_crab'},
    {tx:26,tz:30,type:'berserker'},
    {tx:32,tz:32,type:'berserker'},
    {tx:36,tz:36,type:'berserker'},
    {tx:16,tz:6,type:'magma_crab'},
    {tx:28,tz:6,type:'magma_crab'},
    {tx:20,tz:14,type:'magma_crab'},
    {tx:10,tz:22,type:'magma_crab'},
    {tx:44,tz:8,type:'berserker'},
    {tx:54,tz:6,type:'ash_wraith'},
    {tx:62,tz:10,type:'berserker'},
    {tx:70,tz:8,type:'ash_wraith'},
    {tx:76,tz:14,type:'berserker'},
    {tx:48,tz:16,type:'ash_wraith'},
    {tx:66,tz:18,type:'berserker'},
    {tx:74,tz:22,type:'lava_golem'},
    {tx:56,tz:18,type:'lava_golem'},
    {tx:58,tz:20,type:'lava_golem'},
    {tx:54,tz:20,type:'lava_golem'},
    {tx:60,tz:18,type:'lava_golem'},
    {tx:56,tz:22,type:'berserker'},
    {tx:60,tz:22,type:'berserker'},
    {tx:60,tz:40,type:'magma_crab'},
    {tx:62,tz:42,type:'magma_crab'},
    {tx:58,tz:42,type:'magma_crab'},
    {tx:64,tz:40,type:'magma_crab'},
    {tx:60,tz:44,type:'berserker'},
    {tx:64,tz:44,type:'berserker'},
    {tx:56,tz:44,type:'lava_golem'},
    {tx:44,tz:34,type:'magma_crab'},
    {tx:52,tz:38,type:'berserker'},
    {tx:68,tz:34,type:'ash_wraith'},
    {tx:74,tz:40,type:'magma_crab'},
    {tx:46,tz:50,type:'berserker'},
    {tx:56,tz:52,type:'lava_golem'},
    {tx:66,tz:56,type:'ash_wraith'},
    {tx:72,tz:52,type:'berserker'},
    {tx:68,tz:62,type:'ash_wraith'},
    {tx:70,tz:64,type:'ash_wraith'},
    {tx:66,tz:64,type:'ash_wraith'},
    {tx:72,tz:62,type:'berserker'},
    {tx:42,tz:60,type:'magma_crab'},
    {tx:54,tz:66,type:'lava_golem'},
    {tx:64,tz:70,type:'berserker'},
    {tx:74,tz:70,type:'magma_crab'},
    {tx:8,tz:44,type:'berserker'},
    {tx:20,tz:42,type:'ash_wraith'},
    {tx:32,tz:46,type:'berserker'},
    {tx:12,tz:52,type:'lava_golem'},
    {tx:26,tz:54,type:'ash_wraith'},
    {tx:6,tz:60,type:'berserker'},
    {tx:18,tz:58,type:'lava_golem'},
    {tx:34,tz:56,type:'magma_crab'},
    {tx:14,tz:64,type:'lava_golem'},
    {tx:16,tz:66,type:'lava_golem'},
    {tx:12,tz:66,type:'berserker'},
    {tx:18,tz:64,type:'berserker'},
    {tx:14,tz:68,type:'magma_crab'},
    {tx:20,tz:68,type:'ash_wraith'},
    {tx:8,tz:72,type:'berserker'},
    {tx:28,tz:70,type:'lava_golem'},
    {tx:22,tz:74,type:'ash_wraith'},
    {tx:36,tz:68,type:'magma_crab'},
    {tx:10,tz:76,type:'berserker'},
    {tx:30,tz:74,type:'lava_golem'}
  ],
  sunken_sands: [
    {tx:14,tz:10,type:'sand_scorpion'},
    {tx:26,tz:8,type:'sand_scorpion'},
    {tx:38,tz:10,type:'sand_scorpion'},
    {tx:54,tz:8,type:'sand_scorpion'},
    {tx:66,tz:12,type:'sand_scorpion'},
    {tx:74,tz:18,type:'sand_scorpion'},
    {tx:20,tz:20,type:'sand_scorpion'},
    {tx:44,tz:18,type:'sand_scorpion'},
    {tx:60,tz:18,type:'sand_scorpion'},
    {tx:8,tz:16,type:'sand_scorpion'},
    {tx:10,tz:30,type:'sand_scorpion'},
    {tx:30,tz:28,type:'sand_scorpion'},
    {tx:50,tz:26,type:'sand_scorpion'},
    {tx:70,tz:26,type:'sand_scorpion'},
    {tx:14,tz:42,type:'sand_scorpion'},
    {tx:34,tz:40,type:'sand_scorpion'},
    {tx:52,tz:38,type:'sand_scorpion'},
    {tx:68,tz:40,type:'sand_scorpion'},
    {tx:76,tz:44,type:'sand_scorpion'},
    {tx:6,tz:36,type:'sand_scorpion'},
    {tx:20,tz:54,type:'sand_scorpion'},
    {tx:40,tz:52,type:'sand_scorpion'},
    {tx:58,tz:52,type:'sand_scorpion'},
    {tx:72,tz:54,type:'sand_scorpion'},
    {tx:10,tz:62,type:'sand_scorpion'},
    {tx:28,tz:64,type:'sand_scorpion'},
    {tx:46,tz:66,type:'sand_scorpion'},
    {tx:62,tz:64,type:'sand_scorpion'},
    {tx:76,tz:62,type:'sand_scorpion'},
    {tx:6,tz:58,type:'sand_scorpion'},
    {tx:32,tz:74,type:'sand_scorpion'},
    {tx:50,tz:72,type:'sand_scorpion'},
    {tx:68,tz:70,type:'sand_scorpion'},
    {tx:16,tz:72,type:'sand_scorpion'},
    {tx:18,tz:14,type:'desert_snake'},
    {tx:36,tz:12,type:'desert_snake'},
    {tx:58,tz:14,type:'desert_snake'},
    {tx:74,tz:20,type:'desert_snake'},
    {tx:8,tz:22,type:'desert_snake'},
    {tx:28,tz:22,type:'desert_snake'},
    {tx:48,tz:20,type:'desert_snake'},
    {tx:64,tz:22,type:'desert_snake'},
    {tx:12,tz:36,type:'desert_snake'},
    {tx:40,tz:34,type:'desert_snake'},
    {tx:62,tz:32,type:'desert_snake'},
    {tx:76,tz:36,type:'desert_snake'},
    {tx:22,tz:48,type:'desert_snake'},
    {tx:44,tz:46,type:'desert_snake'},
    {tx:64,tz:46,type:'desert_snake'},
    {tx:10,tz:52,type:'desert_snake'},
    {tx:34,tz:58,type:'desert_snake'},
    {tx:54,tz:60,type:'desert_snake'},
    {tx:72,tz:60,type:'desert_snake'},
    {tx:18,tz:70,type:'desert_snake'},
    {tx:38,tz:70,type:'desert_snake'},
    {tx:56,tz:74,type:'desert_snake'},
    {tx:74,tz:68,type:'desert_snake'},
    {tx:8,tz:68,type:'desert_snake'},
    {tx:26,tz:14,type:'desert_snake'},
    {tx:46,tz:10,type:'desert_snake'},
    {tx:24,tz:16,type:'sand_mummy'},
    {tx:48,tz:16,type:'sand_mummy'},
    {tx:70,tz:18,type:'sand_mummy'},
    {tx:16,tz:26,type:'sand_mummy'},
    {tx:38,tz:24,type:'sand_mummy'},
    {tx:58,tz:28,type:'sand_mummy'},
    {tx:76,tz:32,type:'sand_mummy'},
    {tx:26,tz:36,type:'sand_mummy'},
    {tx:48,tz:32,type:'sand_mummy'},
    {tx:66,tz:28,type:'sand_mummy'},
    {tx:20,tz:44,type:'sand_mummy'},
    {tx:42,tz:44,type:'sand_mummy'},
    {tx:62,tz:50,type:'sand_mummy'},
    {tx:14,tz:56,type:'sand_mummy'},
    {tx:36,tz:56,type:'sand_mummy'},
    {tx:54,tz:54,type:'sand_mummy'},
    {tx:72,tz:48,type:'sand_mummy'},
    {tx:8,tz:46,type:'sand_mummy'},
    {tx:28,tz:68,type:'sand_mummy'},
    {tx:50,tz:66,type:'sand_mummy'},
    {tx:70,tz:64,type:'sand_mummy'},
    {tx:12,tz:72,type:'sand_mummy'},
    {tx:20,tz:30,type:'dune_skeleton'},
    {tx:42,tz:28,type:'dune_skeleton'},
    {tx:62,tz:24,type:'dune_skeleton'},
    {tx:14,tz:46,type:'dune_skeleton'},
    {tx:36,tz:48,type:'dune_skeleton'},
    {tx:56,tz:44,type:'dune_skeleton'},
    {tx:74,tz:48,type:'dune_skeleton'},
    {tx:24,tz:60,type:'dune_skeleton'},
    {tx:46,tz:58,type:'dune_skeleton'},
    {tx:66,tz:56,type:'dune_skeleton'},
    {tx:32,tz:68,type:'dune_skeleton'},
    {tx:54,tz:68,type:'dune_skeleton'},
    {tx:10,tz:40,type:'dune_skeleton'},
    {tx:30,tz:42,type:'dune_skeleton'},
    {tx:52,tz:46,type:'dune_skeleton'},
    {tx:72,tz:42,type:'dune_skeleton'},
    {tx:18,tz:34,type:'dune_skeleton'},
    {tx:40,tz:62,type:'dune_skeleton'},
    {tx:60,tz:68,type:'dune_skeleton'},
    {tx:76,tz:56,type:'dune_skeleton'},
    {tx:30,tz:14,type:'sand_worm'},
    {tx:58,tz:20,type:'sand_worm'},
    {tx:16,tz:38,type:'sand_worm'},
    {tx:50,tz:40,type:'sand_worm'},
    {tx:70,tz:38,type:'sand_worm'},
    {tx:28,tz:56,type:'sand_worm'},
    {tx:60,tz:62,type:'sand_worm'},
    {tx:40,tz:70,type:'sand_worm'},
    {tx:10,tz:24,type:'sand_worm'},
    {tx:72,tz:28,type:'sand_worm'},
    {tx:34,tz:32,type:'sand_worm'},
    {tx:54,tz:34,type:'sand_worm'},
    {tx:22,tz:72,type:'sand_worm'},
    {tx:64,tz:74,type:'sand_worm'}
  ],
  frostveil: [
    {tx:10,tz:8,type:'frost_specter'},
    {tx:22,tz:8,type:'frost_specter'},
    {tx:16,tz:6,type:'polar_bear'},
    {tx:28,tz:6,type:'polar_bear'},
    {tx:20,tz:14,type:'polar_bear'},
    {tx:10,tz:22,type:'polar_bear'},
    {tx:24,tz:20,type:'frost_specter'},
    {tx:16,tz:34,type:'frost_specter'},
    {tx:38,tz:14,type:'polar_bear'},
    {tx:36,tz:30,type:'frost_specter'},
    {tx:20,tz:28,type:'frost_wraith'},
    {tx:22,tz:30,type:'frost_wraith'},
    {tx:18,tz:30,type:'frost_wraith'},
    {tx:24,tz:28,type:'frost_wraith'},
    {tx:16,tz:28,type:'frost_wraith'},
    {tx:30,tz:10,type:'frost_wraith'},
    {tx:32,tz:12,type:'frost_wraith'},
    {tx:8,tz:15,type:'ice_golem'},
    {tx:18,tz:20,type:'ice_golem'},
    {tx:12,tz:28,type:'ice_golem'},
    {tx:34,tz:24,type:'ice_golem'},
    {tx:32,tz:32,type:'ice_golem'},
    {tx:36,tz:36,type:'ice_golem'},
    {tx:44,tz:8,type:'frost_wraith'},
    {tx:52,tz:6,type:'frost_specter'},
    {tx:60,tz:8,type:'frost_wraith'},
    {tx:68,tz:6,type:'polar_bear'},
    {tx:74,tz:10,type:'frost_specter'},
    {tx:48,tz:16,type:'frost_wraith'},
    {tx:64,tz:14,type:'polar_bear'},
    {tx:72,tz:18,type:'frost_specter'},
    {tx:54,tz:22,type:'ice_golem'},
    {tx:56,tz:24,type:'ice_golem'},
    {tx:52,tz:24,type:'frost_wraith'},
    {tx:58,tz:22,type:'frost_wraith'},
    {tx:54,tz:26,type:'ice_golem'},
    {tx:58,tz:26,type:'ice_golem'},
    {tx:60,tz:50,type:'frost_wraith'},
    {tx:62,tz:52,type:'frost_wraith'},
    {tx:58,tz:52,type:'frost_wraith'},
    {tx:64,tz:50,type:'frost_wraith'},
    {tx:60,tz:54,type:'frost_wraith'},
    {tx:56,tz:50,type:'polar_bear'},
    {tx:66,tz:52,type:'frost_specter'},
    {tx:44,tz:34,type:'polar_bear'},
    {tx:56,tz:36,type:'frost_wraith'},
    {tx:68,tz:36,type:'ice_golem'},
    {tx:74,tz:42,type:'frost_wraith'},
    {tx:46,tz:46,type:'frost_specter'},
    {tx:58,tz:44,type:'ice_golem'},
    {tx:70,tz:46,type:'polar_bear'},
    {tx:44,tz:56,type:'frost_wraith'},
    {tx:52,tz:62,type:'frost_specter'},
    {tx:66,tz:64,type:'ice_golem'},
    {tx:72,tz:58,type:'frost_wraith'},
    {tx:46,tz:68,type:'polar_bear'},
    {tx:60,tz:70,type:'frost_wraith'},
    {tx:74,tz:72,type:'frost_specter'},
    {tx:8,tz:44,type:'frost_wraith'},
    {tx:20,tz:42,type:'frost_specter'},
    {tx:32,tz:46,type:'polar_bear'},
    {tx:12,tz:52,type:'frost_wraith'},
    {tx:26,tz:54,type:'ice_golem'},
    {tx:6,tz:60,type:'frost_specter'},
    {tx:18,tz:58,type:'frost_wraith'},
    {tx:34,tz:56,type:'polar_bear'},
    {tx:14,tz:64,type:'frost_wraith'},
    {tx:16,tz:66,type:'frost_wraith'},
    {tx:12,tz:66,type:'frost_wraith'},
    {tx:18,tz:64,type:'frost_specter'},
    {tx:14,tz:68,type:'ice_golem'},
    {tx:20,tz:68,type:'polar_bear'},
    {tx:8,tz:72,type:'frost_wraith'},
    {tx:28,tz:70,type:'ice_golem'},
    {tx:22,tz:74,type:'frost_specter'},
    {tx:36,tz:68,type:'frost_wraith'},
    {tx:10,tz:76,type:'polar_bear'},
    {tx:30,tz:74,type:'frost_wraith'}
  ],
  ancient: [
    {tx:10,tz:8,type:'vine_horror'},
    {tx:22,tz:8,type:'vine_horror'},
    {tx:16,tz:6,type:'void_stalker'},
    {tx:38,tz:14,type:'void_stalker'},
    {tx:8,tz:15,type:'void_stalker'},
    {tx:24,tz:20,type:'void_stalker'},
    {tx:34,tz:24,type:'void_stalker'},
    {tx:36,tz:30,type:'stone_sentinel'},
    {tx:20,tz:18,type:'ancient_guardian'},
    {tx:22,tz:18,type:'ancient_guardian'},
    {tx:18,tz:20,type:'ancient_guardian'},
    {tx:24,tz:22,type:'ancient_guardian'},
    {tx:10,tz:30,type:'ancient_guardian'},
    {tx:12,tz:32,type:'ancient_guardian'},
    {tx:26,tz:12,type:'vine_horror'},
    {tx:30,tz:18,type:'vine_horror'},
    {tx:28,tz:26,type:'vine_horror'},
    {tx:24,tz:34,type:'vine_horror'},
    {tx:28,tz:6,type:'stone_sentinel'},
    {tx:20,tz:14,type:'stone_sentinel'},
    {tx:10,tz:22,type:'stone_sentinel'},
    {tx:20,tz:28,type:'stone_sentinel'},
    {tx:16,tz:34,type:'stone_sentinel'},
    {tx:32,tz:32,type:'stone_sentinel'},
    {tx:36,tz:36,type:'vine_horror'},
    {tx:44,tz:8,type:'stone_sentinel'},
    {tx:52,tz:6,type:'vine_horror'},
    {tx:60,tz:8,type:'void_stalker'},
    {tx:68,tz:6,type:'stone_sentinel'},
    {tx:74,tz:10,type:'vine_horror'},
    {tx:48,tz:16,type:'void_stalker'},
    {tx:62,tz:14,type:'stone_sentinel'},
    {tx:70,tz:18,type:'ancient_guardian'},
    {tx:54,tz:26,type:'ancient_guardian'},
    {tx:56,tz:28,type:'ancient_guardian'},
    {tx:52,tz:28,type:'ancient_guardian'},
    {tx:58,tz:26,type:'ancient_guardian'},
    {tx:54,tz:30,type:'vine_horror'},
    {tx:58,tz:30,type:'vine_horror'},
    {tx:50,tz:26,type:'stone_sentinel'},
    {tx:60,tz:30,type:'stone_sentinel'},
    {tx:68,tz:28,type:'vine_horror'},
    {tx:70,tz:30,type:'vine_horror'},
    {tx:66,tz:30,type:'vine_horror'},
    {tx:72,tz:28,type:'stone_sentinel'},
    {tx:64,tz:28,type:'void_stalker'},
    {tx:44,tz:42,type:'stone_sentinel'},
    {tx:54,tz:44,type:'ancient_guardian'},
    {tx:66,tz:42,type:'void_stalker'},
    {tx:74,tz:44,type:'stone_sentinel'},
    {tx:46,tz:54,type:'vine_horror'},
    {tx:56,tz:58,type:'ancient_guardian'},
    {tx:68,tz:56,type:'stone_sentinel'},
    {tx:72,tz:60,type:'vine_horror'},
    {tx:56,tz:64,type:'ancient_guardian'},
    {tx:58,tz:66,type:'ancient_guardian'},
    {tx:54,tz:66,type:'ancient_guardian'},
    {tx:60,tz:64,type:'ancient_guardian'},
    {tx:56,tz:68,type:'vine_horror'},
    {tx:60,tz:68,type:'stone_sentinel'},
    {tx:44,tz:62,type:'void_stalker'},
    {tx:64,tz:70,type:'ancient_guardian'},
    {tx:72,tz:68,type:'stone_sentinel'},
    {tx:48,tz:72,type:'vine_horror'},
    {tx:60,tz:74,type:'ancient_guardian'},
    {tx:74,tz:74,type:'stone_sentinel'},
    {tx:8,tz:44,type:'ancient_guardian'},
    {tx:20,tz:42,type:'vine_horror'},
    {tx:32,tz:46,type:'void_stalker'},
    {tx:12,tz:52,type:'ancient_guardian'},
    {tx:26,tz:54,type:'stone_sentinel'},
    {tx:6,tz:60,type:'vine_horror'},
    {tx:18,tz:58,type:'ancient_guardian'},
    {tx:34,tz:56,type:'void_stalker'},
    {tx:14,tz:64,type:'ancient_guardian'},
    {tx:16,tz:66,type:'ancient_guardian'},
    {tx:12,tz:66,type:'ancient_guardian'},
    {tx:18,tz:64,type:'vine_horror'},
    {tx:14,tz:68,type:'stone_sentinel'},
    {tx:20,tz:68,type:'ancient_guardian'},
    {tx:8,tz:72,type:'vine_horror'},
    {tx:28,tz:70,type:'ancient_guardian'},
    {tx:22,tz:74,type:'void_stalker'},
    {tx:36,tz:68,type:'stone_sentinel'},
    {tx:10,tz:76,type:'ancient_guardian'},
    {tx:30,tz:74,type:'vine_horror'}
  ],
  dragonlair: [
    {tx:12,tz:8,type:'ancient_guardian'},
    {tx:16,tz:6,type:'citadel_mage'},
    {tx:8,tz:20,type:'ancient_guardian'},
    {tx:20,tz:8,type:'iron_guard'},
    {tx:30,tz:15,type:'fire_demon'},
    {tx:45,tz:20,type:'fire_demon'},
    {tx:35,tz:40,type:'fire_demon'},
    {tx:55,tz:30,type:'fire_demon'},
    {tx:25,tz:55,type:'fire_demon'},
    {tx:50,tz:55,type:'fire_demon'},
    {tx:38,tz:12,type:'wyvern'},
    {tx:55,tz:18,type:'wyvern'},
    {tx:22,tz:35,type:'wyvern'},
    {tx:60,tz:45,type:'wyvern'},
    {tx:40,tz:65,type:'wyvern'},
    {tx:8,tz:35,type:'void_spider'},
    {tx:15,tz:50,type:'void_spider'},
    {tx:65,tz:25,type:'void_spider'},
    {tx:70,tz:50,type:'void_spider'},
    {tx:30,tz:68,type:'void_spider'},
    {tx:55,tz:68,type:'void_spider'},
    {tx:45,tz:40,type:'inferno_golem'},
    {tx:60,tz:60,type:'inferno_golem'},
    {tx:30,tz:50,type:'inferno_golem'}
  ],
  riftvale: [
    {tx:10,tz:8,type:'rift_stalker'},
    {tx:16,tz:6,type:'rift_weaver'},
    {tx:22,tz:8,type:'rift_stalker'},
    {tx:28,tz:6,type:'psyche_horror'},
    {tx:8,tz:15,type:'rift_weaver'},
    {tx:14,tz:14,type:'rift_stalker'},
    {tx:20,tz:20,type:'rift_stalker'},
    {tx:22,tz:20,type:'rift_weaver'},
    {tx:18,tz:22,type:'psyche_horror'},
    {tx:24,tz:22,type:'rift_stalker'},
    {tx:30,tz:15,type:'psyche_horror'},
    {tx:32,tz:16,type:'rift_weaver'},
    {tx:35,tz:18,type:'void_colossus'},
    {tx:28,tz:24,type:'rift_stalker'},
    {tx:40,tz:25,type:'rift_stalker'},
    {tx:42,tz:22,type:'psyche_horror'},
    {tx:38,tz:28,type:'rift_weaver'},
    {tx:44,tz:28,type:'rift_stalker'},
    {tx:50,tz:20,type:'rift_stalker'},
    {tx:52,tz:18,type:'rift_weaver'},
    {tx:48,tz:22,type:'psyche_horror'},
    {tx:54,tz:22,type:'rift_stalker'},
    {tx:55,tz:30,type:'void_colossus'},
    {tx:45,tz:35,type:'psyche_horror'},
    {tx:20,tz:35,type:'rift_stalker'},
    {tx:22,tz:38,type:'rift_weaver'},
    {tx:18,tz:40,type:'psyche_horror'},
    {tx:26,tz:36,type:'rift_stalker'},
    {tx:30,tz:40,type:'rift_weaver'},
    {tx:32,tz:42,type:'rift_stalker'},
    {tx:28,tz:44,type:'psyche_horror'},
    {tx:34,tz:40,type:'void_colossus'},
    {tx:45,tz:45,type:'rift_stalker'},
    {tx:48,tz:42,type:'rift_weaver'},
    {tx:52,tz:46,type:'psyche_horror'},
    {tx:40,tz:48,type:'rift_stalker'},
    {tx:55,tz:50,type:'void_colossus'},
    {tx:60,tz:45,type:'rift_stalker'},
    {tx:58,tz:52,type:'psyche_horror'},
    {tx:62,tz:48,type:'rift_weaver'},
    {tx:65,tz:55,type:'rift_stalker'},
    {tx:68,tz:52,type:'rift_weaver'},
    {tx:62,tz:58,type:'psyche_horror'},
    {tx:70,tz:56,type:'rift_stalker'},
    {tx:72,tz:62,type:'void_colossus'},
    {tx:65,tz:65,type:'rift_stalker'},
    {tx:68,tz:68,type:'psyche_horror'},
    {tx:60,tz:70,type:'rift_weaver'},
    {tx:50,tz:65,type:'rift_stalker'},
    {tx:55,tz:68,type:'psyche_horror'},
    {tx:40,tz:65,type:'rift_weaver'},
    {tx:35,tz:68,type:'rift_stalker'},
    {tx:25,tz:62,type:'psyche_horror'},
    {tx:20,tz:65,type:'void_colossus'},
    {tx:15,tz:58,type:'rift_stalker'},
    {tx:10,tz:55,type:'rift_weaver'},
    {tx:8,tz:45,type:'psyche_horror'},
    {tx:12,tz:48,type:'rift_stalker'}
  ],
  wyvernwastes: [
    {tx:10,tz:8,type:'wyvern_warlord'},
    {tx:20,tz:6,type:'wyvern_warlord'},
    {tx:14,tz:14,type:'deep_wyrm'},
    {tx:28,tz:8,type:'elder_dragon'},
    {tx:8,tz:20,type:'wyvern_warlord'},
    {tx:22,tz:16,type:'deep_wyrm'},
    {tx:8,tz:28,type:'wyvern_warlord'},
    {tx:10,tz:30,type:'wyvern_warlord'},
    {tx:6,tz:30,type:'wyvern_warlord'},
    {tx:12,tz:28,type:'elder_dragon'},
    {tx:8,tz:34,type:'deep_wyrm'},
    {tx:14,tz:32,type:'deep_wyrm'},
    {tx:30,tz:10,type:'elder_dragon'},
    {tx:32,tz:12,type:'elder_dragon'},
    {tx:34,tz:8,type:'wyvern_warlord'},
    {tx:28,tz:18,type:'deep_wyrm'},
    {tx:36,tz:16,type:'wyvern_warlord'},
    {tx:18,tz:24,type:'deep_wyrm'},
    {tx:20,tz:26,type:'deep_wyrm'},
    {tx:22,tz:24,type:'deep_wyrm'},
    {tx:16,tz:26,type:'elder_dragon'},
    {tx:24,tz:28,type:'elder_dragon'},
    {tx:20,tz:32,type:'wyvern_warlord'},
    {tx:26,tz:22,type:'deep_wyrm'},
    {tx:8,tz:40,type:'elder_dragon'},
    {tx:18,tz:38,type:'wyvern_warlord'},
    {tx:28,tz:36,type:'deep_wyrm'},
    {tx:36,tz:34,type:'elder_dragon'},
    {tx:10,tz:48,type:'wyvern_warlord'},
    {tx:12,tz:50,type:'wyvern_warlord'},
    {tx:8,tz:50,type:'deep_wyrm'},
    {tx:22,tz:44,type:'elder_dragon'},
    {tx:24,tz:46,type:'elder_dragon'},
    {tx:34,tz:44,type:'wyvern_warlord'},
    {tx:44,tz:8,type:'wyvern_warlord'},
    {tx:54,tz:6,type:'elder_dragon'},
    {tx:62,tz:10,type:'wyvern_warlord'},
    {tx:72,tz:8,type:'deep_wyrm'},
    {tx:46,tz:18,type:'elder_dragon'},
    {tx:56,tz:16,type:'wyvern_warlord'},
    {tx:64,tz:14,type:'deep_wyrm'},
    {tx:74,tz:16,type:'elder_dragon'},
    {tx:44,tz:28,type:'wyvern_warlord'},
    {tx:46,tz:30,type:'wyvern_warlord'},
    {tx:42,tz:30,type:'elder_dragon'},
    {tx:56,tz:26,type:'deep_wyrm'},
    {tx:58,tz:28,type:'deep_wyrm'},
    {tx:68,tz:24,type:'elder_dragon'},
    {tx:76,tz:28,type:'wyvern_warlord'},
    {tx:42,tz:40,type:'deep_wyrm'},
    {tx:54,tz:38,type:'elder_dragon'},
    {tx:64,tz:36,type:'wyvern_warlord'},
    {tx:74,tz:40,type:'deep_wyrm'},
    {tx:44,tz:52,type:'elder_dragon'},
    {tx:46,tz:54,type:'elder_dragon'},
    {tx:56,tz:50,type:'wyvern_warlord'},
    {tx:58,tz:52,type:'deep_wyrm'},
    {tx:68,tz:50,type:'wyvern_warlord'},
    {tx:76,tz:54,type:'elder_dragon'},
    {tx:42,tz:64,type:'wyvern_warlord'},
    {tx:54,tz:62,type:'deep_wyrm'},
    {tx:62,tz:66,type:'elder_dragon'},
    {tx:72,tz:64,type:'wyvern_warlord'},
    {tx:44,tz:72,type:'deep_wyrm'},
    {tx:56,tz:70,type:'elder_dragon'},
    {tx:64,tz:74,type:'wyvern_warlord'},
    {tx:74,tz:72,type:'deep_wyrm'}
  ],
  xumen: [
    {tx:10,tz:8,type:'xu_titan'},
    {tx:18,tz:6,type:'xu_enforcer'},
    {tx:26,tz:8,type:'xu_titan'},
    {tx:14,tz:14,type:'xu_enforcer'},
    {tx:8,tz:16,type:'xu_supreme'},
    {tx:22,tz:14,type:'xu_titan'},
    {tx:10,tz:22,type:'xu_annihilator'},
    {tx:8,tz:24,type:'xu_titan'},
    {tx:12,tz:24,type:'xu_titan'},
    {tx:6,tz:26,type:'xu_enforcer'},
    {tx:14,tz:22,type:'xu_enforcer'},
    {tx:10,tz:28,type:'xu_supreme'},
    {tx:30,tz:8,type:'xu_supreme'},
    {tx:36,tz:6,type:'xu_titan'},
    {tx:34,tz:14,type:'xu_annihilator'},
    {tx:32,tz:16,type:'xu_supreme'},
    {tx:36,tz:16,type:'xu_titan'},
    {tx:28,tz:18,type:'xu_enforcer'},
    {tx:34,tz:20,type:'xu_enforcer'},
    {tx:20,tz:22,type:'xu_titan'},
    {tx:22,tz:24,type:'xu_annihilator'},
    {tx:18,tz:24,type:'xu_titan'},
    {tx:20,tz:26,type:'xu_supreme'},
    {tx:24,tz:20,type:'xu_enforcer'},
    {tx:16,tz:20,type:'xu_enforcer'},
    {tx:8,tz:36,type:'xu_enforcer'},
    {tx:14,tz:34,type:'xu_titan'},
    {tx:6,tz:42,type:'xu_titan'},
    {tx:8,tz:44,type:'xu_annihilator'},
    {tx:10,tz:46,type:'xu_titan'},
    {tx:12,tz:42,type:'xu_enforcer'},
    {tx:6,tz:48,type:'xu_supreme'},
    {tx:14,tz:48,type:'xu_enforcer'},
    {tx:28,tz:30,type:'xu_supreme'},
    {tx:34,tz:28,type:'xu_titan'},
    {tx:32,tz:36,type:'xu_annihilator'},
    {tx:30,tz:38,type:'xu_supreme'},
    {tx:34,tz:40,type:'xu_titan'},
    {tx:28,tz:40,type:'xu_enforcer'},
    {tx:36,tz:44,type:'xu_annihilator'},
    {tx:32,tz:44,type:'xu_supreme'},
    {tx:18,tz:36,type:'xu_titan'},
    {tx:22,tz:38,type:'xu_supreme'},
    {tx:16,tz:44,type:'xu_enforcer'},
    {tx:20,tz:46,type:'xu_titan'},
    {tx:24,tz:44,type:'xu_annihilator'},
    {tx:26,tz:48,type:'xu_supreme'},
    {tx:44,tz:8,type:'xu_enforcer'},
    {tx:50,tz:6,type:'xu_titan'},
    {tx:58,tz:8,type:'xu_annihilator'},
    {tx:64,tz:6,type:'xu_titan'},
    {tx:66,tz:8,type:'xu_supreme'},
    {tx:70,tz:10,type:'xu_enforcer'},
    {tx:74,tz:8,type:'xu_titan'},
    {tx:46,tz:18,type:'xu_titan'},
    {tx:54,tz:16,type:'xu_annihilator'},
    {tx:62,tz:18,type:'xu_supreme'},
    {tx:68,tz:20,type:'xu_titan'},
    {tx:72,tz:18,type:'xu_enforcer'},
    {tx:44,tz:28,type:'xu_supreme'},
    {tx:52,tz:26,type:'xu_annihilator'},
    {tx:60,tz:28,type:'xu_titan'},
    {tx:68,tz:30,type:'xu_supreme'},
    {tx:74,tz:28,type:'xu_annihilator'},
    {tx:46,tz:38,type:'xu_titan'},
    {tx:56,tz:36,type:'xu_enforcer'},
    {tx:64,tz:38,type:'xu_annihilator'},
    {tx:72,tz:40,type:'xu_supreme'},
    {tx:42,tz:48,type:'xu_enforcer'},
    {tx:50,tz:46,type:'xu_titan'},
    {tx:58,tz:48,type:'xu_supreme'},
    {tx:66,tz:46,type:'xu_annihilator'},
    {tx:74,tz:50,type:'xu_titan'},
    {tx:44,tz:58,type:'xu_supreme'},
    {tx:54,tz:56,type:'xu_annihilator'},
    {tx:62,tz:58,type:'xu_titan'},
    {tx:70,tz:60,type:'xu_supreme'},
    {tx:46,tz:68,type:'xu_enforcer'},
    {tx:56,tz:66,type:'xu_titan'},
    {tx:64,tz:68,type:'xu_annihilator'},
    {tx:72,tz:70,type:'xu_supreme'},
    {tx:8,tz:8,type:'xu_annihilator'},
    {tx:20,tz:6,type:'xu_annihilator'},
    {tx:36,tz:8,type:'xu_annihilator'},
    {tx:52,tz:6,type:'xu_annihilator'},
    {tx:68,tz:10,type:'xu_annihilator'},
    {tx:76,tz:24,type:'xu_annihilator'},
    {tx:74,tz:42,type:'xu_annihilator'},
    {tx:72,tz:58,type:'xu_annihilator'},
    {tx:60,tz:74,type:'xu_annihilator'},
    {tx:44,tz:76,type:'xu_annihilator'},
    {tx:28,tz:74,type:'xu_annihilator'},
    {tx:10,tz:68,type:'xu_annihilator'},
    {tx:6,tz:50,type:'xu_annihilator'},
    {tx:8,tz:34,type:'xu_annihilator'},
    {tx:38,tz:40,type:'xu_annihilator'}
  ],
  necropolis: [
    {tx:10,tz:8,type:'necro_specter'},
    {tx:18,tz:6,type:'necro_wight'},
    {tx:26,tz:8,type:'necro_specter'},
    {tx:14,tz:14,type:'necro_abomination'},
    {tx:8,tz:16,type:'necro_lich_mage'},
    {tx:22,tz:14,type:'necro_specter'},
    {tx:8,tz:22,type:'necro_wight'},
    {tx:10,tz:24,type:'necro_wight'},
    {tx:12,tz:22,type:'necro_specter'},
    {tx:6,tz:26,type:'necro_lich_mage'},
    {tx:14,tz:24,type:'necro_abomination'},
    {tx:10,tz:28,type:'necro_lich_mage'},
    {tx:30,tz:8,type:'necro_lich_mage'},
    {tx:36,tz:6,type:'necro_wight'},
    {tx:34,tz:14,type:'necro_abomination'},
    {tx:32,tz:16,type:'necro_lich_mage'},
    {tx:36,tz:16,type:'necro_wight'},
    {tx:28,tz:18,type:'necro_specter'},
    {tx:34,tz:20,type:'necro_specter'},
    {tx:20,tz:22,type:'necro_abomination'},
    {tx:22,tz:24,type:'necro_wight'},
    {tx:18,tz:24,type:'necro_specter'},
    {tx:20,tz:26,type:'necro_lich_mage'},
    {tx:24,tz:20,type:'necro_abomination'},
    {tx:16,tz:20,type:'necro_wight'},
    {tx:8,tz:36,type:'necro_specter'},
    {tx:14,tz:34,type:'necro_wight'},
    {tx:6,tz:42,type:'necro_wight'},
    {tx:8,tz:44,type:'necro_abomination'},
    {tx:10,tz:46,type:'necro_wight'},
    {tx:12,tz:42,type:'necro_specter'},
    {tx:6,tz:48,type:'necro_lich_mage'},
    {tx:28,tz:30,type:'necro_lich_mage'},
    {tx:34,tz:28,type:'necro_abomination'},
    {tx:32,tz:36,type:'necro_abomination'},
    {tx:30,tz:38,type:'necro_lich_mage'},
    {tx:34,tz:40,type:'necro_wight'},
    {tx:28,tz:40,type:'necro_specter'},
    {tx:36,tz:44,type:'necro_abomination'},
    {tx:44,tz:8,type:'necro_specter'},
    {tx:50,tz:6,type:'necro_wight'},
    {tx:58,tz:8,type:'necro_abomination'},
    {tx:64,tz:6,type:'necro_wight'},
    {tx:66,tz:8,type:'necro_lich_mage'},
    {tx:70,tz:10,type:'necro_specter'},
    {tx:74,tz:8,type:'necro_wight'},
    {tx:46,tz:18,type:'necro_wight'},
    {tx:54,tz:16,type:'necro_abomination'},
    {tx:62,tz:18,type:'necro_lich_mage'},
    {tx:68,tz:20,type:'necro_wight'},
    {tx:72,tz:18,type:'necro_specter'},
    {tx:44,tz:28,type:'necro_lich_mage'},
    {tx:52,tz:26,type:'necro_abomination'},
    {tx:60,tz:28,type:'necro_wight'},
    {tx:68,tz:30,type:'necro_lich_mage'},
    {tx:74,tz:28,type:'necro_abomination'},
    {tx:46,tz:38,type:'necro_wight'},
    {tx:56,tz:36,type:'necro_specter'},
    {tx:64,tz:38,type:'necro_abomination'},
    {tx:72,tz:40,type:'necro_lich_mage'},
    {tx:42,tz:48,type:'necro_specter'},
    {tx:50,tz:46,type:'necro_wight'},
    {tx:58,tz:48,type:'necro_lich_mage'},
    {tx:66,tz:46,type:'necro_abomination'},
    {tx:74,tz:50,type:'necro_wight'},
    {tx:44,tz:58,type:'necro_lich_mage'},
    {tx:54,tz:56,type:'necro_abomination'},
    {tx:62,tz:58,type:'necro_wight'},
    {tx:70,tz:60,type:'necro_specter'},
    {tx:46,tz:68,type:'necro_specter'},
    {tx:56,tz:66,type:'necro_wight'},
    {tx:64,tz:68,type:'necro_abomination'},
    {tx:72,tz:70,type:'necro_lich_mage'},
    {tx:36,tz:54,type:'necro_abomination'},
    {tx:38,tz:56,type:'necro_lich_mage'},
    {tx:34,tz:58,type:'necro_wight'},
    {tx:40,tz:60,type:'necro_abomination'},
    {tx:36,tz:62,type:'necro_lich_mage'},
    {tx:42,tz:62,type:'necro_wight'}
  ],
  xumen_fortress: [
    {tx:10,tz:8,type:'xf_titan_elite'},
    {tx:18,tz:6,type:'xf_fortress_drone'},
    {tx:26,tz:8,type:'xf_titan_elite'},
    {tx:14,tz:14,type:'xf_siege_walker'},
    {tx:8,tz:16,type:'xf_warlord'},
    {tx:22,tz:14,type:'xf_titan_elite'},
    {tx:8,tz:22,type:'xf_titan_elite'},
    {tx:10,tz:24,type:'xf_warlord'},
    {tx:12,tz:22,type:'xf_fortress_drone'},
    {tx:6,tz:26,type:'xf_fortress_drone'},
    {tx:14,tz:24,type:'xf_siege_walker'},
    {tx:10,tz:28,type:'xf_warlord'},
    {tx:30,tz:8,type:'xf_warlord'},
    {tx:36,tz:6,type:'xf_titan_elite'},
    {tx:34,tz:14,type:'xf_siege_walker'},
    {tx:32,tz:16,type:'xf_warlord'},
    {tx:36,tz:16,type:'xf_titan_elite'},
    {tx:28,tz:18,type:'xf_fortress_drone'},
    {tx:34,tz:20,type:'xf_fortress_drone'},
    {tx:20,tz:22,type:'xf_titan_elite'},
    {tx:22,tz:24,type:'xf_siege_walker'},
    {tx:18,tz:24,type:'xf_titan_elite'},
    {tx:20,tz:26,type:'xf_warlord'},
    {tx:24,tz:20,type:'xf_fortress_drone'},
    {tx:16,tz:20,type:'xf_siege_walker'},
    {tx:8,tz:36,type:'xf_fortress_drone'},
    {tx:14,tz:34,type:'xf_titan_elite'},
    {tx:6,tz:42,type:'xf_titan_elite'},
    {tx:8,tz:44,type:'xf_siege_walker'},
    {tx:10,tz:46,type:'xf_titan_elite'},
    {tx:12,tz:42,type:'xf_fortress_drone'},
    {tx:6,tz:48,type:'xf_warlord'},
    {tx:28,tz:30,type:'xf_warlord'},
    {tx:34,tz:28,type:'xf_titan_elite'},
    {tx:32,tz:36,type:'xf_siege_walker'},
    {tx:30,tz:38,type:'xf_warlord'},
    {tx:34,tz:40,type:'xf_titan_elite'},
    {tx:28,tz:40,type:'xf_fortress_drone'},
    {tx:36,tz:44,type:'xf_siege_walker'},
    {tx:44,tz:8,type:'xf_fortress_drone'},
    {tx:50,tz:6,type:'xf_titan_elite'},
    {tx:58,tz:8,type:'xf_siege_walker'},
    {tx:64,tz:6,type:'xf_titan_elite'},
    {tx:66,tz:8,type:'xf_warlord'},
    {tx:70,tz:10,type:'xf_fortress_drone'},
    {tx:74,tz:8,type:'xf_titan_elite'},
    {tx:46,tz:18,type:'xf_titan_elite'},
    {tx:54,tz:16,type:'xf_siege_walker'},
    {tx:62,tz:18,type:'xf_warlord'},
    {tx:68,tz:20,type:'xf_titan_elite'},
    {tx:72,tz:18,type:'xf_fortress_drone'},
    {tx:44,tz:28,type:'xf_warlord'},
    {tx:52,tz:26,type:'xf_siege_walker'},
    {tx:60,tz:28,type:'xf_titan_elite'},
    {tx:68,tz:30,type:'xf_warlord'},
    {tx:74,tz:28,type:'xf_siege_walker'},
    {tx:46,tz:38,type:'xf_titan_elite'},
    {tx:56,tz:36,type:'xf_fortress_drone'},
    {tx:64,tz:38,type:'xf_siege_walker'},
    {tx:72,tz:40,type:'xf_warlord'},
    {tx:42,tz:48,type:'xf_fortress_drone'},
    {tx:50,tz:46,type:'xf_titan_elite'},
    {tx:58,tz:48,type:'xf_warlord'},
    {tx:66,tz:46,type:'xf_siege_walker'},
    {tx:74,tz:50,type:'xf_titan_elite'},
    {tx:44,tz:58,type:'xf_warlord'},
    {tx:54,tz:56,type:'xf_siege_walker'},
    {tx:62,tz:58,type:'xf_titan_elite'},
    {tx:70,tz:60,type:'xf_warlord'},
    {tx:46,tz:68,type:'xf_fortress_drone'},
    {tx:56,tz:66,type:'xf_titan_elite'},
    {tx:64,tz:68,type:'xf_siege_walker'},
    {tx:72,tz:70,type:'xf_warlord'},
    {tx:36,tz:54,type:'xf_siege_walker'},
    {tx:38,tz:56,type:'xf_warlord'},
    {tx:34,tz:58,type:'xf_titan_elite'},
    {tx:40,tz:60,type:'xf_siege_walker'},
    {tx:36,tz:62,type:'xf_warlord'},
    {tx:42,tz:62,type:'xf_titan_elite'},
    {tx:38,tz:64,type:'xf_siege_walker'},
    {tx:40,tz:66,type:'xf_warlord'}
  ],
  fungal: [
    {tx:10,tz:8,type:'mushroom_man'},
    {tx:28,tz:6,type:'spore_walker'},
    {tx:22,tz:8,type:'mushroom_man'},
    {tx:10,tz:22,type:'spore_walker'},
    {tx:24,tz:20,type:'mushroom_man'},
    {tx:28,tz:26,type:'spore_walker'},
    {tx:16,tz:34,type:'mushroom_man'},
    {tx:36,tz:30,type:'mushroom_man'},
    {tx:14,tz:12,type:'fungal_shambler'},
    {tx:18,tz:14,type:'fungal_shambler'},
    {tx:12,tz:16,type:'fungal_shambler'},
    {tx:16,tz:10,type:'fungal_shambler'},
    {tx:30,tz:28,type:'fungal_shambler'},
    {tx:32,tz:30,type:'fungal_shambler'},
    {tx:28,tz:32,type:'fungal_shambler'},
    {tx:8,tz:15,type:'mycelium_horror'},
    {tx:18,tz:20,type:'mycelium_horror'},
    {tx:12,tz:28,type:'mycelium_horror'},
    {tx:34,tz:24,type:'mycelium_horror'},
    {tx:32,tz:32,type:'mycelium_horror'},
    {tx:38,tz:14,type:'spore_walker'},
    {tx:36,tz:36,type:'mycelium_horror'},
    {tx:24,tz:34,type:'spore_walker'},
    {tx:44,tz:8,type:'mushroom_man'},
    {tx:52,tz:6,type:'fungal_shambler'},
    {tx:60,tz:8,type:'mushroom_man'},
    {tx:68,tz:10,type:'spore_walker'},
    {tx:74,tz:8,type:'fungal_shambler'},
    {tx:48,tz:18,type:'mushroom_man'},
    {tx:64,tz:16,type:'spore_walker'},
    {tx:72,tz:20,type:'fungal_shambler'},
    {tx:54,tz:26,type:'fungal_shambler'},
    {tx:56,tz:28,type:'fungal_shambler'},
    {tx:52,tz:28,type:'fungal_shambler'},
    {tx:58,tz:26,type:'fungal_shambler'},
    {tx:54,tz:30,type:'mycelium_horror'},
    {tx:58,tz:30,type:'mycelium_horror'},
    {tx:50,tz:26,type:'spore_walker'},
    {tx:60,tz:28,type:'spore_walker'},
    {tx:44,tz:30,type:'mycelium_horror'},
    {tx:66,tz:28,type:'fungal_shambler'},
    {tx:72,tz:32,type:'spore_walker'},
    {tx:46,tz:40,type:'mushroom_man'},
    {tx:58,tz:42,type:'mycelium_horror'},
    {tx:68,tz:40,type:'fungal_shambler'},
    {tx:56,tz:56,type:'fungal_shambler'},
    {tx:58,tz:58,type:'fungal_shambler'},
    {tx:54,tz:58,type:'fungal_shambler'},
    {tx:60,tz:56,type:'fungal_shambler'},
    {tx:56,tz:60,type:'mycelium_horror'},
    {tx:60,tz:60,type:'spore_walker'},
    {tx:52,tz:60,type:'fungal_shambler'},
    {tx:44,tz:52,type:'fungal_shambler'},
    {tx:66,tz:50,type:'mycelium_horror'},
    {tx:72,tz:56,type:'mushroom_man'},
    {tx:46,tz:64,type:'spore_walker'},
    {tx:60,tz:68,type:'fungal_shambler'},
    {tx:70,tz:68,type:'mycelium_horror'},
    {tx:74,tz:62,type:'mushroom_man'},
    {tx:48,tz:74,type:'fungal_shambler'},
    {tx:8,tz:44,type:'fungal_shambler'},
    {tx:20,tz:42,type:'mushroom_man'},
    {tx:32,tz:46,type:'spore_walker'},
    {tx:12,tz:52,type:'fungal_shambler'},
    {tx:26,tz:54,type:'mushroom_man'},
    {tx:6,tz:60,type:'fungal_shambler'},
    {tx:18,tz:58,type:'mycelium_horror'},
    {tx:34,tz:56,type:'spore_walker'},
    {tx:14,tz:64,type:'fungal_shambler'},
    {tx:16,tz:66,type:'fungal_shambler'},
    {tx:12,tz:66,type:'fungal_shambler'},
    {tx:18,tz:64,type:'spore_walker'},
    {tx:14,tz:68,type:'mycelium_horror'},
    {tx:20,tz:68,type:'fungal_shambler'},
    {tx:8,tz:72,type:'mushroom_man'},
    {tx:28,tz:70,type:'fungal_shambler'},
    {tx:22,tz:74,type:'spore_walker'},
    {tx:36,tz:68,type:'mycelium_horror'},
    {tx:10,tz:76,type:'fungal_shambler'},
    {tx:30,tz:74,type:'mushroom_man'}
  ],
  void_citadel: [
    {tx: 8,tz: 8,type:'void_construct'}, {tx:10,tz:10,type:'void_sentinel'},
    {tx:12,tz: 8,type:'void_construct'}, {tx:10,tz: 6,type:'rift_stalker'},
    {tx: 8,tz:12,type:'rift_weaver'}, {tx:36,tz: 8,type:'void_sentinel'},
    {tx:38,tz:10,type:'void_construct'}, {tx:40,tz: 8,type:'void_sentinel'},
    {tx:42,tz:10,type:'void_construct'}, {tx:38,tz: 6,type:'rift_stalker'},
    {tx:68,tz: 8,type:'void_construct'}, {tx:70,tz:10,type:'void_sentinel'},
    {tx:72,tz: 8,type:'void_construct'}, {tx:70,tz: 6,type:'rift_weaver'},
    {tx:68,tz:12,type:'rift_stalker'}, {tx:18,tz: 6,type:'void_construct'},
    {tx:24,tz:10,type:'rift_stalker'}, {tx:30,tz: 6,type:'void_sentinel'},
    {tx:48,tz: 6,type:'void_construct'}, {tx:54,tz:10,type:'rift_weaver'},
    {tx:60,tz: 6,type:'void_sentinel'}, {tx:16,tz:14,type:'void_construct'},
    {tx:22,tz:16,type:'rift_stalker'}, {tx:46,tz:14,type:'void_construct'},
    {tx:56,tz:16,type:'void_sentinel'}, {tx:62,tz:14,type:'rift_weaver'},
    {tx:14,tz:26,type:'void_sentinel'}, {tx:16,tz:28,type:'void_construct'},
    {tx:18,tz:26,type:'void_sentinel'}, {tx:14,tz:30,type:'rift_stalker'},
    {tx:18,tz:30,type:'rift_weaver'}, {tx:62,tz:26,type:'void_sentinel'},
    {tx:64,tz:28,type:'void_construct'}, {tx:66,tz:26,type:'void_sentinel'},
    {tx:62,tz:30,type:'rift_weaver'}, {tx:66,tz:30,type:'rift_stalker'},
    {tx:26,tz:26,type:'void_construct'}, {tx:32,tz:28,type:'rift_stalker'},
    {tx:48,tz:28,type:'void_sentinel'}, {tx:54,tz:26,type:'rift_weaver'},
    {tx:30,tz:34,type:'void_construct'}, {tx:50,tz:34,type:'void_sentinel'},
    {tx:22,tz:34,type:'rift_stalker'}, {tx:58,tz:34,type:'rift_weaver'},
    {tx:10,tz:22,type:'void_construct'}, {tx:10,tz:32,type:'void_sentinel'},
    {tx:70,tz:22,type:'void_construct'}, {tx:70,tz:32,type:'void_sentinel'},
    {tx:10,tz:40,type:'void_construct'}, {tx:12,tz:38,type:'rift_stalker'},
    {tx:14,tz:42,type:'void_sentinel'}, {tx:70,tz:40,type:'void_construct'},
    {tx:68,tz:38,type:'rift_stalker'}, {tx:66,tz:42,type:'void_sentinel'},
    {tx:14,tz:50,type:'void_sentinel'}, {tx:16,tz:52,type:'void_construct'},
    {tx:18,tz:50,type:'void_sentinel'}, {tx:14,tz:54,type:'rift_stalker'},
    {tx:18,tz:54,type:'rift_weaver'}, {tx:62,tz:50,type:'void_sentinel'},
    {tx:64,tz:52,type:'void_construct'}, {tx:66,tz:50,type:'void_sentinel'},
    {tx:62,tz:54,type:'rift_weaver'}, {tx:66,tz:54,type:'rift_stalker'},
    {tx:26,tz:50,type:'void_construct'}, {tx:32,tz:48,type:'rift_stalker'},
    {tx:48,tz:48,type:'void_sentinel'}, {tx:54,tz:50,type:'rift_weaver'},
    {tx:22,tz:56,type:'void_construct'}, {tx:30,tz:56,type:'void_sentinel'},
    {tx:50,tz:56,type:'rift_stalker'}, {tx:58,tz:56,type:'rift_weaver'},
    {tx:10,tz:50,type:'void_construct'}, {tx:70,tz:50,type:'void_construct'},
    {tx:10,tz:66,type:'void_construct'}, {tx:12,tz:68,type:'void_sentinel'},
    {tx:14,tz:66,type:'void_construct'}, {tx:12,tz:64,type:'rift_stalker'},
    {tx:10,tz:70,type:'rift_weaver'}, {tx:38,tz:66,type:'void_sentinel'},
    {tx:40,tz:68,type:'void_construct'}, {tx:42,tz:66,type:'void_sentinel'},
    {tx:40,tz:64,type:'rift_weaver'}, {tx:38,tz:70,type:'rift_stalker'},
    {tx:42,tz:70,type:'void_construct'}, {tx:66,tz:66,type:'void_construct'},
    {tx:68,tz:68,type:'void_sentinel'}, {tx:70,tz:66,type:'void_construct'},
    {tx:68,tz:64,type:'rift_stalker'}, {tx:70,tz:70,type:'rift_weaver'},
    {tx:20,tz:62,type:'void_construct'}, {tx:24,tz:66,type:'rift_stalker'},
    {tx:30,tz:62,type:'void_sentinel'}, {tx:50,tz:62,type:'void_construct'},
    {tx:56,tz:66,type:'rift_weaver'}, {tx:60,tz:62,type:'void_sentinel'},
    {tx:22,tz:72,type:'void_construct'}, {tx:30,tz:74,type:'rift_stalker'},
    {tx:50,tz:74,type:'rift_weaver'}, {tx:58,tz:72,type:'void_sentinel'},
    {tx:14,tz:74,type:'void_sentinel'}, {tx:66,tz:74,type:'void_sentinel'},
  ],
  // ── NEON HOLLOW — POST-CAP AA-GATED (matches client ZONE_DEFS.neon_hollow) ──
  neon_hollow: [
    // Entry boulevard sentinel drones
    {tx:12,tz:36,type:'sentinel_drone'}, {tx:14,tz:44,type:'sentinel_drone'},
    {tx:16,tz:38,type:'sentinel_drone'}, {tx:16,tz:42,type:'sentinel_drone'},
    // Camp A1 — outer tower plaza NW
    {tx:18,tz:12,type:'maintenance_striker'}, {tx:22,tz:14,type:'maintenance_striker'},
    {tx:24,tz:18,type:'maintenance_striker'}, {tx:20,tz:16,type:'sentinel_drone'},
    {tx:26,tz:12,type:'sentinel_drone'},
    // Camp A2 — north skybridge
    {tx:30,tz:8,type:'skybridge_sniper'},  {tx:34,tz:10,type:'skybridge_sniper'},
    {tx:38,tz:8,type:'skybridge_sniper'},  {tx:32,tz:14,type:'sentinel_drone'},
    {tx:36,tz:12,type:'sentinel_drone'},
    // Camp A3 — NE tower base
    {tx:52,tz:10,type:'maintenance_striker'}, {tx:56,tz:8,type:'maintenance_striker'},
    {tx:58,tz:14,type:'hollow_enforcer'}, {tx:62,tz:12,type:'sentinel_drone'},
    // Camp A4 — NE far edge patrol
    {tx:68,tz:14,type:'sentinel_drone'}, {tx:72,tz:18,type:'sentinel_drone'},
    {tx:74,tz:22,type:'sentinel_drone'}, {tx:70,tz:12,type:'skybridge_sniper'},
    {tx:76,tz:16,type:'maintenance_striker'},
    // North corridor patrol
    {tx:8,tz:22,type:'sentinel_drone'},  {tx:14,tz:24,type:'sentinel_drone'},
    {tx:28,tz:22,type:'sentinel_drone'}, {tx:42,tz:18,type:'maintenance_striker'},
    {tx:48,tz:22,type:'sentinel_drone'}, {tx:64,tz:24,type:'maintenance_striker'},
    // Camp B1 — warship docks mid-west
    {tx:12,tz:46,type:'hollow_enforcer'}, {tx:16,tz:48,type:'hollow_enforcer'},
    {tx:20,tz:50,type:'hollow_enforcer'}, {tx:14,tz:52,type:'maintenance_striker'},
    {tx:22,tz:46,type:'maintenance_striker'},
    // Camp B2 — mid-central neon wraiths
    {tx:28,tz:30,type:'neon_wraith'}, {tx:32,tz:28,type:'neon_wraith'},
    {tx:36,tz:32,type:'hollow_enforcer'}, {tx:30,tz:34,type:'sentinel_drone'},
    // Camp B3 — neon strip east
    {tx:52,tz:30,type:'sentinel_drone'}, {tx:56,tz:34,type:'sentinel_drone'},
    {tx:58,tz:30,type:'crash_car'}, {tx:54,tz:36,type:'skybridge_sniper'},
    // Mid corridor
    {tx:14,tz:42,type:'neon_wraith'}, {tx:20,tz:48,type:'neon_wraith'},
    {tx:28,tz:46,type:'hollow_enforcer'}, {tx:32,tz:50,type:'crash_car'},
    {tx:48,tz:48,type:'crash_car'}, {tx:52,tz:46,type:'hollow_enforcer'},
    {tx:60,tz:50,type:'skybridge_sniper'}, {tx:66,tz:46,type:'neon_wraith'},
    // Camp C1 — SW tower base
    {tx:8,tz:60,type:'maintenance_striker'}, {tx:12,tz:62,type:'maintenance_striker'},
    {tx:14,tz:58,type:'neon_wraith'}, {tx:16,tz:66,type:'neon_wraith'},
    {tx:10,tz:68,type:'hollow_enforcer'},
    // Camp C2 — deep district gate
    {tx:22,tz:62,type:'hollow_enforcer'}, {tx:26,tz:66,type:'hollow_enforcer'},
    {tx:30,tz:62,type:'neon_wraith'}, {tx:28,tz:68,type:'skybridge_sniper'},
    {tx:32,tz:64,type:'neon_wraith'},
    // Camp C3 — SE tower base
    {tx:52,tz:60,type:'neon_wraith'}, {tx:56,tz:64,type:'neon_wraith'},
    {tx:58,tz:58,type:'skybridge_sniper'}, {tx:62,tz:62,type:'skybridge_sniper'},
    {tx:60,tz:66,type:'hollow_enforcer'},
    // Camp C4 — far south edge
    {tx:38,tz:72,type:'neon_wraith'}, {tx:42,tz:74,type:'neon_wraith'},
    {tx:44,tz:70,type:'hollow_enforcer'}, {tx:46,tz:76,type:'crash_car'},
    // South patrols
    {tx:6,tz:56,type:'neon_wraith'}, {tx:18,tz:70,type:'hollow_enforcer'},
    {tx:36,tz:58,type:'skybridge_sniper'}, {tx:44,tz:62,type:'neon_wraith'},
    {tx:66,tz:58,type:'maintenance_striker'}, {tx:72,tz:62,type:'neon_wraith'},
    {tx:74,tz:70,type:'skybridge_sniper'}, {tx:68,tz:74,type:'hollow_enforcer'},
    // Far east deep district
    {tx:70,tz:30,type:'sentinel_drone'}, {tx:74,tz:34,type:'neon_wraith'},
    {tx:78,tz:38,type:'skybridge_sniper'}, {tx:72,tz:42,type:'hollow_enforcer'},
    {tx:76,tz:46,type:'maintenance_striker'}, {tx:68,tz:48,type:'neon_wraith'},
  ],
  // ── VEILED SANCTUARY (v92.41) — matches client ZONE_DEFS.veiled_sanctuary ──
  veiled_sanctuary: [
    // ENTRANCE PROCESSION (west side)
    {tx:14,tz:36, type:'veiled_acolyte'}, {tx:16,tz:42, type:'veiled_acolyte'},
    {tx:18,tz:38, type:'censer_bearer'},  {tx:20,tz:44, type:'penitent_striker'},
    {tx:22,tz:36, type:'veiled_acolyte'}, {tx:24,tz:42, type:'choir_wraith'},
    // INNER COURTYARD
    {tx:28,tz:30, type:'stone_inquisitor'}, {tx:30,tz:36, type:'censer_bearer'},
    {tx:32,tz:42, type:'choir_wraith'},     {tx:34,tz:48, type:'penitent_striker'},
    {tx:36,tz:30, type:'ritual_guardian'},  {tx:38,tz:42, type:'veiled_acolyte'},
    {tx:40,tz:36, type:'stone_inquisitor'}, {tx:42,tz:48, type:'censer_bearer'},
    {tx:44,tz:30, type:'choir_wraith'},     {tx:46,tz:42, type:'penitent_striker'},
    // CARDINAL'S COURT (mini-boss)
    {tx:50,tz:40, type:'veiled_cardinal'},
    {tx:52,tz:34, type:'veiled_acolyte'},   {tx:52,tz:46, type:'veiled_acolyte'},
    {tx:54,tz:38, type:'ritual_guardian'},  {tx:54,tz:42, type:'ritual_guardian'},
    // FORSAKEN HALL
    {tx:60,tz:34, type:'choir_wraith'},     {tx:60,tz:46, type:'choir_wraith'},
    {tx:62,tz:40, type:'forsaken_abbot'},   // mini-boss
    {tx:64,tz:36, type:'stone_inquisitor'}, {tx:64,tz:44, type:'stone_inquisitor'},
    {tx:66,tz:38, type:'penitent_striker'}, {tx:66,tz:42, type:'penitent_striker'},
    // FINAL APPROACH
    {tx:70,tz:38, type:'ritual_guardian'},  {tx:70,tz:42, type:'ritual_guardian'},
    {tx:72,tz:40, type:'censer_bearer'},
  ],
  // ── BLOOMING WILDS (v92.49+v92.50) — matches client ZONE_DEFS.blooming_wilds ──
  blooming_wilds: [
    // ENTRANCE GLADE (south, z 60-74) — 3 fairy camps + roaming brutes
    {tx:22,tz:66, type:'bloom_sprite'},   {tx:22,tz:70, type:'bloom_sprite'},
    {tx:18,tz:68, type:'glimmer_fairy'},  {tx:24,tz:64, type:'glimmer_fairy'},
    {tx:58,tz:66, type:'bloom_sprite'},   {tx:58,tz:70, type:'bloom_sprite'},
    {tx:62,tz:68, type:'glimmer_fairy'},  {tx:56,tz:64, type:'glimmer_fairy'},
    {tx:36,tz:62, type:'mushroom_brute'},{tx:44,tz:62, type:'mushroom_brute'},
    {tx:30,tz:72, type:'bloom_sprite'},   {tx:50,tz:72, type:'bloom_sprite'},

    // PETAL CLEARING (mid-south, z 48-58)
    {tx:16,tz:50, type:'vine_stalker'},   {tx:18,tz:54, type:'vine_stalker'},
    {tx:14,tz:52, type:'pollen_wraith'},
    {tx:64,tz:50, type:'vine_stalker'},   {tx:62,tz:54, type:'vine_stalker'},
    {tx:66,tz:52, type:'pollen_wraith'},
    {tx:38,tz:46, type:'mushroom_brute'},{tx:42,tz:46, type:'mushroom_brute'},
    {tx:28,tz:50, type:'glimmer_fairy'},  {tx:52,tz:50, type:'glimmer_fairy'},
    {tx:32,tz:54, type:'bloom_sprite'},   {tx:48,tz:54, type:'bloom_sprite'},

    // ROSE GARDEN (mid, z 36-46) — Thorn Knight mini-boss + court
    {tx:40,tz:40, type:'thorn_knight'},
    {tx:34,tz:38, type:'vine_stalker'},   {tx:46,tz:38, type:'vine_stalker'},
    {tx:34,tz:42, type:'vine_stalker'},
    {tx:18,tz:38, type:'pollen_wraith'},  {tx:22,tz:42, type:'pollen_wraith'},
    {tx:20,tz:40, type:'bloom_sprite'},   {tx:24,tz:38, type:'bloom_sprite'},
    {tx:60,tz:38, type:'pollen_wraith'},  {tx:56,tz:42, type:'pollen_wraith'},
    {tx:58,tz:40, type:'bloom_sprite'},   {tx:54,tz:38, type:'bloom_sprite'},

    // MUSHROOM RING (mid-north, z 24-34) — signature ring camp
    {tx:32,tz:26, type:'mushroom_brute'},
    {tx:48,tz:26, type:'mushroom_brute'},
    {tx:32,tz:32, type:'mushroom_brute'},
    {tx:48,tz:32, type:'mushroom_brute'},
    {tx:40,tz:28, type:'pollen_wraith'},  {tx:40,tz:30, type:'pollen_wraith'},
    {tx:18,tz:28, type:'glimmer_fairy'},  {tx:14,tz:30, type:'vine_stalker'},
    {tx:16,tz:26, type:'bloom_sprite'},
    {tx:62,tz:28, type:'glimmer_fairy'},  {tx:66,tz:30, type:'vine_stalker'},
    {tx:64,tz:26, type:'bloom_sprite'},

    // WILDMOTHER'S APPROACH (z 12-22)
    {tx:24,tz:18, type:'vine_stalker'},   {tx:20,tz:14, type:'vine_stalker'},
    {tx:22,tz:20, type:'pollen_wraith'},
    {tx:56,tz:18, type:'vine_stalker'},   {tx:60,tz:14, type:'vine_stalker'},
    {tx:58,tz:20, type:'pollen_wraith'},
    {tx:34,tz:16, type:'bloom_sprite'},   {tx:46,tz:16, type:'bloom_sprite'},
    {tx:36,tz:20, type:'glimmer_fairy'},  {tx:44,tz:20, type:'glimmer_fairy'},
    {tx:40,tz:18, type:'pollen_wraith'},
    {tx:30,tz:12, type:'mushroom_brute'},{tx:50,tz:12, type:'mushroom_brute'},
  ],
  // ── XERON (v92.55+v92.58) — matches client ZONE_DEFS.xeron ──
  xeron: [
    // DOCKING SPIRE (entry, central z 38-42)
    {tx:14,tz:36, type:'corrupted_xu'},     {tx:14,tz:44, type:'corrupted_xu'},
    {tx:18,tz:38, type:'corrupted_xu'},     {tx:18,tz:42, type:'corrupted_xu'},
    {tx:22,tz:36, type:'holo_wraith'},      {tx:22,tz:44, type:'holo_wraith'},
    {tx:10,tz:32, type:'corrupted_xu'},     {tx:10,tz:48, type:'corrupted_xu'},
    {tx:14,tz:30, type:'holo_wraith'},      {tx:14,tz:50, type:'holo_wraith'},
    {tx:20,tz:34, type:'void_marine'},      {tx:20,tz:46, type:'void_marine'},
    // LOWER INDUSTRIAL — 2 camps with turrets
    {tx:26,tz:30, type:'void_marine'},      {tx:28,tz:32, type:'void_marine'},
    {tx:30,tz:30, type:'void_marine'},      {tx:24,tz:34, type:'laser_turret'},
    {tx:26,tz:36, type:'corrupted_xu'},
    {tx:28,tz:48, type:'void_marine'},      {tx:30,tz:50, type:'void_marine'},
    {tx:26,tz:50, type:'corrupted_xu'},     {tx:24,tz:46, type:'laser_turret'},
    {tx:32,tz:48, type:'holo_wraith'},
    {tx:32,tz:30, type:'corrupted_xu'},     {tx:32,tz:50, type:'corrupted_xu'},
    {tx:36,tz:32, type:'holo_wraith'},      {tx:36,tz:48, type:'holo_wraith'},
    {tx:30,tz:36, type:'corrupted_xu'},     {tx:30,tz:44, type:'corrupted_xu'},
    {tx:34,tz:36, type:'void_marine'},      {tx:34,tz:44, type:'void_marine'},
    // PLAZA OF SPIRES
    {tx:42,tz:40, type:'shard_assassin'},
    {tx:38,tz:32, type:'holo_wraith'},      {tx:38,tz:48, type:'holo_wraith'},
    {tx:42,tz:30, type:'corrupted_xu'},     {tx:42,tz:50, type:'corrupted_xu'},
    {tx:46,tz:34, type:'laser_turret'},     {tx:46,tz:46, type:'laser_turret'},
    {tx:44,tz:38, type:'void_marine'},      {tx:44,tz:42, type:'void_marine'},
    {tx:40,tz:34, type:'corrupted_xu'},     {tx:40,tz:46, type:'corrupted_xu'},
    {tx:46,tz:38, type:'holo_wraith'},      {tx:46,tz:42, type:'holo_wraith'},
    {tx:38,tz:36, type:'void_marine'},      {tx:38,tz:44, type:'void_marine'},
    {tx:50,tz:36, type:'corrupted_xu'},     {tx:50,tz:44, type:'corrupted_xu'},
    // CYBER-FORGE DISTRICT
    {tx:54,tz:30, type:'cyber_ogre'},
    {tx:56,tz:32, type:'corrupted_xu'},     {tx:52,tz:34, type:'corrupted_xu'},
    {tx:58,tz:30, type:'void_marine'},      {tx:54,tz:36, type:'holo_wraith'},
    {tx:54,tz:50, type:'cyber_ogre'},
    {tx:56,tz:48, type:'corrupted_xu'},     {tx:58,tz:50, type:'void_marine'},
    {tx:52,tz:46, type:'laser_turret'},     {tx:54,tz:44, type:'holo_wraith'},
    {tx:60,tz:32, type:'void_marine'},      {tx:60,tz:48, type:'void_marine'},
    {tx:62,tz:36, type:'corrupted_xu'},     {tx:62,tz:44, type:'corrupted_xu'},
    {tx:58,tz:36, type:'holo_wraith'},      {tx:58,tz:44, type:'holo_wraith'},
    {tx:56,tz:38, type:'void_marine'},      {tx:56,tz:42, type:'void_marine'},
    {tx:60,tz:40, type:'shard_assassin'},
    // THRONE APPROACH
    {tx:64,tz:34, type:'laser_turret'},     {tx:64,tz:46, type:'laser_turret'},
    {tx:66,tz:40, type:'cyber_ogre'},
    {tx:68,tz:38, type:'shard_assassin'},   {tx:68,tz:42, type:'shard_assassin'},
    {tx:70,tz:36, type:'void_marine'},      {tx:70,tz:44, type:'void_marine'},
    {tx:72,tz:38, type:'corrupted_xu'},     {tx:72,tz:42, type:'corrupted_xu'},
    {tx:74,tz:36, type:'holo_wraith'},      {tx:74,tz:44, type:'holo_wraith'},
    {tx:64,tz:38, type:'void_marine'},      {tx:64,tz:42, type:'void_marine'},
    {tx:66,tz:36, type:'corrupted_xu'},     {tx:66,tz:44, type:'corrupted_xu'},
    {tx:68,tz:34, type:'void_marine'},      {tx:68,tz:46, type:'void_marine'},
    {tx:70,tz:40, type:'cyber_ogre'},
    {tx:72,tz:36, type:'holo_wraith'},      {tx:72,tz:44, type:'holo_wraith'},
  ],
  // ── v93.0 phase 3 — THE CONVERGENCE ──
  // Empty array marker. createZoneEnemies() special-cases 'convergence' and
  // generates ~100 procedural spawns at game-create time via generateConvergenceSpawns().
  convergence: [],
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
function generateConvergenceSpawns() {
  const POOL = ['corrupted_xu', 'void_marine', 'holo_wraith', 'crawler',
                'wraith', 'elite', 'ash_wraith', 'void_eye'];
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

function createZoneEnemies(zoneName) {
  // v93.0 phase 3 — special-case convergence: generate spawns procedurally
  // per game-instance instead of using the static ZONE_SPAWNS entry.
  const spawns = (zoneName === 'convergence')
    ? generateConvergenceSpawns()
    : (ZONE_SPAWNS[zoneName] || []);
  const scale  = ZONE_SCALE[zoneName]  || 1.0;
  return spawns.map((s, i) => {
    const st = ENEMY_STATS[s.type] || ENEMY_STATS.soldier;
    return {
      id: i,
      type: s.type,
      x: s.tx * TILE,
      z: s.tz * TILE,
      spawnX: s.tx * TILE,
      spawnZ: s.tz * TILE,
      hp: Math.round(st.hp * scale),
      maxHp: Math.round(st.hp * scale),
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
    };
  }
  return game.zones[zoneName];
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

function tickGame(game) {
  Object.entries(game.zones).forEach(([zoneName, zone]) => {
    const zonePlayers = getPlayersInZone(game.id, zoneName);
    const hasPlayers = zonePlayers.length > 0;
    if (hasPlayers) zone.lastActivity = Date.now();

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

      // Move toward player
      if (nearestDist > ATTACK_RANGE) {
        const dx = nearestPlayer.x - e.x, dz = nearestPlayer.z - e.z;
        const len = Math.sqrt(dx*dx + dz*dz) || 1;
        e.x += (dx/len) * e.spd * 1.6; // 1.6 = server tick scale
        e.z += (dz/len) * e.spd * 1.6;
        changed.push(e);
      }

      // Attack
      e.attackTimer++;
      if (e.attackTimer >= ATTACK_COOLDOWN && nearestDist <= ATTACK_RANGE + 0.8) {
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
function broadcastPlayerList(){ broadcast({ type:'player_list', players:getPlayerNames() }); }
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
    let data;
    try { data = JSON.parse(raw); } catch { return; }
    const player = players.get(ws);

    switch(data.type){

      // ── LOBBY ──────────────────────────────────────────
      case 'login':
        player.name = (data.name||'').slice(0,20).replace(/[<>]/g,'') || 'Adventurer';
        send(ws, { type:'logged_in', name:player.name });
        sendGameList(ws);
        send(ws, { type:'player_count', count:players.size });
        send(ws, { type:'player_list', players:getPlayerNames() });
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
        send(ws, { type:'player_list', players:getPlayerNames() });
        break;

      // ── CLOUD SAVES ────────────────────────────────────
      case 'sv_cloud_save': {
        // Client is uploading a save — store it
        if (!data.name || !data.raceId || !data.cls || !data.saveData) break;
        const name = data.name.slice(0,20).replace(/[^a-zA-Z0-9_\- ]/g,'');
        if (!name) break;
        const key = getSaveKey(name, data.raceId, data.cls);
        const incoming = data.saveData;
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
        const saves = getAllSavesForUser(name);
        send(ws, { type:'sv_cloud_load_result', saves, name });
        console.log(`[saves] Load request for '${name}': ${saves.length} save(s) found`);
        break;
      }

      case 'sv_cloud_load_one': {
        // Client requesting a single specific save key
        if (!data.key) break;
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
        if (!zone || !zone.boss) break;
        const b = zone.boss;
        if (!b.spawned || b.hp <= 0) break;

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
          // Reset boss after 3 minutes
          // Capture bossZone NOW — player.zone may change before the timer fires
          const bossZone = player.zone;
          setTimeout(() => {
            if (g && g.zones[bossZone] && g.zones[bossZone].boss) {
              const rb = g.zones[bossZone].boss;
              rb.hp = rb.maxHp;
              rb.phase = 1;
              rb.spawned = false; // will re-spawn when triggered client-side
              broadcastToZone(g.id, bossZone, {
                type: 'sv_boss_respawn', zone: bossZone, bossName: rb.name,
              });
            }
          }, 3 * 60 * 1000);
        }
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
          zone.boss.hp = zone.boss.maxHp;
          zone.boss.phase = 1;
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
