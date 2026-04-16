// SQLite wrapper for MyWorld.
// Uses better-sqlite3 (synchronous). All prepared statements exported below.
// The DB file path defaults to ./world.db relative to cwd; override via MYWORLD_DB env.

import Database from 'better-sqlite3';
import path from 'node:path';

const DB_PATH = process.env.MYWORLD_DB || path.resolve('world.db');

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    room       TEXT PRIMARY KEY,
    seed       INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    room          TEXT NOT NULL,
    name          TEXT NOT NULL,
    salt          TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    PRIMARY KEY (room, name)
  );

  CREATE TABLE IF NOT EXISTS blocks (
    room TEXT NOT NULL,
    x    INTEGER NOT NULL,
    y    INTEGER NOT NULL,
    z    INTEGER NOT NULL,
    type TEXT NOT NULL,
    PRIMARY KEY (room, x, y, z)
  );
  CREATE INDEX IF NOT EXISTS idx_blocks_room ON blocks(room);

  CREATE TABLE IF NOT EXISTS chat (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    room   TEXT NOT NULL,
    author TEXT NOT NULL,
    text   TEXT NOT NULL,
    ts     INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_chat_room_ts ON chat(room, ts);
`);

// --- Prepared statements ---

const stmt = {
  getRoom:        db.prepare('SELECT * FROM rooms WHERE room = ?'),
  insertRoom:     db.prepare('INSERT INTO rooms (room, seed, created_at) VALUES (?, ?, ?)'),

  getUser:        db.prepare('SELECT * FROM users WHERE room = ? AND name = ?'),
  insertUser:     db.prepare(
    'INSERT INTO users (room, name, salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?)'
  ),

  getBlocks:      db.prepare('SELECT x, y, z, type FROM blocks WHERE room = ?'),
  upsertBlock:    db.prepare(
    `INSERT INTO blocks (room, x, y, z, type) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(room, x, y, z) DO UPDATE SET type = excluded.type`
  ),
  deleteBlock:    db.prepare('DELETE FROM blocks WHERE room = ? AND x = ? AND y = ? AND z = ?'),

  insertChat:     db.prepare('INSERT INTO chat (room, author, text, ts) VALUES (?, ?, ?, ?)'),
  recentChat:     db.prepare(
    `SELECT author, text, ts FROM chat WHERE room = ? ORDER BY id DESC LIMIT ?`
  ),
};

// --- High-level helpers ---

export function getRoom(room) {
  return stmt.getRoom.get(room);
}

export function createRoom(room, seed) {
  stmt.insertRoom.run(room, seed, Date.now());
}

export function getUser(room, name) {
  return stmt.getUser.get(room, name);
}

export function createUser(room, name, salt, passwordHash) {
  stmt.insertUser.run(room, name, salt, passwordHash, Date.now());
}

export function getAllBlocks(room) {
  return stmt.getBlocks.all(room);
}

export function setBlock(room, x, y, z, type) {
  stmt.upsertBlock.run(room, x, y, z, type);
}

export function deleteBlock(room, x, y, z) {
  stmt.deleteBlock.run(room, x, y, z);
}

/**
 * Insert many blocks atomically. `blocks` is an iterable of {x, y, z, type}.
 * Used once per room at creation time (~10k rows).
 */
export const insertBlocksBatch = db.transaction((room, blocks) => {
  for (const b of blocks) {
    stmt.upsertBlock.run(room, b.x, b.y, b.z, b.type);
  }
});

export function appendChat(room, author, text, ts) {
  stmt.insertChat.run(room, author, text, ts);
}

/** Returns up to `limit` most recent chat messages in chronological (ascending) order. */
export function recentChat(room, limit = 50) {
  const rows = stmt.recentChat.all(room, limit);
  return rows.reverse();
}
