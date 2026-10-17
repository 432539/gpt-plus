'use strict';

const { totpSnapshot } = require('../lib/totp');
const { headlessInteractionTuning } = require('../lib/register-performance');
const { stableCloakErrorCode } = require('../cloak');
const {
  REGISTER_ACCOUNT_CREATION_REJECTED,
  PASSWORD_SUBMISSION_STAGE,
  isAccountCreationRejectedMessage,
} = require('../lib/account-creation-reject');

const CHATGPT_ORIGIN = 'https://chatgpt.com';
const AUTH_HOST = /(^|\.)auth\.openai\.com$/i;
const AUTH_ORIGIN = 'https://auth.openai.com';
const SIGNUP_SELECTORS = Object.freeze({
  email: ['input[type="email"]', 'input[name="email"]', 'input[autocomplete="username"]', 'input[inputmode="email"]', 'input[placeholder*="mail" i]'],
  password: ['input[autocomplete="new-password"]', 'input[type="password"]', 'input[name="password"]', 'input[placeholder*="password" i]'],
  otp: ['input[autocomplete="one-time-code"]', 'input[name="code"]', 'input[id$="-code"]', 'input[aria-label*="code" i]', 'input[inputmode="numeric"]', 'input[type="tel"]'],
  name: ['input[name="name"]', 'input[autocomplete="name"]', 'input[aria-label*="name" i]', 'input[placeholder*="name" i]', 'input[aria-label*="full name" i]', 'input[placeholder*="full name" i]', 'label:has-text("Name") input', 'input[aria-label*="名前"]', 'input[placeholder*="名前"]', 'input[aria-label*="氏名"]', 'input[placeholder*="氏名"]', 'input[aria-label*="Ad Soyad" i]', 'input[placeholder*="Ad Soyad" i]', '.react-aria-TextField input[type="text"]'],
  age: ['input[name="age"]', 'input[id*="age" i]', 'input[aria-label*="age" i]', 'input[placeholder*="age" i]', '[role="spinbutton"][aria-label*="age" i]', 'input[aria-label*="年齢"]', 'input[aria-label*="Yaş" i]'],
  birthdate: ['input[type="date"]', 'input[name="birthdate"]', 'input[name*="birth" i]', 'input[autocomplete="bday"]', 'input[aria-label*="birth" i]', 'input[placeholder*="birth" i]', 'input[placeholder*="mm/dd" i]', 'input[aria-label*="生年月日"]', 'input[aria-label*="Doğum" i]'],
  birthMonth: ['input[autocomplete="bday-month"]', 'select[name*="month" i]', 'select[aria-label*="month" i]', 'input[name*="month" i]', '[role="spinbutton"][aria-label*="month" i]', '[role="spinbutton"][aria-label*="Month"]', 'input[aria-label="月"]', 'input[aria-label="Ay" i]'],
  birthDay: ['input[autocomplete="bday-day"]', 'select[name*="day" i]', 'select[aria-label*="day" i]', 'input[name*="day" i]', '[role="spinbutton"][aria-label*="day" i]', '[role="spinbutton"][aria-label*="Day"]', 'input[aria-label="日"]', 'input[aria-label="Gün" i]'],
  birthYear: ['input[autocomplete="bday-year"]', 'select[name*="year" i]', 'select[aria-label*="year" i]', 'input[name*="year" i]', '[role="spinbutton"][aria-label*="year" i]', '[role="spinbutton"][aria-label*="Year"]', 'input[aria-label="年"]', 'input[aria-label="Yıl" i]'],
  continue: ['button[data-dd-action-name="Continue"]', 'button[type="submit"]:text-is("Continue")', 'form button[type="submit"]', 'form input[type="submit"]', 'form button:not([type])', 'button:text-is("Continue")', 'button:has-text("Continue")', 'button:has-text("Next")'],
});
const SKIP_SELECTORS = Object.freeze({
  passkey: [
    'button:has-text("Not now")', 'button:has-text("Skip")', 'button:has-text("Maybe later")',
    'button:has-text("Continue without a passkey")', 'button:has-text("Continue without")',
    'a:has-text("Not now")', 'button:has-text("跳过")', 'button:has-text("暂不")',
    '[data-testid*="skip" i]', '[data-dd-action-name*="skip" i]',
  ],
});
const ENTRY_SELECTORS = Object.freeze({
  cookieAccept: ['#onetrust-accept-btn-handler', 'button:has-text("Accept all")', 'button:has-text("接受全部")', 'button:has-text("Tümünü kabul et")'],
  emailField: SIGNUP_SELECTORS.email,
  email: SIGNUP_SELECTORS.email,
  signUp: ['a[href*="signup" i]', 'a[href*="sign-up" i]', 'button[data-testid*="signup" i]', 'a[data-testid*="signup" i]', 'button:has-text("Sign up")', 'a:has-text("Sign up")', 'button:has-text("Create account")', 'a:has-text("Create account")', 'button:has-text("注册")', 'a:has-text("注册")'],
  continueWithPassword: [
    'a[href*="/create-account/password"]',
    '[data-testid*="password" i][role="button"]',
    'button[data-dd-action-name*="password" i]',
    'a:has-text("Continue with password")',
    'button:has-text("Continue with password")',
    'a:has-text("Şifre ile devam et")',
    'button:has-text("Şifre ile devam et")',
    'a:has-text("Parola ile devam et")',
    'button:has-text("Parola ile devam et")',
    'a:has-text("Create a password")',
    'button:has-text("Create a password")',
    'a:has-text("Use password")',
    'button:has-text("Use password")',
    'a:has-text("设置密码")',
    'button:has-text("设置密码")',
    'a:has-text("创建密码")',
    'button:has-text("创建密码")',
    'a:has-text("使用密码")',
    'button:has-text("使用密码")',
    'a:has-text("用密码继续")',
    'button:has-text("用密码继续")',
  ],
});
const FORM_SUBMITTER_SELECTOR = ['button[type="submit"]', 'input[type="submit"]', 'button:not([type])'].join(',');
const ABOUT_GENERIC_SELECTOR_GROUPS = Object.freeze([
  'textarea',
  'select',
  '[role="textbox"]',
  '[role="spinbutton"]',
  '[role="combobox"]',
  '[contenteditable="true"]',
]);
const ABOUT_GENERIC_INPUT_SELECTOR = ABOUT_GENERIC_SELECTOR_GROUPS.join(',');
const LOGIN_SELECTORS = Object.freeze({
  email: SIGNUP_SELECTORS.email,
  password: ['input[autocomplete="current-password"]', 'input[name="password"]', 'input[type="password"]'],
  otp: SIGNUP_SELECTORS.otp,
  continue: [...SIGNUP_SELECTORS.continue, 'button[type="submit"]:has-text("Log in")', 'button:has-text("Log in")'],
  submit: SIGNUP_SELECTORS.continue,
});

const PASSWORD_ADVANCE_MIN_TIMEOUT_MS = 45000;
const OTP_ADVANCE_MIN_TIMEOUT_MS = 30000;
const ABOUT_FORM_MIN_TIMEOUT_MS = 150000;
const ABOUT_CALLBACK_MIN_TIMEOUT_MS = 30000;
const ENTRY_NAVIGATION_MIN_TIMEOUT_MS = 45000;
const ENTRY_EMAIL_FIELD_MIN_TIMEOUT_MS = 30000;
const ENTRY_EMAIL_STABILITY_MIN_TIMEOUT_MS = 30000;
const AUTH_STAGE_MIN_TIMEOUT_MS = 20000;
const LANDING_MIN_TIMEOUT_MS = 45000;
const ABOUT_VALIDATION_RETRY_TIMEOUT_MS = 30000;
const ABOUT_PROFILE_RETRYABLE_ERROR = /(?:valid|required|enter|input).{0,40}(?:\bage\b|\bbirth(?:day|date)\b)|(?:\bage\b|\bbirth(?:day|date)\b).{0,40}(?:valid|required|enter|input)|(?:could(?:n['’]?t| not)|cannot|unable to).{0,80}create (?:an? )?account.{0,80}(?:information|try again)|hmm,?\s*that doesn['’]?t look right.{0,40}try again|(?:valid|required|birth|age|try again|enter (?:your )?(?:name|age)|姓名|年龄|生日|年齢|doğum|yaş)/iu;
const RECOVERABLE_DOM_INTERACTION_ERROR = /pointer[_ -]?events|covered by|intercepts pointer|detached|stale|not attached|element is not attached|execution context was destroyed/i;
const SAFE_CONSENT_LABEL = /^(?:Accept All|Accept all|Allow all|同意全部|接受全部)$/i;

const sleep = (session, ms) => typeof session.wait === 'function'
  ? session.wait(ms)
  : new Promise(resolve => setTimeout(resolve, ms));
const currentUrl = session => {
  try { return String(session.page.url() || ''); } catch { return ''; }
};
const active = cancelled => {
  if (!cancelled?.()) return;
  throw Object.assign(new Error('任务已取消'), { code: 'JOB_CANCELLED' });
};
const flowError = (message, code, cause) => Object.assign(new Error(message), {
  code, ...(cause ? { cause, cloak_code: stableCloakErrorCode(cause) } : {}),
});

function inferHeadlessFailureCode(code, inlineError = '') {
  if (isAccountCreationRejectedMessage(inlineError)) return REGISTER_ACCOUNT_CREATION_REJECTED;
  const requested = String(code || '').trim() || 'REGISTER_HEADLESS_FAILED';
  return /account.*already.*exists|already registered|已有账号|账号已存在|邮箱已存在|zaten.*(?:mevcut|kayıtlı)/iu.test(String(inlineError || ''))
    ? 'REGISTER_HEADLESS_EMAIL_NOT_NEW'
    : requested;
}

function passwordAdvanceFailure(inline) {
  const text = String(inline || '').trim();
  return Object.assign(
    flowError(`密码提交后页面未进入验证码步骤${text ? `：${text}` : ''}`, inferHeadlessFailureCode('REGISTER_HEADLESS_PASSWORD_STALLED', text)),
    { inline_error: text, stage: PASSWORD_SUBMISSION_STAGE },
  );
}
const DEFAULT_STEP_TIMEOUT_MS = 45000;
const empiricalStageTimeoutMs = (value, observed) => {
  const requested = Number(value) || 0;
  if (requested > 0 && requested < DEFAULT_STEP_TIMEOUT_MS) return requested;
  return Math.max(observed, requested > DEFAULT_STEP_TIMEOUT_MS ? requested : 0);
};
const passwordAdvanceTimeoutMs = value => empiricalStageTimeoutMs(value, PASSWORD_ADVANCE_MIN_TIMEOUT_MS);
const otpAdvanceTimeoutMs = value => empiricalStageTimeoutMs(value, OTP_ADVANCE_MIN_TIMEOUT_MS);
const aboutFormTimeoutMs = value => empiricalStageTimeoutMs(value, ABOUT_FORM_MIN_TIMEOUT_MS);
const aboutCallbackTimeoutMs = value => empiricalStageTimeoutMs(value, ABOUT_CALLBACK_MIN_TIMEOUT_MS);
const entryNavigationTimeoutMs = value => empiricalStageTimeoutMs(value, ENTRY_NAVIGATION_MIN_TIMEOUT_MS);
const entryEmailFieldTimeoutMs = value => empiricalStageTimeoutMs(value, ENTRY_EMAIL_FIELD_MIN_TIMEOUT_MS);
const authStageTimeoutMs = value => empiricalStageTimeoutMs(value, AUTH_STAGE_MIN_TIMEOUT_MS);
const landingTimeoutMs = value => empiricalStageTimeoutMs(value, LANDING_MIN_TIMEOUT_MS);

function classifyAboutBirthdaySegments(fields = []) {
  const hints = fields.map(item => [item?.type, item?.name, item?.id, item?.autocomplete, item?.placeholder, item?.ariaLabel, item?.labelText].filter(Boolean).join(' ').toLowerCase());
  const monthIndex = hints.findIndex(value => /month|bday-month|(?:^|\s)月|(?:^|\s)ay(?:$|\s)/iu.test(value));
  const dayIndex = hints.findIndex(value => /day|bday-day|(?:^|\s)日|(?:^|\s)gün(?:$|\s)/iu.test(value));
  const yearIndex = hints.findIndex(value => /year|yyyy|bday-year|(?:^|\s)年|(?:^|\s)yıl(?:$|\s)/iu.test(value));
  return monthIndex >= 0 && dayIndex >= 0 && yearIndex >= 0 && new Set([monthIndex, dayIndex, yearIndex]).size === 3
    ? { monthIndex, dayIndex, yearIndex }
    : null;
}

function classifyAboutInputDescriptors(fields = [], title = '') {
  const hints = fields.map(item => [item?.type, item?.name, item?.id, item?.autocomplete, item?.placeholder, item?.ariaLabel, item?.labelText].filter(Boolean).join(' ').toLowerCase());
  let nameIndex = hints.findIndex(value => /full[_ -]?name|(^|\s)name($|\s)|名前|氏名|ad soyad|tam ad/iu.test(value));
  const birthIndex = hints.findIndex(value => /birth|birthday|\bdob\b|\bbday\b|yyyy|生年月日|誕生日|doğum/iu.test(value));
  const ageIndex = hints.findIndex(value => /(^|\s)age($|\s)|how old|年齢|kaç yaş|\byaş\b/iu.test(value));
  let valueIndex = ageIndex >= 0 ? ageIndex : birthIndex;
  let mode = ageIndex >= 0 ? 'age' : birthIndex >= 0 ? 'birthdate' : '';
  if (fields.length === 1 && nameIndex === 0 && valueIndex < 0 && !/age|how old|年齢|yaş/iu.test(title)) {
    return { nameIndex: 0, valueIndex: -1, mode: 'name-only' };
  }
  if (valueIndex < 0) {
    valueIndex = fields.map((_, index) => index).find(index => index !== nameIndex) ?? -1;
    if (valueIndex >= 0) mode = String(fields[valueIndex]?.type || '').toLowerCase() === 'date' ? 'birthdate' : 'age';
  }
  if (nameIndex < 0 && fields.length > 1) nameIndex = fields.map((_, index) => index).find(index => index !== valueIndex) ?? -1;
  if (nameIndex === valueIndex) nameIndex = -1;
  return { nameIndex, valueIndex, mode };
}

function shouldReplayAuthorize(authorizeUrl, events = []) {
  try {
    const url = new URL(authorizeUrl);
    return /(^|\.)auth\.openai\.com$/i.test(url.host)
      && url.pathname === '/api/accounts/authorize'
      && !events.includes('authorize:request');
  } catch { return false; }
}
function isChatgptLanding(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return /(^|\.)chatgpt\.com$/i.test(url.host) && !/^\/(?:api\/auth|auth)(?:\/|$)/i.test(url.pathname);
  } catch { return false; }
}
function isEmailConfirmEntry(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return /(^|\.)chatgpt\.com$/i.test(url.host) && /^\/auth\/login\/?$/i.test(url.pathname) && url.searchParams.has('email');
  } catch { return false; }
}

