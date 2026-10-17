const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const GB_FIRST_NAMES = Object.freeze([
  'Oliver', 'George', 'Harry', 'Jack', 'Noah', 'Charlie', 'Thomas',
  'James', 'William', 'Henry', 'Amelia', 'Olivia', 'Isla', 'Emily',
  'Sophie', 'Grace', 'Charlotte', 'Ella', 'Lucy', 'Alice',
]);

const GB_LAST_NAMES = Object.freeze([
  'Smith', 'Jones', 'Taylor', 'Brown', 'Williams', 'Wilson', 'Johnson',
  'Davies', 'Patel', 'Robinson', 'Wright', 'Thompson', 'Evans',
  'Walker', 'White', 'Edwards', 'Green', 'Hall', 'Thomas', 'Clarke',
]);

const GB_ADDRESSES = Object.freeze([
  ['Arundel Gardens', '12', 'Notting Hill', 'London', 'Greater London', 'W11 2LW'],
  ['Noel Road', '25', 'Islington', 'London', 'Greater London', 'N1 8HQ'],
  ['Derngate', '78', 'Semilong', 'Northampton', 'Northamptonshire', 'NN1 1UH'],
  ['Forthlin Road', '20', 'Allerton', 'Liverpool', 'Merseyside', 'L18 9TL'],
  ['Menlove Avenue', '251', 'Woolton', 'Liverpool', 'Merseyside', 'L25 7SA'],
  ['Plymouth Grove', '84', 'Chorlton-on-Medlock', 'Manchester', 'Greater Manchester', 'M13 9LW'],
]);

const GB_BINS = Object.freeze([
  ['402396', '402396', 16, 'visa'],
  ['410970', '410970', 16, 'visa'],
  ['412983', '412983', 16, 'visa'],
  ['450198', '450198', 16, 'visa'],
  ['450823', '450823', 16, 'visa'],
  ['455206', '455206', 16, 'visa'],
  ['512687', '512687', 16, 'mastercard'],
  ['518652', '518652', 16, 'mastercard'],
  ['528683', '528683', 16, 'mastercard'],
  ['530127', '530127', 16, 'mastercard'],
  ['531200', '531200', 16, 'mastercard'],
  ['543460', '543460', 16, 'mastercard'],
  ['545140', '545140', 16, 'mastercard'],
]);

const BIN_FILE = path.join(__dirname, '..', '..', 'data', 'card_bin_ranges.csv');
const HASH_FILE = path.join(__dirname, '..', '..', 'data', 'used_local_card_hashes.txt');

let regionalBinCache = null;
let usedCardHashes = null;

