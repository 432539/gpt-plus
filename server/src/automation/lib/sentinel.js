const { config } = require('../config');

/**
 * OpenAI Sentinel（人机校验）请求头生成。
 *
 * 旧版 Python 引擎在没有浏览器的前提下逆向了 sentinel SDK（FNV-1a PoW + turnstile
 * VM + session observer）。这里改为在 CloakBrowser 里直接跑官方 SDK。
 *
 * SDK 是「父页面 + sentinel iframe」双层结构：父页面算 PoW 与 turnstile，iframe 负责
 * 同源 POST `/backend-api/sentinel/req`。因此宿主页面必须选在 sentinel 自己的源上：
 *   - 在 chatgpt.com 页面里注入 SDK 会被 ChatGPT 的 `script-src-elem` 拦掉；
 *   - 即使借用页面 nonce 绕过，SDK 自建的 iframe 又会撞上 ChatGPT 的 `frame-src`。
 * 直接把独立页面导航到 `sentinel.openai.com/backend-api/sentinel/frame.html`，脚本与
 * iframe 都变成同源，两条 CSP 都不再介入，同时 `.openai.com` 上的 `oai-did` 仍可被
 * SDK 读到（它用这个 cookie 填令牌的 `id`）。
 */

const SENTINEL_ORIGIN = 'https://sentinel.openai.com';
const SENTINEL_FRAME_PATH = '/backend-api/sentinel/frame.html';
const CHATGPT_ORIGIN = 'https://chatgpt.com';
const DEVICE_COOKIE = 'oai-did';
const TOKEN_HEADER = 'OpenAI-Sentinel-Token';
const SO_TOKEN_HEADER = 'OpenAI-Sentinel-SO-Token';
const SDK_MISSING = 'sdk_global_missing';
const TRANSIENT_NAVIGATION = /net::ERR_(?:TIMED_OUT|EMPTY_RESPONSE|CONNECTION_(?:RESET|CLOSED|ABORTED|REFUSED)|NETWORK_CHANGED|PROXY_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED)|Timeout \d+ms exceeded/i;

const noop = () => {};

class SentinelTokenError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SentinelTokenError';
    this.code = 'SENTINEL_TOKEN_FAILED';
  }
}