async function visible(session, selectors, timeout = 500) {
  for (const selector of selectors) {
    const collection = session.page.locator(selector);
    let candidates;
    if (typeof collection?.count === 'function' && typeof collection?.nth === 'function') {
      const count = Math.min(8, await collection.count().catch(() => 0));
      candidates = Array.from({ length: count }, (_, index) => collection.nth(index));
    } else {
      candidates = [typeof collection?.first === 'function' ? collection.first() : collection];
    }
    for (let index = 0; index < candidates.length; index += 1) {
      const locator = candidates[index];
      if (!locator || !await locator.isVisible({ timeout }).catch(() => false)) continue;
      if (typeof locator.isEnabled === 'function'
        && !await locator.isEnabled({ timeout: 0 }).catch(() => false)) continue;
      return { selector, locator, index };
    }
  }
  return null;
}

async function scanVisibleSelectorGroups(session, selectorGroups) {
  if (!Array.isArray(selectorGroups)) {
    const out = {};
    for (const [name, selectors] of Object.entries(selectorGroups || {})) out[name] = (await visible(session, selectors, 100))?.selector || '';
    return out;
  }
  const matches = [];
  const unsupported = [];
  for (const selectors of selectorGroups) {
    const found = await visible(session, selectors, 100);
    matches.push(found);
    unsupported.push([]);
  }
  return { matches, unsupported };
}

async function waitVisible(session, selectors, timeoutMs, cancelled) {
  const deadline = Date.now() + timeoutMs;
  do {
    active(cancelled);
    const found = await visible(session, selectors, Math.min(500, Math.max(1, deadline - Date.now())));
    if (found) return found;
    await sleep(session, 200);
  } while (Date.now() < deadline);
  return null;
}

async function waitForPasswordFormHydration(session, options = {}) {
  return waitVisible(session, SIGNUP_SELECTORS.password, passwordAdvanceTimeoutMs(options.timeoutMs), options.cancelled);
}

async function waitForStableVisibleInputNode(session, selectors, options = {}) {
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 30000);
  const deadline = Date.now() + timeoutMs;
  const settleMs = Math.max(50, Number(options.settleMs) || 120);
  do {
    active(options.cancelled);
    const found = await visible(session, selectors, Math.min(500, Math.max(1, deadline - Date.now())));
    if (!found) {
      await sleep(session, 100);
      continue;
    }
    if (typeof found.locator.boundingBox !== 'function') {
      await sleep(session, settleMs);
      return visible(session, [found.selector], 200);
    }
    let previous = null;
    let stableReads = 0;
    while (Date.now() < deadline && stableReads < 2) {
      active(options.cancelled);
      const box = await found.locator.boundingBox().catch(() => null);
      if (!box || box.width <= 0 || box.height <= 0) break;
      const stable = previous
        && ['x', 'y', 'width', 'height'].every(key => Math.abs(Number(previous[key]) - Number(box[key])) <= 1);
      stableReads = stable ? stableReads + 1 : 0;
      previous = box;
      if (stableReads < 2) await sleep(session, settleMs);
    }
    if (stableReads >= 2) {
      // React can replace the node after layout settles. Reacquire from the live
      // document so callers never keep an obsolete nth=0 handle.
      return visible(session, [found.selector], 200);
    }
    await sleep(session, 100);
  } while (Date.now() < deadline);
  return null;
}

async function stabilizeVisibleInputInPage(session, selectors, value, options = {}) {
  const found = await waitForStableVisibleInputNode(session, selectors, options);
  if (!found) return { ok: false, selector: '' };
  await found.locator.fill(String(value));
  return { ok: true, selector: found.selector };
}

async function submitVisibleEmailFormInPage(session, selectors, value) {
  const filled = await stabilizeVisibleInputInPage(session, selectors, value, { timeoutMs: ENTRY_EMAIL_FIELD_MIN_TIMEOUT_MS });
  if (!filled.ok) return { ok: false, selector: '' };
  const submit = await visible(session, SIGNUP_SELECTORS.continue, 1000);
  if (submit) await submit.locator.click();
  else await session.page.locator(filled.selector).first().press('Enter');
  return { ok: true, selector: filled.selector };
}

async function dismissKnownEntryConsent(session, { cancelled, timeoutMs = 1800 } = {}) {
  active(cancelled);
  const consent = await visible(session, ENTRY_SELECTORS.cookieAccept, Math.min(1000, timeoutMs));
  if (!consent) return false;
  const text = typeof consent.locator.textContent === 'function'
    ? await consent.locator.textContent({ timeout: 300 }).catch(() => '')
    : '';
  const ariaLabel = typeof consent.locator.getAttribute === 'function'
    ? await consent.locator.getAttribute('aria-label').catch(() => '')
    : '';
  if (!SAFE_CONSENT_LABEL.test(String(text || ariaLabel || '').trim())) return false;
  await consent.locator.click({ timeout: Math.min(3000, timeoutMs) }).catch(() => {});
  const deadline = Date.now() + Math.max(100, timeoutMs);
  do {
    active(cancelled);
    if (!await visible(session, ENTRY_SELECTORS.cookieAccept, 100)) return true;
    await sleep(session, 100);
  } while (Date.now() < deadline);
  return true;
}

function trackEmailOtpDispatch(page) {
  const state = {
    requests: 0, responses: 0, request_failures: 0, last_status: 0,
    last_error_code: '', last_error: '', last_event_at: Date.now(),
    revision: 0, settle_timed_out: false,
  };
  const pending = new Set();
  const record = () => {
    state.revision += 1;
    state.last_event_at = Date.now();
  };
  const safeText = value => String(value ?? '')
    .replace(/\s+/g, ' ')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '<url>')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
    .replace(/\b(?:Bearer|ApiKey)\s+\S+/gi, '<auth>')
    .trim()
    .slice(0, 180);
  const inspectBody = body => {
    const code = body?.error?.code ?? body?.errorCode ?? body?.code;
    if (/^[A-Z][A-Z0-9_.-]{2,80}$/.test(String(code || '').trim())) state.last_error_code = String(code).trim();
    const message = typeof body?.error === 'string'
      ? body.error
      : body?.error?.message ?? body?.detail ?? body?.message;
    if (message) state.last_error = safeText(message);
    record();
  };
  const matches = value => {
    try {
      const url = new URL(value);
      return /auth\.openai\.com$/i.test(url.host) && url.pathname === '/api/accounts/email-otp/send';
    } catch { return false; }
  };
  const onRequest = request => {
    if (!matches(request.url?.() || '')) return;
    state.requests += 1;
    record();
  };
  const onResponse = response => {
    if (!matches(response.url?.() || '')) return;
    state.responses += 1;
    state.last_status = Number(response.status?.()) || 0;
    record();
    if (typeof response.json === 'function') {
      const task = Promise.resolve(response.json())
        .then(inspectBody)
        .catch(() => {})
        .finally(() => {
          pending.delete(task);
          record();
        });
      pending.add(task);
    }
  };
  const onRequestFailed = request => {
    if (!matches(request.url?.() || '')) return;
    state.request_failures += 1;
    state.last_error = safeText(request.failure?.()?.errorText || 'email-otp/send request failed');
    record();
  };
  if (typeof page?.on === 'function') {
    page.on('request', onRequest);
    page.on('response', onResponse);
    page.on('requestfailed', onRequestFailed);
  }
  return {
    snapshot: () => ({
      ...state,
      pending_bodies: pending.size,
      observed: state.requests > 0 || state.responses > 0 || state.request_failures > 0,
    }),
    async settle({ timeoutMs = 750, quietMs = 75 } = {}) {
      const deadline = Date.now() + Math.max(1, Number(timeoutMs) || 750);
      let observedRevision = state.revision;
      let observedStage = routeStage(typeof page?.url === 'function' ? page.url() : '');
      let stableSince = Date.now();
      state.settle_timed_out = false;
      do {
        if (pending.size) {
          await Promise.race([
            Promise.allSettled([...pending]),
            new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now())))),
          ]);
        } else {
          await new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
        }
        const nextStage = routeStage(typeof page?.url === 'function' ? page.url() : '');
        if (observedRevision !== state.revision || observedStage !== nextStage || pending.size) {
          observedRevision = state.revision;
          observedStage = nextStage;
          stableSince = Date.now();
          continue;
        }
        if (Date.now() - stableSince >= quietMs) return true;
      } while (Date.now() < deadline);
      state.settle_timed_out = true;
      return false;
    },
    dispose() {
      if (typeof page?.off === 'function') {
        page.off('request', onRequest);
        page.off('response', onResponse);
        page.off('requestfailed', onRequestFailed);
      } else if (typeof page?.removeListener === 'function') {
        page.removeListener('request', onRequest);
        page.removeListener('response', onResponse);
        page.removeListener('requestfailed', onRequestFailed);
      }
    },
  };
}

