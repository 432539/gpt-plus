const crypto = require('node:crypto');

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function decodeBase32(value) {
  const input = String(value || '').toUpperCase().replace(/[\s=-]+/g, '');
  if (!input) throw new TypeError('TOTP secret is empty');
  let bits = 0;
  let count = 0;
  const bytes = [];
  for (const character of input) {
    const index = BASE32.indexOf(character);
    if (index < 0) throw new TypeError('TOTP secret is not valid Base32');
    bits = (bits << 5) | index;
    count += 5;
    while (count >= 8) {
      count -= 8;
      bytes.push((bits >>> count) & 0xff);
      bits &= (1 << count) - 1;
    }
  }
  if (!bytes.length) throw new TypeError('TOTP secret is too short');
  return Buffer.from(bytes);
}

function totpSnapshot(secret, options = {}) {
  const period = Math.max(1, Number(options.period) || 30);
  const digits = Math.max(6, Math.min(10, Number(options.digits) || 6));
  const now = Number(options.now ?? Date.now());
  const counter = BigInt(Math.floor(now / (period * 1000)));
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(counter);
  const digest = crypto.createHmac('sha1', decodeBase32(secret)).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return {
    code: String(binary % (10 ** digits)).padStart(digits, '0'),
    validFor: period - (Math.floor(now / 1000) % period),
    counter,
  };
}

const totpCode = (secret, options) => totpSnapshot(secret, options).code;

exports.decodeBase32 = decodeBase32;
exports.totpSnapshot = totpSnapshot;
exports.totpCode = totpCode;
