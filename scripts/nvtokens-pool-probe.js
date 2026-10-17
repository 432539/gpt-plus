#!/usr/bin/env node
const path = require('path');
require(path.join(__dirname, '..', 'server', 'node_modules', 'dotenv')).config({
  path: path.join(__dirname, '..', '.env'),
});

const {
  maskApiKey,
  fetchPriceBoard,
  fetchMerchantRankings,
  fetchPoolSchema,
  postPoolCard,
  suggestListPrice,
  DEFAULT_BASE,
} = require('../server/src/utils/nvtokensPool');

const DUMMY = {
  type: 'codex',
  email: 'nvtokens-probe@example.invalid',
  access_token: 'dummy-access-token-not-a-real-account',
  refresh_token: 'dummy-refresh-token-not-a-real-account',
};

function log(label, value) {
  console.log(label, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

async function main() {
  const apiKey = String(process.env.NVTOKENS_API_KEY || '').trim();
  log('KEY', maskApiKey(apiKey));
  log('BASE', DEFAULT_BASE);

  const board = await fetchPriceBoard();
  log('PRICE_BOARD', {
    status: board.status,
    error: board.error,
    code: board.code,
    plus: board.plus,
    suggest_p25: board.plus ? suggestListPrice(board.plus, 'p25') : null,
    suggest_floor: board.plus ? suggestListPrice(board.plus, 'floor') : null,
    suggest_median: board.plus ? suggestListPrice(board.plus, 'median') : null,
  });

  const ranks = await fetchMerchantRankings();
  log('MERCHANT_RANKINGS', {
    status: ranks.status,
    error: ranks.error,
    code: ranks.code,
    plus_merchant_count: ranks.plus_merchant_count,
  });

  const schema = await fetchPoolSchema({ apiKey });
  log('POOL_SCHEMA', {
    status: schema.status,
    api_key: schema.api_key,
    payload: schema.payload,
  });

  const probes = [];
  const run = async (name, fn) => {
    try {
      const result = await fn();
      probes.push({
        name,
        status: result.status,
        ok: result.ok,
        api_key: result.api_key,
        payload: result.payload,
      });
    } catch (error) {
      probes.push({ name, error: String(error.message || error).slice(0, 180) });
    }
  };

  await run('POST_pool_no_key', () => postPoolCard(DUMMY, '10.00', { omitApiKey: true }));
  await run('POST_pool_bad_key', () => postPoolCard(DUMMY, '10.00', { apiKey: 'irk-invalid-probe-key' }));
  if (apiKey) {
    await run('POST_pool_dummy_cpa', () => postPoolCard(DUMMY, '10.00', { apiKey }));
    await run('POST_pool_dummy_sub2', () => postPoolCard({
      exported_at: new Date().toISOString(),
      proxies: [],
      accounts: [{
        platform: 'openai',
        type: 'oauth',
        name: DUMMY.email,
        credentials: { access_token: DUMMY.access_token, refresh_token: DUMMY.refresh_token, email: DUMMY.email },
        extra: { email: DUMMY.email },
      }],
    }, '10.00', { apiKey }));
    await run('POST_pool_price_only', () => postPoolCard(DUMMY, '10.00', { apiKey, body: { price_yuan: '10.00' } }));
  } else {
    probes.push({ name: 'POST_pool_skipped', reason: 'NVTOKENS_API_KEY missing' });
  }

  log('POOL_PROBES', probes);
  log('REAL_ACCOUNT_LISTED', false);
}

main().catch((error) => {
  console.error('PROBE_FAILED', String(error.message || error).slice(0, 200));
  process.exitCode = 1;
});