function trackEntryTransition(page) {
  const state = {
    events: [], statuses: new Map(), authorizeUrl: '', requestFailure: '',
    revision: 0, lastEventAt: Date.now(), settleTimedOut: false,
  };
  const pending = new Set();
  const record = (name, status = 0) => {
    state.events.push(name);
    if (status) state.statuses.set(name.replace(/:.*/, ''), status);
    state.revision += 1;
    state.lastEventAt = Date.now();
  };
  const classify = value => {
    try {
      const url = new URL(value);
      if (/chatgpt\.com$/i.test(url.host)) {
        if (url.pathname === '/api/auth/providers') return 'providers';
        if (url.pathname === '/api/auth/csrf') return 'csrf';
        if (url.pathname === '/api/auth/signin/openai') return 'signin';
      }
      if (/auth\.openai\.com$/i.test(url.host) && url.pathname === '/api/accounts/authorize') return 'authorize';
    } catch {}
    return '';
  };
  const onRequest = request => {
    const url = request.url?.() || '';
    const name = classify(url);
    if (!name) return;
    record(`${name}:request`);
    if (name === 'authorize') state.authorizeUrl = url;
  };
  const onResponse = response => {
    const url = response.url?.() || '';
    const name = classify(url);
    if (!name) return;
    record(name, Number(response.status?.()) || 0);
    if (name === 'authorize') state.authorizeUrl = url;
    if (name === 'signin' && typeof response.json === 'function') {
      const task = Promise.resolve(response.json())
        .then(body => {
          const candidate = String(body?.url || '');
          if (shouldReplayAuthorize(candidate, [])) {
            state.authorizeUrl = candidate;
            record('signin:redirect');
          }
        })
        .catch(() => {})
        .finally(() => {
          pending.delete(task);
          state.revision += 1;
          state.lastEventAt = Date.now();
        });
      pending.add(task);
    }
  };
  const onFailed = request => {
    const url = request.url?.() || '';
    const name = classify(url);
    if (!name) return;
    state.requestFailure = String(request.failure?.()?.errorText || `${name} request failed`).slice(0, 160);
    record(`${name}:failed`);
  };
  page?.on?.('request', onRequest);
  page?.on?.('response', onResponse);
  page?.on?.('requestfailed', onFailed);
  return {
    state,
    hasSignal: () => state.events.length > 0 || state.statuses.size > 0,
    summary: () => ['providers', 'csrf', 'signin', 'authorize']
      .filter(name => state.statuses.has(name) || state.events.some(item => item.startsWith(`${name}:`)))
      .map(name => state.statuses.has(name) ? `${name}:${state.statuses.get(name)}` : `${name}:started`)
      .concat(state.requestFailure ? [`network:${state.requestFailure}`] : [])
      .join(' > ') || 'no-request',
    async settle({ timeoutMs = 750, quietMs = 75 } = {}) {
      const deadline = Date.now() + Math.max(1, Number(timeoutMs) || 750);
      let observedRevision = state.revision;
      let observedStage = routeStage(typeof page?.url === 'function' ? page.url() : '');
      let stableSince = Date.now();
      state.settleTimedOut = false;
      do {
        if (pending.size) {
          await Promise.race([
            Promise.allSettled([...pending]),
            new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now())))),
          ]);
        } else {
          await new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
        }
        const nextStage = routeStage(typeof page?.url === 'function' ? page.url() : '');
        if (observedRevision !== state.revision || observedStage !== nextStage || pending.size) {
          observedRevision = state.revision;
          observedStage = nextStage;
          stableSince = Date.now();
          continue;
        }
        if (Date.now() - stableSince >= quietMs) return true;
      } while (Date.now() < deadline);
      state.settleTimedOut = true;
      return false;
    },
    dispose() {
      page?.off?.('request', onRequest);
      page?.off?.('response', onResponse);
      page?.off?.('requestfailed', onFailed);
    },
  };
}

async function readInlineError(session) {
  try {
    return String(await session.page.evaluate(() => {
      const selectors = ['[role="alert"]', '[data-testid*="error" i]', '.text-error', '[class*="error" i]', 'p[id$="-error"]', '[slot="errorMessage"]', '[data-invalid]'];
      const values = [];
      for (const selector of selectors) {
        for (const element of document.querySelectorAll(selector)) {
          const style = getComputedStyle(element);
          const text = String(element.textContent || '').replace(/\s+/g, ' ').trim();
          if (text && style.display !== 'none' && style.visibility !== 'hidden') values.push(text);
        }
      }
      return [...new Set(values)].join(' | ').slice(0, 500);
    }) || '');
  } catch { return ''; }
}

async function submitEntryEmail(session, email, {
  timeoutMs, cancelled, note, telemetry,
}) {
  const tracker = trackEntryTransition(session.page);
  try {
    const fillAndSubmit = async ({ interactionRetry = false } = {}) => {
      await dismissKnownEntryConsent(session, { cancelled });
      let field = await waitForStableVisibleInputNode(session, SIGNUP_SELECTORS.email, {
        timeoutMs: Math.min(timeoutMs, 15000),
        settleMs: 180,
        cancelled,
      });
      if (!field) throw flowError('邮箱输入框持续重渲染', 'REGISTER_HEADLESS_EMAIL_INPUT_UNSTABLE');
      const stabilityDeadline = Date.now() + Math.min(timeoutMs, ENTRY_EMAIL_STABILITY_MIN_TIMEOUT_MS);
      let stableReads = 0;
      do {
        active(cancelled);
        const rebound = await visible(session, SIGNUP_SELECTORS.email, 200);
        if (rebound) field = rebound;
        const actual = typeof field.locator.inputValue === 'function'
          ? await field.locator.inputValue().catch(() => '')
          : '';
        if (actual !== email) {
          // fill() does not require a pointer click and is safe when a transient
          // overlay is visually above an otherwise editable input.
          await field.locator.fill(email);
          stableReads = 0;
        } else {
          stableReads += 1;
          if (stableReads >= 2) break;
        }
        await sleep(session, 100);
      } while (Date.now() < stabilityDeadline);
      const finalValue = typeof field.locator.inputValue === 'function'
        ? await field.locator.inputValue().catch(() => '')
        : email;
      if (finalValue !== email) {
        throw flowError('邮箱输入框持续重渲染，输入值未稳定保留', 'REGISTER_HEADLESS_EMAIL_INPUT_UNSTABLE');
      }
      try {
        await clickSubmit(session, field);
      } catch (error) {
        if (interactionRetry || !RECOVERABLE_DOM_INTERACTION_ERROR.test(String(error?.message || error))) throw error;
        telemetry?.noteDomRetry?.();
        note?.('邮箱格子被挡住或换了个新的，再轻轻填一次', 'warn');
        await sleep(session, 400);
        return fillAndSubmit({ interactionRetry: true });
      }
      return field;
    };

    await fillAndSubmit();
    const deadline = Date.now() + timeoutMs;
    const waitForHandoff = async until => {
      do {
        active(cancelled);
        try {
          if (AUTH_HOST.test(new URL(currentUrl(session)).hostname)) return currentUrl(session);
        } catch {}
        await tracker.settle();
        if (tracker.state.authorizeUrl && shouldReplayAuthorize(tracker.state.authorizeUrl, tracker.state.events)) {
          note?.('页面想跳一下但没跳成，再帮你推一把', 'warn');
          await session.goto(tracker.state.authorizeUrl, {
            waitUntil: 'commit',
            timeout: Math.max(10000, Math.min(timeoutMs, 45000)),
          }).catch(() => {});
          try {
            if (AUTH_HOST.test(new URL(currentUrl(session)).hostname)) return currentUrl(session);
          } catch {}
        }
        await sleep(session, 250);
      } while (Date.now() < until);
      return '';
    };
    const firstWindowMs = Math.min(30000, Math.max(10000, Math.floor(timeoutMs / 3)));
    const first = await waitForHandoff(Math.min(deadline, Date.now() + firstWindowMs));
    if (first) return first;

    // Only retry an email submission in-page when the monitor saw no auth
    // request at all, the same editable field is still present, and the page
    // has no explicit rejection. A real upstream error remains authoritative.
    const inlineBeforeRetry = await readInlineError(session);
    const emailStillPresent = await visible(session, SIGNUP_SELECTORS.email, 300);
    if (!tracker.hasSignal() && emailStillPresent && !inlineBeforeRetry && Date.now() < deadline) {
      telemetry?.noteDomRetry?.();
      note?.('邮箱交上去了但页面没接住，再填一次', 'warn');
      await fillAndSubmit({ interactionRetry: true });
    }
    const second = await waitForHandoff(deadline);
    if (second) return second;
    const inline = await readInlineError(session);
    throw Object.assign(new Error(`提交邮箱后认证交接未完成（请求链 ${tracker.summary()}${inline ? `；页面报错：${inline}` : ''}）`), {
      code: inferHeadlessFailureCode('REGISTER_HEADLESS_NO_AUTH_HOST', inline),
      authChain: tracker.summary(),
    });
  } finally {
    tracker.dispose();
  }
}