function parseCsvLine(line) {
  const out = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (ch === ',' && !quoted) {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out;
}

function loadRegionalBinRanges() {
  if (regionalBinCache) return regionalBinCache;
  const ranges = {};
  try {
    const text = fs.readFileSync(BIN_FILE, 'utf8');
    const lines = text.split(/\r?\n/);
    const header = parseCsvLine(lines[0] || '').map((item) => item.trim().toLowerCase());
    const idx = (name) => header.indexOf(name);
    const countryIdx = idx('country');
    const schemeIdx = idx('scheme');
    const typeIdx = idx('type');
    const startIdx = idx('iin_start');
    const endIdx = idx('iin_end');
    const lengthIdx = idx('number_length');
    for (const line of lines.slice(1)) {
      if (!line.trim()) continue;
      const cols = parseCsvLine(line);
      const country = String(cols[countryIdx] || '').trim().toUpperCase();
      const scheme = String(cols[schemeIdx] || '').trim().toLowerCase();
      const productType = String(cols[typeIdx] || '').trim().toLowerCase();
      const start = String(cols[startIdx] || '').replace(/\D/g, '');
      const end = String(cols[endIdx] || '').replace(/\D/g, '');
      const lengthRaw = String(cols[lengthIdx] || '').trim();
      const numberLength = /^\d+$/.test(lengthRaw) ? Number(lengthRaw) : 16;
      if (!country || !['visa', 'mastercard'].includes(scheme) || productType !== 'credit' || !start || numberLength !== 16) {
        continue;
      }
      (ranges[country] ||= []).push([start, end, numberLength, scheme]);
    }
  } catch {
    ranges.GB = GB_BINS.map((row) => [...row]);
  }
  if (!ranges.GB?.length) ranges.GB = GB_BINS.map((row) => [...row]);
  regionalBinCache = ranges;
  return ranges;
}

function loadUsedCardHashes() {
  if (usedCardHashes) return usedCardHashes;
  usedCardHashes = new Set();
  try {
    for (const line of fs.readFileSync(HASH_FILE, 'utf8').split(/\r?\n/)) {
      if (line.trim()) usedCardHashes.add(line.trim());
    }
  } catch { /* first run */ }
  return usedCardHashes;
}

function rememberCardHash(fingerprint) {
  const used = loadUsedCardHashes();
  used.add(fingerprint);
  try {
    fs.mkdirSync(path.dirname(HASH_FILE), { recursive: true });
    fs.appendFileSync(HASH_FILE, `${fingerprint}\n`);
  } catch { /* best effort */ }
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function luhnChecksum(body) {
  let sum = 0;
  let doubleDigit = true;
  for (let i = body.length - 1; i >= 0; i -= 1) {
    let digit = Number(body[i]);
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }
  return String((10 - (sum % 10)) % 10);
}

function generateEteid() {
  const rand = () => Math.floor(Math.random() * 30000000000) - 10000000000;
  return [rand(), rand(), rand(), rand(), rand(), rand(), null, null];
}

function generateRandomEmail() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let user = '';
  for (let i = 0; i < 12; i += 1) user += chars[Math.floor(Math.random() * chars.length)];
  return `${user}@gmail.com`;
}

function generatePassword() {
  const lower = 'abcdefghijklmnopqrstuvwxyz';
  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const digits = '0123456789';
  const symbols = '!@#$%^';
  const chars = [
    ...Array.from({ length: 6 }, () => pick(lower)),
    ...Array.from({ length: 3 }, () => pick(upper)),
    ...Array.from({ length: 3 }, () => pick(digits)),
    ...Array.from({ length: 2 }, () => pick(symbols)),
  ];
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

function generateDob() {
  const day = String(1 + Math.floor(Math.random() * 28)).padStart(2, '0');
  const month = String(1 + Math.floor(Math.random() * 12)).padStart(2, '0');
  const year = String(1980 + Math.floor(Math.random() * 21));
  return `${day}/${month}/${year}`;
}

function parsePhone(phone, country = 'GB') {
  const digits = String(phone || '').replace(/\D/g, '');
  const phoneCountryCode = country === 'GB' ? '+44' : '+44';
  const calling = phoneCountryCode.replace(/^\+/, '');
  let phoneLocal = digits.startsWith(calling) && digits.length > calling.length
    ? digits.slice(calling.length)
    : digits;
  if (phoneLocal.startsWith('0') && calling) phoneLocal = phoneLocal.slice(1);
  return {
    phone: `${phoneCountryCode}${phoneLocal}`,
    phone_country_code: phoneCountryCode,
    phone_local: phoneLocal,
  };
}

function generateUser(phone, country = 'GB') {
  const parsed = parsePhone(phone, country);
  return {
    first_name: pick(GB_FIRST_NAMES),
    last_name: pick(GB_LAST_NAMES),
    email: generateRandomEmail(),
    password: generatePassword(),
    dob: generateDob(),
    country,
    ...parsed,
  };
}

function generateAddress(country = 'GB') {
  const [street, house_number, district, city, state, postal_code] = pick(GB_ADDRESSES);
  return { street, house_number, district, city, state, postal_code, country };
}

function generateCard(country = 'GB') {
  const region = String(country || 'GB').trim().toUpperCase() || 'GB';
  const candidates = loadRegionalBinRanges()[region] || loadRegionalBinRanges().GB || GB_BINS;
  if (!candidates.length) throw new Error(`no regional Visa/Mastercard credit BIN data for ${region}`);
  const used = loadUsedCardHashes();
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const [start, end, length] = pick(candidates);
    let prefix = start;
    if (end && end.length === start.length && Number(end) >= Number(start)) {
      const n = Number(start) + Math.floor(Math.random() * (Number(end) - Number(start) + 1));
      prefix = String(n).padStart(start.length, '0');
    }
    const remaining = length - prefix.length - 1;
    if (remaining < 0) continue;
    let body = prefix;
    for (let i = 0; i < remaining; i += 1) body += String(Math.floor(Math.random() * 10));
    const number = body + luhnChecksum(body);
    const fingerprint = crypto.createHash('sha256').update(number).digest('hex');
    if (used.has(fingerprint)) continue;
    rememberCardHash(fingerprint);
    const month = String(1 + Math.floor(Math.random() * 12)).padStart(2, '0');
    const year = String(2027 + Math.floor(Math.random() * 5));
    return {
      number,
      expiry: `${month}/${year}`,
      cvv: String(Math.floor(Math.random() * 1000)).padStart(3, '0'),
      card_type: 'CREDIT',
      issuer_country: region,
    };
  }
  throw new Error(`regional card generation exhausted for ${region}`);
}

function cardIssuerType(number) {
  const prefix2 = Number(String(number).slice(0, 2));
  const prefix4 = Number(String(number).slice(0, 4));
  if ((prefix2 >= 51 && prefix2 <= 55) || (prefix4 >= 2221 && prefix4 <= 2720)) return 'MASTER_CARD';
  if (String(number).startsWith('4')) return 'VISA';
  if (String(number).startsWith('3')) return 'AMEX';
  if (String(number).startsWith('6')) return 'DISCOVER';
  return 'VISA';
}

function createSessionState(baToken = '') {
  return {
    ba_token: baToken,
    ec_token: '',
    ssrt: '',
    ctx_id: '',
    nsid: '',
    d_id: '',
    user_id: '',
    datadome_cookie: '',
    tltsid: '',
    tltdid: '',
    paypal_client_metadata_id: crypto.randomUUID(),
    euat_token: '',
    return_url: '',
    content_hash: '',
    content_identifier: '',
    signup_url: '',
    signup_context_ready: false,
    onboarding_url: '',
    show_create_account_action_id: '',
    create_user_action_id: '',
  };
}

function updateStateFromCookies(state, cookies = []) {
  for (const cookie of cookies) {
    const name = String(cookie?.name || '');
    const value = String(cookie?.value || '');
    if (name === 'nsid') state.nsid = value;
    else if (name === 'd_id') state.d_id = value;
    else if (name === 'datadome') state.datadome_cookie = value;
    else if (name === 'TLTSID') state.tltsid = value;
    else if (name === 'TLTDID') state.tltdid = value;
    else if (name === 'AV894Kt2TSumQQrJwe-8mzmyREO') state.euat_token = value;
  }
  return state;
}

function gbBillingLine1(address) {
  return `${address.house_number} ${address.street}`.trim();
}

module.exports = {
  GB_FIRST_NAMES,
  GB_LAST_NAMES,
  GB_ADDRESSES,
  GB_BINS,
  loadRegionalBinRanges,
  luhnChecksum,
  generateEteid,
  generateRandomEmail,
  generatePassword,
  generateDob,
  parsePhone,
  generateUser,
  generateAddress,
  generateCard,
  cardIssuerType,
  createSessionState,
  updateStateFromCookies,
  gbBillingLine1,
};