function parseSentinelJson(value) {
  if (typeof value !== 'string' || !value.trim().startsWith('{')) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 真实客户端总是带 sv；版本号过期时退回不带查询串的 frame.html。 */
function frameCandidates(sdkVersion) {
  const base = `${SENTINEL_ORIGIN}${SENTINEL_FRAME_PATH}`;
  const version = String(sdkVersion || '').trim();
  return version ? [`${base}?sv=${encodeURIComponent(version)}`, base] : [base];
}

/**
 * `addInitScript` 走 CDP 注入，不受页面 CSP 约束，且在页面脚本之前执行，
 * 因此能抓到 SDK 自建 iframe 被拦的那一刻。少了它，CSP 拦截只会表现为超时。
 */
async function installViolationCollector(page, log) {
  if (typeof page?.addInitScript !== 'function') return false;
  try {
    await page.addInitScript(() => {
      window.__sentinelCspViolations = window.__sentinelCspViolations || [];
      // 一次协议跑两个 challenge，钩子会注册两次，这里避免监听器重复累加。
      if (window.__sentinelCspHooked) return;
      window.__sentinelCspHooked = true;
      document.addEventListener('securitypolicyviolation', event => {
        const directive = event.effectiveDirective || event.violatedDirective || 'csp';
        window.__sentinelCspViolations.push(`${directive}:${String(event.blockedURI || '').slice(0, 120)}`);
      });
    });
    return true;
  } catch (error) {
    log(`[sentinel] CSP 诊断钩子安装失败（继续）：${error?.message || error}`, 'debug');
    return false;
  }
}

/**
 * SDK 在宿主页面读 `oai-did` 填令牌的 `id`，其 iframe 再读一次填 `/req` 请求体。
 * 必须在导航之前写好，否则首个 challenge 就会缺 `id`。
 */
async function ensureDeviceCookie(page, deviceId, log) {
  const context = typeof page?.context === 'function' ? page.context() : null;
  if (typeof context?.addCookies !== 'function') return;
  let existing = [];
  if (typeof context.cookies === 'function') {
    try { existing = await context.cookies([`${CHATGPT_ORIGIN}/`, `${SENTINEL_ORIGIN}/`]) || []; } catch { existing = []; }
  }
  const missing = ['.chatgpt.com', '.openai.com'].filter(domain => !existing.some(
    cookie => cookie?.name === DEVICE_COOKIE
      && cookie?.value === deviceId
      && String(cookie?.domain || '').endsWith(domain.slice(1)),
  ));
  if (!missing.length) return;
  try {
    await context.addCookies(missing.map(domain => ({
      name: DEVICE_COOKIE, value: deviceId, domain, path: '/', secure: true,
    })));
    log(`[sentinel] 已补齐 ${DEVICE_COOKIE} cookie（${missing.join(', ')}）`, 'debug');
  } catch (error) {
    log(`[sentinel] ${DEVICE_COOKIE} cookie 补齐失败（继续）：${error?.message || error}`, 'debug');
  }
}

/* c8 ignore start -- 在浏览器页面上下文中执行，不参与 Node 侧覆盖率 */
async function collectInPage({ flow, timeoutMs, soTimeoutMs, sdkMissing }) {
  const deadline = Date.now() + timeoutMs;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const withTimeout = (value, ms, label) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), Math.max(1000, ms));
    Promise.resolve(value).then(
      result => { clearTimeout(timer); resolve(result); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
  const readCookie = name => {
    const found = document.cookie.split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`));
    if (!found) return '';
    try { return decodeURIComponent(found.slice(name.length + 1)); } catch { return found.slice(name.length + 1); }
  };
  const violations = () => (window.__sentinelCspViolations || []).slice(0, 6).join(' | ');
  const annotate = message => {
    const csp = violations();
    return csp ? `${message} csp=[${csp}]` : message;
  };

  // frame.html 自己加载 SDK，这里只等它就绪，不注入任何脚本。
  while (typeof window.SentinelSDK?.token !== 'function') {
    if (Date.now() >= deadline) throw new Error(annotate(sdkMissing));
    await sleep(50);
  }

  let token = null;
  let so = null;
  try {
    token = await withTimeout(window.SentinelSDK.token(flow), deadline - Date.now(), 'sdk_token_timeout');
  } catch (error) {
    throw new Error(annotate(error?.message || 'sdk_token_failed'));
  }
  // session observer 只在 challenge 要求时才有值，拿不到就按 SDK 语义留空。
  try {
    so = typeof window.SentinelSDK.sessionObserverToken === 'function'
      ? await withTimeout(window.SentinelSDK.sessionObserverToken(flow), soTimeoutMs, 'sdk_so_timeout')
      : null;
  } catch {
    so = null;
  }
  const frame = document.querySelector('iframe[src*="/backend-api/sentinel/"]') || document.querySelector('iframe');
  return {
    token: token ?? null,
    so: so ?? null,
    deviceCookie: readCookie('oai-did'),
    frameSrc: frame?.src || '',
    cspViolations: violations(),
  };
}
/* c8 ignore stop */

function pageReached(page, targetUrl) {
  try {
    const current = new URL(page.url());
    const target = new URL(targetUrl);
    return current.origin === target.origin && current.pathname === target.pathname;
  } catch { return false; }
}

async function navigate(session, page, url, settings, log, flow) {
  const timeoutMs = Math.max(5000, Number(settings.navigationTimeoutMs) || 70000);
  const attempts = Math.max(1, Math.min(4, Number(settings.navigationAttempts) || 2));
  const deadline = Date.now() + timeoutMs;
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const options = { waitUntil: 'commit', timeout: Math.max(1, deadline - Date.now()) };
      if (typeof session?.goto === 'function') await session.goto(url, options);
      else await page.goto(url, options);
      return;
    } catch (error) {
      if (error?.code === 'JOB_CANCELLED') throw error;
      if ((error?.name === 'TimeoutError' || TRANSIENT_NAVIGATION.test(String(error?.message || error))) && pageReached(page, url)) {
        log(`[sentinel] frame 已提交但导航响应超时，继续等待 SDK（flow=${flow}）`, 'warn');
        return;
      }
      if (error?.name !== 'TimeoutError' && !TRANSIENT_NAVIGATION.test(String(error?.message || error))) throw error;
      last = error;
      if (attempt >= attempts || Date.now() >= deadline) break;
      log(`[sentinel] frame 传输超时，复用当前 BrowserContext 重试 ${attempt}/${attempts}（flow=${flow}）`, 'warn');
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  throw last || new Error(`Sentinel frame navigation timeout after ${timeoutMs}ms`);
}

async function collectFromSentinelFrame(session, page, { flow, settings, log }) {
  let lastDetail = '';
  for (const url of frameCandidates(settings.sdkVersion)) {
    try {
      await navigate(session, page, url, settings, log, flow);
    } catch (error) {
      throw new SentinelTokenError(`Sentinel 页面导航失败（flow=${flow}，phase=navigation）：${String(error?.message || error)}`);
    }
    try {
      const result = await page.evaluate(collectInPage, {
        flow,
        timeoutMs: settings.timeoutMs,
        soTimeoutMs: settings.soTimeoutMs,
        sdkMissing: SDK_MISSING,
      });
      return { result, url };
    } catch (error) {
      const detail = String(error?.message || error);
      // 只有「SDK 没出现」才值得换 frame 地址重试；其余失败原样上报。
      if (!detail.includes(SDK_MISSING)) {
        throw new SentinelTokenError(`Sentinel 人机校验令牌生成异常（flow=${flow}）：${detail}`);
      }
      lastDetail = detail;
      log(`[sentinel] ${url} 未暴露 SDK：${detail}`, 'debug');
    }
  }
  throw new SentinelTokenError(
    `Sentinel SDK 未在 ${SENTINEL_ORIGIN} 就绪（flow=${flow}）：${lastDetail || '未知原因'}`,
  );
}

/**
 * 生成一次性的 Sentinel 请求头。
 *
 * 复用 cloak.js 的 origin 切换模型：把会话页面切到 sentinel 源完成校验，之后
 * `CloakSession.request` 会在下一次 chatgpt.com 请求时自己把页面切回去。
 *
 * @param {{page?: object, goto?: Function}} session CloakBrowser 会话
 * @param {{flow: string, deviceId?: string, log?: Function, settings?: object, enabled?: boolean}} options
 * @returns {Promise<Record<string, string>>} 可直接展开到 fetch headers 的对象
 */
async function sentinelHeaders(session, options = {}) {
  const flow = String(options.flow || '').trim();
  if (!flow) throw new TypeError('Sentinel 请求头生成缺少 flow 名称');
  const log = typeof options.log === 'function' ? options.log : noop;
  const settings = { ...(config.sentinel || {}), ...(options.settings || {}) };
  if (options.enabled === false || settings.enabled === false) {
    log(`[sentinel] 已按配置关闭，flow=${flow} 不携带人机校验`, 'warn');
    return {};
  }
  if (typeof session?.page?.evaluate !== 'function') {
    throw new SentinelTokenError(`Sentinel 人机校验需要 CloakBrowser 页面上下文（flow=${flow}）`);
  }

  const deviceId = String(options.deviceId || '').trim();
  const page = session.page;
  await installViolationCollector(page, log);
  if (deviceId) await ensureDeviceCookie(page, deviceId, log);
  const { result, url: frameUrl } = await collectFromSentinelFrame(session, page, { flow, settings, log });

  const token = parseSentinelJson(result?.token);
  if (!token) {
    throw new SentinelTokenError(
      `Sentinel 人机校验令牌不是有效 JSON（flow=${flow}）：${String(result?.token ?? '').slice(0, 160)}`,
    );
  }
  // SDK 失败时会返回 {e: message, p: proof}，必须当成失败而不是照发。
  if (token.e) throw new SentinelTokenError(`Sentinel 人机校验被拒（flow=${flow}）：${String(token.e).slice(0, 160)}`);
  if (!token.p || !token.c) {
    throw new SentinelTokenError(
      `Sentinel 人机校验令牌字段缺失（flow=${flow}）：p=${Boolean(token.p)} c=${Boolean(token.c)}`,
    );
  }
  if (!token.id) {
    log(`[sentinel] 令牌缺少 device_id（flow=${flow}）：${DEVICE_COOKIE} 未写入 .openai.com`, 'warn');
  } else if (deviceId && String(token.id) !== deviceId) {
    log(`[sentinel] 令牌 device_id 与 OAI-Device-Id 不一致（flow=${flow}），风控可能拒绝批准`, 'warn');
  }

  const headers = { [TOKEN_HEADER]: result.token };
  const soToken = parseSentinelJson(result?.so);
  if (soToken?.so) headers[SO_TOKEN_HEADER] = result.so;
  log(
    `[sentinel] flow=${flow} frame=${frameUrl.replace(SENTINEL_ORIGIN, '')} `
      + `turnstile=${Boolean(token.t)} so=${Boolean(soToken?.so)}`
      + (result.cspViolations ? ` csp=[${result.cspViolations}]` : ''),
    'debug',
  );
  return headers;
}

/**
 * 包装成协议状态机使用的注入点：失败即抛出，交给外层更换代理重试（旧协议行为）。
 */
function sentinelProvider({ session, deviceId, log, settings } = {}) {
  return (flow, target) => sentinelHeaders(target || session, { flow, deviceId, log, settings });
}

exports.SentinelTokenError = SentinelTokenError;
exports.sentinelHeaders = sentinelHeaders;
exports.sentinelProvider = sentinelProvider;