function routeStage(url) {
  if (isChatgptLanding(url)) return 'landing';
  try {
    const value = new URL(url);
    if (!AUTH_HOST.test(value.hostname)) return 'transition';
    if (/\/(?:choose-an-account|add-phone|phone-verification|phone-otp|workspace|organization|consent)(?:\/|$)|\/sign-in-with-chatgpt\//i.test(value.pathname)) return 'oauthContinuation';
    if (/\/about-you(?:\/|$)/i.test(value.pathname)) return 'about';
    if (/\/(?:log-in|login|reset-password)(?:\/|$)/i.test(value.pathname)) return 'existingPassword';
    if (/\/create-account\/password(?:\/|$)/i.test(value.pathname)) return 'password';
    if (/passkey/i.test(value.pathname)) return 'passkey';
    // Source: /email-verification is transitional. OTP/password come from visible controls.
    if (/\/email-verification(?:\/|$)/i.test(value.pathname)) return 'transition';
    if (/\/create-account(?:\/|$)/i.test(value.pathname)) return 'about';
    if (/\/error(?:\/|$)/i.test(value.pathname)) return 'error';
  } catch {}
  return 'transition';
}

function pageLocation(session) {
  try {
    const value = new URL(currentUrl(session));
    return `${value.origin}${value.pathname}`;
  } catch {
    return currentUrl(session) || 'unknown';
  }
}

function stageLabel(stage) {
  return {
    waiting: '还在等页面',
    password: '密码页',
    passwordChoice: '选密码页',
    otp: '验证码页',
    about: '资料页',
    passkey: '中间页',
    landing: '完成页',
    existingPassword: '登录页',
    browserError: '打不开的页面',
    transition: '过渡页',
    unknown: '未知页',
    error: '出错页',
    inlineError: '提示出错',
    oauthContinuation: '授权页',
  }[stage] || '页面';
}

async function detectStage(session) {
  const url = currentUrl(session);
  if (/^chrome-error:/i.test(url)) return 'browserError';
  if (isChatgptLanding(url)) return 'landing';
  let parsed;
  try { parsed = new URL(url); } catch { return 'unknown'; }
  if (!AUTH_HOST.test(parsed.hostname)) return 'unknown';
  const path = parsed.pathname;
  if (/\/(?:choose-an-account|add-phone|phone-verification|phone-otp|workspace|organization|consent)(?:\/|$)|\/sign-in-with-chatgpt\//i.test(path)) {
    return 'oauthContinuation';
  }
  // Source detects about-you by URL only. Never infer about from React Aria
  // name selectors — those also match password/OTP fields.
  if (/\/about-you(?:\/|$)/i.test(path)) return 'about';
  if (/\/(?:log-in|login|reset-password)(?:\/|$)/i.test(path)) {
    return await visible(session, SIGNUP_SELECTORS.otp, 100) ? 'otp' : 'existingPassword';
  }
  if (/\/create-account\/password(?:\/|$)/i.test(path)) {
    return await visible(session, SIGNUP_SELECTORS.password, 100) ? 'password' : 'transition';
  }
  if (/passkey/i.test(path)) return 'passkey';
  if (await visible(session, SIGNUP_SELECTORS.password, 100)) return 'password';
  if (await visible(session, SIGNUP_SELECTORS.otp, 100)) return 'otp';
  if (await visible(session, ENTRY_SELECTORS.continueWithPassword, 100)) return 'passwordChoice';
  if (/\/email-verification(?:\/|$)/i.test(path)) return 'transition';
  if (/\/create-account(?:\/|$)/i.test(path)) return 'about';
  return 'transition';
}

async function waitForStage(session, allowed, {
  timeoutMs = 45000, cancelled, stopOnInlineError = false, inlineErrorGraceMs = 750,
} = {}) {
  const wanted = new Set(allowed);
  const deadline = Date.now() + timeoutMs;
  const startedAt = Date.now();
  let lastInline = '';
  let inlineSince = 0;
  do {
    active(cancelled);
    const stage = await detectStage(session);
    if (wanted.has(stage)) return stage;
    if (stopOnInlineError && Date.now() - startedAt >= inlineErrorGraceMs) {
      const inline = await readInlineError(session);
      if (inline && inline === lastInline && Date.now() - inlineSince >= 500) return 'inlineError';
      if (inline !== lastInline) {
        lastInline = inline;
        inlineSince = Date.now();
      }
    }
    await sleep(session, 200);
  } while (Date.now() < deadline);
  const finalStage = await detectStage(session);
  return wanted.has(finalStage) ? finalStage : '';
}

async function acceptLateStage(session, stage, allowed) {
  const observed = await detectStage(session);
  return allowed.includes(observed) ? observed : stage;
}
const isRetryableOtpInlineError = value => /expired|try again|new code|incorrect|invalid|wrong|6\s*(?:characters?|digits?)|6\s*文字|验证码.*(?:过期|重试|无效|错误)|hatalı|yanlış|geçersiz|tam\s+olarak\s+6\s+karakter/iu.test(String(value || ''));
function normalizeEmailOtp(value) {
  const raw = String(value?.code ?? value?.otp ?? value ?? '').trim();
  if (/^\d{6}$/.test(raw)) return raw;
  const compact = raw.replace(/[\s-]+/g, '');
  if (/^\d{6}$/.test(compact)) return compact;
  const matches = [...raw.matchAll(/(?:^|\D)(\d(?:[\s-]?\d){5})(?!\d)/g)].map(match => match[1].replace(/\D/g, ''));
  return matches.length === 1 ? matches[0] : '';
}

async function requestSubmit(session, locator = null) {
  if (locator && typeof locator.evaluate === 'function') {
    try {
      const submitted = await locator.evaluate((input, submitterSelector) => {
        const form = input?.form || input?.closest?.('form');
        if (!form) return false;
        const submitter = [...form.querySelectorAll(submitterSelector)].find(element => {
          const style = globalThis.getComputedStyle?.(element);
          const rect = element.getBoundingClientRect?.();
          return !element.disabled
            && style?.display !== 'none'
            && style?.visibility !== 'hidden'
            && (!rect || rect.width > 0 || rect.height > 0);
        });
        if (typeof form.requestSubmit === 'function') form.requestSubmit(submitter || undefined);
        else form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        return true;
      }, FORM_SUBMITTER_SELECTOR);
      if (submitted) return true;
    } catch {}
  }
  try {
    return Boolean(await session.page.evaluate(submitterSelector => {
      const active = document.activeElement;
      const form = active?.form || active?.closest?.('form') || document.querySelector('form');
      if (!form) return false;
      const submitter = [...form.querySelectorAll(submitterSelector)].find(element => {
        const style = globalThis.getComputedStyle?.(element);
        const rect = element.getBoundingClientRect?.();
        return !element.disabled
          && style?.display !== 'none'
          && style?.visibility !== 'hidden'
          && (!rect || rect.width > 0 || rect.height > 0);
      });
      if (typeof form.requestSubmit === 'function') form.requestSubmit(submitter || undefined);
      else form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      return true;
    }, FORM_SUBMITTER_SELECTOR));
  } catch { return false; }
}

function trackFormSubmission(page) {
  let revision = 0;
  const matches = value => /\/(?:api\/auth\/(?:providers|csrf|signin\/openai)|api\/accounts\/(?:authorize|user\/register|email-otp\/validate|create_account))(?:\?|$)/i.test(String(value || ''));
  const onRequest = request => {
    if (matches(request?.url?.())) revision += 1;
  };
  page?.on?.('request', onRequest);
  return {
    observed: () => revision > 0,
    dispose() {
      if (typeof page?.off === 'function') page.off('request', onRequest);
      else page?.removeListener?.('request', onRequest);
    },
  };
}

async function submissionAdvanced(session, beforeUrl, beforeStage, tracker, timeoutMs = 300) {
  const deadline = Date.now() + timeoutMs;
  do {
    const afterUrl = currentUrl(session);
    const afterStage = routeStage(afterUrl);
    if (tracker.observed() || afterUrl !== beforeUrl || (afterStage && afterStage !== beforeStage)) return true;
    await sleep(session, 25);
  } while (Date.now() < deadline);
  return false;
}

async function clickSubmit(session, field) {
  const beforeUrl = currentUrl(session);
  const beforeStage = routeStage(beforeUrl);
  const tracker = trackFormSubmission(session.page);
  let interactionError = null;
  try {
    const submit = await visible(session, SIGNUP_SELECTORS.continue, 1000);
    if (submit) {
      try {
        await submit.locator.click();
        return { submitted: true, method: 'click', selector: submit.selector };
      } catch (error) {
        interactionError = error;
        if (await submissionAdvanced(session, beforeUrl, beforeStage, tracker)) {
          return { submitted: true, method: 'click-raced', error };
        }
      }
    }
    if (field?.locator?.press) {
      try {
        await field.locator.press('Enter');
        return { submitted: true, method: 'enter' };
      } catch (error) {
        interactionError = error;
        if (await submissionAdvanced(session, beforeUrl, beforeStage, tracker)) {
          return { submitted: true, method: 'enter-raced', error };
        }
      }
    }
    if (await requestSubmit(session, field?.locator)) {
      return { submitted: true, method: 'requestSubmit' };
    }
    if (interactionError && RECOVERABLE_DOM_INTERACTION_ERROR.test(String(interactionError?.message || interactionError))) {
      throw interactionError;
    }
    throw flowError('注册页没有可用提交控件', 'REGISTER_HEADLESS_AUTH_PAGE_FAILED');
  } finally {
    tracker.dispose();
  }
}

async function retryOtpSubmit(session, field) {
  const beforeUrl = currentUrl(session);
  const beforeStage = routeStage(beforeUrl);
  const tracker = trackFormSubmission(session.page);
  try {
    if (field?.locator?.press) {
      try {
        await field.locator.press('Enter');
        return { submitted: true, method: 'enter' };
      } catch (error) {
        if (await submissionAdvanced(session, beforeUrl, beforeStage, tracker)) {
          return { submitted: true, method: 'enter-raced', error };
        }
      }
    }
    if (await requestSubmit(session, field?.locator)) {
      return { submitted: true, method: 'requestSubmit' };
    }
    const submit = await visible(session, SIGNUP_SELECTORS.continue, 1000);
    if (submit) {
      try {
        await submit.locator.click();
        return { submitted: true, method: 'click' };
      } catch (error) {
        if (await submissionAdvanced(session, beforeUrl, beforeStage, tracker)) {
          return { submitted: true, method: 'click-raced', error };
        }
      }
    }
    throw flowError('验证码重试没有可用提交控件', 'REGISTER_HEADLESS_OTP_STALLED');
  } finally {
    tracker.dispose();
  }
}

async function fill(session, selectors, value, timeoutMs, cancelled, missingCode, { clickFirst = false } = {}) {
  const found = await waitVisible(session, selectors, timeoutMs, cancelled);
  if (!found) throw flowError('注册输入控件在限定时间内未渲染', missingCode);
  if (clickFirst) await found.locator.click?.({ timeout: 3000 }).catch(() => {});
  await found.locator.fill(String(value));
  return found;
}

async function skipPasskeyIfPresent(session, { cancelled, log, timeoutMs = 2500 } = {}) {
  active(cancelled);
  if (!/passkey/i.test(currentUrl(session))) return false;
  const skip = await visible(session, SKIP_SELECTORS.passkey, Math.min(1500, timeoutMs));
  if (!skip) return false;
  log?.('路过中间页，继续往前走', 'info');
  await skip.locator.click({ timeout: 3000 }).catch(() => {});
  await sleep(session, 400);
  return true;
}

async function stableControlValue(session, locator, wanted, timeoutMs = 1500) {
  if (typeof locator?.inputValue !== 'function') return true;
  const deadline = Date.now() + timeoutMs;
  let stableSince = 0;
  do {
    const value = await locator.inputValue().catch(() => '');
    if (String(value).trim() === String(wanted).trim()) {
      stableSince ||= Date.now();
      if (Date.now() - stableSince >= 200) return true;
    } else stableSince = 0;
    await sleep(session, 50);
  } while (Date.now() < deadline);
  return false;
}

async function typeStable(session, locator, value, forceKeyboard = false) {
  const wanted = String(value);
  if (!forceKeyboard && typeof locator.fill === 'function') {
    await locator.fill(wanted).catch(() => {});
    if (await stableControlValue(session, locator, wanted)) return true;
  }
  await locator.click?.({ force: true }).catch(() => {});
  await locator.press?.('Control+A').catch(() => {});
  await locator.press?.('Backspace').catch(() => {});
  try {
    if (typeof locator.pressSequentially === 'function') await locator.pressSequentially(wanted, { delay: 40 });
    else await locator.fill?.(wanted);
  } catch {}
  if (await stableControlValue(session, locator, wanted)) return true;
  if (typeof locator.evaluate === 'function') {
    await locator.evaluate((el, next) => {
      el.focus?.();
      if (el.getAttribute?.('contenteditable') === 'true') el.textContent = next;
      else {
        const proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc?.set) desc.set.call(el, next);
        else el.value = next;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, wanted).catch(() => {});
  }
  return stableControlValue(session, locator, wanted);
}

function birthdateParts(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  return match
    ? { year: match[1], month: match[2], day: match[3] }
    : { year: '1990', month: '01', day: '01' };
}

async function readControlValue(locator) {
  if (!locator) return { readable: false, value: '' };
  if (typeof locator.inputValue === 'function') {
    try { return { readable: true, value: String(await locator.inputValue()) }; } catch {}
  }
  if (typeof locator.evaluate === 'function') {
    try {
      const value = await locator.evaluate(element => {
        if (element && 'value' in element) return String(element.value || '');
        return String(element?.textContent || '');
      });
      return { readable: true, value: String(value || '').trim() };
    } catch {}
  }
  return { readable: false, value: '' };
}

function controlValuesMatch(actual, wanted) {
  const left = String(actual || '').trim();
  const right = String(wanted || '').trim();
  if (left === right) return true;
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) return Number(left) === Number(right);
  return false;
}

async function typeIntoSegment(locator, value, {
  session, forceKeyboard = false, verifyValue = true, settleMs = 150,
} = {}) {
  if (!locator) return false;
  const wanted = String(value);
  const verify = async () => {
    const observed = await readControlValue(locator);
    return !observed.readable || controlValuesMatch(observed.value, wanted);
  };
  const commit = async () => {
    if (typeof locator.press === 'function') await locator.press('Tab').catch(() => {});
    else if (typeof locator.blur === 'function') await locator.blur().catch(() => {});
    if (session && settleMs > 0) await sleep(session, settleMs);
  };

  if (!forceKeyboard) {
    try {
      if (typeof locator.fill === 'function') {
        await locator.fill(wanted);
        await commit();
        if (!verifyValue || await verify()) return true;
      }
    } catch {}
  }

  try {
    await locator.click?.().catch(() => {});
    if (typeof locator.press === 'function') {
      await locator.press('Control+A').catch(async () => locator.press('Meta+A').catch(() => {}));
      await locator.press('Backspace').catch(() => {});
    }
    if (typeof locator.pressSequentially === 'function') await locator.pressSequentially(wanted, { delay: 40 });
    else if (typeof locator.fill === 'function') await locator.fill(wanted);
    await commit();
    if (!verifyValue || await verify()) return true;
  } catch {}

  if (typeof locator.evaluate === 'function') {
    try {
      await locator.evaluate((element, nextValue) => {
        element.focus?.();
        if (element && 'value' in element) {
          const prototype = Object.getPrototypeOf(element);
          const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
            || Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
          if (setter) setter.call(element, nextValue);
          else element.value = nextValue;
        } else if (element?.isContentEditable || element?.getAttribute?.('contenteditable') === 'true') {
          element.textContent = nextValue;
        } else if (element?.getAttribute?.('role') === 'spinbutton') {
          element.textContent = nextValue;
          element.setAttribute?.('aria-valuenow', String(Number(nextValue) || nextValue));
        }
        element.dispatchEvent?.(new InputEvent('input', {
          bubbles: true,
          inputType: 'insertText',
          data: nextValue,
        }));
        element.dispatchEvent?.(new Event('change', { bubbles: true }));
        element.blur?.();
      }, wanted);
      if (session && settleMs > 0) await sleep(session, settleMs);
      return verifyValue ? verify() : true;
    } catch {}
  }
  return false;
}

function birthdaySegmentEntries(segments, parts) {
  const entries = [
    { key: 'month', field: segments?.month, value: parts.month },
    { key: 'day', field: segments?.day, value: parts.day },
    { key: 'year', field: segments?.year, value: parts.year },
  ];
  if (!entries.every(entry => entry.field?.locator)) return [];
  if (entries.every(entry => Number.isInteger(entry.field.documentOrder) && entry.field.documentOrder >= 0)) {
    entries.sort((left, right) => left.field.documentOrder - right.field.documentOrder);
  }
  return entries;
}

function ageFromBirthdate(value, now = new Date()) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) return 30;
  let age = now.getFullYear() - Number(match[1]);
  if (now.getMonth() + 1 < Number(match[2])
    || (now.getMonth() + 1 === Number(match[2]) && now.getDate() < Number(match[3]))) age -= 1;
  return Math.max(18, Math.min(90, age));
}

