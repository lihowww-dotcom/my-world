// MyWorld authoritative server.
//
// - Same HTTP server handles `GET /` (index.html) and WebSocket upgrades.
// - Per-room in-memory state, written through to SQLite on change.
// - 15Hz position broadcast tick.
// - Rate limiting: 10 block-ops/sec, 5 chat/10s per connection.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomInt } from 'node:crypto';
import { WebSocketServer } from 'ws';

import {
  getRoom, createRoom, getUser, createUser,
  getAllBlocks, setBlock, deleteBlock,
  insertBlocksBatch, appendChat, recentChat,
} from './db.js';
import { hashPassword, verifyPassword } from './auth.js';
import {
  generateWorld, generateDigDigWorld, spawnPoint, inBounds, BLOCK_TYPES,
} from './terrain.js';

// ---------------- Config ----------------
const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_CONNS_PER_ROOM = 16;
const POSITION_TICK_MS = 66;          // ~15Hz

// DigDig game-mode: mine the most gold within the round.
const DIGDIG_ROOM = 'digdig';
const DIGDIG_ROUND_MS = 180_000;        // 3 min
const DIGDIG_INTERMISSION_MS = 10_000;  // 10 s between rounds
const DIGDIG_GOLD_COUNT = 100;
const DIGDIG_GOLD_MAX_Y = 3;            // shallowest gold y — gold sits just below grass
const INDEX_HTML = path.resolve(
  fileURLToPath(new URL('..', import.meta.url)),
  'index.html'
);

