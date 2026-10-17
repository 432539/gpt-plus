const CAMPAIGN_ID = 'plus-1-month-free';
const PAID_PLANS = new Set(['Plus', 'Pro', 'Team']);

function decodeJwtPayload(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

function jwtAuthClaims(token) {
  const payload = decodeJwtPayload(token);
  const auth = payload?.['https://api.openai.com/auth'];
  return auth && typeof auth === 'object' ? auth : {};
}

function trialFromJwt(token) {
  const auth = jwtAuthClaims(token);
  const onTrial = auth.chatgpt_plus_on_free_trial === true;
  const hasUsed = auth.has_used_trial === true
    || auth.chatgpt_has_used_free_trial === true
    || auth.has_used_chatgpt_plus_trial === true;
  return {
    usable: Boolean(token) && Object.keys(auth).length > 0,
    onTrial,
    hasUsed,
  };
}

function primaryAccountRecord(data) {
  const accounts = data?.accounts;
  if (!accounts || typeof accounts !== 'object') return null;
  const ordering = data.account_ordering;
  if (Array.isArray(ordering) && ordering.length) {
    const hit = accounts[String(ordering[0])];
    if (hit && typeof hit === 'object') return hit;
  }
  if (accounts.default && typeof accounts.default === 'object') return accounts.default;
  for (const [key, record] of Object.entries(accounts)) {
    if (key === 'default' || !record || typeof record !== 'object') continue;
    if (record.account || record.entitlement || record.eligible_promo_campaigns) return record;
  }
  return null;
}

function accountCheckPayloadUsable(data) {
  if (!data || typeof data !== 'object') return false;
  const accounts = data.accounts;
  if (!accounts || typeof accounts !== 'object' || !Object.keys(accounts).length) return false;
  return Boolean(primaryAccountRecord(data));
}

function scanTrialOfferLabel(primary) {
  const labels = [];
  const collect = (node, depth = 0) => {
    if (depth > 5 || node == null) return;
    if (Array.isArray(node)) {
      for (const value of node) collect(value, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    const val = node.promotion_type_label;
    if (typeof val === 'string' && val.trim()) labels.push(val.trim());
    for (const value of Object.values(node)) collect(value, depth + 1);
  };
  if (primary && typeof primary === 'object') {
    collect(primary.eligible_promo_campaigns);
    collect(primary.eligible_offers);
    collect(primary.promo_data);
  }
  return labels.find((label) => /trial|免费试用|试用/i.test(label)) || '';
}

function promoCampaignId(data, accountId = '') {
  const findCampaignId = (value, seen = new Set()) => {
    if (!value || typeof value !== 'object' || seen.has(value)) return '';
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) {
        const hit = findCampaignId(item, seen);
        if (hit) return hit;
      }
      return '';
    }
    for (const [key, nested] of Object.entries(value)) {
      const normalized = String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
      if (normalized === 'promocampaignid' || normalized === 'campaignid') {
        const hit = String(nested || '').trim();
        if (hit) return hit;
      }
      const hit = findCampaignId(nested, seen);
      if (hit) return hit;
    }
    return '';
  };
  const fromRecord = (record) => {
    if (!record || typeof record !== 'object') return '';
    const campaigns = record.eligible_promo_campaigns;
    if (campaigns && typeof campaigns === 'object') {
      const plus = campaigns.plus;
      if (plus && typeof plus === 'object' && plus.id) return String(plus.id).trim();
      if (campaigns.id) return String(campaigns.id).trim();
    }
    return findCampaignId(record);
  };
  if (!data || typeof data !== 'object') return '';
  const accounts = data.accounts;
  if (accounts && typeof accounts === 'object') {
    const id = String(accountId || '').trim();
    if (id && accounts[id]) {
      const hit = fromRecord(accounts[id]);
      if (hit) return hit;
    }
    const fromDefault = fromRecord(accounts.default);
    if (fromDefault) return fromDefault;
    for (const [key, record] of Object.entries(accounts)) {
      if (key === 'default') continue;
      const hit = fromRecord(record);
      if (hit) return hit;
    }
  }
  return fromRecord(data) || findCampaignId(data);
}

function parseAccountCheck(data) {
  const result = {
    plan_code: 'free',
    plan_label: 'Free',
    subscription_plan: '',
    is_trial: false,
    trial_label: '',
    plan_status: '免费',
    paid: false,
  };
  const primary = primaryAccountRecord(data);
  if (!primary) return result;
  const account = primary.account && typeof primary.account === 'object' ? primary.account : {};
  const entitlement = primary.entitlement && typeof primary.entitlement === 'object' ? primary.entitlement : {};
  const subscriptionPlan = String(entitlement.subscription_plan || account.plan_type || '').trim();
  result.subscription_plan = subscriptionPlan;
  const low = subscriptionPlan.toLowerCase();
  if (low.includes('plus')) {
    result.plan_code = 'plus';
    result.plan_label = 'Plus';
  } else if (low.includes('pro')) {
    result.plan_code = 'pro';
    result.plan_label = 'Pro';
  } else if (low.includes('team')) {
    result.plan_code = 'team';
    result.plan_label = 'Team';
  } else if (low.includes('go')) {
    result.plan_code = 'go';
    result.plan_label = 'Go';
  } else if (subscriptionPlan) {
    result.plan_code = low.includes('free') ? 'free' : subscriptionPlan;
    result.plan_label = low.includes('free') ? 'Free' : subscriptionPlan;
  }

  const trial = entitlement.trial;
  const trialLabel = scanTrialOfferLabel(primary);
  const hasActive = Boolean(entitlement.has_active_subscription);
  const billingPeriod = entitlement.billing_period;
  if (trial != null && trial !== false && trial !== '') {
    result.is_trial = true;
    result.plan_status = '试用中';
  } else if (trialLabel) {
    result.is_trial = true;
    result.trial_label = trialLabel;
    result.plan_status = '试用资格';
  } else if (hasActive && billingPeriod) {
    result.plan_status = '付费';
    result.paid = true;
  } else {
    result.plan_status = '免费';
  }
  return result;
}

function normalizeTrialFlag(value) {
  if (value === true || value === 1 || value === '1' || value === '有试用' || value === '是') return 1;
  if (value === false || value === 0 || value === '0' || value === '没试用' || value === '否') return 0;
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim().toLowerCase();
  if (['true', 'yes', 'trial', 'eligible', '是'].includes(text)) return 1;
  if (['false', 'no', 'none', 'unknown', 'null', '否'].includes(text)) return text === 'unknown' || text === 'null' ? null : 0;
  return null;
}

function trialKnown(value) {
  return value === 0 || value === 1 || value === true || value === false;
}

function isTrialUnset(value) {
  if (trialKnown(value)) return false;
  const text = String(value ?? '').trim().toLowerCase();
  return text === '' || text === 'null' || text === 'undefined';
}

function trialUnsetSql(column = 'has_trial') {
  const name = String(column || 'has_trial').replace(/[^\w]/g, '') || 'has_trial';
  return `(${name} IS NULL OR TRIM(CAST(${name} AS TEXT)) = '')`;
}

function resolveTrial({ check, accessToken, hasTrial } = {}) {
  const explicit = normalizeTrialFlag(hasTrial);
  if (explicit === 0 || explicit === 1) return { has_trial: explicit, trial_label: '', source: 'explicit' };
  const jwt = trialFromJwt(accessToken);
  if (jwt.onTrial) {
    return { has_trial: 1, trial_label: 'chatgpt_plus_on_free_trial', source: 'jwt' };
  }
  if (accountCheckPayloadUsable(check)) {
    const parsed = parseAccountCheck(check);
    const campaign = String(promoCampaignId(check) || '').trim().toLowerCase();
    if (parsed.is_trial || campaign === CAMPAIGN_ID) {
      return {
        has_trial: 1,
        trial_label: parsed.trial_label || (campaign === CAMPAIGN_ID ? CAMPAIGN_ID : ''),
        source: 'check',
        parsed,
      };
    }
    return { has_trial: 0, trial_label: '', source: 'check', parsed };
  }
  return { has_trial: null, trial_label: '', source: 'unknown' };
}

function resolveTrialOnce(row, payload = {}) {
  if (trialKnown(row?.has_trial)) {
    return {
      has_trial: row.has_trial === true || row.has_trial === 1 ? 1 : 0,
      trial_label: String(row.trial_label || ''),
      source: 'cached',
    };
  }
  return resolveTrial(payload);
}

// New registers: Free unless accounts/check says a paid Plus/Pro/Team plan.
// JWT chatgpt_plan_type=plus (including trial) is not treated as paid Plus.
function resolveStoredPlan({ check, fallback = 'Free' } = {}) {
  if (!accountCheckPayloadUsable(check)) return String(fallback || 'Free').trim() || 'Free';
  const parsed = parseAccountCheck(check);
  if (parsed.paid && PAID_PLANS.has(parsed.plan_label)) return parsed.plan_label;
  return 'Free';
}

function paidPlanFromCheck(check) {
  if (!accountCheckPayloadUsable(check)) return '';
  const parsed = parseAccountCheck(check);
  return parsed.paid && PAID_PLANS.has(parsed.plan_label) ? parsed.plan_label : '';
}

// After PayPal authorize: ChatGPT itself reporting Plus/Pro/Team counts,
// including trial-plus (plan_label Plus + entitlement.trial). Free / 试用资格
// on a free plan does not.
function activatedPlanFromCheck(check) {
  if (!accountCheckPayloadUsable(check)) return '';
  const parsed = parseAccountCheck(check);
  if (PAID_PLANS.has(parsed.plan_label)) return parsed.plan_label;
  const low = String(parsed.subscription_plan || '').toLowerCase();
  if (low.includes('chatgptplus') || /(^|[^a-z])plus([^a-z]|$)/.test(low)) return 'Plus';
  if (low.includes('chatgptpro') || /(^|[^a-z])pro([^a-z]|$)/.test(low)) return 'Pro';
  if (low.includes('team')) return 'Team';
  return '';
}

function isPaidPlan(planType) {
  return PAID_PLANS.has(String(planType || '').trim());
}

function subscriptionExpiresFromCheck(data, fallbackDays = 30) {
  const walk = (node, depth = 0) => {
    if (!node || depth > 6) return '';
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = walk(item, depth + 1);
        if (found) return found;
      }
      return '';
    }
    if (typeof node !== 'object') return '';
    const trial = node.trial;
    if (trial && typeof trial === 'object' && trial.expires_at) return String(trial.expires_at);
    if (node.expires_at && (node.subscription_plan || node.plan_type || node.trial)) return String(node.expires_at);
    for (const value of Object.values(node)) {
      const found = walk(value, depth + 1);
      if (found) return found;
    }
    return '';
  };
  const found = walk(data);
  if (found) {
    const stamp = found.replace('T', ' ').slice(0, 19);
    if (stamp) return stamp;
  }
  if (fallbackDays == null || fallbackDays === false) return '';
  const later = new Date(Date.now() + Number(fallbackDays) * 86400000);
  return later.toISOString().replace('T', ' ').slice(0, 19);
}

module.exports = {
  CAMPAIGN_ID,
  PAID_PLANS,
  accountCheckPayloadUsable,
  parseAccountCheck,
  promoCampaignId,
  trialFromJwt,
  jwtAuthClaims,
  resolveTrial,
  resolveTrialOnce,
  resolveStoredPlan,
  paidPlanFromCheck,
  activatedPlanFromCheck,
  subscriptionExpiresFromCheck,
  trialKnown,
  isTrialUnset,
  trialUnsetSql,
  normalizeTrialFlag,
  isPaidPlan,
};