async function waitForAboutSubmitOutcome(session, {
  timeoutMs, cancelled, inlineErrorGraceMs = 0, ignoredInlineError = '',
} = {}) {
  const started = Date.now();
  const deadline = Date.now() + timeoutMs;
  do {
    active(cancelled);
    const stage = await detectStage(session);
    if (stage === 'landing' || stage === 'passkey' || stage === 'otp') return { stage, inlineError: '' };
    if (/^chrome-error:/i.test(currentUrl(session))) return { stage: 'browserError', inlineError: '' };
    if (stage === 'about') {
      const inlineError = await readInlineError(session);
      if (inlineError && ABOUT_PROFILE_RETRYABLE_ERROR.test(inlineError)
        && (Date.now() - started >= inlineErrorGraceMs || inlineError !== ignoredInlineError)) {
        return { stage: 'validation-error', inlineError };
      }
    }
    await sleep(session, 250);
  } while (Date.now() < deadline);
  const stage = await detectStage(session);
  if (stage === 'landing' || stage === 'passkey' || stage === 'otp') return { stage, inlineError: '' };
  if (stage === 'about') {
    const inlineError = await readInlineError(session);
    if (inlineError && ABOUT_PROFILE_RETRYABLE_ERROR.test(inlineError)) {
      return { stage: 'validation-error', inlineError };
    }
  }
  return { stage: '', inlineError: await readInlineError(session) };
}

async function collectGenericAboutInputs(session) {
  const fields = [];
  try {
    for (const selector of ABOUT_GENERIC_SELECTOR_GROUPS) {
      const collection = session.page.locator(selector);
      if (typeof collection.count === 'function' && typeof collection.nth === 'function') {
        const count = Math.min(12, await collection.count());
        for (let index = 0; index < count; index += 1) {
          const locator = collection.nth(index);
          const descriptor = await describeAboutLocator(locator, selector, fields.length);
          if (descriptor) fields.push(descriptor);
        }
        continue;
      }
      const locator = typeof collection.first === 'function' ? collection.first() : collection;
      const descriptor = await describeAboutLocator(locator, selector, fields.length);
      if (descriptor) fields.push(descriptor);
    }
    const title = typeof session.page.title === 'function' ? await session.page.title().catch(() => '') : '';
    return { fields, title: String(title || '') };
  } catch {
    return { fields, title: '' };
  }
}

async function describeAboutLocator(locator, selector, index) {
  if (!locator) return null;
  if (!await locator.isVisible({ timeout: 0 }).catch(() => false)) return null;
  if (typeof locator.isEnabled === 'function' && !await locator.isEnabled({ timeout: 0 }).catch(() => false)) return null;
  const attribute = async name => typeof locator.getAttribute === 'function'
    ? String(await locator.getAttribute(name).catch(() => '') || '')
    : '';
  const autocomplete = await attribute('autocomplete');
  const name = await attribute('name');
  if (/one-time-code/i.test(autocomplete) || name === 'code') return null;
  return {
    locator,
    selector,
    matchIndex: index,
    documentOrder: index,
    type: await attribute('type'),
    name,
    id: await attribute('id'),
    autocomplete,
    inputmode: await attribute('inputmode'),
    placeholder: await attribute('placeholder'),
    ariaLabel: await attribute('aria-label'),
    labelText: await attribute('aria-labelledby'),
    dataType: await attribute('data-type'),
    role: await attribute('role'),
    testId: await attribute('data-testid'),
    contentEditable: await attribute('contenteditable'),
  };
}

async function collectAboutInputsByEvaluate(session) {
  if (typeof session?.page?.evaluate !== 'function') return null;
  try {
    return await session.page.evaluate(() => {
      const hiddenType = /^(hidden|email|password|checkbox|radio|submit|button|file|image|reset)$/i;
      const visible = (el) => {
        const style = globalThis.getComputedStyle?.(el);
        const rect = el.getBoundingClientRect?.();
        return style?.display !== 'none'
          && style?.visibility !== 'hidden'
          && Number(style?.opacity || 1) !== 0
          && (!rect || rect.width > 0 || rect.height > 0);
      };
      const labelOf = (el) => {
        const labelledBy = el.getAttribute?.('aria-labelledby');
        if (labelledBy) {
          return labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ').trim();
        }
        if (el.id) {
          const forLabel = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
          if (forLabel) return String(forLabel.textContent || '').trim();
        }
        const wrap = el.closest?.('label, .react-aria-TextField, [class*="TextField"], [class*="DateField"]');
        return String(wrap?.querySelector('label')?.textContent || wrap?.textContent || el.getAttribute('aria-label') || '')
          .replace(/\s+/g, ' ').trim().slice(0, 80);
      };
      const nodes = [...document.querySelectorAll('input, textarea, select, [role="textbox"], [role="spinbutton"], [role="combobox"], [contenteditable="true"]')];
      const fields = [];
      for (const el of nodes) {
        if (!visible(el)) continue;
        const type = String(el.getAttribute('type') || el.type || '');
        if (hiddenType.test(type)) continue;
        if (/one-time-code/i.test(el.getAttribute('autocomplete') || '')) continue;
        if (String(el.getAttribute('name') || '') === 'code') continue;
        fields.push({
          tag: String(el.tagName || '').toLowerCase(),
          type,
          name: el.getAttribute('name') || '',
          id: el.id || '',
          autocomplete: el.getAttribute('autocomplete') || '',
          placeholder: el.getAttribute('placeholder') || '',
          ariaLabel: el.getAttribute('aria-label') || '',
          labelText: labelOf(el),
          role: el.getAttribute('role') || '',
          documentOrder: fields.length,
        });
      }
      const heading = String(document.querySelector('h1, h2, [role="heading"]')?.textContent || '').replace(/\s+/g, ' ').trim();
      return { fields, title: `${document.title || ''} ${heading}`.trim() };
    });
  } catch {
    return null;
  }
}

async function discoverGenericAboutFields(session) {
  const { fields, title } = await collectGenericAboutInputs(session);
  if (!fields.length) return { fields, title, nameField: null, valueField: null, mode: '' };
  const classified = classifyAboutInputDescriptors(fields, title);
  const segmentIndices = classifyAboutBirthdaySegments(fields);
  if (segmentIndices) {
    return {
      fields,
      title,
      nameField: classified.nameIndex >= 0 ? fields[classified.nameIndex] : null,
      valueField: fields[segmentIndices.yearIndex],
      mode: 'birthdate-segments',
      segments: {
        month: fields[segmentIndices.monthIndex],
        day: fields[segmentIndices.dayIndex],
        year: fields[segmentIndices.yearIndex],
      },
    };
  }
  return {
    fields,
    title,
    nameField: classified.nameIndex >= 0 ? fields[classified.nameIndex] : null,
    valueField: classified.valueIndex >= 0 ? fields[classified.valueIndex] : null,
    mode: classified.mode,
  };
}

async function fillGenericAboutFields(session, discovered, identity, { forceKeyboard = false, allowNameOnly = true } = {}) {
  const name = String(identity?.name || 'Alex');
  if (discovered.nameField && !await typeIntoSegment(discovered.nameField.locator, name, { session, forceKeyboard })) return null;
  if (discovered.mode === 'name-only' && discovered.nameField) {
    return allowNameOnly ? { field: discovered.nameField, mode: 'fallback-name-only' } : null;
  }
  if (discovered.mode === 'birthdate-segments' && discovered.segments) {
    const mode = await fillBirthdayVariant(session, identity.birthdate, {
      timeoutMs: 3000, forceKeyboard, segments: discovered.segments,
    });
    return mode ? { field: discovered.valueField, mode: `${discovered.nameField ? 'name+' : ''}fallback-${mode}` } : null;
  }
  if (!discovered.valueField || !discovered.mode) return null;
  if (discovered.mode === 'age') {
    if (!await typeIntoSegment(discovered.valueField.locator, String(ageFromBirthdate(identity?.birthdate)), { session, forceKeyboard })) {
      return null;
    }
  } else {
    const parts = birthdateParts(identity?.birthdate);
    const type = String(discovered.valueField.type || '').toLowerCase();
    const placeholder = String(discovered.valueField.placeholder || '');
    const value = type === 'date'
      ? String(identity?.birthdate || '1990-01-01')
      : /^\s*dd/i.test(placeholder)
        ? `${parts.day}/${parts.month}/${parts.year}`
        : `${parts.month}/${parts.day}/${parts.year}`;
    if (!await typeIntoSegment(discovered.valueField.locator, value, { session, forceKeyboard })) return null;
  }
  return {
    field: discovered.valueField,
    mode: `${discovered.nameField ? 'name+' : ''}fallback-${discovered.mode}`,
  };
}

async function verifyBirthdaySegments(session, segments, birthdate, { settleMs = 100 } = {}) {
  const parts = birthdateParts(birthdate);
  const entries = birthdaySegmentEntries(segments, parts);
  if (!entries.length) return false;
  if (settleMs > 0) await sleep(session, settleMs);
  const observed = await Promise.all(entries.map(entry => readControlValue(entry.field.locator)));
  return observed.every((item, index) => !item.readable || controlValuesMatch(item.value, entries[index].value));
}

