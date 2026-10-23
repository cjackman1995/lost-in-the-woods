/**
 * WILDWOOD — a third-person 3D survival game (Expo + three.js)
 * ------------------------------------------------------------
 * Single file. Dependencies: three@0.136.0, expo-gl (pin both in package.json for Snack).
 *
 * Level 1 — Forest: gather, fasten an axe, club rats, fell trees, build a lean-to + fire, survive the night.
 * Level 2 — Desert: craft a pickaxe, follow the trail east, find the village, mine copper/tin/limestone,
 *           smelt bronze, forge weapons and armor, buy land or defend your camp from nightly raids,
 *           and wipe out the marauder camp for Chief Soloman.
 * Desert Cave — open from the start: a cave mouth in the cliffs beyond the oasis. Pull two levers to open the
 *           Ancient Mummy Guardian's chamber, find two unique weapons, and take his golden key for the shortcut out.
 *
 * Touch: left thumb = move, drag elsewhere = camera, USE / ATTACK / DODGE buttons. Tap the minimap to enlarge it.
 * Keyboard (web): WASD move, mouse-drag camera, E use (hold to chop/mine), Space attack, Shift or Q dodge,
 *                 C craft, B bag, G goals, M map, Esc close.
 */
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, useWindowDimensions, ScrollView, Platform, StatusBar } from 'react-native';
import { GLView } from 'expo-gl';
import * as THREE from 'three';

/* Snack can only bundle three.js up to r136 (later versions ship as ES modules it can't build).
   r136 predates built-in color management, so treat every hex color as sRGB and light in linear
   space the way modern three.js does. On newer versions this block does nothing. */
const LEGACY_THREE = !('ColorManagement' in THREE);
if (LEGACY_THREE && !THREE.Color.prototype.__srgbPatched) {
  const setHex = THREE.Color.prototype.setHex;
  THREE.Color.prototype.setHex = function (hex) {
    setHex.call(this, hex);
    return this.convertSRGBToLinear();
  };
  THREE.Color.prototype.__srgbPatched = true;
}

/* =====================================================================
   HELPERS
   ===================================================================== */
const DAY_SECONDS = 420; // one full day/night = 7 real minutes
const FIRE_MAX = 240;
const FIRE_RANGE = 12;
const PLAYER_R = 0.38;
const WATERSKIN_CAP = 4;
// Playtest tools: shortcut starts on the title screen + a 🧪 cheat panel in game. Set to false before sharing with players.
const PLAYTEST = true;
const SMELT_CHANCE = 0.8;
/* Energy: a full bar lasts about 20+ minutes of active play, so quests and dungeons don't force a trip
   back to bed. Night still lets you sleep any time, whatever your energy. */
const ENERGY = {
  idle: 0.05, // per second, always
  run: 0.02, // extra while running
  heat: 0.017, // extra in the desert sun
  swing: 0.13, // per attack
  heavySwing: 0.23, // per mace attack
  dodge: 1, // per dodge roll
  work: 0.2, // per chop or pick swing
};

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const angDiff = (a, b) => {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
};
const dist2 = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);

function rng(g) {
  g.seed = (g.seed + 0x6d2b79f5) | 0;
  let t = g.seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/* =====================================================================
   REGIONS + TERRAIN
   ===================================================================== */
export const REGIONS = {
  forest: { name: 'Forest', r: 62 },
  desert: { name: 'Desert', r: 76 },
  cave: { name: 'Desert Cave', r: 60 },
};
export const DESERT = {
  arrival: { x: -68, z: 2 },
  village: { x: -34, z: 18, r: 14 },
  oasis: { x: 6, z: -36, r: 7, level: 0.3 },
  camp: { x: 44, z: 32, r: 16, level: 0.6 },
  campPondR: 5,
};
// the plot of land Chief Soloman sells, just north of the village (axis-aligned square)
export const PLOT = { x: -41.8, z: 40.7, half: 8, price: 500 };
const FOREST_TRAIL = { x: 57, z: 0 };
// the cave mouth, cut into the cliffs beyond the oasis; it opens toward the middle of the map
export const CAVE_MOUTH = { x: 12, z: -66 };
CAVE_MOUTH.rot = Math.atan2(-CAVE_MOUTH.x, -CAVE_MOUTH.z);

let REGION = 'forest'; // which terrain heightAt() samples; set whenever the player travels
let GRID = null; // the cave's walkable grid while the player is underground (walls are grid cells, not circles)
function setRegion(g) {
  REGION = g.region;
  GRID = g.region === 'cave' && g.w ? g.w.grid : null;
}

function forestHeight(x, z) {
  const d = Math.hypot(x, z);
  let h =
    Math.sin(x * 0.07) * Math.cos(z * 0.06) * 1.1 +
    Math.sin(x * 0.021 + 1.3) * Math.sin(z * 0.027 + 0.4) * 2.2 +
    Math.sin((x - z) * 0.16) * 0.18;
  h *= smooth(5, 24, d);
  h += smooth(56, 88, d) * 10;
  return h;
}
function desertHeight(x, z) {
  const d = Math.hypot(x, z);
  let h = Math.sin(x * 0.055 + z * 0.02) * 2.0 + Math.sin(z * 0.085 - x * 0.035) * 1.0 + Math.sin((x + z) * 0.2) * 0.22 + 1.6;
  const flatten = (p, r, level) => {
    const k = 1 - smooth(r, r + 9, Math.hypot(x - p.x, z - p.z));
    h = lerp(h, level, k);
  };
  flatten(DESERT.village, DESERT.village.r, 0.8);
  flatten(PLOT, PLOT.half * 1.5, 0.8);
  flatten(DESERT.camp, DESERT.camp.r, DESERT.camp.level);
  flatten(DESERT.oasis, DESERT.oasis.r + 3, DESERT.oasis.level);
  flatten(DESERT.arrival, 5, 1.0);
  const pond = (p, r) => {
    const pd = Math.hypot(x - p.x, z - p.z);
    if (pd < r + 1) h -= (1 - smooth(r - 2.5, r + 1, pd)) * 1.1;
  };
  pond(DESERT.oasis, DESERT.oasis.r);
  pond(DESERT.camp, DESERT.campPondR);
  h += smooth(72, 104, d) * 18; // canyon walls
  return h;
}
export function heightAt(x, z) {
  if (REGION === 'cave') return 0; // the cave floor is flat; pits and water are their own grid cells
  return REGION === 'desert' ? desertHeight(x, z) : forestHeight(x, z);
}

export function isNight(tod) {
  return tod >= 0.66 || tod < 0.03;
}
export function darkness(tod) {
  if (tod < 0.06) return 1 - tod / 0.06;
  if (tod < 0.56) return 0;
  if (tod < 0.7) return (tod - 0.56) / 0.14;
  return 1;
}
export function clockText(tod) {
  const mins = Math.floor(((6 + tod * 24) % 24) * 60);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

// the village + the plot are a safe zone: no animal or marauder ever enters it
export function inVillage(x, z) {
  return dist2(x, z, DESERT.village.x, DESERT.village.z) < DESERT.village.r + 3;
}
export function inPlot(x, z, pad = 0) {
  return Math.abs(x - PLOT.x) < PLOT.half + pad && Math.abs(z - PLOT.z) < PLOT.half + pad;
}
export function inSafeZone(g, x, z) {
  return g.region === 'desert' && (inVillage(x, z) || inPlot(x, z, 1));
}
function pushOutOfSafeZone(e, rad) {
  for (let k = 0; k < 2; k++) {
    const V = DESERT.village;
    const R = V.r + 3 + rad;
    const d = dist2(e.x, e.z, V.x, V.z);
    if (d < R) {
      const ux = d > 1e-3 ? (e.x - V.x) / d : 1;
      const uz = d > 1e-3 ? (e.z - V.z) / d : 0;
      e.x = V.x + ux * R;
      e.z = V.z + uz * R;
    }
    const H = PLOT.half + 1 + rad;
    const lx = e.x - PLOT.x;
    const lz = e.z - PLOT.z;
    if (Math.abs(lx) < H && Math.abs(lz) < H) {
      if (H - Math.abs(lx) < H - Math.abs(lz)) e.x = PLOT.x + Math.sign(lx || 1) * H;
      else e.z = PLOT.z + Math.sign(lz || 1) * H;
    }
  }
}

/* =====================================================================
   GAME DATA
   ===================================================================== */
export const ITEMS = {
  stick: { name: 'Stick', icon: '🥢' },
  stone: { name: 'Stone', icon: '🪨' },
  fiber: { name: 'Plant fiber', icon: '🌾' },
  log: { name: 'Log', icon: '🪵' },
  copper: { name: 'Copper ore', icon: '🟠' },
  tin: { name: 'Tin ore', icon: '⚪' },
  bronzeBar: { name: 'Bronze bar', icon: '🟧' },
  limestone: { name: 'Limestone', icon: '⬜' },
  stoneBlock: { name: 'Stone block', icon: '🧱' },
  leather: { name: 'Leather', icon: '🟫' },
  water: { name: 'Water', icon: '💧' },
  berries: { name: 'Berries', icon: '🍒', food: { hunger: 8 } },
  dates: { name: 'Dates', icon: '🌴', food: { hunger: 10, thirst: 8 } },
  mushroom: { name: 'Mushroom', icon: '🍄', food: { hunger: 6, risk: 0.35, dmg: 12 } },
  rawMeat: { name: 'Raw meat', icon: '🥩', food: { hunger: 10, dmg: 14, sick: true } },
  cookedMeat: { name: 'Cooked meat', icon: '🍖', food: { hunger: 38, heal: 10 } },
  roastedMushroom: { name: 'Roasted mushroom', icon: '🍢', food: { hunger: 15, heal: 3 } },
  goldenKey: { name: 'Golden key', icon: '🗝️' },
};
/* Weapons: dmg per hit, swing = attack animation (s), cd = time before the next swing, reach/arc = hit area,
   kb = knockback multiplier, stagger = can interrupt even the King's wind-up.
   Armor: share of incoming damage absorbed. Bronze gear lasts far longer than anything made of wood or stone. */
export const TOOLS = {
  axe: { name: 'Stone axe', icon: '🪓', kind: 'weapon', dmg: 2, swing: 0.42, cd: 0.5, reach: 2.2, arc: 1.25, kb: 1, maxDur: 45 },
  club: { name: 'Wooden club', icon: '🏏', kind: 'weapon', dmg: 3, swing: 0.42, cd: 0.5, reach: 2.2, arc: 1.25, kb: 1, maxDur: 35 },
  pickaxe: { name: 'Stone pickaxe', icon: '⛏️', kind: 'weapon', dmg: 2, swing: 0.42, cd: 0.5, reach: 2.2, arc: 1.25, kb: 1, maxDur: 60 },
  hammer: { name: 'Smithing hammer', icon: '🔨', kind: 'tool', maxDur: 40, desc: 'Needed to work bronze at an anvil.' },
  waterskin: { name: 'Waterskin', icon: '🫙', kind: 'tool', maxDur: 0 },
  dagger: { name: 'Bronze dagger', icon: '🔪', kind: 'weapon', dmg: 4, swing: 0.26, cd: 0.3, reach: 1.9, arc: 1.1, kb: 0.6, maxDur: 180, desc: 'Lightning-fast stabs.' },
  sword: { name: 'Bronze sword', icon: '🗡️', kind: 'weapon', dmg: 6, swing: 0.36, cd: 0.42, reach: 2.5, arc: 1.45, kb: 1, maxDur: 200, desc: 'Balanced reach and speed.' },
  mace: { name: 'Bronze mace', icon: '🔱', kind: 'weapon', dmg: 9, swing: 0.55, cd: 0.7, reach: 2.2, arc: 1.3, kb: 1.8, stagger: true, maxDur: 220, desc: 'Slow, crushing blows that stagger even the King.' },
  // unique weapons, found only in the Desert Cave's treasure chests
  khopesh: { name: 'Ancient Khopesh', icon: '🌙', kind: 'weapon', dmg: 7, swing: 0.3, cd: 0.36, reach: 2.4, arc: 1.75, kb: 1, maxDur: 280, desc: 'A sickle-sword of the old kings. Fast, wide sweeping cuts.' },
  spear: { name: 'Scarab Spear', icon: '🪲', kind: 'weapon', dmg: 7, swing: 0.42, cd: 0.5, reach: 3.5, arc: 0.7, kb: 1.4, maxDur: 280, desc: 'The longest reach of any weapon. Strike from a safe distance.' },
  shield: { name: 'Bronze shield', icon: '🛡️', kind: 'shield', maxDur: 180, desc: 'Blocks most of a frontal hit, and all arrows.' },
  helmet: { name: 'Bronze helmet', icon: '⛑️', kind: 'armor', armor: 0.1, maxDur: 200 },
  platelegs: { name: 'Bronze platelegs', icon: '👖', kind: 'armor', armor: 0.15, maxDur: 230 },
  platebody: { name: 'Bronze platebody', icon: '🦺', kind: 'armor', armor: 0.25, maxDur: 260 },
};
const WEAPONS = Object.keys(TOOLS).filter((k) => TOOLS[k].kind === 'weapon');
const ARMOR = Object.keys(TOOLS).filter((k) => TOOLS[k].kind === 'armor');
export const FORGE = [
  { id: 'dagger', bars: 4 },
  { id: 'sword', bars: 5 },
  { id: 'mace', bars: 5 },
  { id: 'helmet', bars: 6 },
  { id: 'platelegs', bars: 8 },
  { id: 'shield', bars: 8 },
  { id: 'platebody', bars: 10 },
];
/* Buildings: hp = how much marauder punishment it takes, size = footprint radius (how close raiders must get),
   ahead/room = placement distance in front of you and clearance needed. */
export const BUILDS = {
  shelter: { name: 'lean-to shelter', hp: 120, size: 1.5, ahead: 2.8, room: 1.7, repair: 'log' },
  fire: { name: 'fire pit', hp: 80, size: 0.9, ahead: 2.0, room: 0.9, repair: 'log' },
  hut: { name: 'stone hut', hp: 400, size: 2.5, ahead: 3.4, room: 2.6, repair: 'stoneBlock' },
  wall: { name: 'stone wall', hp: 200, size: 1.4, ahead: 2.0, room: 0.9, repair: 'stoneBlock' },
  furnace: { name: 'furnace', hp: 300, size: 1.2, ahead: 2.3, room: 1.3, repair: 'stoneBlock' },
  anvil: { name: 'anvil', hp: 300, size: 0.8, ahead: 2.0, room: 0.9, repair: 'stoneBlock' },
};
export const RECIPES = [
  { id: 'axe', icon: '🪓', name: 'Stone Axe', kind: 'tool', desc: 'Lash a sharp stone to a sturdy stick with plant fiber. Fells trees and palms.', cost: { stick: 2, stone: 2, fiber: 2 } },
  { id: 'club', icon: '🏏', name: 'Wooden Club', kind: 'tool', desc: 'A heavy branch with a fiber grip. Good against rats.', cost: { stick: 3, fiber: 1 } },
  { id: 'pickaxe', icon: '⛏️', name: 'Stone Pickaxe', kind: 'tool', desc: 'Mines stone, copper, tin and limestone.', cost: { stick: 2, stone: 3, fiber: 2 } },
  { id: 'hammer', icon: '🔨', name: 'Smithing Hammer', kind: 'tool', desc: 'A heavy stone head on a short handle. Needed to forge bronze at an anvil.', cost: { stick: 1, stone: 3, fiber: 1 } },
  { id: 'waterskin', icon: '🫙', name: 'Waterskin', kind: 'tool', desc: `Stitched leather. Carries ${WATERSKIN_CAP} sips of water. Fill it at an oasis.`, cost: { leather: 2, fiber: 1 } },
  { id: 'stoneBlock', icon: '🧱', name: 'Stone Blocks ×2', kind: 'material', desc: 'Mix limestone with water and stone into mortar-bound blocks.', cost: { limestone: 1, water: 1, stone: 2 }, makes: 2 },
  { id: 'shelter', icon: '⛺', name: 'Lean-to Shelter', kind: 'build', desc: 'A log frame with a thatched roof. Built in front of you, opening toward you.', cost: { log: 4, stick: 6, fiber: 4 } },
  { id: 'fire', icon: '🔥', name: 'Fire Pit', kind: 'build', desc: 'Cooks food, keeps you warm and scares animals away.', cost: { stone: 5, stick: 4, log: 1 } },
  { id: 'hut', icon: '🏠', name: 'Stone Hut', kind: 'build', desc: 'Thick stone walls: sleep safely without a fire and rest in the shade.', cost: { stoneBlock: 8, log: 2 } },
  { id: 'furnace', icon: '🏭', name: 'Furnace', kind: 'build', desc: 'A stone kiln hot enough to smelt copper and tin into bronze bars.', cost: { stoneBlock: 6, stone: 4, log: 2 } },
  { id: 'anvil', icon: '⚒️', name: 'Anvil', kind: 'build', desc: 'A dense, flat stone block. Forge bronze weapons and armor here with a hammer.', cost: { stoneBlock: 4, stone: 6 } },
  { id: 'wall', icon: '🧱', name: 'Stone Wall', kind: 'build', desc: 'A wall segment that slows raiders and blocks arrows. Build as many as you like.', cost: { stoneBlock: 3 } },
];
export const OBJECTIVES_L1 = [
  { id: 'gather', text: 'Collect sticks and stones', tip: 'Walk up to sticks and stones on the forest floor. The yellow marker shows what USE will pick up.' },
  { id: 'fiber', text: 'Pull plant fiber from tall grass', tip: 'Tall pale grass gives fiber. You need it to lash tools together.' },
  { id: 'axe', text: 'Fasten a stone axe', tip: 'Open CRAFT: 2 sticks + 2 stones + 2 fiber.' },
  { id: 'club', text: 'Make a club to fend off rats', tip: 'CRAFT: 3 sticks + 1 fiber. Tap ATTACK when a rat gets close.' },
  { id: 'chop', text: 'Fell a tree for logs', tip: 'Stand at a tree and hold USE. Three chops brings it down.' },
  { id: 'shelter', text: 'Build a lean-to shelter', tip: '4 logs + 6 sticks + 4 fiber. Find a clear spot; it is built in front of you.' },
  { id: 'fire', text: 'Build a fire pit near the shelter', tip: '5 stones + 4 sticks + 1 log. A few steps from the shelter.' },
  { id: 'cook', text: 'Cook food over the fire', tip: 'Club a rat for meat or find mushrooms, then USE at the lit fire.' },
  { id: 'sleep', text: 'Sleep through the night', tip: 'After dark, feed the fire a couple of logs, then USE at the shelter.' },
];
export const OBJECTIVES_L2 = [
  { id: 'pickaxe', text: 'Craft a stone pickaxe', tip: 'CRAFT: 2 sticks + 3 stones + 2 fiber. You will need it to mine the desert.' },
  { id: 'travel', text: 'Follow the trail east into the desert', tip: 'The trail marker stands at the eastern edge of the forest. The star on the minimap shows the way.' },
  { id: 'village', text: 'Find the desert village', tip: 'Head for the star on the minimap. Your thirst drains fast in the sun, so do not dawdle.' },
  { id: 'chief', text: 'Speak with Chief Soloman', tip: 'He waits in front of the largest house in the village.' },
  { id: 'water', text: 'Fill a waterskin at the oasis', tip: 'Craft a waterskin (2 leather + 1 fiber). Hares and snakes drop leather, or buy it from the merchant.' },
  { id: 'mine', text: 'Mine copper and tin', tip: 'Ore veins sit near the rock mesas: orange is copper, silver is tin. Hold USE with a pickaxe.' },
  { id: 'block', text: 'Make stone blocks', tip: 'CRAFT: 1 limestone + 1 water + 2 stone. Limestone is the pale rock; outcrops give stone.' },
  { id: 'hut', text: 'Build a stone hut', tip: '8 stone blocks + 2 logs. Build it on land bought from Chief Soloman, or be ready to defend it from raiders at night.' },
  { id: 'camp', text: 'Wipe out the marauder camp', tip: 'The camp surrounds the eastern oasis. Forge bronze gear first (or buy it), and dodge the archers.' },
  { id: 'king', text: 'Defeat the Marauder King', tip: 'Watch for his raised blade, then dodge the heavy slam. A mace can stagger him.' },
  { id: 'report', text: 'Return to Chief Soloman', tip: 'Tell the chief the oasis is free.' },
];
export const SIDE_GOALS = [
  { id: 'smelt', text: 'Smelt a bronze bar at a furnace', tip: 'Build a furnace, then USE it with copper and tin ore in your bag.' },
  { id: 'forge', text: 'Forge bronze gear at an anvil', tip: 'Craft a smithing hammer, build an anvil, then USE it with bronze bars.' },
  { id: 'property', text: 'Buy land from Chief Soloman', tip: `${PLOT.price} gold for a plot beside the village. Marauders never go near it.` },
  { id: 'raid', text: 'Fight off a marauder raid', tip: 'Buildings outside your land are raided every night. Kill every raider to break the raid.' },
  { id: 'cave', text: 'Find the cave in the cliffs', tip: 'A dark cave mouth is cut into the cliffs beyond the oasis. Bring food, water and your best gear.' },
  { id: 'mummy', text: 'Defeat the Ancient Mummy Guardian', tip: 'Pull both levers in the cave to open his chamber. When his spirit shields him, smash the four glowing pillars.' },
];
export function objectives(g) {
  return g.level === 1 ? OBJECTIVES_L1 : OBJECTIVES_L2;
}
export function currentObjective(g) {
  return objectives(g).find((o) => !g.done[o.id]);
}

export const ENEMIES = {
  rat: { name: 'rat', hp: 4, speed: [3.5, 4.3], dmg: [6, 9], reach: 0.85, aggro: 12, windup: 0, recover: 1.3, radius: 0.3, fearFire: true, drops: [['rawMeat', 1]], gold: [0, 0] },
  scorpion: { name: 'scorpion', hp: 7, speed: [3.0, 3.6], dmg: [8, 10], reach: 1.15, aggro: 9, windup: 0.45, recover: 1.2, radius: 0.45, fearFire: true, gold: [2, 6] },
  snake: { name: 'snake', hp: 5, speed: [2.8, 3.3], dmg: [10, 12], reach: 1.5, aggro: 7, windup: 0.4, recover: 1.4, radius: 0.35, fearFire: true, drops: [['leather', 1]], gold: [1, 4] },
  hare: { name: 'desert hare', hp: 2, speed: [4.6, 4.6], passive: true, radius: 0.25, drops: [['rawMeat', 1], ['leather', 1]], gold: [0, 0] },
  swordsman: { name: 'marauder swordsman', hp: 16, speed: [3.6, 4.0], dmg: [12, 15], siege: 10, reach: 1.6, aggro: 15, windup: 0.55, recover: 1.1, radius: 0.4, human: true, gold: [12, 22], leash: 34 },
  archer: { name: 'marauder archer', hp: 10, speed: [3.4, 3.8], dmg: [8, 10], siege: 6, reach: 16, aggro: 18, windup: 0.8, recover: 1.9, radius: 0.4, human: true, ranged: true, gold: [10, 18], leash: 34 },
  king: { name: 'Marauder King', hp: 70, speed: [3.0, 3.4], dmg: [22, 26], reach: 2.2, aggro: 16, windup: 0.85, recover: 1.4, radius: 0.6, human: true, boss: true, gold: [150, 150], leash: 22 },
  // the Desert Cave: tougher kin of the surface creatures, plus the restless dead
  caveRat: { name: 'cave rat', hp: 9, speed: [4.0, 4.0], dmg: [11, 11], reach: 0.95, aggro: 11, windup: 0, recover: 1.1, radius: 0.38, drops: [['rawMeat', 1]], gold: [1, 4] },
  caveScorpion: { name: 'cave scorpion', hp: 15, speed: [3.4, 3.4], dmg: [15, 15], reach: 1.3, aggro: 9, windup: 0.45, recover: 1.1, radius: 0.55, gold: [5, 12] },
  skeleton: { name: 'skeleton', hp: 20, speed: [3.5, 3.5], dmg: [15, 15], reach: 1.6, aggro: 13, windup: 0.55, recover: 1.1, radius: 0.4, human: true, gold: [6, 14] },
  mummy: { name: 'Ancient Mummy Guardian', hp: 140, speed: [2.3, 2.3], dmg: [15, 15], reach: 2.2, aggro: 0, windup: 0.85, recover: 1.4, radius: 0.65, human: true, boss: true, gold: [200, 200] },
};

export const SHOP = {
  buy: [
    { id: 'stone', price: 2 },
    { id: 'leather', price: 5 },
    { id: 'rawMeat', price: 10 },
    { id: 'sword', price: 100, tool: true },
    { id: 'shield', price: 150, tool: true },
  ],
  sell: [
    { id: 'bronzeBar', price: 15 },
    { id: 'copper', price: 6 },
    { id: 'tin', price: 6 },
    { id: 'limestone', price: 2 },
    { id: 'stone', price: 1 },
    { id: 'leather', price: 2 },
    { id: 'rawMeat', price: 5 },
  ],
};

const RESPAWN = { stick: 80, stone: 140, grass: 70, reeds: 70, bush: 100, mushroom: 110, tree: 200, palm: 220, deadbush: 90, copper: 180, tin: 180, limestone: 150, outcrop: 150 };
const MINEABLE = { copper: 'copper', tin: 'tin', limestone: 'limestone', outcrop: 'stone' };
const CHOPPABLE = { tree: true, palm: true };
// Level 1 rat pressure: [day cap, night cap], spawn interval ranges (s)
const RATS = { start: 5, cap: [5, 8], every: [[9, 15], [6, 10]] };

/* =====================================================================
   GAME STATE
   ===================================================================== */
function msg(g, text) {
  g.msgs.push({ id: g.nextId++, text, t: g.time });
  if (g.msgs.length > 4) g.msgs.shift();
}
function fx(g, type, x, z, extra = {}) {
  g.fx.push({ type, x, z, ...extra });
}
export function weapon(g) {
  if (g.equip && g.tools[g.equip] && TOOLS[g.equip].kind === 'weapon') return g.equip;
  let best = null;
  for (const k of WEAPONS) if (g.tools[k] && (!best || TOOLS[k].dmg > TOOLS[best].dmg)) best = k;
  return best;
}
export function equipWeapon(g, id) {
  if (!g.tools[id] || TOOLS[id].kind !== 'weapon') return;
  g.equip = id;
  msg(g, `You ready your ${TOOLS[id].name.toLowerCase()}.`);
}
export function armorValue(g) {
  return Math.min(0.5, ARMOR.reduce((s, k) => s + (g.tools[k] ? TOOLS[k].armor : 0), 0));
}
function gainTool(g, id) {
  const before = weapon(g);
  g.tools[id] = { dur: TOOLS[id].maxDur };
  // switch to a new weapon automatically if it hits harder than what you were holding
  if (TOOLS[id].kind === 'weapon' && (!before || TOOLS[id].dmg > TOOLS[before].dmg)) g.equip = id;
}
export function buildsOf(w, type) {
  return w.builds.filter((b) => b.type === type);
}
function nearestBuild(w, type, x, z, maxD = Infinity, pred) {
  let best = null;
  let bd = maxD;
  for (const b of w.builds) {
    if (b.type !== type || (pred && !pred(b))) continue;
    const d = dist2(b.x, b.z, x, z);
    if (d < bd) {
      bd = d;
      best = b;
    }
  }
  return best;
}

function newWorld(region) {
  return {
    region,
    r: REGIONS[region].r,
    nodes: [],
    rocks: [],
    decor: {},
    enemies: [],
    arrows: [],
    npcs: [],
    staticObs: [],
    builds: [],
    raid: null,
    leftAt: null,
    spawnT: 20,
  };
}

export function createGame(seed = Math.floor(Math.random() * 1e9)) {
  REGION = 'forest';
  const g = {
    seed,
    seed0: seed,
    time: 0,
    tod: 0.1,
    day: 1,
    level: 1,
    region: 'forest',
    gold: 0,
    quest: null,
    plotOwned: false,
    equip: null,
    raidKey: null,
    player: {
      x: 0, z: 0, rot: Math.PI, speed: 0, walk: 0, moving: false, moveX: 0, moveZ: 0,
      health: 100, hunger: 85, energy: 90, warmth: 100, thirst: 100,
      action: null, actionT: 0, actionDur: 0, hitDone: true, target: null, cooldown: 0, dodgeCd: 0, hurtT: 0, dodgeX: 0, dodgeZ: 0,
    },
    inv: Object.fromEntries(Object.keys(ITEMS).map((k) => [k, 0])),
    tools: {},
    worlds: {},
    w: null,
    msgs: [],
    fx: [],
    done: {},
    collected: { stick: 0, stone: 0, fiber: 0, copper: 0, tin: 0 },
    kills: 0,
    sleeping: false,
    sleepAt: null,
    sleepWasNight: false,
    sleepCrossed: false,
    coldWarned: false,
    thirstWarned: false,
    over: false,
    deathReason: '',
    lastHarm: 'exhaustion',
    showWin: null,
    nextId: 1,
    hitStop: 0,
    shake: 0,
    openPanel: null,
    activeBuild: null,
    visitedDesert: false,
  };
  g.w = genForest(g);
  g.worlds.forest = g.w;
  msg(g, 'You wake up alone in a forest clearing…');
  msg(g, 'Look for sticks and stones nearby.');
  return g;
}

function placer(g, w, occ) {
  const free = (x, z, r) => occ.every((o) => dist2(x, z, o.x, o.z) > r + o.r) && Math.hypot(x, z) < w.r - 2;
  const polar = (rMin, rMax) => {
    const a = rng(g) * Math.PI * 2;
    const r = Math.sqrt(lerp(rMin * rMin, rMax * rMax, rng(g)));
    return [Math.cos(a) * r, Math.sin(a) * r];
  };
  const add = (type, x, z, extra = {}) => {
    const n = { id: g.nextId++, type, x, z, alive: true, timer: 0, rot: rng(g) * Math.PI * 2, ...extra };
    w.nodes.push(n);
    occ.push({ x, z, r: type === 'tree' || type === 'palm' ? 1.6 : type === 'bush' ? 0.9 : 0.5 });
    return n;
  };
  return { free, polar, add };
}
const treeExtra = (g, variant) => ({ hp: 3, variant: variant || (rng(g) < 0.5 ? 'pine' : 'broad'), scale: 0.85 + rng(g) * 0.4, fallDir: 0, grow: 1 });
const nodeExtra = (g, type) => {
  if (type === 'tree') return treeExtra(g);
  if (type === 'palm') return { ...treeExtra(g, 'palm'), scale: 0.9 + rng(g) * 0.3 };
  if (type === 'bush') return { uses: 3 };
  if (MINEABLE[type]) return { hp: type === 'limestone' ? 2 : 3 };
  return {};
};

function genForest(g) {
  const w = newWorld('forest');
  const occ = [{ x: FOREST_TRAIL.x, z: FOREST_TRAIL.z, r: 4 }];
  const { free, polar, add } = placer(g, w, occ);
  const scatter = (type, n, rMin, rMax) => {
    for (let i = 0, tries = 0; i < n && tries < n * 40; tries++) {
      const [x, z] = polar(rMin, rMax);
      if (free(x, z, type === 'tree' ? 1.6 : 0.6)) {
        add(type, x, z, nodeExtra(g, type));
        i++;
      }
    }
  };
  w.nodes.push({ id: g.nextId++, type: 'trail', dest: 'desert', x: FOREST_TRAIL.x, z: FOREST_TRAIL.z, alive: true, rot: -Math.PI / 2, out: { x: -6, z: 0 } });
  [[8.5, 2.5], [-7.5, 6.5], [3, -9.5], [-9, -5]].forEach(([x, z]) => add('tree', x, z, treeExtra(g)));
  [[2.2, 3.0, 'stick'], [-2.6, 2.4, 'stone'], [3.6, -1.4, 'stick'], [-1.4, -3.4, 'stone'], [5.2, 4.2, 'grass'],
   [-4.8, -1.2, 'grass'], [0.6, 5.6, 'stick'], [-5.6, 3.8, 'bush'], [4.4, -4.8, 'stone'], [-3.4, 6.2, 'grass'],
   [6.4, 0.8, 'mushroom']].forEach(([x, z, t]) => add(t, x, z, nodeExtra(g, t)));
  scatter('tree', 70, 11, w.r - 3);
  scatter('stick', 24, 6, w.r - 4);
  scatter('stone', 18, 6, w.r - 4);
  scatter('grass', 16, 6, w.r - 4);
  scatter('bush', 8, 8, w.r - 4);
  scatter('mushroom', 10, 8, w.r - 4);
  for (let i = 0, tries = 0; i < 26 && tries < 1000; tries++) {
    const [x, z] = polar(9, w.r - 2);
    const r = 0.6 + rng(g) * 1.0;
    if (free(x, z, r + 0.6)) {
      w.rocks.push({ x, z, r, rot: rng(g) * 6.28 });
      w.staticObs.push({ x, z, r });
      occ.push({ x, z, r: r + 0.4 });
      i++;
    }
  }
  w.decor.ferns = [];
  w.decor.tufts = [];
  w.decor.farTrees = [];
  for (let i = 0; i < 160; i++) {
    const [x, z] = polar(3, w.r + 6);
    w.decor.ferns.push({ x, z, rot: rng(g) * 6.28, s: 0.6 + rng(g) * 0.7 });
  }
  for (let i = 0; i < 900; i++) {
    const [x, z] = polar(1, w.r + 10);
    w.decor.tufts.push({ x, z, rot: rng(g) * 6.28, s: 0.6 + rng(g) * 0.8 });
  }
  for (let i = 0; i < 260; i++) {
    const [x, z] = polar(w.r + 1, w.r + 34);
    w.decor.farTrees.push({ x, z, rot: rng(g) * 6.28, s: 0.9 + rng(g) * 0.9, pine: rng(g) < 0.55 });
  }
  // rats roam the woods from the start: spread around, never right on top of the clearing
  for (let i = 0; i < RATS.start; i++) {
    const a = (i / RATS.start) * Math.PI * 2 + rng(g) * 0.8;
    const r = 15 + rng(g) * 18;
    spawnEnemy(g, 'rat', Math.cos(a) * r, Math.sin(a) * r, w);
  }
  return w;
}

function genDesert(g) {
  const w = newWorld('desert');
  const V = DESERT.village;
  const O = DESERT.oasis;
  const C = DESERT.camp;
  const A = DESERT.arrival;
  const occ = [
    { x: V.x, z: V.z, r: V.r + 2 },
    { x: PLOT.x, z: PLOT.z, r: PLOT.half * 1.45 + 1 },
    { x: O.x, z: O.z, r: O.r + 3 },
    { x: C.x, z: C.z, r: C.r + 3 },
    { x: A.x, z: A.z, r: 6 },
    { x: CAVE_MOUTH.x, z: CAVE_MOUTH.z, r: 10 },
  ];
  const { free, polar, add } = placer(g, w, occ);
  w.nodes.push({ id: g.nextId++, type: 'trail', dest: 'forest', x: A.x + 2, z: A.z, alive: true, rot: Math.PI / 2, out: { x: 6, z: 0 } });
  // the cave mouth: a dark opening in a rock mass at the cliff's foot, facing the middle of the map
  {
    const M0 = CAVE_MOUTH;
    const fx0 = Math.sin(M0.rot);
    const fz0 = Math.cos(M0.rot);
    const local = (lx, lz) => ({ x: M0.x + lx * fz0 + lz * fx0, z: M0.z - lx * fx0 + lz * fz0 });
    w.nodes.push({ id: g.nextId++, type: 'cavemouth', dest: 'cave', x: M0.x, z: M0.z, alive: true, rot: M0.rot, out: { x: fx0 * 3.2, z: fz0 * 3.2 } });
    [[0, -4.2, 4.6], [3.7, -0.9, 1.7], [-3.7, -0.9, 1.7]].forEach(([lx, lz, r]) => {
      const o = local(lx, lz);
      w.staticObs.push({ x: o.x, z: o.z, r, big: true });
    });
  }

  // rock mesas
  w.decor.mesas = [];
  for (let i = 0, tries = 0; i < 11 && tries < 400; tries++) {
    const [x, z] = polar(22, w.r - 8);
    const r = 3 + rng(g) * 3.5;
    if (free(x, z, r + 3)) {
      w.decor.mesas.push({ x, z, r, h: 6 + rng(g) * 8, rot: rng(g) * 6.28 });
      w.staticObs.push({ x, z, r: r + 0.2, big: true });
      occ.push({ x, z, r: r + 1 });
      i++;
    }
  }

  // the village: houses ring a dry well
  w.decor.houses = [];
  const houseAt = (a, rr, wd, dp, chief) => {
    const x = V.x + Math.cos(a) * rr;
    const z = V.z + Math.sin(a) * rr;
    const h = { x, z, w: wd, d: dp, h: chief ? 3.6 : 2.8, rot: Math.atan2(V.x - x, V.z - z), chief };
    w.decor.houses.push(h);
    w.staticObs.push({ x, z, r: (wd + dp) / 4 + 0.2, big: true });
    return h;
  };
  const chiefHouse = houseAt(-1.9, 10.5, 6, 5, true);
  [-0.6, 0.5, 1.4, 2.4, 3.3, 4.2].forEach((a, i) => houseAt(a, 9.5 + (i % 2) * 1.5, 4 + (i % 3) * 0.6, 3.6 + (i % 2) * 0.6));
  w.decor.well = { x: V.x, z: V.z };
  w.staticObs.push({ x: V.x, z: V.z, r: 1.1 });
  const stallA = 0.95;
  w.decor.stall = { x: V.x + Math.cos(stallA) * 5.5, z: V.z + Math.sin(stallA) * 5.5, rot: Math.atan2(-Math.cos(stallA), -Math.sin(stallA)) };
  w.staticObs.push({ x: w.decor.stall.x, z: w.decor.stall.z, r: 1.1 });
  const npc = (type, x, z, rot, extra = {}) => w.npcs.push({ id: g.nextId++, type, x, z, rot, home: { x, z }, walk: 0, moving: false, wT: 0, ...extra });
  const s = w.decor.stall;
  npc('merchant', s.x - Math.sin(s.rot) * 1.6, s.z - Math.cos(s.rot) * 1.6, s.rot + Math.PI);
  npc('chief', chiefHouse.x + Math.sin(chiefHouse.rot) * 3.6, chiefHouse.z + Math.cos(chiefHouse.rot) * 3.6, chiefHouse.rot);
  for (let i = 0; i < 3; i++) {
    const a = rng(g) * 6.28;
    npc('villager', V.x + Math.cos(a) * 4, V.z + Math.sin(a) * 4, a, { variant: i });
  }

  // the plot for sale: a low post-and-rope fence with a gate facing the village
  w.decor.fence = [];
  const H = PLOT.half;
  const gateHalf = 1.6;
  for (let t = -H; t <= H + 1e-6; t += 1.0) {
    const edges = [
      [PLOT.x + t, PLOT.z - H, 'south'],
      [PLOT.x + t, PLOT.z + H, 'north'],
      [PLOT.x - H, PLOT.z + t, 'west'],
      [PLOT.x + H, PLOT.z + t, 'east'],
    ];
    for (const [x, z, side] of edges) {
      if (side === 'south' && Math.abs(t) < gateHalf) continue;
      if ((side === 'west' || side === 'east') && Math.abs(t) > H - 0.5) continue; // corners come from north/south
      w.decor.fence.push({ x, z, side });
      w.staticObs.push({ x, z, r: 0.42 });
    }
  }
  w.decor.plotSign = { x: PLOT.x + gateHalf + 0.8, z: PLOT.z - H - 0.9 };

  // oases
  w.decor.ponds = [
    { x: O.x, z: O.z, r: O.r, y: O.level - 0.3 },
    { x: C.x, z: C.z, r: DESERT.campPondR, y: C.level - 0.3 },
  ];
  w.decor.ponds.forEach((p) => w.staticObs.push({ x: p.x, z: p.z, r: p.r - 0.6, pond: true }));
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + rng(g) * 0.4;
    const r = O.r + 1.5 + rng(g) * 2.5;
    add('palm', O.x + Math.cos(a) * r, O.z + Math.sin(a) * r, nodeExtra(g, 'palm'));
  }
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.3;
    add('reeds', O.x + Math.cos(a) * (O.r + 0.7), O.z + Math.sin(a) * (O.r + 0.7));
  }
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.5;
    const r = DESERT.campPondR + 1.6;
    add('palm', C.x + Math.cos(a) * r, C.z + Math.sin(a) * r, nodeExtra(g, 'palm'));
  }

  // the marauder camp: palisade ring with a gate facing the village
  const gateA = Math.atan2(V.z - C.z, V.x - C.x);
  w.decor.gateA = gateA;
  w.decor.stakes = [];
  for (let a = 0; a < Math.PI * 2; a += 1.1 / C.r) {
    if (Math.abs(angDiff(a, gateA)) < 0.24) continue;
    const x = C.x + Math.cos(a) * C.r;
    const z = C.z + Math.sin(a) * C.r;
    w.decor.stakes.push({ x, z, rot: a });
    w.staticObs.push({ x, z, r: 0.4 });
  }
  w.decor.tents = [];
  [0.95, 1.9, -0.95, -1.9].forEach((da) => {
    const a = gateA + Math.PI + da * 0.75;
    const x = C.x + Math.cos(a) * 10.5;
    const z = C.z + Math.sin(a) * 10.5;
    w.decor.tents.push({ x, z, r: 2.1, rot: rng(g) * 6.28 });
    w.staticObs.push({ x, z, r: 2.0 });
  });
  const kingTentA = gateA + Math.PI;
  const kt = { x: C.x + Math.cos(kingTentA) * 11, z: C.z + Math.sin(kingTentA) * 11, r: 3.0, rot: kingTentA, king: true };
  w.decor.tents.push(kt);
  w.staticObs.push({ x: kt.x, z: kt.z, r: 2.8, big: true });
  w.decor.campfires = [{ x: C.x + Math.cos(gateA) * 8.5, z: C.z + Math.sin(gateA) * 8.5 }];
  w.staticObs.push({ x: w.decor.campfires[0].x, z: w.decor.campfires[0].z, r: 0.75 });
  w.decor.banners = [-0.3, 0.3].map((da) => ({ x: C.x + Math.cos(gateA + da) * (C.r + 0.6), z: C.z + Math.sin(gateA + da) * (C.r + 0.6) }));

  // ore, outcrops, brush
  const nearMesa = () => {
    if (!w.decor.mesas.length || rng(g) < 0.35) return polar(14, w.r - 5);
    const m = w.decor.mesas[Math.floor(rng(g) * w.decor.mesas.length)];
    const a = rng(g) * Math.PI * 2;
    const d = m.r + 1.8 + rng(g) * 5;
    return [m.x + Math.cos(a) * d, m.z + Math.sin(a) * d];
  };
  [['copper', 16], ['tin', 14], ['limestone', 12], ['outcrop', 12]].forEach(([type, n]) => {
    for (let i = 0, tries = 0; i < n && tries < n * 60; tries++) {
      const [x, z] = nearMesa();
      if (free(x, z, 0.9)) {
        add(type, x, z, nodeExtra(g, type));
        i++;
      }
    }
  });
  for (let i = 0, tries = 0; i < 20 && tries < 800; tries++) {
    const [x, z] = polar(8, w.r - 4);
    if (free(x, z, 0.6)) {
      add('deadbush', x, z);
      i++;
    }
  }
  // a few starter pickings near the arrival point
  [[-62, -3, 'outcrop'], [-60, 6, 'deadbush'], [-57, -1, 'limestone']].forEach(([x, z, t]) => add(t, x, z, nodeExtra(g, t)));

  // decoration
  w.decor.cacti = [];
  for (let i = 0, tries = 0; i < 50 && tries < 1500; tries++) {
    const [x, z] = polar(8, w.r - 2);
    if (free(x, z, 0.8)) {
      w.decor.cacti.push({ x, z, rot: rng(g) * 6.28, s: 0.8 + rng(g) * 0.6, arms: rng(g) });
      w.staticObs.push({ x, z, r: 0.45, big: true });
      occ.push({ x, z, r: 0.6 });
      i++;
    }
  }
  for (let i = 0, tries = 0; i < 18 && tries < 600; tries++) {
    const [x, z] = polar(9, w.r - 2);
    const r = 0.5 + rng(g) * 0.8;
    if (free(x, z, r + 0.5)) {
      w.rocks.push({ x, z, r, rot: rng(g) * 6.28 });
      w.staticObs.push({ x, z, r });
      occ.push({ x, z, r: r + 0.4 });
      i++;
    }
  }
  w.decor.tufts = [];
  for (let i = 0; i < 520; i++) {
    const [x, z] = polar(2, w.r + 6);
    if (!inPlot(x, z, 0.5)) w.decor.tufts.push({ x, z, rot: rng(g) * 6.28, s: 0.6 + rng(g) * 0.9 });
  }
  w.decor.canyon = [];
  for (let i = 0; i < 44; i++) {
    const a = (i / 44) * Math.PI * 2 + rng(g) * 0.1;
    const r = w.r + 14 + rng(g) * 18;
    w.decor.canyon.push({ x: Math.cos(a) * r, z: Math.sin(a) * r, r: 7 + rng(g) * 7, h: 10 + rng(g) * 16, rot: rng(g) * 6.28 });
  }

  // wildlife
  const wild = (type, n, rMin, rMax) => {
    for (let i = 0, tries = 0; i < n && tries < n * 50; tries++) {
      const [x, z] = polar(rMin, rMax);
      if (dist2(x, z, V.x, V.z) > V.r + 8 && !inPlot(x, z, 8) && dist2(x, z, C.x, C.z) > C.r + 6 && dist2(x, z, A.x, A.z) > 14) {
        spawnEnemy(g, type, x, z, w);
        i++;
      }
    }
  };
  wild('scorpion', 8, 15, w.r - 4);
  wild('snake', 6, 15, w.r - 4);
  for (let i = 0; i < 5; i++) {
    const a = rng(g) * Math.PI * 2;
    const r = O.r + 4 + rng(g) * 7;
    spawnEnemy(g, 'hare', O.x + Math.cos(a) * r, O.z + Math.sin(a) * r, w);
  }

  // marauders: two roaming packs near the trade routes, three packs + the king inside the camp
  const pack = (cx, cz, n, archers, camp) => {
    const id = g.nextId++;
    for (let i = 0; i < n; i++) {
      const type = i < archers ? 'archer' : 'swordsman';
      const a = (i / n) * Math.PI * 2;
      spawnEnemy(g, type, cx + Math.cos(a) * 1.8, cz + Math.sin(a) * 1.8, w, { pack: id, camp, home: { x: cx, z: cz } });
    }
  };
  pack((V.x + C.x) / 2 + 6, (V.z + C.z) / 2 - 2, 2, 1, false);
  pack(O.x + 14, O.z + 12, 3, 1, false);
  pack(C.x + Math.cos(gateA - 0.5) * 9, C.z + Math.sin(gateA - 0.5) * 9, 3, 1, true);
  pack(C.x + Math.cos(gateA + 0.6) * 9, C.z + Math.sin(gateA + 0.6) * 9, 2, 1, true);
  pack(C.x + Math.cos(gateA + Math.PI - 0.9) * 7, C.z + Math.sin(gateA + Math.PI - 0.9) * 7, 3, 1, true);
  const kx = C.x + Math.cos(kingTentA) * 7.2;
  const kz = C.z + Math.sin(kingTentA) * 7.2;
  spawnEnemy(g, 'king', kx, kz, w, { camp: true, home: { x: kx, z: kz } });
  return w;
}

/* =====================================================================
   THE DESERT CAVE — a hand-laid dungeon on a 1-unit grid
   ===================================================================== */
const ROCK = 0;
const FLOOR = 1;
const PIT = 2;
const WATER = 3;
const BRIDGE = 4;
const DOOR = 5;
// the layout is traced from the design map: 1 map pixel = 1/8 unit, centered on the drawing (north = up on the minimap)
export const CPX = (X, Y) => [(X - 545) / 8, (Y - 308) / 8];
export const CAVE_ROOMS = {
  boss: [490, 82, 104, 70],
  nw: [282, 148, 84, 70],
  junction: [495, 268, 36, 34],
  ne: [690, 232, 122, 58],
  trap: [385, 385, 52, 48],
  alcove: [268, 372, 36, 30],
  central: [495, 398, 50, 48],
  grotto: [668, 392, 88, 62],
  entrance: [495, 540, 62, 56],
};
export const CAVE_PATHS = [
  { pts: [[495, 148], [495, 238]], w: 34 }, // boss chamber ↔ junction, through the great door
  { pts: [[330, 205], [360, 245], [462, 268]], w: 32 }, // northwest treasure room ↔ junction
  { pts: [[528, 268], [575, 262], [600, 248]], w: 30 }, // junction ↔ northeast lever room
  { pts: [[495, 296], [495, 354]], w: 34 }, // junction ↔ central chamber, over the chasm bridge
  { pts: [[462, 275], [420, 292], [408, 330], [396, 348]], w: 30 }, // the western loop down to the trap room
  { pts: [[296, 374], [338, 382]], w: 26 }, // trap room ↔ west treasure alcove
  { pts: [[430, 392], [452, 396]], w: 28 }, // trap room ↔ central chamber
  { pts: [[538, 400], [594, 400]], w: 26 }, // central chamber ↔ grotto, over the stream bridge
  { pts: [[495, 440], [495, 494]], w: 34 }, // central chamber ↔ entrance hall
  { pts: [[495, 560], [495, 616]], w: 30 }, // the way out, up toward daylight
  { pts: [[548, 556], [720, 562], [838, 522], [880, 452], [882, 220], [862, 140], [790, 96], [585, 88]], w: 28 }, // the shortcut
];
const SPIKE = { period: 2.8, up: 0.9, warn: 0.55, dmg: 14 };
const HAZARD_D = { sand: { name: 'patch of cursed sand' }, hands: { name: 'spectral hand' }, spikes: { name: 'spike trap' } };
export const MUMMY_ABILITIES = { sand: 'Cursed Sand', hands: 'Spectral Hands', barrage: 'Soul Barrage', curse: 'Curse of the Dead' };
const DIRS8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const hash01 = (x, z) => Math.abs(Math.sin(x * 12.9898 + z * 78.233) * 43758.5453) % 1;

export function cellIdx(G, x, z) {
  const c = Math.floor(x - G.x0);
  const r = Math.floor(z - G.z0);
  if (c < 0 || r < 0 || c >= G.cols || r >= G.rows) return -1;
  return r * G.cols + c;
}
function blockedAt(G, x, z) {
  const i = cellIdx(G, x, z);
  return i < 0 || !G.walk[i];
}
// solid rock or a shut door: stops projectiles (pits and water do not)
function wallAt(G, x, z) {
  const i = cellIdx(G, x, z);
  return i < 0 || G.t[i] === ROCK || (G.t[i] === DOOR && !G.walk[i]);
}
// push a circle out of every blocked cell it overlaps
function gridPush(G, o, rad) {
  for (let pass = 0; pass < 2; pass++) {
    const c0 = Math.floor(o.x - rad - G.x0);
    const c1 = Math.floor(o.x + rad - G.x0);
    const r0 = Math.floor(o.z - rad - G.z0);
    const r1 = Math.floor(o.z + rad - G.z0);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        if (c >= 0 && r >= 0 && c < G.cols && r < G.rows && G.walk[r * G.cols + c]) continue;
        const bx = G.x0 + c;
        const bz = G.z0 + r;
        const nx = clamp(o.x, bx, bx + 1);
        const nz = clamp(o.z, bz, bz + 1);
        const dx = o.x - nx;
        const dz = o.z - nz;
        const d = Math.hypot(dx, dz);
        if (d >= rad) continue;
        if (d > 1e-5) {
          o.x = nx + (dx / d) * rad;
          o.z = nz + (dz / d) * rad;
        } else {
          // the center ended up inside the block: shove it out along the shortest way
          const l = o.x - bx;
          const rt = bx + 1 - o.x;
          const tp = o.z - bz;
          const bt = bz + 1 - o.z;
          const m = Math.min(l, rt, tp, bt);
          if (m === l) o.x = bx - rad;
          else if (m === rt) o.x = bx + 1 + rad;
          else if (m === tp) o.z = bz - rad;
          else o.z = bz + 1 + rad;
        }
      }
    }
  }
}
function lineClear(G, ax, az, bx, bz) {
  const d = Math.hypot(bx - ax, bz - az);
  const n = Math.ceil(d / 0.45);
  for (let i = 1; i < n; i++) {
    const t = i / n;
    if (blockedAt(G, ax + (bx - ax) * t, az + (bz - az) * t)) return false;
  }
  return true;
}
// a breadth-first distance map from the player's cell, so cave creatures path around walls
function updateFlow(G, x, z) {
  const src = cellIdx(G, x, z);
  if (src < 0 || (src === G.flowFrom && !G.flowDirty)) return;
  G.flowFrom = src;
  G.flowDirty = false;
  const dist = G.flow;
  dist.fill(-1);
  if (!G.walk[src]) return;
  const q = G.queue;
  let h = 0;
  let t = 0;
  dist[src] = 0;
  q[t++] = src;
  while (h < t) {
    const i = q[h++];
    const c = i % G.cols;
    const r = (i / G.cols) | 0;
    const nd = dist[i] + 1;
    for (let k = 0; k < 8; k++) {
      const dc = DIRS8[k][0];
      const dr = DIRS8[k][1];
      const cc = c + dc;
      const rr = r + dr;
      if (cc < 0 || rr < 0 || cc >= G.cols || rr >= G.rows) continue;
      const j = rr * G.cols + cc;
      if (!G.walk[j] || dist[j] >= 0) continue;
      if (dc && dr && (!G.walk[r * G.cols + cc] || !G.walk[rr * G.cols + c])) continue; // no cutting corners
      dist[j] = nd;
      q[t++] = j;
    }
  }
}
function flowDist(G, x, z) {
  const i = cellIdx(G, x, z);
  return i < 0 ? -1 : G.flow[i];
}
// the center of the neighboring cell one step closer to the player
function flowStep(G, x, z) {
  const i = cellIdx(G, x, z);
  if (i < 0) return null;
  const di = G.flow[i];
  if (di <= 0) return null;
  const c = i % G.cols;
  const r = (i / G.cols) | 0;
  let best = -1;
  let bd = di;
  for (let k = 0; k < 8; k++) {
    const dc = DIRS8[k][0];
    const dr = DIRS8[k][1];
    const cc = c + dc;
    const rr = r + dr;
    if (cc < 0 || rr < 0 || cc >= G.cols || rr >= G.rows) continue;
    const j = rr * G.cols + cc;
    if (!G.walk[j] || G.flow[j] < 0 || G.flow[j] >= bd) continue;
    if (dc && dr && (!G.walk[r * G.cols + cc] || !G.walk[rr * G.cols + c])) continue;
    bd = G.flow[j];
    best = j;
  }
  if (best < 0) return null;
  return { x: G.x0 + (best % G.cols) + 0.5, z: G.z0 + ((best / G.cols) | 0) + 0.5 };
}

function genCave(g) {
  const w = newWorld('cave');
  const G = { cols: 92, rows: 80, x0: -46, z0: -40, flowFrom: -1, flowDirty: true };
  const N = G.cols * G.rows;
  G.t = new Uint8Array(N);
  G.walk = new Uint8Array(N);
  G.wallH = new Float32Array(N);
  G.flow = new Int16Array(N).fill(-1);
  G.queue = new Int32Array(N);
  const each = (fn) => {
    for (let r = 0; r < G.rows; r++) for (let c = 0; c < G.cols; c++) fn(r * G.cols + c, G.x0 + c + 0.5, G.z0 + r + 0.5);
  };
  const wob = (x, z) => Math.sin(x * 0.9 + z * 0.4) * 0.5 + Math.sin(x * 0.37 - z * 0.71 + 1.3) * 0.5;
  const set = (type, test, only) =>
    each((i, x, z) => {
      if ((!only || only.includes(G.t[i])) && test(x, z)) G.t[i] = type;
    });
  const inEll = (E0, x, z, wobble = 0.1) => {
    const nx = (x - E0.x) / E0.rx;
    const nz = (z - E0.z) / E0.rz;
    return nx * nx + nz * nz < (1 + wobble * wob(x, z)) ** 2;
  };
  const segD = (x, z, ax, az, bx, bz) => {
    const dx = bx - ax;
    const dz = bz - az;
    const t = clamp(((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz), 0, 1);
    return Math.hypot(x - ax - dx * t, z - az - dz * t);
  };
  // carve the rooms and the passages between them
  const rooms = {};
  for (const [k, [X, Y, RX, RY]] of Object.entries(CAVE_ROOMS)) {
    const [x, z] = CPX(X, Y);
    rooms[k] = { x, z, rx: RX / 8, rz: RY / 8 };
    set(FLOOR, (px, pz) => inEll(rooms[k], px, pz));
  }
  for (const pa of CAVE_PATHS) {
    const pts = pa.pts.map(([X, Y]) => CPX(X, Y));
    const hw = pa.w / 16;
    set(FLOOR, (x, z) => {
      for (let i = 1; i < pts.length; i++) if (segD(x, z, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) < hw * (1 + 0.12 * wob(x * 1.3, z * 1.3))) return true;
      return false;
    });
  }
  // the chasm between the junction and the central chamber, with a plank bridge across
  const chasm = { x: -6.25, z: 1.9, rx: 4.6, rz: 1.9 };
  set(PIT, (x, z) => inEll(chasm, x, z, 0.08));
  set(BRIDGE, (x) => Math.abs(x + 6) < 1.01, [PIT]);
  // the stream between the central chamber and the grotto, and the grotto's pool
  const inlet = { x: 2.6, z: 11.5, rx: 1.7, rz: 3.4 };
  set(WATER, (x, z) => inEll(inlet, x, z, 0.08));
  set(BRIDGE, (x, z) => Math.abs(z - 11) < 1.01, [WATER]);
  const pool = { x: 16.4, z: 10.5, rx: 6.6, rz: 4.6 };
  set(WATER, (x, z) => inEll(pool, x, z, 0.12), [FLOOR]);
  // the rubble-choked stairwell in the northeast room
  set(PIT, (x, z) => x > 31.4 && x < 34.2 && z > -10.5 && z < -7.9);
  // doors: the great door to the boss, and the two ends of the shortcut
  w.doors = [
    { id: g.nextId++, kind: 'boss', x: -6.25, z: -14.1, axis: 'x', half: 2.7, open: false },
    { id: g.nextId++, kind: 'shortcutA', x: 8.4, z: -27.35, axis: 'z', half: 2.4, open: false },
    { id: g.nextId++, kind: 'shortcutB', x: 2.9, z: 31.1, axis: 'z', half: 2.4, open: false },
  ];
  for (const d of w.doors) {
    d.cells = [];
    each((i, x, z) => {
      if (G.t[i] !== FLOOR) return;
      const along = d.axis === 'x' ? x - d.x : z - d.z;
      const across = d.axis === 'x' ? z - d.z : x - d.x;
      if (Math.abs(across) < 0.75 && Math.abs(along) < d.half) {
        G.t[i] = DOOR;
        d.cells.push(i);
      }
    });
  }
  for (let i = 0; i < N; i++) G.walk[i] = G.t[i] === FLOOR || G.t[i] === BRIDGE ? 1 : 0;
  // wall heights for the rock that borders open space (also used to keep the camera out of the walls)
  each((i, x, z) => {
    if (G.t[i] === DOOR) {
      G.wallH[i] = 4.4;
      return;
    }
    if (G.t[i] !== ROCK) {
      G.wallH[i] = -10;
      return;
    }
    const c = i % G.cols;
    const r = (i / G.cols) | 0;
    let near = 9;
    for (let dr = -2; dr <= 2; dr++) {
      for (let dc = -2; dc <= 2; dc++) {
        const cc = c + dc;
        const rr = r + dr;
        if (cc < 0 || rr < 0 || cc >= G.cols || rr >= G.rows) continue;
        if (G.t[rr * G.cols + cc] !== ROCK) near = Math.min(near, Math.max(Math.abs(dc), Math.abs(dr)));
      }
    }
    const n = hash01(x, z);
    G.wallH[i] = near === 1 ? 2.7 + n * 1.3 : near === 2 ? 3.2 + n * 1.5 : 0;
  });
  // bridges, for drawing planks
  const span = (pred) => {
    let x0 = 1e9;
    let x1 = -1e9;
    let z0 = 1e9;
    let z1 = -1e9;
    each((i, x, z) => {
      if (G.t[i] === BRIDGE && pred(x, z)) {
        x0 = Math.min(x0, x - 0.5);
        x1 = Math.max(x1, x + 0.5);
        z0 = Math.min(z0, z - 0.5);
        z1 = Math.max(z1, z + 0.5);
      }
    });
    return { x0, x1, z0, z1 };
  };
  const b1 = span((x, z) => z < 6);
  const b2 = span((x, z) => z > 6);
  w.bridges = [
    { x: (b1.x0 + b1.x1) / 2, z: (b1.z0 + b1.z1) / 2, axis: 'z', len: b1.z1 - b1.z0 + 0.6, wd: b1.x1 - b1.x0 },
    { x: (b2.x0 + b2.x1) / 2, z: (b2.z0 + b2.z1) / 2, axis: 'x', len: b2.x1 - b2.x0 + 0.6, wd: b2.z1 - b2.z0 },
  ];
  let far = 0;
  each((i, x, z) => G.t[i] !== ROCK && (far = Math.max(far, Math.hypot(x, z))));
  w.r = far + 3;
  w.grid = G;
  w.rooms = rooms;
  const walkAt = (x, z) => !blockedAt(G, x, z);

  // ---- things to use ----
  const node = (type, x, z, extra = {}) => {
    const n = { id: g.nextId++, type, x, z, alive: true, timer: 0, rot: 0, ...extra };
    w.nodes.push(n);
    return n;
  };
  node('caveexit', -6.25, 36, { dest: 'desert', rot: Math.PI, out: { x: 0, z: -3.6 } });
  node('lever', rooms.central.x, rooms.central.z, { pulled: false, rot: 0 });
  node('lever', 19.4, -9.5, { pulled: false, rot: Math.PI / 2 });
  node('chest', -36.6, 8, { item: 'khopesh', opened: false, rot: Math.PI / 2 });
  node('chest', rooms.nw.x, -26.2, { item: 'spear', opened: false, rot: 0 });
  node('stairs', 31.1, -9.2, { rot: -Math.PI / 2 });
  w.nodes.forEach((n) => n.type !== 'caveexit' && w.staticObs.push({ x: n.x, z: n.z, r: n.type === 'chest' ? 0.65 : n.type === 'stairs' ? 0.5 : 0.35 }));
  // richer ore veins than up in the sun
  [['copper', 12.5, -13], ['tin', 26, -5.5], ['copper', 24.5, -13.8], ['tin', 9.5, 15], ['copper', 22.5, 16], ['outcrop', -1.5, 31]].forEach(([t, x, z]) => {
    if (walkAt(x, z)) node(t, x, z, { ...nodeExtra(g, t), rot: rng(g) * 6.28 });
  });
  w.decor.ponds = [{ x: pool.x, z: pool.z, r: 6.2, y: -0.3 }];
  w.rocks = [{ x: 15.2, z: 9.6, r: 1.2 }, { x: 19, z: 11.8, r: 0.8 }, { x: 13.8, z: 12.4, r: 0.6 }].map((r) => ({ ...r, rot: hash01(r.x, r.z) * 6 }));
  w.decor.sarc = { x: rooms.boss.x, z: rooms.boss.z - 7.3 };
  w.staticObs.push({ x: w.decor.sarc.x, z: w.decor.sarc.z, r: 1.2 });

  // ---- standing torches ----
  w.decor.torches = [];
  const torch = (R, a, boss) => {
    for (let k = 0.84; k > 0.5; k -= 0.06) {
      const x = R.x + Math.cos(a) * R.rx * k;
      const z = R.z + Math.sin(a) * R.rz * k;
      if (walkAt(x, z) && walkAt(x + 1, z) && walkAt(x - 1, z) && walkAt(x, z + 1) && walkAt(x, z - 1)) {
        w.decor.torches.push({ x, z, boss });
        w.staticObs.push({ x, z, r: 0.3 });
        return;
      }
    }
  };
  const torchPlan = {
    entrance: [-2.2, -0.95, 2.4, 0.7],
    central: [-2.4, -0.7, 2.4, 0.7],
    trap: [-2.4, -0.75, 2.4, 0.75],
    alcove: [-2.0, 2.0],
    nw: [-2.3, -0.85, 2.5, 0.2],
    junction: [-2.4],
    ne: [-2.0, -1.0, 1.2, 2.2],
    grotto: [-2.2, -0.9, 0.9, 2.2],
  };
  Object.entries(torchPlan).forEach(([k, angles]) => angles.forEach((a) => torch(rooms[k], a, false)));
  [-2.75, -2.0, -1.15, -0.4, 0.75, 2.4].forEach((a) => torch(rooms.boss, a, true));

  // ---- bones, and glowing mushrooms around the pool ----
  w.decor.bones = [];
  ['entrance', 'central', 'trap', 'alcove', 'nw', 'ne', 'grotto', 'boss'].forEach((k) => {
    const R = rooms[k];
    for (let i = 0, tries = 0; i < (k === 'boss' ? 10 : 5) && tries < 60; tries++) {
      const a = rng(g) * Math.PI * 2;
      const rr = Math.sqrt(rng(g)) * 0.85;
      const x = R.x + Math.cos(a) * R.rx * rr;
      const z = R.z + Math.sin(a) * R.rz * rr;
      if (!walkAt(x, z)) continue;
      w.decor.bones.push({ x, z, rot: rng(g) * 6.28, s: 0.5 + rng(g) * 0.5 });
      i++;
    }
  });
  w.decor.shrooms = [];
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2 + rng(g) * 0.3;
    const k = 1.12 + rng(g) * 0.15;
    const x = pool.x + Math.cos(a) * pool.rx * k;
    const z = pool.z + Math.sin(a) * pool.rz * k;
    if (walkAt(x, z)) w.decor.shrooms.push({ x, z, s: 0.6 + rng(g) * 0.6, rot: rng(g) * 6.28 });
  }

  // ---- the spike trap: three strips across the western chamber, rising in a rolling wave ----
  w.spikes = [-22.5, -20, -17.5].map((x, i) => ({ id: g.nextId++, x, z: rooms.trap.z, w: 1.6, len: 11, off: i * 0.93, hit: false, wasUp: false }));

  // ---- the boss chamber ----
  const A = rooms.boss;
  w.boss = { arena: { x: A.x, z: A.z, rx: A.rx * 0.95, rz: A.rz * 0.95 }, pillars: [], glow: false, torchesOut: false, done: false, sandT: 0, handsT: 0, barrageT: 0, curseT: 0 };
  [['sand', -7, -3.6], ['hands', 7, -3.6], ['barrage', -7, 3.6], ['curse', 7, 3.6]].forEach(([ability, ox, oz]) => {
    const pl = { id: g.nextId++, ability, x: A.x + ox, z: A.z + oz, hp: 14, maxHp: 14, alive: true, hitT: 0 };
    w.boss.pillars.push(pl);
    w.staticObs.push({ x: pl.x, z: pl.z, r: 0.85, big: true });
  });
  w.hazards = [];

  // ---- the cave's inhabitants ----
  const foe = (type, x, z, extra = {}) => {
    if (!walkAt(x, z)) return;
    spawnEnemy(g, type, x, z, w, extra);
  };
  const bones = { dormant: true, wakeR: 6.5 };
  foe('caveRat', -3.5, 27);
  foe('caveRat', -9, 26.5);
  foe('skeleton', -9.5, 9, bones);
  foe('skeleton', -3, 13.5, bones);
  foe('caveScorpion', -20, 4.6);
  foe('caveScorpion', -33, 6.5);
  foe('caveScorpion', -33, 9.5);
  foe('caveRat', 10, 5.5);
  foe('caveRat', 21, 15.5);
  foe('caveRat', 24, 6);
  foe('skeleton', -6.25, -6);
  foe('skeleton', -29, -22, bones);
  foe('skeleton', -36.5, -18, bones);
  foe('caveScorpion', -30, -15);
  foe('skeleton', 14, -10, bones);
  foe('skeleton', 24, -7.5, bones);
  foe('caveRat', 20, -12);
  foe('caveRat', 26, -11);
  foe('caveScorpion', ...CPX(882, 330));
  foe('caveScorpion', ...CPX(866, 150));
  spawnEnemy(g, 'mummy', A.x, A.z - 5.2, w, { awake: false, phase: 1, mode: 'dormant', hy: 0, castCd: 2, summonT: 5, burstCd: 0, rot: 0 });
  return w;
}

/* ---------- doors, levers, chests ---------- */
function openDoor(g, d, w = g.w) {
  if (!d || d.open) return;
  d.open = true;
  for (const i of d.cells) {
    w.grid.walk[i] = 1;
    w.grid.wallH[i] = -10;
  }
  w.grid.flowDirty = true;
  if (w === g.w) {
    g.shake = Math.max(g.shake, 0.35);
    fx(g, 'poof', d.x, d.z, { y: 0.3, color: 0xb89a6a, n: 20 });
  }
}
function leversPulled(w) {
  return w.nodes.filter((n) => n.type === 'lever' && n.pulled).length;
}
function pullLever(g, n) {
  n.pulled = true;
  g.shake = Math.max(g.shake, 0.25);
  fx(g, 'sparks', n.x, n.z, { y: 0.9 });
  const pulled = leversPulled(g.w);
  if (pulled >= 2) {
    openDoor(g, g.w.doors.find((d) => d.kind === 'boss'));
    msg(g, 'Far away, stone grinds against stone… the great door to the north is open.');
  } else msg(g, `The lever locks into place with a heavy clunk. (${pulled}/2)`);
}
function openChest(g, n) {
  n.opened = true;
  const T = TOOLS[n.item];
  gainTool(g, n.item);
  fx(g, 'gold', n.x, n.z, { y: 0.8 });
  fx(g, 'sparks', n.x, n.z, { y: 0.8 });
  msg(g, `You find the ${T.name}! ${T.icon}`);
  msg(g, T.desc);
}

/* ---------- traps ---------- */
export function spikeState(s, t) {
  const ph = (t + s.off) % SPIKE.period;
  return ph < SPIKE.up ? 'up' : ph > SPIKE.period - SPIKE.warn ? 'warn' : 'down';
}
function updateSpikes(g) {
  const p = g.player;
  for (const s of g.w.spikes) {
    const up = spikeState(s, g.time) === 'up';
    if (up && !s.wasUp) s.hit = false;
    s.wasUp = up;
    if (up && !s.hit && Math.abs(p.x - s.x) < s.w / 2 + 0.15 && Math.abs(p.z - s.z) < s.len / 2) {
      s.hit = true;
      damagePlayer(g, SPIKE.dmg, null, HAZARD_D.spikes);
    }
  }
}
function updateHazards(g, dt) {
  const p = g.player;
  const w = g.w;
  if (w.boss) for (const pl of w.boss.pillars) if (pl.hitT > 0) pl.hitT -= dt;
  for (const h of w.hazards) {
    h.age += dt;
    const d = dist2(h.x, h.z, p.x, p.z);
    if (h.kind === 'sand') {
      if (h.age > h.warn && h.age < h.warn + h.life && d < h.r && p.action !== 'dodge' && !g.over) {
        h.tick -= dt;
        if (h.tick <= 0) {
          h.tick = 0.5;
          damagePlayer(g, 4, null, HAZARD_D.sand, true);
          if (!g.sandMsgT || g.time - g.sandMsgT > 3) {
            g.sandMsgT = g.time;
            msg(g, 'The cursed sand sears you! Get out of it!');
          }
        }
      }
    } else if (h.kind === 'hands' && !h.fired && h.age >= h.warn) {
      h.fired = true;
      fx(g, 'spirit', h.x, h.z, { y: 0.2 });
      if (d < h.r && p.action !== 'dodge' && !g.over) {
        damagePlayer(g, 12, null, HAZARD_D.hands, true);
        p.rootT = 0.9;
        msg(g, 'Spectral hands burst from the ground and seize your ankles!');
      }
    }
  }
  w.hazards = w.hazards.filter((h) => (h.kind === 'sand' ? h.age < h.warn + h.life + 0.6 : h.age < h.warn + 0.8));
}

/* ---------- the Ancient Mummy Guardian ---------- */
function inArena(A, x, z, s = 1) {
  const nx = (x - A.x) / A.rx;
  const nz = (z - A.z) / A.rz;
  return nx * nx + nz * nz < s * s;
}
function clampToArena(A, o, s) {
  const nx = (o.x - A.x) / A.rx;
  const nz = (o.z - A.z) / A.rz;
  const r = Math.hypot(nx, nz);
  if (r > s) {
    o.x = A.x + (nx / r) * s * A.rx;
    o.z = A.z + (nz / r) * s * A.rz;
  }
}
function arenaSpot(g, A, s) {
  const a = rng(g) * Math.PI * 2;
  const r = Math.sqrt(rng(g)) * s;
  return { x: A.x + Math.cos(a) * r * A.rx, z: A.z + Math.sin(a) * r * A.rz };
}
function summonSkeletons(g, e, n, cursed) {
  const A = g.w.boss.arena;
  for (let i = 0; i < n; i++) {
    const a = e.rot + (i ? 1.2 : -1.2);
    let x = e.x + Math.sin(a) * 2.6;
    let z = e.z + Math.cos(a) * 2.6;
    if (blockedAt(g.w.grid, x, z) || !inArena(A, x, z, 0.85)) ({ x, z } = arenaSpot(g, A, 0.6));
    spawnEnemy(g, 'skeleton', x, z, g.w, { summoned: true, noLoot: true, cursed, riseT: 0.8, alert: true, home: { x: A.x, z: A.z } });
    fx(g, 'spirit', x, z, { y: 0.3 });
  }
}
function shootSoul(g, e, angle, speed, dmg, kind) {
  const ux = Math.sin(angle);
  const uz = Math.cos(angle);
  g.w.arrows.push({ id: g.nextId++, kind, x: e.x + ux * 0.9, z: e.z + uz * 0.9, vx: ux * speed, vz: uz * speed, life: kind === 'soul' ? 3.4 : 2.4, dmg, y: 1.5 + (e.hy || 0) * 0.7, magic: true });
}
function spawnSand(g, B) {
  const p = g.player;
  const spots = [{ x: p.x + (rng(g) - 0.5) * 2, z: p.z + (rng(g) - 0.5) * 2 }, arenaSpot(g, B.arena, 0.7), arenaSpot(g, B.arena, 0.7)];
  for (const s of spots) g.w.hazards.push({ id: g.nextId++, kind: 'sand', x: s.x, z: s.z, r: 2.3, warn: 1.1, life: 6, age: 0, tick: 0 });
}
function startMummyCast(e, kind, t) {
  e.mode = 'cast';
  e.cast = kind;
  e.state = 'windup';
  e.t = t;
  e.tMax = t;
}
function mummyCast(g, e, d, dx, dz) {
  const aim = Math.atan2(dx, dz);
  e.state = 'swing';
  e.t = 0.5;
  e.swingT = 0.5;
  if (e.cast === 'bolt') {
    shootSoul(g, e, aim, 12, 15, 'bolt');
    e.castCd = 1.9;
  } else if (e.cast === 'bolt3') {
    [-0.24, 0, 0.24].forEach((o) => shootSoul(g, e, aim + o, 12, 14, 'bolt'));
    e.castCd = 2.2;
  } else if (e.cast === 'burst') {
    g.shake = Math.max(g.shake, 0.55);
    fx(g, 'slam', e.x, e.z);
    fx(g, 'spirit', e.x, e.z, { y: 0.4 });
    if (d < 3.6) damagePlayer(g, 14, e, ENEMIES.mummy);
    e.burstCd = 4.5;
    e.castCd = 1.4;
  } else if (e.cast === 'summon') {
    summonSkeletons(g, e, 2, false);
    msg(g, 'The Guardian raises his staff, and the dead rise with it!');
    e.summonT = 16;
    e.castCd = 1.6;
  } else if (e.cast === 'barrage') {
    for (let i = 0; i < 7; i++) shootSoul(g, e, aim + (i - 3) * 0.24, 6.5, 11, 'soul');
  }
}
function startMummyTransition(g, e) {
  const B = g.w.boss;
  e.hp = ENEMIES.mummy.hp * 0.5;
  e.phase = 2;
  e.mode = 'transition';
  e.modeT = 3.4;
  e.inv = true;
  e.pose = 'kneel';
  e.state = 'idle';
  e.swingT = 0;
  B.torchesOut = true;
  g.shake = Math.max(g.shake, 0.6);
  msg(g, 'The Mummy Guardian falls to his knees… his wrappings unravel and the torches gutter out!');
}
function breakPillar(g, pl) {
  const B = g.w.boss;
  pl.alive = false;
  g.shake = Math.max(g.shake, 0.45);
  fx(g, 'poof', pl.x, pl.z, { y: 1.5, color: 0xcdb48a, n: 24 });
  fx(g, 'spirit', pl.x, pl.z, { y: 2 });
  const left = B.pillars.filter((o) => o.alive).length;
  if (left) {
    msg(g, `A pillar shatters! His ${MUMMY_ABILITIES[pl.ability]} fades. (${left} left)`);
    return;
  }
  B.glow = false;
  g.w.hazards = [];
  const e = g.w.enemies.find((o) => o.type === 'mummy');
  if (!e) return;
  e.mode = 'stun';
  e.modeT = 4.5;
  e.inv = false;
  e.spirit = false;
  e.phase = 3;
  e.pose = 'kneel';
  e.state = 'idle';
  fx(g, 'spirit', e.x, e.z, { y: 1.5 });
  msg(g, 'The last pillar falls! The spirit is dragged back into his body. Strike now!');
}
function mummyDefeated(g, e, loot) {
  const w = g.w;
  const B = w.boss;
  B.done = true;
  B.glow = false;
  B.torchesOut = false;
  w.hazards = [];
  w.arrows = w.arrows.filter((a) => !a.magic);
  for (const o of w.enemies) {
    if (o.summoned && o !== e) {
      o.hp = 0;
      fx(g, 'poof', o.x, o.z, { y: 0.4, color: 0xe6dcc0 });
    }
  }
  fx(g, 'poof', e.x, e.z, { y: 0.8, color: 0xcdb48a, n: 40 });
  const spot = { x: e.x, z: e.z };
  collide(spot, 0.9, obstacles(g), w.r - 1);
  w.nodes.push({ id: g.nextId++, type: 'drop', item: 'goldenKey', x: spot.x, z: spot.z, alive: true, timer: 0, rot: e.rot });
  msg(g, `The Ancient Mummy Guardian crumbles into sand!${loot}`);
  msg(g, 'Something gold glints in the sand where he stood…');
  complete(g, 'mummy');
}
// dying in the cave puts the Guardian back to sleep, at full strength, ready for another try
function resetMummy(g) {
  const w = g.worlds.cave;
  if (!w || !w.boss || w.boss.done) return;
  const B = w.boss;
  w.enemies = w.enemies.filter((o) => !o.summoned);
  w.hazards = [];
  w.arrows = [];
  B.glow = false;
  B.torchesOut = false;
  B.pillars.forEach((pl) => Object.assign(pl, { alive: true, hp: pl.maxHp, hitT: 0 }));
  const e = w.enemies.find((o) => o.type === 'mummy');
  if (e) Object.assign(e, { hp: e.maxHp, awake: false, phase: 1, mode: 'dormant', inv: false, spirit: false, pose: null, state: 'idle', hy: 0, x: e.home.x, z: e.home.z, rot: 0, castCd: 2, summonT: 5, burstCd: 0, swingT: 0 });
}
function updateMummy(g, e, dt, obs) {
  const D = ENEMIES.mummy;
  const p = g.player;
  const w = g.w;
  const B = w.boss;
  const A = B.arena;
  e.hurtT = Math.max(0, e.hurtT - dt);
  e.swingT = Math.max(0, e.swingT - dt);
  e.kx = 0;
  e.kz = 0;
  e.moving = false;
  e.speedNow = 0;
  const dx = p.x - e.x;
  const dz = p.z - e.z;
  const d = Math.hypot(dx, dz) || 0.001;
  const faceP = () => (e.rot += angDiff(Math.atan2(dx, dz), e.rot) * Math.min(1, dt * 6));
  const floating = e.mode === 'float' || (e.phase === 2 && e.mode === 'cast') || (e.mode === 'transition' && e.modeT < 1.6);
  e.hy = lerp(e.hy || 0, floating ? 1.3 : 0, 1 - Math.exp(-dt * 2.5));
  if (!e.awake) {
    e.hurtT = 0; // nothing outside the sealed chamber can disturb him
    if (!g.over && bossDoorOpen(w) && inArena(A, p.x, p.z, 0.8)) {
      e.awake = true;
      e.mode = 'rise';
      e.modeT = 1.8;
      e.inv = true;
      e.pose = 'kneel';
      g.shake = Math.max(g.shake, 0.5);
      fx(g, 'poof', e.x, e.z, { y: 0.3, color: 0xcdb48a, n: 24 });
      msg(g, 'The sarcophagus grinds open… the Ancient Mummy Guardian rises!');
    }
    return;
  }
  const engaged = !g.over && inArena(A, p.x, p.z, 1.08);
  e.modeT = (e.modeT || 0) - dt;
  let vx = 0;
  let vz = 0;
  const move = (tx, tz, s) => {
    const ddx = tx - e.x;
    const ddz = tz - e.z;
    const dd = Math.hypot(ddx, ddz);
    if (dd > 0.3) {
      vx = (ddx / dd) * s;
      vz = (ddz / dd) * s;
    }
  };
  if (e.mode === 'rise') {
    if (e.modeT <= 0) {
      e.mode = 'fight';
      e.inv = false;
      e.pose = null;
      e.castCd = 1.2;
    }
  } else if (e.mode === 'transition') {
    faceP();
    if (!e.spirit && e.modeT < 1.6) {
      e.spirit = true;
      g.shake = Math.max(g.shake, 0.7);
      fx(g, 'spirit', e.x, e.z, { y: 1.4 });
      msg(g, 'A glowing green spirit tears free of him and lifts him off the ground!');
    }
    if (e.modeT <= 0) {
      e.mode = 'float';
      e.pose = null;
      B.glow = true;
      B.sandT = 2;
      B.handsT = 3.5;
      B.barrageT = 5.5;
      B.curseT = 7.5;
      msg(g, 'Four pillars blaze with green fire. Smash them to break his shield!');
    }
  } else if (e.mode === 'stun') {
    if (e.modeT <= 0) {
      e.mode = 'fight';
      e.pose = null;
      e.castCd = 1.0;
      msg(g, 'The Guardian staggers back to his feet!');
    }
  } else if (e.mode === 'cast') {
    faceP();
    if (e.state === 'windup') {
      e.t -= dt;
      if (e.t <= 0) mummyCast(g, e, d, dx, dz);
    } else if (e.state === 'swing') {
      e.t -= dt;
      if (e.t <= 0) {
        e.mode = e.phase === 2 ? 'float' : 'fight';
        e.state = 'chase';
      }
    } else {
      // a mace blow broke the spell
      e.mode = e.phase === 2 ? 'float' : 'fight';
      e.castCd = 1.2;
    }
  } else if (!engaged) {
    // the player left the chamber: drift back to the sarcophagus and wait
    e.state = 'idle';
    move(e.home.x, e.home.z, 2);
  } else if (e.mode === 'fight') {
    e.state = 'chase';
    faceP();
    if (d < 4.5) move(e.x - dx, e.z - dz, D.speed[0]);
    else if (d > 9) move(p.x, p.z, D.speed[0]);
    else {
      const s = e.id % 2 ? 1 : -1;
      vx = (-dz / d) * 1.1 * s;
      vz = (dx / d) * 1.1 * s;
    }
    e.castCd -= dt;
    e.summonT -= dt;
    e.burstCd -= dt;
    if (e.castCd <= 0) {
      const summons = w.enemies.filter((o) => o.summoned && o.hp > 0).length;
      if (d < 3.2 && e.burstCd <= 0) startMummyCast(e, 'burst', 0.75);
      else if (e.phase === 1 && e.summonT <= 0 && summons < 2) startMummyCast(e, 'summon', 1.2);
      else startMummyCast(e, e.phase === 3 || e.hp < D.hp * 0.75 ? 'bolt3' : 'bolt', 0.85);
    }
  } else if (e.mode === 'float') {
    e.state = 'chase';
    faceP();
    if (d < 6) move(e.x - dx, e.z - dz, 1.7);
    else if (d > 10) move(p.x, p.z, 1.7);
    const alive = (k) => B.pillars.some((pl) => pl.alive && pl.ability === k);
    for (const k of ['sand', 'hands', 'barrage', 'curse']) B[k + 'T'] -= dt;
    if (alive('sand') && B.sandT <= 0) {
      B.sandT = 6.5;
      spawnSand(g, B);
    }
    if (alive('hands') && B.handsT <= 0) {
      B.handsT = 4.2;
      w.hazards.push({ id: g.nextId++, kind: 'hands', x: p.x, z: p.z, r: 1.5, warn: 1.0, age: 0 });
    }
    if (alive('curse') && B.curseT <= 0) {
      B.curseT = 13;
      if (w.enemies.filter((o) => o.cursed && o.hp > 0).length < 3) {
        summonSkeletons(g, e, 2, true);
        msg(g, 'The Curse of the Dead! Slay the risen to steal back their life.');
      }
    }
    if (alive('barrage') && B.barrageT <= 0) {
      B.barrageT = 7;
      startMummyCast(e, 'barrage', 1.0);
    }
  }
  if (e.state === 'windup' || e.state === 'swing' || e.mode === 'rise' || e.mode === 'transition' || e.mode === 'stun') {
    vx = 0;
    vz = 0;
  }
  e.x += vx * dt;
  e.z += vz * dt;
  collide(e, D.radius, obs, w.r);
  clampToArena(A, e, 0.8);
  const sp = Math.hypot(vx, vz);
  e.moving = sp > 0.1;
  e.speedNow = sp;
  if (e.moving) e.walk += dt * (2 + sp * 1.4);
}
function bossDoorOpen(w) {
  const d = w.doors && w.doors.find((o) => o.kind === 'boss');
  return !!(d && d.open);
}
// the Guardian's health bar only shows once you've stepped into his opened chamber and he has risen
export function mummyInView(g) {
  if (g.region !== 'cave' || !g.w.boss || g.w.boss.done || !bossDoorOpen(g.w)) return null;
  const e = g.w.enemies.find((o) => o.type === 'mummy');
  if (!e || !e.awake || !inArena(g.w.boss.arena, g.player.x, g.player.z, 1.05)) return null;
  return e;
}
export function bossNote(g, e) {
  if (e.type !== 'mummy' || !g.w.boss) return '';
  const B = g.w.boss;
  if (e.mode === 'transition') return 'The chamber shakes…';
  if (B.glow) return `🛡️ Shielded · smash the glowing pillars (${B.pillars.filter((pl) => pl.alive).length} left)`;
  if (e.mode === 'stun') return '⚔️ Vulnerable! Strike now!';
  return '';
}

export function spawnEnemy(g, type, x, z, w = g.w, extra = {}) {
  const D = ENEMIES[type];
  const e = {
    id: g.nextId++, type, x, z, rot: rng(g) * 6.28, hp: D.hp, maxHp: D.hp, walk: 0, kx: 0, kz: 0,
    state: 'idle', t: 0, cd: 0, swingT: 0, hurtT: 0, wT: 0, wDir: rng(g) * 6.28, wMove: 0, moving: false, speedNow: 0,
    home: { x, z }, ...extra,
  };
  w.enemies.push(e);
  return e;
}

export function startLevel2(g) {
  g.level = 2;
  g.showWin = null;
  msg(g, 'A worn trail leads east, out of the forest…');
  if (g.tools.pickaxe) complete(g, 'pickaxe');
}

const absTime = (g) => g.day + g.tod;
// trails and cave openings: anything you can USE to travel to another region
const PORTAL = { trail: true, cavemouth: true, caveexit: true };
export function travel(g, dest) {
  const p = g.player;
  const from = g.region;
  g.w.leftAt = absTime(g);
  g.worlds[from] = g.w;
  g.region = dest;
  REGION = dest;
  if (!g.worlds[dest]) g.worlds[dest] = dest === 'desert' ? genDesert(g) : dest === 'cave' ? genCave(g) : genForest(g);
  g.w = g.worlds[dest];
  setRegion(g);
  g.w.arrows = [];
  const portals = g.w.nodes.filter((n) => PORTAL[n.type]);
  const gate = portals.find((n) => n.dest === from) || portals[0];
  p.x = gate.x + gate.out.x;
  p.z = gate.z + gate.out.z;
  p.rot = Math.atan2(gate.out.x, gate.out.z);
  p.action = null;
  p.actionT = 0;
  p.rootT = 0;
  g.fx = [];
  if (dest === 'desert') {
    if (from === 'cave') msg(g, 'You climb out of the cave, squinting into the sun.');
    else msg(g, 'The trees thin out into an endless sea of sand…');
    if (!g.visitedDesert) msg(g, 'The sun beats down. Keep an eye on your thirst 💧');
    g.visitedDesert = true;
    g.caveSeen = g.caveSeen || from === 'cave';
    complete(g, 'travel');
    raidsWhileAway(g);
  } else if (dest === 'cave') {
    msg(g, 'Cool, stale air… your eyes slowly adjust to the dark.');
    if (!g.visitedCave) msg(g, 'Bones litter the floor. Something down here is still moving.');
    g.visitedCave = true;
    g.caveSeen = true;
    complete(g, 'cave');
  } else msg(g, 'Back in the cool shade of the forest.');
}

/* =====================================================================
   SIMULATION
   ===================================================================== */
function buildObs(b) {
  if (b.type === 'fire') return [{ x: b.x, z: b.z, r: 0.75 }];
  if (b.type === 'hut') return hutObs(b.x, b.z, b.rot);
  if (b.type === 'wall') return wallObs(b.x, b.z, b.rot);
  if (b.type === 'furnace') return [{ x: b.x, z: b.z, r: 1.0 }];
  if (b.type === 'anvil') return [{ x: b.x, z: b.z, r: 0.6 }];
  return []; // you can walk into a lean-to
}
function obstacles(g) {
  const w = g.w;
  const out = w.staticObs.slice();
  for (const n of w.nodes) if (CHOPPABLE[n.type]) out.push({ x: n.x, z: n.z, r: n.alive ? 0.42 * n.scale : 0.32 });
  for (const b of w.builds) for (const o of b.obs) out.push(o);
  return out;
}
function collide(obj, rad, obs, R) {
  for (const o of obs) {
    const dx = obj.x - o.x;
    const dz = obj.z - o.z;
    const d = Math.hypot(dx, dz);
    const min = o.r + rad;
    if (d < min && d > 1e-4) {
      obj.x = o.x + (dx / d) * min;
      obj.z = o.z + (dz / d) * min;
    }
  }
  if (REGION === 'cave' && GRID) gridPush(GRID, obj, rad);
  const d = Math.hypot(obj.x, obj.z);
  if (d > R) {
    obj.x *= R / d;
    obj.z *= R / d;
  }
}
function litFireNear(g, x, z, maxD) {
  return nearestBuild(g.w, 'fire', x, z, maxD, (f) => f.lit);
}
function inShade(g, x, z) {
  if (g.region !== 'desert') return true; // the forest canopy and the cave are always shaded
  if (inVillage(x, z) || inPlot(x, z)) return true;
  for (const p of g.w.decor.ponds) if (dist2(x, z, p.x, p.z) < p.r + 5) return true;
  return !!nearestBuild(g.w, 'hut', x, z, 3.5);
}
function sleepBuild(g) {
  return g.sleepAt ? g.w.builds.find((b) => b.id === g.sleepAt) : null;
}
export function exposedBuilds(g, includeWalls = true) {
  if (g.region !== 'desert') return [];
  return g.w.builds.filter((b) => (includeWalls || b.type !== 'wall') && !inSafeZone(g, b.x, b.z));
}
export function raiders(g) {
  return g.w.enemies.filter((e) => e.raid && e.hp > 0 && !e.gone);
}

export function step(g, dt, input = { x: 0, z: 0 }) {
  if (g.over) return;
  if (g.hitStop > 0) {
    g.hitStop -= dt;
    return;
  }
  setRegion(g);
  const p = g.player;
  const w = g.w;
  const cave = g.region === 'cave';
  const gdt = dt * (g.sleeping ? 28 : 1);
  g.time += dt;
  g.shake = Math.max(0, g.shake - dt * 2.5);

  // ---- clock ----
  const prev = g.tod;
  g.tod += gdt / DAY_SECONDS;
  if (g.tod >= 1) {
    g.tod -= 1;
    g.day += 1;
    g.coldWarned = false;
    if (g.sleeping) g.sleepCrossed = true;
    else msg(g, `☀ Day ${g.day} begins`);
  }
  if (!cave && prev < 0.56 && g.tod >= 0.56) msg(g, g.region === 'desert' ? 'The sun is setting. Desert nights are cold.' : 'The sun is setting. Rats grow bolder in the dark, but they fear fire.');
  if (!cave && prev < 0.66 && g.tod >= 0.66) msg(g, 'Night has fallen.');
  const night = !cave && isNight(g.tod); // underground there is no day or night
  const nearFire = !!litFireNear(g, p.x, p.z, 7);
  const inHut = !!nearestBuild(w, 'hut', p.x, p.z, 2.2);
  const obs = obstacles(g);

  // ---- movement ----
  p.moving = false;
  p.speed = 0;
  const mag = Math.min(1, Math.hypot(input.x, input.z));
  p.moveX = mag > 0.08 ? input.x : 0;
  p.moveZ = mag > 0.08 ? input.z : 0;
  if (!g.sleeping) {
    if (p.action === 'dodge') {
      const q = 1 - p.actionT / p.actionDur;
      const spd = 8.5 * (1 - q * 0.6);
      p.x += p.dodgeX * spd * dt;
      p.z += p.dodgeZ * spd * dt;
      p.speed = spd;
    } else {
      const busy = (p.actionT > 0 && (p.action === 'chop' || p.action === 'mine' || p.action === 'smith' || p.action === 'eat')) || p.rootT > 0;
      if (mag > 0.08 && !busy) {
        const tired = p.energy < 8 || p.hunger <= 0 || (g.region !== 'forest' && p.thirst <= 0);
        const spd = (tired ? 2.4 : 5.4) * mag * (p.actionT > 0 ? 0.5 : 1);
        p.x += (input.x / mag) * spd * dt;
        p.z += (input.z / mag) * spd * dt;
        p.rot += angDiff(Math.atan2(input.x, input.z), p.rot) * Math.min(1, dt * 12);
        p.moving = true;
        p.speed = spd;
        p.walk += dt * (2.2 + spd * 1.25);
      }
    }
    collide(p, PLAYER_R, obs, w.r);
  }

  // ---- action timing ----
  if (p.actionT > 0) {
    p.actionT -= dt;
    if (!p.hitDone && p.actionT <= p.actionDur * 0.28) {
      p.hitDone = true;
      resolveAction(g);
    }
    if (p.actionT <= 0) {
      p.actionT = 0;
      p.action = null;
    }
  }
  p.cooldown = Math.max(0, p.cooldown - dt);
  p.dodgeCd = Math.max(0, p.dodgeCd - dt);
  p.hurtT = Math.max(0, p.hurtT - dt);
  p.rootT = Math.max(0, (p.rootT || 0) - dt);

  // ---- survival stats ----
  const sb = sleepBuild(g);
  const hot = g.region === 'desert' && !night && g.tod > 0.06 && g.tod < 0.6;
  p.hunger = clamp(p.hunger - (g.sleeping ? 0.12 : 0.22 + (p.speed > 4 ? 0.06 : 0)) * gdt, 0, 100);
  if (g.sleeping) p.energy = clamp(p.energy + 0.8 * gdt, 0, 100);
  else p.energy = clamp(p.energy - (ENERGY.idle + (p.speed > 4 ? ENERGY.run : 0) + (hot ? ENERGY.heat : 0)) * gdt, 0, 100);
  if (g.region === 'desert') {
    const shade = inShade(g, p.x, p.z);
    const drain = g.sleeping ? 0.06 : hot ? (shade ? 0.22 : 0.5) : 0.14;
    p.thirst = clamp(p.thirst - drain * gdt, 0, 100);
    if (p.thirst < 25 && !g.thirstWarned) {
      g.thirstWarned = true;
      msg(g, 'Your lips are cracking. Find water! 💧');
    }
    if (p.thirst > 40) g.thirstWarned = false;
  } else if (cave) p.thirst = clamp(p.thirst - 0.12 * gdt, 0, 100); // cool and dry: thirst creeps, but the grotto pool has water
  else p.thirst = clamp(p.thirst + 0.5 * gdt, 0, 100); // forest streams keep you watered
  let wDelta = night ? (g.region === 'desert' ? -0.65 : -0.5) : 0.6;
  if (!night && g.tod > 0.56) wDelta = -0.1;
  if (cave) wDelta = 0.4; // the rock holds the day's warmth
  if (nearFire || inHut) wDelta = 1.5;
  if (g.sleeping && sb && (sb.type === 'hut' || litFireNear(g, sb.x, sb.z, FIRE_RANGE))) wDelta = 1;
  p.warmth = clamp(p.warmth + wDelta * gdt, 0, 100);
  if (p.warmth < 25 && !g.coldWarned && !g.sleeping) {
    g.coldWarned = true;
    msg(g, "You're freezing! Get near a fire.");
  }
  let hp = 0;
  if (p.hunger <= 0) { hp -= 0.7; g.lastHarm = 'starvation'; }
  if (p.warmth <= 0) { hp -= 0.6; g.lastHarm = 'the cold'; }
  if (p.energy <= 0) { hp -= 0.35; g.lastHarm = 'exhaustion'; }
  if (g.region !== 'forest' && p.thirst <= 0) { hp -= 0.8; g.lastHarm = 'dehydration'; }
  if (hp === 0 && p.hunger > 45 && p.warmth > 30 && p.thirst > 30) hp = 0.25;
  p.health = clamp(p.health + hp * gdt, 0, 100);
  if (g.god) Object.assign(p, { health: 100, hunger: Math.max(p.hunger, 60), thirst: Math.max(p.thirst, 60), warmth: Math.max(p.warmth, 60), energy: Math.max(p.energy, 60) });

  // ---- fires burn down ----
  for (const f of buildsOf(w, 'fire')) {
    if (!f.lit) continue;
    f.fuel -= gdt * (g.sleeping ? 0.45 : 1);
    if (f.fuel <= 0) {
      f.fuel = 0;
      f.lit = false;
      msg(g, 'Your fire burned out.');
    }
  }
  for (const b of w.builds) if (b.hitT > 0) b.hitT -= dt;

  // ---- sleeping ----
  if (g.sleeping) {
    if (!sb) wake(g, 'Your shelter is gone!');
    else {
      p.x = sb.x;
      p.z = sb.z;
      if (sb.type === 'shelter' && !litFireNear(g, sb.x, sb.z, FIRE_RANGE)) wake(g, 'The fire died and the cold woke you up.');
      else if (g.sleepWasNight) {
        if (!isNight(g.tod) && g.tod < 0.5 && (g.sleepCrossed || g.tod > 0.03)) {
          wake(g, 'You wake up rested. Good morning!');
          complete(g, 'sleep');
        }
      } else if (p.energy >= 100) wake(g, 'You feel rested.');
    }
  }

  // ---- places ----
  if (g.region === 'desert' && dist2(p.x, p.z, DESERT.village.x, DESERT.village.z) < DESERT.village.r) {
    if (!g.done.village && g.level === 2) msg(g, 'You reach the village. The people here look parched.');
    complete(g, 'village');
  }
  if (g.region === 'desert' && !g.caveSeen && dist2(p.x, p.z, CAVE_MOUTH.x, CAVE_MOUTH.z) < 30) {
    g.caveSeen = true;
    msg(g, 'A dark cave mouth yawns in the cliffs ahead…');
  }

  // ---- regrowth ----
  for (const n of w.nodes) {
    if (!n.alive && !n.dead) {
      n.timer -= gdt;
      if (n.timer <= 0 && dist2(n.x, n.z, p.x, p.z) > 4) {
        n.alive = true;
        if (CHOPPABLE[n.type]) {
          n.hp = 3;
          n.grow = 0;
        }
        if (MINEABLE[n.type]) n.hp = n.type === 'limestone' ? 2 : 3;
        if (n.type === 'bush') n.uses = 3;
      }
    }
    if (CHOPPABLE[n.type] && n.grow < 1) n.grow = Math.min(1, n.grow + dt * 0.5);
    if (n.shakeT > 0) n.shakeT -= dt;
  }
  w.nodes = w.nodes.filter((n) => !n.dead);

  // ---- wildlife respawn ----
  w.spawnT -= gdt;
  if (w.spawnT <= 0 && !g.sleeping && !cave) {
    const forest = g.region === 'forest';
    const [lo, hi] = forest ? RATS.every[night ? 1 : 0] : night ? [8, 14] : [14, 24];
    w.spawnT = lo + rng(g) * (hi - lo);
    const count = (type) => w.enemies.filter((e) => e.type === type).length;
    const want = forest ? [['rat', RATS.cap[night ? 1 : 0]]] : [['scorpion', night ? 9 : 6], ['snake', 5], ['hare', 4]];
    for (const [type, max] of want) {
      if (count(type) >= max) continue;
      for (let i = 0; i < 8; i++) {
        const a = rng(g) * Math.PI * 2;
        const r = forest ? 18 + rng(g) * 12 : 22 + rng(g) * 12;
        const near = type === 'hare' ? DESERT.oasis : p;
        const x = near.x + Math.cos(a) * (type === 'hare' ? 6 + rng(g) * 8 : r);
        const z = near.z + Math.sin(a) * (type === 'hare' ? 6 + rng(g) * 8 : r);
        const okDesert = forest || (!inSafeZone(g, x, z) && dist2(x, z, DESERT.village.x, DESERT.village.z) > DESERT.village.r + 6 && !inPlot(x, z, 6) && dist2(x, z, DESERT.camp.x, DESERT.camp.z) > DESERT.camp.r + 4);
        if (Math.hypot(x, z) < w.r - 1 && okDesert && !litFireNear(g, x, z, 14) && dist2(x, z, p.x, p.z) > 15) {
          spawnEnemy(g, type, x, z);
          break;
        }
      }
      break; // one spawn per tick
    }
  }

  // ---- nightly raids on camps built outside your land ----
  if (g.region === 'desert') updateRaids(g, night);

  // ---- the cave: pathfinding, traps and the Guardian's curses ----
  if (cave) {
    updateFlow(w.grid, p.x, p.z);
    updateSpikes(g);
    updateHazards(g, dt);
  }

  // ---- enemies + arrows ----
  for (const e of w.enemies) updateEnemy(g, e, dt, night, obs);
  w.enemies = w.enemies.filter((e) => e.hp > 0 && !e.gone);
  updateArrows(g, dt, obs);

  // ---- npcs idle about ----
  for (const n of w.npcs) {
    n.moving = false;
    if (n.type !== 'villager') continue;
    n.wT -= dt;
    if (n.wT <= 0) {
      n.wT = 2 + rng(g) * 4;
      n.wDir = rng(g) * 6.28;
      n.go = rng(g) < 0.5;
    }
    if (n.go && dist2(n.x, n.z, n.home.x, n.home.z) < 5) {
      n.x += Math.sin(n.wDir) * 1.2 * dt;
      n.z += Math.cos(n.wDir) * 1.2 * dt;
      n.rot = n.wDir;
      n.walk += dt * 4;
      n.moving = true;
    } else if (n.go) n.wDir = Math.atan2(n.home.x - n.x, n.home.z - n.z);
    collide(n, 0.35, w.staticObs, w.r);
  }

  // ---- death ----
  if (p.health <= 0) {
    p.health = 0;
    g.over = true;
    g.sleeping = false;
    g.deathReason = g.lastHarm;
  }
}

/* ---------- raids ---------- */
function nightKey(g) {
  if (g.tod >= 0.66) return g.day;
  if (g.tod < 0.03) return g.day - 1;
  return null;
}
function updateRaids(g, night) {
  const p = g.player;
  const key = nightKey(g);
  if (key !== null && g.raidKey !== key && exposedBuilds(g, false).length) {
    g.raidKey = key;
    startRaid(g);
  }
  const rs = raiders(g);
  if (!rs.length) return;
  if (g.sleeping && rs.some((e) => dist2(e.x, e.z, p.x, p.z) < 26)) wake(g, 'Shouts in the dark! Marauders are raiding your camp!');
  if (!night && g.tod > 0.03 && g.tod < 0.5 && !rs[0].retreat) {
    rs.forEach((e) => (e.retreat = true));
    msg(g, 'Dawn breaks. The surviving raiders flee into the dunes.');
  }
}
export function startRaid(g) {
  const w = g.w;
  const targets = exposedBuilds(g, false);
  if (!targets.length) return null;
  const t = targets[Math.floor(rng(g) * targets.length)];
  const n = 4 + (rng(g) < 0.5 ? 1 : 0);
  const archers = n === 5 ? 2 : 1;
  let bx = t.x;
  let bz = t.z;
  for (let i = 0; i < 16; i++) {
    const a = rng(g) * Math.PI * 2;
    const x = t.x + Math.cos(a) * 30;
    const z = t.z + Math.sin(a) * 30;
    const blocked = w.staticObs.some((o) => o.big && dist2(x, z, o.x, o.z) < o.r + 3);
    if (Math.hypot(x, z) < w.r - 4 && !inSafeZone(g, x, z) && !inPlot(x, z, 5) && !blocked) {
      bx = x;
      bz = z;
      break;
    }
  }
  const pack = g.nextId++;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    spawnEnemy(g, i < archers ? 'archer' : 'swordsman', bx + Math.cos(a) * 2, bz + Math.sin(a) * 2, w, { raid: true, pack, target: t.id, home: { x: bx, z: bz } });
  }
  w.raid = { total: n, target: t.id, at: g.time };
  msg(g, `War drums echo across the dunes… ${n} marauders are coming for your ${BUILDS[t.type].name}!`);
  return w.raid;
}
function raidsWhileAway(g) {
  const w = g.w;
  if (w.leftAt == null) return;
  const now = absTime(g);
  let missed = Math.floor(now - 0.66) - Math.floor(w.leftAt - 0.66);
  w.leftAt = null;
  const lost = [];
  while (missed-- > 0) {
    const ex = exposedBuilds(g, false);
    if (!ex.length) break;
    const b = ex[Math.floor(rng(g) * ex.length)];
    w.builds = w.builds.filter((o) => o !== b);
    lost.push(BUILDS[b.type].name);
  }
  if (lost.length) {
    g.raidKey = nightKey(g) ?? g.raidKey;
    msg(g, `While you were away, marauders raided your camp and destroyed your ${lost.join(' and ')}.`);
  }
}
function raidTarget(g, e) {
  const ex = exposedBuilds(g, false);
  const cur = ex.find((b) => b.id === e.target);
  if (cur) return cur;
  let best = null;
  let bd = Infinity;
  for (const b of ex) {
    const d = dist2(b.x, b.z, e.x, e.z);
    if (d < bd) {
      bd = d;
      best = b;
    }
  }
  if (best) e.target = best.id;
  return best;
}
function buildInReach(g, e, D) {
  const reach = D.ranged ? 7 : D.reach + 0.4;
  let best = null;
  let bd = Infinity;
  for (const b of exposedBuilds(g, true)) {
    const d = dist2(b.x, b.z, e.x, e.z) - BUILDS[b.type].size;
    if (d < reach && d < bd) {
      bd = d;
      best = b;
    }
  }
  return best;
}
function damageBuild(g, b, dmg) {
  const w = g.w;
  b.hp -= dmg;
  b.hitT = 0.3;
  fx(g, 'chips', b.x, b.z, { y: 0.8, color: BUILDS[b.type].repair === 'log' ? 0xb88a52 : 0xcdb48a });
  if (b.hp <= 0) {
    w.builds = w.builds.filter((o) => o !== b);
    fx(g, 'poof', b.x, b.z, { y: 0.4, color: 0xa89878, n: 24 });
    g.shake = Math.max(g.shake, 0.4);
    msg(g, `Marauders destroyed your ${BUILDS[b.type].name}!`);
    return;
  }
  if (!b.warnT || g.time - b.warnT > 6) {
    b.warnT = g.time;
    msg(g, `Marauders are smashing your ${BUILDS[b.type].name}! (${Math.ceil(b.hp)}/${b.maxHp})`);
  }
}

function updateEnemy(g, e, dt, night, obs) {
  const D = ENEMIES[e.type];
  const p = g.player;
  const w = g.w;
  if (e.type === 'mummy') return updateMummy(g, e, dt, obs);
  // bone piles lie still until you come close (or kick them)
  if (e.dormant) {
    if (!g.over && (dist2(e.x, e.z, p.x, p.z) < (e.wakeR || 6) || e.hurtT > 0)) {
      e.dormant = false;
      e.riseT = 0.8;
      e.alert = true;
      fx(g, 'poof', e.x, e.z, { y: 0.2, color: 0xe6dcc0, n: 14 });
      if (!g.boneMsgT || g.time - g.boneMsgT > 6) {
        g.boneMsgT = g.time;
        msg(g, 'Bones rattle and drag themselves upright…');
      }
    }
    e.hurtT = Math.max(0, e.hurtT - dt);
    return;
  }
  if (e.riseT > 0) {
    e.riseT -= dt;
    e.hurtT = Math.max(0, e.hurtT - dt);
    return;
  }
  e.hurtT = Math.max(0, e.hurtT - dt);
  e.cd = Math.max(0, e.cd - dt);
  e.swingT = Math.max(0, e.swingT - dt);
  e.x += e.kx * dt;
  e.z += e.kz * dt;
  const damp = Math.pow(0.02, dt);
  e.kx *= damp;
  e.kz *= damp;
  const knocked = Math.hypot(e.kx, e.kz) > 0.6;
  const dx = p.x - e.x;
  const dz = p.z - e.z;
  const d = Math.hypot(dx, dz);
  const spd = D.speed[night ? 1 : 0];
  const playerSafe = inSafeZone(g, p.x, p.z);
  let vx = 0;
  let vz = 0;
  const toward = (tx, tz, s) => {
    const ddx = tx - e.x;
    const ddz = tz - e.z;
    const dd = Math.hypot(ddx, ddz) || 1;
    vx = (ddx / dd) * s;
    vz = (ddz / dd) * s;
  };
  const faceAt = (tx, tz) => (e.rot += angDiff(Math.atan2(tx - e.x, tz - e.z), e.rot) * Math.min(1, dt * 10));
  const face = () => faceAt(p.x, p.z);
  const homeD = dist2(e.x, e.z, e.home.x, e.home.z);
  const fire = D.fearFire ? litFireNear(g, e.x, e.z, 9) : null;
  // in the cave, follow the distance map around walls unless the way is clear
  const chasePlayer = (s) => {
    if (GRID && !(d < 12 && lineClear(GRID, e.x, e.z, p.x, p.z))) {
      const st = flowStep(GRID, e.x, e.z);
      if (st) return toward(st.x, st.z, s);
    }
    return toward(p.x, p.z, s);
  };
  // close in on the player and attack (shared by normal enemies and raiders)
  const fightPlayer = () => {
    if (e.state !== 'chase') {
      e.state = 'chase';
      if (e.pack) for (const o of w.enemies) if (o.pack === e.pack && o !== e && o.state === 'idle') o.alert = true;
      if (e.type === 'king') msg(g, 'The Marauder King draws his blade!');
    }
    e.alert = false;
    if (D.ranged) {
      if (d > 12) chasePlayer(spd);
      else if (d < 6.5) toward(e.x - dx, e.z - dz, spd * 0.9);
      else {
        vx = (-dz / d) * spd * 0.35 * (e.id % 2 ? 1 : -1);
        vz = (dx / d) * spd * 0.35 * (e.id % 2 ? 1 : -1);
      }
      if (d < 16 && e.cd <= 0) {
        e.state = 'windup';
        e.t = D.windup;
      }
    } else if (d > D.reach) chasePlayer(spd);
    else if (e.cd <= 0 && !knocked) {
      if (D.windup === 0) strike(g, e, D, d, dx, dz, night);
      else {
        e.state = 'windup';
        e.t = D.windup;
      }
    }
    if (e.state === 'chase' || e.state === 'windup') face();
  };

  if (e.state === 'windup') {
    const sb = e.siege ? w.builds.find((b) => b.id === e.siege) : null;
    if (sb) faceAt(sb.x, sb.z);
    else face();
    e.t -= dt;
    if (e.t <= 0) strike(g, e, D, d, dx, dz, night);
  } else if (e.state === 'swing') {
    e.t -= dt;
    if (e.t <= 0) e.state = 'chase';
  } else if (D.passive) {
    // hares bolt when you get close, but tire after a short sprint and stop to catch their breath
    e.fleeT = e.fleeT || 0;
    if (e.restT > 0) e.restT -= dt;
    else if (d < 9 && !g.sleeping) {
      toward(e.x - dx, e.z - dz, D.speed[0]);
      e.fleeT += dt;
      if (e.fleeT > 2.2) {
        e.fleeT = 0;
        e.restT = 1.6;
      }
    } else {
      e.fleeT = Math.max(0, e.fleeT - dt);
      e.wT -= dt;
      if (e.wT <= 0) {
        e.wDir += (rng(g) - 0.5) * 2.5;
        e.wMove = rng(g) < 0.5 ? 1 : 0;
        e.wT = 1 + rng(g) * 2;
      }
      vx = Math.sin(e.wDir) * 1.4 * e.wMove;
      vz = Math.cos(e.wDir) * 1.4 * e.wMove;
    }
  } else if (fire) {
    e.state = 'idle';
    toward(e.x + (e.x - fire.x), e.z + (e.z - fire.z), 4);
  } else if (e.raid) {
    if (e.retreat) {
      toward(e.x - dx, e.z - dz, spd);
      if (d > 38) e.gone = true;
    } else {
      const target = raidTarget(g, e);
      const hunt = !playerSafe && !g.over && !g.sleeping && (d < 12 || !target);
      if (hunt) fightPlayer();
      else if (target) {
        e.state = 'chase';
        const inReach = buildInReach(g, e, D);
        if (inReach && e.cd <= 0 && !knocked) {
          e.state = 'windup';
          e.t = D.windup;
          e.siege = inReach.id;
          faceAt(inReach.x, inReach.z);
        } else if (!inReach) toward(target.x, target.z, spd);
        else faceAt(inReach.x, inReach.z);
      } else {
        // nothing left to burn and the player is out of reach: drift back toward the dunes
        e.state = 'idle';
        toward(e.home.x, e.home.z, spd * 0.6);
      }
    }
  } else if (e.returning) {
    toward(e.home.x, e.home.z, spd);
    if (homeD < 3) e.returning = false;
  } else {
    const aggro = D.aggro * (night && e.type === 'scorpion' ? 1.5 : 1);
    let engaged = !g.sleeping && !g.over && !playerSafe && (d < aggro || (e.state === 'chase' && d < aggro * 1.8) || e.alert);
    // cave creatures can't smell you through solid rock: they need a line of sight or a short way around
    if (engaged && GRID && !e.alert && e.state !== 'chase' && !lineClear(GRID, e.x, e.z, p.x, p.z)) {
      const fd = flowDist(GRID, e.x, e.z);
      if (fd < 0 || fd > aggro * 1.3) engaged = false;
    }
    if (engaged && D.leash && homeD > D.leash) {
      e.returning = true;
      e.alert = false;
      e.state = 'idle';
    } else if (engaged) fightPlayer();
    else {
      e.state = 'idle';
      e.wT -= dt;
      if (e.wT <= 0) {
        e.wDir += (rng(g) - 0.5) * 2.5;
        e.wMove = rng(g) < (D.human ? 0.45 : 0.65) ? 1 : 0;
        e.wT = 1.2 + rng(g) * 2.5;
        if (D.human && homeD > 5) e.wDir = Math.atan2(e.home.x - e.x, e.home.z - e.z);
      }
      const ws = D.human ? 1.3 : 1.6;
      vx = Math.sin(e.wDir) * ws * e.wMove;
      vz = Math.cos(e.wDir) * ws * e.wMove;
    }
  }
  if (e.state === 'windup' || e.state === 'swing') {
    vx = 0;
    vz = 0;
  }
  if (!knocked) {
    e.x += vx * dt;
    e.z += vz * dt;
  }
  collide(e, D.radius, obs, w.r);
  if (g.region === 'desert') pushOutOfSafeZone(e, D.radius); // nothing hostile ever sets foot in the village or on your land
  const sp = Math.hypot(vx, vz);
  e.moving = sp > 0.1 && !knocked;
  e.speedNow = sp;
  if (e.moving) {
    if (!(D.ranged && e.state === 'chase')) e.rot += angDiff(Math.atan2(vx, vz), e.rot) * Math.min(1, dt * 10);
    e.walk += dt * (2 + sp * 1.4);
  }
}

function strike(g, e, D, d, dx, dz, night) {
  e.state = 'swing';
  e.t = D.boss ? 0.5 : 0.35;
  e.swingT = e.t;
  e.cd = D.recover;
  if (e.siege) {
    const b = g.w.builds.find((o) => o.id === e.siege);
    e.siege = null;
    if (!b) return;
    if (D.ranged) {
      const bdx = b.x - e.x;
      const bdz = b.z - e.z;
      const bd = Math.hypot(bdx, bdz) || 1;
      g.w.arrows.push({ id: g.nextId++, x: e.x, z: e.z, vx: (bdx / bd) * 17, vz: (bdz / bd) * 17, life: bd / 17, dmg: 0, harmless: true });
    }
    damageBuild(g, b, D.siege || 8);
    return;
  }
  const dmg = D.dmg ? D.dmg[night ? 1 : 0] : 0;
  if (D.ranged) {
    if (inSafeZone(g, g.player.x, g.player.z)) return;
    const sp = 17;
    const ux = dx / (d || 1);
    const uz = dz / (d || 1);
    g.w.arrows.push({ id: g.nextId++, x: e.x + ux * 0.6, z: e.z + uz * 0.6, vx: ux * sp, vz: uz * sp, life: 1.4, dmg, src: e });
    return;
  }
  if (D.boss) {
    g.shake = Math.max(g.shake, 0.6);
    fx(g, 'slam', e.x + Math.sin(e.rot) * 1.6, e.z + Math.cos(e.rot) * 1.6);
    if (d <= D.reach + 0.8) damagePlayer(g, dmg, e, D);
    return;
  }
  const facing = Math.abs(angDiff(Math.atan2(dx, dz), e.rot)) < 1.1;
  if (d <= D.reach + 0.45 && facing) {
    damagePlayer(g, dmg, e, D);
    if (e.type === 'rat' || e.type === 'caveRat') {
      e.kx = -(dx / (d || 1)) * 5;
      e.kz = -(dz / (d || 1)) * 5;
    }
  }
}

function damagePlayer(g, amount, src, D, quiet) {
  const p = g.player;
  if (g.over || g.god) return;
  if (p.action === 'dodge') {
    msg(g, 'Dodged!');
    return;
  }
  let amt = amount;
  let note = '';
  if (g.tools.shield && src) {
    const a = Math.atan2(src.x - p.x, src.z - p.z);
    if (Math.abs(angDiff(a, p.rot)) < 1.2) {
      amt = src.arrow ? 0 : amt * 0.35;
      fx(g, 'sparks', p.x + Math.sin(p.rot) * 0.6, p.z + Math.cos(p.rot) * 0.6, { y: 1.1 });
      wearTool(g, 'shield');
      if (!amt) return msg(g, 'Blocked the arrow!');
      note = 'Blocked! ';
    }
  }
  const armor = armorValue(g);
  if (armor > 0) {
    amt *= 1 - armor;
    ARMOR.forEach((k) => g.tools[k] && wearTool(g, k));
    if (!note) note = 'Your armor absorbs the blow. ';
  }
  amt = Math.max(1, Math.round(amt));
  p.health -= amt;
  p.hurtT = 0.4;
  g.shake = Math.max(g.shake, 0.35);
  g.lastHarm = D ? (D.boss ? `the ${D.name}` : `a ${D.name}`) : 'an arrow';
  if (!quiet) msg(g, note ? `${note}-${amt}` : `${D ? 'The ' + D.name : 'An arrow'} hit you! -${amt}`);
}

function updateArrows(g, dt, obs) {
  const p = g.player;
  const keep = [];
  for (const a of g.w.arrows) {
    a.x += a.vx * dt;
    a.z += a.vz * dt;
    a.life -= dt;
    if (a.life <= 0) continue;
    if (inSafeZone(g, a.x, a.z)) continue; // arrows never land in the village or on your land
    if (!a.harmless && dist2(a.x, a.z, p.x, p.z) < (a.kind === 'soul' ? 0.75 : 0.55) && p.action !== 'dodge') {
      // a shield stops arrows cold, but magic only partly
      damagePlayer(g, a.dmg, { x: a.x - a.vx * 0.05, z: a.z - a.vz * 0.05, arrow: !a.magic }, a.magic ? { name: a.kind === 'soul' ? 'soul orb' : 'cursed bolt' } : null);
      continue;
    }
    if (GRID && wallAt(GRID, a.x, a.z)) continue;
    if (!a.harmless && obs.some((o) => !o.pond && dist2(a.x, a.z, o.x, o.z) < o.r)) continue;
    keep.push(a);
  }
  g.w.arrows = keep;
}

function killEnemy(g, e) {
  const D = ENEMIES[e.type];
  g.kills += 1;
  const gold = e.noLoot ? 0 : D.gold[0] + Math.floor(rng(g) * (D.gold[1] - D.gold[0] + 1));
  if (gold > 0) {
    g.gold += gold;
    fx(g, 'gold', e.x, e.z, { y: 0.5 });
  }
  if (e.cursed) {
    // the Curse of the Dead: slaying the risen gives back a little life
    g.player.health = Math.min(100, g.player.health + 8);
    fx(g, 'spirit', g.player.x, g.player.z, { y: 1 });
  }
  (e.noLoot ? [] : D.drops || []).forEach(([item], i) => {
    // drops land on reachable ground: push them out of ponds, rocks and walls
    const spot = { x: e.x + i * 0.5, z: e.z + i * 0.3 };
    collide(spot, 0.9, obstacles(g), g.w.r - 1);
    g.w.nodes.push({ id: g.nextId++, type: 'drop', item, x: spot.x, z: spot.z, alive: true, timer: 0, rot: e.rot });
  });
  fx(g, 'poof', e.x, e.z, { y: 0.2 });
  const loot = gold ? ` +${gold} gold` : '';
  if (e.type === 'mummy') mummyDefeated(g, e, loot);
  else if (D.boss) {
    msg(g, `The Marauder King falls!${loot}`);
    complete(g, 'king');
  } else msg(g, e.cursed ? `The cursed skeleton collapses. Its stolen life flows into you. +8 ❤️` : `You defeated a ${D.name}.${loot}`);
  if (e.camp && !D.boss) {
    const left = g.w.enemies.filter((o) => o.camp && o.hp > 0 && !ENEMIES[o.type].boss && o !== e).length;
    if (left === 0) {
      msg(g, 'The marauder camp is cleared!');
      complete(g, 'camp');
    } else msg(g, `${left} marauders left in the camp.`);
  }
  if (e.raid) {
    const left = g.w.enemies.filter((o) => o.raid && o.hp > 0 && !o.gone && o !== e).length;
    if (left === 0) {
      g.gold += 30;
      g.w.raid = null;
      msg(g, 'The raid is broken! You pick 30 gold off the fallen raiders.');
      complete(g, 'raid');
    }
  }
}

function wearTool(g, tool) {
  const t = g.tools[tool];
  if (!t || !TOOLS[tool].maxDur) return;
  t.dur -= 1;
  if (t.dur <= 0) {
    delete g.tools[tool];
    if (g.equip === tool) g.equip = null;
    msg(g, `Your ${TOOLS[tool].name.toLowerCase()} broke!`);
  }
}
function give(g, item, n, quiet) {
  g.inv[item] = (g.inv[item] || 0) + n;
  if (g.collected[item] !== undefined) g.collected[item] += n;
  if (!quiet) msg(g, `+${n} ${ITEMS[item].name}`);
  if (g.collected.stick >= 2 && g.collected.stone >= 2) complete(g, 'gather');
  if (g.collected.fiber >= 2) complete(g, 'fiber');
  if (g.collected.copper >= 1 && g.collected.tin >= 1) complete(g, 'mine');
}
function complete(g, id) {
  if (g.done[id]) return;
  const o = [...OBJECTIVES_L1, ...OBJECTIVES_L2, ...SIDE_GOALS].find((ob) => ob.id === id);
  if (!o) return;
  // level-2 and side goals only count once level 2 has started
  if ((OBJECTIVES_L2.includes(o) || SIDE_GOALS.includes(o)) && g.level < 2) return;
  g.done[id] = true;
  msg(g, `✓ ${o.text}`);
  if (g.level === 1 && OBJECTIVES_L1.every((ob) => g.done[ob.id])) g.showWin = 'l1';
  if (g.level === 2 && id === 'report') g.showWin = 'l2';
}
function wake(g, text) {
  g.sleeping = false;
  g.sleepCrossed = false;
  g.sleepAt = null;
  msg(g, text);
}

function resolveAction(g) {
  const p = g.player;
  if (p.action === 'chop' || p.action === 'mine') {
    const t = g.w.nodes.find((n) => n.id === p.target);
    const tool = p.action === 'chop' ? 'axe' : 'pickaxe';
    if (!t || !t.alive || !g.tools[tool]) return;
    t.hp -= 1;
    t.shakeT = 0.35;
    g.hitStop = 0.05;
    g.shake = Math.max(g.shake, 0.22);
    const color = { copper: 0xd07a3a, tin: 0xc8ccd4, limestone: 0xeee6d2, outcrop: 0x9a9a95 }[t.type];
    fx(g, 'chips', t.x - Math.sin(p.rot) * 0.35, t.z - Math.cos(p.rot) * 0.35, { y: p.action === 'chop' ? 1.0 : 0.4, color });
    wearTool(g, tool);
    if (t.hp > 0) return;
    t.alive = false;
    t.timer = RESPAWN[t.type];
    if (p.action === 'chop') {
      t.fallDir = p.rot;
      if (t.type === 'palm') {
        give(g, 'log', 1, true);
        give(g, 'dates', 2, true);
        msg(g, 'The palm comes down. +1 log, +2 dates');
      } else {
        give(g, 'log', 2, true);
        give(g, 'stick', 1, true);
        msg(g, 'Timber! +2 logs, +1 stick');
      }
      complete(g, 'chop');
    } else {
      const item = MINEABLE[t.type];
      const n = item === 'limestone' || item === 'stone' ? 2 : 1 + (rng(g) < 0.5 ? 1 : 0);
      give(g, item, n);
      fx(g, 'poof', t.x, t.z, { y: 0.2, color });
    }
  } else if (p.action === 'smith') {
    const a = g.w.builds.find((b) => b.id === p.target);
    if (a) fx(g, 'sparks', a.x, a.z, { y: 0.9 });
    g.shake = Math.max(g.shake, 0.15);
  } else if (p.action === 'attack') {
    const w = weapon(g);
    const T = w ? TOOLS[w] : { dmg: 1, reach: 2.0, arc: 1.2, kb: 0.8 };
    let hit = false;
    for (const e of g.w.enemies) {
      const dx = e.x - p.x;
      const dz = e.z - p.z;
      const d = Math.hypot(dx, dz);
      if (d < T.reach + ENEMIES[e.type].radius * 0.5 && e.hp > 0 && Math.abs(angDiff(Math.atan2(dx, dz), p.rot)) < T.arc) {
        const D = ENEMIES[e.type];
        if (e.inv) {
          // the Guardian's spirit shield turns the blow aside
          hit = true;
          fx(g, 'spirit', e.x, e.z, { y: 1.4 + (e.hy || 0) });
          if (!g.shieldMsgT || g.time - g.shieldMsgT > 3) {
            g.shieldMsgT = g.time;
            msg(g, g.w.boss && g.w.boss.glow ? 'His spirit shield holds! Smash the glowing pillars.' : 'Your blow glances off him!');
          }
          continue;
        }
        e.hp -= T.dmg * (e.mode === 'stun' ? 1.5 : 1);
        e.hurtT = 0.3;
        if (e.type === 'mummy' && e.phase === 1 && e.hp <= D.hp * 0.5) startMummyTransition(g, e);
        const kb = (D.boss ? 1.5 : D.human ? 5 : 9) * T.kb;
        e.kx = (dx / (d || 1)) * kb;
        e.kz = (dz / (d || 1)) * kb;
        if (e.state === 'windup' && (!D.boss || T.stagger)) {
          e.state = 'chase';
          e.siege = null;
          e.cd = T.stagger ? 1.0 : 0.6; // a solid hit interrupts small enemies; a mace staggers anyone
          if (D.boss) msg(g, e.type === 'king' ? 'Your mace staggers the King!' : 'Your mace breaks his spell!');
        }
        if (e.state === 'idle' && !D.passive) e.state = 'chase';
        hit = true;
        fx(g, 'hit', e.x, e.z, { y: D.human ? 1.1 : 0.3 });
        if (e.hp <= 0) killEnemy(g, e);
      }
    }
    // the glowing pillars in the Guardian's chamber can be smashed while his shield is up
    const B = g.region === 'cave' && g.w.boss;
    if (B && B.glow) {
      for (const pl of B.pillars) {
        if (!pl.alive) continue;
        const dx = pl.x - p.x;
        const dz = pl.z - p.z;
        const d = Math.hypot(dx, dz);
        if (d < T.reach + 0.85 && Math.abs(angDiff(Math.atan2(dx, dz), p.rot)) < Math.max(T.arc, 0.9)) {
          pl.hp -= T.dmg;
          pl.hitT = 0.3;
          hit = true;
          fx(g, 'chips', pl.x - dx / (d || 1) * 0.7, pl.z - dz / (d || 1) * 0.7, { y: 1.4, color: 0xcdb48a });
          fx(g, 'spirit', pl.x, pl.z, { y: 2.2 });
          if (pl.hp <= 0) breakPillar(g, pl);
        }
      }
    }
    if (hit) {
      g.hitStop = w === 'mace' ? 0.1 : 0.07;
      g.shake = Math.max(g.shake, w === 'mace' ? 0.42 : 0.3);
      if (w) wearTool(g, w);
    }
  }
}

export function getUseTarget(g) {
  const p = g.player;
  const w = g.w;
  if (g.over) return null;
  if (g.sleeping) return { kind: 'wake', label: 'Wake up', enabled: true };
  const c = [];
  const score = (x, z) => dist2(x, z, p.x, p.z) + Math.abs(angDiff(Math.atan2(x - p.x, z - p.z), p.rot)) * 0.5;
  const raidOn = g.region === 'desert' && raiders(g).length > 0;
  const noSleep = raidOn ? { enabled: false, why: "You can't sleep while marauders are raiding your camp!" } : {};
  for (const b of w.builds) {
    const d = dist2(b.x, b.z, p.x, p.z);
    const name = BUILDS[b.type].name;
    if (b.type === 'shelter' && d < 2.6) c.push({ s: score(b.x, b.z), kind: 'sleep', build: b, label: 'Sleep', x: b.x, z: b.z, y: 2.6, ...noSleep });
    if (b.type === 'hut' && d < 3.4) c.push({ s: score(b.x, b.z) - 0.5, kind: 'sleep', build: b, label: 'Sleep in the hut', x: b.x, z: b.z, y: 3.6, ...noSleep });
    if (b.type === 'furnace' && d < 2.6) c.push({ s: score(b.x, b.z) - 0.3, kind: 'furnace', build: b, label: 'Use the furnace', x: b.x, z: b.z, y: 2.6 });
    if (b.type === 'anvil' && d < 2.3) c.push({ s: score(b.x, b.z) - 0.3, kind: 'anvil', build: b, label: g.tools.hammer ? 'Use the anvil' : 'Need a hammer', enabled: !!g.tools.hammer, why: 'Craft a smithing hammer to work the anvil.', x: b.x, z: b.z, y: 1.6 });
    if (b.type === 'fire' && d < 2.4) {
      const s = score(b.x, b.z) - 0.3;
      const base = { x: b.x, z: b.z, y: 1.4, build: b };
      if (!b.lit) c.push({ ...base, s, kind: 'light', label: 'Light fire', enabled: g.inv.stick >= 2, why: 'You need 2 sticks to light the fire.' });
      else if (g.inv.rawMeat > 0 || g.inv.mushroom > 0) c.push({ ...base, s, kind: 'cook', label: g.inv.rawMeat > 0 ? 'Cook meat' : 'Roast mushroom' });
      else if (b.fuel < FIRE_MAX - 10 && (g.inv.log > 0 || g.inv.stick > 0)) c.push({ ...base, s, kind: 'fuel', label: g.inv.log > 0 ? 'Add a log' : 'Add a stick' });
    }
    if (b.hp < b.maxHp && d < BUILDS[b.type].size + 1.8) {
      const mat = BUILDS[b.type].repair;
      c.push({ s: score(b.x, b.z) + 0.8, kind: 'repair', build: b, label: `Repair ${name} (1 ${ITEMS[mat].name.toLowerCase()})`, enabled: g.inv[mat] > 0, why: `You need a ${ITEMS[mat].name.toLowerCase()} to repair it.`, x: b.x, z: b.z, y: 2.2 });
    }
  }
  for (const n of w.npcs) {
    if (n.type === 'villager' || dist2(n.x, n.z, p.x, p.z) > 3.2) continue;
    c.push({ s: score(n.x, n.z) - 0.4, kind: 'talk', npc: n, label: n.type === 'chief' ? 'Talk to Chief Soloman' : 'Trade with the merchant', x: n.x, z: n.z, y: 2.4 });
  }
  for (const n of w.npcs) {
    if (n.type === 'villager' && dist2(n.x, n.z, p.x, p.z) < 2.2) c.push({ s: score(n.x, n.z) + 1.2, kind: 'villager', npc: n, label: 'Talk', x: n.x, z: n.z, y: 2.3 }); // flavor NPCs never steal USE from the chief or merchant
  }
  if (w.doors) {
    for (const dr of w.doors) {
      if (dr.open || dist2(dr.x, dr.z, p.x, p.z) > dr.half + 1.5) continue;
      const base = { s: score(dr.x, dr.z) - 0.2, kind: 'door', door: dr, x: dr.x, z: dr.z, y: 4.6 };
      if (dr.kind === 'boss') c.push({ ...base, label: `Sealed door (${leversPulled(w)}/2 levers)`, enabled: false, why: 'The great door will not budge. Two lever slots are carved beside it: somewhere in the cave, two levers must be pulled.' });
      else if (dr.kind === 'shortcutA') c.push({ ...base, label: g.inv.goldenKey > 0 ? 'Unlock with the golden key' : 'Locked door', enabled: g.inv.goldenKey > 0, why: 'A scarab-shaped keyhole. Whoever rules this cave must hold the key.' });
      else c.push({ ...base, label: 'Sealed door', enabled: false, why: 'Sealed tight. It must open from the other side.' });
    }
  }
  if (w.decor.ponds) {
    for (const pd of w.decor.ponds) {
      const d = dist2(pd.x, pd.z, p.x, p.z);
      if (d < pd.r + 2.0) {
        const fill = g.tools.waterskin && g.inv.water < WATERSKIN_CAP;
        const ex = pd.x + ((p.x - pd.x) / d) * (pd.r - 0.4);
        const ez = pd.z + ((p.z - pd.z) / d) * (pd.r - 0.4);
        c.push({ s: Math.max(0, d - pd.r) + 1.1, kind: 'water', label: fill ? 'Fill waterskin' : 'Drink', x: ex, z: ez, y: 0.9 });
      }
    }
  }
  if (g.region === 'desert') {
    const well = w.decor.well;
    if (dist2(well.x, well.z, p.x, p.z) < 2.3) c.push({ s: score(well.x, well.z), kind: 'well', label: 'Look into the well', x: well.x, z: well.z, y: 2.6 });
    const sign = w.decor.plotSign;
    if (dist2(sign.x, sign.z, p.x, p.z) < 2.2) c.push({ s: score(sign.x, sign.z), kind: 'sign', label: 'Read the sign', x: sign.x, z: sign.z, y: 2.0 });
  }
  for (const n of w.nodes) {
    if (!n.alive) continue;
    const d = dist2(n.x, n.z, p.x, p.z);
    const big = CHOPPABLE[n.type];
    if (n.type === 'cavemouth' || n.type === 'caveexit') {
      if (d > 3.2) continue;
      const inbound = n.type === 'cavemouth';
      c.push({ s: score(n.x, n.z) - 0.5, kind: 'trail', node: n, label: inbound ? 'Enter the cave' : 'Leave the cave', enabled: true, x: n.x, z: n.z, y: inbound ? 4.6 : 2.6 });
      continue;
    }
    if (n.type === 'trail') {
      if (d > 2.8) continue;
      const toDesert = n.dest === 'desert';
      const ok = !toDesert || (g.level >= 2 && !!g.tools.pickaxe);
      const why = g.level < 2 ? 'Survive your first night before heading out.' : 'Craft a stone pickaxe first. The desert is full of ore.';
      c.push({ s: score(n.x, n.z) - 0.5, kind: 'trail', node: n, label: toDesert ? 'Travel to the desert' : 'Return to the forest', enabled: ok, why, x: n.x, z: n.z, y: 2.4 });
      continue;
    }
    if (n.type === 'lever' || n.type === 'chest' || n.type === 'stairs') {
      if (d > 2.3 || n.pulled || n.opened) continue;
      const label = n.type === 'lever' ? 'Pull the lever' : n.type === 'chest' ? 'Open the chest' : 'Look down the stairs';
      c.push({ s: score(n.x, n.z) - 0.3, kind: n.type, node: n, label, x: n.x, z: n.z, y: n.type === 'lever' ? 1.9 : 1.4 });
      continue;
    }
    if (d > (big ? 2.3 * n.scale : MINEABLE[n.type] ? 2.0 : 1.9)) continue;
    const s = score(n.x, n.z);
    if (big) {
      const name = n.type === 'palm' ? 'Chop palm' : 'Chop tree';
      c.push({ s: s + 0.6, kind: 'chop', node: n, label: g.tools.axe ? name : 'Need an axe', enabled: !!g.tools.axe, why: 'You need a stone axe to chop trees.', x: n.x, z: n.z, y: n.type === 'palm' ? 3.2 : 2.4 });
    } else if (MINEABLE[n.type]) {
      const what = n.type === 'outcrop' ? 'stone' : ITEMS[MINEABLE[n.type]].name.toLowerCase().replace(' ore', '');
      c.push({ s, kind: 'mine', node: n, label: g.tools.pickaxe ? `Mine ${what}` : 'Need a pickaxe', enabled: !!g.tools.pickaxe, why: 'You need a stone pickaxe to mine rock.', x: n.x, z: n.z, y: 1.5 });
    } else if (n.type === 'grass' || n.type === 'reeds') c.push({ s, kind: 'fiber', node: n, label: 'Pull fiber', x: n.x, z: n.z, y: 1.3 });
    else if (n.type === 'bush') c.push({ s, kind: 'berries', node: n, label: 'Pick berries', x: n.x, z: n.z, y: 1.5 });
    else if (n.type === 'deadbush') c.push({ s, kind: 'deadbush', node: n, label: 'Gather dry sticks', x: n.x, z: n.z, y: 1.2 });
    else {
      const item = n.type === 'drop' ? n.item : n.type;
      c.push({ s, kind: 'pickup', node: n, label: 'Pick up ' + ITEMS[item].name.toLowerCase(), x: n.x, z: n.z, y: 0.9 });
    }
  }
  if (!c.length) return null;
  c.sort((a, b) => a.s - b.s);
  const t = c.find((x) => x.enabled !== false) || c[0];
  if (t.enabled === undefined) t.enabled = true;
  return t;
}

function startAction(p, action, dur, faceX, faceZ) {
  if (faceX !== undefined) p.rot = Math.atan2(faceX - p.x, faceZ - p.z);
  p.action = action;
  p.actionDur = p.actionT = dur;
  p.hitDone = !['chop', 'mine', 'attack', 'smith'].includes(action);
}

const VILLAGER_LINES = [
  'Water… please, if you find any, stranger.',
  'The marauders took the eastern oasis. We drink sand now.',
  'My brother went to look for water. He never came back.',
  'Chief Soloman is a good man. Hear him out.',
];

export function doUse(g) {
  const p = g.player;
  if (g.over || (p.actionT > 0 && !g.sleeping)) return;
  const t = getUseTarget(g);
  if (!t) return msg(g, 'Nothing here to use.');
  if (!t.enabled) return msg(g, t.why || "You can't do that yet.");
  const n = t.node;
  const fire = t.build;
  switch (t.kind) {
    case 'wake':
      wake(g, 'You get up.');
      break;
    case 'pickup':
      startAction(p, 'pickup', 0.5, n.x, n.z);
      give(g, n.type === 'drop' ? n.item : n.type, 1);
      fx(g, 'poof', n.x, n.z, { y: 0.1, color: 0xd8cfa8 });
      if (n.type === 'drop') n.dead = true;
      else {
        n.alive = false;
        n.timer = RESPAWN[n.type];
      }
      break;
    case 'fiber':
      startAction(p, 'pickup', 0.5, n.x, n.z);
      give(g, 'fiber', 1 + (rng(g) < 0.5 ? 1 : 0));
      fx(g, 'leaves', n.x, n.z, { y: 0.4, color: 0xa8c25a, n: 8 });
      n.alive = false;
      n.timer = RESPAWN[n.type];
      break;
    case 'deadbush':
      startAction(p, 'pickup', 0.5, n.x, n.z);
      give(g, 'stick', 2);
      fx(g, 'leaves', n.x, n.z, { y: 0.4, color: 0x8a6a42, n: 8 });
      n.alive = false;
      n.timer = RESPAWN.deadbush;
      break;
    case 'berries':
      startAction(p, 'pickup', 0.45, n.x, n.z);
      give(g, 'berries', 2);
      n.uses -= 1;
      if (n.uses <= 0) {
        n.alive = false;
        n.timer = RESPAWN.bush;
      }
      break;
    case 'chop':
    case 'mine':
      startAction(p, t.kind, 0.62, n.x, n.z);
      p.target = n.id;
      p.energy = Math.max(0, p.energy - ENERGY.work);
      break;
    case 'light':
      g.inv.stick -= 2;
      fire.lit = true;
      fire.fuel = Math.max(fire.fuel, 40);
      startAction(p, 'pickup', 0.6, fire.x, fire.z);
      fx(g, 'sparks', fire.x, fire.z, { y: 0.3 });
      msg(g, 'You spin a stick until the kindling catches. 🔥');
      break;
    case 'cook':
      startAction(p, 'pickup', 0.6, fire.x, fire.z);
      if (g.inv.rawMeat > 0) {
        g.inv.rawMeat -= 1;
        g.inv.cookedMeat += 1;
        msg(g, 'Sizzle! +1 cooked meat.');
      } else {
        g.inv.mushroom -= 1;
        g.inv.roastedMushroom += 1;
        msg(g, 'The mushroom is roasted and safe to eat.');
      }
      fx(g, 'sparks', fire.x, fire.z, { y: 0.3 });
      complete(g, 'cook');
      break;
    case 'fuel':
      startAction(p, 'pickup', 0.5, fire.x, fire.z);
      if (g.inv.log > 0) {
        g.inv.log -= 1;
        fire.fuel = Math.min(FIRE_MAX, fire.fuel + 60);
      } else {
        g.inv.stick -= 1;
        fire.fuel = Math.min(FIRE_MAX, fire.fuel + 15);
      }
      fx(g, 'sparks', fire.x, fire.z, { y: 0.3 });
      msg(g, `Fire stoked (${Math.round(fire.fuel)}s of fuel)`);
      break;
    case 'repair': {
      const b = t.build;
      const mat = BUILDS[b.type].repair;
      g.inv[mat] -= 1;
      b.hp = Math.min(b.maxHp, b.hp + b.maxHp * 0.5);
      startAction(p, 'pickup', 0.6, b.x, b.z);
      fx(g, 'poof', b.x, b.z, { y: 0.4, color: 0xcdb48a });
      msg(g, `You patch up the ${BUILDS[b.type].name} (${Math.ceil(b.hp)}/${b.maxHp}).`);
      break;
    }
    case 'sleep':
      trySleep(g, t.build);
      break;
    case 'furnace':
      g.activeBuild = t.build.id;
      g.openPanel = 'furnace';
      break;
    case 'anvil':
      g.activeBuild = t.build.id;
      g.openPanel = 'anvil';
      break;
    case 'talk':
      p.rot = Math.atan2(t.npc.x - p.x, t.npc.z - p.z);
      if (t.npc.type === 'chief') {
        complete(g, 'chief');
        g.openPanel = 'chief';
      } else g.openPanel = 'shop';
      break;
    case 'villager':
      msg(g, `Villager: "${VILLAGER_LINES[t.npc.variant % VILLAGER_LINES.length]}"`);
      break;
    case 'water':
      startAction(p, 'drink', 0.8, t.x, t.z);
      p.thirst = 100;
      fx(g, 'splash', t.x, t.z, { y: 0.1 });
      if (g.tools.waterskin) {
        g.inv.water = WATERSKIN_CAP;
        msg(g, 'You drink deeply and fill your waterskin. 💧');
        complete(g, 'water');
      } else msg(g, 'You drink deeply. A waterskin would let you carry some. 💧');
      break;
    case 'well':
      msg(g, 'The well is bone dry. A rope with an empty bucket hangs inside.');
      break;
    case 'sign':
      msg(g, g.plotOwned ? 'Your land. Marauders never come near the village or this plot.' : `LAND FOR SALE: ${PLOT.price} gold. Ask Chief Soloman.`);
      break;
    case 'trail':
      g.pendingTravel = n.dest;
      break;
    case 'lever':
      startAction(p, 'pickup', 0.6, n.x, n.z);
      pullLever(g, n);
      break;
    case 'chest':
      startAction(p, 'pickup', 0.6, n.x, n.z);
      openChest(g, n);
      break;
    case 'stairs':
      msg(g, 'Stone steps spiral down into the dark, choked with rubble. Whatever lies below will have to wait.');
      break;
    case 'door':
      if (t.door.kind === 'shortcutA') {
        g.inv.goldenKey -= 1;
        g.w.doors.filter((dr) => dr.kind !== 'boss').forEach((dr) => openDoor(g, dr));
        msg(g, 'The golden key turns. Both shortcut doors grind open: the way back to the entrance is clear.');
      }
      break;
    default:
      break;
  }
}

function trySleep(g, b) {
  const w = g.w;
  const p = g.player;
  const night = isNight(g.tod) || g.tod > 0.6;
  if (raiders(g).length) return msg(g, "You can't sleep while marauders are raiding your camp!");
  if (b.type === 'shelter') {
    const f = litFireNear(g, b.x, b.z, FIRE_RANGE);
    if (!f) return msg(g, nearestBuild(w, 'fire', b.x, b.z, FIRE_RANGE) ? 'Light the fire first.' : "It's too cold and exposed. Build a fire pit near the shelter.");
    if (night && f.fuel < 70) msg(g, 'The fire is low. It might die before morning!');
  }
  if (!night && p.energy > 40) return msg(g, "You're not tired yet. Sleep when night falls.");
  if (w.enemies.some((e) => !ENEMIES[e.type].passive && dist2(e.x, e.z, p.x, p.z) < 12)) return msg(g, "You can't sleep with enemies nearby!");
  g.sleeping = true;
  g.sleepAt = b.id;
  g.sleepWasNight = night;
  g.sleepCrossed = false;
  p.action = null;
  p.actionT = 0;
  msg(g, b.type === 'hut' ? 'You settle in behind thick stone walls…' : 'You curl up in the shelter by the fire…');
}

export function doAttack(g) {
  const p = g.player;
  if (g.over || g.sleeping || p.actionT > 0 || p.cooldown > 0) return;
  const w = weapon(g);
  const T = w ? TOOLS[w] : { swing: 0.42, cd: 0.5 };
  startAction(p, 'attack', T.swing);
  p.cooldown = T.cd;
  p.energy = Math.max(0, p.energy - (w === 'mace' ? ENERGY.heavySwing : ENERGY.swing));
}

export function doDodge(g) {
  const p = g.player;
  if (g.over || g.sleeping || p.dodgeCd > 0) return;
  if (p.actionT > 0 && !(p.action === 'attack' && p.hitDone) && p.action !== 'pickup') return;
  if (p.energy < ENERGY.dodge) return msg(g, 'Too tired to dodge.');
  const m = Math.hypot(p.moveX, p.moveZ);
  if (m > 0.1) {
    p.dodgeX = p.moveX / m;
    p.dodgeZ = p.moveZ / m;
  } else {
    p.dodgeX = -Math.sin(p.rot);
    p.dodgeZ = -Math.cos(p.rot);
  }
  startAction(p, 'dodge', 0.42);
  p.rootT = 0; // a dodge roll tears you free of grasping hands
  p.dodgeCd = 0.75;
  p.energy = Math.max(0, p.energy - ENERGY.dodge);
  fx(g, 'dust', p.x, p.z);
}

export function canAfford(g, cost) {
  return Object.entries(cost).every(([k, v]) => (g.inv[k] || 0) >= v);
}

function wallObs(x, z, rot) {
  const out = [];
  for (let i = -1; i <= 1; i++) out.push({ x: x + Math.cos(rot) * i * 0.85, z: z - Math.sin(rot) * i * 0.85, r: 0.55 });
  return out;
}
function hutObs(x, z, rot) {
  const out = [];
  const half = 2.0;
  for (let i = -2; i <= 2; i++) {
    for (const side of ['back', 'left', 'right', 'front']) {
      if (side === 'front' && Math.abs(i) < 1) continue; // doorway
      let lx = i * 0.95;
      let lz = 0;
      if (side === 'back') lz = -half;
      if (side === 'front') lz = half;
      if (side === 'left') {
        lx = -half;
        lz = i * 0.95;
      }
      if (side === 'right') {
        lx = half;
        lz = i * 0.95;
      }
      out.push({ x: x + lx * Math.cos(rot) + lz * Math.sin(rot), z: z - lx * Math.sin(rot) + lz * Math.cos(rot), r: 0.5 });
    }
  }
  return out;
}

// where would a building go, and is that allowed?
export function buildSpot(g, id) {
  const p = g.player;
  const B = BUILDS[id];
  const x = p.x + Math.sin(p.rot) * B.ahead;
  const z = p.z + Math.cos(p.rot) * B.ahead;
  if (g.region === 'cave') return { x, z, why: 'There is no room to build down here.' };
  if (g.region === 'desert') {
    if (inPlot(x, z, B.size * 0.6)) {
      if (!g.plotOwned) return { x, z, why: `This land is for sale. Buy it from Chief Soloman for ${PLOT.price} gold.` };
      if (!inPlot(x, z, -B.size * 0.7)) return { x, z, why: 'Too close to the fence. Step further into your plot.' };
    } else if (inVillage(x, z) || dist2(x, z, DESERT.village.x, DESERT.village.z) < DESERT.village.r + 3 + B.size) {
      return { x, z, why: 'This is village land. Buy the plot beside the village from Chief Soloman to build safely here.' };
    }
  }
  const blocked = obstacles(g).some((o) => dist2(x, z, o.x, o.z) < o.r + B.room) || Math.hypot(x, z) > g.w.r - 2;
  if (blocked) return { x, z, why: 'Not enough room here. Find a clearer spot.' };
  return { x, z, ok: true };
}

export function craft(g, id) {
  const r = RECIPES.find((x) => x.id === id);
  const p = g.player;
  if (!r || !canAfford(g, r.cost)) {
    msg(g, 'Not enough materials.');
    return false;
  }
  const pay = () => Object.entries(r.cost).forEach(([k, v]) => (g.inv[k] -= v));
  if (r.kind === 'tool') {
    if (g.tools[id]) {
      msg(g, 'You already have one.');
      return false;
    }
    pay();
    gainTool(g, id);
    msg(g, `You craft a ${TOOLS[id].name.toLowerCase()}! ${TOOLS[id].icon}`);
    if (id === 'waterskin') msg(g, 'Fill it at an oasis.');
    complete(g, id);
    return true;
  }
  if (r.kind === 'material') {
    pay();
    give(g, id, r.makes, true);
    msg(g, `You press mortar and stone into ${r.makes} stone blocks. 🧱`);
    complete(g, 'block');
    return true;
  }
  const spot = buildSpot(g, id);
  if (!spot.ok) {
    msg(g, spot.why);
    return false;
  }
  const { x, z } = spot;
  if (id === 'fire') {
    const sh = nearestBuild(g.w, 'shelter', x, z);
    if (sh && dist2(sh.x, sh.z, x, z) < 3) {
      msg(g, 'Too close to the shelter. Take a few steps away.');
      return false;
    }
  }
  pay();
  const rot = id === 'wall' ? p.rot : p.rot + Math.PI;
  const b = { id: g.nextId++, type: id, x, z, rot, hp: BUILDS[id].hp, maxHp: BUILDS[id].hp, hitT: 0 };
  if (id === 'fire') Object.assign(b, { lit: true, fuel: 90 });
  b.obs = buildObs(b);
  g.w.builds.push(b);
  fx(g, 'poof', x, z, { y: 0.2, color: 0xc8b48a, n: 16 });
  msg(g, { fire: 'You build a fire pit and get it burning. 🔥', shelter: 'You lash together a lean-to shelter. ⛺', hut: 'You raise a sturdy stone hut. 🏠', wall: 'You stack a stone wall. 🧱', furnace: 'You build a roaring stone furnace. 🏭', anvil: 'You set a heavy stone anvil in place. ⚒️' }[id]);
  if (g.region === 'desert' && id !== 'wall' && !inSafeZone(g, x, z) && !g.raidWarned) {
    g.raidWarned = true;
    msg(g, 'Careful: marauders raid camps outside the village every night.');
  }
  if (id === 'fire') {
    const sh = nearestBuild(g.w, 'shelter', x, z);
    if (sh && dist2(sh.x, sh.z, x, z) > FIRE_RANGE) msg(g, 'Tip: the fire is far from the shelter. Build them closer to sleep.');
  }
  complete(g, id);
  return true;
}

/* ---------- smelting + smithing ---------- */
export function smelt(g, all) {
  const f = g.w.builds.find((b) => b.id === g.activeBuild && b.type === 'furnace');
  if (!f) return null;
  const n = all ? Math.min(g.inv.copper, g.inv.tin) : 1;
  if (n < 1 || g.inv.copper < 1 || g.inv.tin < 1) {
    msg(g, 'You need 1 copper ore and 1 tin ore for each bar.');
    return null;
  }
  let made = 0;
  for (let i = 0; i < n; i++) {
    g.inv.copper -= 1;
    g.inv.tin -= 1;
    if (rng(g) < SMELT_CHANCE) made++;
  }
  g.inv.bronzeBar += made;
  f.activeT = g.time;
  fx(g, 'sparks', f.x, f.z, { y: 1.0 });
  const failed = n - made;
  if (n === 1) msg(g, made ? 'The molten bronze settles into a bar. +1 bronze bar 🟧' : 'The mold cracks. That bronze is ruined.');
  else msg(g, `Smelted ${made} bronze bar${made === 1 ? '' : 's'}${failed ? ` (${failed} cracked)` : ''}. 🟧`);
  if (made) complete(g, 'smelt');
  return { made, failed };
}
export function forge(g, id) {
  const recipe = FORGE.find((f) => f.id === id);
  const a = g.w.builds.find((b) => b.id === g.activeBuild && b.type === 'anvil');
  if (!recipe || !a) return false;
  if (!g.tools.hammer) {
    msg(g, 'You need a smithing hammer.');
    return false;
  }
  if (g.tools[id]) {
    msg(g, `You already have a ${TOOLS[id].name.toLowerCase()}.`);
    return false;
  }
  if (g.inv.bronzeBar < recipe.bars) {
    msg(g, `You need ${recipe.bars} bronze bars.`);
    return false;
  }
  g.inv.bronzeBar -= recipe.bars;
  gainTool(g, id);
  wearTool(g, 'hammer');
  startAction(g.player, 'smith', 0.62, a.x, a.z);
  g.player.target = a.id;
  msg(g, `You hammer out a ${TOOLS[id].name.toLowerCase()}! ${TOOLS[id].icon}`);
  complete(g, 'forge');
  return true;
}

export function eat(g, item) {
  const f = ITEMS[item] && ITEMS[item].food;
  const p = g.player;
  if (!f || g.inv[item] <= 0) return;
  g.inv[item] -= 1;
  p.hunger = clamp(p.hunger + f.hunger, 0, 100);
  if (f.thirst) p.thirst = clamp(p.thirst + f.thirst, 0, 100);
  if (f.heal) p.health = clamp(p.health + f.heal, 0, 100);
  if (!g.sleeping) startAction(p, 'eat', 0.9);
  if (f.dmg && (f.sick || rng(g) < f.risk)) {
    p.health = Math.max(1, p.health - f.dmg);
    p.hurtT = 0.4;
    msg(g, item === 'rawMeat' ? 'Raw meat made you sick! Cook it next time.' : 'That mushroom was bad… you feel ill.');
  } else msg(g, `Ate ${ITEMS[item].name.toLowerCase()}. +${f.hunger} food`);
}
export function drink(g) {
  const p = g.player;
  if (g.inv.water <= 0) return msg(g, 'Your waterskin is empty.');
  g.inv.water -= 1;
  p.thirst = clamp(p.thirst + 35, 0, 100);
  if (!g.sleeping) startAction(p, 'drink', 0.8);
  msg(g, `You take a sip. ${g.inv.water}/${WATERSKIN_CAP} left 💧`);
}

export function buy(g, id) {
  const offer = SHOP.buy.find((o) => o.id === id);
  if (!offer) return false;
  if (g.gold < offer.price) {
    msg(g, 'Merchant: "Come back when you have the gold."');
    return false;
  }
  if (offer.tool && g.tools[id]) {
    msg(g, 'Merchant: "You already carry one of those."');
    return false;
  }
  g.gold -= offer.price;
  if (offer.tool) gainTool(g, id);
  else g.inv[id] += 1;
  msg(g, `Bought ${offer.tool ? TOOLS[id].name.toLowerCase() : ITEMS[id].name.toLowerCase()} for ${offer.price} gold.`);
  return true;
}
export function sell(g, id) {
  const offer = SHOP.sell.find((o) => o.id === id);
  if (!offer || g.inv[id] <= 0) return false;
  g.inv[id] -= 1;
  g.gold += offer.price;
  msg(g, `Sold ${ITEMS[id].name.toLowerCase()} for ${offer.price} gold.`);
  return true;
}

export function buyPlot(g) {
  if (g.plotOwned) return false;
  if (g.gold < PLOT.price) {
    msg(g, `Chief Soloman: "The land costs ${PLOT.price} gold, friend."`);
    return false;
  }
  g.gold -= PLOT.price;
  g.plotOwned = true;
  msg(g, 'Chief Soloman: "The land north of the village is yours. No marauder will set foot on it."');
  complete(g, 'property');
  return true;
}

export function chiefState(g) {
  if (g.done.report) return 'done';
  if (!g.quest) return 'intro';
  if (g.done.camp && g.done.king) return 'ready';
  return 'active';
}
export function acceptQuest(g) {
  if (g.quest) return;
  g.quest = 'active';
  msg(g, 'New quest: Chronic Dehydration');
}
export function turnInQuest(g) {
  if (chiefState(g) !== 'ready') return;
  g.gold += 200;
  g.quest = 'done';
  msg(g, 'Chief Soloman: "The oasis is ours again! Take this, with our thanks." +200 gold');
  complete(g, 'report');
}
export function campRemaining(g) {
  const w = g.worlds.desert;
  if (!w) return { marauders: 12, king: true };
  return { marauders: w.enemies.filter((e) => e.camp && !ENEMIES[e.type].boss).length, king: w.enemies.some((e) => e.type === 'king') };
}

export function respawnInVillage(g) {
  const p = g.player;
  if (g.region === 'cave') {
    // villagers drag you out of the cave; the Guardian settles back into his sarcophagus
    resetMummy(g);
    travel(g, 'desert');
    g.msgs = [];
  }
  p.rootT = 0;
  const lost = Math.floor(g.gold / 2);
  g.gold -= lost;
  const chief = g.w.npcs.find((n) => n.type === 'chief');
  p.x = chief.x + 1.5;
  p.z = chief.z + 1.5;
  p.health = 60;
  p.thirst = Math.max(p.thirst, 70);
  p.hunger = Math.max(p.hunger, 50);
  p.warmth = Math.max(p.warmth, 80);
  p.action = null;
  p.actionT = 0;
  g.over = false;
  g.w.arrows = [];
  for (const e of g.w.enemies) {
    if (ENEMIES[e.type].human && !e.raid) {
      e.state = 'idle';
      e.returning = true;
    }
  }
  msg(g, `Villagers carried you back to the village.${lost ? ` You lost ${lost} gold.` : ''}`);}

/* =====================================================================
   PLAYTEST — jump straight to any part of the game
   ===================================================================== */
export const SCENARIOS = [
  { id: 'forestCamp', title: 'Forest · ready to make camp', desc: 'Axe and club in hand, logs and sticks in the bag, late afternoon. Build the shelter and fire, then sleep.' },
  { id: 'desertArrive', title: 'Desert · just arrived', desc: 'Level 1 done. Fresh off the trail with a pickaxe, axe and a full waterskin.' },
  { id: 'village', title: 'Desert · in the village, 600 gold', desc: 'Quest accepted, at Chief Soloman. Buy the land, then build. Bag full of stone blocks, logs and ore.' },
  { id: 'smithing', title: 'Desert · smithing ready', desc: 'You own the plot with a hut, fire, furnace and anvil. Hammer, 20 copper + 20 tin, 46 bronze bars.' },
  { id: 'raid', title: 'Desert · raid tonight', desc: 'A hut out in the open dunes, sword and shield, just before sunset. The raiders arrive at nightfall.' },
  { id: 'boss', title: 'Desert · storm the camp', desc: 'Full bronze armor, mace, sword, dagger and shield at the camp gate. Cooked meat in the bag.' },
  { id: 'cave', title: 'Cave · just inside', desc: 'Full bronze gear in the cave entrance hall. Find the two levers and the two treasure chests.' },
  { id: 'caveBoss', title: 'Cave · Mummy Guardian', desc: 'Both levers pulled, both cave weapons found, full bronze gear. Standing outside the open boss door.' },
];
const L1_DONE = ['gather', 'fiber', 'axe', 'club', 'chop', 'shelter', 'fire', 'cook', 'sleep'];
function giveAll(g, items) {
  Object.entries(items).forEach(([k, v]) => (g.inv[k] = (g.inv[k] || 0) + v));
}
function placeBuild(g, type, x, z, rot) {
  const b = { id: g.nextId++, type, x, z, rot, hp: BUILDS[type].hp, maxHp: BUILDS[type].hp, hitT: 0 };
  if (type === 'fire') Object.assign(b, { lit: true, fuel: 200 });
  b.obs = buildObs(b);
  g.w.builds.push(b);
  return b;
}
function clearAround(g, x, z, r) {
  g.w.nodes = g.w.nodes.filter((n) => PORTAL[n.type] || dist2(n.x, n.z, x, z) > r);
  g.w.enemies = g.w.enemies.filter((e) => ENEMIES[e.type].human || dist2(e.x, e.z, x, z) > r + 10);
}
function toDesert(g) {
  L1_DONE.forEach((k) => (g.done[k] = true));
  g.level = 2;
  gainTool(g, 'pickaxe');
  gainTool(g, 'axe');
  gainTool(g, 'waterskin');
  g.done.pickaxe = true;
  travel(g, 'desert');
  g.inv.water = WATERSKIN_CAP;
  g.done.water = true;
}
export function applyScenario(g, id) {
  const p = g.player;
  g.msgs = [];
  if (id === 'forestCamp') {
    ['gather', 'fiber', 'axe', 'club', 'chop'].forEach((k) => (g.done[k] = true));
    gainTool(g, 'axe');
    gainTool(g, 'club');
    giveAll(g, { log: 6, stick: 14, fiber: 6, stone: 8, rawMeat: 1 });
    g.tod = 0.5;
    msg(g, '🧪 Playtest: ready to make camp. Build a shelter, then a fire pit.');
    return;
  }
  toDesert(g);
  g.msgs = []; // drop the travel chatter
  const chief = g.w.npcs.find((n) => n.type === 'chief');
  const standAt = (x, z, faceX, faceZ) => {
    p.x = x;
    p.z = z;
    p.rot = Math.atan2(faceX - x, faceZ - z);
  };
  if (id === 'desertArrive') {
    msg(g, '🧪 Playtest: just arrived in the desert. Follow the star to the village.');
    return;
  }
  if (id === 'cave' || id === 'caveBoss') {
    ['village', 'chief'].forEach((k) => (g.done[k] = true));
    g.quest = 'active';
    ['dagger', 'sword', 'mace', 'shield', 'helmet', 'platelegs', 'platebody'].forEach((k) => gainTool(g, k));
    g.equip = 'sword';
    giveAll(g, { cookedMeat: 8 });
    g.gold = 100;
    travel(g, 'cave');
    g.msgs = [];
    if (id === 'cave') {
      msg(g, '🧪 Playtest: inside the cave. Pull both levers to open the boss door.');
      return;
    }
    const w = g.w;
    w.nodes.forEach((n) => {
      if (n.type === 'lever') n.pulled = true;
      if (n.type === 'chest') {
        n.opened = true;
        gainTool(g, n.item);
      }
    });
    openDoor(g, w.doors.find((d) => d.kind === 'boss'));
    g.equip = 'mace';
    w.enemies = w.enemies.filter((e) => e.type === 'mummy' || dist2(e.x, e.z, -6.25, -11) > 16);
    standAt(-6.25, -10.5, -6.25, -20);
    g.fx = [];
    msg(g, '🧪 Playtest: the great door is open. The Mummy Guardian waits to the north.');
    return;
  }
  ['village', 'chief'].forEach((k) => (g.done[k] = true));
  g.quest = 'active';
  if (id === 'village') {
    g.gold = 600;
    giveAll(g, { stoneBlock: 24, stone: 20, log: 8, stick: 8, fiber: 6, copper: 10, tin: 10, limestone: 4, cookedMeat: 3 });
    standAt(chief.x + Math.sin(chief.rot) * 2.4, chief.z + Math.cos(chief.rot) * 2.4, chief.x, chief.z);
    msg(g, '🧪 Playtest: talk to the chief to buy the land, then build on it.');
    return;
  }
  ['mine', 'block'].forEach((k) => (g.done[k] = true));
  if (id === 'smithing') {
    g.plotOwned = true;
    g.done.property = true;
    g.done.hut = true;
    placeBuild(g, 'hut', -44, 45.1, Math.PI);
    placeBuild(g, 'furnace', -39.3, 37.7, Math.PI / 2);
    placeBuild(g, 'anvil', -39.3, 43.2, Math.PI / 2);
    placeBuild(g, 'fire', -47.5, 36.2, 0);
    gainTool(g, 'hammer');
    giveAll(g, { copper: 20, tin: 20, bronzeBar: 46, stoneBlock: 10, log: 4 });
    g.gold = 200;
    standAt(-36.8, 37.7, -39.3, 37.7);
    msg(g, '🧪 Playtest: furnace in front of you, anvil to your right. USE them.');
    return;
  }
  if (id === 'raid') {
    const hx = -8;
    const hz = -18;
    clearAround(g, hx, hz, 9);
    placeBuild(g, 'hut', hx, hz, Math.PI);
    placeBuild(g, 'wall', hx, hz - 4.2, 0);
    g.done.hut = true;
    gainTool(g, 'sword');
    gainTool(g, 'shield');
    giveAll(g, { stoneBlock: 6, cookedMeat: 3 });
    g.gold = 100;
    g.tod = 0.648; // nightfall (and the raid) is about 10 seconds away
    standAt(hx, hz - 6.5, hx, hz);
    msg(g, '🧪 Playtest: the sun is setting. Raiders come for your hut at nightfall.');
    return;
  }
  if (id === 'boss') {
    g.done.hut = true;
    ['dagger', 'sword', 'mace', 'shield', 'helmet', 'platelegs', 'platebody', 'hammer'].forEach((k) => gainTool(g, k));
    g.equip = 'mace';
    giveAll(g, { cookedMeat: 6 });
    g.gold = 250;
    g.tod = 0.2;
    const C = DESERT.camp;
    const a = g.w.decor.gateA;
    standAt(C.x + Math.cos(a) * 22, C.z + Math.sin(a) * 22, C.x, C.z);
    msg(g, '🧪 Playtest: full bronze gear. Storm the camp and take down the King.');
  }
}
export const CHEATS = [
  { id: 'gold', label: '+500 gold' },
  { id: 'mats', label: '+20 of every material' },
  { id: 'heal', label: 'Heal + refill all stats' },
  { id: 'god', label: 'Toggle god mode' },
  { id: 'dusk', label: 'Skip to sunset' },
  { id: 'morning', label: 'Skip to morning' },
  { id: 'raid', label: 'Start a raid now' },
  { id: 'gear', label: 'Full bronze gear' },
];
export const WARPS = [
  { id: 'village', label: 'Village', region: 'desert' },
  { id: 'plot', label: 'Your plot', region: 'desert' },
  { id: 'oasis', label: 'Oasis', region: 'desert' },
  { id: 'camp', label: 'Camp gate', region: 'desert' },
  { id: 'desertTrail', label: 'Desert trail', region: 'desert' },
  { id: 'forestTrail', label: 'Forest trail', region: 'forest' },
  { id: 'caveMouth', label: 'Cave mouth', region: 'desert' },
  { id: 'caveIn', label: 'Cave entrance hall', region: 'cave' },
  { id: 'caveBoss', label: 'Cave boss door', region: 'cave' },
];
export function cheat(g, id) {
  const p = g.player;
  if (id === 'gold') g.gold += 500;
  if (id === 'mats') giveAll(g, { stick: 20, stone: 20, fiber: 20, log: 20, copper: 20, tin: 20, limestone: 20, stoneBlock: 20, bronzeBar: 20, leather: 20, cookedMeat: 5 });
  if (id === 'heal') Object.assign(p, { health: 100, hunger: 100, energy: 100, warmth: 100, thirst: 100 });
  if (id === 'god') g.god = !g.god;
  if (id === 'dusk') g.tod = 0.6;
  if (id === 'morning') {
    if (g.tod > 0.1) g.day += 1;
    g.tod = 0.08;
  }
  if (id === 'raid') {
    if (g.region !== 'desert' || !exposedBuilds(g, false).length) msg(g, '🧪 Raids need a building out in the desert, outside the village and your plot.');
    else startRaid(g);
  }
  if (id === 'gear') ['dagger', 'sword', 'mace', 'shield', 'helmet', 'platelegs', 'platebody', 'hammer', 'pickaxe', 'axe', 'waterskin'].forEach((k) => !g.tools[k] && gainTool(g, k));
  if (id !== 'raid') msg(g, `🧪 ${CHEATS.find((c) => c.id === id).label}${id === 'god' ? (g.god ? ': ON' : ': OFF') : ''}`);
}
export function warp(g, id) {
  const W = WARPS.find((x) => x.id === id);
  if (!W) return;
  if (W.region !== 'forest' && !g.worlds.desert && g.level < 2) toDesert(g);
  if (g.region !== W.region) travel(g, W.region);
  const p = g.player;
  const V = DESERT.village;
  const spots = {
    caveMouth: [CAVE_MOUTH.x + Math.sin(CAVE_MOUTH.rot) * 4, CAVE_MOUTH.z + Math.cos(CAVE_MOUTH.rot) * 4],
    caveIn: [-6.25, 31],
    caveBoss: [-6.25, -10.5],
    village: [V.x + 4, V.z + 4],
    plot: [PLOT.x, PLOT.z - PLOT.half + 2],
    oasis: [DESERT.oasis.x - DESERT.oasis.r - 2.5, DESERT.oasis.z],
    camp: [DESERT.camp.x + Math.cos(g.w.decor.gateA || 0) * 22, DESERT.camp.z + Math.sin(g.w.decor.gateA || 0) * 22],
    desertTrail: [DESERT.arrival.x + 6, DESERT.arrival.z],
    forestTrail: [FOREST_TRAIL.x - 4, FOREST_TRAIL.z],
  };
  const [x, z] = spots[id];
  p.x = x;
  p.z = z;
  g.w.arrows = [];
  msg(g, `🧪 Warped to: ${W.label}`);
}

export function objectiveTarget(g) {
  const cur = currentObjective(g);
  if (!cur || g.level < 2) return null;
  if (g.region === 'forest') return FOREST_TRAIL;
  const chief = g.w.npcs.find((n) => n.type === 'chief');
  if (['village', 'chief', 'report'].includes(cur.id)) return chief;
  if (cur.id === 'water') return DESERT.oasis;
  if (cur.id === 'camp' || cur.id === 'king') return DESERT.camp;
  if (cur.id === 'hut' && g.plotOwned) return PLOT;
  return null;
}

/* =====================================================================
   3D — materials, builders
   ===================================================================== */
const matCache = {};
function M(color, opts) {
  const key = color + (opts ? JSON.stringify(opts) : '');
  if (!matCache[key]) {
    matCache[key] = new THREE.MeshLambertMaterial({ color, ...opts });
    matCache[key].userData.shared = true;
  }
  return matCache[key];
}
function mesh(geo, mat, x = 0, y = 0, z = 0, cast = true) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = cast;
  m.receiveShadow = true;
  return m;
}
const GEO = {};
// split shared vertices so every face gets its own normal: the faceted low-poly look,
// without relying on material.flatShading (which MeshLambertMaterial ignores in older three.js)
function flat(geometry) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  g.computeVertexNormals();
  return g;
}
function geo(key, make) {
  if (!GEO[key]) {
    GEO[key] = flat(make());
    GEO[key].userData.shared = true;
  }
  return GEO[key];
}

const COL = {
  skin: 0xe2ab83, shirt: 0x3f86c4, shirtDark: 0x2e6a9e, pants: 0x34425c, boot: 0x4a3122,
  hair: 0x4e2e1b, pack: 0x8b6a3d, packDark: 0x6c4f2a, bedroll: 0x9c3b2e,
  bark: 0x6b4526, barkDark: 0x553419, wood: 0x8a5a2c, cut: 0xd9b27c, stone: 0x9a9a95, stoneDark: 0x77776f,
  bronze: 0xc98a3c, steel: 0xb9bec6, gold: 0xe0b23a, adobe: 0xd9b48a, adobeDark: 0xb8936a, sandstone: 0xcdb48a,
};

const handle = () => geo('handle', () => new THREE.CylinderGeometry(0.028, 0.034, 0.78, 6).rotateX(Math.PI / 2));
function makeTool(kind) {
  const g = new THREE.Group();
  // the tool's handle points along +z from the fist; the head sits at the far end
  if (kind === 'axe') {
    g.add(mesh(handle(), M(0x9a6534), 0, 0, 0.26));
    g.add(mesh(geo('axehead', () => new THREE.BoxGeometry(0.06, 0.22, 0.16)), M(COL.stone), 0, -0.07, 0.6));
    g.add(mesh(geo('axeedge', () => new THREE.BoxGeometry(0.03, 0.06, 0.16)), M(0xcfcfc8), 0, -0.19, 0.6));
    g.add(mesh(geo('lash', () => new THREE.BoxGeometry(0.075, 0.07, 0.07)), M(0xc9b16a), 0, 0.02, 0.6));
  } else if (kind === 'pickaxe') {
    g.add(mesh(handle(), M(0x9a6534), 0, 0, 0.26));
    g.add(mesh(geo('pickhead', () => new THREE.BoxGeometry(0.06, 0.5, 0.07)), M(COL.stone), 0, -0.02, 0.62));
    g.add(mesh(geo('picktip', () => new THREE.ConeGeometry(0.04, 0.12, 4)), M(0xcfcfc8), 0, 0.28, 0.62));
    const tip2 = mesh(geo('picktip', () => new THREE.ConeGeometry(0.04, 0.12, 4)), M(0xcfcfc8), 0, -0.32, 0.62);
    tip2.rotation.x = Math.PI;
    g.add(tip2);
    g.add(mesh(geo('lash', () => new THREE.BoxGeometry(0.075, 0.07, 0.07)), M(0xc9b16a), 0, 0, 0.6));
  } else if (kind === 'club') {
    g.add(mesh(geo('club', () => new THREE.CylinderGeometry(0.075, 0.032, 0.74, 7).rotateX(Math.PI / 2)), M(COL.wood), 0, 0, 0.3));
    g.add(mesh(geo('knot', () => new THREE.SphereGeometry(0.035, 5, 4)), M(0x5c3a1a), 0.06, 0.02, 0.48));
    g.add(mesh(geo('grip', () => new THREE.CylinderGeometry(0.04, 0.04, 0.12, 6).rotateX(Math.PI / 2)), M(0xc9b16a), 0, 0, 0.02));
  } else if (kind === 'sword') {
    g.add(mesh(geo('swordGrip', () => new THREE.CylinderGeometry(0.03, 0.03, 0.18, 6).rotateX(Math.PI / 2)), M(0x5a3a22), 0, 0, 0.02));
    g.add(mesh(geo('swordGuard', () => new THREE.BoxGeometry(0.06, 0.24, 0.05)), M(COL.bronze), 0, 0, 0.13));
    g.add(mesh(geo('swordBlade', () => new THREE.BoxGeometry(0.025, 0.085, 0.72)), M(COL.bronze, { emissive: 0x2a1404 }), 0, 0, 0.5));
    g.add(mesh(geo('swordTip', () => new THREE.ConeGeometry(0.045, 0.14, 4).rotateX(Math.PI / 2)), M(COL.bronze), 0, 0, 0.92));
  } else if (kind === 'scimitar' || kind === 'greatsword') {
    const s = kind === 'greatsword' ? 1.45 : 1;
    g.add(mesh(geo('scGrip', () => new THREE.CylinderGeometry(0.03, 0.03, 0.18, 6).rotateX(Math.PI / 2)), M(0x2a1a12), 0, 0, 0.02));
    g.add(mesh(geo('scGuard', () => new THREE.BoxGeometry(0.06, 0.2, 0.04)), M(kind === 'greatsword' ? COL.gold : 0x6a6a6a), 0, 0, 0.12));
    for (let i = 0; i < 3; i++) {
      const b = mesh(geo('scBlade', () => new THREE.BoxGeometry(0.022, 0.09, 0.3)), M(COL.steel), 0, -0.03 * i * i * s, (0.28 + i * 0.27) * s);
      b.rotation.x = -0.18 * i;
      b.scale.set(1, s, s);
      g.add(b);
    }
  } else if (kind === 'dagger') {
    g.add(mesh(geo('dgGrip', () => new THREE.CylinderGeometry(0.026, 0.026, 0.14, 6).rotateX(Math.PI / 2)), M(0x4a2a18), 0, 0, 0.01));
    g.add(mesh(geo('dgGuard', () => new THREE.BoxGeometry(0.05, 0.16, 0.035)), M(COL.bronze), 0, 0, 0.09));
    g.add(mesh(geo('dgBlade', () => new THREE.BoxGeometry(0.02, 0.06, 0.32)), M(COL.bronze, { emissive: 0x2a1404 }), 0, 0, 0.26));
    g.add(mesh(geo('dgTip', () => new THREE.ConeGeometry(0.032, 0.1, 4).rotateX(Math.PI / 2)), M(COL.bronze), 0, 0, 0.46));
  } else if (kind === 'mace') {
    g.add(mesh(geo('mcHandle', () => new THREE.CylinderGeometry(0.03, 0.036, 0.62, 6).rotateX(Math.PI / 2)), M(0x5a3a22), 0, 0, 0.22));
    g.add(mesh(geo('mcHead', () => new THREE.IcosahedronGeometry(0.13, 0)), M(COL.bronze, { emissive: 0x2a1404 }), 0, 0, 0.58));
    [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1]].forEach(([x, y, z], i) => {
      const sp = mesh(geo('mcSpike', () => new THREE.ConeGeometry(0.035, 0.11, 4)), M(0xe0a85a), x * 0.14, y * 0.14, 0.58 + z * 0.14, false);
      if (x) sp.rotation.z = -x * Math.PI / 2;
      if (y < 0) sp.rotation.x = Math.PI;
      if (z) sp.rotation.x = Math.PI / 2;
      g.add(sp);
    });
  } else if (kind === 'hammer') {
    g.add(mesh(geo('hmHandle', () => new THREE.CylinderGeometry(0.028, 0.032, 0.5, 6).rotateX(Math.PI / 2)), M(0x9a6534), 0, 0, 0.16));
    g.add(mesh(geo('hmHead', () => new THREE.BoxGeometry(0.11, 0.24, 0.12)), M(COL.stoneDark), 0, -0.02, 0.42));
    g.add(mesh(geo('lash', () => new THREE.BoxGeometry(0.075, 0.07, 0.07)), M(0xc9b16a), 0, 0.02, 0.36));
  } else if (kind === 'khopesh') {
    g.add(mesh(geo('khGrip', () => new THREE.CylinderGeometry(0.03, 0.03, 0.18, 6).rotateX(Math.PI / 2)), M(0x2a1a12), 0, 0, 0.02));
    g.add(mesh(geo('khGuard', () => new THREE.BoxGeometry(0.06, 0.16, 0.05)), M(COL.gold), 0, 0, 0.12));
    g.add(mesh(geo('khShank', () => new THREE.BoxGeometry(0.03, 0.06, 0.36)), M(COL.bronze, { emissive: 0x2a1404 }), 0, 0, 0.31));
    // the hooked sickle blade curls forward and down from the end of the shank
    const cy = -0.16;
    const cz = 0.5;
    const R = 0.18;
    for (let k = 0; k < 6; k++) {
      const th = ((95 - k * 40 - 20) * Math.PI) / 180;
      const b = mesh(geo('khBlade', () => new THREE.BoxGeometry(0.026, 0.085, 0.15)), M(COL.gold, { emissive: 0x3a2800 }), 0, cy + R * Math.sin(th), cz + R * Math.cos(th), false);
      b.rotation.x = Math.PI / 2 - th;
      g.add(b);
    }
  } else if (kind === 'spear') {
    g.add(mesh(geo('spShaft', () => new THREE.CylinderGeometry(0.026, 0.03, 1.7, 6).rotateX(Math.PI / 2)), M(0x6a4a2a), 0, 0, 0.42));
    g.add(mesh(geo('spButt', () => new THREE.ConeGeometry(0.035, 0.1, 5).rotateX(-Math.PI / 2)), M(COL.bronze), 0, 0, -0.47));
    g.add(mesh(geo('spCollar', () => new THREE.CylinderGeometry(0.045, 0.045, 0.08, 6).rotateX(Math.PI / 2)), M(COL.gold), 0, 0, 1.28));
    g.add(mesh(geo('spScarab', () => new THREE.SphereGeometry(0.06, 6, 4).scale(1, 0.6, 1.3)), M(0x1fa89a, { emissive: 0x0a3a34 }), 0, 0.05, 1.34, false));
    g.add(mesh(geo('spHead', () => new THREE.ConeGeometry(0.07, 0.34, 4).rotateX(Math.PI / 2)), M(COL.bronze, { emissive: 0x2a1404 }), 0, 0, 1.5));
  } else if (kind === 'staff') {
    g.add(mesh(geo('staff', () => new THREE.CylinderGeometry(0.03, 0.035, 1.8, 6).rotateX(Math.PI / 2)), M(0x7a5232), 0, 0, 0.35));
    g.add(mesh(geo('staffGem', () => new THREE.IcosahedronGeometry(0.07, 0)), M(0x3fb6c9, { emissive: 0x0b3a44 }), 0, 0, 1.28));
  }
  g.rotation.x = kind === 'staff' ? -1.45 : 0.64; // angle the tool forward-down from the fist
  return g;
}
function makeBow() {
  const g = new THREE.Group();
  const pts = [];
  for (let i = 0; i <= 6; i++) {
    const a = -Math.PI / 2 + (i / 6) * Math.PI;
    pts.push([-Math.cos(a) * 0.16, Math.sin(a) * 0.55]); // (y, z): bulges forward (-y = away from the fist)
  }
  for (let i = 0; i < 6; i++) {
    const [y1, z1] = pts[i];
    const [y2, z2] = pts[i + 1];
    const seg = mesh(geo('bowSeg', () => new THREE.BoxGeometry(0.03, 0.2, 0.03)), M(0x6a4423), 0, (y1 + y2) / 2, (z1 + z2) / 2, false);
    seg.rotation.x = Math.atan2(z2 - z1, y2 - y1);
    g.add(seg);
  }
  g.add(mesh(geo('bowString', () => new THREE.BoxGeometry(0.008, 0.008, 1.1)), M(0xe8e0c8), 0, 0, 0, false));
  return g;
}
function makeShield() {
  const g = new THREE.Group();
  g.add(mesh(geo('shield', () => new THREE.CylinderGeometry(0.3, 0.3, 0.05, 10).rotateZ(Math.PI / 2)), M(COL.bronze, { emissive: 0x1e0e02 }), 0.1, -0.12, 0.02));
  g.add(mesh(geo('shieldRim', () => new THREE.CylinderGeometry(0.32, 0.32, 0.03, 10).rotateZ(Math.PI / 2)), M(0x8a5a22), 0.085, -0.12, 0.02));
  g.add(mesh(geo('shieldBoss', () => new THREE.SphereGeometry(0.07, 6, 4)), M(COL.gold), 0.14, -0.12, 0.02));
  return g;
}

const HUMAN_STYLES = {
  player: { skin: COL.skin, shirt: COL.shirt, shirtDark: COL.shirtDark, pants: COL.pants, boot: COL.boot, hair: COL.hair, pack: true, beard: 0x5e3a22, detail: true, armor: true },
  swordsman: { skin: 0xb98560, shirt: 0x7a2a22, shirtDark: 0x4a1812, pants: 0x3b3026, boot: 0x2a1f16, hair: 0x1a1410, wrap: 0x2b2b2b, mask: 0x2b2b2b },
  archer: { skin: 0xb98560, shirt: 0x6a5634, shirtDark: 0x4a3c22, pants: 0x3b3026, boot: 0x2a1f16, hair: 0x1a1410, wrap: 0x7a2a22, mask: 0x7a2a22, quiver: true },
  king: { skin: 0xa8754f, shirt: 0x4a1a5a, shirtDark: COL.gold, pants: 0x2a1a22, boot: 0x1a1210, hair: 0x101010, crown: true, cape: 0x7a1a1a, beard: 0x101010, scale: 1.3 },
  merchant: { skin: 0xc58e66, shirt: 0x2f6e8a, shirtDark: 0x1f4e62, pants: 0xd8c9a8, boot: 0x5a4030, hair: 0x2a1a10, wrap: 0xc9a24a, beard: 0x2a1a10, detail: true },
  chief: { skin: 0xb07c55, shirt: 0xeae2cc, shirtDark: 0x8a2a2a, pants: 0xcfc2a2, boot: 0x5a4030, hair: 0xdedede, wrap: 0x8a2a2a, beard: 0xe8e8e8, detail: true },
  villager0: { skin: 0xc08a60, shirt: 0xd8c9a8, shirtDark: 0xa89878, pants: 0xb8a888, boot: 0x5a4030, hair: 0x2a1a10, wrap: 0xeeeeee },
  villager1: { skin: 0xa87650, shirt: 0xb85a3a, shirtDark: 0x8a3a22, pants: 0xc8b898, boot: 0x5a4030, hair: 0x1a1008, wrap: 0xd8c9a8 },
  villager2: { skin: 0xd09a70, shirt: 0x6a8a5a, shirtDark: 0x4a6a3a, pants: 0xd8c9a8, boot: 0x5a4030, hair: 0x3a2214 },
  skeleton: { skin: 0xe6dcc0, shirt: 0xd4caae, shirtDark: 0x9a8e70, pants: 0x4a3e30, boot: 0x2e261c, hair: 0xe6dcc0, eyes: 0xff4a2a, stripes: 0x5a5040 },
  mummy: { skin: 0xcbbd96, shirt: 0xd6c9a2, shirtDark: COL.gold, pants: 0xc4b68e, boot: 0x9a8a62, hair: 0x1f3f7a, wrap: 0x1f3f7a, cape: 0x1f3f7a, eyes: 0x6aff8a, stripes: 0xa89a74, scale: 1.35 },
};

function makeHuman(styleName, toolKinds = []) {
  const S = HUMAN_STYLES[styleName];
  const root = new THREE.Group();
  const hips = new THREE.Group();
  hips.position.y = 0.92;
  root.add(hips);
  hips.add(mesh(geo('pelvis', () => new THREE.BoxGeometry(0.36, 0.2, 0.23)), M(S.pants), 0, 0.02, 0));
  hips.add(mesh(geo('belt', () => new THREE.BoxGeometry(0.37, 0.05, 0.24)), M(0x3a2a1a), 0, 0.11, 0));

  const torso = new THREE.Group();
  torso.position.y = 0.1;
  hips.add(torso);
  torso.add(mesh(geo('chest', () => new THREE.BoxGeometry(0.44, 0.56, 0.26)), M(S.shirt), 0, 0.3, 0));
  torso.add(mesh(geo('collar', () => new THREE.BoxGeometry(0.3, 0.06, 0.27)), M(S.shirtDark), 0, 0.56, 0));
  if (S.pack) {
    torso.add(mesh(geo('pack', () => new THREE.BoxGeometry(0.34, 0.42, 0.16)), M(COL.pack), 0, 0.3, -0.2));
    torso.add(mesh(geo('packFlap', () => new THREE.BoxGeometry(0.35, 0.12, 0.17)), M(COL.packDark), 0, 0.46, -0.2));
    torso.add(mesh(geo('bedroll', () => new THREE.CylinderGeometry(0.085, 0.085, 0.46, 7).rotateZ(Math.PI / 2)), M(COL.bedroll), 0, 0.6, -0.22));
    torso.add(mesh(geo('strap', () => new THREE.BoxGeometry(0.05, 0.5, 0.02)), M(COL.packDark), 0.13, 0.32, 0.135));
    torso.add(mesh(geo('strap', () => new THREE.BoxGeometry(0.05, 0.5, 0.02)), M(COL.packDark), -0.13, 0.32, 0.135));
  }
  if (S.quiver) {
    const q = mesh(geo('quiver', () => new THREE.CylinderGeometry(0.07, 0.06, 0.5, 6)), M(0x5a3a22), 0.1, 0.38, -0.18);
    q.rotation.z = 0.4;
    torso.add(q);
  }
  if (S.cape) {
    const cape = mesh(geo('cape', () => new THREE.BoxGeometry(0.5, 0.95, 0.04).translate(0, -0.45, 0)), M(S.cape), 0, 0.58, -0.16);
    cape.rotation.x = 0.12;
    torso.add(cape);
  }
  torso.add(mesh(geo('neck', () => new THREE.CylinderGeometry(0.06, 0.07, 0.1, 6)), M(S.skin), 0, 0.62, 0));

  const head = new THREE.Group();
  head.position.y = 0.66;
  torso.add(head);
  head.add(mesh(geo('head', () => new THREE.BoxGeometry(0.27, 0.3, 0.27)), M(S.skin), 0, 0.15, 0));
  if (S.wrap) {
    head.add(mesh(geo('wrap', () => new THREE.BoxGeometry(0.3, 0.14, 0.3)), M(S.wrap), 0, 0.29, -0.005));
    head.add(mesh(geo('wrapBack', () => new THREE.BoxGeometry(0.3, 0.22, 0.06)), M(S.wrap), 0, 0.17, -0.13));
  } else {
    head.add(mesh(geo('hairTop', () => new THREE.BoxGeometry(0.29, 0.09, 0.29)), M(S.hair), 0, 0.31, -0.005));
    head.add(mesh(geo('hairBack', () => new THREE.BoxGeometry(0.29, 0.2, 0.07)), M(S.hair), 0, 0.21, -0.12));
  }
  if (S.mask) head.add(mesh(geo('mask', () => new THREE.BoxGeometry(0.28, 0.12, 0.05)), M(S.mask), 0, 0.07, 0.125, false));
  if (S.crown) {
    head.add(mesh(geo('crownBand', () => new THREE.CylinderGeometry(0.17, 0.17, 0.08, 8)), M(COL.gold, { emissive: 0x3a2800 }), 0, 0.33, 0));
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      head.add(mesh(geo('crownSpike', () => new THREE.ConeGeometry(0.03, 0.1, 4)), M(COL.gold), Math.sin(a) * 0.15, 0.41, Math.cos(a) * 0.15, false));
    }
  }
  const eyeM = S.eyes ? M(S.eyes, { emissive: S.eyes }) : M(0x1d1d1f);
  head.add(mesh(geo('eye', () => new THREE.BoxGeometry(0.04, 0.045, 0.02)), eyeM, 0.065, 0.17, 0.137, false));
  head.add(mesh(geo('eye', () => new THREE.BoxGeometry(0.04, 0.045, 0.02)), eyeM, -0.065, 0.17, 0.137, false));
  // ribs on a skeleton, bandage wraps on a mummy
  if (S.stripes) for (let i = 0; i < 4; i++) torso.add(mesh(geo('stripe', () => new THREE.BoxGeometry(0.4, 0.035, 0.02)), M(S.stripes), 0, 0.14 + i * 0.11, 0.135, false));
  if (S.detail) {
    if (!S.wrap) head.add(mesh(geo('hairFringe', () => new THREE.BoxGeometry(0.2, 0.05, 0.05)), M(S.hair), -0.04, 0.26, 0.13));
    head.add(mesh(geo('ear', () => new THREE.BoxGeometry(0.04, 0.07, 0.05)), M(S.skin), 0.145, 0.15, 0));
    head.add(mesh(geo('ear', () => new THREE.BoxGeometry(0.04, 0.07, 0.05)), M(S.skin), -0.145, 0.15, 0));
    head.add(mesh(geo('brow', () => new THREE.BoxGeometry(0.06, 0.015, 0.02)), M(S.hair), 0.065, 0.215, 0.138, false));
    head.add(mesh(geo('brow', () => new THREE.BoxGeometry(0.06, 0.015, 0.02)), M(S.hair), -0.065, 0.215, 0.138, false));
    head.add(mesh(geo('nose', () => new THREE.BoxGeometry(0.045, 0.06, 0.04)), M(0xd09670), 0, 0.12, 0.15, false));
  }
  if (S.beard) {
    const long = styleName === 'chief';
    head.add(mesh(geo(long ? 'beardLong' : 'beard', () => new THREE.BoxGeometry(0.26, long ? 0.2 : 0.07, 0.04)), M(S.beard), 0, long ? -0.01 : 0.035, 0.125, false));
  }

  const arm = (side) => {
    const sh = new THREE.Group();
    sh.position.set(0.29 * side, 0.52, 0);
    torso.add(sh);
    sh.add(mesh(geo('upperArm', () => new THREE.BoxGeometry(0.13, 0.33, 0.14)), M(S.shirt), 0, -0.15, 0));
    const el = new THREE.Group();
    el.position.y = -0.31;
    sh.add(el);
    el.add(mesh(geo('cuff', () => new THREE.BoxGeometry(0.135, 0.05, 0.145)), M(S.shirtDark), 0, 0.0, 0));
    el.add(mesh(geo('forearm', () => new THREE.BoxGeometry(0.105, 0.27, 0.115)), M(S.skin), 0, -0.14, 0));
    const hand = new THREE.Group();
    hand.position.y = -0.3;
    el.add(hand);
    hand.add(mesh(geo('hand', () => new THREE.BoxGeometry(0.1, 0.11, 0.11)), M(S.skin), 0, -0.02, 0));
    return { sh, el, hand };
  };
  const leg = (side) => {
    const hp = new THREE.Group();
    hp.position.set(0.105 * side, 0, 0);
    hips.add(hp);
    hp.add(mesh(geo('thigh', () => new THREE.BoxGeometry(0.155, 0.46, 0.17)), M(S.pants), 0, -0.23, 0));
    const kn = new THREE.Group();
    kn.position.y = -0.46;
    hp.add(kn);
    kn.add(mesh(geo('shin', () => new THREE.BoxGeometry(0.135, 0.38, 0.15)), M(S.pants), 0, -0.19, 0));
    kn.add(mesh(geo('bootTop', () => new THREE.BoxGeometry(0.15, 0.1, 0.16)), M(S.boot), 0, -0.36, 0));
    kn.add(mesh(geo('foot', () => new THREE.BoxGeometry(0.15, 0.09, 0.27)), M(S.boot), 0, -0.42, 0.05));
    return { hp, kn };
  };
  const L = arm(1);
  const R = arm(-1);
  const LL = leg(1);
  const RL = leg(-1);
  const tools = {};
  for (const k of toolKinds) {
    if (k === 'bow') {
      tools.bow = makeBow();
      L.hand.add(tools.bow);
    } else if (k === 'shield') {
      tools.shield = makeShield();
      L.el.add(tools.shield);
    } else {
      tools[k] = makeTool(k);
      R.hand.add(tools[k]);
    }
    tools[k].visible = false;
  }
  // bronze armor pieces, hidden until the player owns them
  const armor = { helmet: [], platebody: [], platelegs: [] };
  if (S.armor) {
    const BZ = M(COL.bronze, { emissive: 0x1e0e02 });
    const add = (part, list, x, y, z, key, make) => {
      const m = mesh(geo(key, make), BZ, x, y, z);
      m.visible = false;
      part.add(m);
      list.push(m);
    };
    add(head, armor.helmet, 0, 0.28, -0.005, 'helm', () => new THREE.BoxGeometry(0.31, 0.15, 0.31));
    add(head, armor.helmet, 0, 0.37, -0.02, 'helmCrest', () => new THREE.BoxGeometry(0.05, 0.08, 0.3));
    add(head, armor.helmet, 0, 0.17, 0.146, 'helmNose', () => new THREE.BoxGeometry(0.04, 0.13, 0.02));
    add(head, armor.helmet, 0.15, 0.19, 0.01, 'helmCheek', () => new THREE.BoxGeometry(0.03, 0.14, 0.22));
    add(head, armor.helmet, -0.15, 0.19, 0.01, 'helmCheek', () => new THREE.BoxGeometry(0.03, 0.14, 0.22));
    add(torso, armor.platebody, 0, 0.34, 0.01, 'plate', () => new THREE.BoxGeometry(0.47, 0.44, 0.29));
    add(torso, armor.platebody, 0, 0.13, 0.005, 'plateSkirt', () => new THREE.BoxGeometry(0.46, 0.08, 0.28));
    [L.sh, R.sh].forEach((sh) => add(sh, armor.platebody, 0, -0.02, 0, 'pauldron', () => new THREE.BoxGeometry(0.17, 0.12, 0.18)));
    [LL, RL].forEach((lg) => {
      add(lg.hp, armor.platelegs, 0, -0.21, 0.005, 'cuisse', () => new THREE.BoxGeometry(0.175, 0.34, 0.19));
      add(lg.kn, armor.platelegs, 0, -0.16, 0.01, 'greave', () => new THREE.BoxGeometry(0.155, 0.27, 0.17));
    });
  }
  if (S.scale) root.scale.setScalar(S.scale);
  return { root, hips, torso, head, shL: L.sh, shR: R.sh, elL: L.el, elR: R.el, hipL: LL.hp, hipR: RL.hp, knL: LL.kn, knR: RL.kn, tools, armor, pose: {} };
}

function makeRat(opts = {}) {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const base = opts.fur || 0x7d7670;
  const fur = new THREE.MeshLambertMaterial({ color: base });
  if (opts.scale) root.scale.setScalar(opts.scale);
  body.add(mesh(geo('ratBody', () => new THREE.SphereGeometry(0.2, 7, 5).scale(1, 0.78, 1.7)), fur, 0, 0.2, 0));
  body.add(mesh(geo('ratHead', () => new THREE.ConeGeometry(0.13, 0.32, 6).rotateX(Math.PI / 2)), fur, 0, 0.21, 0.42));
  body.add(mesh(geo('ratNose', () => new THREE.SphereGeometry(0.03, 5, 4)), M(0xe8a0a0), 0, 0.2, 0.58, false));
  body.add(mesh(geo('ratEar', () => new THREE.CylinderGeometry(0.065, 0.065, 0.02, 7).rotateX(Math.PI / 2)), M(0xe9a6a6), 0.09, 0.33, 0.33, false));
  body.add(mesh(geo('ratEar', () => new THREE.CylinderGeometry(0.065, 0.065, 0.02, 7).rotateX(Math.PI / 2)), M(0xe9a6a6), -0.09, 0.33, 0.33, false));
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0x111111 });
  body.add(mesh(geo('ratEye', () => new THREE.SphereGeometry(0.022, 5, 4)), eyeMat, 0.065, 0.27, 0.45, false));
  body.add(mesh(geo('ratEye', () => new THREE.SphereGeometry(0.022, 5, 4)), eyeMat, -0.065, 0.27, 0.45, false));
  const tail = [];
  let parent = body;
  let pos = [0, 0.17, -0.32];
  for (let i = 0; i < 5; i++) {
    const seg = new THREE.Group();
    seg.position.set(...pos);
    parent.add(seg);
    seg.add(mesh(geo('tailSeg' + i, () => new THREE.CylinderGeometry(0.022 - i * 0.003, 0.026 - i * 0.003, 0.14, 4).rotateX(Math.PI / 2)), M(0xd8a2a0), 0, 0, -0.07, false));
    tail.push(seg);
    parent = seg;
    pos = [0, 0, -0.14];
  }
  const legs = [];
  [[0.12, 0.2], [-0.12, 0.2], [0.12, -0.2], [-0.12, -0.2]].forEach(([x, z]) => {
    const l = new THREE.Group();
    l.position.set(x, 0.12, z);
    l.add(mesh(geo('ratLeg', () => new THREE.BoxGeometry(0.05, 0.12, 0.06)), M(0x5a5450), 0, -0.06, 0, false));
    body.add(l);
    legs.push(l);
  });
  return { kind: 'rat', root, body, tail, legs, skin: fur, base, eyeMat };
}

function makeScorpion(opts = {}) {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const base = opts.shell || 0x8a5a2a;
  const shell = new THREE.MeshLambertMaterial({ color: base });
  if (opts.scale) root.scale.setScalar(opts.scale);
  body.add(mesh(geo('scBody', () => new THREE.SphereGeometry(0.26, 7, 5).scale(1, 0.45, 1.4)), shell, 0, 0.2, 0));
  body.add(mesh(geo('scHead', () => new THREE.BoxGeometry(0.28, 0.12, 0.2)), shell, 0, 0.2, 0.38));
  const claws = [];
  [1, -1].forEach((s) => {
    const arm = new THREE.Group();
    arm.position.set(0.16 * s, 0.2, 0.42);
    arm.add(mesh(geo('scArm', () => new THREE.BoxGeometry(0.07, 0.07, 0.3).translate(0, 0, 0.15)), shell, 0, 0, 0, false));
    const pincer = mesh(geo('scPincer', () => new THREE.SphereGeometry(0.09, 5, 4).scale(0.8, 0.6, 1.4)), shell, 0, 0, 0.36, false);
    arm.add(pincer);
    arm.rotation.y = 0.35 * s;
    body.add(arm);
    claws.push(arm);
  });
  const legs = [];
  for (let i = 0; i < 4; i++) {
    [1, -1].forEach((s) => {
      const l = new THREE.Group();
      l.position.set(0.18 * s, 0.18, 0.2 - i * 0.14);
      l.add(mesh(geo('scLeg', () => new THREE.BoxGeometry(0.28, 0.03, 0.03).translate(0.14, -0.06, 0)), M(0x6a4420), 0, 0, 0, false));
      l.rotation.y = s > 0 ? -0.2 + i * 0.12 : Math.PI + 0.2 - i * 0.12;
      l.rotation.z = -0.4 * s;
      body.add(l);
      legs.push(l);
    });
  }
  // tail curls up and over the back, ending in a stinger
  const tail = [];
  let parent = body;
  let pos = [0, 0.24, -0.34];
  for (let i = 0; i < 5; i++) {
    const seg = new THREE.Group();
    seg.position.set(...pos);
    parent.add(seg);
    seg.add(mesh(geo('scTail', () => new THREE.SphereGeometry(0.075, 5, 4).scale(1, 1, 1.3)), shell, 0, 0, 0, false));
    tail.push(seg);
    parent = seg;
    pos = [0, 0.12, 0.02];
  }
  const sting = mesh(geo('scSting', () => new THREE.ConeGeometry(0.04, 0.16, 4).rotateX(Math.PI / 2)), opts.sting ? M(opts.sting, { emissive: opts.sting }) : M(0x2a1a0a), 0, 0.02, 0.1, false);
  tail[4].add(sting);
  return { kind: 'scorpion', root, body, tail, legs, claws, skin: shell, base };
}

function makeSnake() {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const skin = new THREE.MeshLambertMaterial({ color: 0xa8883a });
  const segs = [];
  for (let i = 0; i < 9; i++) {
    const r = 0.09 - Math.abs(i - 2) * 0.006;
    const s = mesh(geo('snSeg' + i, () => new THREE.SphereGeometry(Math.max(0.035, r), 6, 4).scale(1, 0.8, 1.6)), i % 2 ? skin : M(0x6a5424), 0, 0.08, -i * 0.2, false);
    body.add(s);
    segs.push(s);
  }
  const head = new THREE.Group();
  head.position.set(0, 0.1, 0.18);
  head.add(mesh(geo('snHead', () => new THREE.BoxGeometry(0.16, 0.08, 0.2)), skin, 0, 0, 0, false));
  head.add(mesh(geo('snEye', () => new THREE.SphereGeometry(0.02, 4, 3)), M(0xffd23a, { emissive: 0x3a2a00 }), 0.06, 0.04, 0.05, false));
  head.add(mesh(geo('snEye', () => new THREE.SphereGeometry(0.02, 4, 3)), M(0xffd23a, { emissive: 0x3a2a00 }), -0.06, 0.04, 0.05, false));
  body.add(head);
  return { kind: 'snake', root, body, segs, head, skin, base: 0xa8883a };
}

function makeHare() {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const fur = new THREE.MeshLambertMaterial({ color: 0xc9a67a });
  body.add(mesh(geo('hrBody', () => new THREE.SphereGeometry(0.18, 6, 5).scale(1, 0.95, 1.4)), fur, 0, 0.2, 0));
  body.add(mesh(geo('hrHead', () => new THREE.SphereGeometry(0.11, 6, 5)), fur, 0, 0.32, 0.22));
  [1, -1].forEach((s) => {
    const ear = mesh(geo('hrEar', () => new THREE.BoxGeometry(0.04, 0.24, 0.07).translate(0, 0.12, 0)), fur, 0.05 * s, 0.4, 0.2, false);
    ear.rotation.z = -0.15 * s;
    body.add(ear);
  });
  body.add(mesh(geo('hrTail', () => new THREE.SphereGeometry(0.06, 5, 4)), M(0xf2ead8), 0, 0.24, -0.26, false));
  return { kind: 'hare', root, body, skin: fur, base: 0xc9a67a };
}

function makeEnemyRig(type) {
  if (type === 'rat') return makeRat();
  if (type === 'scorpion') return makeScorpion();
  if (type === 'snake') return makeSnake();
  if (type === 'hare') return makeHare();
  if (type === 'caveRat') return makeRat({ fur: 0x4a4440, scale: 1.35 });
  if (type === 'caveScorpion') return makeScorpion({ shell: 0x3a2c24, sting: 0x6aff8a, scale: 1.3 });
  const tool = type === 'archer' ? 'bow' : type === 'king' ? 'greatsword' : type === 'mummy' ? 'staff' : 'scimitar';
  const rig = makeHuman(type, [tool]);
  rig.kind = 'human';
  rig.mainTool = tool;
  rig.tools[tool].visible = true;
  return rig;
}

function makeTree(n) {
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);
  if (n.variant === 'palm') {
    let x = 0;
    let y = 0;
    for (let i = 0; i < 3; i++) {
      const seg = mesh(geo('palmSeg' + i, () => new THREE.CylinderGeometry(0.15 - i * 0.025, 0.2 - i * 0.025, 1.6, 6).translate(0, 0.8, 0)), M(i % 2 ? 0x8a6a42 : 0x7a5a36), x, y, 0);
      seg.rotation.z = -0.12 - i * 0.1;
      body.add(seg);
      x += Math.sin(0.12 + i * 0.1) * 1.6;
      y += Math.cos(0.12 + i * 0.1) * 1.6;
    }
    const crown = new THREE.Group();
    crown.position.set(x, y, 0);
    for (let k = 0; k < 7; k++) {
      const fr = new THREE.Group();
      fr.rotation.y = (k / 7) * Math.PI * 2;
      const leaf = mesh(geo('frond', () => new THREE.BoxGeometry(1.9, 0.04, 0.42).translate(0.95, 0, 0)), M(k % 2 ? 0x3f8a3a : 0x52a046), 0, 0, 0);
      leaf.rotation.z = -0.45;
      fr.add(leaf);
      crown.add(fr);
    }
    crown.add(mesh(geo('coconuts', () => new THREE.IcosahedronGeometry(0.2, 0)), M(0x6a4a22), 0.1, -0.15, 0));
    body.add(crown);
  } else {
    const trunkH = n.variant === 'pine' ? 2.3 : 2.6;
    body.add(mesh(geo('trunk' + n.variant, () => new THREE.CylinderGeometry(0.17, 0.3, trunkH, 7).translate(0, trunkH / 2, 0)), M(COL.bark), 0, 0, 0));
    if (n.variant === 'pine') {
      [0x2c6638, 0x33743f, 0x3c8447].forEach((c, i) => {
        const cone = mesh(geo('pineCone' + i, () => new THREE.ConeGeometry(1.55 - i * 0.37, 1.9, 7)), M(c), 0, trunkH - 0.2 + i * 1.05, 0);
        cone.rotation.y = i * 0.7;
        body.add(cone);
      });
    } else {
      [[0, 0.75, 0, 1.2, 0x3d7f35], [0.75, 0.25, 0.3, 0.88, 0x2f6b2e], [-0.65, 0.35, -0.25, 0.92, 0x4a9440], [0.1, 1.4, -0.2, 0.78, 0x56a24a]].forEach(
        ([x, y, z, r, c], i) => body.add(mesh(geo('blob' + i, () => new THREE.IcosahedronGeometry(r, 0)), M(c), x, trunkH + y, z)),
      );
    }
  }
  const stump = new THREE.Group();
  const bark = n.variant === 'palm' ? 0x7a5a36 : COL.bark;
  stump.add(mesh(geo('stump', () => new THREE.CylinderGeometry(0.26, 0.3, 0.36, 7).translate(0, 0.18, 0)), M(bark)));
  stump.add(mesh(geo('stumpTop', () => new THREE.CylinderGeometry(0.255, 0.255, 0.02, 7)), M(COL.cut), 0, 0.37, 0, false));
  stump.visible = false;
  group.add(stump);
  group.scale.setScalar(n.scale);
  group.rotation.y = n.rot;
  return { group, body, stump };
}

function makeOre(type) {
  const g = new THREE.Group();
  const base = { copper: 0x8c7a66, tin: 0x86888c, limestone: 0xe4dcc6, outcrop: 0x9a8f80 }[type];
  const vein = { copper: 0xd2702e, tin: 0xd8dde6, limestone: 0xf6f0e0, outcrop: 0x7a7066 }[type];
  const full = new THREE.Group();
  full.add(mesh(geo('oreA', () => new THREE.DodecahedronGeometry(0.55, 0).scale(1.1, 0.7, 1)), M(base), 0, 0.3, 0));
  full.add(mesh(geo('oreB', () => new THREE.DodecahedronGeometry(0.35, 0)), M(base), 0.45, 0.2, 0.2));
  full.add(mesh(geo('oreC', () => new THREE.DodecahedronGeometry(0.28, 0)), M(base), -0.4, 0.15, -0.25));
  if (type !== 'outcrop') {
    [[0.25, 0.55, 0.3], [-0.2, 0.45, 0.35], [0.5, 0.35, 0.35], [-0.1, 0.62, -0.1], [0.3, 0.3, -0.35]].forEach(([x, y, z]) =>
      full.add(mesh(geo('vein', () => new THREE.OctahedronGeometry(0.09, 0)), M(vein, { emissive: type === 'copper' ? 0x2a1000 : 0x101010 }), x, y, z, false)),
    );
  }
  const rubble = new THREE.Group();
  [[0.2, 0.1, 0.1], [-0.2, 0.08, -0.1], [0.05, 0.08, -0.25]].forEach(([x, y, z]) => rubble.add(mesh(geo('rubble', () => new THREE.DodecahedronGeometry(0.14, 0)), M(base), x, y, z, false)));
  g.add(full, rubble);
  g.userData.full = full;
  g.userData.rubble = rubble;
  return g;
}

function makeNode(n) {
  const g = new THREE.Group();
  switch (n.type) {
    case 'stick': {
      g.add(mesh(geo('stick', () => new THREE.CylinderGeometry(0.035, 0.045, 0.95, 5).rotateZ(Math.PI / 2)), M(COL.wood), 0, 0.05, 0));
      const twig = mesh(geo('twig', () => new THREE.CylinderGeometry(0.018, 0.022, 0.3, 4)), M(COL.wood), 0.15, 0.08, 0.08);
      twig.rotation.set(1.2, 0, 0.6);
      g.add(twig);
      break;
    }
    case 'stone':
      g.add(mesh(geo('stone', () => new THREE.DodecahedronGeometry(0.2, 0).scale(1, 0.65, 1)), M(COL.stone), 0, 0.1, 0));
      g.add(mesh(geo('pebble', () => new THREE.DodecahedronGeometry(0.09, 0)), M(COL.stoneDark), 0.22, 0.05, 0.1));
      break;
    case 'grass':
    case 'reeds': {
      const reeds = n.type === 'reeds';
      const tall = new THREE.Group();
      for (let i = 0; i < 9; i++) {
        const b = mesh(geo(reeds ? 'reed' : 'blade', () => new THREE.ConeGeometry(0.045, reeds ? 1.3 : 0.85, 3).translate(0, reeds ? 0.65 : 0.42, 0)), M(i % 2 ? (reeds ? 0x7fa84a : 0xb9c96a) : reeds ? 0x5f8a3a : 0x93b450), Math.cos(i * 2.4) * 0.14, 0, Math.sin(i * 2.4) * 0.14, false);
        b.rotation.set(Math.sin(i * 1.7) * 0.3, 0, Math.cos(i * 1.3) * 0.3);
        tall.add(b);
      }
      if (reeds) for (let i = 0; i < 3; i++) tall.add(mesh(geo('cattail', () => new THREE.CylinderGeometry(0.035, 0.035, 0.18, 5)), M(0x6a4422), Math.cos(i * 2.1) * 0.12, 1.25, Math.sin(i * 2.1) * 0.12, false));
      const stub = new THREE.Group();
      for (let i = 0; i < 6; i++) stub.add(mesh(geo('stubble', () => new THREE.ConeGeometry(0.03, 0.14, 3).translate(0, 0.07, 0)), M(0x9a8a4a), Math.cos(i) * 0.12, 0, Math.sin(i) * 0.12, false));
      g.add(tall, stub);
      g.userData.tall = tall;
      g.userData.stub = stub;
      break;
    }
    case 'bush': {
      [[0, 0.45, 0, 0.55, 0x3f7d36], [0.42, 0.32, 0.1, 0.4, 0x468a3c], [-0.38, 0.3, -0.12, 0.42, 0x4e9441]].forEach(([x, y, z, r, c], i) =>
        g.add(mesh(geo('bushBlob' + i, () => new THREE.IcosahedronGeometry(r, 0)), M(c), x, y, z)),
      );
      const berries = [];
      [[0.25, 0.7, 0.3], [-0.2, 0.6, 0.35], [0.5, 0.45, 0.25], [-0.45, 0.4, 0.2], [0.05, 0.85, 0.15], [0.3, 0.3, 0.42]].forEach(([x, y, z]) => {
        const b = mesh(geo('berry', () => new THREE.SphereGeometry(0.065, 5, 4)), M(0xd7263d, { emissive: 0x3a0008 }), x, y, z, false);
        g.add(b);
        berries.push(b);
      });
      g.userData.berries = berries;
      break;
    }
    case 'deadbush':
      for (let i = 0; i < 7; i++) {
        const b = mesh(geo('twigBush', () => new THREE.CylinderGeometry(0.015, 0.03, 0.8, 3).translate(0, 0.4, 0)), M(0x7a5a3a), 0, 0, 0, false);
        b.rotation.set(Math.sin(i * 2.3) * 0.7, i, Math.cos(i * 1.7) * 0.7);
        g.add(b);
      }
      break;
    case 'mushroom':
      g.add(mesh(geo('mStem', () => new THREE.CylinderGeometry(0.05, 0.06, 0.22, 6).translate(0, 0.11, 0)), M(0xf2e8d4)));
      g.add(mesh(geo('mCap', () => new THREE.SphereGeometry(0.16, 7, 4, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.7, 1)), M(0xc8402e), 0, 0.2, 0));
      g.add(mesh(geo('mDot', () => new THREE.SphereGeometry(0.025, 4, 3)), M(0xffffff), 0.07, 0.29, 0.04, false));
      g.add(mesh(geo('mDot', () => new THREE.SphereGeometry(0.025, 4, 3)), M(0xffffff), -0.05, 0.3, -0.06, false));
      break;
    case 'drop':
      if (n.item === 'goldenKey') {
        const key = new THREE.Group();
        const gold = M(COL.gold, { emissive: 0x6a4a00 });
        key.add(mesh(geo('keyBow', () => new THREE.TorusGeometry(0.12, 0.035, 5, 10)), gold, 0, 0, -0.22, false));
        key.add(mesh(geo('keyShaft', () => new THREE.BoxGeometry(0.04, 0.04, 0.42)), gold, 0, 0, 0.05, false));
        key.add(mesh(geo('keyBit', () => new THREE.BoxGeometry(0.04, 0.12, 0.08)), gold, 0, -0.06, 0.2, false));
        key.position.y = 0.45;
        g.add(key);
        g.add(mesh(geo('keyGlow', () => new THREE.CylinderGeometry(0.5, 0.5, 0.02, 12)), new THREE.MeshBasicMaterial({ color: 0xffd23a, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }), 0, 0.02, 0, false));
        g.userData.update = (nn, t) => {
          key.rotation.y = t * 2;
          key.position.y = 0.45 + Math.sin(t * 3) * 0.08;
        };
      } else if (n.item === 'leather') {
        const hide = mesh(geo('hide', () => new THREE.BoxGeometry(0.5, 0.03, 0.4)), M(0x8a5a32), 0, 0.03, 0);
        hide.rotation.y = 0.4;
        g.add(hide);
      } else {
        g.add(mesh(geo('meat', () => new THREE.SphereGeometry(0.15, 6, 5).scale(1.3, 0.8, 1)), M(0xc85a60), 0, 0.12, 0));
        g.add(mesh(geo('bone', () => new THREE.CylinderGeometry(0.03, 0.03, 0.3, 5).rotateZ(Math.PI / 2)), M(0xf2eee4), 0.25, 0.12, 0));
      }
      break;
    case 'trail': {
      g.add(mesh(geo('post', () => new THREE.CylinderGeometry(0.07, 0.08, 2.0, 6).translate(0, 1.0, 0)), M(COL.bark)));
      const sign = mesh(geo('sign', () => new THREE.BoxGeometry(0.06, 0.32, 1.1)), M(0xb88a52), 0, 1.6, 0.25);
      g.add(sign);
      g.add(mesh(geo('signTip', () => new THREE.ConeGeometry(0.2, 0.3, 3).rotateX(Math.PI / 2)), M(0xb88a52), 0, 1.6, 0.9));
      for (let i = 0; i < 6; i++) g.add(mesh(geo('pathStone', () => new THREE.CylinderGeometry(0.3, 0.32, 0.06, 6)), M(0x9a8a6a), (i % 2) * 0.4 - 0.2, 0.03, 1.5 + i * 1.1, false));
      break;
    }
    case 'cavemouth': {
      // a rock mass at the foot of the cliff with a dark opening facing out (+z)
      const rock = M(0xa8653f);
      const rock2 = M(0x8f5636);
      const blob = (key, x, y, z, sx, sy, sz, mat, rx = 0) => {
        const m = mesh(geo(key, () => new THREE.DodecahedronGeometry(1, 0)), mat, x, y, z);
        m.scale.set(sx, sy, sz);
        m.rotation.set(rx, rx * 2, 0);
        g.add(m);
      };
      blob('cmA', 0, 2.4, -4.6, 6.2, 5.2, 4.4, rock);
      blob('cmA', -3.8, 1.8, -1.2, 2.0, 3.0, 2.2, rock2, 0.4);
      blob('cmA', 3.8, 1.6, -1.2, 2.0, 2.8, 2.2, rock2, 1.1);
      blob('cmA', 0, 4.6, -1.6, 4.0, 1.4, 2.0, rock, 0.2);
      blob('cmA', 6.5, 1.2, -3.4, 2.4, 2.4, 2.4, rock2, 2.0);
      blob('cmA', -6.2, 1.4, -3.2, 2.6, 2.8, 2.2, rock, 0.8);
      const dark = new THREE.MeshBasicMaterial({ color: 0x050302 });
      g.add(mesh(geo('cmHole', () => new THREE.BoxGeometry(3.8, 3.6, 3.0)), dark, 0, 1.8, -2.0, false));
      g.add(mesh(geo('cmFloor', () => new THREE.BoxGeometry(3.6, 0.1, 2.4)), M(0x6a4a30), 0, 0.03, -0.2, false));
      const bone = M(0xe6dcc0);
      [[1.6, 1.4, 0.4], [-1.2, 1.9, 2.2], [0.6, 2.4, 1.1]].forEach(([x, z, r]) => {
        const b = mesh(geo('cmBone', () => new THREE.CylinderGeometry(0.04, 0.04, 0.6, 5).rotateZ(Math.PI / 2)), bone, x, 0.06, z, false);
        b.rotation.y = r;
        g.add(b);
      });
      g.add(mesh(geo('cmSkull', () => new THREE.SphereGeometry(0.17, 7, 5).scale(1, 0.9, 1.15)), bone, 1.1, 0.15, 2.0, false));
      break;
    }
    case 'caveexit': {
      // daylight spilling down the passage from the desert above (+z here points back into the cave)
      const sand = M(0xc9a46b);
      for (let i = 0; i < 4; i++) g.add(mesh(geo('exStep', () => new THREE.BoxGeometry(3.4, 0.25, 0.7)), sand, 0, 0.12 + i * 0.25, -0.6 - i * 0.7));
      const beam = new THREE.Mesh(
        geo('exBeam', () => new THREE.CylinderGeometry(1.3, 2.8, 8, 12, 1, true)),
        new THREE.MeshBasicMaterial({ color: 0xffe6b0, transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
      );
      beam.position.set(0, 3.4, -1.6);
      beam.rotation.x = -0.4;
      g.add(beam);
      break;
    }
    case 'lever': {
      g.add(mesh(geo('lvBase', () => new THREE.BoxGeometry(0.7, 0.5, 0.5)), M(0x8a7a5a), 0, 0.25, 0));
      g.add(mesh(geo('lvSlot', () => new THREE.BoxGeometry(0.12, 0.04, 0.42)), M(0x1a140c), 0, 0.51, 0, false));
      const arm = new THREE.Group();
      arm.position.y = 0.5;
      arm.add(mesh(geo('lvStick', () => new THREE.CylinderGeometry(0.04, 0.05, 1.0, 6).translate(0, 0.5, 0)), M(0x5a4a3a)));
      const knob = mesh(geo('lvKnob', () => new THREE.SphereGeometry(0.1, 7, 5)), M(COL.gold, { emissive: 0x3a2800 }), 0, 1.0, 0);
      arm.add(knob);
      arm.rotation.x = n.pulled ? 0.75 : -0.75;
      g.add(arm);
      g.userData.update = (nn, t, dt) => {
        arm.rotation.x = lerp(arm.rotation.x, nn.pulled ? 0.75 : -0.75, 1 - Math.exp(-dt * 6));
      };
      break;
    }
    case 'chest': {
      const wood = M(0x6a4422);
      const band = M(COL.gold, { emissive: 0x2a1c00 });
      g.add(mesh(geo('chBody', () => new THREE.BoxGeometry(1.1, 0.6, 0.7)), wood, 0, 0.3, 0));
      [-0.4, 0.4].forEach((x) => g.add(mesh(geo('chBand', () => new THREE.BoxGeometry(0.08, 0.62, 0.72)), band, x, 0.31, 0)));
      const glow = mesh(geo('chGold', () => new THREE.BoxGeometry(0.9, 0.12, 0.5)), M(COL.gold, { emissive: 0x7a5a00 }), 0, 0.56, 0, false);
      glow.visible = !!n.opened;
      g.add(glow);
      const lid = new THREE.Group();
      lid.position.set(0, 0.6, -0.35);
      lid.add(mesh(geo('chLid', () => new THREE.BoxGeometry(1.12, 0.22, 0.72)), wood, 0, 0.11, 0.35));
      [-0.4, 0.4].forEach((x) => lid.add(mesh(geo('chLidBand', () => new THREE.BoxGeometry(0.08, 0.24, 0.74)), band, x, 0.11, 0.35, false)));
      lid.add(mesh(geo('chLock', () => new THREE.BoxGeometry(0.16, 0.18, 0.06)), band, 0, 0.0, 0.72, false));
      lid.rotation.x = n.opened ? -1.9 : 0;
      g.add(lid);
      g.userData.update = (nn, t, dt) => {
        lid.rotation.x = lerp(lid.rotation.x, nn.opened ? -1.9 : 0, 1 - Math.exp(-dt * 5));
        glow.visible = !!nn.opened;
      };
      break;
    }
    case 'stairs': {
      // steps spiral down into a dark stairwell (local -z), choked with rubble
      for (let i = 0; i < 5; i++) g.add(mesh(geo('stStep', () => new THREE.BoxGeometry(2.4, 0.3, 0.6)), M(i % 2 ? 0x7a6a4c : 0x6e5e42), 0, -0.15 - i * 0.32, -0.75 - i * 0.55));
      [[0, 0.1, -1.5, 0.7], [-0.7, 0, -1.1, 0.5], [0.8, 0.05, -1.9, 0.55], [0.2, 0.35, -2.1, 0.6], [-0.5, -0.1, -2.5, 0.5]].forEach(([x, y, z, r], i) => {
        const m = mesh(geo('rub' + i, () => new THREE.DodecahedronGeometry(r, 0)), M(0x7a6a58), x, y, z);
        m.rotation.set(i, i * 2, 0);
        g.add(m);
      });
      break;
    }
    default:
      if (MINEABLE[n.type]) return makeOre(n.type);
      break;
  }
  g.rotation.y = n.rot || 0;
  return g;
}

function makeShelter() {
  const g = new THREE.Group();
  const log = (len, r = 0.09) => geo('log' + len + r, () => new THREE.CylinderGeometry(r, r * 1.1, len, 6));
  [-1.25, 1.25].forEach((x) => {
    g.add(mesh(log(1.9), M(COL.bark), x, 0.95, 0.4));
    const fork = mesh(log(0.5, 0.05), M(COL.bark), x + 0.12 * Math.sign(x), 1.85, 0.4);
    fork.rotation.z = -0.5 * Math.sign(x);
    g.add(fork);
  });
  const ridge = mesh(log(3.0, 0.1), M(COL.barkDark), 0, 1.8, 0.4);
  ridge.rotation.z = Math.PI / 2;
  g.add(ridge);
  const slope = Math.atan2(1.8, 2.3);
  const rLen = Math.hypot(1.8, 2.3);
  [-1.2, -0.6, 0, 0.6, 1.2].forEach((x) => {
    const r = mesh(log(rLen, 0.07), M(COL.bark), x, 0.9, 0.4 - 1.15);
    r.rotation.x = Math.PI / 2 - slope;
    g.add(r);
  });
  const greens = [0x4c8a3a, 0x5d9c45, 0x3f7a32, 0x6aa84c];
  for (let row = 0; row < 6; row++) {
    for (let col = 0; col < 4; col++) {
      const t = (row + 0.5) / 6;
      const s = mesh(geo('thatch', () => new THREE.BoxGeometry(0.9, 0.16, 0.7)), M(greens[(row + col) % 4]), -1.08 + col * 0.72, 1.85 - t * 1.8 + 0.08, 0.4 - t * 2.3);
      s.rotation.x = -slope;
      s.rotation.z = Math.sin(row * 3 + col) * 0.06;
      g.add(s);
    }
  }
  g.add(mesh(geo('bed', () => new THREE.BoxGeometry(2.0, 0.08, 1.2)), M(0x7a8a3a), 0, 0.04, -0.75, false));
  return g;
}

function makeFire(withLight = true) {
  const g = new THREE.Group();
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2;
    const s = mesh(geo('ringStone', () => new THREE.DodecahedronGeometry(0.17, 0).scale(1, 0.7, 1)), M(i % 2 ? COL.stone : COL.stoneDark), Math.cos(a) * 0.6, 0.1, Math.sin(a) * 0.6);
    s.rotation.y = a * 3;
    g.add(s);
  }
  for (let i = 0; i < 3; i++) {
    const l = mesh(geo('fireLog', () => new THREE.CylinderGeometry(0.06, 0.07, 0.8, 6)), M(COL.barkDark), Math.cos(i * 2.1) * 0.15, 0.3, Math.sin(i * 2.1) * 0.15);
    l.rotation.set(Math.sin(i * 2.1) * 0.6, 0, -Math.cos(i * 2.1) * 0.6);
    g.add(l);
  }
  g.add(mesh(geo('ash', () => new THREE.CylinderGeometry(0.42, 0.45, 0.04, 9)), M(0x2a2622), 0, 0.02, 0, false));
  const flames = new THREE.Group();
  [[0xff5a00, 0.38, 1.1, 0.85], [0xffa21a, 0.27, 0.85, 0.9], [0xfff0a0, 0.15, 0.55, 0.95]].forEach(([c, r, h, o]) => {
    const f = new THREE.Mesh(
      new THREE.ConeGeometry(r, h, 7).translate(0, h / 2, 0),
      new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: o, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    f.position.y = 0.12;
    flames.add(f);
  });
  g.add(flames);
  let light = null;
  if (withLight) {
    light = new THREE.PointLight(0xff9a3c, 40, 22, 1.6);
    light.position.y = 1.1;
    g.add(light);
  }
  const N = 26;
  const pos = new Float32Array(N * 3);
  const life = new Float32Array(N);
  for (let i = 0; i < N; i++) life[i] = Math.random();
  const eg = new THREE.BufferGeometry();
  eg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const embers = new THREE.Points(eg, new THREE.PointsMaterial({ color: 0xffb347, size: 0.09, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  embers.frustumCulled = false;
  g.add(embers);
  return { g, flames, light, embers, life };
}
function animateFire(f, lit, fuel, t, d, dt) {
  f.flames.visible = lit;
  f.embers.visible = lit;
  const fl = 1 + 0.18 * Math.sin(t * 13) + 0.1 * Math.sin(t * 23.7) + 0.06 * Math.sin(t * 41);
  const size = 0.55 + 0.45 * clamp(fuel / 90, 0, 1);
  f.flames.scale.set(size * (1 + 0.05 * Math.sin(t * 17)), size * fl, size * (1 + 0.05 * Math.cos(t * 19)));
  f.flames.rotation.y += dt * 1.5;
  if (f.light) f.light.intensity = lit ? (18 + 30 * d) * size * fl * (LEGACY_THREE ? 0.3 : 1) : 0;
  const arr = f.embers.geometry.attributes.position.array;
  for (let i = 0; i < f.life.length; i++) {
    f.life[i] += dt * (0.5 + (i % 5) * 0.12);
    if (f.life[i] > 1) f.life[i] = 0;
    const L = f.life[i];
    arr[i * 3] = Math.sin(i * 7.3 + L * 4) * 0.25 * L;
    arr[i * 3 + 1] = 0.3 + L * 2.6;
    arr[i * 3 + 2] = Math.cos(i * 5.1 + L * 4) * 0.25 * L;
  }
  f.embers.geometry.attributes.position.needsUpdate = true;
}

const BLOCK_COLORS = [0xcdb48a, 0xc4a87c, 0xd6bf96, 0xbfa276];
function blockRow(g, x0, z0, along, len, rows, y0, skip) {
  // a wall of stacked blocks running along local x (along = 'x') or z
  const n = Math.round(len / 0.8);
  for (let r = 0; r < rows; r++) {
    for (let i = 0; i < n; i++) {
      if (skip && skip(i, r)) continue;
      const off = -len / 2 + 0.4 + i * 0.8 + (r % 2 ? 0.2 : 0);
      if (off > len / 2) continue;
      const b = mesh(geo('block', () => new THREE.BoxGeometry(0.76, 0.5, 0.46)), M(BLOCK_COLORS[(i * 3 + r * 7) % 4]), along === 'x' ? x0 + off : x0, y0 + 0.25 + r * 0.53, along === 'x' ? z0 : z0 + off);
      if (along === 'z') b.rotation.y = Math.PI / 2;
      g.add(b);
    }
  }
}
function makeHut() {
  const g = new THREE.Group();
  const H = 5;
  blockRow(g, 0, -2.0, 'x', 4.4, H, 0);
  blockRow(g, -2.0, 0, 'z', 3.6, H, 0);
  blockRow(g, 2.0, 0, 'z', 3.6, H, 0);
  blockRow(g, 0, 2.0, 'x', 4.4, H, 0, (i, r) => r < 4 && (i === 2 || i === 3)); // doorway
  const roof = new THREE.Group();
  roof.add(mesh(geo('hutRoof', () => new THREE.BoxGeometry(4.8, 0.25, 4.8)), M(0xb8a07a), 0, H * 0.53 + 0.12, 0));
  roof.add(mesh(geo('hutRim', () => new THREE.BoxGeometry(5.0, 0.18, 5.0)), M(0xa88f68), 0, H * 0.53 + 0.32, 0));
  g.add(roof);
  g.userData.roof = roof;
  g.add(mesh(geo('hutBed', () => new THREE.BoxGeometry(1.0, 0.12, 2.0)), M(0x9c3b2e), -0.9, 0.06, -0.7, false));
  return g;
}
function makeWall() {
  const g = new THREE.Group();
  blockRow(g, 0, 0, 'x', 2.4, 3, 0);
  return g;
}
function makeFurnace() {
  const g = new THREE.Group();
  blockRow(g, 0, -0.6, 'x', 1.9, 3, 0);
  blockRow(g, -0.75, 0.05, 'z', 1.0, 3, 0);
  blockRow(g, 0.75, 0.05, 'z', 1.0, 3, 0);
  blockRow(g, 0, 0.6, 'x', 1.9, 3, 0, (i, r) => r < 2 && i === 1); // fire mouth
  g.add(mesh(geo('fnTop', () => new THREE.BoxGeometry(2.0, 0.22, 1.7)), M(0xa88f68), 0, 1.68, 0));
  g.add(mesh(geo('fnChimney', () => new THREE.CylinderGeometry(0.26, 0.34, 1.3, 7).translate(0, 0.65, 0)), M(0x9a8460), 0.4, 1.78, -0.3));
  g.add(mesh(geo('fnInside', () => new THREE.BoxGeometry(1.0, 1.0, 0.9)), M(0x1a120c), 0, 0.5, 0.05, false));
  const glow = new THREE.Mesh(geo('fnGlow', () => new THREE.BoxGeometry(0.62, 0.7, 0.06)), new THREE.MeshBasicMaterial({ color: 0xff7a1a, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false }));
  glow.position.set(0, 0.45, 0.58);
  g.add(glow);
  const light = new THREE.PointLight(0xff8a3a, 0, 9, 1.6);
  light.position.set(0, 0.7, 1.0);
  g.add(light);
  g.userData.glow = glow;
  g.userData.light = light;
  return g;
}
function makeAnvil() {
  const g = new THREE.Group();
  g.add(mesh(geo('anBase', () => new THREE.BoxGeometry(0.62, 0.5, 0.52)), M(0xb8a07a), 0, 0.25, 0));
  g.add(mesh(geo('anWaist', () => new THREE.BoxGeometry(0.4, 0.2, 0.34)), M(0x6a6a70), 0, 0.6, 0));
  g.add(mesh(geo('anTop', () => new THREE.BoxGeometry(0.95, 0.2, 0.38)), M(0x55555c), 0, 0.8, 0));
  g.add(mesh(geo('anHorn', () => new THREE.ConeGeometry(0.15, 0.45, 6).rotateZ(-Math.PI / 2)), M(0x55555c), 0.68, 0.82, 0));
  g.add(mesh(geo('anBar', () => new THREE.BoxGeometry(0.3, 0.05, 0.1)), M(COL.bronze, { emissive: 0x2a1404 }), -0.15, 0.93, 0.05, false));
  return g;
}

function makeHouse(h) {
  const g = new THREE.Group();
  g.add(mesh(new THREE.BoxGeometry(h.w, h.h, h.d), M(COL.adobe), 0, h.h / 2, 0));
  g.add(mesh(new THREE.BoxGeometry(h.w + 0.2, 0.25, h.d + 0.2), M(COL.adobeDark), 0, h.h + 0.12, 0));
  g.add(mesh(geo('door', () => new THREE.BoxGeometry(0.9, 1.7, 0.08)), M(0x4a3020), 0, 0.85, h.d / 2 + 0.01, false));
  [-1, 1].forEach((s) => g.add(mesh(geo('window', () => new THREE.BoxGeometry(0.5, 0.45, 0.08)), M(0x2a2018), s * (h.w / 2 - 0.8), h.h * 0.6, h.d / 2 + 0.01, false)));
  for (let i = 0; i < 4; i++) {
    const beam = mesh(geo('viga', () => new THREE.CylinderGeometry(0.07, 0.07, 0.6, 5).rotateX(Math.PI / 2)), M(0x6a4a2a), -h.w / 2 + 0.6 + i * ((h.w - 1.2) / 3), h.h - 0.35, h.d / 2 + 0.25, false);
    g.add(beam);
  }
  if (h.chief) {
    const pole = mesh(geo('bannerPole', () => new THREE.CylinderGeometry(0.05, 0.05, 2.2, 5)), M(0x6a4a2a), h.w / 2 - 0.4, h.h + 1.1, h.d / 2 - 0.4);
    g.add(pole);
    g.add(mesh(geo('flag', () => new THREE.BoxGeometry(0.04, 0.6, 0.9)), M(0x2f7a9a), h.w / 2 - 0.4, h.h + 1.85, h.d / 2 + 0.05));
  }
  g.position.set(h.x, heightAt(h.x, h.z) - 0.05, h.z);
  g.rotation.y = h.rot;
  return g;
}
function makeStall(s) {
  const g = new THREE.Group();
  [[-1, -0.6], [1, -0.6], [-1, 0.6], [1, 0.6]].forEach(([x, z]) => g.add(mesh(geo('stallPost', () => new THREE.CylinderGeometry(0.05, 0.05, 2.3, 5).translate(0, 1.15, 0)), M(0x6a4a2a), x * 1.1, 0, z)));
  g.add(mesh(geo('counter', () => new THREE.BoxGeometry(2.2, 0.9, 0.6)), M(0x8a6a42), 0, 0.45, 0.3));
  for (let i = 0; i < 5; i++) {
    const stripe = mesh(geo('awning', () => new THREE.BoxGeometry(0.46, 0.04, 1.6)), M(i % 2 ? 0xeee6d2 : 0xc0392b), -0.92 + i * 0.46, 2.35, 0.1);
    stripe.rotation.x = 0.18;
    g.add(stripe);
  }
  [[-0.6, 0x3a7ab8], [0, 0xd07a3a], [0.6, 0xe0b23a]].forEach(([x, c]) => g.add(mesh(geo('goods', () => new THREE.BoxGeometry(0.3, 0.25, 0.3)), M(c), x, 1.02, 0.3, false)));
  g.position.set(s.x, heightAt(s.x, s.z), s.z);
  g.rotation.y = s.rot;
  return g;
}
function makeWell(wl) {
  const g = new THREE.Group();
  g.add(mesh(geo('wellRing', () => new THREE.CylinderGeometry(0.9, 1.0, 0.8, 10, 1, true)), M(0xa89878, { side: THREE.DoubleSide }), 0, 0.4, 0));
  g.add(mesh(geo('wellHole', () => new THREE.CircleGeometry(0.85, 10).rotateX(-Math.PI / 2)), M(0x1a140c), 0, 0.3, 0, false));
  [-1, 1].forEach((s) => g.add(mesh(geo('wellPost', () => new THREE.CylinderGeometry(0.06, 0.06, 2.0, 5).translate(0, 1.0, 0)), M(0x6a4a2a), s * 0.95, 0, 0)));
  const bar = mesh(geo('wellBar', () => new THREE.CylinderGeometry(0.05, 0.05, 2.1, 5).rotateZ(Math.PI / 2)), M(0x6a4a2a), 0, 1.8, 0);
  g.add(bar);
  g.add(mesh(geo('wellRoof', () => new THREE.ConeGeometry(1.4, 0.8, 4)), M(0x8a5a32), 0, 2.4, 0));
  g.position.set(wl.x, heightAt(wl.x, wl.z), wl.z);
  return g;
}
function makeTent(t) {
  const g = new THREE.Group();
  const c = t.king ? 0x5a1a2a : [0x7a3a2a, 0x5a4a32, 0x6a2a22][Math.floor(Math.abs(t.x * 7)) % 3];
  g.add(mesh(new THREE.ConeGeometry(t.r, t.king ? 3.6 : 2.6, 4).translate(0, t.king ? 1.8 : 1.3, 0), M(c), 0, 0, 0));
  g.add(mesh(geo('tentFlap', () => new THREE.BoxGeometry(0.8, 1.2, 0.05)), M(0x1a1010), 0, 0.6, t.r * 0.68, false));
  if (t.king) {
    g.add(mesh(geo('kPole', () => new THREE.CylinderGeometry(0.06, 0.06, 1.6, 5)), M(0x3a2a1a), 0, 4.1, 0));
    g.add(mesh(geo('kFlag', () => new THREE.BoxGeometry(0.04, 0.5, 0.8)), M(COL.gold), 0, 4.6, 0.4));
  }
  g.position.set(t.x, heightAt(t.x, t.z), t.z);
  g.rotation.y = t.rot;
  return g;
}

/* =====================================================================
   ENGINE — owns the three.js scene and draws the game state
   ===================================================================== */
const PALETTES = {
  forest: {
    top: [0x4f9ad8, 0x050a1c], horizon: [0xcfe9f5, 0x121a36], dusk: [0x5b4f8f, 0xf2a26a],
    hemiSky: [0xcfe8ff, 0x34477a], hemiGround: [0x5a6a32, 0x0a0f08], hemiI: [1.15, 0.32],
    sun: 0xfff1d6, sunI: 2.5, fog: [32, 115, 10, 46],
  },
  desert: {
    top: [0x3f8fd6, 0x07102a], horizon: [0xf3e3c3, 0x1e1f3a], dusk: [0x6a4f8a, 0xf6a05a],
    hemiSky: [0xeaf4ff, 0x3a4a80], hemiGround: [0xc9a46b, 0x1a140c], hemiI: [1.25, 0.38],
    sun: 0xfff0d2, sunI: 3.1, fog: [45, 170, 14, 62],
  },
  // underground: no sky, no sun, just warm rock and the dark beyond the torchlight
  cave: {
    top: [0x050403, 0x050403], horizon: [0x0b0806, 0x0b0806], dusk: [0x050403, 0x0b0806],
    hemiSky: [0x9a8670, 0x9a8670], hemiGround: [0x2a2018, 0x2a2018], hemiI: [0.62, 0.62],
    sun: 0x000000, sunI: 0, fog: [14, 52, 14, 52],
  },
};

function createEngine(gl) {
  const W = gl.drawingBufferWidth;
  const H = gl.drawingBufferHeight;
  const canvas =
    Platform.OS === 'web' && gl.canvas
      ? gl.canvas
      : { width: W, height: H, style: {}, clientWidth: W, clientHeight: H, addEventListener: () => {}, removeEventListener: () => {}, getContext: () => gl };
  const renderer = new THREE.WebGLRenderer({ canvas, context: gl, antialias: true });
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  if (LEGACY_THREE) {
    renderer.physicallyCorrectLights = true; // same light units as modern three.js
    renderer.outputEncoding = THREE.sRGBEncoding;
  }

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xcfe9f5, 35, 110);
  const camera = new THREE.PerspectiveCamera(58, W / H, 0.1, 500);

  const skyUni = { top: { value: new THREE.Color(0x5ea8e0) }, bottom: { value: new THREE.Color(0xcfe9f5) } };
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(320, 24, 12),
    new THREE.ShaderMaterial({
      uniforms: skyUni,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader:
        'uniform vec3 top; uniform vec3 bottom; varying vec3 vP; void main(){ float h = normalize(vP).y; float t = pow(clamp(h*1.4+0.05,0.0,1.0),0.7); gl_FragColor = vec4(mix(bottom, top, t),1.0); }',
    }),
  );
  sky.renderOrder = -1;
  scene.add(sky);
  const sunDisc = new THREE.Mesh(new THREE.CircleGeometry(9, 20), new THREE.MeshBasicMaterial({ color: 0xffe9a8, fog: false, transparent: true }));
  const moonDisc = new THREE.Mesh(new THREE.CircleGeometry(6, 20), new THREE.MeshBasicMaterial({ color: 0xeef0ff, fog: false, transparent: true }));
  scene.add(sunDisc, moonDisc);
  const starPos = new Float32Array(500 * 3);
  for (let i = 0; i < 500; i++) {
    const u = Math.random() * 2 - 1;
    const a = Math.random() * Math.PI * 2;
    const y = Math.abs(u) * 0.9 + 0.1;
    const r = Math.sqrt(1 - y * y);
    starPos.set([Math.cos(a) * r * 290, y * 290, Math.sin(a) * r * 290], i * 3);
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 1.4, sizeAttenuation: true, transparent: true, fog: false, depthWrite: false }));
  scene.add(stars);

  const hemi = new THREE.HemisphereLight(0xbfe3ff, 0x4a5a2a, 1.1);
  const ambient = new THREE.AmbientLight(0xffffff, 0.15);
  const sun = new THREE.DirectionalLight(0xfff1d6, 2.4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  const sc = sun.shadow.camera;
  sc.left = -22;
  sc.right = 22;
  sc.top = 22;
  sc.bottom = -22;
  sc.near = 1;
  sc.far = 100;
  sun.shadow.bias = LEGACY_THREE ? -0.002 : -0.0008;
  sun.shadow.normalBias = LEGACY_THREE ? 0.08 : 0.03;
  scene.add(hemi, ambient, sun, sun.target);

  // things that persist across regions: the hero, particles, target marker
  const player = makeHuman('player', ['axe', 'club', 'pickaxe', 'hammer', 'dagger', 'sword', 'mace', 'khopesh', 'spear', 'shield']);
  scene.add(player.root);
  const marker = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.34, 4).rotateX(Math.PI), new THREE.MeshBasicMaterial({ color: 0xffd166, fog: false }));
  scene.add(marker);
  const parts = [];
  const pg = new THREE.BoxGeometry(0.08, 0.08, 0.08);
  for (let i = 0; i < 110; i++) {
    const m = new THREE.Mesh(pg, new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true }));
    m.visible = false;
    scene.add(m);
    parts.push({ m, life: 0, vx: 0, vy: 0, vz: 0, spin: 0, grav: 9 });
  }
  return {
    renderer, scene, camera, sky, skyUni, sunDisc, moonDisc, stars, hemi, ambient, sun, W, H,
    player, marker, parts, region: null, world: null,
    cam: { yaw: Math.PI * 0.85, pitch: 0.36, dist: 6.2, target: new THREE.Vector3(0, 1.5, 0), lastDrag: -10 },
  };
}

function clearWorld(E) {
  if (!E.world) return;
  E.scene.remove(E.world);
  E.world.traverse((o) => {
    if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    mats.forEach((m) => !m.userData.shared && m.dispose());
  });
  E.world = null;
}

function terrainMesh(colorAt) {
  let tg = new THREE.PlaneGeometry(240, 240, 104, 104).rotateX(-Math.PI / 2);
  tg = tg.toNonIndexed();
  const pos = tg.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setY(i, heightAt(pos.getX(i), pos.getZ(i)));
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i += 3) {
    const cx = (pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3;
    const cz = (pos.getZ(i) + pos.getZ(i + 1) + pos.getZ(i + 2)) / 3;
    const cy = (pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3;
    const n = Math.abs(Math.sin(cx * 12.9898 + cz * 78.233) * 43758.5453) % 1;
    colorAt(c, cx, cy, cz, n);
    for (let k = 0; k < 3; k++) colors.set([c.r, c.g, c.b], (i + k) * 3);
  }
  tg.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  tg.computeVertexNormals();
  const terrain = new THREE.Mesh(tg, new THREE.MeshLambertMaterial({ vertexColors: true }));
  terrain.receiveShadow = true;
  return terrain;
}

function buildWorld(E, g) {
  clearWorld(E);
  REGION = g.region;
  const world = new THREE.Group();
  E.world = world;
  E.scene.add(world);
  E.region = g.region;
  E.nodeObjs = new Map();
  E.enemyObjs = new Map();
  E.npcObjs = new Map();
  E.arrowObjs = new Map();
  E.buildObjs = new Map();
  E.plotFlag = null;
  E.campFires = [];
  E.doorObjs = new Map();
  E.spikeObjs = new Map();
  E.pillarObjs = new Map();
  E.hazardObjs = new Map();
  E.torches = [];
  E.caveLights = [];
  E.playerLight = null;
  E.spirit = null;
  E.sun.castShadow = g.region !== 'cave'; // no sun underground
  const w = g.w;
  const tmp = new THREE.Object3D();
  const instanced = (geom, mat, list, place, cast = false) => {
    if (!list.length) return null;
    const im = new THREE.InstancedMesh(geom, mat, list.length);
    list.forEach((it, i) => {
      place(tmp, it, i);
      tmp.updateMatrix();
      im.setMatrixAt(i, tmp.matrix);
    });
    im.castShadow = cast;
    im.receiveShadow = true;
    world.add(im);
    return im;
  };
  const C = (hex) => new THREE.Color(hex);

  if (g.region === 'forest') {
    const grass = [C(0x5f9a3c), C(0x649f40), C(0x5a9439), C(0x67a343)];
    world.add(
      terrainMesh((c, x, y, z, n) => {
        c.copy(grass[Math.floor(n * 4)]);
        const d = Math.hypot(x, z);
        const trail = Math.abs(z) < 2.2 && x > 40 ? 0.5 : 0;
        const dirt = (1 - smooth(2.5, 6.5, d)) * 0.75 + (Math.sin(x * 0.3) * Math.cos(z * 0.25) > 0.75 ? 0.35 : 0) + trail;
        c.lerp(C(0x8b7448), clamp(dirt, 0, 0.8));
        if (y > 5) c.lerp(C(0x4d6b3a), clamp((y - 5) / 6, 0, 0.6));
      }),
    );
    instanced(flat(new THREE.ConeGeometry(0.07, 0.42, 3).translate(0, 0.2, 0)), M(0x7cb24a), w.decor.tufts, (o, t) => {
      o.position.set(t.x, heightAt(t.x, t.z), t.z);
      o.rotation.set(Math.sin(t.rot) * 0.3, t.rot, Math.cos(t.rot) * 0.3);
      o.scale.setScalar(t.s);
    });
    const fernGeo = flat(new THREE.ConeGeometry(0.12, 0.9, 3).translate(0, 0.45, 0).rotateX(0.9));
    for (let k = 0; k < 5; k++) {
      instanced(fernGeo, M(k % 2 ? 0x3f7f39 : 0x4f9244), w.decor.ferns, (o, f) => {
        o.position.set(f.x, heightAt(f.x, f.z), f.z);
        o.rotation.set(0, f.rot + (k / 5) * Math.PI * 2, 0);
        o.scale.setScalar(f.s);
      });
    }
    instanced(new THREE.DodecahedronGeometry(1, 0), M(0x8d8d86), w.rocks, (o, r) => {
      o.position.set(r.x, heightAt(r.x, r.z) + r.r * 0.35, r.z);
      o.rotation.set(r.rot, r.rot * 2, 0);
      o.scale.set(r.r * 1.1, r.r * 0.8, r.r);
    }, true);
    const pines = w.decor.farTrees.filter((t) => t.pine);
    const broads = w.decor.farTrees.filter((t) => !t.pine);
    const placeFar = (o, t) => {
      o.position.set(t.x, heightAt(t.x, t.z) - 0.2, t.z);
      o.rotation.set(0, t.rot, 0);
      o.scale.setScalar(t.s * 1.3);
    };
    instanced(flat(new THREE.CylinderGeometry(0.2, 0.32, 2.5, 5).translate(0, 1.25, 0)), M(COL.bark), w.decor.farTrees, placeFar);
    instanced(flat(new THREE.ConeGeometry(1.7, 4.6, 6).translate(0, 4.2, 0)), M(0x2d5f37), pines, placeFar, true);
    instanced(new THREE.IcosahedronGeometry(1.7, 0).translate(0, 3.6, 0), M(0x3a7531), broads, placeFar, true);
  } else if (g.region === 'cave') {
    buildCave(E, g, world, instanced);
  } else {
    const sand = [C(0xe2c48a), C(0xdab879), C(0xe6cc98), C(0xd8b475)];
    const O = DESERT.oasis;
    const CP = DESERT.camp;
    const V = DESERT.village;
    world.add(
      terrainMesh((c, x, y, z, n) => {
        c.copy(sand[Math.floor(n * 4)]);
        const near = (p, r) => dist2(x, z, p.x, p.z) - r;
        const green = Math.max(1 - smooth(0, 5, near(O, O.r)), 1 - smooth(0, 3, near(CP, DESERT.campPondR)));
        if (green > 0) c.lerp(n > 0.5 ? C(0x6a9a3c) : C(0x5a8a34), green * 0.9);
        const earth = Math.max(1 - smooth(V.r - 4, V.r + 2, dist2(x, z, V.x, V.z)), (1 - smooth(CP.r - 2, CP.r + 2, dist2(x, z, CP.x, CP.z))) * (green > 0.3 ? 0 : 1));
        if (earth > 0) c.lerp(C(0xc29a6a), earth * 0.55);
        if (inPlot(x, z)) c.lerp(n > 0.5 ? C(0xc9a46e) : C(0xbf9862), 0.55); // tilled earth on the plot
        if (y > 4) c.lerp((Math.floor(y * 0.6) % 2 ? C(0xb9774e) : C(0xc98a5a)), clamp((y - 4) / 5, 0, 0.95));
      }),
    );
    // water
    w.decor.ponds.forEach((p) => {
      const water = new THREE.Mesh(new THREE.CircleGeometry(p.r + 0.3, 28).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0x2f86c0, emissive: 0x0a2a40, transparent: true, opacity: 0.88 }));
      water.position.set(p.x, p.y, p.z);
      world.add(water);
      p.mesh = water;
    });
    // mesas + the canyon walls that ring the map
    w.decor.mesas.forEach((m) => {
      const y0 = heightAt(m.x, m.z) - 0.6;
      [[1, 0.5, 0xb9774e], [0.88, 0.3, 0xc98a5a], [0.78, 0.2, 0xa8653f]].reduce((y, [rs, hs, col]) => {
        const part = mesh(flat(new THREE.CylinderGeometry(m.r * rs * 0.95, m.r * rs, m.h * hs, 7).translate(0, (m.h * hs) / 2, 0)), M(col), m.x, y, m.z);
        part.rotation.y = m.rot;
        world.add(part);
        return y + m.h * hs;
      }, y0);
    });
    instanced(flat(new THREE.CylinderGeometry(0.9, 1, 1, 7).translate(0, 0.5, 0)), M(0xb06e48), w.decor.canyon, (o, k) => {
      o.position.set(k.x, heightAt(k.x, k.z) - 2, k.z);
      o.rotation.set(0, k.rot, 0);
      o.scale.set(k.r, k.h, k.r);
    }, true);
    // cacti: trunk + two arms each
    const cact = M(0x5c8a3a);
    instanced(flat(new THREE.CylinderGeometry(0.24, 0.3, 3, 7).translate(0, 1.5, 0)), cact, w.decor.cacti, (o, k) => {
      o.position.set(k.x, heightAt(k.x, k.z), k.z);
      o.rotation.set(0, k.rot, 0);
      o.scale.setScalar(k.s);
    }, true);
    const arms = [];
    w.decor.cacti.forEach((k) => {
      if (k.arms > 0.25) arms.push({ k, side: 1, h: 1.4 + k.arms * 0.6 });
      if (k.arms > 0.6) arms.push({ k, side: -1, h: 1.1 + k.arms * 0.5 });
    });
    instanced(flat(new THREE.CylinderGeometry(0.15, 0.17, 1.2, 6).translate(0, 0.6, 0)), cact, arms, (o, a) => {
      const k = a.k;
      const lx = 0.55 * a.side * k.s;
      o.position.set(k.x + Math.cos(k.rot) * lx, heightAt(k.x, k.z) + a.h * k.s, k.z - Math.sin(k.rot) * lx);
      o.rotation.set(0, k.rot, 0);
      o.scale.setScalar(k.s);
    }, true);
    instanced(flat(new THREE.CylinderGeometry(0.13, 0.13, 0.5, 6).rotateZ(Math.PI / 2)), cact, arms, (o, a) => {
      const k = a.k;
      const lx = 0.3 * a.side * k.s;
      o.position.set(k.x + Math.cos(k.rot) * lx, heightAt(k.x, k.z) + a.h * k.s, k.z - Math.sin(k.rot) * lx);
      o.rotation.set(0, k.rot, 0);
      o.scale.setScalar(k.s);
    });
    instanced(flat(new THREE.ConeGeometry(0.06, 0.5, 3).translate(0, 0.24, 0)), M(0xc8b46a), w.decor.tufts, (o, t) => {
      o.position.set(t.x, heightAt(t.x, t.z), t.z);
      o.rotation.set(Math.sin(t.rot) * 0.4, t.rot, Math.cos(t.rot) * 0.4);
      o.scale.setScalar(t.s);
    });
    instanced(new THREE.DodecahedronGeometry(1, 0), M(0xb08a62), w.rocks, (o, r) => {
      o.position.set(r.x, heightAt(r.x, r.z) + r.r * 0.3, r.z);
      o.rotation.set(r.rot, r.rot * 2, 0);
      o.scale.set(r.r * 1.1, r.r * 0.75, r.r);
    }, true);
    // village + camp
    w.decor.houses.forEach((h) => world.add(makeHouse(h)));
    world.add(makeStall(w.decor.stall));
    world.add(makeWell(w.decor.well));
    w.decor.tents.forEach((t) => world.add(makeTent(t)));
    instanced(flat(new THREE.CylinderGeometry(0.13, 0.15, 2.4, 6).translate(0, 1.2, 0)), M(0x6a4a2a), w.decor.stakes, (o, s) => {
      o.position.set(s.x, heightAt(s.x, s.z), s.z);
      o.rotation.set(Math.sin(s.rot * 5) * 0.06, s.rot, 0);
    }, true);
    instanced(flat(new THREE.ConeGeometry(0.15, 0.45, 6).translate(0, 2.62, 0)), M(0x8a6a42), w.decor.stakes, (o, s) => {
      o.position.set(s.x, heightAt(s.x, s.z), s.z);
      o.rotation.set(Math.sin(s.rot * 5) * 0.06, s.rot, 0);
    });
    w.decor.banners.forEach((b) => {
      world.add(mesh(geo('banPole', () => new THREE.CylinderGeometry(0.06, 0.06, 3.6, 5).translate(0, 1.8, 0)), M(0x3a2a1a), b.x, heightAt(b.x, b.z), b.z));
      const flag = mesh(geo('banFlag', () => new THREE.BoxGeometry(0.05, 1.2, 0.7)), M(0x8a1a1a), b.x, heightAt(b.x, b.z) + 2.9, b.z);
      flag.rotation.y = w.decor.gateA;
      world.add(flag);
    });
    // the plot: post-and-rope fence, a gate toward the village, a sign with a for-sale / owned flag
    const posts = w.decor.fence;
    instanced(flat(new THREE.CylinderGeometry(0.07, 0.09, 1.1, 5).translate(0, 0.55, 0)), M(0x7a5a36), posts, (o, f) => {
      o.position.set(f.x, heightAt(f.x, f.z), f.z);
      o.rotation.set(0, (f.x + f.z) * 3, 0);
    }, true);
    const rails = [];
    for (let i = 0; i < posts.length; i++) {
      for (let j = i + 1; j < posts.length; j++) {
        const a = posts[i];
        const b = posts[j];
        const dd = dist2(a.x, a.z, b.x, b.z);
        if (dd < 1.05 && (Math.abs(a.x - b.x) < 0.01 || Math.abs(a.z - b.z) < 0.01)) {
          rails.push({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, rot: Math.abs(a.x - b.x) < 0.01 ? Math.PI / 2 : 0, y: 0.5 });
          rails.push({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, rot: Math.abs(a.x - b.x) < 0.01 ? Math.PI / 2 : 0, y: 0.9 });
        }
      }
    }
    instanced(new THREE.BoxGeometry(1.0, 0.04, 0.04), M(0xc9b07a), rails, (o, r) => {
      o.position.set(r.x, heightAt(r.x, r.z) + r.y, r.z);
      o.rotation.set(0, r.rot, 0);
    });
    const sg = w.decor.plotSign;
    world.add(mesh(geo('signPost2', () => new THREE.CylinderGeometry(0.06, 0.07, 2.2, 5).translate(0, 1.1, 0)), M(COL.bark), sg.x, heightAt(sg.x, sg.z), sg.z));
    world.add(mesh(geo('signBoard2', () => new THREE.BoxGeometry(1.1, 0.6, 0.06)), M(0xb88a52), sg.x, heightAt(sg.x, sg.z) + 1.55, sg.z + 0.06));
    const flagMat = new THREE.MeshLambertMaterial({ color: 0xc0392b });
    const flag = new THREE.Mesh(geo('plotFlag', () => new THREE.BoxGeometry(0.6, 0.35, 0.03)), flagMat);
    flag.position.set(sg.x + 0.3, heightAt(sg.x, sg.z) + 2.05, sg.z);
    world.add(flag);
    E.plotFlag = flag;
    w.decor.campfires.forEach((cf) => {
      const f = makeFire(true);
      f.g.position.set(cf.x, heightAt(cf.x, cf.z), cf.z);
      world.add(f.g);
      E.campFires.push(f);
    });
  }
  E.built = true;
}

/* ---------- the Desert Cave ---------- */
const FX_MATS = {};
function glowMat(color, opacity = 0.85) {
  const key = color + ':' + opacity;
  if (!FX_MATS[key]) {
    FX_MATS[key] = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false });
    FX_MATS[key].userData.shared = true;
  }
  return FX_MATS[key];
}
function makeTorch() {
  const g = new THREE.Group();
  const iron = M(0x3a3430);
  g.add(mesh(geo('tcPole', () => new THREE.CylinderGeometry(0.05, 0.07, 1.9, 6).translate(0, 0.95, 0)), iron));
  g.add(mesh(geo('tcFoot', () => new THREE.CylinderGeometry(0.25, 0.3, 0.12, 6)), iron, 0, 0.06, 0));
  g.add(mesh(geo('tcBowl', () => new THREE.CylinderGeometry(0.22, 0.1, 0.22, 7)), M(0x5a4a3a), 0, 1.98, 0));
  const flames = new THREE.Group();
  flames.position.y = 2.05;
  [[0xff5a00, 0.18, 0.62, 0.85], [0xffa21a, 0.12, 0.46, 0.9], [0xfff0a0, 0.07, 0.3, 0.95]].forEach(([c, r, h, o], i) =>
    flames.add(new THREE.Mesh(geo('tcFlame' + i, () => new THREE.ConeGeometry(r, h, 6).translate(0, h / 2, 0)), glowMat(c, o))),
  );
  g.add(flames);
  return { g, flames };
}
function makePillar() {
  const g = new THREE.Group();
  const glyph = new THREE.MeshLambertMaterial({ color: 0xc9a24a, emissive: 0x1a1000 });
  const stone = M(0xcdb48a);
  const dark = M(0xb89a6a);
  const column = new THREE.Group();
  column.add(mesh(geo('plBase', () => new THREE.BoxGeometry(1.7, 0.4, 1.7)), dark, 0, 0.2, 0));
  column.add(mesh(geo('plShaft', () => new THREE.CylinderGeometry(0.62, 0.7, 4.6, 8).translate(0, 2.7, 0)), stone));
  [1.2, 2.6, 4.0].forEach((y) => column.add(mesh(geo('plBand', () => new THREE.CylinderGeometry(0.73, 0.73, 0.18, 8)), glyph, 0, y, 0, false)));
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2 + Math.PI / 8;
    const s = mesh(geo('plGlyph', () => new THREE.BoxGeometry(0.16, 2.4, 0.05)), glyph, Math.sin(a) * 0.66, 2.6, Math.cos(a) * 0.66, false);
    s.rotation.y = a;
    column.add(s);
  }
  column.add(mesh(geo('plCap', () => new THREE.BoxGeometry(1.6, 0.4, 1.6)), dark, 0, 5.2, 0));
  const stump = new THREE.Group();
  stump.add(mesh(geo('plBase', () => new THREE.BoxGeometry(1.7, 0.4, 1.7)), dark, 0, 0.2, 0));
  stump.add(mesh(geo('plStub', () => new THREE.CylinderGeometry(0.5, 0.7, 1.1, 8).translate(0, 0.9, 0)), stone));
  [[0.9, 0.2, 0.6, 0.4], [-0.8, 0.2, -0.5, 0.45], [0.3, 0.15, -1.1, 0.35], [-0.6, 0.15, 0.9, 0.3]].forEach(([x, y, z, r], i) => {
    const m = mesh(geo('plRub' + i, () => new THREE.DodecahedronGeometry(r, 0)), stone, x, y, z);
    m.rotation.set(i, i * 1.7, 0);
    stump.add(m);
  });
  stump.visible = false;
  g.add(column, stump);
  return { g, column, stump, glyph };
}
function makeCaveDoor(dr) {
  const g = new THREE.Group();
  const len = dr.half * 2 + 0.8;
  const slab = new THREE.Group();
  slab.add(mesh(new THREE.BoxGeometry(len, 4.4, 0.9), M(dr.kind === 'boss' ? 0x9a8458 : 0xa89060), 0, 2.2, 0));
  [0.5, 3.9].forEach((y) => slab.add(mesh(new THREE.BoxGeometry(len - 0.4, 0.14, 0.98), M(0x7a6440), 0, y, 0, false)));
  const gold = M(COL.gold, { emissive: 0x3a2800 });
  if (dr.kind === 'boss') {
    // an ankh, with the two lever slots beside it
    slab.add(mesh(geo('ankhBar', () => new THREE.BoxGeometry(0.22, 1.5, 1.0)), gold, 0, 1.75, 0, false));
    slab.add(mesh(geo('ankhArm', () => new THREE.BoxGeometry(1.0, 0.2, 1.0)), gold, 0, 2.55, 0, false));
    slab.add(mesh(geo('ankhLoop', () => new THREE.TorusGeometry(0.32, 0.09, 6, 12)), gold, 0, 3.05, 0.48, false));
    slab.add(mesh(geo('ankhLoop', () => new THREE.TorusGeometry(0.32, 0.09, 6, 12)), gold, 0, 3.05, -0.48, false));
    [-1, 1].forEach((s) => slab.add(mesh(geo('doorSlot', () => new THREE.BoxGeometry(0.16, 0.6, 1.0)), M(0x1a140c), s * 1.5, 2.0, 0, false)));
  } else {
    // a golden scarab around the keyhole
    [0.48, -0.48].forEach((z) => {
      slab.add(mesh(geo('scarabBody', () => new THREE.SphereGeometry(0.42, 8, 6).scale(1, 1.3, 0.3)), gold, 0, 2.2, z, false));
      [-1, 1].forEach((s) => {
        const wing = mesh(geo('scarabWing', () => new THREE.BoxGeometry(0.7, 0.3, 0.06)), gold, s * 0.6, 2.4, z, false);
        wing.rotation.z = s * 0.4;
        slab.add(wing);
      });
    });
  }
  g.add(slab);
  g.position.set(dr.x, 0, dr.z);
  g.rotation.y = dr.axis === 'z' ? Math.PI / 2 : 0;
  slab.position.y = dr.open ? -4.4 : 0;
  return { g, slab, y: slab.position.y };
}
function makeSpikeStrip(s) {
  const g = new THREE.Group();
  g.add(mesh(new THREE.BoxGeometry(s.w, 0.06, s.len), M(0x3e3832), 0, 0.03, 0, false));
  const spikes = new THREE.Group();
  const rows = Math.floor(s.len / 0.7);
  const steel = M(0xb9bec6);
  for (let i = 0; i < rows; i++) for (const x of [-0.4, 0.4]) spikes.add(mesh(geo('spike', () => new THREE.ConeGeometry(0.09, 0.6, 5).translate(0, 0.3, 0)), steel, x, 0.04, -s.len / 2 + 0.35 + i * 0.7, false));
  spikes.position.y = -0.7;
  g.add(spikes);
  g.position.set(s.x, 0, s.z);
  return { g, spikes };
}
function makeSpirit() {
  const g = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: 0x6aff9a, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false });
  g.add(new THREE.Mesh(new THREE.ConeGeometry(0.75, 2.4, 10, 1, true).translate(0, -0.4, 0), mat));
  g.add(new THREE.Mesh(new THREE.SphereGeometry(0.34, 10, 8), mat).translateY(1.05));
  [-1, 1].forEach((s) => {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.16, 1.1, 0.16).translate(0, 0.5, 0), mat);
    arm.position.set(s * 0.45, 0.55, 0);
    arm.rotation.z = -s * 0.7;
    g.add(arm);
  });
  const eyes = glowMat(0xeaffea, 0.95);
  [-1, 1].forEach((s) => g.add(new THREE.Mesh(geo('spEye', () => new THREE.SphereGeometry(0.06, 6, 4)), eyes).translateX(s * 0.12).translateY(1.1).translateZ(0.28)));
  g.visible = false;
  return { g, mat };
}
function makeHazard(h) {
  const g = new THREE.Group();
  if (h.kind === 'sand') {
    const disc = new THREE.Mesh(new THREE.CircleGeometry(h.r, 24).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x1e1424, transparent: true, opacity: 0, depthWrite: false }));
    const swirlMat = new THREE.MeshBasicMaterial({ color: 0x3aa860, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false });
    const swirl = new THREE.Group();
    for (let i = 0; i < 3; i++) {
      const arc = new THREE.Mesh(new THREE.RingGeometry(h.r * (0.25 + i * 0.24), h.r * (0.33 + i * 0.24), 16, 1, i * 2, 2.6).rotateX(-Math.PI / 2), swirlMat);
      arc.position.y = 0.02;
      swirl.add(arc);
    }
    const ring = new THREE.Mesh(new THREE.RingGeometry(h.r - 0.14, h.r, 28).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x5aff8a, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }));
    ring.position.y = 0.03;
    g.add(disc, swirl, ring);
    return { g, disc, swirl, ring, swirlMat };
  }
  const ring = new THREE.Mesh(new THREE.RingGeometry(h.r - 0.15, h.r, 24).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x8affb0, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
  ring.position.y = 0.03;
  const handMat = new THREE.MeshBasicMaterial({ color: 0x6aff9a, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false });
  const hands = new THREE.Group();
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const hand = new THREE.Group();
    hand.add(new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.7, 0.1).translate(0, 0.35, 0), handMat));
    for (let f = 0; f < 4; f++) hand.add(new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.3, 0.05).translate(0, 0.15, 0), handMat).translateX(-0.08 + f * 0.055).translateY(0.7));
    hand.position.set(Math.cos(a) * 0.55, 0, Math.sin(a) * 0.55);
    hand.rotation.set(Math.sin(a) * 0.4, -a, Math.cos(a) * 0.4);
    hands.add(hand);
  }
  hands.visible = false;
  g.add(ring, hands);
  return { g, ring, hands, handMat };
}
function makeBonePile() {
  const g = new THREE.Group();
  const bone = M(0xe6dcc0);
  g.add(mesh(geo('bpSkull', () => new THREE.SphereGeometry(0.16, 7, 5).scale(1, 0.9, 1.1)), bone, 0.12, 0.14, 0.18));
  [[0, 0.05, 0, 0.75, 0.4], [0.2, 0.06, -0.2, 0.6, 1.8], [-0.25, 0.05, 0.05, 0.55, 2.7], [0.05, 0.11, -0.05, 0.5, 1.0], [-0.1, 0.05, -0.3, 0.45, 0.2]].forEach(([x, y, z, l, r]) => {
    const b = mesh(geo('bpBone', () => new THREE.CylinderGeometry(0.035, 0.035, 1, 5).rotateZ(Math.PI / 2)), bone, x, y, z, false);
    b.scale.x = l;
    b.rotation.y = r;
    g.add(b);
  });
  return g;
}

function buildCave(E, g, world, instanced) {
  const w = g.w;
  const G = w.grid;
  const R = w.rooms;
  const C = (hex) => new THREE.Color(hex);
  // ---- floor (one merged mesh) and water ----
  const fpos = [];
  const fcol = [];
  const wpos = [];
  const quad = (arr, x, z, y) => arr.push(x, y, z, x, y, z + 1, x + 1, y, z + 1, x, y, z, x + 1, y, z + 1, x + 1, y, z);
  const dirt = [C(0x5e4c3a), C(0x66533f), C(0x584636), C(0x6c5842)];
  const tile = [C(0x8a7a5a), C(0x7a6a4c)];
  const c = new THREE.Color();
  const inRoom = (k, x, z, s = 1) => ((x - R[k].x) / R[k].rx) ** 2 + ((z - R[k].z) / R[k].rz) ** 2 < s * s;
  for (let r = 0; r < G.rows; r++) {
    for (let col = 0; col < G.cols; col++) {
      const i = r * G.cols + col;
      const t = G.t[i];
      const x = G.x0 + col;
      const z = G.z0 + r;
      if (t === WATER) {
        quad(wpos, x, z, -0.3);
        continue;
      }
      if (t !== FLOOR && t !== DOOR) continue;
      const n = hash01(x + 0.5, z + 0.5);
      if (inRoom('boss', x, z, 1.15)) c.copy(tile[(col + r) % 2]).lerp(C(0x5a4c36), n * 0.25);
      else {
        c.copy(dirt[Math.floor(n * 4)]);
        c.lerp(C(0xc9a46b), smooth(26, 38, z) * 0.85); // sand blown in from the desert
        if (inRoom('grotto', x, z, 1.1)) c.lerp(C(0x3e5038), 0.35); // damp near the pool
      }
      quad(fpos, x, z, 0);
      for (let k = 0; k < 6; k++) fcol.push(c.r, c.g, c.b);
    }
  }
  const fg = new THREE.BufferGeometry();
  fg.setAttribute('position', new THREE.Float32BufferAttribute(fpos, 3));
  fg.setAttribute('color', new THREE.Float32BufferAttribute(fcol, 3));
  fg.computeVertexNormals();
  const floor = new THREE.Mesh(fg, new THREE.MeshLambertMaterial({ vertexColors: true }));
  floor.receiveShadow = true;
  world.add(floor);
  const wg = new THREE.BufferGeometry();
  wg.setAttribute('position', new THREE.Float32BufferAttribute(wpos, 3));
  wg.computeVertexNormals();
  const water = new THREE.Mesh(wg, new THREE.MeshLambertMaterial({ color: 0x2a6a90, emissive: 0x08202e, transparent: true, opacity: 0.9 }));
  world.add(water);
  E.caveWater = water;
  // the bottomless dark under the pits, and around everything
  const voidPlane = new THREE.Mesh(new THREE.PlaneGeometry(260, 260).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x050403 }));
  voidPlane.position.y = -4.5;
  world.add(voidPlane);

  // ---- rock walls: one instanced mesh of lumpy boulders along every open edge ----
  const walls = [];
  for (let i = 0; i < G.t.length; i++) if (G.t[i] === ROCK && G.wallH[i] > 0) walls.push(i);
  const rockGeo = flat(new THREE.DodecahedronGeometry(1, 0));
  const rockMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const wim = new THREE.InstancedMesh(rockGeo, rockMat, walls.length);
  const tmp = new THREE.Object3D();
  const rockCols = [C(0x6e5a46), C(0x5e4c3a), C(0x7a644c), C(0x54443a), C(0x82684e)];
  walls.forEach((i, k) => {
    const x = G.x0 + (i % G.cols) + 0.5;
    const z = G.z0 + ((i / G.cols) | 0) + 0.5;
    const h = G.wallH[i];
    const n = hash01(x, z);
    const n2 = hash01(z, x);
    tmp.position.set(x + (n - 0.5) * 0.3, h * 0.42, z + (n2 - 0.5) * 0.3);
    tmp.rotation.set((n - 0.5) * 0.4, n2 * 6.28, (n2 - 0.5) * 0.4);
    tmp.scale.set(0.95 + n * 0.3, h * 0.6, 0.95 + n2 * 0.3);
    tmp.updateMatrix();
    wim.setMatrixAt(k, tmp.matrix);
    wim.setColorAt(k, rockCols[Math.floor(n2 * rockCols.length)]);
  });
  if (wim.instanceColor) wim.instanceColor.needsUpdate = true;
  wim.receiveShadow = true;
  world.add(wim);

  // ---- bridges ----
  w.bridges.forEach((b) => {
    const grp = new THREE.Group();
    const n = Math.ceil(b.len / 0.45);
    for (let i = 0; i < n; i++) {
      const pl = mesh(geo('plank', () => new THREE.BoxGeometry(1, 0.1, 0.38)), M(i % 2 ? 0x7a5432 : 0x6a4628), 0, -0.04, -b.len / 2 + 0.22 + i * 0.45);
      pl.scale.x = b.wd + 0.3;
      pl.rotation.y = Math.sin(i * 7) * 0.04;
      grp.add(pl);
    }
    [-1, 1].forEach((s) => {
      grp.add(mesh(new THREE.BoxGeometry(0.04, 0.04, b.len + 0.4), M(0xc9b07a), s * (b.wd / 2 + 0.12), 0.75, 0, false));
      [-1, 1].forEach((e) => grp.add(mesh(geo('brPost', () => new THREE.CylinderGeometry(0.06, 0.07, 1.0, 5).translate(0, 0.5, 0)), M(0x5a3a22), s * (b.wd / 2 + 0.12), -0.1, e * (b.len / 2 + 0.1))));
    });
    grp.position.set(b.x, 0, b.z);
    grp.rotation.y = b.axis === 'x' ? Math.PI / 2 : 0;
    world.add(grp);
  });

  // ---- doors, spikes, pillars, torches ----
  w.doors.forEach((dr) => {
    const o = makeCaveDoor(dr);
    world.add(o.g);
    E.doorObjs.set(dr.id, o);
  });
  w.spikes.forEach((s) => {
    const o = makeSpikeStrip(s);
    world.add(o.g);
    E.spikeObjs.set(s.id, o);
  });
  w.boss.pillars.forEach((pl) => {
    const o = makePillar();
    o.g.position.set(pl.x, 0, pl.z);
    world.add(o.g);
    E.pillarObjs.set(pl.id, o);
  });
  w.decor.torches.forEach((td, i) => {
    const o = makeTorch();
    o.g.position.set(td.x, 0, td.z);
    world.add(o.g);
    E.torches.push({ data: td, flames: o.flames, lit: true, fl: 1, ph: i * 1.7 });
  });

  // ---- the sarcophagus at the back of the boss chamber ----
  const sc = w.decor.sarc;
  const sarc = new THREE.Group();
  sarc.add(mesh(geo('sarcBase', () => new THREE.BoxGeometry(1.5, 0.9, 2.7)), M(0xb89a6a), 0, 0.45, 0));
  sarc.add(mesh(geo('sarcTrim', () => new THREE.BoxGeometry(1.56, 0.12, 2.76)), M(COL.gold, { emissive: 0x2a1c00 }), 0, 0.85, 0, false));
  const lidM = mesh(geo('sarcLid', () => new THREE.BoxGeometry(1.4, 0.25, 2.6)), M(0x2a4a8a), 1.0, 0.55, 0.2);
  lidM.rotation.z = -0.9;
  sarc.add(lidM);
  sarc.add(mesh(geo('sarcFace', () => new THREE.BoxGeometry(0.6, 0.06, 0.7)), M(COL.gold, { emissive: 0x3a2800 }), 1.1, 0.75, 1.0, false));
  sarc.position.set(sc.x, 0, sc.z);
  world.add(sarc);

  // ---- little things: bones, glowing mushrooms, rocks in the pool ----
  instanced(geo('bpBone', () => new THREE.CylinderGeometry(0.035, 0.035, 1, 5).rotateZ(Math.PI / 2)), M(0xe6dcc0), w.decor.bones, (o, b) => {
    o.position.set(b.x, 0.04, b.z);
    o.rotation.set(0, b.rot, 0);
    o.scale.set(b.s, 1, 1);
  });
  instanced(geo('bpSkull', () => new THREE.SphereGeometry(0.16, 7, 5).scale(1, 0.9, 1.1)), M(0xe6dcc0), w.decor.bones.filter((b, i) => i % 3 === 0), (o, b) => {
    o.position.set(b.x + 0.3, 0.12, b.z - 0.2);
    o.rotation.set(0, b.rot * 2, 0.3);
  });
  instanced(geo('shStem', () => new THREE.CylinderGeometry(0.04, 0.05, 0.25, 5).translate(0, 0.12, 0)), M(0xe8e2d0), w.decor.shrooms, (o, s) => {
    o.position.set(s.x, 0, s.z);
    o.scale.setScalar(s.s);
  });
  instanced(geo('shCap', () => new THREE.SphereGeometry(0.14, 7, 4, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.6, 1)), new THREE.MeshBasicMaterial({ color: 0x6af0ff }), w.decor.shrooms, (o, s) => {
    o.position.set(s.x, 0.24 * s.s, s.z);
    o.rotation.set(0, s.rot, 0);
    o.scale.setScalar(s.s);
  });
  instanced(new THREE.DodecahedronGeometry(1, 0), M(0x6a5a48), w.rocks, (o, rk) => {
    o.position.set(rk.x, -0.1, rk.z);
    o.rotation.set(rk.rot, rk.rot * 2, 0);
    o.scale.set(rk.r * 1.1, rk.r * 0.7, rk.r);
  });

  // ---- light: a small glow around the player, plus a pool of lights handed to the nearest torches ----
  const f = LEGACY_THREE ? 0.3 : 1;
  E.playerLight = new THREE.PointLight(0xffc890, 9 * f, 10, 1.6);
  world.add(E.playerLight);
  for (let i = 0; i < 5; i++) {
    const L = new THREE.PointLight(0xff9a3c, 0, 15, 1.6);
    world.add(L);
    E.caveLights.push(L);
  }
  const sp = makeSpirit();
  E.spirit = sp.g;
  E.spiritMat = sp.mat;
  world.add(sp.g);
}

function syncCave(E, g, dt, t) {
  const w = g.w;
  const p = g.player;
  const B = w.boss;
  // doors sink into the floor once they open
  for (const dr of w.doors) {
    const o = E.doorObjs.get(dr.id);
    if (!o) continue;
    o.y = lerp(o.y, dr.open ? -4.5 : 0, 1 - Math.exp(-dt * 1.4));
    o.slab.position.y = o.y + (dr.open && o.y > -4.3 ? Math.sin(t * 40) * 0.03 : 0);
  }
  // spikes: hidden, then twitching (the warning), then up
  for (const s of w.spikes) {
    const o = E.spikeObjs.get(s.id);
    const st = spikeState(s, g.time);
    const want = st === 'up' ? 0 : st === 'warn' ? -0.45 + Math.abs(Math.sin(t * 30)) * 0.05 : -0.7;
    o.spikes.position.y = lerp(o.spikes.position.y, want, 1 - Math.exp(-dt * (st === 'up' ? 40 : 10)));
  }
  // pillars glow green while they power his shield
  for (const pl of B.pillars) {
    const o = E.pillarObjs.get(pl.id);
    o.column.visible = pl.alive;
    o.stump.visible = !pl.alive;
    const lit = B.glow && pl.alive;
    o.glyph.color.setHex(lit ? 0x7affa0 : 0xc9a24a);
    o.glyph.emissive.setHex(lit ? (Math.sin(t * 6 + pl.id) > 0 ? 0x2ac85a : 0x1a8a3a) : 0x1a1000);
    o.column.position.x = pl.hitT > 0 ? Math.sin(t * 70) * 0.06 : 0;
  }
  // torches (the boss chamber's go dark when the spirit rises)
  const out = B.torchesOut && !B.done;
  E.torches.forEach((tr) => {
    tr.lit = !(tr.data.boss && out);
    tr.flames.visible = tr.lit;
    tr.fl = 1 + 0.15 * Math.sin(t * 13 + tr.ph) + 0.08 * Math.sin(t * 27 + tr.ph);
    tr.flames.scale.set(1, tr.fl, 1);
  });
  // the spirit hovering over the Guardian
  const mum = w.enemies.find((e) => e.type === 'mummy');
  E.spirit.visible = !!(mum && mum.spirit);
  if (E.spirit.visible) {
    E.spirit.position.set(mum.x, (mum.hy || 0) + 3.3 + Math.sin(t * 2) * 0.15, mum.z);
    E.spirit.rotation.y = mum.rot;
    E.spiritMat.opacity = 0.4 + Math.sin(t * 5) * 0.08;
  }
  // the Guardian's curses on the floor
  const liveH = new Set();
  for (const h of w.hazards) {
    liveH.add(h.id);
    let o = E.hazardObjs.get(h.id);
    if (!o) {
      o = makeHazard(h);
      E.world.add(o.g);
      E.hazardObjs.set(h.id, o);
    }
    o.g.position.set(h.x, 0.04, h.z);
    if (h.kind === 'sand') {
      const active = h.age > h.warn;
      const fade = clamp((h.warn + h.life + 0.6 - h.age) / 0.6, 0, 1);
      o.disc.material.opacity = (active ? 0.85 : 0.2 + 0.12 * Math.sin(t * 20)) * fade;
      o.swirlMat.opacity = (active ? 0.7 : 0.25) * fade;
      o.swirl.rotation.y += dt * (active ? 2.5 : 0.8);
      o.ring.material.opacity = (active ? 0.5 : 0.6 + 0.4 * Math.sin(t * 18)) * fade;
    } else {
      const k = clamp(h.age / h.warn, 0, 1);
      o.ring.scale.setScalar(1.6 - 0.6 * k);
      o.ring.material.opacity = h.fired ? 0 : 0.5 + 0.4 * Math.sin(t * 25);
      o.hands.visible = !!h.fired;
      if (h.fired) {
        const a = h.age - h.warn;
        o.hands.position.y = Math.min(1, a * 6) * 0.6 - 0.5;
        o.handMat.opacity = clamp(1 - a / 0.8, 0, 1) * 0.8;
      }
    }
  }
  for (const [id, o] of E.hazardObjs) {
    if (liveH.has(id)) continue;
    E.world.remove(o.g);
    o.g.traverse((m) => {
      if (m.geometry && !m.geometry.userData.shared) m.geometry.dispose();
      if (m.material && !m.material.userData.shared) m.material.dispose();
    });
    E.hazardObjs.delete(id);
  }
  if (E.caveWater) E.caveWater.material.emissive.setHex(Math.sin(t * 1.3) > 0.6 ? 0x0c2a3c : 0x08202e);
  // hand the light pool to whatever glows nearest the player
  const f = LEGACY_THREE ? 0.3 : 1;
  const src = [];
  E.torches.forEach((tr) => tr.lit && src.push({ x: tr.data.x, y: 2.4, z: tr.data.z, c: 0xff9a3c, i: 34 * tr.fl, r: 15 }));
  if (B.glow) B.pillars.forEach((pl) => pl.alive && src.push({ x: pl.x, y: 2.8, z: pl.z, c: 0x5aff8a, i: 26, r: 14 }));
  if (E.spirit.visible) src.push({ x: E.spirit.position.x, y: E.spirit.position.y, z: E.spirit.position.z, c: 0x6affa0, i: 40, r: 18 });
  const ex = w.nodes.find((n) => n.type === 'caveexit');
  if (ex) src.push({ x: ex.x, y: 3, z: ex.z + 1, c: 0xffe6b0, i: 45, r: 16 });
  for (const s of src) s.d = dist2(s.x, s.z, p.x, p.z);
  src.sort((a, b) => a.d - b.d);
  E.caveLights.forEach((L, i) => {
    const s = src[i];
    if (!s || s.d > 30) {
      L.intensity = 0;
      return;
    }
    L.position.set(s.x, s.y, s.z);
    L.color.setHex(s.c);
    L.intensity = s.i * f;
    L.distance = s.r;
  });
  E.playerLight.position.set(p.x, 2.4, p.z);
}

function emit(E, type, x, y, z, color, n) {
  const cfg = {
    chips: { n: 10, c: color || 0xd9b27c, sp: 3.2, up: 3.5, life: 0.9, s: 1, grav: 12 },
    leaves: { n: n || 22, c: color || 0x4f9244, sp: 1.8, up: 1.2, life: 2.4, s: 1.6, grav: 1.4 },
    poof: { n: n || 12, c: color || 0xb8b0a0, sp: 1.6, up: 1.4, life: 0.7, s: 1.6, grav: 1 },
    hit: { n: 10, c: 0xffe08a, sp: 3, up: 2, life: 0.4, s: 0.9, grav: 4 },
    sparks: { n: 14, c: 0xffb347, sp: 1.2, up: 3.5, life: 0.9, s: 0.7, grav: -0.5 },
    dust: { n: 4, c: color || 0x9c8a62, sp: 0.8, up: 0.6, life: 0.6, s: 1.3, grav: 0.5 },
    slam: { n: 24, c: 0xcaa878, sp: 5, up: 1.6, life: 0.9, s: 1.8, grav: 3 },
    gold: { n: 10, c: 0xffd23a, sp: 1.2, up: 4, life: 0.9, s: 0.9, grav: 7 },
    splash: { n: 14, c: 0x8fd0f0, sp: 1.4, up: 2.6, life: 0.6, s: 0.8, grav: 8 },
    spirit: { n: n || 14, c: color || 0x6aff9a, sp: 1.1, up: 2.6, life: 0.9, s: 0.9, grav: -0.8 },
  }[type];
  if (!cfg) return;
  let made = 0;
  for (const p of E.parts) {
    if (p.life > 0) continue;
    p.m.visible = true;
    p.m.position.set(x + (Math.random() - 0.5) * 0.3, y + Math.random() * 0.3, z + (Math.random() - 0.5) * 0.3);
    const a = Math.random() * Math.PI * 2;
    const sp = cfg.sp * (0.4 + Math.random() * 0.8);
    p.vx = Math.cos(a) * sp;
    p.vz = Math.sin(a) * sp;
    p.vy = cfg.up * (0.5 + Math.random() * 0.8);
    p.life = p.max = cfg.life * (0.7 + Math.random() * 0.6);
    p.grav = cfg.grav;
    p.spin = (Math.random() - 0.5) * 12;
    p.m.material.color.setHex(cfg.c);
    p.m.material.emissive.setHex(['sparks', 'hit', 'gold', 'spirit'].includes(type) ? cfg.c : 0x000000);
    p.m.scale.set(cfg.s, type === 'leaves' ? cfg.s * 0.25 : cfg.s, cfg.s);
    if (++made >= cfg.n) break;
  }
}

function lerpAngle(a, b, t) {
  return a + angDiff(b, a) * t;
}

function syncEngine(E, g, dt, mode, target) {
  if (E.region !== g.region || !E.world) buildWorld(E, g);
  setRegion(g);
  const { scene, camera, sun, hemi, skyUni } = E;
  const w = g.w;
  const t = g.time;
  const p = g.player;
  const k = (rate) => 1 - Math.exp(-dt * rate);

  const gl = E.renderer.getContext();
  if (gl.drawingBufferWidth !== E.W || gl.drawingBufferHeight !== E.H) {
    E.W = gl.drawingBufferWidth;
    E.H = gl.drawingBufferHeight;
    E.renderer.setSize(E.W, E.H, false);
  }
  camera.aspect = E.W / E.H;
  camera.updateProjectionMatrix();

  // ---- sky, light, fog ----
  const P = PALETTES[g.region];
  const tod = mode === 'title' ? 0.13 : g.tod;
  const cave = g.region === 'cave';
  const d = cave ? 1 : darkness(tod);
  const dusk = clamp(1 - Math.abs(tod - 0.62) / 0.08, 0, 1) + clamp(1 - Math.abs(tod - 0.035) / 0.04, 0, 1) * 0.6;
  const mix2 = ([a, b]) => new THREE.Color(a).lerp(new THREE.Color(b), d);
  skyUni.top.value.copy(mix2(P.top).lerp(new THREE.Color(P.dusk[0]), dusk * 0.45));
  const horizon = mix2(P.horizon).lerp(new THREE.Color(P.dusk[1]), dusk * 0.75);
  skyUni.bottom.value.copy(horizon);
  scene.fog.color.copy(horizon);
  scene.fog.near = lerp(P.fog[0], P.fog[2], d);
  scene.fog.far = lerp(P.fog[1], P.fog[3], d);
  hemi.color.copy(mix2(P.hemiSky));
  hemi.groundColor.copy(mix2(P.hemiGround));
  hemi.intensity = lerp(P.hemiI[0], P.hemiI[1], d);
  E.ambient.intensity = lerp(0.18, 0.06, d);
  E.renderer.toneMappingExposure = lerp(1.05, 1.3, d);
  const dayP = clamp(tod / 0.68, 0, 1);
  const sunA = Math.PI * dayP;
  const sunDir = new THREE.Vector3(Math.cos(sunA) * 0.85, Math.max(0.06, Math.sin(sunA)), 0.45).normalize();
  const nightP = ((tod - 0.64 + 1) % 1) / 0.42;
  const moonA = Math.PI * clamp(nightP, 0, 1);
  const moonDir = new THREE.Vector3(-Math.cos(moonA) * 0.8, Math.max(0.15, Math.sin(moonA)), -0.4).normalize();
  const useMoon = d > 0.6;
  sun.color.copy(useMoon ? new THREE.Color(0x8ea8ff) : new THREE.Color(P.sun).lerp(new THREE.Color(0xff9a52), clamp(dusk, 0, 1)));
  sun.intensity = useMoon ? lerp(0, 0.55, (d - 0.6) / 0.4) : lerp(P.sunI, 0.2, d / 0.6);
  const focus = mode === 'title' ? new THREE.Vector3(0, 0, 0) : new THREE.Vector3(p.x, heightAt(p.x, p.z), p.z);
  sun.position.copy(focus).addScaledVector(useMoon ? moonDir : sunDir, 50);
  sun.target.position.copy(focus);
  E.sunDisc.position.copy(camera.position).addScaledVector(sunDir, 240);
  E.sunDisc.lookAt(camera.position);
  E.sunDisc.material.opacity = 1 - d;
  E.sunDisc.material.color.setHex(dusk > 0.3 ? 0xffb070 : 0xffeeb0);
  E.moonDisc.position.copy(camera.position).addScaledVector(moonDir, 240);
  E.moonDisc.lookAt(camera.position);
  E.moonDisc.material.opacity = d;
  E.stars.material.opacity = clamp((d - 0.4) / 0.6, 0, 1);
  E.stars.position.copy(camera.position);
  E.sky.position.copy(camera.position);
  if (cave) {
    sun.intensity = 0;
    E.moonDisc.material.opacity = 0;
    E.stars.material.opacity = 0;
    E.ambient.intensity = 0.1;
    E.renderer.toneMappingExposure = 1.15;
  }
  const near = (x, z, r) => Math.abs(x - p.x) < r && Math.abs(z - p.z) < r;

  // ---- resource nodes ----
  const seen = new Set();
  for (const n of w.nodes) {
    seen.add(n.id);
    let o = E.nodeObjs.get(n.id);
    if (!o) {
      if (CHOPPABLE[n.type]) {
        o = makeTree(n);
        o.wasAlive = n.alive;
      } else o = { group: makeNode(n) };
      o.group.position.set(n.x, heightAt(n.x, n.z), n.z);
      E.world.add(o.group);
      E.nodeObjs.set(n.id, o);
    }
    if (CHOPPABLE[n.type]) {
      if (o.wasAlive && !n.alive) {
        o.falling = 0;
        o.fallAxis = new THREE.Vector3(Math.cos(n.fallDir), 0, -Math.sin(n.fallDir)).applyAxisAngle(new THREE.Vector3(0, 1, 0), -n.rot);
      }
      if (!o.wasAlive && n.alive) {
        o.falling = undefined;
        o.body.visible = true;
        o.body.quaternion.identity();
        o.body.position.y = 0;
      }
      o.wasAlive = n.alive;
      if (o.falling !== undefined) {
        o.falling += dt;
        const ft = o.falling;
        o.body.quaternion.setFromAxisAngle(o.fallAxis, Math.min(Math.PI / 2 - 0.08, 0.15 * ft + 1.6 * ft * ft));
        if (ft > 1.0 && !o.landed) {
          o.landed = true;
          const fx2 = n.x + Math.sin(n.fallDir) * 3 * n.scale;
          const fz2 = n.z + Math.cos(n.fallDir) * 3 * n.scale;
          emit(E, 'leaves', fx2, heightAt(fx2, fz2) + 0.6, fz2);
          emit(E, 'poof', fx2, heightAt(fx2, fz2) + 0.2, fz2, g.region === 'desert' ? 0xd8bf8a : 0xb8a98a, 14);
          g.shake = Math.max(g.shake, 0.4);
        }
        if (ft > 2.2) o.body.position.y = -(ft - 2.2) * 1.5;
        if (ft > 3.2) {
          o.body.visible = false;
          o.falling = undefined;
          o.landed = false;
        }
      } else if (n.alive) {
        o.body.visible = true;
        const s = n.shakeT > 0 ? Math.sin(t * 60) * 0.03 * (n.shakeT / 0.35) : 0;
        o.body.rotation.set(s, 0, s * 0.7);
        if (n.type === 'palm') o.body.rotation.z += Math.sin(t * 0.8 + n.x) * 0.02;
        o.group.scale.setScalar(n.scale * (n.grow < 1 ? 0.2 + 0.8 * n.grow : 1));
      }
      o.stump.visible = !n.alive || o.falling !== undefined;
      if (n.alive && o.falling === undefined) o.stump.visible = false;
    } else if (MINEABLE[n.type]) {
      o.group.userData.full.visible = n.alive;
      o.group.userData.rubble.visible = !n.alive;
      const s = n.shakeT > 0 ? Math.sin(t * 70) * 0.04 : 0;
      o.group.userData.full.position.x = s;
    } else {
      o.group.visible = n.alive || n.type === 'grass' || n.type === 'reeds' || n.type === 'bush';
      if (n.type === 'grass' || n.type === 'reeds') {
        o.group.userData.tall.visible = n.alive;
        o.group.userData.stub.visible = !n.alive;
        o.group.userData.tall.rotation.z = Math.sin(t * 1.5 + n.x) * 0.05;
      }
      if (n.type === 'bush') o.group.userData.berries.forEach((b, i) => (b.visible = n.alive && i < n.uses * 2));
      if (o.group.userData.update) o.group.userData.update(n, t, dt);
    }
  }
  for (const [id, o] of E.nodeObjs) {
    if (!seen.has(id)) {
      E.world.remove(o.group);
      E.nodeObjs.delete(id);
    }
  }

  // ---- buildings ----
  const liveB = new Set();
  for (const b of w.builds) {
    liveB.add(b.id);
    let o = E.buildObjs.get(b.id);
    if (!o) {
      let fireRig = null;
      let obj;
      if (b.type === 'fire') {
        fireRig = makeFire(true);
        obj = fireRig.g;
      } else obj = { shelter: makeShelter, hut: makeHut, wall: makeWall, furnace: makeFurnace, anvil: makeAnvil }[b.type]();
      obj.position.set(b.x, heightAt(b.x, b.z), b.z);
      obj.rotation.y = b.rot || 0;
      E.world.add(obj);
      o = { obj, fire: fireRig, bx: b.x };
      E.buildObjs.set(b.id, o);
    }
    o.obj.position.x = o.bx + (b.hitT > 0 ? Math.sin(t * 80) * 0.06 : 0); // shudder when struck
    if (o.fire) animateFire(o.fire, b.lit, b.fuel, t, d, dt);
    if (b.type === 'hut') o.obj.userData.roof.visible = !(g.sleeping && g.sleepAt === b.id); // peek inside while you sleep
    if (b.type === 'furnace') {
      const heat = b.activeT !== undefined ? clamp(1 - (t - b.activeT) / 8, 0, 1) : 0;
      o.obj.userData.glow.material.opacity = 0.22 + 0.7 * heat * (0.85 + 0.15 * Math.sin(t * 13));
      o.obj.userData.light.intensity = heat * (LEGACY_THREE ? 4 : 12);
    }
  }
  for (const [id, o] of E.buildObjs) {
    if (!liveB.has(id)) {
      E.world.remove(o.obj);
      E.buildObjs.delete(id);
    }
  }
  if (E.plotFlag) E.plotFlag.material.color.setHex(g.plotOwned ? 0x3a9a4a : 0xc0392b);
  if (cave) syncCave(E, g, dt, t);
  for (const f of E.campFires) animateFire(f, true, 120, t, d, dt);
  if (w.decor.ponds) w.decor.ponds.forEach((pd, i) => pd.mesh && (pd.mesh.material.emissive.setHex(Math.sin(t * 1.3 + i) > 0.6 ? 0x0e3450 : 0x0a2a40)));

  // ---- enemies ----
  const live = new Set();
  for (const e of w.enemies) {
    live.add(e.id);
    let o = E.enemyObjs.get(e.id);
    if (!o) {
      o = makeEnemyRig(e.type);
      E.world.add(o.root);
      if (e.dormant) {
        // a heap of bones, until it stands up
        o.bones = makeBonePile();
        o.bones.position.set(e.x, heightAt(e.x, e.z), e.z);
        o.bones.rotation.y = e.rot;
        E.world.add(o.bones);
      }
      E.enemyObjs.set(e.id, o);
    }
    if (o.bones) o.bones.visible = !!e.dormant;
    o.root.visible = near(e.x, e.z, 70) && !e.dormant;
    if (!o.root.visible) continue;
    const rise = e.riseT > 0 ? 1.7 * (e.riseT / 0.8) : 0;
    o.root.position.set(e.x, heightAt(e.x, e.z) + (e.hy || 0) - rise, e.z);
    o.root.rotation.y = e.rot;
    const D = ENEMIES[e.type];
    if (o.kind === 'human') {
      const kneel = e.pose === 'kneel';
      const action = kneel ? 'pickup' : e.state === 'windup' ? (D.ranged ? 'draw' : 'windup') : e.swingT > 0 ? (D.ranged ? 'shoot' : 'attack') : null;
      const q = kneel ? 0.5 : e.state === 'windup' ? 1 - e.t / (e.tMax || D.windup) : 1 - e.swingT / (D.boss ? 0.5 : 0.35);
      poseHuman(o, { moving: e.moving, speed: e.speedNow, walk: e.walk, action, q, hurt: e.hurtT > 0 ? e.hurtT / 0.3 : 0, bow: D.ranged }, dt, t);
      continue;
    }
    o.skin.color.setHex(e.hurtT > 0 ? 0xd46a6a : o.base);
    const mv = e.moving;
    if (o.kind === 'rat') {
      o.body.position.y = mv ? Math.abs(Math.sin(e.walk * 2)) * 0.04 : 0;
      o.body.rotation.x = e.swingT > 0 ? -0.3 : 0;
      o.legs.forEach((l, i) => (l.rotation.x = mv ? Math.sin(e.walk * 2 + (i % 2 ? Math.PI : 0) + (i > 1 ? Math.PI : 0)) * 0.7 : 0));
      o.tail.forEach((s, i) => (s.rotation.y = Math.sin(t * 6 + i * 0.8 + e.id) * 0.25));
      o.eyeMat.color.setHex(e.state === 'chase' && d > 0.3 ? 0xff2a2a : 0x111111);
    } else if (o.kind === 'scorpion') {
      const wind = e.state === 'windup' ? 1 - e.t / D.windup : 0;
      const strike = e.swingT > 0 ? e.swingT / 0.35 : 0;
      o.tail.forEach((s, i) => (s.rotation.x = -0.55 - wind * 0.25 + strike * (i > 2 ? 0.9 : 0.3) + Math.sin(t * 3 + i) * 0.03));
      o.legs.forEach((l, i) => (l.rotation.x = mv ? Math.sin(e.walk * 3 + i * 1.3) * 0.35 : 0));
      o.claws.forEach((c, i) => (c.rotation.y = (i ? -1 : 1) * (0.35 + wind * 0.4 - strike * 0.3)));
    } else if (o.kind === 'snake') {
      const wind = e.state === 'windup' ? 1 - e.t / D.windup : 0;
      const strike = e.swingT > 0 ? e.swingT / 0.35 : 0;
      o.segs.forEach((s, i) => {
        s.position.x = Math.sin(e.walk * 2 - i * 0.9 + t * (mv ? 0 : 1.5)) * (0.12 + i * 0.012);
        s.position.y = 0.08 + (i < 3 ? wind * (0.3 - i * 0.1) : 0);
      });
      o.head.position.set(o.segs[0].position.x, 0.1 + wind * 0.35, 0.18 + strike * 0.7);
      o.head.rotation.x = -wind * 0.5;
    } else if (o.kind === 'hare') {
      o.body.position.y = mv ? Math.abs(Math.sin(e.walk * 1.5)) * 0.18 : 0;
      o.body.rotation.x = mv ? -Math.sin(e.walk * 1.5) * 0.2 : 0;
    }
  }
  for (const [id, o] of E.enemyObjs) {
    if (!live.has(id)) {
      E.world.remove(o.root);
      if (o.bones) E.world.remove(o.bones);
      E.enemyObjs.delete(id);
    }
  }

  // ---- arrows, cursed bolts and soul orbs ----
  const liveA = new Set();
  for (const a of w.arrows) {
    liveA.add(a.id);
    let m = E.arrowObjs.get(a.id);
    if (!m) {
      m = new THREE.Group();
      if (a.kind) {
        const soul = a.kind === 'soul';
        m.add(new THREE.Mesh(geo(soul ? 'orbSoul' : 'orbBolt', () => new THREE.SphereGeometry(soul ? 0.24 : 0.17, 8, 6)), glowMat(soul ? 0xb0ffe0 : 0x9affb8, 0.95)));
        m.add(new THREE.Mesh(geo(soul ? 'haloSoul' : 'haloBolt', () => new THREE.SphereGeometry(soul ? 0.48 : 0.34, 8, 6)), glowMat(0x3aff7a, 0.3)));
      } else {
        m.add(mesh(geo('arrowShaft', () => new THREE.CylinderGeometry(0.015, 0.015, 0.75, 4).rotateX(Math.PI / 2)), M(0x8a6a42), 0, 0, 0, false));
        m.add(mesh(geo('arrowHead', () => new THREE.ConeGeometry(0.035, 0.1, 4).rotateX(Math.PI / 2)), M(0x555555), 0, 0, 0.42, false));
        m.add(mesh(geo('arrowFletch', () => new THREE.BoxGeometry(0.08, 0.005, 0.12)), M(0xe8e0d0), 0, 0, -0.32, false));
      }
      E.world.add(m);
      E.arrowObjs.set(a.id, m);
    }
    m.position.set(a.x, heightAt(a.x, a.z) + (a.y || 1.25), a.z);
    m.rotation.y = Math.atan2(a.vx, a.vz);
    if (a.kind) m.scale.setScalar(1 + Math.sin(t * 20 + a.id) * 0.12);
  }
  for (const [id, m] of E.arrowObjs) {
    if (!liveA.has(id)) {
      E.world.remove(m);
      E.arrowObjs.delete(id);
    }
  }

  // ---- npcs ----
  for (const n of w.npcs) {
    let o = E.npcObjs.get(n.id);
    if (!o) {
      const style = n.type === 'villager' ? `villager${n.variant % 3}` : n.type;
      o = makeHuman(style, n.type === 'chief' ? ['staff'] : []);
      if (o.tools.staff) o.tools.staff.visible = true;
      E.world.add(o.root);
      E.npcObjs.set(n.id, o);
    }
    o.root.position.set(n.x, heightAt(n.x, n.z), n.z);
    const close = dist2(n.x, n.z, p.x, p.z) < 6 && mode === 'play';
    const want = close ? Math.atan2(p.x - n.x, p.z - n.z) : n.rot;
    o.root.rotation.y = lerpAngle(o.root.rotation.y, want, k(5));
    poseHuman(o, { moving: n.moving, speed: 1.2, walk: n.walk, action: close && n.type !== 'villager' ? 'talk' : null, q: 0, hurt: 0, staff: n.type === 'chief' }, dt, t);
  }

  // ---- effects ----
  while (g.fx.length) {
    const f = g.fx.shift();
    emit(E, f.type, f.x, heightAt(f.x, f.z) + (f.y || 0), f.z, f.color, f.n);
  }
  for (const pt of E.parts) {
    if (pt.life <= 0) continue;
    pt.life -= dt;
    pt.vy -= pt.grav * dt;
    pt.m.position.x += pt.vx * dt;
    pt.m.position.y += pt.vy * dt;
    pt.m.position.z += pt.vz * dt;
    const gy = heightAt(pt.m.position.x, pt.m.position.z) + 0.03;
    if (pt.m.position.y < gy) {
      pt.m.position.y = gy;
      pt.vx *= 0.5;
      pt.vz *= 0.5;
      pt.vy = 0;
    }
    pt.m.rotation.x += pt.spin * dt;
    pt.m.rotation.y += pt.spin * dt;
    pt.m.material.opacity = clamp(pt.life / (pt.max * 0.4), 0, 1);
    if (pt.life <= 0) pt.m.visible = false;
  }

  // ---- player ----
  animatePlayer(E, g, dt, mode);

  // ---- target marker ----
  if (target && target.x !== undefined && mode === 'play' && !g.sleeping) {
    E.marker.visible = true;
    E.marker.position.set(target.x, heightAt(target.x, target.z) + target.y + Math.sin(t * 5) * 0.08, target.z);
    E.marker.rotation.y += dt * 2.5;
    E.marker.material.color.setHex(target.enabled ? 0xffd166 : 0xff7b6b);
  } else E.marker.visible = false;

  // ---- camera ----
  const Cm = E.cam;
  let want;
  if (mode === 'title') {
    Cm.yaw += dt * 0.05;
    Cm.pitch = 0.3;
    Cm.dist = 5.5;
    want = new THREE.Vector3(0, 2.2, 0);
  } else if (g.sleeping) {
    Cm.yaw += dt * 0.08;
    Cm.pitch = lerp(Cm.pitch, 0.55, k(2));
    Cm.dist = lerp(Cm.dist, 8, k(2));
    want = new THREE.Vector3(p.x, heightAt(p.x, p.z) + 0.8, p.z);
  } else {
    Cm.dist = lerp(Cm.dist, 6.2, k(3));
    if (p.moving && t - Cm.lastDrag > 1.6) {
      const behind = p.rot + Math.PI;
      if (Math.abs(angDiff(behind, Cm.yaw)) < 2.3) Cm.yaw = lerpAngle(Cm.yaw, behind, k(0.9));
    }
    want = new THREE.Vector3(p.x, heightAt(p.x, p.z) + 1.45, p.z);
    if (cave) Cm.pitch = Math.max(Cm.pitch, 0.62); // look down over the cave walls
  }
  Cm.target.lerp(want, mode === 'title' ? 1 : k(9));
  let dist = Cm.dist;
  const dirX = Math.sin(Cm.yaw) * Math.cos(Cm.pitch);
  const dirY = Math.sin(Cm.pitch);
  const dirZ = Math.cos(Cm.yaw) * Math.cos(Cm.pitch);
  if (mode === 'play') {
    const hl = Math.hypot(dirX, dirZ) || 1;
    const block = (ox, oz, r) => {
      const along = (ox * dirX + oz * dirZ) / hl;
      if (along < 0.6 || along > dist * hl) return;
      const perp = Math.abs(ox * dirZ - oz * dirX) / hl;
      if (perp < r) dist = Math.min(dist, along / hl - 0.4);
    };
    for (const n of w.nodes) if (CHOPPABLE[n.type] && n.alive) block(n.x - Cm.target.x, n.z - Cm.target.z, 0.55 * n.scale);
    for (const o of w.staticObs) if (o.big) block(o.x - Cm.target.x, o.z - Cm.target.z, o.r + 0.3);
    if (GRID) {
      // keep the camera out of the rock: stop short of any wall taller than the camera line,
      // and tilt up over the walls when they crowd in
      for (let s = 0.8; s < dist; s += 0.35) {
        const i = cellIdx(GRID, Cm.target.x + dirX * s, Cm.target.z + dirZ * s);
        const h = i < 0 ? 99 : GRID.wallH[i];
        if (h > Cm.target.y + dirY * s - 0.4) {
          dist = Math.min(dist, s - 0.45);
          break;
        }
      }
      if (dist < Cm.dist * 0.75) Cm.pitch = lerp(Cm.pitch, 1.1, k(3));
    }
  }
  dist = Math.max(1.6, dist);
  const cx = Cm.target.x + dirX * dist;
  const cz = Cm.target.z + dirZ * dist;
  const cy = Math.max(Cm.target.y + dirY * dist, heightAt(cx, cz) + 0.6);
  const sh = g.shake * g.shake * 0.25;
  camera.position.set(cx + (Math.random() - 0.5) * sh, cy + (Math.random() - 0.5) * sh, cz + (Math.random() - 0.5) * sh);
  camera.lookAt(Cm.target);
}

function poseHuman(R, s, dt, t) {
  const P = { hipL: 0, hipR: 0, knL: 0.05, knR: 0.05, shL: 0, shR: 0, shLz: 0.1, shRz: -0.1, elL: -0.15, elR: -0.15, torsoX: 0, torsoY: 0, headX: 0, hipsY: 0 };
  const run = clamp((s.speed - 2.2) / 3, 0, 1);
  if (s.moving) {
    const ph = s.walk;
    const amp = 0.42 + run * 0.4;
    P.hipL = -Math.sin(ph) * amp;
    P.hipR = Math.sin(ph) * amp;
    P.knL = 0.1 + Math.max(0, Math.sin(ph - 1.3)) * (0.7 + run * 0.7);
    P.knR = 0.1 + Math.max(0, -Math.sin(ph - 1.3)) * (0.7 + run * 0.7);
    P.shL = Math.sin(ph) * amp * 0.9;
    P.shR = -Math.sin(ph) * amp * 0.9;
    P.elL = P.elR = -0.25 - run * 1.0;
    P.hipsY = -Math.abs(Math.cos(ph)) * (0.03 + 0.05 * run);
    P.torsoX = 0.05 + run * 0.16;
    P.torsoY = Math.sin(ph) * 0.06;
  } else {
    P.torsoX = Math.sin(t * 1.7) * 0.02;
    P.shL = Math.sin(t * 1.7) * 0.03;
    P.shR = -Math.sin(t * 1.7) * 0.03;
  }
  if (s.shield) {
    P.shL = -0.35 + P.shL * 0.3;
    P.elL = -1.25;
    P.shLz = 0.05;
  }
  let spin = 0;
  if (s.action) {
    const q = clamp(s.q, 0, 1);
    const env = Math.sin(Math.PI * q);
    switch (s.action) {
      case 'chop':
      case 'mine':
      case 'smith': {
        const a = q < 0.5 ? lerp(-0.5, -2.9, Math.sin((q / 0.5) * Math.PI * 0.5)) : lerp(-2.9, s.action !== 'chop' ? -0.7 : -0.95, Math.pow((q - 0.5) / 0.5, 0.6));
        P.shR = a;
        P.shL = a + 0.15;
        P.shRz = 0.32;
        P.shLz = -0.32;
        P.elR = P.elL = -0.25;
        P.torsoX = q < 0.5 ? -0.18 : s.action !== 'chop' ? 0.45 : 0.28;
        P.hipsY = -0.06 * env;
        P.knL = P.knR = 0.25 * env;
        break;
      }
      case 'attack': {
        const a = q < 0.38 ? lerp(-0.4, -2.6, q / 0.38) : lerp(-2.6, -0.5, Math.pow((q - 0.38) / 0.62, 0.6));
        P.shR = a;
        P.shRz = q < 0.38 ? -0.6 : lerp(-0.6, 0.45, (q - 0.38) / 0.62);
        P.elR = -0.3;
        P.torsoY = q < 0.38 ? 0.45 : lerp(0.45, -0.55, (q - 0.38) / 0.62);
        P.torsoX = 0.12;
        if (!s.shield) P.shL = -0.4;
        break;
      }
      case 'windup':
        P.shR = -2.8;
        P.shRz = -0.5;
        P.elR = -0.5;
        P.torsoY = 0.45;
        P.torsoX = -0.15;
        P.knL = P.knR = 0.25;
        P.hipsY = -0.05;
        break;
      case 'draw':
        P.shL = -1.55;
        P.shLz = -0.1;
        P.elL = 0;
        P.shR = -1.45;
        P.shRz = 0.3;
        P.elR = -1.2 - 0.8 * q;
        P.torsoY = 0.35;
        break;
      case 'shoot':
        P.shL = -1.55;
        P.elL = 0;
        P.shR = -1.2;
        P.elR = -0.3;
        P.torsoY = 0.35;
        break;
      case 'pickup':
        P.hipsY = -0.32 * env;
        P.hipL = P.hipR = -0.85 * env;
        P.knL = P.knR = 1.5 * env;
        P.torsoX = 0.5 * env;
        P.shR = -1.1 * env;
        P.shL = -0.3 * env;
        P.headX = 0.3 * env;
        break;
      case 'eat':
      case 'drink':
        P.shR = -2.1 * env;
        P.shRz = 0.4 * env;
        P.elR = -1.7 * env;
        P.headX = -0.15 * env;
        break;
      case 'dodge':
        P.hipsY = -0.45 * env;
        P.hipL = P.hipR = -1.0 * env;
        P.knL = P.knR = 1.6 * env;
        P.torsoX = 0.8 * env;
        P.shL = P.shR = -0.9 * env;
        spin = Math.PI * 2 * q;
        break;
      case 'talk':
        P.shL = -0.7 + Math.sin(t * 5) * 0.25;
        P.elL = -0.9;
        P.shLz = 0.2;
        if (s.staff) {
          P.shR = -0.3;
          P.elR = -0.6;
        }
        break;
      default:
        break;
    }
  }
  if (s.hurt) {
    P.torsoX -= 0.3 * s.hurt;
    P.headX -= 0.2 * s.hurt;
  }
  const kk = 1 - Math.exp(-dt * (s.action ? 28 : 14));
  const S = R.pose;
  for (const key in P) S[key] = S[key] === undefined ? P[key] : lerp(S[key], P[key], kk);
  R.hipL.rotation.x = S.hipL;
  R.hipR.rotation.x = S.hipR;
  R.knL.rotation.x = S.knL;
  R.knR.rotation.x = S.knR;
  R.shL.rotation.set(S.shL, 0, S.shLz);
  R.shR.rotation.set(S.shR, 0, S.shRz);
  R.elL.rotation.x = S.elL;
  R.elR.rotation.x = S.elR;
  R.torso.rotation.set(S.torsoX, S.torsoY, 0);
  R.head.rotation.x = S.headX;
  R.hips.position.y = 0.92 + S.hipsY;
  R.hips.rotation.x = spin;
}

function animatePlayer(E, g, dt, mode) {
  const R = E.player;
  const p = g.player;
  R.root.visible = mode !== 'title';
  if (mode === 'title') return;
  const showTool = p.action === 'chop' ? 'axe' : p.action === 'mine' ? 'pickaxe' : p.action === 'smith' ? 'hammer' : weapon(g);
  for (const key of ['axe', 'club', 'pickaxe', 'hammer', 'dagger', 'sword', 'mace', 'khopesh', 'spear']) R.tools[key].visible = key === showTool && !g.sleeping;
  for (const k of Object.keys(R.armor)) R.armor[k].forEach((m) => (m.visible = !!g.tools[k]));
  R.tools.shield.visible = !!g.tools.shield && !g.sleeping;
  const q = p.action ? 1 - p.actionT / p.actionDur : 0;
  poseHuman(R, { moving: p.moving, speed: p.speed, walk: p.walk, action: p.action, q, hurt: p.hurtT > 0 ? p.hurtT / 0.4 : 0, shield: !!g.tools.shield && !p.action }, dt, g.time);
  const sleepSpot = g.sleeping ? g.w.builds.find((b) => b.id === g.sleepAt) : null;
  if (sleepSpot) {
    const s = sleepSpot;
    const back = s.type === 'hut' ? 0.5 : 0.8;
    const bx = s.x - Math.sin(s.rot) * back;
    const bz = s.z - Math.cos(s.rot) * back;
    const hx = Math.cos(s.rot);
    const hz = -Math.sin(s.rot);
    R.root.position.set(bx - hx * 0.85, heightAt(bx, bz) + 0.3, bz - hz * 0.85);
    R.root.rotation.set(-Math.PI / 2, s.rot - Math.PI / 2, 0, 'YXZ');
  } else {
    R.root.position.set(p.x, heightAt(p.x, p.z), p.z);
    R.root.rotation.set(0, p.rot, 0);
  }
}

/* =====================================================================
   UI
   ===================================================================== */
function StatBar({ icon, value, color }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statIcon}>{icon}</Text>
      <View style={styles.barBg}>
        <View style={[styles.barFill, { width: `${clamp(value, 0, 100)}%`, backgroundColor: color }]} />
      </View>
    </View>
  );
}

function Panel({ title, onClose, children }) {
  return (
    <View style={styles.overlay}>
      <View style={styles.panel}>
        <View style={styles.panelHead}>
          <Text style={styles.panelTitle}>{title}</Text>
          <Pressable onPress={onClose} hitSlop={12} style={styles.closeBtn}>
            <Text style={styles.closeTxt}>✕</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={{ paddingBottom: 12 }}>{children}</ScrollView>
        <Text style={styles.paused}>Game paused</Text>
      </View>
    </View>
  );
}

const KIND_TITLES = { tool: 'Tools', material: 'Materials', build: 'Build' };
function CraftPanel({ g, onCraft, onClose }) {
  return (
    <Panel title="Craft & Build" onClose={onClose}>
      {g.region === 'desert' && (
        <Text style={[styles.cardDesc, styles.warnTxt]}>
          {g.plotOwned
            ? '🏡 Build on your plot north of the village to stay safe. Anything built out in the desert is raided by marauders every night.'
            : `⚔️ Marauders raid anything built out in the desert every night. Buy the plot beside the village (${PLOT.price} gold, from Chief Soloman) to build safely.`}
        </Text>
      )}
      {['tool', 'material', 'build'].map((kind) => (
        <View key={kind}>
          <Text style={styles.section}>{KIND_TITLES[kind]}</Text>
          {RECIPES.filter((r) => r.kind === kind).map((r) => {
            const ok = canAfford(g, r.cost);
            const owned = r.kind === 'tool' && !!g.tools[r.id];
            return (
              <View key={r.id} style={styles.card}>
                <View style={styles.row}>
                  <View style={styles.iconBox}>
                    <Text style={styles.iconTxt}>{r.icon}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.cardTitle}>{r.name}</Text>
                    <Text style={styles.cardDesc}>{r.desc}</Text>
                  </View>
                </View>
                <View style={[styles.row, { flexWrap: 'wrap', marginTop: 8 }]}>
                  {Object.entries(r.cost).map(([k, v]) => (
                    <View key={k} style={styles.chip}>
                      <Text>{ITEMS[k].icon}</Text>
                      <Text style={[styles.chipTxt, { color: (g.inv[k] || 0) >= v ? '#9fe08a' : '#ff8a80' }]}>
                        {g.inv[k] || 0}/{v}
                      </Text>
                    </View>
                  ))}
                </View>
                <Pressable
                  disabled={!ok || owned}
                  onPress={() => {
                    onCraft(r.id);
                    onClose();
                  }}
                  style={[styles.craftBtn, (!ok || owned) && styles.disabled]}
                >
                  <Text style={styles.craftTxt}>{owned ? 'Owned' : r.kind === 'build' ? 'Build here' : 'Craft'}</Text>
                </Pressable>
              </View>
            );
          })}
        </View>
      ))}
    </Panel>
  );
}

function toolStats(k) {
  const T = TOOLS[k];
  if (T.kind === 'weapon') return `${T.dmg} damage · ${(1 / Math.max(T.swing, T.cd)).toFixed(1)} hits/s${T.stagger ? ' · staggers' : ''}`;
  if (T.kind === 'armor') return `-${Math.round(T.armor * 100)}% damage taken`;
  if (k === 'shield') return 'Blocks most of a frontal hit, and all arrows';
  return T.desc || '';
}
function BagPanel({ g, onEat, onDrink, onEquip, onClose }) {
  const items = Object.keys(ITEMS).filter((k) => g.inv[k] > 0 && k !== 'water');
  const tools = Object.keys(g.tools);
  return (
    <Panel title="Bag" onClose={onClose}>
      <View style={[styles.card, styles.row]}>
        <View style={styles.iconBox}>
          <Text style={styles.iconTxt}>🪙</Text>
        </View>
        <Text style={[styles.cardTitle, { flex: 1 }]}>{g.gold} gold</Text>
      </View>
      {g.tools.waterskin && (
        <View style={[styles.card, styles.row]}>
          <View style={styles.iconBox}>
            <Text style={styles.iconTxt}>💧</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.cardTitle}>
              Waterskin {g.inv.water}/{WATERSKIN_CAP}
            </Text>
            <Text style={styles.cardDesc}>+35 thirst per sip. Refill at an oasis.</Text>
          </View>
          <Pressable disabled={g.inv.water <= 0} onPress={onDrink} style={[styles.eatBtn, g.inv.water <= 0 && styles.disabled]}>
            <Text style={styles.craftTxt}>Drink</Text>
          </Pressable>
        </View>
      )}
      {armorValue(g) > 0 && (
        <Text style={[styles.cardDesc, { marginBottom: 6 }]}>🛡️ Armor absorbs {Math.round(armorValue(g) * 100)}% of every hit.</Text>
      )}
      {tools.filter((k) => k !== 'waterskin').length > 0 && <Text style={styles.section}>Gear</Text>}
      {tools
        .filter((k) => k !== 'waterskin')
        .map((k) => {
          const T = TOOLS[k];
          const held = weapon(g) === k;
          return (
            <View key={k} style={[styles.card, styles.row]}>
              <View style={styles.iconBox}>
                <Text style={styles.iconTxt}>{T.icon}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.cardTitle}>{T.name}</Text>
                <View style={[styles.barBg, { marginTop: 6 }]}>
                  <View style={[styles.barFill, { width: `${(100 * g.tools[k].dur) / T.maxDur}%`, backgroundColor: '#c9b16a' }]} />
                </View>
                <Text style={styles.cardDesc}>
                  Durability {g.tools[k].dur}/{T.maxDur} · {toolStats(k)}
                </Text>
              </View>
              {T.kind === 'weapon' && (
                <Pressable disabled={held} onPress={() => onEquip(k)} style={[styles.eatBtn, held && styles.equipped]}>
                  <Text style={styles.craftTxt}>{held ? 'In hand' : 'Equip'}</Text>
                </Pressable>
              )}
              {(T.kind === 'armor' || k === 'shield') && <Text style={styles.wornTxt}>Worn</Text>}
            </View>
          );
        })}
      <Text style={styles.section}>Items</Text>
      {items.length === 0 && <Text style={styles.cardDesc}>Your pack is empty.</Text>}
      {items.map((k) => {
        const food = ITEMS[k].food;
        return (
          <View key={k} style={[styles.card, styles.row]}>
            <View style={styles.iconBox}>
              <Text style={styles.iconTxt}>{ITEMS[k].icon}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardTitle}>
                {ITEMS[k].name} × {g.inv[k]}
              </Text>
              {food && (
                <Text style={styles.cardDesc}>
                  +{food.hunger} food{food.thirst ? ` · +${food.thirst} thirst` : ''}
                  {food.heal ? ` · +${food.heal} health` : ''}
                  {food.sick ? ' · will make you sick' : food.risk ? ' · might be poisonous' : ''}
                </Text>
              )}
            </View>
            {food && (
              <Pressable onPress={() => onEat(k)} style={styles.eatBtn}>
                <Text style={styles.craftTxt}>Eat</Text>
              </Pressable>
            )}
          </View>
        );
      })}
    </Panel>
  );
}

function GoalsPanel({ g, onClose }) {
  const list = objectives(g);
  const current = currentObjective(g);
  const camp = campRemaining(g);
  return (
    <Panel title={g.level === 1 ? 'Level 1 · The Forest' : 'Level 2 · The Desert'} onClose={onClose}>
      {list.map((o, i) => (
        <View key={o.id} style={[styles.goal, current === o && styles.goalCurrent]}>
          <Text style={[styles.goalTxt, g.done[o.id] && styles.goalDone]}>
            {g.done[o.id] ? '✓' : `${i + 1}.`} {o.text}
          </Text>
          {current === o && <Text style={styles.cardDesc}>{o.tip}</Text>}
        </View>
      ))}
      {g.level === 2 && (
        <View style={{ marginTop: 8 }}>
          <Text style={styles.section}>Side goals</Text>
          {SIDE_GOALS.map((o) => (
            <View key={o.id} style={styles.goal}>
              <Text style={[styles.goalTxt, g.done[o.id] && styles.goalDone]}>
                {g.done[o.id] ? '✓' : '○'} {o.text}
              </Text>
              {!g.done[o.id] && <Text style={styles.cardDesc}>{o.tip}</Text>}
            </View>
          ))}
        </View>
      )}
      {g.quest && (
        <View style={[styles.card, { marginTop: 10 }]}>
          <Text style={styles.cardTitle}>📜 Quest: Chronic Dehydration</Text>
          <Text style={styles.cardDesc}>
            Marauders left in the camp: {camp.marauders} · King: {camp.king ? 'alive' : 'defeated'}
          </Text>
        </View>
      )}
      <Text style={[styles.cardDesc, { marginTop: 10 }]}>
        {g.level === 1
          ? 'Watch your food, energy and warmth. Cook meat before eating it. Rats keep away from a lit fire.'
          : 'In the desert, thirst drains fast in the midday sun; shade at the village, the oasis or your hut slows it. Dodge (Shift / the ↻ button) makes you briefly untouchable.'}
      </Text>
    </Panel>
  );
}

function ShopPanel({ g, onBuy, onSell, onClose }) {
  const nameOf = (o) => (o.tool ? TOOLS[o.id].name : ITEMS[o.id].name);
  const iconOf = (o) => (o.tool ? TOOLS[o.id].icon : ITEMS[o.id].icon);
  return (
    <Panel title="Merchant" onClose={onClose}>
      <Text style={styles.dialog}>{'"Gold for goods, goods for gold. Bronze is dear out here, friend."'}</Text>
      <View style={[styles.goldPill]}>
        <Text style={styles.goldTxt}>🪙 {g.gold} gold</Text>
      </View>
      <Text style={styles.section}>Buy</Text>
      {SHOP.buy.map((o) => {
        const owned = o.tool && !!g.tools[o.id];
        const ok = g.gold >= o.price && !owned;
        return (
          <View key={'b' + o.id} style={[styles.card, styles.row]}>
            <View style={styles.iconBox}>
              <Text style={styles.iconTxt}>{iconOf(o)}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardTitle}>{nameOf(o)}</Text>
              <Text style={styles.cardDesc}>
                {o.price} gold{o.id === 'sword' ? ' · 6 damage, fast swings' : o.id === 'shield' ? ' · blocks frontal hits and arrows' : ` · you have ${g.inv[o.id]}`}
              </Text>
            </View>
            <Pressable disabled={!ok} onPress={() => onBuy(o.id)} style={[styles.eatBtn, !ok && styles.disabled]}>
              <Text style={styles.craftTxt}>{owned ? 'Owned' : 'Buy'}</Text>
            </Pressable>
          </View>
        );
      })}
      <Text style={styles.section}>Sell</Text>
      {SHOP.sell.map((o) => {
        const ok = g.inv[o.id] > 0;
        return (
          <View key={'s' + o.id} style={[styles.card, styles.row]}>
            <View style={styles.iconBox}>
              <Text style={styles.iconTxt}>{iconOf(o)}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardTitle}>{nameOf(o)}</Text>
              <Text style={styles.cardDesc}>
                {o.price} gold each · you have {g.inv[o.id]}
              </Text>
            </View>
            <Pressable disabled={!ok} onPress={() => onSell(o.id)} style={[styles.eatBtn, !ok && styles.disabled]}>
              <Text style={styles.craftTxt}>Sell</Text>
            </Pressable>
          </View>
        );
      })}
    </Panel>
  );
}

function ChiefPanel({ g, onAccept, onTurnIn, onBuyPlot, onClose }) {
  const st = chiefState(g);
  const camp = campRemaining(g);
  const lines = {
    intro:
      'Traveler, you come to us in our darkest hour. Marauders have cut off the trade routes to the eastern oasis and will not let us near any water in the entire region. Our scouts die of exposure every time we send them to find water anywhere else. The village is on rations and will not last much longer. Wipe out the marauder camp and defeat their king. I beg you.',
    active: `The marauders still hold the eastern oasis. ${camp.marauders} of them remain in the camp${camp.king ? ', and their king still lives' : ''}. Forge bronze weapons and armor, or buy them from the merchant, and mind their archers.`,
    ready: 'You have done it! The camp is broken and their king has fallen. Our people will drink tonight.',
    done: 'The children are laughing again. You will always have a home here, friend.',
  };
  return (
    <Panel title="Chief Soloman" onClose={onClose}>
      <Text style={styles.dialog}>{`"${lines[st]}"`}</Text>
      {(st === 'intro' || st === 'active' || st === 'ready') && (
        <View style={[styles.card, { marginTop: 10 }]}>
          <Text style={styles.cardTitle}>📜 Chronic Dehydration</Text>
          <Text style={styles.cardDesc}>
            {g.done.camp ? '✓' : '○'} Wipe out the marauder camp ({Math.max(0, camp.marauders)} left)
          </Text>
          <Text style={styles.cardDesc}>{g.done.king ? '✓' : '○'} Defeat the Marauder King</Text>
          <Text style={styles.cardDesc}>{"Reward: 200 gold and the village's gratitude"}</Text>
        </View>
      )}
      {st === 'intro' && (
        <Pressable onPress={onAccept} style={styles.craftBtn}>
          <Text style={styles.craftTxt}>Accept the quest</Text>
        </Pressable>
      )}
      {st === 'ready' && (
        <Pressable onPress={onTurnIn} style={styles.craftBtn}>
          <Text style={styles.craftTxt}>Report back</Text>
        </Pressable>
      )}
      <View style={[styles.card, { marginTop: 12 }]}>
        <Text style={styles.cardTitle}>🏡 Land beside the village</Text>
        {g.plotOwned ? (
          <Text style={styles.cardDesc}>The fenced plot north of the village is yours. Marauders never come near it, so anything you build there is safe.</Text>
        ) : (
          <>
            <Text style={styles.cardDesc}>
              {`"There is a fenced plot just north of the village, room enough for a house, a fire, a furnace and an anvil. Marauders never come near our walls. It is yours for ${PLOT.price} gold."`}
            </Text>
            <Text style={styles.cardDesc}>Build anywhere else and marauders will raid your camp every night.</Text>
            <Pressable disabled={g.gold < PLOT.price} onPress={onBuyPlot} style={[styles.craftBtn, g.gold < PLOT.price && styles.disabled]}>
              <Text style={styles.craftTxt}>
                Buy the land · {PLOT.price} gold (you have {g.gold})
              </Text>
            </Pressable>
          </>
        )}
      </View>
    </Panel>
  );
}

function ScenarioPanel({ onPick, onClose }) {
  return (
    <Panel title="🧪 Playtest shortcuts" onClose={onClose}>
      <Text style={styles.cardDesc}>Jump straight to any part of the game. Turn these off by setting PLAYTEST = false at the top of App.js.</Text>
      {SCENARIOS.map((sc) => (
        <Pressable key={sc.id} onPress={() => onPick(sc.id)} style={({ pressed }) => [styles.card, { marginTop: 8 }, pressed && styles.pressed]}>
          <Text style={styles.cardTitle}>{sc.title}</Text>
          <Text style={styles.cardDesc}>{sc.desc}</Text>
        </Pressable>
      ))}
    </Panel>
  );
}

function DevPanel({ g, onCheat, onWarp, onClose }) {
  return (
    <Panel title="🧪 Playtest tools" onClose={onClose}>
      <Text style={styles.section}>Cheats</Text>
      <View style={styles.devGrid}>
        {CHEATS.map((c) => (
          <Pressable key={c.id} onPress={() => onCheat(c.id)} style={({ pressed }) => [styles.devBtn, c.id === 'god' && g.god && styles.devOn, pressed && styles.pressed]}>
            <Text style={styles.devTxt}>{c.id === 'god' ? `God mode: ${g.god ? 'ON' : 'off'}` : c.label}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={styles.section}>Warp to</Text>
      <View style={styles.devGrid}>
        {WARPS.map((wp) => (
          <Pressable key={wp.id} onPress={() => onWarp(wp.id)} style={({ pressed }) => [styles.devBtn, pressed && styles.pressed]}>
            <Text style={styles.devTxt}>{wp.label}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={[styles.cardDesc, { marginTop: 8 }]}>
        Day {g.day} · {clockText(g.tod)} · {REGIONS[g.region].name} · ({g.player.x.toFixed(1)}, {g.player.z.toFixed(1)})
      </Text>
    </Panel>
  );
}

function FurnacePanel({ g, onSmelt, onClose }) {
  const pairs = Math.min(g.inv.copper, g.inv.tin);
  return (
    <Panel title="Furnace" onClose={onClose}>
      <Text style={styles.dialog}>Melt copper and tin together into bronze. Each bar takes 1 copper ore and 1 tin ore, and about 1 in 5 molds cracks.</Text>
      <View style={[styles.row, { flexWrap: 'wrap', marginVertical: 8 }]}>
        {[['copper', g.inv.copper], ['tin', g.inv.tin], ['bronzeBar', g.inv.bronzeBar]].map(([k, v]) => (
          <View key={k} style={styles.chip}>
            <Text>{ITEMS[k].icon}</Text>
            <Text style={[styles.chipTxt, { color: '#f4efe3' }]}>
              {ITEMS[k].name}: {v}
            </Text>
          </View>
        ))}
      </View>
      <Text style={styles.cardDesc}>Success rate: {Math.round(SMELT_CHANCE * 100)}%</Text>
      <Pressable disabled={pairs < 1} onPress={() => onSmelt(false)} style={[styles.craftBtn, pairs < 1 && styles.disabled]}>
        <Text style={styles.craftTxt}>Smelt 1 bar</Text>
      </Pressable>
      <Pressable disabled={pairs < 2} onPress={() => onSmelt(true)} style={[styles.craftBtn, pairs < 2 && styles.disabled]}>
        <Text style={styles.craftTxt}>Smelt all ({pairs})</Text>
      </Pressable>
      {pairs < 1 && <Text style={[styles.cardDesc, { marginTop: 8 }]}>Mine copper (orange veins) and tin (silver veins) near the mesas.</Text>}
    </Panel>
  );
}

function AnvilPanel({ g, onForge, onClose }) {
  return (
    <Panel title="Anvil" onClose={onClose}>
      <View style={[styles.row, { marginBottom: 8 }]}>
        <View style={styles.chip}>
          <Text>{ITEMS.bronzeBar.icon}</Text>
          <Text style={[styles.chipTxt, { color: '#f4efe3' }]}>Bronze bars: {g.inv.bronzeBar}</Text>
        </View>
        <View style={styles.chip}>
          <Text>🔨</Text>
          <Text style={[styles.chipTxt, { color: '#f4efe3' }]}>Hammer {g.tools.hammer ? `${g.tools.hammer.dur}/${TOOLS.hammer.maxDur}` : 'missing'}</Text>
        </View>
      </View>
      {FORGE.map((f) => {
        const T = TOOLS[f.id];
        const owned = !!g.tools[f.id];
        const ok = !owned && g.inv.bronzeBar >= f.bars && !!g.tools.hammer;
        return (
          <View key={f.id} style={[styles.card, styles.row]}>
            <View style={styles.iconBox}>
              <Text style={styles.iconTxt}>{T.icon}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardTitle}>{T.name}</Text>
              <Text style={styles.cardDesc}>
                {f.bars} bars · {toolStats(f.id)} · lasts {T.maxDur}
              </Text>
            </View>
            <Pressable disabled={!ok} onPress={() => onForge(f.id)} style={[styles.eatBtn, !ok && styles.disabled]}>
              <Text style={styles.craftTxt}>{owned ? 'Owned' : 'Forge'}</Text>
            </Pressable>
          </View>
        );
      })}
    </Panel>
  );
}

function Minimap({ g, big, size, onToggle }) {
  const w = g.w;
  const p = g.player;
  const R = w.r + 4;
  const s = size / 2 / R;
  const pos = (x, z) => ({ left: size / 2 + x * s, top: size / 2 + z * s });
  const dot = (key, x, z, d, color, extra) => <View key={key} style={[styles.mmDot, pos(x, z), { width: d, height: d, marginLeft: -d / 2, marginTop: -d / 2, borderRadius: d / 2, backgroundColor: color }, extra]} />;
  const marks = [];
  if (g.region === 'forest') {
    w.nodes.forEach((n) => n.type === 'tree' && n.alive && marks.push(dot('t' + n.id, n.x, n.z, big ? 5 : 3, '#1f4a22')));
    w.rocks.forEach((r, i) => marks.push(dot('r' + i, r.x, r.z, big ? 5 : 3, '#8d8d86')));
  } else if (g.region === 'cave') {
    // rooms as ovals and passages as rotated bars, traced from the same layout the cave was carved from
    const floorC = '#7a6448';
    Object.entries(CAVE_ROOMS).forEach(([key, [X, Y, RX, RY]]) => {
      const [x, z] = CPX(X, Y);
      const rx = RX / 8;
      const rz = RY / 8;
      marks.push(<View key={'cr' + key} style={[styles.mmDot, pos(x - rx, z - rz), { width: rx * 2 * s, height: rz * 2 * s, borderRadius: Math.max(rx, rz) * s, backgroundColor: floorC }]} />);
    });
    CAVE_PATHS.forEach((pa, j) =>
      pa.pts.slice(1).forEach((pt, i) => {
        const [ax, az] = CPX(...pa.pts[i]);
        const [bx, bz] = CPX(...pt);
        const wd = (pa.w / 8) * s;
        const len = Math.hypot(bx - ax, bz - az) * s + wd;
        const m = pos((ax + bx) / 2, (az + bz) / 2);
        marks.push(<View key={`cp${j}_${i}`} style={[styles.mmDot, { left: m.left - len / 2, top: m.top - wd / 2, width: len, height: wd, backgroundColor: floorC, transform: [{ rotate: `${Math.atan2(bz - az, bx - ax)}rad` }] }]} />);
      }),
    );
    w.decor.ponds.forEach((pd, i) => marks.push(dot('p' + i, pd.x, pd.z, pd.r * 1.6 * s, '#2f86c0')));
    w.doors.forEach((dr) => !dr.open && marks.push(dot('d' + dr.id, dr.x, dr.z, big ? 9 : 5, '#c9a24a', { borderRadius: 1 })));
    w.nodes.forEach((n) => {
      if (n.type === 'lever') marks.push(dot('lv' + n.id, n.x, n.z, big ? 8 : 5, n.pulled ? '#6ad06a' : '#ffd166'));
      if (n.type === 'chest') marks.push(dot('ch' + n.id, n.x, n.z, big ? 8 : 5, n.opened ? '#8a7a5a' : '#ffb020', { borderRadius: 1 }));
      if (n.type === 'drop' && n.item === 'goldenKey') marks.push(dot('key', n.x, n.z, big ? 9 : 6, '#ffe066'));
    });
  } else {
    w.decor.mesas.forEach((m, i) => marks.push(dot('m' + i, m.x, m.z, m.r * 2 * s, '#a8653f')));
    w.decor.ponds.forEach((pd, i) => marks.push(dot('p' + i, pd.x, pd.z, pd.r * 2 * s + 2, '#2f86c0')));
    const V = DESERT.village;
    marks.push(dot('village', V.x, V.z, V.r * 2 * s, 'rgba(120,80,40,0.35)', { borderWidth: 1, borderColor: '#8a5a32' }));
    w.decor.houses.forEach((h, i) => marks.push(dot('h' + i, h.x, h.z, big ? 7 : 4, '#c9a06a')));
    const C = DESERT.camp;
    marks.push(dot('camp', C.x, C.z, C.r * 2 * s, 'rgba(140,30,30,0.25)', { borderWidth: 1.5, borderColor: '#b23a2a' }));
  }
  w.nodes.forEach((n) => {
    if (n.type === 'trail' || n.type === 'caveexit') marks.push(dot('trail' + n.id, n.x, n.z, big ? 9 : 6, '#f2e6c8', { borderWidth: 1, borderColor: '#5a4030' }));
    if (n.type === 'cavemouth' && g.caveSeen) marks.push(dot('cave' + n.id, n.x, n.z, big ? 11 : 7, '#1a120c', { borderWidth: 1.5, borderColor: '#e9c46a' }));
  });
  if (g.region === 'desert') {
    const side = PLOT.half * 2 * s;
    marks.push(<View key="plot" style={[styles.mmDot, pos(PLOT.x - PLOT.half, PLOT.z - PLOT.half), { width: side, height: side, borderWidth: 1.5, borderColor: g.plotOwned ? '#3a9a4a' : '#8a5a32', backgroundColor: g.plotOwned ? 'rgba(58,154,74,0.25)' : 'rgba(138,90,50,0.15)' }]} />);
  }
  w.builds.forEach((b) => marks.push(dot('b' + b.id, b.x, b.z, big ? 7 : 5, b.type === 'fire' ? '#ff8a3a' : b.type === 'wall' ? '#b8a07a' : '#f4ead2', b.hitT > 0 ? { borderWidth: 1, borderColor: '#ff3a2a' } : null)));
  w.npcs.forEach((n) => n.type !== 'villager' && marks.push(dot('n' + n.id, n.x, n.z, big ? 8 : 5, n.type === 'chief' ? '#ffd166' : '#7ad0ff')));
  w.enemies.forEach((e) => {
    const D = ENEMIES[e.type];
    if (D.passive || dist2(e.x, e.z, p.x, p.z) > (big ? 999 : 40)) return;
    if (e.dormant) return;
    marks.push(dot('e' + e.id, e.x, e.z, D.boss ? 8 : 4, e.type === 'mummy' ? '#5aff8a' : D.human ? '#ff4a3a' : '#ff9a7a'));
  });
  const tgt = objectiveTarget(g);
  const arrowDeg = (Math.atan2(Math.sin(p.rot), -Math.cos(p.rot)) * 180) / Math.PI;
  return (
    <Pressable onPress={onToggle} style={[styles.minimap, { width: size, height: size, borderRadius: size / 2 }]}>
      <View style={[StyleSheet.absoluteFill, { borderRadius: size / 2, overflow: 'hidden', backgroundColor: g.region === 'desert' ? '#d9b77a' : g.region === 'cave' ? '#17110c' : '#3f7a35' }]}>
        {marks}
        {tgt && (
          <Text style={[styles.mmStar, pos(tgt.x, tgt.z), big && { fontSize: 18, marginLeft: -9, marginTop: -12 }]} pointerEvents="none">
            ★
          </Text>
        )}
        <Text style={[styles.mmPlayer, pos(p.x, p.z), { transform: [{ rotate: `${arrowDeg}deg` }] }]}>▲</Text>
      </View>
      <Text style={styles.mmN}>N</Text>
      {big && <Text style={styles.mmLabel}>{REGIONS[g.region].name} · tap to close</Text>}
    </Pressable>
  );
}

/* =====================================================================
   APP
   ===================================================================== */
/* Everything the game loop and input handlers share lives in one plain controller object
   (held in a ref). React renders the HUD from state snapshots, refreshed 10x a second. */
function createController(game) {
  const c = {
    g: game,
    E: null,
    raf: 0,
    screen: 'title',
    panel: null,
    btn: { use: { x: -999, y: -999, r: 0 }, attack: { x: -999, y: -999, r: 0 }, dodge: { x: -999, y: -999, r: 0 } },
    size: { W: 1, H: 1 },
    input: { joy: { x: 0, y: 0 }, keys: {}, held: {} },
    touches: {},
    lastTouchAt: 0,
    ui: { setJoyUI: () => {}, setScreen: () => {}, setPanel: () => {}, setHud: () => {} },
  };
  const setPanel = (name) => {
    c.panel = name;
    c.ui.setPanel(name);
  };

  c.onContextCreate = (gl) => {
    const E = createEngine(gl);
    c.E = E;
    let last = Date.now();
    const loop = () => {
      c.raf = requestAnimationFrame(loop);
      const now = Date.now();
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const g = c.g;
      const mode = c.screen;
      const paused = !!c.panel || !!g.showWin;
      if (mode === 'play' && !paused) {
        const inp = c.input;
        let jx = inp.joy.x;
        let jy = inp.joy.y;
        const k = inp.keys;
        const kx = (k.d || k.arrowright ? 1 : 0) - (k.a || k.arrowleft ? 1 : 0);
        const ky = (k.w || k.arrowup ? 1 : 0) - (k.s || k.arrowdown ? 1 : 0);
        if (kx || ky) {
          const m = Math.hypot(kx, ky);
          jx = kx / m;
          jy = ky / m;
        }
        const yaw = E.cam.yaw;
        step(g, dt, { x: -Math.sin(yaw) * jy + Math.cos(yaw) * jx, z: -Math.cos(yaw) * jy - Math.sin(yaw) * jx });
        if (inp.held.use && g.player.actionT <= 0) {
          const t = getUseTarget(g);
          if (t && (t.kind === 'chop' || t.kind === 'mine') && t.enabled) doUse(g);
        }
        if (inp.held.attack) doAttack(g);
        if (g.openPanel) {
          setPanel(g.openPanel);
          g.openPanel = null;
        }
        if (g.pendingTravel) {
          travel(g, g.pendingTravel);
          g.pendingTravel = null;
          E.cam.yaw = g.player.rot + Math.PI;
          E.cam.target.set(g.player.x, 1.5, g.player.z);
        }
      } else if (mode === 'title') g.time += dt;
      const target = mode === 'play' ? getUseTarget(g) : null;
      syncEngine(E, g, paused ? 0 : dt, mode, target);
      E.renderer.render(E.scene, E.camera);
      if (gl.endFrameEXP) gl.endFrameEXP();
    };
    loop();
  };

  c.hitButton = (x, y) => {
    for (const id of ['use', 'attack', 'dodge']) {
      const b = c.btn[id];
      if (Math.hypot(x - b.x, y - b.y) < b.r + 8) return id;
    }
    return null;
  };
  c.pointerStart = (id, x, y) => {
    if (c.screen !== 'play' || c.panel) return;
    const b = c.hitButton(x, y);
    if (b) {
      c.touches[id] = { kind: 'button', b };
      c.input.held[b] = true;
      if (b === 'use') doUse(c.g);
      else if (b === 'attack') doAttack(c.g);
      else doDodge(c.g);
      return;
    }
    if (x < c.size.W * 0.45 && y > c.size.H * 0.4) {
      c.touches[id] = { kind: 'joy', ox: x, oy: y };
      c.ui.setJoyUI({ ox: x, oy: y, x: 0, y: 0 });
      return;
    }
    c.touches[id] = { kind: 'cam', lx: x, ly: y };
  };
  c.pointerMove = (id, x, y) => {
    const tc = c.touches[id];
    if (!tc) return;
    if (tc.kind === 'joy') {
      let dx = (x - tc.ox) / 55;
      let dy = (y - tc.oy) / 55;
      const m = Math.hypot(dx, dy);
      if (m > 1) {
        dx /= m;
        dy /= m;
      }
      c.input.joy = { x: dx, y: -dy };
      c.ui.setJoyUI({ ox: tc.ox, oy: tc.oy, x: dx, y: dy });
    } else if (tc.kind === 'cam' && c.E) {
      c.E.cam.yaw -= (x - tc.lx) * 0.009;
      c.E.cam.pitch = clamp(c.E.cam.pitch + (y - tc.ly) * 0.006, 0.05, 1.15);
      c.E.cam.lastDrag = c.g.time;
      tc.lx = x;
      tc.ly = y;
    }
  };
  c.pointerEnd = (id) => {
    const tc = c.touches[id];
    if (!tc) return;
    if (tc.kind === 'joy') {
      c.input.joy = { x: 0, y: 0 };
      c.ui.setJoyUI(null);
    }
    if (tc.kind === 'button') c.input.held[tc.b] = false;
    delete c.touches[id];
  };
  c.touch = (e, type) => {
    c.lastTouchAt = Date.now();
    const list = e.nativeEvent.changedTouches || [];
    for (const t of list) {
      if (type === 'start') c.pointerStart(t.identifier, t.pageX, t.pageY);
      else if (type === 'move') c.pointerMove(t.identifier, t.pageX, t.pageY);
      else c.pointerEnd(t.identifier);
    }
  };

  c.attachWeb = () => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return undefined;
    // debugging hooks for the browser console
    window.__game = () => c.g;
    window.__cam = () => c.E && c.E.cam;
    window.__api = { doUse, doAttack, doDodge, craft, eat, drink, getUseTarget, spawnEnemy, travel, buy, sell, acceptQuest, turnInQuest, startLevel2, respawnInVillage, smelt, forge, equipWeapon, buyPlot, startRaid, buildSpot, raiders, exposedBuilds, inSafeZone, weapon, armorValue, bossNote };
    const fresh = () => Date.now() - c.lastTouchAt > 800;
    const md = (e) => {
      if (!fresh() || e.button !== 0) return;
      if (e.target && e.target.closest && e.target.closest('[data-ui="1"]')) return;
      c.pointerStart('mouse', e.clientX, e.clientY);
    };
    const mm = (e) => fresh() && c.pointerMove('mouse', e.clientX, e.clientY);
    const mu = () => c.pointerEnd('mouse');
    const kd = (e) => {
      const k = e.key.toLowerCase();
      c.input.keys[k] = true;
      if (c.screen !== 'play') {
        if (k === 'enter' || k === ' ') {
          c.screen = 'play';
          c.ui.setScreen('play');
        }
        return;
      }
      if (e.repeat) return;
      if (k === ' ' || k === 'j') {
        e.preventDefault();
        if (!c.panel) {
          c.input.held.attack = true;
          doAttack(c.g);
        }
      }
      if ((k === 'e' || k === 'k') && !c.panel) {
        c.input.held.use = true;
        doUse(c.g);
      }
      if ((k === 'shift' || k === 'q') && !c.panel) doDodge(c.g);
      const toggle = (name) => setPanel(c.panel === name ? null : name);
      if (k === 'c') toggle('craft');
      if (k === 'b' || k === 'i') toggle('bag');
      if (k === 'g') toggle('goals');
      if (k === 'm') c.ui.toggleMap && c.ui.toggleMap();
      if (k === 'escape') setPanel(null);
      if (k.startsWith('arrow') || k === ' ') e.preventDefault();
    };
    const ku = (e) => {
      const k = e.key.toLowerCase();
      c.input.keys[k] = false;
      if (k === 'e' || k === 'k') c.input.held.use = false;
      if (k === ' ' || k === 'j') c.input.held.attack = false;
    };
    window.addEventListener('mousedown', md);
    window.addEventListener('mousemove', mm);
    window.addEventListener('mouseup', mu);
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    return () => {
      window.removeEventListener('mousedown', md);
      window.removeEventListener('mousemove', mm);
      window.removeEventListener('mouseup', mu);
      window.removeEventListener('keydown', kd);
      window.removeEventListener('keyup', ku);
    };
  };

  c.startScenario = (id) => {
    c.g = createGame();
    applyScenario(c.g, id);
    if (c.E) {
      c.E.region = null; // rebuild the scene for wherever the scenario starts
      c.E.cam.yaw = c.g.player.rot + Math.PI;
      c.E.cam.target.set(c.g.player.x, 1.5, c.g.player.z);
    }
    c.input = { joy: { x: 0, y: 0 }, keys: {}, held: {} };
    setPanel(null);
    c.screen = 'play';
    c.ui.setScreen('play');
    c.ui.setHud((h) => ({ g: c.g, n: h.n + 1 }));
  };
  c.cheat = (id) => cheat(c.g, id);
  c.warp = (id) => {
    warp(c.g, id);
    if (c.E) {
      c.E.cam.target.set(c.g.player.x, 1.5, c.g.player.z);
      c.E.cam.yaw = c.g.player.rot + Math.PI;
    }
    setPanel(null);
  };
  c.restart = () => {
    c.g = createGame(c.g.seed0);
    if (c.E) c.E.region = null; // rebuild the scene for the fresh forest
    c.input = { joy: { x: 0, y: 0 }, keys: {}, held: {} };
    setPanel(null);
    c.ui.setHud((h) => ({ g: c.g, n: h.n + 1 }));
  };
  c.respawn = () => respawnInVillage(c.g);
  c.dismissWin = () => {
    if (c.g.showWin === 'l1') startLevel2(c.g);
    else c.g.showWin = null;
  };
  c.craft = (id) => craft(c.g, id);
  c.smelt = (all) => smelt(c.g, all);
  c.forge = (id) => {
    if (forge(c.g, id)) setPanel(null); // close the anvil so you see the hammering
  };
  c.equip = (id) => equipWeapon(c.g, id);
  c.buyPlot = () => buyPlot(c.g);
  c.eat = (item) => eat(c.g, item);
  c.drink = () => drink(c.g);
  c.buy = (id) => buy(c.g, id);
  c.sell = (id) => sell(c.g, id);
  c.accept = () => acceptQuest(c.g);
  c.turnIn = () => {
    turnInQuest(c.g);
    setPanel(null);
  };
  return c;
}

const BOTTOM = Platform.OS === 'ios' ? 26 : 16;
// layout of on-screen buttons (shared by drawing and hit-testing)
function buttonLayout(W, H) {
  return {
    use: { x: W - 78, y: H - 96 - BOTTOM, r: 46 },
    attack: { x: W - 172, y: H - 60 - BOTTOM, r: 38 },
    dodge: { x: W - 176, y: H - 150 - BOTTOM, r: 28 },
  };
}

export default function App() {
  const { width: W, height: H } = useWindowDimensions();
  const [hud, setHud] = useState(() => ({ g: createGame(), n: 0 }));
  const ctl = useRef(null);
  if (ctl.current === null) ctl.current = createController(hud.g);
  const [screen, setScreen] = useState('title');
  const [panel, setPanel] = useState(null);
  const [joyUI, setJoyUI] = useState(null);
  const [bigMap, setBigMap] = useState(false);
  const btn = buttonLayout(W, H);

  useEffect(() => {
    const c = ctl.current;
    c.screen = screen;
    c.panel = panel;
    c.btn = buttonLayout(W, H);
    c.size = { W, H };
    c.ui = { setJoyUI, setScreen, setPanel, setHud, toggleMap: () => setBigMap((b) => !b) };
  }, [screen, panel, W, H]);

  useEffect(() => {
    const c = ctl.current;
    const id = setInterval(() => setHud((h) => ({ g: c.g, n: h.n + 1 })), 100);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    const c = ctl.current;
    return () => cancelAnimationFrame(c.raf);
  }, []);
  useEffect(() => ctl.current.attachWeb(), []);

  const g = hud.g;
  const p = g.player;
  const topPad = Platform.OS === 'android' ? StatusBar.currentHeight || 24 : Platform.OS === 'ios' ? 50 : 10;
  const target = screen === 'play' ? getUseTarget(g) : null;
  const list = objectives(g);
  const current = currentObjective(g);
  const doneCount = list.filter((o) => g.done[o.id]).length;
  const recent = g.msgs.filter((m) => g.time - m.t < 4.5);
  const king =
    g.region === 'desert'
      ? g.w.enemies.find((e) => e.type === 'king' && e.state !== 'idle' && dist2(e.x, e.z, p.x, p.z) < 25)
      : mummyInView(g);
  const kingNote = king ? bossNote(g, king) : '';
  const raid = g.region === 'desert' ? raiders(g) : [];
  const raidTargetB = raid.length ? g.w.builds.find((b) => raid.some((e) => e.target === b.id)) : null;
  const closePanel = () => setPanel(null);
  const mapSize = bigMap ? Math.min(W - 40, H - 260, 300) : 112;

  return (
    <View style={styles.root}>
      <GLView style={StyleSheet.absoluteFill} onContextCreate={(gl) => ctl.current.onContextCreate(gl)} />
      <View
        style={StyleSheet.absoluteFill}
        onTouchStart={(e) => ctl.current.touch(e, 'start')}
        onTouchMove={(e) => ctl.current.touch(e, 'move')}
        onTouchEnd={(e) => ctl.current.touch(e, 'end')}
        onTouchCancel={(e) => ctl.current.touch(e, 'end')}
      />

      {screen === 'title' && (
        <View style={[styles.titleWrap, { paddingTop: topPad + 30 }]} pointerEvents="box-none">
          <Text style={styles.titleTxt}>WILDWOOD</Text>
          <Text style={styles.sub}>survive the wilds</Text>
          <View style={{ flex: 1 }} pointerEvents="none" />
          <View style={styles.titleCard} dataSet={{ ui: '1' }}>
            <Text style={styles.story}>
              You wake up alone in a forest clearing with nothing but a backpack. Survive your first night, then follow the trail east into the
              desert, where a thirsty village needs a hero.
            </Text>
            <Text style={styles.howLine}>
              {Platform.OS === 'web'
                ? 'WASD move · drag to look · E use (hold to chop/mine) · Space attack · Shift dodge · C craft · B bag · M map'
                : 'Left thumb: move · drag elsewhere: look · USE (hold to chop/mine) · ATTACK · ↻ dodge'}
            </Text>
            <Pressable onPress={() => setScreen('play')} style={styles.startBtn}>
              <Text style={styles.startTxt}>Start surviving</Text>
            </Pressable>
            {PLAYTEST && (
              <Pressable onPress={() => setPanel('scenarios')} style={styles.playtestBtn}>
                <Text style={styles.playtestTxt}>🧪 Playtest shortcuts</Text>
              </Pressable>
            )}
          </View>
          {panel === 'scenarios' && <ScenarioPanel onPick={(id) => ctl.current.startScenario(id)} onClose={closePanel} />}
        </View>
      )}

      {screen === 'play' && (
        <>
          <View style={[styles.hud, { paddingTop: topPad }]} pointerEvents="box-none">
            <View style={styles.hudRow} pointerEvents="box-none">
              <View style={styles.hudCard} pointerEvents="none">
                <Text style={styles.dayTxt}>
                  {isNight(g.tod) ? '🌙' : '☀️'} Day {g.day} · {clockText(g.tod)}
                </Text>
                <Text style={styles.regionTxt}>
                  {REGIONS[g.region].name}
                  {g.level === 2 || g.gold > 0 ? `  ·  🪙 ${g.gold}` : ''}
                </Text>
                <StatBar icon="❤️" value={p.health} color="#ef5350" />
                <StatBar icon="🍖" value={p.hunger} color="#f0a030" />
                <StatBar icon="⚡" value={p.energy} color="#4ea3e0" />
                <StatBar icon="🔥" value={p.warmth} color="#ff7849" />
                {g.visitedDesert && <StatBar icon="💧" value={p.thirst} color="#3fc1e8" />}
              </View>
              <View style={{ alignItems: 'flex-end' }} pointerEvents="box-none">
                <View style={styles.menuCol} dataSet={{ ui: '1' }}>
                  {[['bag', '🎒', 'Bag'], ['craft', '🔨', 'Craft'], ['goals', '📋', 'Goals'], ...(PLAYTEST ? [['dev', '🧪', 'Test']] : [])].map(([id, icon, lbl]) => (
                    <Pressable key={id} onPress={() => setPanel(id)} style={({ pressed }) => [styles.menuBtn, pressed && styles.pressed]}>
                      <Text style={styles.menuIcon}>{icon}</Text>
                      <Text style={styles.menuLbl}>{lbl}</Text>
                    </Pressable>
                  ))}
                </View>
                {!bigMap && (
                  <View style={{ marginTop: 8 }} dataSet={{ ui: '1' }}>
                    <Minimap g={g} size={mapSize} big={false} onToggle={() => setBigMap(true)} />
                  </View>
                )}
              </View>
            </View>
            {current && (
              <View style={styles.goalPill} pointerEvents="none">
                <Text style={styles.goalPillTxt} numberOfLines={1}>
                  {g.level === 2 ? 'L2 · ' : ''}Goal {doneCount + 1}/{list.length} · {current.text}
                </Text>
              </View>
            )}
            <View style={styles.msgs} pointerEvents="none">
              {recent.map((m) => (
                <Text key={m.id} style={styles.msgTxt}>
                  {m.text}
                </Text>
              ))}
            </View>
          </View>

          {raid.length > 0 && !king && (
            <View style={[styles.bossWrap, { top: topPad + 6 }]} pointerEvents="none">
              <Text style={styles.bossName}>
                ⚔️ RAID · {raid.length} marauder{raid.length === 1 ? '' : 's'}
                {raid[0].retreat ? ' fleeing' : ''}
              </Text>
              {raidTargetB && (
                <>
                  <View style={styles.bossBg}>
                    <View style={[styles.bossFill, { width: `${(100 * raidTargetB.hp) / raidTargetB.maxHp}%`, backgroundColor: '#d9a43a' }]} />
                  </View>
                  <Text style={styles.raidSub}>
                    Your {BUILDS[raidTargetB.type].name}: {Math.ceil(raidTargetB.hp)}/{raidTargetB.maxHp}
                  </Text>
                </>
              )}
            </View>
          )}
          {king && (
            <View style={[styles.bossWrap, { top: topPad + 6 }]} pointerEvents="none">
              <Text style={styles.bossName}>{king.type === 'mummy' ? '☥ Ancient Mummy Guardian' : '👑 Marauder King'}</Text>
              <View style={styles.bossBg}>
                <View style={[styles.bossFill, { width: `${(100 * king.hp) / king.maxHp}%` }, king.inv && { backgroundColor: '#3fbf6a' }]} />
              </View>
              {!!kingNote && <Text style={styles.raidSub}>{kingNote}</Text>}
            </View>
          )}

          {g.sleeping && (
            <View style={styles.sleepDim} pointerEvents="none">
              <Text style={styles.sleepTxt}>z z z</Text>
            </View>
          )}

          {target && (
            <View style={[styles.prompt, { bottom: H - btn.dodge.y + btn.dodge.r + 14 }]} pointerEvents="none">
              <Text style={[styles.promptTxt, !target.enabled && { color: '#ff9a8a' }]}>
                {Platform.OS === 'web' ? 'E · ' : ''}
                {target.label}
              </Text>
            </View>
          )}

          <View pointerEvents="none" style={StyleSheet.absoluteFill}>
            {joyUI ? (
              <>
                <View style={[styles.joyBase, { left: joyUI.ox - 55, top: joyUI.oy - 55 }]} />
                <View style={[styles.joyKnob, { left: joyUI.ox - 24 + joyUI.x * 55, top: joyUI.oy - 24 + joyUI.y * 55 }]} />
              </>
            ) : (
              Platform.OS !== 'web' && <View style={[styles.joyBase, styles.joyIdle, { left: 40, top: H - 170 - BOTTOM }]} />
            )}
            {[['use', 'USE', styles.useBtn, !target || !target.enabled], ['attack', weapon(g) ? TOOLS[weapon(g)].icon : '👊', styles.atkBtn, false], ['dodge', '↻', styles.dodgeBtn, p.dodgeCd > 0]].map(([id, label, st, dim]) => {
              const b = btn[id];
              return (
                <View key={id} style={[styles.actBtn, st, { left: b.x - b.r, top: b.y - b.r, width: b.r * 2, height: b.r * 2, borderRadius: b.r }, dim && styles.dim]}>
                  <Text style={[styles.actTxt, id === 'dodge' && { fontSize: 20 }]}>{label}</Text>
                </View>
              );
            })}
          </View>

          {bigMap && (
            <View style={styles.mapOverlay} dataSet={{ ui: '1' }}>
              <Minimap g={g} size={mapSize} big onToggle={() => setBigMap(false)} />
            </View>
          )}

          {panel === 'craft' && <CraftPanel g={g} onCraft={(id) => ctl.current.craft(id)} onClose={closePanel} />}
          {panel === 'bag' && <BagPanel g={g} onEat={(k) => ctl.current.eat(k)} onDrink={() => ctl.current.drink()} onEquip={(k) => ctl.current.equip(k)} onClose={closePanel} />}
          {panel === 'furnace' && <FurnacePanel g={g} onSmelt={(all) => ctl.current.smelt(all)} onClose={closePanel} />}
          {panel === 'anvil' && <AnvilPanel g={g} onForge={(id) => ctl.current.forge(id)} onClose={closePanel} />}
          {panel === 'goals' && <GoalsPanel g={g} onClose={closePanel} />}
          {panel === 'dev' && <DevPanel g={g} onCheat={(id) => ctl.current.cheat(id)} onWarp={(id) => ctl.current.warp(id)} onClose={closePanel} />}
          {panel === 'shop' && <ShopPanel g={g} onBuy={(id) => ctl.current.buy(id)} onSell={(id) => ctl.current.sell(id)} onClose={closePanel} />}
          {panel === 'chief' && <ChiefPanel g={g} onAccept={() => ctl.current.accept()} onTurnIn={() => ctl.current.turnIn()} onBuyPlot={() => ctl.current.buyPlot()} onClose={closePanel} />}

          {g.showWin === 'l1' && (
            <View style={styles.overlay}>
              <View style={[styles.panel, styles.center]}>
                <Text style={styles.bigTxt}>You survived the night! 🏕️</Text>
                <Text style={[styles.cardDesc, { textAlign: 'center' }]}>
                  Level 1 complete. A worn trail leads east out of the forest, toward a desert rich in copper, tin and limestone. Craft a stone
                  pickaxe before you go.
                </Text>
                <Pressable onPress={() => ctl.current.dismissWin()} style={styles.startBtn}>
                  <Text style={styles.startTxt}>On to Level 2</Text>
                </Pressable>
              </View>
            </View>
          )}
          {g.showWin === 'l2' && (
            <View style={styles.overlay}>
              <View style={[styles.panel, styles.center]}>
                <Text style={styles.bigTxt}>The oasis is free! 🌴</Text>
                <Text style={[styles.cardDesc, { textAlign: 'center' }]}>
                  Level 2 complete. The marauders are broken, their king has fallen and the village has water again. {g.kills} enemies defeated, {g.gold} gold in your
                  pack.
                </Text>
                <Pressable onPress={() => ctl.current.dismissWin()} style={styles.startBtn}>
                  <Text style={styles.startTxt}>Keep exploring</Text>
                </Pressable>
              </View>
            </View>
          )}
          {g.over && (
            <View style={styles.overlay}>
              <View style={[styles.panel, styles.center]}>
                <Text style={styles.bigTxt}>{"You didn't make it"}</Text>
                <Text style={[styles.cardDesc, { textAlign: 'center' }]}>
                  Cause: {g.deathReason}. Day {g.day}, {g.kills} {g.kills === 1 ? 'enemy' : 'enemies'} defeated.
                </Text>
                {g.region !== 'forest' ? (
                  <Pressable onPress={() => ctl.current.respawn()} style={styles.startBtn}>
                    <Text style={styles.startTxt}>Wake up in the village (lose half your gold)</Text>
                  </Pressable>
                ) : (
                  <Pressable onPress={() => ctl.current.restart()} style={styles.startBtn}>
                    <Text style={styles.startTxt}>Try again</Text>
                  </Pressable>
                )}
              </View>
            </View>
          )}
        </>
      )}
    </View>
  );
}

const shadowTxt = { textShadowColor: '#000a', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 3 };
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0d1410' },
  row: { flexDirection: 'row', alignItems: 'center' },
  center: { alignItems: 'center' },
  hud: { position: 'absolute', left: 0, right: 0, top: 0, paddingHorizontal: 12 },
  hudRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  hudCard: { backgroundColor: '#0b120ecc', borderRadius: 14, padding: 10, width: 190, borderWidth: 1, borderColor: '#ffffff1a' },
  dayTxt: { color: '#f4efe3', fontWeight: '800', fontSize: 13 },
  regionTxt: { color: '#e9c46a', fontWeight: '700', fontSize: 11, marginBottom: 5, marginTop: 1 },
  stat: { flexDirection: 'row', alignItems: 'center', marginVertical: 2 },
  statIcon: { width: 22, fontSize: 12 },
  barBg: { flex: 1, height: 8, backgroundColor: '#ffffff22', borderRadius: 4, overflow: 'hidden' },
  barFill: { height: '100%', borderRadius: 4 },
  menuCol: { flexDirection: 'row' },
  menuBtn: { width: 54, height: 54, borderRadius: 14, backgroundColor: '#0b120ecc', borderWidth: 1, borderColor: '#ffffff1a', alignItems: 'center', justifyContent: 'center', marginLeft: 6 },
  menuIcon: { fontSize: 20 },
  menuLbl: { color: '#d8e0d4', fontSize: 9, fontWeight: '700', marginTop: 1 },
  minimap: { borderWidth: 2, borderColor: '#0b120e', backgroundColor: '#0b120e' },
  mmDot: { position: 'absolute' },
  mmStar: { position: 'absolute', color: '#ffd166', fontSize: 14, marginLeft: -7, marginTop: -10, ...shadowTxt },
  mmPlayer: { position: 'absolute', color: '#ffffff', fontSize: 12, marginLeft: -6, marginTop: -8, ...shadowTxt },
  mmN: { position: 'absolute', top: 2, alignSelf: 'center', color: '#fff', fontSize: 9, fontWeight: '900', ...shadowTxt },
  mmLabel: { position: 'absolute', bottom: -22, alignSelf: 'center', color: '#fff', fontSize: 12, fontWeight: '700', ...shadowTxt },
  mapOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: '#0008', alignItems: 'center', justifyContent: 'center' },
  goalPill: { alignSelf: 'flex-start', marginTop: 8, backgroundColor: '#e9c46ae6', borderRadius: 999, paddingHorizontal: 12, paddingVertical: 5, maxWidth: '70%' },
  goalPillTxt: { color: '#2a2108', fontWeight: '800', fontSize: 12 },
  msgs: { marginTop: 8, maxWidth: '68%' },
  msgTxt: { alignSelf: 'flex-start', color: '#fff', fontSize: 12.5, backgroundColor: '#0008', paddingHorizontal: 9, paddingVertical: 4, borderRadius: 8, marginBottom: 4, overflow: 'hidden' },
  bossWrap: { position: 'absolute', alignSelf: 'center', alignItems: 'center', width: 260 },
  bossName: { color: '#ffd166', fontWeight: '900', fontSize: 13, ...shadowTxt },
  bossBg: { width: '100%', height: 10, borderRadius: 5, backgroundColor: '#0009', marginTop: 3, overflow: 'hidden', borderWidth: 1, borderColor: '#ffd16688' },
  bossFill: { height: '100%', backgroundColor: '#d63a2a' },
  raidSub: { color: '#ffe9c0', fontSize: 11, fontWeight: '700', marginTop: 2, textAlign: 'center', ...shadowTxt },
  warnTxt: { color: '#ffd9a0', marginBottom: 8, backgroundColor: '#3a2a1466', borderRadius: 10, padding: 8 },
  equipped: { backgroundColor: '#6a8a5a' },
  wornTxt: { color: '#9fe08a', fontWeight: '800', fontSize: 12 },
  playtestBtn: { marginTop: 10, paddingVertical: 8, paddingHorizontal: 16, borderRadius: 10, borderWidth: 1, borderColor: '#e9c46a88' },
  playtestTxt: { color: '#e9c46a', fontWeight: '800', fontSize: 13 },
  devGrid: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -4 },
  devBtn: { width: '47%', margin: '1.5%', backgroundColor: '#223027', borderRadius: 10, paddingVertical: 10, paddingHorizontal: 8, alignItems: 'center' },
  devOn: { backgroundColor: '#3f6a3a' },
  devTxt: { color: '#f4efe3', fontWeight: '700', fontSize: 12.5, textAlign: 'center' },
  prompt: { position: 'absolute', right: 16, backgroundColor: '#0b120ee0', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 7, borderWidth: 1, borderColor: '#ffd16655' },
  promptTxt: { color: '#ffd166', fontWeight: '800', fontSize: 14 },
  joyBase: { position: 'absolute', width: 110, height: 110, borderRadius: 55, backgroundColor: '#ffffff1c', borderWidth: 2, borderColor: '#ffffff40' },
  joyIdle: { opacity: 0.5 },
  joyKnob: { position: 'absolute', width: 48, height: 48, borderRadius: 24, backgroundColor: '#ffffffaa' },
  actBtn: { position: 'absolute', alignItems: 'center', justifyContent: 'center', borderWidth: 2 },
  useBtn: { backgroundColor: '#2f6f9acc', borderColor: '#8cc6ee' },
  atkBtn: { backgroundColor: '#8a2f2acc', borderColor: '#e08a80' },
  dodgeBtn: { backgroundColor: '#3f5a3acc', borderColor: '#9fd08a' },
  actTxt: { color: '#fff', fontWeight: '900', fontSize: 16, letterSpacing: 1, ...shadowTxt },
  dim: { opacity: 0.45 },
  sleepDim: { ...StyleSheet.absoluteFillObject, backgroundColor: '#02040c66', alignItems: 'center', justifyContent: 'center' },
  sleepTxt: { color: '#dfe6ff', fontSize: 28, fontWeight: '800', letterSpacing: 8, ...shadowTxt },
  pressed: { opacity: 0.6 },
  disabled: { opacity: 0.4 },
  overlay: { ...StyleSheet.absoluteFillObject, backgroundColor: '#000a', justifyContent: 'center', padding: 18 },
  panel: { backgroundColor: '#17211b', borderRadius: 18, padding: 16, maxHeight: '86%', width: '100%', maxWidth: 460, alignSelf: 'center', borderWidth: 1, borderColor: '#33463a' },
  panelHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  panelTitle: { color: '#f4efe3', fontSize: 20, fontWeight: '800' },
  closeBtn: { padding: 4 },
  closeTxt: { color: '#f4efe3', fontSize: 20 },
  paused: { color: '#7d8f80', fontSize: 11, textAlign: 'center', marginTop: 6 },
  dialog: { color: '#efe6d0', fontSize: 14, lineHeight: 21, fontStyle: 'italic', marginBottom: 6 },
  goldPill: { alignSelf: 'flex-start', backgroundColor: '#e9c46a26', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4, marginTop: 4 },
  goldTxt: { color: '#ffd166', fontWeight: '800' },
  card: { backgroundColor: '#223027', borderRadius: 12, padding: 12, marginBottom: 10 },
  iconBox: { width: 44, height: 44, borderRadius: 10, backgroundColor: '#ffffff12', alignItems: 'center', justifyContent: 'center', marginRight: 10 },
  iconTxt: { fontSize: 22 },
  cardTitle: { color: '#f4efe3', fontWeight: '700', fontSize: 15 },
  cardDesc: { color: '#b9c6b8', fontSize: 12.5, marginTop: 3, lineHeight: 18 },
  chip: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#0003', borderRadius: 10, paddingHorizontal: 7, paddingVertical: 3, marginRight: 6, marginBottom: 4 },
  chipTxt: { marginLeft: 4, fontWeight: '700', fontSize: 12 },
  craftBtn: { marginTop: 8, backgroundColor: '#e9c46a', borderRadius: 10, paddingVertical: 9, alignItems: 'center' },
  eatBtn: { backgroundColor: '#e9c46a', borderRadius: 10, paddingVertical: 8, paddingHorizontal: 14 },
  craftTxt: { color: '#2a2108', fontWeight: '800' },
  section: { color: '#e9c46a', fontWeight: '800', marginBottom: 6, marginTop: 4 },
  goal: { paddingVertical: 7, paddingHorizontal: 8, borderRadius: 10 },
  goalCurrent: { backgroundColor: '#223027' },
  goalTxt: { color: '#f4efe3', fontSize: 14 },
  goalDone: { color: '#8fbf86', textDecorationLine: 'line-through' },
  bigTxt: { color: '#f4efe3', fontSize: 22, fontWeight: '800', textAlign: 'center', marginBottom: 8 },
  titleWrap: { ...StyleSheet.absoluteFillObject, alignItems: 'center', paddingHorizontal: 20, paddingBottom: 30 },
  titleTxt: { color: '#fff8e8', fontSize: 46, fontWeight: '900', letterSpacing: 6, ...shadowTxt },
  sub: { color: '#ffe3a3', fontSize: 14, letterSpacing: 3, fontWeight: '700', ...shadowTxt },
  titleCard: { backgroundColor: '#0b120ed9', borderRadius: 18, padding: 18, maxWidth: 460, width: '100%', alignItems: 'center', borderWidth: 1, borderColor: '#ffffff1f' },
  story: { color: '#e4ebe0', fontSize: 14, lineHeight: 21, textAlign: 'center' },
  howLine: { color: '#a9b8a8', fontSize: 12, marginTop: 10, textAlign: 'center' },
  startBtn: { marginTop: 14, backgroundColor: '#e9c46a', paddingVertical: 13, paddingHorizontal: 34, borderRadius: 14 },
  startTxt: { color: '#2a2108', fontWeight: '900', fontSize: 16, textAlign: 'center' },
});
