const db = require('../db');
const { readSettings, cloakLicenseKeys } = require('./settings');
const { toDetail } = require('./accountFields');
const { normalizeChannel, channelSql } = require('./accountChannel');

function emptyState(kind = '') {
  return {
    kind,
    running: false,
    stop: false,
    finished: false,
    target: 0,
    completed: 0,
    success: 0,
    failed: 0,
    skipped: 0,
    current_email: '',
    current_id: 0,
    ids: [],
    emails: [],
    run_id: '',
    message: '',
    concurrency: 0,
  };
}

function parseJobIds(body = {}) {
  return [...new Set((Array.isArray(body.ids) ? body.ids : []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
}

function resolveOwnedTargets(userId, ids, requireIds, channel) {
  const ch = normalizeChannel(channel);
  const filter = channelSql();
  const targets = ids.length
    ? ids.filter((id) => db.prepare(`SELECT id FROM gpt_accounts WHERE user_id = ? AND id = ? AND ${filter}`).get(userId, id, ch))
    : db.prepare(`SELECT id FROM gpt_accounts WHERE user_id = ? AND ${filter} ORDER BY id`).all(userId, ch).map((row) => row.id);
  if (requireIds && !ids.length) throw Object.assign(new Error('请指定要处理的账号'), { status: 400 });
  if (!targets.length) throw Object.assign(new Error('没有可处理的账号'), { status: 400 });
  return targets;
}

function jobConcurrency({ requested, defaultConcurrency, maxConcurrency, count }) {
  return Math.max(
    1,
    Math.min(
      Number(requested) || defaultConcurrency,
      Math.max(1, Number(maxConcurrency) || 1),
      Math.max(1, Number(count) || 1),
    ),
  );
}

function appendJobTargets(state, userId, ids) {
  const added = [];
  const pending = new Set([...(state.queue || []), ...(state.ids || [])]);
  for (const raw of ids) {
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0 || pending.has(id)) continue;
    const row = db.prepare('SELECT id, email FROM gpt_accounts WHERE user_id = ? AND id = ?').get(userId, id);
    if (!row) continue;
    state.queue.push(id);
    state.ids.push(id);
    const email = String(row.email || '').toLowerCase();
    if (email && !state.emails.includes(email)) state.emails.push(email);
    pending.add(id);
    added.push(id);
  }
  state.target = state.ids.length;
  return added;
}

function publicStatus(state) {
  const {
    runtime,
    module,
    queue,
    nextProxy,
    hooks,
    maxConcurrency,
    activeWorkers,
    ...safe
  } = state;
  return {
    ...safe,
    concurrency: Number(state.concurrency) || 0,
    queued: Array.isArray(state.queue) ? state.queue.length : 0,
    active: Number(state.activeWorkers) || 0,
  };
}

function safeMessage(error, detail) {
  let text = String(error?.message || error || '');
  for (const secret of [
    detail?.password, detail?.totp_secret, detail?.access_token,
    detail?.refresh_token, detail?.client_secret,
  ].filter(Boolean)) text = text.replaceAll(String(secret), '<redacted>');
  return text.replace(/\b[A-Z2-7]{16,128}\b/gi, '<redacted>').replace(/\b\d{6}\b/g, '<redacted>').slice(0, 200);
}

function releaseTarget(state, id, detail) {
  const num = Number(id);
  state.ids = (state.ids || []).filter((item) => Number(item) !== num);
  state.queue = (state.queue || []).filter((item) => Number(item) !== num);
  const email = String(detail?.email || '').toLowerCase();
  if (email) state.emails = (state.emails || []).filter((item) => item !== email);
  if (Number(state.current_id) === num) {
    state.current_id = 0;
    state.current_email = '';
  }
}

function createLiveJob({ kind, log, source, requireIds = true, runOne, configure, allowEnqueue = false, onFinish } = {}) {
  const jobs = new Map();

  function isLive(userId) {
    return Boolean(jobs.get(userId)?.running);
  }

  function status(userId) {
    return publicStatus(jobs.get(userId) || emptyState(kind));
  }

  function finish(state) {
    if (!state.running && state.closed) return;
    state.running = false;
    state.finished = true;
    state.closed = true;
    state.current_email = '';
    state.current_id = 0;
    const runtime = state.runtime;
    state.runtime = null;
    const notify = () => {
      try { (state.onFinish || onFinish)?.({ userId: state.hooks?.userId, kind: state.kind }); } catch { /* ignore */ }
    };
    if (runtime?.closeAll) {
      return Promise.resolve(runtime.closeAll()).catch(() => {}).finally(notify);
    }
    notify();
  }

  function tryFinish(state) {
    if (state.stop) return finish(state);
    if ((state.queue?.length || 0) > 0 || (state.activeWorkers || 0) > 0) return;
    return finish(state);
  }

  function spawnWorker(state, hooks) {
    state.activeWorkers = (state.activeWorkers || 0) + 1;
    (async () => {
      try {
        while (state.queue.length && !state.stop) {
          const id = state.queue.shift();
          const row = db.prepare('SELECT * FROM gpt_accounts WHERE user_id = ? AND id = ?').get(hooks.userId, id);
          const detail = row ? toDetail(row) : null;
          state.current_id = Number(id) || 0;
          state.current_email = detail?.email || '';
          try {
            await hooks.runOne({
              user: hooks.user,
              id,
              row,
              detail,
              runtime: state.runtime,
              nextProxy: state.nextProxy,
              state,
              module: state.module,
              run_id: state.run_id,
            });
            state.success += 1;
            releaseTarget(state, id, detail);
          } catch (error) {
            if (state.stop || error?.code === 'JOB_CANCELLED') break;
            if (error?.skip) {
              state.skipped += 1;
              releaseTarget(state, id, detail);
            } else state.failed += 1;
            const level = error?.skip ? 'warning' : 'error';
            log(hooks.userId, level, `${detail?.email || id}：${safeMessage(error, detail)}（${error?.code || 'ERROR'}）`, {
              source,
              run_id: state.run_id,
            });
          } finally {
            state.completed += 1;
            state.message = `完成 ${state.completed}/${state.target}，成功 ${state.success}，失败 ${state.failed}，跳过 ${state.skipped}`;
          }
        }
      } finally {
        state.activeWorkers = Math.max(0, (state.activeWorkers || 1) - 1);
        const closing = tryFinish(state);
        if (closing && typeof closing.then === 'function') await closing;
      }
    })();
  }

  function ensureWorkers(state, hooks) {
    const cap = Math.max(1, Math.min(Number(state.concurrency) || 1, Number(state.maxConcurrency) || 1));
    while (state.running && !state.stop && state.queue.length > 0 && (state.activeWorkers || 0) < cap) {
      spawnWorker(state, hooks);
    }
  }

  function enqueue(user, body = {}) {
    const userId = user.id;
    const state = jobs.get(userId);
    if (!state?.running) return null;
    const ids = parseJobIds(body);
    const targets = resolveOwnedTargets(userId, ids, requireIds, body.channel);
    const added = appendJobTargets(state, userId, targets);
    if (!added.length) {
      return {
        ok: true,
        kind,
        target: state.target,
        concurrency: state.concurrency,
        run_id: state.run_id,
        enqueued: 0,
      };
    }
    const remaining = (state.queue?.length || 0) + (state.activeWorkers || 0);
    state.concurrency = Math.max(state.concurrency || 1, Math.min(Number(state.maxConcurrency) || 1, remaining));
    state.message = `已启动 ${state.target} 个账号`;
    ensureWorkers(state, state.hooks);
    return {
      ok: true,
      kind,
      target: state.target,
      concurrency: state.concurrency,
      run_id: state.run_id,
      enqueued: added.length,
    };
  }

  async function start(user, body = {}) {
    const userId = user.id;
    if (jobs.get(userId)?.running) {
      if (allowEnqueue) {
        const extra = enqueue(user, body);
        if (extra) return extra;
      }
      throw Object.assign(new Error(kind === 'extract' ? '已有提链任务在运行' : '已有开通任务在运行'), { status: 409 });
    }
    const ids = parseJobIds(body);
    const targets = resolveOwnedTargets(userId, ids, requireIds, body.channel);

    const settings = readSettings(userId);
    let startBody = { ...(body || {}) };
    let maxConcurrency = Math.max(1, Number(settings.cloak.max_concurrency) || 3);
    let defaultConcurrency = 1;
    const runtimeOptions = {};
    let requireProxy = false;
    let skipCloak = false;
    let configuredProxies = null;
    let configuredNextProxy = null;
    if (typeof configure === 'function') {
      const extra = configure({ user, body: startBody, settings, targets }) || {};
      if (extra.body) startBody = extra.body;
      if (extra.maxConcurrency) maxConcurrency = Math.max(1, Number(extra.maxConcurrency));
      if (extra.defaultConcurrency) defaultConcurrency = Math.max(1, Number(extra.defaultConcurrency));
      if (extra.locale) runtimeOptions.locale = extra.locale;
      if (extra.timezone) runtimeOptions.timezone = extra.timezone;
      requireProxy = Boolean(extra.requireProxy);
      skipCloak = extra.skipCloak === true;
      if (typeof extra.nextProxy === 'function') configuredNextProxy = extra.nextProxy;
      if (Array.isArray(extra.proxies)) configuredProxies = extra.proxies;
    }
    const { automation } = require('./accountJob');
    const proxies = Array.isArray(configuredProxies) ? configuredProxies : [];
    if (requireProxy && !configuredNextProxy && !proxies.length) {
      throw Object.assign(new Error('动态代理 CliProxy 未配置或国家无效'), {
        status: 400,
        code: 'DYNAMIC_PROXY_NOT_CONFIGURED',
      });
    }
    let module = null;
    let runtime = null;
    if (!skipCloak) {
      const licenseKeys = cloakLicenseKeys(settings.cloak);
      if (!licenseKeys.length) throw Object.assign(new Error('请先配置 CloakBrowser 授权'), { status: 400 });
      module = await automation();
      runtime = new module.CloakRuntime({
        licenseKey: licenseKeys[0],
        licenseKeys,
        headless: settings.cloak.headless !== false,
        maxConcurrency,
        ...runtimeOptions,
      });
    }
    const emails = targets.map((id) => {
      const row = db.prepare('SELECT email FROM gpt_accounts WHERE user_id = ? AND id = ?').get(userId, id);
      return String(row?.email || '').toLowerCase();
    }).filter(Boolean);
    const run_id = crypto.randomUUID();
    const concurrency = jobConcurrency({
      requested: startBody.concurrency,
      defaultConcurrency,
      maxConcurrency,
      count: targets.length,
    });
    let cursor = 0;
    const nextProxy = configuredNextProxy
      || (() => (proxies.length ? proxies[(cursor++) % proxies.length] : null));
    const state = {
      ...emptyState(kind),
      running: true,
      target: targets.length,
      ids: [...targets],
      emails,
      run_id,
      message: `已启动 ${targets.length} 个账号`,
      runtime,
      module,
      queue: [...targets],
      nextProxy,
      concurrency,
      maxConcurrency,
      activeWorkers: 0,
      onFinish,
    };
    const hooks = { user, userId, runOne };
    state.hooks = hooks;
    jobs.set(userId, state);
    ensureWorkers(state, hooks);
    return { ok: true, kind, target: state.target, concurrency, run_id };
  }

  function stop(userId) {
    const state = jobs.get(userId);
    if (!state?.running) return { ok: true, message: '当前没有运行中的任务' };
    state.stop = true;
    state.message = '正在停止…';
    state.runtime?.closeAll?.().catch(() => {});
    return { ok: true, message: '已发送停止指令' };
  }

  function dropSettled(userId) {
    const state = jobs.get(userId);
    if (!state?.running) return { dropped: 0 };
    const {
      hasActivated, hasRefreshToken, hasGotRtRemark, PROGRESS, normalizeProgress,
    } = require('./accountProgress');
    let dropped = 0;
    for (const id of [...(state.ids || [])]) {
      const row = db.prepare('SELECT * FROM gpt_accounts WHERE user_id = ? AND id = ?').get(userId, id);
      if (!row) {
        releaseTarget(state, id, {});
        dropped += 1;
        continue;
      }
      const settled = hasActivated(row)
        || hasRefreshToken(row)
        || hasGotRtRemark(row)
        || normalizeProgress(row.progress) === PROGRESS.PAID;
      if (!settled) continue;
      releaseTarget(state, id, row);
      dropped += 1;
    }
    if (!(state.queue || []).length && !(state.ids || []).length) {
      if ((state.activeWorkers || 0) === 0) finish(state);
      else state.stop = true;
    }
    return { dropped };
  }

  return { start, stop, status, isLive, dropSettled };
}

module.exports = {
  createLiveJob,
  emptyState,
  parseJobIds,
  jobConcurrency,
  appendJobTargets,
};