async function fillBirthdayVariant(session, birthdate, {
  timeoutMs, cancelled, forceKeyboard = false, segments = null, dateField = null,
} = {}) {
  const parts = birthdateParts(birthdate);
  const month = segments?.month || await visible(session, SIGNUP_SELECTORS.birthMonth, 100);
  const day = segments?.day || await visible(session, SIGNUP_SELECTORS.birthDay, 100);
  const year = segments?.year || await visible(session, SIGNUP_SELECTORS.birthYear, 100);
  if (month && day && year) {
    const resolved = { month, day, year };
    const entries = birthdaySegmentEntries(resolved, parts);
    const writeGroup = async keyboard => {
      for (const entry of entries) {
        active(cancelled);
        if (!await typeIntoSegment(entry.field.locator, entry.value, {
          session, forceKeyboard: keyboard, verifyValue: false, settleMs: 0,
        })) return false;
      }
      return true;
    };
    if (await writeGroup(forceKeyboard) && await verifyBirthdaySegments(session, resolved, birthdate)) {
      return 'birthdate-segments';
    }
    if (!forceKeyboard && await writeGroup(true) && await verifyBirthdaySegments(session, resolved, birthdate)) {
      return 'birthdate-segments';
    }
    for (const entry of entries) {
      active(cancelled);
      if (!await typeIntoSegment(entry.field.locator, entry.value, { session, forceKeyboard: true })) return '';
    }
    return await verifyBirthdaySegments(session, resolved, birthdate) ? 'birthdate-segments' : '';
  }

  const field = dateField || await waitVisible(session, SIGNUP_SELECTORS.birthdate, Math.min(timeoutMs || 3000, 3000), cancelled);
  if (!field) return '';
  const type = typeof field.locator.getAttribute === 'function'
    ? String(await field.locator.getAttribute('type').catch(() => '') || '')
    : '';
  const placeholder = typeof field.locator.getAttribute === 'function'
    ? String(await field.locator.getAttribute('placeholder').catch(() => '') || '')
    : '';
  const value = type === 'date'
    ? String(birthdate)
    : /^\s*dd/i.test(placeholder)
      ? `${parts.day}/${parts.month}/${parts.year}`
      : `${parts.month}/${parts.day}/${parts.year}`;
  return await typeIntoSegment(field.locator, value, { session, forceKeyboard }) ? 'birthdate' : '';
}

async function fillAboutYou(session, identity, {
  timeoutMs, cancelled, forceKeyboard = false, allowNameOnly = true,
} = {}) {
  const url = currentUrl(session);
  if (/\/create-account\/password(?:\/|$)/i.test(url) || (/\/email-verification(?:\/|$)/i.test(url) && !/about-you/i.test(url))) {
    throw flowError(
      `当前不是资料页（停在 ${pageLocation(session)}），拒绝填写用户资料`,
      'REGISTER_HEADLESS_ABOUT_TOO_EARLY',
    );
  }
  const deadline = Date.now() + timeoutMs;
  let semantic = null;
  let discovered = { fields: [], title: '', nameField: null, valueField: null, mode: '' };
  do {
    active(cancelled);
    await skipPasskeyIfPresent(session, { cancelled });
    const name = await visible(session, SIGNUP_SELECTORS.name, 100);
    const month = await visible(session, SIGNUP_SELECTORS.birthMonth, 100);
    const day = await visible(session, SIGNUP_SELECTORS.birthDay, 100);
    const year = await visible(session, SIGNUP_SELECTORS.birthYear, 100);
    if (month && day && year) {
      semantic = { name, mode: 'birthdate-segments', segments: { month, day, year }, valueField: year };
      break;
    }
    const birth = await visible(session, SIGNUP_SELECTORS.birthdate, 100);
    if (birth) {
      semantic = { name, mode: 'birthdate', dateField: birth, valueField: birth };
      break;
    }
    const age = await visible(session, SIGNUP_SELECTORS.age, 100);
    if (age) {
      semantic = { name, mode: 'age', ageField: age, valueField: age };
      break;
    }
    discovered = await discoverGenericAboutFields(session);
    if (discovered.valueField || (allowNameOnly && discovered.mode === 'name-only' && discovered.nameField)) break;
    await sleep(session, 250);
  } while (Date.now() < deadline);

  if (!semantic && (discovered.valueField || (allowNameOnly && discovered.mode === 'name-only'))) {
    try {
      const fallback = await fillGenericAboutFields(session, discovered, identity, { forceKeyboard, allowNameOnly });
      if (fallback) return fallback;
    } catch (error) {
      if (error?.code === 'JOB_CANCELLED') throw error;
    }
  }

  if (!semantic) {
    throw flowError(
      `当前停在 ${pageLocation(session)}，等待后仍未识别姓名/生日控件（候选 ${discovered.fields.length} 个），资料未填上`,
      'REGISTER_HEADLESS_ABOUT_FIELDS_MISSING',
    );
  }

  const nameField = semantic.name || await visible(session, SIGNUP_SELECTORS.name, 100);
  if (nameField && !await typeIntoSegment(nameField.locator, String(identity?.name || 'Alex'), { session, forceKeyboard })) {
    throw flowError('about-you 姓名控件未能保留输入值', 'REGISTER_HEADLESS_ABOUT_VALUE_REJECTED');
  }

  let dateMode = '';
  let lastField = nameField;
  if (semantic.mode === 'age') {
    if (!await typeIntoSegment(semantic.valueField.locator, String(ageFromBirthdate(identity?.birthdate)), { session, forceKeyboard })) {
      throw flowError('about-you 年龄控件未能保留输入值', 'REGISTER_HEADLESS_ABOUT_VALUE_REJECTED');
    }
    dateMode = 'age';
    lastField = semantic.valueField;
  } else {
    dateMode = await fillBirthdayVariant(session, identity.birthdate, {
      timeoutMs, cancelled, forceKeyboard, segments: semantic.segments, dateField: semantic.dateField,
    });
    lastField = semantic.valueField || lastField;
  }
  if (!dateMode) {
    throw flowError(`about-you 页面缺少 Age/生日控件（停在 ${pageLocation(session)}）`, 'REGISTER_HEADLESS_ABOUT_FIELDS_MISSING');
  }
  return { field: lastField, mode: `${nameField ? 'name+' : ''}${dateMode}` };
}

async function aboutFormSnapshot(session) {
  try {
    return await session.page.evaluate(() => {
      const continueBtn = [...document.querySelectorAll('button[data-dd-action-name="Continue"], button[type="submit"], button')]
        .find((el) => {
          const text = String(el.textContent || '').replace(/\s+/g, ' ').trim();
          return el.getAttribute('data-dd-action-name') === 'Continue' || /^(continue|next|继续)$/i.test(text);
        });
      const fields = [...document.querySelectorAll('input, [role="spinbutton"], [role="textbox"], [contenteditable="true"]')]
        .slice(0, 8)
        .map((el) => ({
          role: el.getAttribute('role') || '',
          name: el.getAttribute('name') || '',
          aria: String(el.getAttribute('aria-label') || '').slice(0, 40),
          type: el.getAttribute('type') || '',
          empty: !String(el.value || el.textContent || '').trim(),
          invalid: el.getAttribute('aria-invalid') || '',
        }));
      const alerts = [...document.querySelectorAll('[role="alert"], [slot="errorMessage"], p[id$="-error"], [data-invalid]')]
        .map((el) => String(el.textContent || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .slice(0, 6);
      return {
        continue_enabled: continueBtn
          ? !continueBtn.disabled && continueBtn.getAttribute('aria-disabled') !== 'true'
          : false,
        fields,
        alerts,
      };
    });
  } catch {
    return null;
  }
}

async function clickEnabledContinue(session, { timeoutMs = 12000, cancelled } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  do {
    active(cancelled);
    const found = await visible(session, SIGNUP_SELECTORS.continue, 200);
    if (found) {
      last = found;
      const enabled = typeof found.locator.isEnabled !== 'function'
        || await found.locator.isEnabled({ timeout: 0 }).catch(() => true);
      if (enabled) {
        await found.locator.click({ timeout: 5000 }).catch(() => {});
        return { submitted: true, method: 'click', selector: found.selector, enabled: true };
      }
    }
    await sleep(session, 200);
  } while (Date.now() < deadline);
  return { submitted: false, method: '', selector: last?.selector || '', enabled: false };
}

async function submitAboutAndWait(session, about, identity, {
  timeoutMs, cancelled, note, recoverLanding, callbackProbeAfterMs = 0,
} = {}) {
  const waitOnce = async (waitMs, waitOptions = {}) => {
    const deadline = Date.now() + waitMs;
    const first = typeof recoverLanding === 'function' && callbackProbeAfterMs > 0
      ? Math.min(waitMs, callbackProbeAfterMs)
      : waitMs;
    let outcome = await waitForAboutSubmitOutcome(session, { timeoutMs: first, cancelled, ...waitOptions });
    if (outcome.stage || typeof recoverLanding !== 'function') return { ...outcome, recovered: false };
    if (await recoverLanding()) return { stage: 'landing', inlineError: '', recovered: true };
    const remaining = Math.max(0, deadline - Date.now());
    if (remaining > 0) {
      outcome = await waitForAboutSubmitOutcome(session, { timeoutMs: remaining, cancelled, ...waitOptions });
      if (outcome.stage) return { ...outcome, recovered: false };
    }
    return { ...outcome, recovered: false };
  };

  let clicked = await clickEnabledContinue(session, { timeoutMs: Math.min(12000, timeoutMs), cancelled });
  if (!clicked.submitted) {
    if (about?.field?.locator?.press) await about.field.locator.press('Enter').catch(() => {});
    clicked = { submitted: true, method: 'enter', selector: about?.field?.selector || '', enabled: false };
  }
  let outcome = await waitOnce(Math.min(timeoutMs, ABOUT_VALIDATION_RETRY_TIMEOUT_MS));
  const stillAbout = () => /\/about-you(?:\/|$)/i.test(currentUrl(session));
  if (outcome.stage !== 'validation-error' && (outcome.stage || !stillAbout())) return { ...outcome, submit: clicked };

  note?.('资料页还缺了点东西，再填一遍', 'warn');
  const retryAbout = await fillAboutYou(session, identity, {
    timeoutMs: Math.min(timeoutMs, 30000),
    cancelled,
    forceKeyboard: true,
    allowNameOnly: false,
  });
  note?.('资料又填了一遍，继续往前走');
  await clickEnabledContinue(session, { timeoutMs: Math.min(12000, timeoutMs), cancelled });
  if (retryAbout?.field?.locator?.press) await retryAbout.field.locator.press('Enter').catch(() => {});
  outcome = await waitOnce(timeoutMs, {
    inlineErrorGraceMs: 1500,
    ignoredInlineError: outcome.inlineError,
  });
  if (outcome.stage === 'validation-error' || (!outcome.stage && stillAbout())) {
    const again = await aboutFormSnapshot(session);
    const inline = outcome.inlineError || (again?.alerts || []).join(' | ') || await readInlineError(session);
    throw Object.assign(
      flowError(`about-you 资料重新输入后仍未通过页面校验${inline ? `：${String(inline).slice(0, 180)}` : ''}（停在 ${pageLocation(session)}；Continue ${again?.continue_enabled ? '可用' : '不可用'}）`, 'REGISTER_HEADLESS_ABOUT_REJECTED'),
      { inline_error: inline },
    );
  }
  return { ...outcome, submit: clicked };
}

async function waitForChatgptLanding(session, { timeoutMs = LANDING_MIN_TIMEOUT_MS, cancelled, recoverLanding } = {}) {
  const deadline = Date.now() + timeoutMs;
  do {
    active(cancelled);
    if (isChatgptLanding(currentUrl(session))) return true;
    if (recoverLanding && await recoverLanding()) return true;
    await sleep(session, 250);
  } while (Date.now() < deadline);
  return false;
}

async function openSignupEntry({
  session, entryUrl = `${CHATGPT_ORIGIN}/auth/login`, progress, log, cancelled,
  stepTimeoutMs = 45000, performanceProfile,
} = {}) {
  active(cancelled);
  const tuning = headlessInteractionTuning(performanceProfile);
  const navigationTimeoutMs = entryNavigationTimeoutMs(stepTimeoutMs);
  let last;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await session.goto(entryUrl, { waitUntil: 'commit', timeout: navigationTimeoutMs });
      last = null;
      break;
    } catch (error) {
      last = error;
      const code = stableCloakErrorCode(error);
      if (code === 'CLOAK_LICENSE_SESSION_LIMIT') throw Object.assign(error, { code });
      const timeout = error?.name === 'TimeoutError' || /timeout|ERR_TIMED_OUT/i.test(String(error?.message || error));
      if (!timeout || attempt === 3) {
        throw flowError(`ChatGPT 登录入口导航${timeout ? '超时' : '失败'}：${String(error?.message || error).slice(0, 180)}`, timeout ? 'REGISTER_HEADLESS_ENTRY_TIMEOUT' : 'REGISTER_HEADLESS_ENTRY_NAVIGATION_FAILED', error);
      }
      log?.('注册小门有点慢，再轻轻试一次', 'warn');
      await sleep(session, 1500);
    }
  }
  if (last) throw last;
  progress?.(10, '走进邮箱注册小门');
  await dismissKnownEntryConsent(session, {
    cancelled,
    timeoutMs: Math.max(500, tuning.cookieConsentProbeMs),
  });
  if (AUTH_HOST.test(new URL(currentUrl(session)).hostname)) return currentUrl(session);
  let field = await waitForStableVisibleInputNode(session, ENTRY_SELECTORS.emailField, {
    timeoutMs: entryEmailFieldTimeoutMs(stepTimeoutMs),
    settleMs: 180,
    cancelled,
  });
  if (!field) {
    const signUp = await waitVisible(session, ENTRY_SELECTORS.signUp, 5000, cancelled);
    await signUp?.locator?.click({ timeout: 5000 }).catch(() => {});
    field = await waitForStableVisibleInputNode(session, ENTRY_SELECTORS.emailField, {
      timeoutMs: entryEmailFieldTimeoutMs(stepTimeoutMs),
      settleMs: 180,
      cancelled,
    });
  }
  if (!field) throw flowError('ChatGPT 注册入口未出现邮箱输入框', 'REGISTER_HEADLESS_NO_EMAIL_FIELD');
  await sleep(session, tuning.emailSettleMs);
  log?.('注册小门已经打开啦', 'debug');
  return currentUrl(session);
}

