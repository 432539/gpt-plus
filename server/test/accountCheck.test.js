const test = require('node:test');
const assert = require('node:assert/strict');
const {
  accountCheckPayloadUsable,
  parseAccountCheck,
  resolveTrial,
  resolveTrialOnce,
  resolveStoredPlan,
  activatedPlanFromCheck,
  subscriptionExpiresFromCheck,
  normalizeTrialFlag,
  promoCampaignId,
} = require('../src/utils/accountCheck');

function freeAccount(campaign = '') {
  const promo = campaign ? { plus: { id: campaign } } : {};
  return {
    account_ordering: ['acc-1'],
    accounts: {
      'acc-1': {
        account: { plan_type: 'free' },
        entitlement: { subscription_plan: 'chatgptfreeplan' },
        eligible_promo_campaigns: promo,
      },
    },
  };
}

test('usable check without trial is 没试用, not unknown', () => {
  const payload = freeAccount();
  assert.equal(accountCheckPayloadUsable(payload), true);
  const parsed = parseAccountCheck(payload);
  assert.equal(parsed.is_trial, false);
  assert.equal(parsed.plan_status, '免费');
  assert.equal(resolveTrial({ check: payload }).has_trial, 0);
});

test('plus-1-month-free campaign is 有试用', () => {
  const payload = freeAccount('plus-1-month-free');
  assert.equal(promoCampaignId(payload), 'plus-1-month-free');
  assert.equal(resolveTrial({ check: payload }).has_trial, 1);
});

test('promo campaign parser supports recursively nested normalized campaign keys', () => {
  assert.equal(
    promoCampaignId({
      accounts: {
        'acc-1': {
          offers: [{ metadata: { promo_campaign_id: 'plus-1-month-free' } }],
        },
      },
    }, 'acc-1'),
    'plus-1-month-free',
  );
  assert.equal(
    promoCampaignId({ wrapper: { campaignId: 'plus-1-month-free' } }),
    'plus-1-month-free',
  );
});

test('promotion_type_label trial is 有试用', () => {
  const payload = {
    account_ordering: ['acc-1'],
    accounts: {
      'acc-1': {
        account: { plan_type: 'free' },
        entitlement: {},
        eligible_promo_campaigns: {
          plus: { id: 'other-promo', metadata: { promotion_type_label: '1-month free trial' } },
        },
      },
    },
  };
  const parsed = parseAccountCheck(payload);
  assert.equal(parsed.is_trial, true);
  assert.equal(parsed.plan_status, '试用资格');
  assert.equal(resolveTrial({ check: payload }).has_trial, 1);
});

test('entitlement.trial is 试用中', () => {
  const payload = {
    account_ordering: ['acc-1'],
    accounts: {
      'acc-1': {
        account: { plan_type: 'plus' },
        entitlement: { trial: { expires_at: '2026-09-01' }, subscription_plan: 'chatgptplusplan' },
      },
    },
  };
  const parsed = parseAccountCheck(payload);
  assert.equal(parsed.plan_status, '试用中');
  assert.equal(resolveTrial({ check: payload }).has_trial, 1);
});

test('missing or html check payload stays unknown', () => {
  assert.equal(accountCheckPayloadUsable(null), false);
  assert.equal(accountCheckPayloadUsable('ok'), false);
  assert.equal(accountCheckPayloadUsable({ detail: 'empty' }), false);
  assert.equal(accountCheckPayloadUsable({ accounts: {} }), false);
  assert.equal(resolveTrial({ check: { detail: 'empty' } }).has_trial, null);
  assert.equal(resolveTrial({}).has_trial, null);
});

test('JWT chatgpt_plus_on_free_trial is 是 even without check body', () => {
  const token = `x.${Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': { chatgpt_plan_type: 'free', chatgpt_plus_on_free_trial: true },
  })).toString('base64url')}.x`;
  assert.equal(resolveTrial({ accessToken: token }).has_trial, 1);
});

test('normalizeTrialFlag accepts 是/否', () => {
  assert.equal(normalizeTrialFlag('是'), 1);
  assert.equal(normalizeTrialFlag('否'), 0);
  assert.equal(normalizeTrialFlag('有试用'), 1);
  assert.equal(normalizeTrialFlag('没试用'), 0);
});

test('trial parse-once keeps cached 否 even if a later payload looks eligible', () => {
  const cached = resolveTrialOnce({ has_trial: 0, trial_label: '' }, { check: freeAccount('plus-1-month-free') });
  assert.equal(cached.has_trial, 0);
  assert.equal(cached.source, 'cached');
  const first = resolveTrialOnce({ has_trial: null }, { check: freeAccount() });
  assert.equal(first.has_trial, 0);
  assert.equal(first.source, 'check');
});

test('new register plan is Free unless check is paid Plus', () => {
  assert.equal(resolveStoredPlan({ check: freeAccount(), fallback: 'Free' }), 'Free');
  assert.equal(resolveStoredPlan({ check: freeAccount('plus-1-month-free'), fallback: 'Free' }), 'Free');
  assert.equal(resolveStoredPlan({ fallback: 'Free' }), 'Free');
  const paid = {
    account_ordering: ['acc-1'],
    accounts: {
      'acc-1': {
        account: { plan_type: 'plus' },
        entitlement: {
          subscription_plan: 'chatgptplusplan',
          has_active_subscription: true,
          billing_period: 'monthly',
        },
      },
    },
  };
  assert.equal(resolveStoredPlan({ check: paid, fallback: 'Free' }), 'Plus');
  const jwtPlusToken = `x.${Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' },
  })).toString('base64url')}.x`;
  assert.equal(resolveStoredPlan({ check: freeAccount(), fallback: 'Plus' }), 'Free');
  assert.ok(jwtPlusToken);
});

test('activatedPlanFromCheck treats ChatGPT-reported plus including trial-plus, not Free', () => {
  assert.equal(activatedPlanFromCheck(freeAccount()), '');
  assert.equal(activatedPlanFromCheck(freeAccount('plus-1-month-free')), '');
  const trialPlus = {
    account_ordering: ['acc-1'],
    accounts: {
      'acc-1': {
        account: { plan_type: 'plus' },
        entitlement: { trial: { expires_at: '2026-09-01' }, subscription_plan: 'chatgptplusplan' },
      },
    },
  };
  assert.equal(activatedPlanFromCheck(trialPlus), 'Plus');
  const paid = {
    account_ordering: ['acc-1'],
    accounts: {
      'acc-1': {
        account: { plan_type: 'plus' },
        entitlement: {
          subscription_plan: 'chatgptplusplan',
          has_active_subscription: true,
          billing_period: 'monthly',
        },
      },
    },
  };
  assert.equal(activatedPlanFromCheck(paid), 'Plus');
});

test('subscriptionExpiresFromCheck prefers entitlement/trial expiry', () => {
  assert.equal(subscriptionExpiresFromCheck({
    account_ordering: ['acc-1'],
    accounts: {
      'acc-1': {
        account: { plan_type: 'plus' },
        entitlement: {
          subscription_plan: 'chatgptplusplan',
          expires_at: '2026-09-20T12:00:00Z',
        },
      },
    },
  }, false), '2026-09-20 12:00:00');
});
