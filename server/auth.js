// Password hashing via Node's built-in crypto.scrypt.
// Salt is 16 random bytes; hash is 64 bytes; both stored hex-encoded.

import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';

const SALT_LEN = 16;
const HASH_LEN = 64;
const SCRYPT_COST = 16384;        // N — ~16ms on modern hardware

function scryptAsync(password, salt) {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, HASH_LEN, { N: SCRYPT_COST }, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

export async function hashPassword(password) {
  const salt = randomBytes(SALT_LEN);
  const derived = await scryptAsync(password, salt);
  return { salt: salt.toString('hex'), hash: derived.toString('hex') };
}

export async function verifyPassword(password, saltHex, hashHex) {
  try {
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    if (expected.length !== HASH_LEN) return false;
    const derived = await scryptAsync(password, salt);
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}