async function driveHeadlessSignup(args = {}) {
  const {
    session, account, identity, waitForOtp, checkpoint, progress, log, cancelled,
    onConsumptionCheckpoint, stepTimeoutMs = 45000, performanceProfile = 'safe', recoverLanding,
    telemetry,
  } = args;
  if (!String(account?.email || '').trim()) throw flowError('无头注册缺少邮箱', 'REGISTER_HEADLESS_NO_EMAIL_FIELD');
  if (!String(account?.password || '')) throw flowError('无头模拟点击注册需要固定密码', 'REGISTER_HEADLESS_PASSWORD_REQUIRED');
  const tracker = trackEmailOtpDispatch(session.page);
  const interaction = headlessInteractionTuning(performanceProfile);
  const note = (message, level) => log?.(String(message || ''), level);
  let callbackRecovered = false;
  try {
    if (!AUTH_HOST.test(new URL(currentUrl(session)).hostname)) {
      progress?.(18, '正在填写邮箱');
      note('第1步：填上邮箱');
      await submitEntryEmail(session, account.email, {
        timeoutMs: Math.max(60000, Math.min(120000, (Number(stepTimeoutMs) || 45000) * 2)),
        cancelled,
        note,
        telemetry,
      });
      note('已经走进注册小屋啦');
    }
    let stage = await waitForStage(session, [
      'passwordChoice', 'password', 'otp', 'about', 'passkey', 'landing', 'existingPassword', 'browserError',
    ], {
      timeoutMs: authStageTimeoutMs(stepTimeoutMs), cancelled,
    });
    note(`注册小屋已经打开，现在在${stageLabel(stage || 'waiting')}`);
    if (stage === 'browserError') throw flowError('认证页面加载失败', 'REGISTER_HEADLESS_AUTH_PAGE_FAILED');
    if (stage === 'existingPassword') throw flowError('邮箱进入了已有账号登录/重置密码路径', 'REGISTER_HEADLESS_EMAIL_NOT_NEW');
    if (stage === 'passkey') {
      await skipPasskeyIfPresent(session, { cancelled, log: note });
      stage = await waitForStage(session, [
        'passwordChoice', 'password', 'otp', 'about', 'landing', 'existingPassword', 'browserError',
      ], { timeoutMs: authStageTimeoutMs(stepTimeoutMs), cancelled }) || stage;
    }
    let unifiedPasswordRoute = false;
    const acceptUnifiedPassword = async (next) => {
      if (next === 'existingPassword' && await visible(session, SIGNUP_SELECTORS.password, 100)) {
        unifiedPasswordRoute = true;
        return 'password';
      }
      return next;
    };
    const clickPasswordChoice = async () => {
      let clickError = null;
      try {
        const choice = await waitVisible(session, ENTRY_SELECTORS.continueWithPassword, Math.min(10000, stepTimeoutMs), cancelled);
        if (!choice) throw new Error('password choice missing');
        note('点一下设置密码');
        await choice.locator.click();
      } catch (error) { clickError = error; }
      const next = await acceptUnifiedPassword(
        await waitForStage(session, ['password', 'existingPassword', 'browserError'], { timeoutMs: stepTimeoutMs, cancelled }),
      );
      if (!next && clickError) throw flowError(`密码注册入口未稳定推进：${clickError.message}`, 'REGISTER_HEADLESS_PASSWORD_CHOICE_STALLED', clickError);
      return next;
    };
    const openPasswordSignupPage = async () => {
      if (await visible(session, SIGNUP_SELECTORS.password, 200)) return 'password';
      const choice = await visible(session, ENTRY_SELECTORS.continueWithPassword, 1200);
      if (choice) {
        note('点一下设置密码');
        await choice.locator.click({ timeout: 5000 }).catch(() => {});
        const next = await acceptUnifiedPassword(
          await waitForStage(session, ['password', 'existingPassword', 'browserError'], {
            timeoutMs: Math.min(passwordAdvanceTimeoutMs(stepTimeoutMs), Math.max(Number(stepTimeoutMs) || 8000, 8000)),
            cancelled,
          }),
        );
        if (next === 'password') return next;
      }
      const target = `${AUTH_ORIGIN}/create-account/password`;
      if (typeof session.goto === 'function' && !/\/create-account\/password(?:\/|$)/i.test(currentUrl(session))) {
        note('还没走进密码页，再帮你开一下');
        await session.goto(target, {
          waitUntil: 'commit',
          timeout: Math.min(20000, Math.max(8000, Number(stepTimeoutMs) || 8000)),
        }).catch(() => {
          note('密码页有点倔，暂时没打开', 'warn');
        });
      }
      return acceptUnifiedPassword(
        await waitForStage(session, ['password', 'existingPassword', 'browserError'], {
          timeoutMs: Math.min(passwordAdvanceTimeoutMs(stepTimeoutMs), Math.max(Number(stepTimeoutMs) || 8000, 8000)),
          cancelled,
        }),
      );
    };
    if (!account.password_set && stage !== 'password' && stage !== 'landing') {
      if (stage === 'transition' || !stage) {
        const spaWaitMs = Math.min(10000, Math.max(400, Number(stepTimeoutMs) || 400));
        const delayed = await waitForStage(session, ['passwordChoice', 'password'], { timeoutMs: spaWaitMs, cancelled });
        if (delayed) {
          note(`页面从${stageLabel(stage || 'waiting')}走到${stageLabel(delayed)}，继续往下走`);
          stage = delayed;
        }
      }
      if (stage === 'passwordChoice') stage = await clickPasswordChoice() || stage;
      if (stage !== 'password') {
        note(`先设好密码，再去拿验证码哦（现在还在${stageLabel(stage || 'waiting')}）`);
        stage = await openPasswordSignupPage() || stage;
      }
      if (stage !== 'password' && await visible(session, SIGNUP_SELECTORS.password, 200)) stage = 'password';
      if (stage !== 'password') {
        throw flowError(`必须先点击设置密码并填写密码，不能直接走邮箱验证码（停在 ${pageLocation(session)}）`, 'REGISTER_HEADLESS_PASSWORD_REQUIRED_BEFORE_OTP');
      }
    } else if (stage === 'passwordChoice') {
      stage = await clickPasswordChoice() || stage;
    }
    if (stage === 'password') {
      const passwordField = await visible(session, SIGNUP_SELECTORS.password, 800);
      if (!passwordField) {
        throw flowError(`未找到密码输入框（停在 ${pageLocation(session)}），不会把验证码页当成密码页`, 'REGISTER_HEADLESS_PASSWORD_STALLED');
      }
      progress?.(35, '正在填写密码');
      note('第2步：正在填写密码');
      await checkpoint?.({ password: account.password, password_set: false, hardening_status: 'pending' });
      const hydrated = await waitForPasswordFormHydration(session, { timeoutMs: stepTimeoutMs, cancelled });
      if (!hydrated) throw flowError('密码页初始化超时', 'REGISTER_HEADLESS_PASSWORD_STALLED');
      const password = await fill(session, SIGNUP_SELECTORS.password, account.password, Math.min(stepTimeoutMs, 12000), cancelled, 'REGISTER_HEADLESS_PASSWORD_STALLED', { clickFirst: true });
      await onConsumptionCheckpoint?.({ stage: 'password_submission' });
      await clickSubmit(session, password);
      let next = await waitForStage(session, unifiedPasswordRoute
        ? ['otp', 'about', 'landing', 'browserError']
        : ['otp', 'about', 'landing', 'existingPassword', 'browserError'], {
        timeoutMs: passwordAdvanceTimeoutMs(stepTimeoutMs),
        cancelled,
        stopOnInlineError: true,
      });
      next = await acceptLateStage(session, next, ['otp', 'about', 'landing', 'existingPassword']);
      if (next === 'existingPassword') throw flowError('邮箱已进入已有账号路径', 'REGISTER_HEADLESS_EMAIL_NOT_NEW');
      if (!next || next === 'browserError' || next === 'inlineError') {
        throw passwordAdvanceFailure(await readInlineError(session));
      }
      account.password_set = true;
      await checkpoint?.({ password: account.password, password_set: true, hardening_status: 'password_set' });
      note(`密码交上去啦，接着去${stageLabel(next)}`);
      stage = next;
    }
    for (let round = 0; round < 6 && stage !== 'landing'; round += 1) {
      if (stage === 'password' && !account.password_set) {
        const passwordField = await visible(session, SIGNUP_SELECTORS.password, 800);
        if (!passwordField) {
          throw flowError(`未找到密码输入框（停在 ${pageLocation(session)}）`, 'REGISTER_HEADLESS_PASSWORD_STALLED');
        }
        progress?.(35, '正在填写密码');
        note('第2步：正在填写密码');
        await checkpoint?.({ password: account.password, password_set: false, hardening_status: 'pending' });
        const password = await fill(session, SIGNUP_SELECTORS.password, account.password, Math.min(stepTimeoutMs, 12000), cancelled, 'REGISTER_HEADLESS_PASSWORD_STALLED', { clickFirst: true });
        await onConsumptionCheckpoint?.({ stage: 'password_submission' });
        await clickSubmit(session, password);
        stage = await waitForStage(session, ['otp', 'about', 'landing', 'existingPassword', 'browserError'], {
          timeoutMs: passwordAdvanceTimeoutMs(stepTimeoutMs), cancelled, stopOnInlineError: true,
        }) || stage;
        if (stage === 'existingPassword') throw flowError('邮箱已进入已有账号路径', 'REGISTER_HEADLESS_EMAIL_NOT_NEW');
        if (!stage || stage === 'browserError' || stage === 'inlineError' || stage === 'password') {
          throw passwordAdvanceFailure(await readInlineError(session));
        }
        account.password_set = true;
        await checkpoint?.({ password: account.password, password_set: true, hardening_status: 'password_set' });
        continue;
      }
      if (stage === 'passkey') {
        await skipPasskeyIfPresent(session, { cancelled, log: note });
        stage = await waitForStage(session, ['otp', 'about', 'landing', 'existingPassword', 'browserError'], {
          timeoutMs: otpAdvanceTimeoutMs(stepTimeoutMs), cancelled,
        }) || stage;
        continue;
      }
      if (stage === 'otp') {
        if (!account.password_set) {
          note('先回去设密码，验证码先等等');
          stage = await openPasswordSignupPage() || stage;
          if (stage !== 'password' && await visible(session, SIGNUP_SELECTORS.password, 200)) stage = 'password';
          if (stage !== 'password') {
            throw flowError(`必须先点击设置密码并填写密码，不能直接走邮箱验证码（停在 ${pageLocation(session)}）`, 'REGISTER_HEADLESS_PASSWORD_REQUIRED_BEFORE_OTP');
          }
          continue;
        }
        progress?.(60, '正在等邮箱验证码');
        note('第3步：正在等邮箱验证码');
        const code = normalizeEmailOtp(await waitForOtp?.());
        if (!code) throw flowError('邮箱通道未返回 6 位验证码', 'REGISTER_HEADLESS_OTP_INVALID_FORMAT');
        note('正在填验证码');
        let otp = await fill(session, SIGNUP_SELECTORS.otp, code, Math.min(stepTimeoutMs, 12000), cancelled, 'REGISTER_HEADLESS_OTP_STALLED');
        if (!await stableControlValue(session, otp.locator, code)) {
          otp = await waitVisible(session, SIGNUP_SELECTORS.otp, 3000, cancelled) || otp;
          if (!await typeStable(session, otp.locator, code, true)) {
            throw flowError('验证码输入值未稳定保留', 'REGISTER_HEADLESS_OTP_VALUE_REJECTED');
          }
        }
        const otpTimeoutMs = otpAdvanceTimeoutMs(stepTimeoutMs);
        const automaticGraceMs = Math.min(otpTimeoutMs, Math.max(0, Number(interaction.otpAutoSubmitGraceMs) || 0));
        let next = automaticGraceMs > 0
          ? await waitForStage(session, ['passkey', 'about', 'password', 'landing', 'existingPassword', 'browserError'], {
            timeoutMs: automaticGraceMs,
            cancelled,
          })
          : '';
        if (!next) {
          await clickSubmit(session, otp);
          next = await waitForStage(session, ['passkey', 'about', 'password', 'landing', 'existingPassword', 'browserError'], {
            timeoutMs: Math.max(1, otpTimeoutMs - automaticGraceMs),
            cancelled,
            stopOnInlineError: true,
          });
        }
        const inline = (!next || next === 'inlineError') ? await readInlineError(session) : '';
        const stillOnOtpPage = /\/email-verification(?:\/|$)/i.test(currentUrl(session))
          || Boolean(await visible(session, SIGNUP_SELECTORS.otp, 100));
        const stillOtp = !next && stillOnOtpPage && !inline;
        if (stillOtp || isRetryableOtpInlineError(inline)) {
          note('验证码交上去了，页面还没动，再轻轻推一下', 'warn');
          otp = await waitVisible(session, SIGNUP_SELECTORS.otp, 5000, cancelled) || otp;
          await typeStable(session, otp.locator, code, true);
          await retryOtpSubmit(session, otp);
          next = await waitForStage(session, ['passkey', 'about', 'password', 'landing', 'existingPassword', 'browserError'], {
            timeoutMs: otpAdvanceTimeoutMs(stepTimeoutMs),
            cancelled,
            stopOnInlineError: true,
            inlineErrorGraceMs: 1500,
          });
        }
        next = await acceptLateStage(session, next, ['passkey', 'about', 'password', 'landing', 'existingPassword']);
        if (next === 'passkey') {
          await skipPasskeyIfPresent(session, { cancelled, log: note });
          next = await waitForStage(session, ['about', 'landing', 'existingPassword', 'browserError'], {
            timeoutMs: otpAdvanceTimeoutMs(stepTimeoutMs), cancelled,
          }) || next;
          next = await acceptLateStage(session, next, ['about', 'landing', 'existingPassword']);
        }
        if (next === 'existingPassword') throw flowError('验证码通过后进入了已有账号路径', 'REGISTER_HEADLESS_EMAIL_NOT_NEW');
        if (!next || next === 'browserError' || next === 'inlineError') {
          const errorText = await readInlineError(session);
          throw Object.assign(flowError(`验证码提交后页面未进入资料步骤${errorText ? `：${errorText}` : ''}`, 'REGISTER_HEADLESS_OTP_STALLED'), { inline_error: errorText });
        }
        stage = next;
        continue;
      }
      if (stage === 'about') {
        if (!/\/about-you(?:\/|$)/i.test(currentUrl(session))) {
          note('还没到资料页，再等一等', 'warn');
          stage = await waitForStage(session, ['otp', 'about', 'password', 'landing', 'browserError'], {
            timeoutMs: otpAdvanceTimeoutMs(stepTimeoutMs), cancelled,
          }) || '';
          continue;
        }
        progress?.(78, '正在填写小资料');
        note('第4步：正在填写小资料');
        const about = await fillAboutYou(session, identity, { timeoutMs: aboutFormTimeoutMs(stepTimeoutMs), cancelled });
        note('小资料填好啦');
        const outcome = await submitAboutAndWait(session, about, identity, {
          timeoutMs: aboutCallbackTimeoutMs(stepTimeoutMs),
          cancelled,
          note,
          recoverLanding,
          callbackProbeAfterMs: Number(interaction.callbackProbeAfterMs) || 0,
        });
        const aboutSubmit = outcome.submit || {};
        let next = outcome.stage;
        if (outcome.recovered) callbackRecovered = true;
        if (next === 'otp' || next === 'passkey') {
          note(next === 'otp' ? '资料提交后仍需验证码，回到验证码步骤' : '资料提交后出现通行密钥页', 'info');
          stage = next;
          continue;
        }
        if (next !== 'landing') {
          const inline = outcome.inlineError || await readInlineError(session);
          throw Object.assign(flowError(`资料提交后网页回调未完成（提交方式 ${aboutSubmit?.method || 'unknown'} ${aboutSubmit?.selector || ''}；停在 ${pageLocation(session)}${inline ? `；${String(inline).slice(0, 160)}` : ''}）`, next === 'validation-error' ? 'REGISTER_HEADLESS_ABOUT_REJECTED' : 'REGISTER_HEADLESS_NO_CALLBACK'), { inline_error: inline });
        }
        stage = next;
        continue;
      }
      if (!stage || stage === 'transition') {
        note('还在等密码、验证码或资料页出现', 'warn');
        stage = await waitForStage(session, ['password', 'otp', 'about', 'passkey', 'landing', 'browserError'], {
          timeoutMs: authStageTimeoutMs(stepTimeoutMs), cancelled,
        }) || '';
        if (!stage) break;
        continue;
      }
      break;
    }
    if (stage !== 'landing') {
      const landed = await waitForChatgptLanding(session, {
        timeoutMs: landingTimeoutMs(stepTimeoutMs), cancelled, recoverLanding,
      });
      if (!landed) throw flowError('无头注册未完成 ChatGPT 回调', 'REGISTER_HEADLESS_NO_CALLBACK');
      callbackRecovered ||= !isChatgptLanding(currentUrl(session));
    }
    progress?.(82, '页面注册完成啦');
    note('第5步：页面注册完成啦');
    log?.('页面这边已经注册好啦', 'ok');
    await tracker.settle();
    return { landing: currentUrl(session), email_otp_send: tracker.snapshot(), callback_recovered: callbackRecovered };
  } catch (error) {
    await tracker.settle();
    error.email_otp_send ||= tracker.snapshot();
    error.code ||= inferHeadlessFailureCode('', error.message);
    throw error;
  } finally {
    tracker.dispose();
  }
}