// ---------------- HTTP ----------------
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    fs.readFile(INDEX_HTML, (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end('index.html not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    });
    return;
  }
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

// ---------------- WebSocket ----------------
const wss = new WebSocketServer({ server, maxPayload: 1024 * 1024 }); // 1MB frame cap

/** rooms: Map<roomId, Room> — loaded lazily on first login. */
const rooms = new Map();

function getOrLoadRoom(roomId) {
  let r = rooms.get(roomId);
  if (r) return r;
  const row = getRoom(roomId);
  if (!row) return null;
  const blocks = new Map();
  for (const b of getAllBlocks(roomId)) {
    blocks.set(`${b.x},${b.y},${b.z}`, b.type);
  }
  r = { id: roomId, seed: row.seed, conns: new Set(), blocks };
  rooms.set(roomId, r);
  return r;
}

function send(conn, obj) {
  if (conn.ws.readyState === 1) conn.ws.send(JSON.stringify(obj));
}

function broadcast(room, obj, except = null) {
  const data = JSON.stringify(obj);
  for (const c of room.conns) {
    if (c !== except && c.ws.readyState === 1) c.ws.send(data);
  }
}

function randomColor() {
  // Random hue, medium saturation + lightness — readable against sky/grass.
  const h = Math.floor(Math.random() * 360);
  return `hsl(${h}, 70%, 55%)`;
}

// ---------------- DigDig game mode ----------------
function digdigScoresArray(game) {
  return Array.from(game.scores, ([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function makeGameSnapshot(r) {
  const g = r.game;
  if (!g) return null;
  return {
    mode: 'digdig',
    running: g.running,
    endsAt: g.endsAt,
    nextRoundAt: g.nextRoundAt || null,
    scores: digdigScoresArray(g),
    winner: g.winner || null,
    goldLeft: g.goldLeft,
    totalGold: g.totalGold,
  };
}

function broadcastGame(r) {
  const snap = makeGameSnapshot(r);
  if (snap) broadcast(r, { type: 'game', state: snap });
}

function startDigdigRound(r) {
  // 1. Sweep existing gold
  const oldGold = [];
  for (const [k, type] of r.blocks) if (type === 'gold') oldGold.push(k);
  for (const k of oldGold) {
    const [x, y, z] = k.split(',').map(Number);
    r.blocks.delete(k);
    deleteBlock(r.id, x, y, z);
    broadcast(r, { type: 'break', x, y, z });
  }

  // 2. Pick fresh gold positions (stone blocks shallow enough to reach)
  const candidates = [];
  for (const [k, type] of r.blocks) {
    if (type !== 'stone') continue;
    const [x, y, z] = k.split(',').map(Number);
    if (y < DIGDIG_GOLD_MAX_Y) candidates.push({ x, y, z, k });
  }
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  const pick = candidates.slice(0, DIGDIG_GOLD_COUNT);
  for (const { x, y, z, k } of pick) {
    // Client-side addBlock early-returns on occupied cells, so we must break
    // the existing stone mesh before placing gold on subsequent rounds.
    broadcast(r, { type: 'break', x, y, z });
    r.blocks.set(k, 'gold');
    setBlock(r.id, x, y, z, 'gold');
    broadcast(r, { type: 'place', x, y, z, block: 'gold' });
  }

  // 3. Reset game state
  r.game = {
    running: true,
    endsAt: Date.now() + DIGDIG_ROUND_MS,
    nextRoundAt: null,
    scores: new Map(),
    winner: null,
    goldLeft: pick.length,
    totalGold: pick.length,
  };
  broadcastGame(r);
  console.log(`[${r.id}] round start, gold=${pick.length}`);
}

function endDigdigRound(r) {
  if (!r.game || !r.game.running) return;
  let max = 0, winner = null;
  for (const [name, count] of r.game.scores) {
    if (count > max) { max = count; winner = name; }
  }
  r.game.running = false;
  r.game.winner = winner;
  r.game.nextRoundAt = Date.now() + DIGDIG_INTERMISSION_MS;
  broadcastGame(r);
  console.log(`[${r.id}] round end, winner=${winner || '(none)'} max=${max}`);
}

// ---------------- Rate limits ----------------
function allowBlockOp(conn) {
  const now = Date.now();
  if (now - conn.opsWindowStart > 1000) {
    conn.opsWindowStart = now;
    conn.opsCount = 0;
  }
  if (conn.opsCount >= 10) return false;
  conn.opsCount++;
  return true;
}

function allowChat(conn) {
  const now = Date.now();
  conn.chatWindow = conn.chatWindow.filter(t => now - t < 10000);
  if (conn.chatWindow.length >= 5) return false;
  conn.chatWindow.push(now);
  return true;
}

// ---------------- Validation ----------------
const RE_ROOM = /^[A-Za-z0-9_-]{1,32}$/;
const RE_NAME = /^[^\s\x00-\x1f]{1,24}$/;  // no whitespace/control, 1-24 chars

// ---------------- Message handlers ----------------
async function handleLogin(conn, msg) {
  if (conn.loginPending) return;             // duplicate login frame
  conn.loginPending = true;

  const room = typeof msg.room === 'string' ? msg.room.trim() : '';
  const name = typeof msg.name === 'string' ? msg.name.trim() : '';
  const password = typeof msg.password === 'string' ? msg.password : '';

  if (!RE_ROOM.test(room))   return sendError(conn, 'bad_room', '房號只能用英數字、_、- 且 1–32 字');
  if (!RE_NAME.test(name))   return sendError(conn, 'bad_name', '名字不能有空白或控制字元，1–24 字');
  if (password.length < 1 || password.length > 128) {
    return sendError(conn, 'bad_password', '密碼長度需介於 1–128');
  }

  const existingUser = getUser(room, name);
  let color;
  if (existingUser) {
    const ok = await verifyPassword(password, existingUser.salt, existingUser.password_hash);
    if (!ok) return sendError(conn, 'wrong_password', '密碼錯誤');
  } else {
    // Registering a new user; hash is slow (scrypt).
    const { salt, hash } = await hashPassword(password);

    // Room may need to be created. Do this synchronously in one block.
    const roomRow = getRoom(room);
    if (!roomRow) {
      const seed = randomInt(0, 0x7FFFFFFF);
      try {
        createRoom(room, seed);
        const blocks = room === DIGDIG_ROOM
          ? generateDigDigWorld(seed)
          : generateWorld(seed);
        insertBlocksBatch(room, blocks);
      } catch (err) {
        // Another request created it first; that's fine — re-read.
        if (!/UNIQUE|PRIMARY KEY/i.test(err.message)) throw err;
      }
    }

    try {
      createUser(room, name, salt, hash);
    } catch (err) {
      if (/UNIQUE|PRIMARY KEY/i.test(err.message)) {
        // Race: another registrant won with a different password. Don't let this one in.
        return sendError(conn, 'wrong_password', '名字已被註冊，密碼錯誤');
      }
      throw err;
    }
  }

  const r = getOrLoadRoom(room);
  if (!r) return sendError(conn, 'room_load_failed', '世界載入失敗');

  // Reject duplicate session for same (room, name).
  for (const c of r.conns) {
    if (c.name === name) return sendError(conn, 'already_online', '這個名字已經在這個世界裡了');
  }
  if (r.conns.size >= MAX_CONNS_PER_ROOM) {
    return sendError(conn, 'room_full', `世界已滿（上限 ${MAX_CONNS_PER_ROOM} 人）`);
  }

  // Attach
  const spawn = spawnPoint();
  color = randomColor();
  conn.authed = true;
  conn.id = randomUUID();
  conn.room = room;
  conn.name = name;
  conn.color = color;
  conn.pos = { x: spawn.x, y: spawn.y, z: spawn.z, yaw: 0, pitch: 0 };
  r.conns.add(conn);

  // In digdig, first player triggers a fresh round immediately. The resulting
  // place/break/game broadcasts reach this conn before its welcome; the client
  // tolerates that (addBlock dedups, welcome replay hits its early-return).
  if (r.id === DIGDIG_ROOM && !r.game) {
    startDigdigRound(r);
  }

  // Welcome (full state)
  const players = [];
  for (const c of r.conns) {
    if (c === conn) continue;
    players.push({ id: c.id, name: c.name, color: c.color, ...c.pos });
  }
  const blockList = [];
  for (const [k, type] of r.blocks) {
    const [x, y, z] = k.split(',').map(Number);
    blockList.push({ x, y, z, type });
  }
  const chatHist = recentChat(room, 50);

  send(conn, {
    type: 'welcome',
    yourId: conn.id,
    yourColor: conn.color,
    yourName: conn.name,
    spawn,
    players,
    blocks: blockList,
    chat: chatHist,
    game: makeGameSnapshot(r),
  });

  broadcast(r, {
    type: 'playerJoin',
    id: conn.id,
    name: conn.name,
    color: conn.color,
    ...conn.pos,
  }, conn);

  console.log(`[${room}] + ${name} (${r.conns.size} online)`);
}

function sendError(conn, code, message) {
  send(conn, { type: 'error', code, message });
  conn.loginPending = false;
}

function handlePos(conn, msg) {
  const { x, y, z, yaw, pitch } = msg;
  if (![x, y, z, yaw, pitch].every(Number.isFinite)) return;
  // Sanity clamp — prevents NaN/Infinity/absurd coords from leaking to other clients.
  if (Math.abs(x) > 1000 || Math.abs(z) > 1000 || y < -100 || y > 200) return;
  conn.pos.x = x;
  conn.pos.y = y;
  conn.pos.z = z;
  conn.pos.yaw = yaw;
  conn.pos.pitch = pitch;
}

function handlePlace(conn, msg) {
  if (!allowBlockOp(conn)) return;
  const { x, y, z, block } = msg;
  if (!inBounds(x, y, z)) return;
  if (!BLOCK_TYPES.has(block)) return;
  const r = rooms.get(conn.room);
  if (!r) return;
  const k = `${x},${y},${z}`;
  if (r.blocks.has(k)) return;            // already occupied
  r.blocks.set(k, block);
  setBlock(conn.room, x, y, z, block);
  broadcast(r, { type: 'place', x, y, z, block, by: conn.id });
}

function handleBreak(conn, msg) {
  if (!allowBlockOp(conn)) return;
  const { x, y, z } = msg;
  if (!inBounds(x, y, z)) return;
  const r = rooms.get(conn.room);
  if (!r) return;
  const k = `${x},${y},${z}`;
  const brokenType = r.blocks.get(k);
  if (brokenType === undefined) return;   // nothing to break
  r.blocks.delete(k);
  deleteBlock(conn.room, x, y, z);
  broadcast(r, { type: 'break', x, y, z, by: conn.id });

  // DigDig scoring
  if (r.id === DIGDIG_ROOM && r.game?.running && brokenType === 'gold') {
    r.game.scores.set(conn.name, (r.game.scores.get(conn.name) || 0) + 1);
    r.game.goldLeft = Math.max(0, r.game.goldLeft - 1);
    broadcastGame(r);
    if (r.game.goldLeft === 0) endDigdigRound(r);
  }
}

function handleChat(conn, msg) {
  if (!allowChat(conn)) return;
  const text = typeof msg.text === 'string' ? msg.text.trim().slice(0, 256) : '';
  if (!text) return;
  const r = rooms.get(conn.room);
  if (!r) return;
  const ts = Date.now();
  appendChat(conn.room, conn.name, text, ts);
  broadcast(r, { type: 'chat', author: conn.name, text, ts });
}

// ---------------- Per-connection lifecycle ----------------
wss.on('connection', (ws, req) => {
  const conn = {
    ws,
    id: null,
    authed: false,
    loginPending: false,
    room: null,
    name: null,
    color: null,
    pos: null,
    opsWindowStart: 0,
    opsCount: 0,
    chatWindow: [],
  };
  const ip = req.socket.remoteAddress;
  console.log(`[conn] open from ${ip}`);

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); }
    catch { return; }
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;

    // Auth gate: only 'login' accepted before authed.
    if (!conn.authed) {
      if (msg.type === 'login') {
        try { await handleLogin(conn, msg); }
        catch (err) {
          console.error('[login] error:', err);
          sendError(conn, 'server_error', '伺服器錯誤');
        }
      }
      return;
    }

    switch (msg.type) {
      case 'pos':   handlePos(conn, msg); break;
      case 'place': handlePlace(conn, msg); break;
      case 'break': handleBreak(conn, msg); break;
      case 'chat':  handleChat(conn, msg); break;
      default: /* ignore unknown */ break;
    }
  });

  ws.on('close', () => {
    console.log(`[conn] close ${conn.name || '(unauth)'}`);
    if (conn.authed && conn.room) {
      const r = rooms.get(conn.room);
      if (r) {
        r.conns.delete(conn);
        broadcast(r, { type: 'playerLeave', id: conn.id });
        console.log(`[${conn.room}] - ${conn.name} (${r.conns.size} online)`);
        // DigDig: wipe game state when empty so the next joiner starts fresh.
        if (r.id === DIGDIG_ROOM && r.conns.size === 0) r.game = null;
      }
    }
  });

  ws.on('error', (err) => {
    console.error('[ws] error:', err.message);
  });
});

// ---------------- Position tick ----------------
setInterval(() => {
  for (const r of rooms.values()) {
    if (r.conns.size < 2) continue;   // nobody to notify
    const updates = [];
    for (const c of r.conns) {
      if (!c.pos) continue;
      updates.push({
        id: c.id,
        x: c.pos.x, y: c.pos.y, z: c.pos.z,
        yaw: c.pos.yaw, pitch: c.pos.pitch,
      });
    }
    if (!updates.length) continue;
    broadcast(r, { type: 'positions', updates });
  }
}, POSITION_TICK_MS);

// ---------------- DigDig round tick ----------------
setInterval(() => {
  const now = Date.now();
  for (const r of rooms.values()) {
    if (r.id !== DIGDIG_ROOM) continue;
    if (r.conns.size === 0) continue;
    if (!r.game) { startDigdigRound(r); continue; }
    if (r.game.running && now >= r.game.endsAt) {
      endDigdigRound(r);
    } else if (!r.game.running && r.game.nextRoundAt && now >= r.game.nextRoundAt) {
      startDigdigRound(r);
    }
  }
}, 1000);

// ---------------- Start & shutdown ----------------
server.listen(PORT, HOST, () => {
  console.log(`MyWorld server on http://${HOST}:${PORT}`);
  console.log(`WebSocket at ws://${HOST}:${PORT}/`);
});

function shutdown() {
  console.log('\nshutting down…');
  wss.clients.forEach(ws => ws.close(1001, 'server shutdown'));
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
