const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const players = new Map(); // ws -> player obj
const games   = new Map(); // gameId -> game obj
let nextGameId = 1;

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
  lava_golem:        {hp:2200,  atk:78,  spd:0.018, aggroRange:8,  reward:320,  expR:100,  dmgReduction:0},
};

// Zone scale multipliers — matches client scaleMap
const ZONE_SCALE = {
  outpost:1.0, patrol:1.0, void:1.6, citadel:2.2, ashlands:2.8,
  sunken_sands:1.0, fungal:3.2, frostveil:3.6, ancient:4.0,
  sanctuary:1.0, dragonlair:1.0, riftvale:1.0, xumen:1.0,
  xumen_fortress:1.0, caves_of_despair:2.8, wyvernwastes:1.0, cemetery:1.4,
  necropolis:1.0,
};

// ══════════════════════════════════════════════════════════
// ZONE ENEMY SPAWNS — mirrors ZONE_DEFS.enemySpawns
// Only the spawn positions and types; stats come from ENEMY_STATS
// ══════════════════════════════════════════════════════════
const TILE = 1.6; // matches client TILE constant

const ZONE_SPAWNS = {
  outpost: [],
  patrol: [
    {tx:10,tz:8,type:'xu_scout'},{tx:28,tz:6,type:'xu_scout'},{tx:8,tz:14,type:'wraith'},{tx:26,tz:12,type:'wraith'},
    {tx:30,tz:18,type:'xu_scout'},{tx:36,tz:28,type:'xu_scout'},{tx:16,tz:34,type:'wraith'},{tx:32,tz:32,type:'xu_scout'},
    {tx:22,tz:8,type:'xu_siege_bot'},{tx:20,tz:14,type:'xu_siege_bot'},{tx:18,tz:20,type:'xu_siege_bot'},{tx:24,tz:32,type:'xu_siege_bot'},
    {tx:32,tz:8,type:'bandit_archer'},{tx:34,tz:10,type:'bandit_archer'},{tx:30,tz:10,type:'bandit'},{tx:32,tz:12,type:'bandit'},{tx:34,tz:6,type:'bandit'},
    {tx:8,tz:28,type:'xu_rebel'},{tx:10,tz:30,type:'xu_rebel'},{tx:6,tz:32,type:'xu_rebel'},{tx:12,tz:28,type:'xu_rebel'},{tx:10,tz:32,type:'xu_rebel'},
    {tx:36,tz:34,type:'sniper'},{tx:4,tz:8,type:'sniper'},
    {tx:44,tz:10,type:'xu_scout'},{tx:52,tz:8,type:'xu_scout'},{tx:60,tz:6,type:'wraith'},{tx:68,tz:10,type:'wraith'},
    {tx:48,tz:18,type:'xu_scout'},{tx:56,tz:16,type:'xu_scout'},{tx:72,tz:14,type:'xu_commander'},{tx:76,tz:20,type:'xu_scout'},
    {tx:46,tz:24,type:'xu_siege_bot'},{tx:58,tz:22,type:'xu_siege_bot'},{tx:64,tz:28,type:'xu_siege_bot'},{tx:72,tz:30,type:'xu_siege_bot'},
    {tx:64,tz:8,type:'bandit_archer'},{tx:66,tz:6,type:'bandit_archer'},{tx:68,tz:8,type:'bandit_archer'},
    {tx:62,tz:10,type:'bandit'},{tx:64,tz:12,type:'bandit'},{tx:68,tz:12,type:'bandit'},{tx:66,tz:10,type:'xu_siege_bot'},
    {tx:50,tz:58,type:'xu_rebel'},{tx:52,tz:60,type:'xu_rebel'},{tx:48,tz:60,type:'xu_rebel'},{tx:54,tz:58,type:'xu_rebel'},{tx:50,tz:62,type:'xu_rebel'},
    {tx:46,tz:56,type:'xu_rebel'},{tx:56,tz:62,type:'xu_rebel'},{tx:52,tz:56,type:'sniper'},{tx:48,tz:64,type:'sniper'},
    {tx:44,tz:48,type:'xu_scout'},{tx:60,tz:44,type:'xu_scout'},{tx:68,tz:50,type:'xu_commander'},{tx:56,tz:52,type:'xu_commander'},
    {tx:72,tz:56,type:'xu_scout'},{tx:44,tz:64,type:'xu_siege_bot'},
    {tx:74,tz:38,type:'sniper'},{tx:76,tz:40,type:'sniper'},{tx:72,tz:42,type:'bandit'},
    {tx:42,tz:36,type:'xu_commander'},{tx:58,tz:34,type:'xu_scout'},{tx:70,tz:36,type:'xu_siege_bot'},{tx:46,tz:70,type:'xu_rebel'},
    {tx:62,tz:68,type:'bandit'},{tx:74,tz:64,type:'xu_scout'},
    {tx:8,tz:44,type:'xu_scout'},{tx:20,tz:46,type:'xu_commander'},{tx:34,tz:42,type:'xu_scout'},{tx:12,tz:54,type:'xu_siege_bot'},
    {tx:28,tz:52,type:'xu_commander'},{tx:6,tz:60,type:'xu_scout'},{tx:22,tz:58,type:'xu_siege_bot'},{tx:36,tz:56,type:'xu_scout'},
    {tx:16,tz:64,type:'bandit_archer'},{tx:18,tz:66,type:'bandit_archer'},{tx:14,tz:66,type:'bandit'},{tx:20,tz:64,type:'bandit'},{tx:16,tz:68,type:'xu_siege_bot'},
    {tx:10,tz:70,type:'xu_rebel'},{tx:24,tz:70,type:'xu_rebel'},{tx:8,tz:74,type:'sniper'},{tx:30,tz:72,type:'xu_commander'},
    {tx:34,tz:68,type:'xu_scout'},{tx:20,tz:74,type:'xu_siege_bot'},
  ],
  cemetery: [
    {tx:10,tz:8,type:'skeleton_warrior'},{tx:14,tz:7,type:'skeleton_warrior'},{tx:18,tz:8,type:'skeleton_warrior'},{tx:24,tz:6,type:'skeleton_warrior'},
    {tx:28,tz:8,type:'bone_mage'},{tx:12,tz:12,type:'grave_crawler'},{tx:16,tz:11,type:'grave_crawler'},{tx:22,tz:12,type:'wraith'},
    {tx:26,tz:10,type:'wraith'},{tx:10,tz:16,type:'skeleton_warrior'},{tx:14,tz:15,type:'bone_mage'},{tx:18,tz:16,type:'grave_crawler'},
    {tx:22,tz:18,type:'skeleton_warrior'},{tx:26,tz:16,type:'grave_crawler'},{tx:30,tz:14,type:'wraith'},{tx:8,tz:20,type:'grave_crawler'},
    {tx:12,tz:20,type:'skeleton_warrior'},{tx:16,tz:21,type:'bone_mage'},{tx:20,tz:20,type:'wraith'},{tx:28,tz:20,type:'skeleton_warrior'},
    {tx:14,tz:18,type:'death_knight'},{tx:16,tz:17,type:'skeleton_warrior'},{tx:18,tz:18,type:'skeleton_warrior'},
    {tx:16,tz:20,type:'bone_mage'},{tx:14,tz:20,type:'grave_crawler'},{tx:20,tz:18,type:'grave_crawler'},
    {tx:34,tz:8,type:'skeleton_warrior'},{tx:38,tz:7,type:'skeleton_warrior'},{tx:42,tz:8,type:'bone_mage'},{tx:46,tz:6,type:'skeleton_warrior'},
    {tx:50,tz:8,type:'grave_crawler'},{tx:54,tz:6,type:'wraith'},{tx:36,tz:12,type:'grave_crawler'},{tx:40,tz:11,type:'wraith'},
    {tx:44,tz:12,type:'skeleton_warrior'},{tx:48,tz:10,type:'bone_mage'},{tx:52,tz:12,type:'grave_crawler'},{tx:56,tz:10,type:'skeleton_warrior'},
    {tx:60,tz:8,type:'skeleton_warrior'},{tx:64,tz:6,type:'wraith'},{tx:68,tz:8,type:'bone_mage'},{tx:72,tz:6,type:'skeleton_warrior'},
    {tx:58,tz:12,type:'grave_crawler'},{tx:62,tz:10,type:'skeleton_warrior'},{tx:66,tz:12,type:'grave_crawler'},{tx:70,tz:10,type:'death_knight'},
    {tx:74,tz:8,type:'wraith'},{tx:60,tz:16,type:'bone_mage'},{tx:64,tz:16,type:'skeleton_warrior'},{tx:68,tz:14,type:'grave_crawler'},
    {tx:72,tz:16,type:'wraith'},{tx:64,tz:12,type:'death_knight'},{tx:68,tz:10,type:'death_knight'},
    {tx:10,tz:30,type:'skeleton_warrior'},{tx:14,tz:28,type:'grave_crawler'},{tx:18,tz:30,type:'wraith'},{tx:22,tz:28,type:'bone_mage'},
    {tx:26,tz:30,type:'skeleton_warrior'},{tx:30,tz:28,type:'grave_crawler'},{tx:34,tz:30,type:'wraith'},{tx:38,tz:28,type:'skeleton_warrior'},
    {tx:42,tz:30,type:'bone_mage'},{tx:46,tz:28,type:'grave_crawler'},{tx:50,tz:30,type:'skeleton_warrior'},{tx:54,tz:28,type:'wraith'},
  ],
  void: [
    {tx:10,tz:10,type:'void_phantom'},{tx:20,tz:8,type:'void_stalker'},{tx:30,tz:12,type:'void_eye'},{tx:40,tz:8,type:'void_phantom'},
    {tx:50,tz:10,type:'void_stalker'},{tx:60,tz:8,type:'void_eye'},{tx:70,tz:12,type:'void_phantom'},
    {tx:12,tz:24,type:'void_stalker'},{tx:24,tz:22,type:'void_eye'},{tx:36,tz:24,type:'void_phantom'},{tx:48,tz:22,type:'void_stalker'},
    {tx:60,tz:24,type:'void_eye'},{tx:72,tz:22,type:'void_phantom'},{tx:8,tz:36,type:'void_stalker'},{tx:20,tz:34,type:'void_phantom'},
    {tx:32,tz:36,type:'void_eye'},{tx:44,tz:34,type:'void_stalker'},{tx:56,tz:36,type:'void_phantom'},{tx:68,tz:34,type:'void_stalker'},
    {tx:14,tz:48,type:'void_eye'},{tx:28,tz:46,type:'void_phantom'},{tx:42,tz:48,type:'void_stalker'},{tx:56,tz:46,type:'void_eye'},
    {tx:70,tz:48,type:'void_phantom'},{tx:10,tz:60,type:'void_stalker'},{tx:24,tz:58,type:'void_eye'},{tx:38,tz:60,type:'void_phantom'},
    {tx:52,tz:58,type:'void_stalker'},{tx:66,tz:60,type:'void_eye'},
  ],
  citadel: [
    {tx:10,tz:10,type:'iron_guard'},{tx:22,tz:8,type:'citadel_mage'},{tx:34,tz:10,type:'iron_guard'},{tx:46,tz:8,type:'citadel_mage'},
    {tx:58,tz:10,type:'iron_guard'},{tx:70,tz:8,type:'citadel_mage'},{tx:12,tz:22,type:'citadel_mage'},{tx:24,tz:20,type:'iron_guard'},
    {tx:36,tz:22,type:'xu_shieldbot'},{tx:48,tz:20,type:'iron_guard'},{tx:60,tz:22,type:'citadel_mage'},{tx:72,tz:20,type:'xu_shieldbot'},
    {tx:8,tz:34,type:'iron_guard'},{tx:20,tz:32,type:'xu_commander_elite'},{tx:32,tz:34,type:'iron_guard'},{tx:44,tz:32,type:'xu_sniper_elite'},
    {tx:56,tz:34,type:'iron_guard'},{tx:68,tz:32,type:'citadel_mage'},{tx:14,tz:46,type:'xu_shieldbot'},{tx:28,tz:44,type:'iron_guard'},
    {tx:42,tz:46,type:'citadel_mage'},{tx:56,tz:44,type:'xu_commander_elite'},{tx:70,tz:46,type:'iron_guard'},
    {tx:10,tz:58,type:'citadel_mage'},{tx:24,tz:56,type:'iron_guard'},{tx:38,tz:58,type:'xu_shieldbot'},
    {tx:52,tz:56,type:'citadel_mage'},{tx:66,tz:58,type:'iron_guard'},
  ],
  ashlands: [
    {tx:10,tz:10,type:'ash_wraith'},{tx:22,tz:8,type:'magma_crab'},{tx:34,tz:10,type:'ash_wraith'},{tx:46,tz:8,type:'magma_crab'},
    {tx:58,tz:10,type:'ash_wraith'},{tx:70,tz:8,type:'lava_golem'},
    {tx:12,tz:22,type:'magma_crab'},{tx:24,tz:20,type:'ash_wraith'},{tx:36,tz:22,type:'lava_golem'},{tx:48,tz:20,type:'ash_wraith'},
    {tx:60,tz:22,type:'magma_crab'},{tx:72,tz:20,type:'ash_wraith'},
    {tx:8,tz:34,type:'ash_wraith'},{tx:20,tz:32,type:'lava_golem'},{tx:32,tz:34,type:'magma_crab'},{tx:44,tz:32,type:'ash_wraith'},
    {tx:56,tz:34,type:'lava_golem'},{tx:68,tz:32,type:'magma_crab'},
    {tx:14,tz:46,type:'ash_wraith'},{tx:28,tz:44,type:'magma_crab'},{tx:42,tz:46,type:'lava_golem'},{tx:56,tz:44,type:'ash_wraith'},
    {tx:70,tz:46,type:'magma_crab'},{tx:10,tz:58,type:'lava_golem'},{tx:24,tz:56,type:'ash_wraith'},{tx:38,tz:58,type:'magma_crab'},
  ],
  fungal: [
    {tx:10,tz:10,type:'mushroom_man'},{tx:20,tz:8,type:'spore_walker'},{tx:30,tz:10,type:'mycelium_horror'},{tx:40,tz:8,type:'mushroom_man'},
    {tx:50,tz:10,type:'fungal_shambler'},{tx:60,tz:8,type:'spore_walker'},{tx:70,tz:10,type:'mushroom_man'},
    {tx:12,tz:22,type:'spore_walker'},{tx:24,tz:20,type:'mycelium_horror'},{tx:36,tz:22,type:'mushroom_man'},{tx:48,tz:20,type:'fungal_shambler'},
    {tx:60,tz:22,type:'mycelium_horror'},{tx:72,tz:20,type:'spore_walker'},{tx:8,tz:34,type:'mushroom_man'},{tx:20,tz:32,type:'fungal_shambler'},
    {tx:32,tz:34,type:'spore_walker'},{tx:44,tz:32,type:'mycelium_horror'},{tx:56,tz:34,type:'mushroom_man'},{tx:68,tz:32,type:'fungal_shambler'},
    {tx:14,tz:46,type:'mycelium_horror'},{tx:28,tz:44,type:'spore_walker'},{tx:42,tz:46,type:'fungal_shambler'},{tx:56,tz:44,type:'mushroom_man'},
    {tx:70,tz:46,type:'mycelium_horror'},
  ],
  frostveil: [
    {tx:10,tz:10,type:'polar_bear'},{tx:22,tz:8,type:'ice_golem'},{tx:34,tz:10,type:'frost_specter'},{tx:46,tz:8,type:'polar_bear'},
    {tx:58,tz:10,type:'ice_golem'},{tx:70,tz:8,type:'frost_wraith'},
    {tx:12,tz:22,type:'frost_specter'},{tx:24,tz:20,type:'polar_bear'},{tx:36,tz:22,type:'ice_golem'},{tx:48,tz:20,type:'frost_wraith'},
    {tx:60,tz:22,type:'polar_bear'},{tx:72,tz:20,type:'frost_specter'},
    {tx:8,tz:34,type:'ice_golem'},{tx:20,tz:32,type:'frost_wraith'},{tx:32,tz:34,type:'polar_bear'},{tx:44,tz:32,type:'frost_specter'},
    {tx:56,tz:34,type:'ice_golem'},{tx:68,tz:32,type:'polar_bear'},
    {tx:14,tz:46,type:'frost_wraith'},{tx:28,tz:44,type:'frost_specter'},{tx:42,tz:46,type:'polar_bear'},{tx:56,tz:44,type:'ice_golem'},
    {tx:70,tz:46,type:'frost_wraith'},
  ],
  ancient: [
    {tx:10,tz:10,type:'stone_sentinel'},{tx:22,tz:8,type:'vine_horror'},{tx:34,tz:10,type:'ancient_guardian'},{tx:46,tz:8,type:'stone_sentinel'},
    {tx:58,tz:10,type:'ancient_guardian'},{tx:70,tz:8,type:'vine_horror'},
    {tx:12,tz:22,type:'ancient_guardian'},{tx:24,tz:20,type:'stone_sentinel'},{tx:36,tz:22,type:'vine_horror'},{tx:48,tz:20,type:'ancient_guardian'},
    {tx:60,tz:22,type:'stone_sentinel'},{tx:72,tz:20,type:'ancient_guardian'},
    {tx:8,tz:34,type:'vine_horror'},{tx:20,tz:32,type:'ancient_guardian'},{tx:32,tz:34,type:'stone_sentinel'},{tx:44,tz:32,type:'vine_horror'},
    {tx:56,tz:34,type:'ancient_guardian'},{tx:68,tz:32,type:'stone_sentinel'},
    {tx:14,tz:46,type:'ancient_guardian'},{tx:28,tz:44,type:'vine_horror'},{tx:42,tz:46,type:'stone_sentinel'},{tx:56,tz:44,type:'ancient_guardian'},
  ],
  sunken_sands: [
    {tx:10,tz:10,type:'sand_scorpion'},{tx:22,tz:8,type:'desert_snake'},{tx:34,tz:10,type:'sand_mummy'},{tx:46,tz:8,type:'sand_scorpion'},
    {tx:58,tz:10,type:'dune_skeleton'},{tx:70,tz:8,type:'desert_snake'},
    {tx:12,tz:22,type:'dune_skeleton'},{tx:24,tz:20,type:'sand_mummy'},{tx:36,tz:22,type:'sand_scorpion'},{tx:48,tz:20,type:'sand_worm'},
    {tx:60,tz:22,type:'dune_skeleton'},{tx:72,tz:20,type:'sand_scorpion'},
    {tx:8,tz:34,type:'sand_mummy'},{tx:20,tz:32,type:'desert_snake'},{tx:32,tz:34,type:'dune_skeleton'},{tx:44,tz:32,type:'sand_scorpion'},
    {tx:56,tz:34,type:'sand_worm'},{tx:68,tz:32,type:'sand_mummy'},
    {tx:14,tz:46,type:'desert_snake'},{tx:28,tz:44,type:'sand_scorpion'},{tx:42,tz:46,type:'dune_skeleton'},{tx:56,tz:44,type:'sand_mummy'},
  ],
  necropolis: [
    {tx:10,tz:10,type:'necro_specter'},{tx:22,tz:8,type:'necro_wight'},{tx:34,tz:10,type:'necro_lich_mage'},{tx:46,tz:8,type:'necro_specter'},
    {tx:58,tz:10,type:'necro_abomination'},{tx:70,tz:8,type:'necro_wight'},
    {tx:12,tz:22,type:'necro_lich_mage'},{tx:24,tz:20,type:'necro_specter'},{tx:36,tz:22,type:'necro_wight'},{tx:48,tz:20,type:'necro_abomination'},
    {tx:60,tz:22,type:'necro_lich_mage'},{tx:72,tz:20,type:'necro_specter'},
    {tx:8,tz:34,type:'necro_wight'},{tx:20,tz:32,type:'necro_abomination'},{tx:32,tz:34,type:'necro_specter'},{tx:44,tz:32,type:'necro_lich_mage'},
    {tx:56,tz:34,type:'necro_wight'},{tx:68,tz:32,type:'necro_abomination'},
  ],
  riftvale: [
    {tx:10,tz:10,type:'rift_stalker'},{tx:22,tz:8,type:'psyche_horror'},{tx:34,tz:10,type:'rift_weaver'},{tx:46,tz:8,type:'rift_stalker'},
    {tx:58,tz:10,type:'void_colossus'},{tx:70,tz:8,type:'rift_weaver'},
    {tx:12,tz:22,type:'psyche_horror'},{tx:24,tz:20,type:'rift_stalker'},{tx:36,tz:22,type:'void_colossus'},{tx:48,tz:20,type:'rift_weaver'},
    {tx:60,tz:22,type:'rift_stalker'},{tx:72,tz:20,type:'psyche_horror'},
    {tx:8,tz:34,type:'rift_weaver'},{tx:20,tz:32,type:'rift_stalker'},{tx:32,tz:34,type:'void_colossus'},{tx:44,tz:32,type:'psyche_horror'},
  ],
  xumen: [
    {tx:10,tz:10,type:'xu_titan'},{tx:22,tz:8,type:'xu_enforcer'},{tx:34,tz:10,type:'xu_annihilator'},{tx:46,tz:8,type:'xu_titan'},
    {tx:58,tz:10,type:'xu_supreme'},{tx:70,tz:8,type:'xu_enforcer'},
    {tx:12,tz:22,type:'xu_supreme'},{tx:24,tz:20,type:'xu_titan'},{tx:36,tz:22,type:'xu_enforcer'},{tx:48,tz:20,type:'xu_annihilator'},
    {tx:60,tz:22,type:'xu_supreme'},{tx:72,tz:20,type:'xu_titan'},
    {tx:8,tz:34,type:'xu_enforcer'},{tx:20,tz:32,type:'xu_annihilator'},{tx:32,tz:34,type:'xu_supreme'},{tx:44,tz:32,type:'xu_titan'},
  ],
  xumen_fortress: [
    {tx:10,tz:10,type:'xf_titan_elite'},{tx:22,tz:8,type:'xf_fortress_drone'},{tx:34,tz:10,type:'xf_siege_walker'},{tx:46,tz:8,type:'xf_warlord'},
    {tx:58,tz:10,type:'xf_titan_elite'},{tx:70,tz:8,type:'xf_fortress_drone'},
    {tx:12,tz:22,type:'xf_warlord'},{tx:24,tz:20,type:'xf_siege_walker'},{tx:36,tz:22,type:'xf_titan_elite'},{tx:48,tz:20,type:'xf_fortress_drone'},
    {tx:60,tz:22,type:'xf_warlord'},{tx:72,tz:20,type:'xf_siege_walker'},
    {tx:8,tz:34,type:'xf_titan_elite'},{tx:20,tz:32,type:'xf_fortress_drone'},{tx:32,tz:34,type:'xf_warlord'},{tx:44,tz:32,type:'xf_siege_walker'},
  ],
  caves_of_despair: [
    {tx:10,tz:10,type:'xu_miner'},{tx:22,tz:8,type:'xu_overseer'},{tx:34,tz:10,type:'xu_miner'},{tx:46,tz:8,type:'xu_overseer'},
    {tx:58,tz:10,type:'xu_miner'},{tx:70,tz:8,type:'xu_overseer'},
    {tx:12,tz:22,type:'xu_miner'},{tx:24,tz:20,type:'xu_overseer'},{tx:36,tz:22,type:'xu_miner'},{tx:48,tz:20,type:'xu_overseer'},
    {tx:60,tz:22,type:'xu_miner'},{tx:72,tz:20,type:'xu_overseer'},
    {tx:8,tz:34,type:'xu_miner'},{tx:20,tz:32,type:'xu_overseer'},{tx:32,tz:34,type:'xu_miner'},{tx:44,tz:32,type:'xu_overseer'},
  ],
  wyvernwastes: [
    {tx:10,tz:10,type:'wyvern'},{tx:22,tz:8,type:'wyvern_warlord'},{tx:34,tz:10,type:'elder_dragon'},{tx:46,tz:8,type:'deep_wyrm'},
    {tx:58,tz:10,type:'wyvern'},{tx:70,tz:8,type:'wyvern_warlord'},
    {tx:12,tz:22,type:'deep_wyrm'},{tx:24,tz:20,type:'elder_dragon'},{tx:36,tz:22,type:'wyvern_warlord'},{tx:48,tz:20,type:'wyvern'},
    {tx:60,tz:22,type:'deep_wyrm'},{tx:72,tz:20,type:'elder_dragon'},
    {tx:8,tz:34,type:'wyvern_warlord'},{tx:20,tz:32,type:'deep_wyrm'},{tx:32,tz:34,type:'wyvern'},{tx:44,tz:32,type:'elder_dragon'},
  ],
  dragonlair: [
    {tx:10,tz:10,type:'fire_demon'},{tx:22,tz:8,type:'wyvern'},{tx:34,tz:10,type:'void_spider'},{tx:46,tz:8,type:'inferno_golem'},
    {tx:58,tz:10,type:'fire_demon'},{tx:70,tz:8,type:'wyvern'},
    {tx:12,tz:22,type:'void_spider'},{tx:24,tz:20,type:'inferno_golem'},{tx:36,tz:22,type:'fire_demon'},{tx:48,tz:20,type:'wyvern'},
    {tx:60,tz:22,type:'void_spider'},{tx:72,tz:20,type:'inferno_golem'},
  ],
  sanctuary: [],
};