async function driveExistingAccountLogin({ session, account, progress, log, cancelled, stepTimeoutMs = 45000 } = {}) {
  const { driveExistingAccountLogin: drive } = require('./existing-account-login');
  return drive({ session, account, progress, log, cancelled, stepTimeoutMs });
}

exports.SIGNUP_SELECTORS = SIGNUP_SELECTORS;
exports.ENTRY_SELECTORS = ENTRY_SELECTORS;
exports.FORM_SUBMITTER_SELECTOR = FORM_SUBMITTER_SELECTOR;
exports.LOGIN_SELECTORS = LOGIN_SELECTORS;
exports.PASSWORD_ADVANCE_MIN_TIMEOUT_MS = PASSWORD_ADVANCE_MIN_TIMEOUT_MS;
exports.OTP_ADVANCE_MIN_TIMEOUT_MS = OTP_ADVANCE_MIN_TIMEOUT_MS;
exports.ABOUT_FORM_MIN_TIMEOUT_MS = ABOUT_FORM_MIN_TIMEOUT_MS;
exports.ABOUT_CALLBACK_MIN_TIMEOUT_MS = ABOUT_CALLBACK_MIN_TIMEOUT_MS;
exports.ENTRY_NAVIGATION_MIN_TIMEOUT_MS = ENTRY_NAVIGATION_MIN_TIMEOUT_MS;
exports.ENTRY_EMAIL_FIELD_MIN_TIMEOUT_MS = ENTRY_EMAIL_FIELD_MIN_TIMEOUT_MS;
exports.ENTRY_EMAIL_STABILITY_MIN_TIMEOUT_MS = ENTRY_EMAIL_STABILITY_MIN_TIMEOUT_MS;
exports.AUTH_STAGE_MIN_TIMEOUT_MS = AUTH_STAGE_MIN_TIMEOUT_MS;
exports.LANDING_MIN_TIMEOUT_MS = LANDING_MIN_TIMEOUT_MS;
exports.ABOUT_VALIDATION_RETRY_TIMEOUT_MS = ABOUT_VALIDATION_RETRY_TIMEOUT_MS;
exports.inferHeadlessFailureCode = inferHeadlessFailureCode;
exports.passwordAdvanceTimeoutMs = passwordAdvanceTimeoutMs;
exports.otpAdvanceTimeoutMs = otpAdvanceTimeoutMs;
exports.aboutFormTimeoutMs = aboutFormTimeoutMs;
exports.aboutCallbackTimeoutMs = aboutCallbackTimeoutMs;
exports.entryNavigationTimeoutMs = entryNavigationTimeoutMs;
exports.entryEmailFieldTimeoutMs = entryEmailFieldTimeoutMs;
exports.authStageTimeoutMs = authStageTimeoutMs;
exports.landingTimeoutMs = landingTimeoutMs;
exports.classifyAboutBirthdaySegments = classifyAboutBirthdaySegments;
exports.classifyAboutInputDescriptors = classifyAboutInputDescriptors;
exports.shouldReplayAuthorize = shouldReplayAuthorize;
exports.isChatgptLanding = isChatgptLanding;
exports.isEmailConfirmEntry = isEmailConfirmEntry;
exports.scanVisibleSelectorGroups = scanVisibleSelectorGroups;
exports.waitForPasswordFormHydration = waitForPasswordFormHydration;
exports.waitForStableVisibleInputNode = waitForStableVisibleInputNode;
exports.stabilizeVisibleInputInPage = stabilizeVisibleInputInPage;
exports.submitVisibleEmailFormInPage = submitVisibleEmailFormInPage;
exports.dismissKnownEntryConsent = dismissKnownEntryConsent;
exports.submitEntryEmail = submitEntryEmail;
exports.trackEmailOtpDispatch = trackEmailOtpDispatch;
exports.waitForStage = waitForStage;
exports.detectStage = detectStage;
exports.acceptLateStage = acceptLateStage;
exports.isRetryableOtpInlineError = isRetryableOtpInlineError;
exports.normalizeEmailOtp = normalizeEmailOtp;
exports.waitForAboutSubmitOutcome = waitForAboutSubmitOutcome;
exports.verifyBirthdaySegments = verifyBirthdaySegments;
exports.fillAboutYou = fillAboutYou;
exports.waitForChatgptLanding = waitForChatgptLanding;
exports.openSignupEntry = openSignupEntry;
exports.driveExistingAccountLogin = driveExistingAccountLogin;
exports.driveHeadlessSignup = driveHeadlessSignup;
