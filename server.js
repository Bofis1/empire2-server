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
const WORLD_BOSS_DEFS = [
  { id:'forge_tyrant',     name:'The Forge Tyrant',       zone:'ashlands',     tx:70, tz:70, hp:280000, atk:115, atkCooldown:90,  aggroRange:22, color:0xff6020, lootTier:3 },
  { id:'ancient_wyrm',     name:'The Eyexor',             zone:'ancient',      tx:25, tz:25, hp:320000, atk:120, atkCooldown:85,  aggroRange:22, color:0xddbb60, lootTier:5 },
  { id:'hollow_reaper',    name:'The Hollow Reaper',      zone:'cemetery',     tx:25, tz:25, hp:360000, atk:130, atkCooldown:90,  aggroRange:22, color:0xc080ff, lootTier:4 },
  { id:'void_behemoth',    name:'The Void Behemoth',      zone:'neon_hollow',  tx:30, tz:30, hp:440000, atk:145, atkCooldown:95,  aggroRange:22, color:0xff00ff, lootTier:6 },
  { id:'abacus_of_flesh',  name:'The Abacus of Flesh',    zone:'void_citadel', tx:40, tz:40, hp:520000, atk:160, atkCooldown:100, aggroRange:24, color:0xcc1810, lootTier:7 },
  { id:'overseer_of_discord', name:'The Overseer of Discord', zone:'arena',    tx:120,tz:120,hp:680000, atk:175, atkCooldown:80,  aggroRange:26, color:0xffd84a, lootTier:8 },
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
    // camp 01 [elite guard]
    {tx:160,tz:144,type:'death_knight'},
    {tx:157,tz:144,type:'death_knight'},
    {tx:157,tz:145,type:'death_knight'},
    {tx:158,tz:144,type:'death_knight'},
    {tx:158,tz:146,type:'death_knight'},
    {tx:157,tz:147,type:'death_knight'},
    // camp 02 [elite guard]
    {tx:147,tz:79,type:'death_knight'},
    {tx:143,tz:81,type:'death_knight'},
    {tx:141,tz:80,type:'death_knight'},
    {tx:146,tz:83,type:'death_knight'},
    {tx:146,tz:79,type:'death_knight'},
    {tx:144,tz:81,type:'death_knight'},
    // camp 03 [elite guard]
    {tx:175,tz:113,type:'death_knight'},
    {tx:175,tz:115,type:'death_knight'},
    {tx:176,tz:112,type:'death_knight'},
    {tx:172,tz:112,type:'death_knight'},
    {tx:174,tz:115,type:'death_knight'},
    {tx:171,tz:111,type:'death_knight'},
    // camp 04 [elite guard]
    {tx:123,tz:173,type:'death_knight'},
    {tx:121,tz:178,type:'death_knight'},
    {tx:124,tz:179,type:'death_knight'},
    {tx:124,tz:174,type:'death_knight'},
    {tx:123,tz:174,type:'death_knight'},
    {tx:123,tz:180,type:'death_knight'},
    // camp 05 [elite guard]
    {tx:121,tz:62,type:'death_knight'},
    {tx:118,tz:61,type:'death_knight'},
    {tx:119,tz:64,type:'death_knight'},
    {tx:120,tz:63,type:'bone_mage'},
    {tx:119,tz:62,type:'bone_mage'},
    {tx:120,tz:62,type:'bone_mage'},
    // camp 06 [elite guard]
    {tx:144,tz:68,type:'bone_mage'},
    {tx:148,tz:67,type:'bone_mage'},
    {tx:146,tz:68,type:'bone_mage'},
    {tx:148,tz:68,type:'bone_mage'},
    {tx:142,tz:67,type:'bone_mage'},
    {tx:146,tz:66,type:'bone_mage'},
    // camp 07 [elite guard]
    {tx:177,tz:146,type:'bone_mage'},
    {tx:179,tz:145,type:'bone_mage'},
    {tx:179,tz:143,type:'bone_mage'},
    {tx:180,tz:145,type:'bone_mage'},
    {tx:177,tz:142,type:'bone_mage'},
    {tx:176,tz:144,type:'bone_mage'},
    // camp 08 [elite guard]
    {tx:176,tz:98,type:'bone_mage'},
    {tx:182,tz:97,type:'bone_mage'},
    {tx:177,tz:96,type:'bone_mage'},
    {tx:178,tz:95,type:'bone_mage'},
    {tx:180,tz:96,type:'bone_mage'},
    {tx:178,tz:96,type:'bone_mage'},
    // camp 09 [mid haunt]
    {tx:55,tz:127,type:'bone_mage'},
    {tx:54,tz:129,type:'bone_mage'},
    {tx:55,tz:131,type:'bone_mage'},
    {tx:58,tz:129,type:'bone_mage'},
    {tx:52,tz:129,type:'bone_mage'},
    {tx:55,tz:132,type:'bone_mage'},
    // camp 10 [mid haunt]
    {tx:87,tz:177,type:'bone_mage'},
    {tx:86,tz:180,type:'bone_mage'},
    {tx:85,tz:174,type:'bone_mage'},
    {tx:87,tz:178,type:'bone_mage'},
    {tx:84,tz:175,type:'bone_mage'},
    {tx:86,tz:178,type:'bone_mage'},
    // camp 11 [mid haunt]
    {tx:59,tz:83,type:'bone_mage'},
    {tx:58,tz:84,type:'bone_mage'},
    {tx:60,tz:81,type:'bone_mage'},
    {tx:64,tz:83,type:'bone_mage'},
    {tx:60,tz:85,type:'bone_mage'},
    {tx:59,tz:80,type:'bone_mage'},
    // camp 12 [mid haunt]
    {tx:96,tz:55,type:'bone_mage'},
    {tx:98,tz:55,type:'bone_mage'},
    {tx:99,tz:52,type:'bone_mage'},
    {tx:97,tz:56,type:'bone_mage'},
    {tx:100,tz:51,type:'bone_mage'},
    // camp 13 [mid haunt]
    {tx:54,tz:142,type:'bone_mage'},
    {tx:52,tz:142,type:'wraith'},
    {tx:53,tz:143,type:'wraith'},
    {tx:49,tz:140,type:'wraith'},
    {tx:50,tz:141,type:'wraith'},
    // camp 14 [mid haunt]
    {tx:159,tz:185,type:'wraith'},
    {tx:155,tz:191,type:'wraith'},
    {tx:155,tz:187,type:'wraith'},
    {tx:158,tz:190,type:'wraith'},
    {tx:155,tz:188,type:'wraith'},
    // camp 15 [mid haunt]
    {tx:176,tz:179,type:'wraith'},
    {tx:175,tz:184,type:'wraith'},
    {tx:174,tz:180,type:'wraith'},
    {tx:175,tz:181,type:'wraith'},
    {tx:177,tz:182,type:'wraith'},
    // camp 16 [mid haunt]
    {tx:120,tz:31,type:'wraith'},
    {tx:117,tz:35,type:'wraith'},
    {tx:120,tz:33,type:'wraith'},
    {tx:122,tz:34,type:'wraith'},
    {tx:117,tz:33,type:'wraith'},
    // camp 17 [mid haunt]
    {tx:54,tz:67,type:'wraith'},
    {tx:54,tz:65,type:'wraith'},
    {tx:56,tz:66,type:'wraith'},
    {tx:55,tz:69,type:'wraith'},
    {tx:54,tz:66,type:'wraith'},
    // camp 18 [mid haunt]
    {tx:31,tz:101,type:'wraith'},
    {tx:33,tz:99,type:'wraith'},
    {tx:34,tz:97,type:'wraith'},
    {tx:33,tz:97,type:'wraith'},
    {tx:35,tz:99,type:'wraith'},
    // camp 19 [mid haunt]
    {tx:210,tz:123,type:'wraith'},
    {tx:213,tz:120,type:'wraith'},
    {tx:211,tz:119,type:'wraith'},
    {tx:214,tz:119,type:'wraith'},
    {tx:209,tz:121,type:'wraith'},
    // camp 20 [mid haunt]
    {tx:57,tz:186,type:'wraith'},
    {tx:54,tz:190,type:'wraith'},
    {tx:56,tz:189,type:'wraith'},
    {tx:58,tz:190,type:'wraith'},
    {tx:56,tz:190,type:'wraith'},
    // camp 21 [mid haunt]
    {tx:142,tz:209,type:'wraith'},
    {tx:140,tz:215,type:'wraith'},
    {tx:142,tz:210,type:'wraith'},
    {tx:143,tz:213,type:'grave_crawler'},
    {tx:142,tz:213,type:'grave_crawler'},
    // camp 22 [mid haunt]
    {tx:28,tz:117,type:'grave_crawler'},
    {tx:24,tz:116,type:'grave_crawler'},
    {tx:23,tz:119,type:'grave_crawler'},
    {tx:25,tz:118,type:'grave_crawler'},
    {tx:24,tz:118,type:'grave_crawler'},
    // camp 23 [mid haunt]
    {tx:189,tz:51,type:'grave_crawler'},
    {tx:191,tz:53,type:'grave_crawler'},
    {tx:188,tz:52,type:'grave_crawler'},
    {tx:188,tz:54,type:'grave_crawler'},
    {tx:186,tz:54,type:'grave_crawler'},
    // camp 24 [mid haunt]
    {tx:26,tz:143,type:'grave_crawler'},
    {tx:26,tz:141,type:'grave_crawler'},
    {tx:26,tz:142,type:'grave_crawler'},
    {tx:24,tz:140,type:'grave_crawler'},
    {tx:25,tz:144,type:'grave_crawler'},
    // camp 25 [mid haunt]
    {tx:80,tz:29,type:'grave_crawler'},
    {tx:83,tz:29,type:'grave_crawler'},
    {tx:82,tz:31,type:'grave_crawler'},
    {tx:84,tz:30,type:'grave_crawler'},
    {tx:81,tz:31,type:'grave_crawler'},
    // camp 26 [mid haunt]
    {tx:216,tz:149,type:'grave_crawler'},
    {tx:216,tz:148,type:'grave_crawler'},
    {tx:213,tz:149,type:'grave_crawler'},
    {tx:212,tz:149,type:'grave_crawler'},
    {tx:216,tz:151,type:'grave_crawler'},
    // camp 27 [mid haunt]
    {tx:213,tz:84,type:'grave_crawler'},
    {tx:217,tz:84,type:'grave_crawler'},
    {tx:214,tz:80,type:'grave_crawler'},
    {tx:214,tz:81,type:'grave_crawler'},
    {tx:215,tz:80,type:'grave_crawler'},
    // camp 28 [outer graveyard]
    {tx:91,tz:218,type:'grave_crawler'},
    {tx:94,tz:219,type:'grave_crawler'},
    {tx:88,tz:222,type:'grave_crawler'},
    {tx:91,tz:219,type:'grave_crawler'},
    {tx:91,tz:223,type:'grave_crawler'},
    // camp 29 [outer graveyard]
    {tx:155,tz:23,type:'grave_crawler'},
    {tx:154,tz:23,type:'grave_crawler'},
    {tx:155,tz:18,type:'grave_crawler'},
    {tx:157,tz:20,type:'grave_crawler'},
    {tx:154,tz:18,type:'grave_crawler'},
    // camp 30 [outer graveyard]
    {tx:66,tz:30,type:'skeleton_warrior'},
    {tx:66,tz:28,type:'skeleton_warrior'},
    {tx:62,tz:28,type:'skeleton_warrior'},
    {tx:66,tz:31,type:'skeleton_warrior'},
    {tx:64,tz:32,type:'skeleton_warrior'},
    // camp 31 [outer graveyard]
    {tx:27,tz:170,type:'skeleton_warrior'},
    {tx:28,tz:169,type:'skeleton_warrior'},
    {tx:25,tz:173,type:'skeleton_warrior'},
    {tx:27,tz:174,type:'skeleton_warrior'},
    {tx:26,tz:171,type:'skeleton_warrior'},
    // camp 32 [outer graveyard]
    {tx:33,tz:63,type:'skeleton_warrior'},
    {tx:28,tz:64,type:'skeleton_warrior'},
    {tx:32,tz:62,type:'skeleton_warrior'},
    {tx:33,tz:61,type:'skeleton_warrior'},
    {tx:29,tz:61,type:'skeleton_warrior'},
    // camp 33 [outer graveyard]
    {tx:184,tz:207,type:'skeleton_warrior'},
    {tx:183,tz:206,type:'skeleton_warrior'},
    {tx:184,tz:208,type:'skeleton_warrior'},
    {tx:185,tz:207,type:'skeleton_warrior'},
    {tx:184,tz:204,type:'skeleton_warrior'},
    // camp 34 [outer graveyard]
    {tx:55,tz:204,type:'skeleton_warrior'},
    {tx:55,tz:205,type:'skeleton_warrior'},
    {tx:54,tz:207,type:'skeleton_warrior'},
    {tx:58,tz:207,type:'skeleton_warrior'},
    {tx:55,tz:210,type:'skeleton_warrior'},
    // camp 35 [outer graveyard]
    {tx:185,tz:30,type:'skeleton_warrior'},
    {tx:182,tz:33,type:'skeleton_warrior'},
    {tx:182,tz:32,type:'skeleton_warrior'},
    {tx:183,tz:34,type:'skeleton_warrior'},
    {tx:183,tz:31,type:'skeleton_warrior'},
    // camp 36 [outer graveyard]
    {tx:210,tz:56,type:'skeleton_warrior'},
    {tx:209,tz:60,type:'skeleton_warrior'},
    {tx:207,tz:58,type:'skeleton_warrior'},
    {tx:212,tz:60,type:'skeleton_warrior'},
    {tx:207,tz:56,type:'skeleton_warrior'},
    // camp 37 [outer graveyard]
    {tx:210,tz:185,type:'skeleton_warrior'},
    {tx:209,tz:182,type:'skeleton_warrior'},
    {tx:211,tz:187,type:'skeleton_warrior'},
    {tx:211,tz:182,type:'skeleton_warrior'},
    {tx:208,tz:184,type:'skeleton_warrior'},
    // camp 38 [outer graveyard]
    {tx:211,tz:26,type:'skeleton_warrior'},
    {tx:205,tz:27,type:'skeleton_warrior'},
    {tx:210,tz:29,type:'skeleton_warrior'},
    {tx:206,tz:27,type:'skeleton_warrior'},
    {tx:209,tz:26,type:'skeleton_warrior'},
    // camp 39 [outer graveyard]
    {tx:219,tz:203,type:'skeleton_warrior'},
    {tx:220,tz:204,type:'skeleton_warrior'},
    {tx:220,tz:206,type:'skeleton_warrior'},
    {tx:221,tz:205,type:'skeleton_warrior'},
    {tx:218,tz:202,type:'skeleton_warrior'},
    // camp 40 [outer graveyard]
    {tx:22,tz:29,type:'skeleton_warrior'},
    {tx:27,tz:26,type:'skeleton_warrior'},
    {tx:25,tz:27,type:'skeleton_warrior'},
    {tx:26,tz:26,type:'skeleton_warrior'},
    {tx:26,tz:30,type:'skeleton_warrior'},
    // camp 41 [outer graveyard]
    {tx:20,tz:221,type:'skeleton_warrior'},
    {tx:18,tz:219,type:'skeleton_warrior'},
    {tx:19,tz:219,type:'skeleton_warrior'},
    {tx:22,tz:220,type:'skeleton_warrior'},
    {tx:21,tz:221,type:'skeleton_warrior'},
  ],
  void: [
    {tx:14,tz:25,type:'void_stalker'},{tx:14,tz:18,type:'void_sentinel'},{tx:16,tz:27,type:'void_eye'},
    {tx:15,tz:28,type:'void_sentinel'},{tx:63,tz:16,type:'void_stalker'},{tx:57,tz:17,type:'void_stalker'},
    {tx:57,tz:15,type:'void_eye'},{tx:62,tz:13,type:'void_stalker'},{tx:82,tz:21,type:'void_sentinel'},
    {tx:78,tz:24,type:'void_construct'},{tx:78,tz:23,type:'wraith'},{tx:82,tz:20,type:'void_construct'},
    {tx:157,tz:23,type:'void_sentinel'},{tx:160,tz:25,type:'void_construct'},{tx:181,tz:25,type:'void_stalker'},
    {tx:186,tz:30,type:'void_sentinel'},{tx:219,tz:18,type:'void_spike_horror'},{tx:222,tz:18,type:'void_phantom'},
    {tx:213,tz:15,type:'void_stalker'},{tx:215,tz:15,type:'void_phantom'},{tx:26,tz:59,type:'void_eye'},
    {tx:28,tz:59,type:'void_eye'},{tx:60,tz:51,type:'void_phantom'},{tx:57,tz:51,type:'void_eye'},
    {tx:79,tz:60,type:'void_spike_horror'},{tx:86,tz:55,type:'void_phantom'},{tx:80,tz:57,type:'void_stalker'},
    {tx:80,tz:59,type:'void_phantom'},{tx:113,tz:52,type:'void_stalker'},{tx:118,tz:47,type:'void_sentinel'},
    {tx:115,tz:49,type:'void_eye'},{tx:151,tz:57,type:'void_spike_horror'},{tx:153,tz:54,type:'void_phantom'},
    {tx:151,tz:51,type:'void_phantom'},{tx:182,tz:60,type:'void_phantom'},{tx:180,tz:59,type:'void_eye'},
    {tx:227,tz:50,type:'void_sentinel'},{tx:226,tz:51,type:'void_construct'},{tx:226,tz:48,type:'wraith'},
    {tx:20,tz:88,type:'wraith'},{tx:19,tz:90,type:'void_phantom'},{tx:53,tz:85,type:'void_spike_horror'},
    {tx:51,tz:89,type:'void_phantom'},{tx:89,tz:90,type:'void_sentinel'},{tx:85,tz:88,type:'void_construct'},
    {tx:121,tz:94,type:'void_stalker'},{tx:123,tz:94,type:'void_sentinel'},{tx:123,tz:91,type:'void_eye'},
    {tx:154,tz:94,type:'void_stalker'},{tx:154,tz:97,type:'void_sentinel'},{tx:158,tz:91,type:'void_eye'},
    {tx:185,tz:79,type:'void_spike_horror'},{tx:176,tz:82,type:'void_phantom'},{tx:222,tz:85,type:'void_sentinel'},
    {tx:223,tz:84,type:'void_construct'},{tx:224,tz:90,type:'wraith'},{tx:223,tz:91,type:'void_construct'},
    {tx:63,tz:118,type:'void_stalker'},{tx:61,tz:113,type:'void_stalker'},{tx:57,tz:115,type:'void_eye'},
    {tx:86,tz:115,type:'void_stalker'},{tx:80,tz:119,type:'void_stalker'},{tx:81,tz:116,type:'void_eye'},
    {tx:80,tz:114,type:'void_stalker'},{tx:157,tz:116,type:'void_stalker'},{tx:162,tz:117,type:'void_stalker'},
    {tx:185,tz:112,type:'void_sentinel'},{tx:188,tz:119,type:'void_construct'},{tx:192,tz:113,type:'wraith'},
    {tx:17,tz:146,type:'void_stalker'},{tx:15,tz:144,type:'void_stalker'},{tx:56,tz:154,type:'void_stalker'},
    {tx:52,tz:152,type:'void_stalker'},{tx:58,tz:157,type:'void_eye'},{tx:55,tz:156,type:'void_stalker'},
    {tx:86,tz:146,type:'void_stalker'},{tx:91,tz:143,type:'void_sentinel'},{tx:90,tz:150,type:'void_eye'},
    {tx:86,tz:150,type:'void_sentinel'},{tx:117,tz:150,type:'void_sentinel'},{tx:122,tz:153,type:'void_construct'},
    {tx:120,tz:154,type:'wraith'},{tx:119,tz:150,type:'void_construct'},{tx:149,tz:162,type:'void_stalker'},
    {tx:149,tz:164,type:'void_stalker'},{tx:147,tz:163,type:'void_eye'},{tx:185,tz:149,type:'void_construct'},
    {tx:178,tz:149,type:'void_stalker'},{tx:187,tz:148,type:'void_eye'},{tx:183,tz:146,type:'void_stalker'},
    {tx:220,tz:158,type:'void_sentinel'},{tx:221,tz:152,type:'void_construct'},{tx:214,tz:157,type:'wraith'},
    {tx:20,tz:185,type:'void_spike_horror'},{tx:16,tz:181,type:'void_phantom'},{tx:49,tz:194,type:'void_spike_horror'},
    {tx:49,tz:190,type:'void_phantom'},{tx:47,tz:190,type:'void_stalker'},{tx:85,tz:186,type:'void_eye'},
    {tx:87,tz:180,type:'void_eye'},{tx:94,tz:187,type:'void_phantom'},{tx:118,tz:189,type:'void_stalker'},
    {tx:112,tz:191,type:'void_sentinel'},{tx:112,tz:194,type:'void_eye'},{tx:116,tz:190,type:'void_sentinel'},
    {tx:150,tz:192,type:'void_eye'},{tx:156,tz:195,type:'void_eye'},{tx:178,tz:184,type:'void_stalker'},
    {tx:183,tz:187,type:'void_sentinel'},{tx:185,tz:189,type:'void_eye'},{tx:181,tz:185,type:'void_sentinel'},
    {tx:215,tz:182,type:'void_construct'},{tx:219,tz:185,type:'void_stalker'},{tx:216,tz:185,type:'void_eye'},
    {tx:212,tz:184,type:'void_stalker'},{tx:28,tz:223,type:'void_construct'},{tx:27,tz:223,type:'void_stalker'},
    {tx:20,tz:221,type:'void_eye'},{tx:28,tz:225,type:'void_stalker'},{tx:48,tz:225,type:'void_construct'},
    {tx:45,tz:219,type:'void_stalker'},{tx:50,tz:222,type:'void_eye'},{tx:89,tz:219,type:'void_eye'},
    {tx:91,tz:221,type:'void_phantom'},{tx:149,tz:214,type:'void_eye'},{tx:151,tz:217,type:'void_eye'},
    {tx:187,tz:222,type:'void_phantom'},{tx:185,tz:222,type:'void_stalker'}
  ],
  citadel: [
    // camp 01 [inner garrison]
    {tx:97,tz:98,type:'xu_commander_elite'},
    {tx:98,tz:99,type:'xu_commander_elite'},
    // camp 02 [inner garrison]
    {tx:110,tz:87,type:'xu_commander_elite'},
    {tx:108,tz:87,type:'xu_commander_elite'},
    // camp 03 [inner garrison]
    {tx:150,tz:142,type:'xu_commander_elite'},
    {tx:151,tz:139,type:'xu_commander_elite'},
    // camp 04 [inner garrison]
    {tx:83,tz:112,type:'xu_commander_elite'},
    {tx:83,tz:110,type:'xu_commander_elite'},
    // camp 05 [inner garrison]
    {tx:160,tz:119,type:'xu_commander_elite'},
    {tx:162,tz:117,type:'xu_commander_elite'},
    // camp 06 [inner garrison]
    {tx:82,tz:110,type:'xu_commander_elite'},
    {tx:83,tz:109,type:'xu_commander_elite'},
    // camp 07 [inner garrison]
    {tx:130,tz:80,type:'xu_shieldbot'},
    {tx:130,tz:78,type:'xu_shieldbot'},
    // camp 08 [inner garrison]
    {tx:76,tz:133,type:'xu_shieldbot'},
    {tx:75,tz:133,type:'xu_shieldbot'},
    // camp 09 [inner garrison]
    {tx:120,tz:164,type:'xu_shieldbot'},
    {tx:120,tz:166,type:'xu_shieldbot'},
    // camp 10 [inner garrison]
    {tx:147,tz:157,type:'xu_shieldbot'},
    {tx:144,tz:156,type:'xu_shieldbot'},
    // camp 11 [inner garrison]
    {tx:147,tz:84,type:'xu_shieldbot'},
    {tx:149,tz:86,type:'xu_shieldbot'},
    // camp 12 [inner garrison]
    {tx:102,tz:165,type:'xu_shieldbot'},
    {tx:101,tz:165,type:'xu_shieldbot'},
    // camp 13 [inner garrison]
    {tx:161,tz:95,type:'xu_shieldbot'},
    {tx:162,tz:95,type:'xu_shieldbot'},
    // camp 14 [inner garrison]
    {tx:153,tz:160,type:'xu_shieldbot'},
    {tx:156,tz:161,type:'xu_shieldbot'},
    // camp 15 [inner garrison]
    {tx:67,tz:111,type:'xu_shieldbot'},
    {tx:66,tz:113,type:'xu_shieldbot'},
    // camp 16 [inner garrison]
    {tx:102,tz:171,type:'xu_shieldbot'},
    {tx:102,tz:173,type:'xu_shieldbot'},
    // camp 17 [inner garrison]
    {tx:161,tz:80,type:'xu_shieldbot'},
    {tx:161,tz:81,type:'xu_shieldbot'},
    // camp 18 [inner garrison]
    {tx:177,tz:104,type:'xu_shieldbot'},
    {tx:175,tz:103,type:'xu_shieldbot'},
    // camp 19 [inner garrison]
    {tx:179,tz:128,type:'xu_sniper_elite'},
    {tx:179,tz:127,type:'xu_sniper_elite'},
    // camp 20 [inner garrison]
    {tx:98,tz:65,type:'xu_sniper_elite'},
    {tx:100,tz:65,type:'xu_sniper_elite'},
    // camp 21 [inner garrison]
    {tx:119,tz:58,type:'xu_sniper_elite'},
    {tx:121,tz:57,type:'xu_sniper_elite'},
    // camp 22 [inner garrison]
    {tx:77,tz:163,type:'xu_sniper_elite'},
    {tx:74,tz:161,type:'xu_sniper_elite'},
    // camp 23 [inner garrison]
    {tx:168,tz:83,type:'xu_sniper_elite'},
    {tx:169,tz:82,type:'xu_sniper_elite'},
    // camp 24 [inner garrison]
    {tx:177,tz:146,type:'xu_sniper_elite'},
    {tx:178,tz:143,type:'xu_sniper_elite'},
    // camp 25 [inner garrison]
    {tx:127,tz:181,type:'xu_sniper_elite'},
    {tx:125,tz:181,type:'xu_sniper_elite'},
    // camp 26 [inner garrison]
    {tx:132,tz:57,type:'xu_sniper_elite'},
    {tx:133,tz:54,type:'xu_sniper_elite'},
    // camp 27 [inner garrison]
    {tx:75,tz:71,type:'xu_sniper_elite'},
    {tx:77,tz:73,type:'xu_sniper_elite'},
    // camp 28 [inner garrison]
    {tx:57,tz:130,type:'xu_sniper_elite'},
    {tx:55,tz:132,type:'xu_sniper_elite'},
    // camp 29 [inner garrison]
    {tx:180,tz:152,type:'xu_sniper_elite'},
    {tx:176,tz:153,type:'xu_sniper_elite'},
    // camp 30 [inner garrison]
    {tx:67,tz:79,type:'xu_sniper_elite'},
    {tx:67,tz:82,type:'xu_sniper_elite'},
    // camp 31 [inner garrison]
    {tx:57,tz:98,type:'xu_sniper_elite'},
    {tx:58,tz:99,type:'xu_sniper_elite'},
    // camp 32 [inner garrison]
    {tx:138,tz:186,type:'citadel_mage'},
    {tx:134,tz:184,type:'citadel_mage'},
    // camp 33 [inner garrison]
    {tx:65,tz:161,type:'citadel_mage'},
    {tx:65,tz:164,type:'citadel_mage'},
    // camp 34 [inner garrison]
    {tx:166,tz:65,type:'citadel_mage'},
    {tx:164,tz:64,type:'citadel_mage'},
    // camp 35 [inner garrison]
    {tx:162,tz:177,type:'citadel_mage'},
    {tx:165,tz:176,type:'citadel_mage'},
    // camp 36 [inner garrison]
    {tx:50,tz:144,type:'citadel_mage'},
    {tx:50,tz:142,type:'citadel_mage'},
    // camp 37 [inner garrison]
    {tx:81,tz:182,type:'citadel_mage'},
    {tx:83,tz:183,type:'citadel_mage'},
    // camp 38 [inner garrison]
    {tx:70,tz:173,type:'citadel_mage'},
    {tx:72,tz:173,type:'citadel_mage'},
    // camp 39 [inner garrison]
    {tx:135,tz:193,type:'citadel_mage'},
    {tx:133,tz:191,type:'citadel_mage'},
    // camp 40 [inner garrison]
    {tx:47,tz:111,type:'citadel_mage'},
    {tx:47,tz:113,type:'citadel_mage'},
    // camp 41 [inner garrison]
    {tx:125,tz:196,type:'citadel_mage'},
    {tx:125,tz:194,type:'citadel_mage'},
    // camp 42 [inner garrison]
    {tx:153,tz:192,type:'citadel_mage'},
    {tx:151,tz:189,type:'citadel_mage'},
    // camp 43 [inner garrison]
    {tx:175,tz:175,type:'citadel_mage'},
    {tx:176,tz:175,type:'citadel_mage'},
    // camp 44 [inner garrison]
    {tx:77,tz:57,type:'citadel_mage'},
    {tx:77,tz:56,type:'citadel_mage'},
    // camp 45 [inner garrison]
    {tx:145,tz:47,type:'citadel_mage'},
    // camp 46 [city patrol]
    {tx:48,tz:92,type:'citadel_mage'},
    // camp 47 [city patrol]
    {tx:103,tz:42,type:'citadel_mage'},
    // camp 48 [city patrol]
    {tx:198,tz:121,type:'citadel_mage'},
    // camp 49 [city patrol]
    {tx:118,tz:42,type:'citadel_mage'},
    // camp 50 [city patrol]
    {tx:195,tz:146,type:'citadel_mage'},
    // camp 51 [city patrol]
    {tx:176,tz:62,type:'citadel_mage'},
    // camp 52 [city patrol]
    {tx:61,tz:66,type:'citadel_mage'},
    // camp 53 [city patrol]
    {tx:43,tz:148,type:'iron_guard'},
    // camp 54 [city patrol]
    {tx:191,tz:77,type:'iron_guard'},
    // camp 55 [city patrol]
    {tx:82,tz:192,type:'iron_guard'},
    // camp 56 [city patrol]
    {tx:105,tz:203,type:'iron_guard'},
    // camp 57 [city patrol]
    {tx:170,tz:48,type:'iron_guard'},
    // camp 58 [city patrol]
    {tx:159,tz:43,type:'iron_guard'},
    // camp 59 [city patrol]
    {tx:196,tz:162,type:'iron_guard'},
    // camp 60 [city patrol]
    {tx:205,tz:98,type:'iron_guard'},
    // camp 61 [city patrol]
    {tx:74,tz:43,type:'iron_guard'},
    // camp 62 [city patrol]
    {tx:212,tz:124,type:'iron_guard'},
    // camp 63 [city patrol]
    {tx:174,tz:196,type:'iron_guard'},
    // camp 64 [city patrol]
    {tx:149,tz:209,type:'iron_guard'},
    // camp 65 [city patrol]
    {tx:35,tz:76,type:'iron_guard'},
    // camp 66 [city patrol]
    {tx:124,tz:215,type:'iron_guard'},
    // camp 67 [city patrol]
    {tx:98,tz:27,type:'iron_guard'},
    // camp 68 [city patrol]
    {tx:199,tz:172,type:'iron_guard'},
    // camp 69 [city patrol]
    {tx:71,tz:39,type:'iron_guard'},
    // camp 70 [city patrol]
    {tx:46,tz:62,type:'iron_guard'},
    // camp 71 [city patrol]
    {tx:28,tz:145,type:'iron_guard'},
    // camp 72 [city patrol]
    {tx:216,tz:97,type:'iron_guard'},
    // camp 73 [city patrol]
    {tx:36,tz:171,type:'iron_guard'},
    // camp 74 [city patrol]
    {tx:150,tz:25,type:'iron_guard'},
    // camp 75 [city patrol]
    {tx:85,tz:212,type:'iron_guard'},
    // camp 76 [city patrol]
    {tx:166,tz:212,type:'iron_guard'},
    // camp 77 [city patrol]
    {tx:62,tz:202,type:'iron_guard'},
    // camp 78 [city patrol]
    {tx:20,tz:114,type:'iron_guard'},
    // camp 79 [city patrol]
    {tx:70,tz:30,type:'iron_guard'},
    // camp 80 [city patrol]
    {tx:190,tz:47,type:'iron_guard'},
    // camp 81 [city patrol]
    {tx:42,tz:187,type:'iron_guard'},
    // camp 82 [city patrol]
    {tx:172,tz:206,type:'iron_guard'},
    // camp 83 [city patrol]
    {tx:138,tz:20,type:'iron_guard'},
    // camp 84 [city patrol]
    {tx:19,tz:104,type:'iron_guard'},
    // camp 85 [city patrol]
    {tx:208,tz:174,type:'iron_guard'},
    // camp 86 [city patrol]
    {tx:29,tz:69,type:'iron_guard'},
    // camp 87 [city patrol]
    {tx:225,tz:138,type:'iron_guard'},
    // camp 88 [city patrol]
    {tx:101,tz:223,type:'iron_guard'},
    // camp 89 [city patrol]
    {tx:204,tz:56,type:'iron_guard'},
    // camp 90 [city patrol]
    {tx:89,tz:16,type:'iron_guard'},
    // camp 91 [city patrol]
    {tx:217,tz:73,type:'iron_guard'},
    // camp 92 [city patrol]
    {tx:226,tz:159,type:'iron_guard'},
    // camp 93 [city patrol]
    {tx:18,tz:160,type:'iron_guard'},
    // camp 94 [city patrol]
    {tx:16,tz:81,type:'iron_guard'},
    // camp 95 [city patrol]
    {tx:67,tz:220,type:'iron_guard'},
    // camp 96 [city patrol]
    {tx:205,tz:197,type:'iron_guard'},
    // camp 97 [city patrol]
    {tx:180,tz:25,type:'iron_guard'},
    // camp 98 [city patrol]
    {tx:193,tz:209,type:'iron_guard'},
    // camp 99 [city patrol]
    {tx:216,tz:54,type:'iron_guard'},
    // camp 100 [city patrol]
    {tx:22,tz:183,type:'iron_guard'},
    // camp 101 [city patrol]
    {tx:32,tz:38,type:'iron_guard'},
    // camp 102 [city patrol]
    {tx:51,tz:20,type:'iron_guard'},
    // camp 103 [city patrol]
    {tx:211,tz:203,type:'iron_guard'},
    // camp 104 [city patrol]
    {tx:198,tz:25,type:'iron_guard'},
    // camp 105 [city patrol]
    {tx:20,tz:39,type:'iron_guard'},
    // camp 106 [city patrol]
    {tx:24,tz:204,type:'iron_guard'},
    // camp 107 [city patrol]
    {tx:39,tz:223,type:'iron_guard'},
    // camp 108 [city patrol]
    {tx:222,tz:37,type:'iron_guard'},
    // camp 109 [outer wall watch]
    {tx:214,tz:27,type:'iron_guard'},
    // camp 110 [outer wall watch]
    {tx:32,tz:20,type:'iron_guard'},
    // camp 111 [outer wall watch]
    {tx:17,tz:208,type:'iron_guard'},
    // camp 112 [outer wall watch]
    {tx:224,tz:215,type:'iron_guard'},
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
    // camp 01 [caldera guard]
    {tx:93,tz:139,type:'lava_golem'},
    {tx:97,tz:139,type:'lava_golem'},
    // camp 02 [caldera guard]
    {tx:125,tz:87,type:'lava_golem'},
    {tx:128,tz:88,type:'lava_golem'},
    // camp 03 [caldera guard]
    {tx:85,tz:136,type:'lava_golem'},
    {tx:85,tz:137,type:'lava_golem'},
    // camp 04 [caldera guard]
    {tx:81,tz:123,type:'lava_golem'},
    {tx:83,tz:122,type:'lava_golem'},
    // camp 05 [caldera guard]
    {tx:126,tz:160,type:'lava_golem'},
    {tx:124,tz:162,type:'lava_golem'},
    // camp 06 [caldera guard]
    {tx:159,tz:105,type:'lava_golem'},
    {tx:156,tz:105,type:'lava_golem'},
    // camp 07 [caldera guard]
    {tx:99,tz:157,type:'lava_golem'},
    {tx:99,tz:156,type:'lava_golem'},
    // camp 08 [caldera guard]
    {tx:163,tz:127,type:'lava_golem'},
    {tx:163,tz:126,type:'lava_golem'},
    // camp 09 [caldera guard]
    {tx:80,tz:110,type:'lava_golem'},
    {tx:77,tz:109,type:'lava_golem'},
    // camp 10 [caldera guard]
    {tx:133,tz:165,type:'lava_golem'},
    {tx:132,tz:166,type:'lava_golem'},
    // camp 11 [caldera guard]
    {tx:139,tz:77,type:'lava_golem'},
    {tx:135,tz:76,type:'lava_golem'},
    // camp 12 [caldera guard]
    {tx:162,tz:145,type:'lava_golem'},
    {tx:163,tz:142,type:'lava_golem'},
    // camp 13 [caldera guard]
    {tx:102,tz:76,type:'lava_golem'},
    {tx:99,tz:76,type:'lava_golem'},
    // camp 14 [caldera guard]
    {tx:86,tz:160,type:'lava_golem'},
    {tx:83,tz:161,type:'lava_golem'},
    // camp 15 [caldera guard]
    {tx:122,tz:67,type:'lava_golem'},
    {tx:122,tz:68,type:'lava_golem'},
    // camp 16 [caldera guard]
    {tx:119,tz:175,type:'lava_golem'},
    {tx:117,tz:173,type:'lava_golem'},
    // camp 17 [caldera guard]
    {tx:162,tz:159,type:'lava_golem'},
    {tx:159,tz:156,type:'lava_golem'},
    // camp 18 [caldera guard]
    {tx:177,tz:120,type:'berserker'},
    {tx:177,tz:119,type:'berserker'},
    // camp 19 [caldera guard]
    {tx:61,tz:117,type:'berserker'},
    {tx:61,tz:119,type:'berserker'},
    // camp 20 [caldera guard]
    {tx:137,tz:174,type:'berserker'},
    {tx:136,tz:177,type:'berserker'},
    // camp 21 [caldera guard]
    {tx:78,tz:80,type:'berserker'},
    {tx:80,tz:80,type:'berserker'},
    // camp 22 [caldera guard]
    {tx:139,tz:65,type:'berserker'},
    {tx:136,tz:64,type:'berserker'},
    // camp 23 [caldera guard]
    {tx:173,tz:94,type:'berserker'},
    {tx:175,tz:94,type:'berserker'},
    // camp 24 [caldera guard]
    {tx:64,tz:101,type:'berserker'},
    {tx:65,tz:102,type:'berserker'},
    // camp 25 [caldera guard]
    {tx:161,tz:79,type:'berserker'},
    {tx:162,tz:79,type:'berserker'},
    // camp 26 [caldera guard]
    {tx:107,tz:177,type:'berserker'},
    {tx:104,tz:178,type:'berserker'},
    // camp 27 [caldera guard]
    {tx:177,tz:142,type:'berserker'},
    {tx:178,tz:139,type:'berserker'},
    // camp 28 [caldera guard]
    {tx:93,tz:63,type:'berserker'},
    {tx:93,tz:64,type:'berserker'},
    // camp 29 [caldera guard]
    {tx:56,tz:141,type:'berserker'},
    {tx:56,tz:140,type:'berserker'},
    // camp 30 [caldera guard]
    {tx:65,tz:161,type:'berserker'},
    {tx:67,tz:157,type:'berserker'},
    // camp 31 [caldera guard]
    {tx:157,tz:179,type:'berserker'},
    {tx:154,tz:179,type:'berserker'},
    // camp 32 [caldera guard]
    {tx:157,tz:60,type:'berserker'},
    {tx:154,tz:60,type:'berserker'},
    // camp 33 [caldera guard]
    {tx:189,tz:119,type:'berserker'},
    {tx:192,tz:119,type:'berserker'},
    // camp 34 [caldera guard]
    {tx:184,tz:86,type:'berserker'},
    {tx:182,tz:89,type:'berserker'},
    // camp 35 [caldera guard]
    {tx:180,tz:155,type:'berserker'},
    {tx:183,tz:155,type:'berserker'},
    // camp 36 [caldera guard]
    {tx:117,tz:192,type:'berserker'},
    {tx:120,tz:193,type:'berserker'},
    // camp 37 [caldera guard]
    {tx:83,tz:58,type:'berserker'},
    {tx:85,tz:56,type:'berserker'},
    // camp 38 [caldera guard]
    {tx:56,tz:77,type:'berserker'},
    {tx:55,tz:80,type:'berserker'},
    // camp 39 [caldera guard]
    {tx:146,tz:46,type:'berserker'},
    {tx:145,tz:46,type:'berserker'},
    // camp 40 [caldera guard]
    {tx:196,tz:102,type:'berserker'},
    {tx:194,tz:100,type:'berserker'},
    // camp 41 [caldera guard]
    {tx:102,tz:193,type:'berserker'},
    // camp 42 [caldera guard]
    {tx:46,tz:144,type:'berserker'},
    // camp 43 [caldera guard]
    {tx:75,tz:182,type:'magma_crab'},
    // camp 44 [caldera guard]
    {tx:150,tz:50,type:'magma_crab'},
    // camp 45 [caldera guard]
    {tx:153,tz:192,type:'magma_crab'},
    // camp 46 [caldera guard]
    {tx:40,tz:117,type:'magma_crab'},
    // camp 47 [caldera guard]
    {tx:181,tz:67,type:'magma_crab'},
    // camp 48 [caldera guard]
    {tx:177,tz:178,type:'magma_crab'},
    // camp 49 [caldera guard]
    {tx:193,tz:157,type:'magma_crab'},
    // camp 50 [caldera guard]
    {tx:98,tz:42,type:'magma_crab'},
    // camp 51 [caldera guard]
    {tx:201,tz:131,type:'magma_crab'},
    // camp 52 [caldera guard]
    {tx:38,tz:107,type:'magma_crab'},
    // camp 53 [caldera guard]
    {tx:197,tz:84,type:'magma_crab'},
    // camp 54 [caldera guard]
    {tx:62,tz:178,type:'magma_crab'},
    // camp 55 [caldera guard]
    {tx:121,tz:37,type:'magma_crab'},
    // camp 56 [caldera guard]
    {tx:80,tz:45,type:'magma_crab'},
    // camp 57 [ashfields]
    {tx:83,tz:196,type:'magma_crab'},
    // camp 58 [ashfields]
    {tx:140,tz:201,type:'magma_crab'},
    // camp 59 [ashfields]
    {tx:46,tz:165,type:'magma_crab'},
    // camp 60 [ashfields]
    {tx:58,tz:60,type:'magma_crab'},
    // camp 61 [ashfields]
    {tx:43,tz:78,type:'magma_crab'},
    // camp 62 [ashfields]
    {tx:125,tz:209,type:'magma_crab'},
    // camp 63 [ashfields]
    {tx:171,tz:195,type:'magma_crab'},
    // camp 64 [ashfields]
    {tx:212,tz:121,type:'magma_crab'},
    // camp 65 [ashfields]
    {tx:175,tz:47,type:'magma_crab'},
    // camp 66 [ashfields]
    {tx:140,tz:210,type:'magma_crab'},
    // camp 67 [ashfields]
    {tx:85,tz:212,type:'magma_crab'},
    // camp 68 [ashfields]
    {tx:43,tz:178,type:'magma_crab'},
    // camp 69 [ashfields]
    {tx:40,tz:62,type:'magma_crab'},
    // camp 70 [ashfields]
    {tx:64,tz:40,type:'magma_crab'},
    // camp 71 [ashfields]
    {tx:212,tz:151,type:'magma_crab'},
    // camp 72 [ashfields]
    {tx:145,tz:24,type:'magma_crab'},
    // camp 73 [ashfields]
    {tx:21,tz:145,type:'magma_crab'},
    // camp 74 [ashfields]
    {tx:156,tz:27,type:'magma_crab'},
    // camp 75 [ashfields]
    {tx:102,tz:22,type:'magma_crab'},
    // camp 76 [ashfields]
    {tx:23,tz:151,type:'magma_crab'},
    // camp 77 [ashfields]
    {tx:218,tz:140,type:'ash_wraith'},
    // camp 78 [ashfields]
    {tx:204,tz:63,type:'ash_wraith'},
    // camp 79 [ashfields]
    {tx:97,tz:221,type:'ash_wraith'},
    // camp 80 [ashfields]
    {tx:57,tz:200,type:'ash_wraith'},
    // camp 81 [ashfields]
    {tx:218,tz:82,type:'ash_wraith'},
    // camp 82 [ashfields]
    {tx:222,tz:108,type:'ash_wraith'},
    // camp 83 [ashfields]
    {tx:202,tz:185,type:'ash_wraith'},
    // camp 84 [ashfields]
    {tx:19,tz:86,type:'ash_wraith'},
    // camp 85 [ashfields]
    {tx:210,tz:174,type:'ash_wraith'},
    // camp 86 [ashfields]
    {tx:212,tz:64,type:'ash_wraith'},
    // camp 87 [ashfields]
    {tx:86,tz:18,type:'ash_wraith'},
    // camp 88 [ashfields]
    {tx:192,tz:40,type:'ash_wraith'},
    // camp 89 [ashfields]
    {tx:27,tz:61,type:'ash_wraith'},
    // camp 90 [ashfields]
    {tx:158,tz:223,type:'ash_wraith'},
    // camp 91 [ashfields]
    {tx:40,tz:192,type:'ash_wraith'},
    // camp 92 [ashfields]
    {tx:181,tz:211,type:'ash_wraith'},
    // camp 93 [ashfields]
    {tx:200,tz:196,type:'ash_wraith'},
    // camp 94 [ashfields]
    {tx:66,tz:215,type:'ash_wraith'},
    // camp 95 [ashfields]
    {tx:178,tz:27,type:'ash_wraith'},
    // camp 96 [ashfields]
    {tx:66,tz:24,type:'ash_wraith'},
    // camp 97 [ashfields]
    {tx:46,tz:35,type:'ash_wraith'},
    // camp 98 [ashfields]
    {tx:19,tz:172,type:'ash_wraith'},
    // camp 99 [ashfields]
    {tx:29,tz:48,type:'ash_wraith'},
    // camp 100 [ashfields]
    {tx:50,tz:210,type:'ash_wraith'},
    // camp 101 [ashfields]
    {tx:41,tz:28,type:'ash_wraith'},
    // camp 102 [ashfields]
    {tx:204,tz:210,type:'ash_wraith'},
    // camp 103 [ashfields]
    {tx:219,tz:44,type:'ash_wraith'},
    // camp 104 [ashfields]
    {tx:218,tz:198,type:'ash_wraith'},
    // camp 105 [ashfields]
    {tx:198,tz:21,type:'ash_wraith'},
    // camp 106 [ashfields]
    {tx:19,tz:203,type:'ash_wraith'},
    // camp 107 [ashfields]
    {tx:28,tz:219,type:'ash_wraith'},
    // camp 108 [ashfields]
    {tx:24,tz:27,type:'ash_wraith'},
    // camp 109 [ashfields]
    {tx:221,tz:209,type:'ash_wraith'},
    // camp 110 [ashfields]
    {tx:217,tz:19,type:'ash_wraith'},
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
    // camp 01 [frozen coven]
    {tx:200,tz:133,type:'ice_golem'},
    {tx:201,tz:133,type:'ice_golem'},
    {tx:199,tz:132,type:'ice_golem'},
    {tx:200,tz:132,type:'ice_golem'},
    // camp 02 [frozen coven]
    {tx:43,tz:153,type:'ice_golem'},
    {tx:42,tz:154,type:'ice_golem'},
    {tx:41,tz:155,type:'ice_golem'},
    {tx:41,tz:153,type:'ice_golem'},
    // camp 03 [frozen coven]
    {tx:201,tz:90,type:'ice_golem'},
    {tx:200,tz:87,type:'ice_golem'},
    {tx:198,tz:89,type:'ice_golem'},
    {tx:200,tz:88,type:'ice_golem'},
    // camp 04 [frozen coven]
    {tx:136,tz:203,type:'ice_golem'},
    {tx:136,tz:202,type:'ice_golem'},
    {tx:140,tz:204,type:'ice_golem'},
    {tx:138,tz:206,type:'ice_golem'},
    // camp 05 [frozen coven]
    {tx:103,tz:36,type:'ice_golem'},
    {tx:107,tz:34,type:'ice_golem'},
    {tx:105,tz:35,type:'ice_golem'},
    {tx:107,tz:35,type:'ice_golem'},
    // camp 06 [frozen coven]
    {tx:88,tz:201,type:'ice_golem'},
    {tx:89,tz:206,type:'ice_golem'},
    {tx:91,tz:200,type:'ice_golem'},
    {tx:89,tz:205,type:'ice_golem'},
    // camp 07 [frozen coven]
    {tx:146,tz:204,type:'frost_wraith'},
    {tx:147,tz:204,type:'frost_wraith'},
    {tx:149,tz:202,type:'frost_wraith'},
    {tx:147,tz:203,type:'frost_wraith'},
    // camp 08 [tundra pack]
    {tx:81,tz:38,type:'frost_wraith'},
    {tx:81,tz:34,type:'frost_wraith'},
    {tx:81,tz:35,type:'frost_wraith'},
    {tx:80,tz:39,type:'frost_wraith'},
    // camp 09 [tundra pack]
    {tx:214,tz:130,type:'frost_wraith'},
    {tx:214,tz:126,type:'frost_wraith'},
    {tx:215,tz:131,type:'frost_wraith'},
    // camp 10 [tundra pack]
    {tx:64,tz:43,type:'frost_wraith'},
    {tx:68,tz:42,type:'frost_wraith'},
    {tx:66,tz:41,type:'frost_wraith'},
    // camp 11 [tundra pack]
    {tx:72,tz:202,type:'frost_wraith'},
    {tx:69,tz:203,type:'frost_wraith'},
    {tx:68,tz:201,type:'frost_wraith'},
    // camp 12 [tundra pack]
    {tx:139,tz:18,type:'frost_wraith'},
    {tx:140,tz:21,type:'frost_wraith'},
    {tx:138,tz:21,type:'frost_wraith'},
    // camp 13 [tundra pack]
    {tx:25,tz:79,type:'frost_wraith'},
    {tx:24,tz:80,type:'frost_wraith'},
    {tx:27,tz:78,type:'frost_wraith'},
    // camp 14 [tundra pack]
    {tx:144,tz:218,type:'frost_wraith'},
    {tx:148,tz:216,type:'frost_wraith'},
    {tx:147,tz:217,type:'frost_wraith'},
    // camp 15 [tundra pack]
    {tx:19,tz:154,type:'frost_wraith'},
    {tx:22,tz:155,type:'frost_wraith'},
    {tx:21,tz:153,type:'frost_wraith'},
    // camp 16 [tundra pack]
    {tx:221,tz:148,type:'frost_wraith'},
    {tx:219,tz:153,type:'frost_wraith'},
    {tx:221,tz:150,type:'frost_wraith'},
    // camp 17 [tundra pack]
    {tx:137,tz:224,type:'frost_wraith'},
    {tx:136,tz:227,type:'frost_wraith'},
    {tx:134,tz:223,type:'frost_wraith'},
    // camp 18 [tundra pack]
    {tx:82,tz:218,type:'frost_wraith'},
    {tx:85,tz:220,type:'frost_wraith'},
    {tx:82,tz:219,type:'frost_wraith'},
    // camp 19 [tundra pack]
    {tx:172,tz:213,type:'frost_wraith'},
    {tx:171,tz:213,type:'frost_wraith'},
    {tx:175,tz:214,type:'frost_wraith'},
    // camp 20 [tundra pack]
    {tx:224,tz:95,type:'frost_wraith'},
    {tx:226,tz:95,type:'polar_bear'},
    {tx:225,tz:94,type:'polar_bear'},
    // camp 21 [tundra pack]
    {tx:40,tz:194,type:'polar_bear'},
    {tx:38,tz:193,type:'polar_bear'},
    {tx:40,tz:192,type:'polar_bear'},
    // camp 22 [tundra pack]
    {tx:83,tz:17,type:'polar_bear'},
    {tx:83,tz:14,type:'polar_bear'},
    {tx:82,tz:18,type:'polar_bear'},
    // camp 23 [tundra pack]
    {tx:159,tz:15,type:'polar_bear'},
    {tx:158,tz:15,type:'polar_bear'},
    {tx:161,tz:15,type:'polar_bear'},
    // camp 24 [tundra pack]
    {tx:199,tz:38,type:'polar_bear'},
    {tx:197,tz:36,type:'polar_bear'},
    {tx:198,tz:40,type:'polar_bear'},
    // camp 25 [tundra pack]
    {tx:44,tz:38,type:'polar_bear'},
    {tx:45,tz:39,type:'polar_bear'},
    {tx:49,tz:38,type:'polar_bear'},
    // camp 26 [tundra pack]
    {tx:58,tz:20,type:'polar_bear'},
    {tx:61,tz:23,type:'polar_bear'},
    {tx:59,tz:24,type:'polar_bear'},
    // camp 27 [tundra pack]
    {tx:20,tz:62,type:'polar_bear'},
    {tx:18,tz:63,type:'polar_bear'},
    {tx:21,tz:66,type:'polar_bear'},
    // camp 28 [tundra pack]
    {tx:189,tz:26,type:'polar_bear'},
    {tx:190,tz:29,type:'polar_bear'},
    {tx:189,tz:27,type:'polar_bear'},
    // camp 29 [tundra pack]
    {tx:215,tz:191,type:'polar_bear'},
    {tx:214,tz:191,type:'polar_bear'},
    {tx:215,tz:192,type:'polar_bear'},
    // camp 30 [tundra pack]
    {tx:222,tz:181,type:'polar_bear'},
    {tx:220,tz:181,type:'polar_bear'},
    {tx:222,tz:178,type:'polar_bear'},
    // camp 31 [tundra pack]
    {tx:60,tz:223,type:'frost_specter'},
    {tx:61,tz:223,type:'frost_specter'},
    {tx:61,tz:222,type:'frost_specter'},
    // camp 32 [tundra pack]
    {tx:226,tz:64,type:'frost_specter'},
    {tx:226,tz:66,type:'frost_specter'},
    {tx:224,tz:65,type:'frost_specter'},
    // camp 33 [tundra pack]
    {tx:179,tz:15,type:'frost_specter'},
    {tx:176,tz:17,type:'frost_specter'},
    {tx:176,tz:16,type:'frost_specter'},
    // camp 34 [tundra pack]
    {tx:49,tz:214,type:'frost_specter'},
    {tx:48,tz:218,type:'frost_specter'},
    {tx:50,tz:215,type:'frost_specter'},
    // camp 35 [tundra pack]
    {tx:13,tz:174,type:'frost_specter'},
    {tx:16,tz:176,type:'frost_specter'},
    {tx:12,tz:177,type:'frost_specter'},
    // camp 36 [tundra pack]
    {tx:49,tz:25,type:'frost_specter'},
    {tx:50,tz:24,type:'frost_specter'},
    {tx:45,tz:22,type:'frost_specter'},
    // camp 37 [tundra pack]
    {tx:18,tz:194,type:'frost_specter'},
    {tx:19,tz:193,type:'frost_specter'},
    {tx:18,tz:192,type:'frost_specter'},
    // camp 38 [tundra pack]
    {tx:222,tz:39,type:'frost_specter'},
    {tx:219,tz:39,type:'frost_specter'},
    {tx:219,tz:40,type:'frost_specter'},
    // camp 39 [tundra pack]
    {tx:195,tz:227,type:'frost_specter'},
    {tx:193,tz:231,type:'frost_specter'},
    {tx:193,tz:229,type:'frost_specter'},
    // camp 40 [outer wastes]
    {tx:15,tz:38,type:'frost_specter'},
    {tx:18,tz:36,type:'frost_specter'},
    {tx:17,tz:37,type:'frost_specter'},
    // camp 41 [outer wastes]
    {tx:27,tz:217,type:'frost_specter'},
    {tx:28,tz:217,type:'frost_specter'},
    {tx:26,tz:217,type:'frost_specter'},
    // camp 42 [outer wastes]
    {tx:215,tz:215,type:'frost_specter'},
    {tx:219,tz:213,type:'frost_specter'},
    {tx:221,tz:213,type:'frost_specter'},
    // camp 43 [outer wastes]
    {tx:219,tz:18,type:'frost_specter'},
    {tx:221,tz:21,type:'frost_specter'},
    {tx:217,tz:24,type:'frost_specter'},
    // camp 44 [outer wastes]
    {tx:15,tz:17,type:'frost_specter'},
    {tx:15,tz:19,type:'frost_specter'},
    {tx:15,tz:16,type:'frost_specter'},
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
    // camp 01 [central garrison]
    {tx:139,tz:98,type:'xu_supreme'},
    {tx:139,tz:97,type:'xu_supreme'},
    // camp 02 [central garrison]
    {tx:87,tz:115,type:'xu_supreme'},
    {tx:85,tz:118,type:'xu_supreme'},
    // camp 03 [central garrison]
    {tx:98,tz:143,type:'xu_supreme'},
    {tx:97,tz:146,type:'xu_supreme'},
    // camp 04 [central garrison]
    {tx:143,tz:146,type:'xu_supreme'},
    {tx:146,tz:145,type:'xu_supreme'},
    // camp 05 [central garrison]
    {tx:92,tz:98,type:'xu_supreme'},
    {tx:94,tz:99,type:'xu_supreme'},
    // camp 06 [central garrison]
    {tx:152,tz:138,type:'xu_supreme'},
    {tx:152,tz:137,type:'xu_supreme'},
    // camp 07 [central garrison]
    {tx:159,tz:127,type:'xu_supreme'},
    {tx:160,tz:123,type:'xu_supreme'},
    // camp 08 [central garrison]
    {tx:135,tz:159,type:'xu_supreme'},
    {tx:135,tz:158,type:'xu_supreme'},
    // camp 09 [central garrison]
    {tx:111,tz:78,type:'xu_supreme'},
    {tx:113,tz:80,type:'xu_supreme'},
    // camp 10 [central garrison]
    {tx:137,tz:82,type:'xu_supreme'},
    {tx:139,tz:83,type:'xu_supreme'},
    // camp 11 [central garrison]
    {tx:100,tz:161,type:'xu_supreme'},
    {tx:99,tz:162,type:'xu_supreme'},
    // camp 12 [central garrison]
    {tx:110,tz:164,type:'xu_supreme'},
    {tx:109,tz:165,type:'xu_supreme'},
    // camp 13 [central garrison]
    {tx:78,tz:142,type:'xu_supreme'},
    {tx:77,tz:141,type:'xu_supreme'},
    // camp 14 [central garrison]
    {tx:156,tz:90,type:'xu_supreme'},
    {tx:155,tz:93,type:'xu_supreme'},
    // camp 15 [central garrison]
    {tx:98,tz:79,type:'xu_supreme'},
    {tx:98,tz:81,type:'xu_supreme'},
    // camp 16 [central garrison]
    {tx:156,tz:86,type:'xu_titan'},
    {tx:155,tz:89,type:'xu_titan'},
    // camp 17 [central garrison]
    {tx:81,tz:152,type:'xu_titan'},
    {tx:80,tz:153,type:'xu_titan'},
    // camp 18 [central garrison]
    {tx:72,tz:97,type:'xu_titan'},
    {tx:75,tz:97,type:'xu_titan'},
    // camp 19 [central garrison]
    {tx:115,tz:68,type:'xu_titan'},
    {tx:114,tz:67,type:'xu_titan'},
    // camp 20 [central garrison]
    {tx:103,tz:65,type:'xu_titan'},
    {tx:101,tz:64,type:'xu_titan'},
    // camp 21 [central garrison]
    {tx:65,tz:143,type:'xu_titan'},
    {tx:64,tz:142,type:'xu_titan'},
    // camp 22 [central garrison]
    {tx:82,tz:76,type:'xu_titan'},
    {tx:84,tz:75,type:'xu_titan'},
    // camp 23 [central garrison]
    {tx:59,tz:119,type:'xu_titan'},
    {tx:59,tz:121,type:'xu_titan'},
    // camp 24 [central garrison]
    {tx:164,tz:157,type:'xu_titan'},
    {tx:163,tz:159,type:'xu_titan'},
    // camp 25 [central garrison]
    {tx:180,tz:121,type:'xu_titan'},
    {tx:180,tz:120,type:'xu_titan'},
    // camp 26 [central garrison]
    {tx:147,tz:177,type:'xu_titan'},
    {tx:146,tz:177,type:'xu_titan'},
    // camp 27 [central garrison]
    {tx:140,tz:59,type:'xu_titan'},
    {tx:137,tz:61,type:'xu_titan'},
    // camp 28 [central garrison]
    {tx:62,tz:98,type:'xu_titan'},
    {tx:60,tz:98,type:'xu_titan'},
    // camp 29 [central garrison]
    {tx:155,tz:66,type:'xu_titan'},
    {tx:157,tz:68,type:'xu_titan'},
    // camp 30 [central garrison]
    {tx:172,tz:81,type:'xu_titan'},
    {tx:174,tz:81,type:'xu_titan'},
    // camp 31 [central garrison]
    {tx:98,tz:182,type:'xu_titan'},
    {tx:96,tz:178,type:'xu_titan'},
    // camp 32 [central garrison]
    {tx:122,tz:185,type:'xu_titan'},
    {tx:123,tz:186,type:'xu_titan'},
    // camp 33 [central garrison]
    {tx:186,tz:106,type:'xu_titan'},
    {tx:184,tz:108,type:'xu_titan'},
    // camp 34 [central garrison]
    {tx:186,tz:141,type:'xu_titan'},
    {tx:184,tz:140,type:'xu_titan'},
    // camp 35 [central garrison]
    {tx:79,tz:61,type:'xu_titan'},
    {tx:77,tz:63,type:'xu_titan'},
    // camp 36 [central garrison]
    {tx:65,tz:166,type:'xu_titan'},
    {tx:65,tz:167,type:'xu_titan'},
    // camp 37 [central garrison]
    {tx:158,tz:183,type:'xu_annihilator'},
    {tx:158,tz:184,type:'xu_annihilator'},
    // camp 38 [central garrison]
    {tx:83,tz:181,type:'xu_annihilator'},
    {tx:82,tz:184,type:'xu_annihilator'},
    // camp 39 [central garrison]
    {tx:48,tz:144,type:'xu_annihilator'},
    {tx:50,tz:145,type:'xu_annihilator'},
    // camp 40 [central garrison]
    {tx:45,tz:114,type:'xu_annihilator'},
    // camp 41 [central garrison]
    {tx:137,tz:47,type:'xu_annihilator'},
    // camp 42 [central garrison]
    {tx:185,tz:159,type:'xu_annihilator'},
    // camp 43 [central garrison]
    {tx:55,tz:82,type:'xu_annihilator'},
    // camp 44 [central garrison]
    {tx:195,tz:118,type:'xu_annihilator'},
    // camp 45 [central garrison]
    {tx:142,tz:194,type:'xu_annihilator'},
    // camp 46 [central garrison]
    {tx:119,tz:196,type:'xu_annihilator'},
    // camp 47 [central garrison]
    {tx:47,tz:102,type:'xu_annihilator'},
    // camp 48 [central garrison]
    {tx:107,tz:44,type:'xu_annihilator'},
    // camp 49 [central garrison]
    {tx:199,tz:105,type:'xu_annihilator'},
    // camp 50 [central garrison]
    {tx:176,tz:64,type:'xu_annihilator'},
    // camp 51 [central garrison]
    {tx:92,tz:195,type:'xu_annihilator'},
    // camp 52 [city district]
    {tx:121,tz:41,type:'xu_annihilator'},
    // camp 53 [city district]
    {tx:193,tz:151,type:'xu_annihilator'},
    // camp 54 [city district]
    {tx:191,tz:84,type:'xu_annihilator'},
    // camp 55 [city district]
    {tx:83,tz:194,type:'xu_annihilator'},
    // camp 56 [city district]
    {tx:202,tz:133,type:'xu_annihilator'},
    // camp 57 [city district]
    {tx:179,tz:177,type:'xu_annihilator'},
    // camp 58 [city district]
    {tx:59,tz:63,type:'xu_annihilator'},
    // camp 59 [city district]
    {tx:54,tz:174,type:'xu_annihilator'},
    // camp 60 [city district]
    {tx:80,tz:42,type:'xu_annihilator'},
    // camp 61 [city district]
    {tx:41,tz:82,type:'xu_annihilator'},
    // camp 62 [city district]
    {tx:172,tz:195,type:'xu_annihilator'},
    // camp 63 [city district]
    {tx:159,tz:40,type:'xu_annihilator'},
    // camp 64 [city district]
    {tx:35,tz:156,type:'xu_annihilator'},
    // camp 65 [city district]
    {tx:193,tz:176,type:'xu_annihilator'},
    // camp 66 [city district]
    {tx:99,tz:209,type:'xu_annihilator'},
    // camp 67 [city district]
    {tx:175,tz:41,type:'xu_annihilator'},
    // camp 68 [city district]
    {tx:29,tz:143,type:'xu_annihilator'},
    // camp 69 [city district]
    {tx:163,tz:205,type:'xu_annihilator'},
    // camp 70 [city district]
    {tx:23,tz:116,type:'xu_annihilator'},
    // camp 71 [city district]
    {tx:155,tz:211,type:'xu_annihilator'},
    // camp 72 [city district]
    {tx:69,tz:36,type:'xu_annihilator'},
    // camp 73 [city district]
    {tx:199,tz:61,type:'xu_annihilator'},
    // camp 74 [city district]
    {tx:219,tz:101,type:'xu_annihilator'},
    // camp 75 [city district]
    {tx:79,tz:213,type:'xu_annihilator'},
    // camp 76 [city district]
    {tx:33,tz:62,type:'xu_annihilator'},
    // camp 77 [city district]
    {tx:39,tz:185,type:'xu_annihilator'},
    // camp 78 [city district]
    {tx:52,tz:200,type:'xu_annihilator'},
    // camp 79 [city district]
    {tx:214,tz:160,type:'xu_annihilator'},
    // camp 80 [city district]
    {tx:223,tz:130,type:'xu_enforcer'},
    // camp 81 [city district]
    {tx:219,tz:87,type:'xu_enforcer'},
    // camp 82 [city district]
    {tx:142,tz:15,type:'xu_enforcer'},
    // camp 83 [city district]
    {tx:143,tz:223,type:'xu_enforcer'},
    // camp 84 [city district]
    {tx:104,tz:15,type:'xu_enforcer'},
    // camp 85 [city district]
    {tx:197,tz:192,type:'xu_enforcer'},
    // camp 86 [city district]
    {tx:160,tz:19,type:'xu_enforcer'},
    // camp 87 [city district]
    {tx:46,tz:44,type:'xu_enforcer'},
    // camp 88 [city district]
    {tx:75,tz:22,type:'xu_enforcer'},
    // camp 89 [city district]
    {tx:27,tz:64,type:'xu_enforcer'},
    // camp 90 [city district]
    {tx:203,tz:48,type:'xu_enforcer'},
    // camp 91 [city district]
    {tx:17,tz:160,type:'xu_enforcer'},
    // camp 92 [city district]
    {tx:42,tz:200,type:'xu_enforcer'},
    // camp 93 [city district]
    {tx:174,tz:222,type:'xu_enforcer'},
    // camp 94 [city district]
    {tx:176,tz:16,type:'xu_enforcer'},
    // camp 95 [city district]
    {tx:47,tz:31,type:'xu_enforcer'},
    // camp 96 [city district]
    {tx:224,tz:175,type:'xu_enforcer'},
    // camp 97 [city district]
    {tx:53,tz:217,type:'xu_enforcer'},
    // camp 98 [city district]
    {tx:21,tz:183,type:'xu_enforcer'},
    // camp 99 [city district]
    {tx:60,tz:19,type:'xu_enforcer'},
    // camp 100 [city district]
    {tx:225,tz:57,type:'xu_enforcer'},
    // camp 101 [city district]
    {tx:218,tz:48,type:'xu_enforcer'},
    // camp 102 [city district]
    {tx:195,tz:22,type:'xu_enforcer'},
    // camp 103 [city district]
    {tx:212,tz:202,type:'xu_enforcer'},
    // camp 104 [city district]
    {tx:25,tz:201,type:'xu_enforcer'},
    // camp 105 [city district]
    {tx:39,tz:220,type:'xu_enforcer'},
    // camp 106 [city district]
    {tx:205,tz:220,type:'xu_enforcer'},
    // camp 107 [city district]
    {tx:18,tz:34,type:'xu_enforcer'},
    // camp 108 [city district]
    {tx:25,tz:219,type:'xu_enforcer'},
    // camp 109 [city district]
    {tx:18,tz:31,type:'xu_enforcer'},
    // camp 110 [city district]
    {tx:212,tz:221,type:'xu_enforcer'},
    // camp 111 [outer wall]
    {tx:224,tz:24,type:'xu_enforcer'},
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
    // camp 01 [deep garden]
    {tx:144,tz:101,type:'thorn_knight'},
    {tx:147,tz:101,type:'thorn_knight'},
    // camp 02 [deep garden]
    {tx:147,tz:140,type:'thorn_knight'},
    {tx:147,tz:142,type:'thorn_knight'},
    // camp 03 [deep garden]
    {tx:100,tz:148,type:'mushroom_brute'},
    {tx:99,tz:147,type:'mushroom_brute'},
    // camp 04 [deep garden]
    {tx:155,tz:139,type:'mushroom_brute'},
    {tx:153,tz:137,type:'mushroom_brute'},
    // camp 05 [deep garden]
    {tx:85,tz:103,type:'mushroom_brute'},
    {tx:86,tz:103,type:'mushroom_brute'},
    // camp 06 [deep garden]
    {tx:127,tz:78,type:'mushroom_brute'},
    {tx:126,tz:81,type:'mushroom_brute'},
    // camp 07 [deep garden]
    {tx:108,tz:158,type:'mushroom_brute'},
    {tx:106,tz:159,type:'mushroom_brute'},
    // camp 08 [deep garden]
    {tx:162,tz:105,type:'mushroom_brute'},
    {tx:160,tz:106,type:'mushroom_brute'},
    // camp 09 [deep garden]
    {tx:85,tz:147,type:'mushroom_brute'},
    {tx:86,tz:146,type:'mushroom_brute'},
    // camp 10 [deep garden]
    {tx:94,tz:82,type:'mushroom_brute'},
    {tx:97,tz:82,type:'mushroom_brute'},
    // camp 11 [deep garden]
    {tx:77,tz:114,type:'mushroom_brute'},
    {tx:74,tz:112,type:'mushroom_brute'},
    // camp 12 [deep garden]
    {tx:166,tz:119,type:'mushroom_brute'},
    {tx:165,tz:118,type:'mushroom_brute'},
    // camp 13 [deep garden]
    {tx:112,tz:167,type:'mushroom_brute'},
    {tx:113,tz:167,type:'mushroom_brute'},
    // camp 14 [deep garden]
    {tx:140,tz:164,type:'mushroom_brute'},
    {tx:144,tz:165,type:'mushroom_brute'},
    // camp 15 [deep garden]
    {tx:145,tz:75,type:'vine_stalker'},
    {tx:146,tz:75,type:'vine_stalker'},
    // camp 16 [deep garden]
    {tx:156,tz:82,type:'vine_stalker'},
    {tx:157,tz:83,type:'vine_stalker'},
    // camp 17 [deep garden]
    {tx:83,tz:161,type:'vine_stalker'},
    {tx:84,tz:159,type:'vine_stalker'},
    // camp 18 [deep garden]
    {tx:102,tz:67,type:'vine_stalker'},
    {tx:105,tz:69,type:'vine_stalker'},
    // camp 19 [deep garden]
    {tx:128,tz:64,type:'vine_stalker'},
    {tx:126,tz:66,type:'vine_stalker'},
    // camp 20 [deep garden]
    {tx:113,tz:175,type:'vine_stalker'},
    {tx:116,tz:175,type:'vine_stalker'},
    // camp 21 [deep garden]
    {tx:134,tz:61,type:'vine_stalker'},
    {tx:130,tz:63,type:'vine_stalker'},
    // camp 22 [deep garden]
    {tx:61,tz:100,type:'vine_stalker'},
    {tx:61,tz:102,type:'vine_stalker'},
    // camp 23 [deep garden]
    {tx:168,tz:161,type:'vine_stalker'},
    {tx:165,tz:161,type:'vine_stalker'},
    // camp 24 [deep garden]
    {tx:184,tz:126,type:'vine_stalker'},
    {tx:183,tz:129,type:'vine_stalker'},
    // camp 25 [deep garden]
    {tx:63,tz:143,type:'vine_stalker'},
    {tx:64,tz:143,type:'vine_stalker'},
    // camp 26 [deep garden]
    {tx:152,tz:68,type:'vine_stalker'},
    {tx:153,tz:65,type:'vine_stalker'},
    // camp 27 [deep garden]
    {tx:181,tz:104,type:'vine_stalker'},
    {tx:183,tz:106,type:'vine_stalker'},
    // camp 28 [deep garden]
    {tx:57,tz:116,type:'vine_stalker'},
    {tx:56,tz:115,type:'vine_stalker'},
    // camp 29 [deep garden]
    {tx:183,tz:132,type:'vine_stalker'},
    {tx:182,tz:134,type:'vine_stalker'},
    // camp 30 [deep garden]
    {tx:75,tz:73,type:'vine_stalker'},
    {tx:76,tz:75,type:'vine_stalker'},
    // camp 31 [deep garden]
    {tx:146,tz:181,type:'vine_stalker'},
    {tx:144,tz:180,type:'vine_stalker'},
    // camp 32 [deep garden]
    {tx:103,tz:182,type:'pollen_wraith'},
    {tx:101,tz:186,type:'pollen_wraith'},
    // camp 33 [deep garden]
    {tx:82,tz:62,type:'pollen_wraith'},
    {tx:83,tz:64,type:'pollen_wraith'},
    // camp 34 [deep garden]
    {tx:165,tz:176,type:'pollen_wraith'},
    {tx:164,tz:177,type:'pollen_wraith'},
    // camp 35 [deep garden]
    {tx:65,tz:167,type:'pollen_wraith'},
    {tx:67,tz:169,type:'pollen_wraith'},
    // camp 36 [deep garden]
    {tx:58,tz:79,type:'pollen_wraith'},
    {tx:60,tz:82,type:'pollen_wraith'},
    // camp 37 [deep garden]
    {tx:180,tz:163,type:'pollen_wraith'},
    {tx:178,tz:165,type:'pollen_wraith'},
    // camp 38 [deep garden]
    {tx:82,tz:187,type:'pollen_wraith'},
    {tx:82,tz:185,type:'pollen_wraith'},
    // camp 39 [deep garden]
    {tx:42,tz:117,type:'pollen_wraith'},
    {tx:44,tz:117,type:'pollen_wraith'},
    // camp 40 [wildwood]
    {tx:127,tz:199,type:'pollen_wraith'},
    {tx:125,tz:198,type:'pollen_wraith'},
    // camp 41 [wildwood]
    {tx:95,tz:198,type:'pollen_wraith'},
    {tx:94,tz:197,type:'pollen_wraith'},
    // camp 42 [wildwood]
    {tx:44,tz:144,type:'pollen_wraith'},
    {tx:43,tz:139,type:'pollen_wraith'},
    // camp 43 [wildwood]
    {tx:133,tz:198,type:'pollen_wraith'},
    {tx:133,tz:200,type:'pollen_wraith'},
    // camp 44 [wildwood]
    {tx:182,tz:174,type:'pollen_wraith'},
    {tx:183,tz:175,type:'pollen_wraith'},
    // camp 45 [wildwood]
    {tx:188,tz:74,type:'pollen_wraith'},
    {tx:186,tz:74,type:'pollen_wraith'},
    // camp 46 [wildwood]
    {tx:203,tz:103,type:'glimmer_fairy'},
    {tx:201,tz:103,type:'glimmer_fairy'},
    // camp 47 [wildwood]
    {tx:65,tz:62,type:'glimmer_fairy'},
    // camp 48 [wildwood]
    {tx:100,tz:39,type:'glimmer_fairy'},
    // camp 49 [wildwood]
    {tx:41,tz:101,type:'glimmer_fairy'},
    // camp 50 [wildwood]
    {tx:47,tz:152,type:'glimmer_fairy'},
    // camp 51 [wildwood]
    {tx:135,tz:35,type:'glimmer_fairy'},
    // camp 52 [wildwood]
    {tx:204,tz:118,type:'glimmer_fairy'},
    // camp 53 [wildwood]
    {tx:122,tz:35,type:'glimmer_fairy'},
    // camp 54 [wildwood]
    {tx:42,tz:85,type:'glimmer_fairy'},
    // camp 55 [wildwood]
    {tx:84,tz:199,type:'glimmer_fairy'},
    // camp 56 [wildwood]
    {tx:87,tz:37,type:'glimmer_fairy'},
    // camp 57 [wildwood]
    {tx:209,tz:139,type:'glimmer_fairy'},
    // camp 58 [wildwood]
    {tx:67,tz:47,type:'glimmer_fairy'},
    // camp 59 [wildwood]
    {tx:188,tz:59,type:'glimmer_fairy'},
    // camp 60 [wildwood]
    {tx:152,tz:32,type:'glimmer_fairy'},
    // camp 61 [wildwood]
    {tx:162,tz:201,type:'glimmer_fairy'},
    // camp 62 [wildwood]
    {tx:177,tz:46,type:'glimmer_fairy'},
    // camp 63 [wildwood]
    {tx:195,tz:64,type:'glimmer_fairy'},
    // camp 64 [wildwood]
    {tx:190,tz:178,type:'glimmer_fairy'},
    // camp 65 [wildwood]
    {tx:124,tz:24,type:'glimmer_fairy'},
    // camp 66 [wildwood]
    {tx:53,tz:185,type:'glimmer_fairy'},
    // camp 67 [wildwood]
    {tx:25,tz:113,type:'glimmer_fairy'},
    // camp 68 [wildwood]
    {tx:103,tz:212,type:'glimmer_fairy'},
    // camp 69 [wildwood]
    {tx:205,tz:81,type:'glimmer_fairy'},
    // camp 70 [wildwood]
    {tx:201,tz:167,type:'glimmer_fairy'},
    // camp 71 [wildwood]
    {tx:103,tz:25,type:'glimmer_fairy'},
    // camp 72 [wildwood]
    {tx:28,tz:98,type:'glimmer_fairy'},
    // camp 73 [wildwood]
    {tx:212,tz:96,type:'glimmer_fairy'},
    // camp 74 [wildwood]
    {tx:215,tz:123,type:'glimmer_fairy'},
    // camp 75 [wildwood]
    {tx:136,tz:216,type:'bloom_sprite'},
    // camp 76 [wildwood]
    {tx:217,tz:142,type:'bloom_sprite'},
    // camp 77 [wildwood]
    {tx:215,tz:160,type:'bloom_sprite'},
    // camp 78 [wildwood]
    {tx:35,tz:61,type:'bloom_sprite'},
    // camp 79 [wildwood]
    {tx:67,tz:208,type:'bloom_sprite'},
    // camp 80 [wildwood]
    {tx:184,tz:201,type:'bloom_sprite'},
    // camp 81 [wildwood]
    {tx:192,tz:197,type:'bloom_sprite'},
    // camp 82 [wildwood]
    {tx:158,tz:22,type:'bloom_sprite'},
    // camp 83 [wildwood]
    {tx:15,tz:140,type:'bloom_sprite'},
    // camp 84 [wildwood]
    {tx:220,tz:78,type:'bloom_sprite'},
    // camp 85 [wildwood]
    {tx:17,tz:154,type:'bloom_sprite'},
    // camp 86 [wildwood]
    {tx:18,tz:81,type:'bloom_sprite'},
    // camp 87 [wildwood]
    {tx:34,tz:186,type:'bloom_sprite'},
    // camp 88 [wildwood]
    {tx:75,tz:22,type:'bloom_sprite'},
    // camp 89 [wildwood]
    {tx:43,tz:46,type:'bloom_sprite'},
    // camp 90 [wildwood]
    {tx:213,tz:63,type:'bloom_sprite'},
    // camp 91 [wildwood]
    {tx:215,tz:176,type:'bloom_sprite'},
    // camp 92 [wildwood]
    {tx:81,tz:222,type:'bloom_sprite'},
    // camp 93 [wildwood]
    {tx:145,tz:11,type:'bloom_sprite'},
    // camp 94 [wildwood]
    {tx:35,tz:195,type:'bloom_sprite'},
    // camp 95 [wildwood]
    {tx:204,tz:50,type:'bloom_sprite'},
    // camp 96 [wildwood]
    {tx:163,tz:224,type:'bloom_sprite'},
    // camp 97 [wildwood]
    {tx:21,tz:182,type:'bloom_sprite'},
    // camp 98 [wildwood]
    {tx:180,tz:220,type:'bloom_sprite'},
    // camp 99 [wildwood]
    {tx:57,tz:221,type:'bloom_sprite'},
    // camp 100 [wildwood]
    {tx:193,tz:26,type:'bloom_sprite'},
    // camp 101 [wildwood]
    {tx:63,tz:15,type:'bloom_sprite'},
    // camp 102 [wildwood]
    {tx:27,tz:45,type:'bloom_sprite'},
    // camp 103 [wildwood]
    {tx:16,tz:60,type:'bloom_sprite'},
    // camp 104 [wildwood]
    {tx:185,tz:12,type:'bloom_sprite'},
    // camp 105 [wildwood]
    {tx:42,tz:22,type:'bloom_sprite'},
    // camp 106 [wildwood]
    {tx:218,tz:202,type:'bloom_sprite'},
    // camp 107 [wildwood]
    {tx:15,tz:199,type:'bloom_sprite'},
    // camp 108 [outer bloom]
    {tx:40,tz:226,type:'bloom_sprite'},
    // camp 109 [outer bloom]
    {tx:205,tz:224,type:'bloom_sprite'},
    // camp 110 [outer bloom]
    {tx:21,tz:26,type:'bloom_sprite'},
    // camp 111 [outer bloom]
    {tx:227,tz:34,type:'bloom_sprite'},
    // camp 112 [outer bloom]
    {tx:228,tz:27,type:'bloom_sprite'},
    // camp 113 [outer bloom]
    {tx:14,tz:217,type:'bloom_sprite'},
    // camp 114 [outer bloom]
    {tx:222,tz:220,type:'bloom_sprite'},
  ],
  // ── XERON (v93.0-a94) — matches client ZONE_DEFS.xeron ──
  // Cut from 86 → 51 mobs to address dense-combat feedback.
  // Also incorporates a92's docking spire pushback (entry now tx 18-30, not 10-22).
  xeron: [
    // DOCKING SPIRE (entry, tx 18-30) — 7 mobs
    {tx:22,tz:36, type:'corrupted_xu'},     {tx:22,tz:44, type:'corrupted_xu'},
    {tx:26,tz:38, type:'corrupted_xu'},
    {tx:30,tz:36, type:'holo_wraith'},      {tx:30,tz:44, type:'holo_wraith'},
    {tx:18,tz:32, type:'corrupted_xu'},     {tx:18,tz:48, type:'corrupted_xu'},
    // LOWER INDUSTRIAL (tx 24-38) — 11 mobs, 2 camps with turrets preserved
    {tx:26,tz:30, type:'void_marine'},      {tx:28,tz:32, type:'void_marine'},
    {tx:24,tz:34, type:'laser_turret'},     {tx:26,tz:36, type:'corrupted_xu'},
    {tx:28,tz:48, type:'void_marine'},      {tx:26,tz:50, type:'corrupted_xu'},
    {tx:24,tz:46, type:'laser_turret'},
    {tx:32,tz:30, type:'corrupted_xu'},     {tx:32,tz:50, type:'corrupted_xu'},
    {tx:36,tz:32, type:'holo_wraith'},      {tx:36,tz:48, type:'holo_wraith'},
    // PLAZA OF SPIRES (tx 38-52) — 10 mobs, Shard Assassin + turret line preserved
    {tx:42,tz:40, type:'shard_assassin'},
    {tx:38,tz:32, type:'holo_wraith'},      {tx:38,tz:48, type:'holo_wraith'},
    {tx:42,tz:30, type:'corrupted_xu'},     {tx:42,tz:50, type:'corrupted_xu'},
    {tx:46,tz:34, type:'laser_turret'},     {tx:46,tz:46, type:'laser_turret'},
    {tx:44,tz:38, type:'void_marine'},      {tx:44,tz:42, type:'void_marine'},
    {tx:50,tz:40, type:'corrupted_xu'},
    // CYBER-FORGE DISTRICT (tx 52-64) — 10 mobs, both ogre camps preserved
    {tx:54,tz:30, type:'cyber_ogre'},
    {tx:56,tz:32, type:'corrupted_xu'},     {tx:58,tz:30, type:'void_marine'},
    {tx:54,tz:50, type:'cyber_ogre'},
    {tx:56,tz:48, type:'corrupted_xu'},     {tx:52,tz:46, type:'laser_turret'},
    {tx:60,tz:32, type:'void_marine'},      {tx:60,tz:48, type:'void_marine'},
    {tx:62,tz:40, type:'holo_wraith'},
    {tx:60,tz:40, type:'shard_assassin'},
    // THRONE APPROACH (tx 64-74) — 13 mobs, gate elite + assassins preserved
    {tx:64,tz:34, type:'laser_turret'},     {tx:64,tz:46, type:'laser_turret'},
    {tx:66,tz:40, type:'cyber_ogre'},
    {tx:68,tz:38, type:'shard_assassin'},   {tx:68,tz:42, type:'shard_assassin'},
    {tx:70,tz:36, type:'void_marine'},      {tx:70,tz:44, type:'void_marine'},
    {tx:72,tz:38, type:'corrupted_xu'},     {tx:72,tz:42, type:'corrupted_xu'},
    {tx:74,tz:36, type:'holo_wraith'},      {tx:74,tz:44, type:'holo_wraith'},
    {tx:70,tz:40, type:'cyber_ogre'},
    {tx:66,tz:36, type:'corrupted_xu'},
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
    const _baseHp = (zoneName === 'convergence') ? convBaseHp(s.type, st.hp) : st.hp;
    return {
      id: i,
      type: s.type,
      x: s.tx * TILE,
      z: s.tz * TILE,
      spawnX: s.tx * TILE,
      spawnZ: s.tz * TILE,
      hp: Math.round(_baseHp * scale),
      maxHp: Math.round(_baseHp * scale),
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
  // Idle despawn — no damage taken in the cutoff window
  if (Date.now() - wb.lastHitAt > WORLD_BOSS_IDLE_MS) {
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
  // a146 — World boss AI tick (one per game, independent of zone enemy loop)
  tickWorldBoss(game);
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