// ══════════════════════════════════════════════════════════
// GAME ZONE STATE
// Each game has zones. Each zone has enemies[].
// ══════════════════════════════════════════════════════════

function createZoneEnemies(zoneName) {
  const spawns = ZONE_SPAWNS[zoneName] || [];
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
    if (zonePlayers.length === 0) return; // no players — skip AI, save CPU

    zone.lastActivity = Date.now();
    const changed = []; // enemies whose state changed this tick

    zone.enemies.forEach(e => {
      // Respawn dead enemies
      if (!e.active) {
        e.respawnTimer++;
        if (e.respawnTimer >= RESPAWN_TICKS) {
          e.active = true;
          e.hp = e.maxHp;
          e.x = e.spawnX;
          e.z = e.spawnZ;
          e.respawnTimer = 0;
          e.aggroed = false;
          changed.push(e);
        }
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
        // Send damage to the nearest player's ws
        players.forEach((p, ws) => {
          if (p === nearestPlayer) {
            send(ws, { type:'sv_enemy_attack', eid:e.id, dmg, ex:e.x, ez:e.z });
          }
        });
      }
    });

    // Broadcast state for changed enemies (positions + HP)
    if (changed.length > 0) {
      const ids=[], xs=[], zs=[], hps=[], acts=[];
      changed.forEach(e => {
        ids.push(e.id);
        xs.push(+e.x.toFixed(2));
        zs.push(+e.z.toFixed(2));
        hps.push(e.hp);
        acts.push(e.active ? 1 : 0);
      });
      broadcastToZone(game.id, zoneName, { type:'sv_enemy_state', zone:zoneName, ids, xs, zs, hps, acts });
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
  send(ws, { type:'sv_zone_snapshot', zone:zoneName, ids, xs, zs, hps, maxhps, types, acts });
}

// ══════════════════════════════════════════════════════════
// GLOBAL GAME LOOP — 10Hz
// ══════════════════════════════════════════════════════════
setInterval(() => {
  games.forEach(game => {
    if (game.started) tickGame(game);
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
          zones: {}, // zone name -> { enemies[], lastActivity }
        };
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
        // Player entered a new zone — send them the full enemy snapshot
        player.zone = data.zone;
        if (!player.gameId) break;
        const g = games.get(player.gameId);
        if (!g) break;
        g.started = true;
        sendZoneSnapshot(ws, g, data.zone);
        // Announce to other players in zone
        broadcastToZone(g.id, data.zone, {
          type:'sv_player_entered', name:player.name, zone:data.zone
        }, ws);
        break;
      }

      case 'sv_hit_enemy': {
        // Client hit an enemy — server validates and applies damage
        if (!player.gameId || !player.zone) break;
        const g = games.get(player.gameId);
        if (!g) break;
        const zone = g.zones[player.zone];
        if (!zone) break;
        const e = zone.enemies.find(en => en.id === data.id && en.active);
        if (!e) break;

        // Validate player is close enough (anti-cheat: max 12 units)
        if (player.x !== undefined) {
          const dx = player.x - e.x, dz = player.z - e.z;
          if (dx*dx + dz*dz > 144) break; // > 12 units away, reject
        }

        // Apply damage with dmgReduction
        const rawDmg = Math.max(1, Math.floor((data.dmg||1) * (1 - e.dmgReduction)));
        e.hp -= rawDmg;

        if (e.hp <= 0) {
          // Enemy killed
          e.hp = 0;
          e.active = false;
          e.aggroed = false;
          e.respawnTimer = 0;
          // Broadcast kill to all players in zone — they get XP/gold only if in zone (enforced client-side)
          broadcastToZone(g.id, player.zone, {
            type:'sv_enemy_killed',
            id:e.id, etype:e.type, zone:player.zone,
            reward:e.reward, expR:e.expR,
            ex:+e.x.toFixed(2), ez:+e.z.toFixed(2)
          });
        } else {
          // Broadcast updated HP to zone
          broadcastToZone(g.id, player.zone, {
            type:'sv_enemy_hit',
            id:e.id, hp:e.hp, maxHp:e.maxHp,
            dmg:rawDmg, ex:+e.x.toFixed(2), ez:+e.z.toFixed(2)
          });
        }
        break;
      }

      case 'sv_hit_boss': {
        // Relay boss hits to all players in zone (boss HP managed client-side for now)
        if (!player.gameId || !player.zone) break;
        broadcastToZone(player.gameId, player.zone, {
          type:'sv_boss_hit', dmg:data.dmg, zone:player.zone,
          name:player.name
        }, ws);
        break;
      }
    }
  });

  ws.on('close',  () => removePlayer(ws));
  ws.on('error',  () => removePlayer(ws));
});

// Clean up old games every hour
setInterval(()=>{
  const now = Date.now();
  games.forEach((g,id) => {
    if (now - g.createdAt > 6*60*60*1000) games.delete(id);
  });
  broadcastGameList();
}, 60*60*1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Empire 2 server running on port ' + PORT));
