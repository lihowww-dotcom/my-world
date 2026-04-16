// Deterministic terrain generation, mirrored from index.html's noise functions.
// `hash()`, `smooth()`, `noise2D()`, `heightAt()` are value-preserving ports of the
// client-side originals. Tree placement is seeded via mulberry32 so every run with
// the same seed produces identical output, unlike the client's Math.random().

export const SIZE = 24;           // half-extent; world is (2*SIZE+1)^2 columns
export const MAX_Y = 50;
export const MIN_Y = -10;
export const TREE_COUNT = 14;

// Valid block type whitelist. Kept in sync with client's BLOCKS map.
export const BLOCK_TYPES = new Set(['grass', 'dirt', 'stone', 'wood', 'leaves', 'sand', 'gold']);

/** Seeded PRNG. Same seed → same sequence. */
function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(x, z) {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function smooth(t) { return t * t * (3 - 2 * t); }

function noise2D(x, z) {
  const xi = Math.floor(x), zi = Math.floor(z);
  const xf = x - xi, zf = z - zi;
  const a = hash(xi, zi), b = hash(xi + 1, zi);
  const c = hash(xi, zi + 1), d = hash(xi + 1, zi + 1);
  const u = smooth(xf), v = smooth(zf);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

export function heightAt(x, z) {
  let h = 0;
  h += noise2D(x * 0.05, z * 0.05) * 8;
  h += noise2D(x * 0.12, z * 0.12) * 3;
  return Math.floor(h) + 4;
}

/** Returns true if the (x,y,z) coord is within the world's allowed bounds. */
export function inBounds(x, y, z) {
  return (
    Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(z) &&
    Math.abs(x) <= SIZE + 4 && Math.abs(z) <= SIZE + 4 &&
    y >= MIN_Y && y <= MAX_Y
  );
}

/**
 * Generate the full initial world for a fresh room.
 * Returns an array of { x, y, z, type }. First-writer-wins on duplicate coords
 * (mirrors the client's addBlock early-return on existing key).
 */
export function generateWorld(seed) {
  const blocks = new Map();   // "x,y,z" -> type
  const put = (x, y, z, type) => {
    const k = `${x},${y},${z}`;
    if (!blocks.has(k)) blocks.set(k, type);
  };

  // Base terrain
  for (let x = -SIZE; x <= SIZE; x++) {
    for (let z = -SIZE; z <= SIZE; z++) {
      const h = heightAt(x, z);
      for (let y = h - 3; y <= h; y++) {
        let type = 'stone';
        if (y === h)        type = h <= 3 ? 'sand' : 'grass';
        else if (y >= h - 2) type = 'dirt';
        put(x, y, z, type);
      }
    }
  }

  // Trees — positions seeded by mulberry32 so the same seed yields the same forest.
  const rand = mulberry32(seed);
  for (let i = 0; i < TREE_COUNT; i++) {
    const tx = (rand() * SIZE * 2 - SIZE) | 0;
    const tz = (rand() * SIZE * 2 - SIZE) | 0;
    const h = heightAt(tx, tz);
    if (h <= 4) continue;   // skip over sand (matches client behaviour)
    // trunk
    for (let j = 1; j <= 4; j++) put(tx, h + j, tz, 'wood');
    // leaves
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        for (let dy = 3; dy <= 5; dy++) {
          if (Math.abs(dx) + Math.abs(dz) + Math.abs(dy - 4) > 4) continue;
          if (dx === 0 && dz === 0 && dy < 5) continue;
          put(tx + dx, h + dy, tz + dz, 'leaves');
        }
      }
    }
  }

  const result = [];
  for (const [k, type] of blocks) {
    const [x, y, z] = k.split(',').map(Number);
    result.push({ x, y, z, type });
  }
  return result;
}

/** Spawn point for a fresh room. Places the player above the surface at origin. */
export function spawnPoint() {
  return { x: 0.5, y: heightAt(0, 0) + 3, z: 0.5 };
}

// DigDig mode: deeper stone layer (down to -DIGDIG_DEPTH) so there's room to mine.
// Gold is not baked into terrain — the server scatters it per round.
export const DIGDIG_DEPTH = 8;

export function generateDigDigWorld(seed) {
  const blocks = new Map();
  const put = (x, y, z, type) => {
    const k = `${x},${y},${z}`;
    if (!blocks.has(k)) blocks.set(k, type);
  };

  for (let x = -SIZE; x <= SIZE; x++) {
    for (let z = -SIZE; z <= SIZE; z++) {
      const h = heightAt(x, z);
      put(x, h, z, h <= 3 ? 'sand' : 'grass');
      for (let y = h - 1; y >= h - 2; y--) put(x, y, z, 'dirt');
      for (let y = h - 3; y >= -DIGDIG_DEPTH; y--) put(x, y, z, 'stone');
    }
  }

  // A few surface trees for landmarks.
  const rand = mulberry32(seed);
  for (let i = 0; i < 6; i++) {
    const tx = (rand() * SIZE * 2 - SIZE) | 0;
    const tz = (rand() * SIZE * 2 - SIZE) | 0;
    const h = heightAt(tx, tz);
    if (h <= 4) continue;
    for (let j = 1; j <= 4; j++) put(tx, h + j, tz, 'wood');
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        for (let dy = 3; dy <= 5; dy++) {
          if (Math.abs(dx) + Math.abs(dz) + Math.abs(dy - 4) > 4) continue;
          if (dx === 0 && dz === 0 && dy < 5) continue;
          put(tx + dx, h + dy, tz + dz, 'leaves');
        }
      }
    }
  }

  const result = [];
  for (const [k, type] of blocks) {
    const [x, y, z] = k.split(',').map(Number);
    result.push({ x, y, z, type });
  }
  return result;
}
