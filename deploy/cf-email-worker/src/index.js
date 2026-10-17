const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', ...extra },
});

function text(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeDomain(value) {
  return text(value).toLowerCase().replace(/^@/, '').replace(/\.+$/, '');
}

function parseDomainList(value) {
  const parts = Array.isArray(value)
    ? value.flatMap((item) => String(item || '').split(/[\s,;，；]+/))
    : String(value || '').split(/[\s,;，；]+/);
  const seen = new Set();
  const out = [];
  for (const part of parts) {
    const domain = normalizeDomain(part);
    if (!domain || seen.has(domain)) continue;
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(domain)) continue;
    seen.add(domain);
    out.push(domain);
  }
  return out;
}

function domainsFromEnv(env) {
  return parseDomainList(env.DOMAINS);
}

async function ensureSchema(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS managed_domains (
      domain TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    )`
  ).run();
}

async function extraDomains(env) {
  await ensureSchema(env);
  const rows = await env.DB.prepare('SELECT domain FROM managed_domains ORDER BY domain').all();
  return parseDomainList((rows.results || []).map((row) => row.domain));
}

async function listDomains(env) {
  return [...new Set([...domainsFromEnv(env), ...(await extraDomains(env))])];
}

function cookieToken(request) {
  const raw = request.headers.get('cookie') || '';
  const match = raw.match(/(?:^|;\s*)gpt_mail_admin=([^;]*)/);
  if (!match) return '';
  try {
    return decodeURIComponent(match[1] || '');
  } catch {
    return match[1] || '';
  }
}

function authorized(request, env) {
  const token = text(env.ADMIN_TOKEN);
  if (!token) return false;
  const header = text(request.headers.get('authorization'));
  const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  const key = text(request.headers.get('x-api-key') || request.headers.get('x-admin-auth'));
  return bearer === token || key === token || cookieToken(request) === token;
}

function authCookie(token, clear = false) {
  const value = clear ? '' : encodeURIComponent(token);
  const maxAge = clear ? 0 : 60 * 60 * 24 * 30;
  return `gpt_mail_admin=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function randomLocal() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return `otp${[...bytes].map((item) => item.toString(16).padStart(2, '0')).join('')}`;
}

async function dnsQuery(name, type) {
  try {
    const response = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`,
      { headers: { accept: 'application/dns-json' } },
    );
    const data = await response.json().catch(() => ({}));
    return Array.isArray(data.Answer) ? data.Answer : [];
  } catch {
    return [];
  }
}

function hostOf(value) {
  return String(value || '').trim().replace(/\.$/, '').toLowerCase();
}

function parseNs(answers) {
  return [...new Set(answers.map((row) => hostOf(row.data)).filter(Boolean))];
}

function parseMx(answers) {
  return answers.map((row) => {
    const raw = String(row.data || '').trim();
    const parts = raw.split(/\s+/);
    if (parts.length >= 2 && /^\d+$/.test(parts[0])) {
      return { priority: Number(parts[0]), host: hostOf(parts.slice(1).join(' ')) };
    }
    return { priority: Number(row.priority || row.Preference || 0) || 0, host: hostOf(raw) };
  }).filter((row) => row.host);
}

function verdictDns(ns, mx) {
  const nsOk = ns.length > 0 && ns.every((item) => item.endsWith('.ns.cloudflare.com') || item === 'ns.cloudflare.com');
  const mxHosts = mx.map((item) => item.host);
  const hasAliyun = mxHosts.some((item) => /aliyun|hichina|mxhichina/.test(item));
  const mxOk = mxHosts.length > 0 && mxHosts.every((item) => item.endsWith('.mx.cloudflare.net') || item.endsWith('.inbound.cloudflare.net'));
  return { nsOk, mxOk, hasAliyun };
}

async function publicNs(domain) {
  for (const name of zoneLookupNames(domain)) {
    const ns = parseNs(await dnsQuery(name, 'NS'));
    if (ns.length) return ns;
  }
  return [];
}

async function testDomainDns(domain) {
  const [ns, mxAnswers] = await Promise.all([
    publicNs(domain),
    dnsQuery(domain, 'MX'),
  ]);
  const mx = parseMx(mxAnswers);
  const { nsOk, mxOk, hasAliyun } = verdictDns(ns, mx);
  let message = '';
  if (!nsOk) {
    message = hasAliyun || !ns.length
      ? 'NS 还不是 Cloudflare。请到阿里云「域名 → DNS修改」改成 Cloudflare 提供的两台 NS，不要只在云解析里加 MX。'
      : 'NS 不是 Cloudflare 权威服务器。';
  } else if (!mxOk) {
    message = hasAliyun
      ? 'NS 已指向 Cloudflare，但 MX 仍是阿里云邮箱。到 Cloudflare Email Routing 开启收信，它会自动写 MX。'
      : 'MX 还没有指向 Cloudflare Email Routing（route1/2/3.mx.cloudflare.net）。';
  } else {
    message = 'NS 和 MX 已指向 Cloudflare，可以收信。';
  }
  return {
    domain,
    ok: nsOk && mxOk,
    ns_ok: nsOk,
    mx_ok: mxOk,
    ns,
    mx: mx.map((item) => item.host),
    message,
  };
}

async function cfApi(env, method, path, body) {
  const token = text(env.CF_API_TOKEN);
  if (!token) return { ok: false, skipped: true, data: {} };
  try {
    const headers = { authorization: `Bearer ${token}` };
    const init = { method, headers };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, init);
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok && data.success !== false, skipped: false, data };
  } catch (error) {
    return {
      ok: false,
      skipped: false,
      data: { errors: [{ message: error && error.message ? String(error.message) : 'Cloudflare API 请求失败' }] },
    };
  }
}

function cfError(result) {
  const errors = Array.isArray(result?.data?.errors) ? result.data.errors : [];
  const messages = errors.map((item) => item && item.message).filter(Boolean);
  if (messages.length) return messages.join('; ');
  const extra = Array.isArray(result?.data?.messages) ? result.data.messages : [];
  return extra.map((item) => (typeof item === 'string' ? item : item && item.message)).filter(Boolean).join('; ');
}

function routingAlreadyOk(result) {
  return /already|enabled|exist|ready|duplicate/i.test(cfError(result));
}

function pendingNsResult(nameServers, extra = '') {
  const nsText = nameServers.length
    ? `站点已在 Cloudflare，NS 尚未生效。阿里云「域名 → DNS修改」改成：${nameServers.join(' 和 ')}`
    : '站点已在 Cloudflare，请到阿里云把 DNS 服务器改成 Cloudflare 提供的两台 NS。';
  return {
    routing: 'pending_ns',
    name_servers: nameServers,
    message: extra ? `${extra} ${nsText}` : nsText,
  };
}

function zoneLookupNames(domain) {
  const labels = String(domain || '').split('.').filter(Boolean);
  const names = [];
  for (let i = 0; i < labels.length - 1; i += 1) names.push(labels.slice(i).join('.'));
  return names;
}

async function findZone(env, domain) {
  const accountId = text(env.CF_ACCOUNT_ID);
  for (const name of zoneLookupNames(domain)) {
    const query = new URLSearchParams({ name });
    if (accountId) query.set('account.id', accountId);
    const lookup = await cfApi(env, 'GET', `/zones?${query.toString()}`);
    if (lookup.skipped) return { skipped: true, zone: null };
    const list = Array.isArray(lookup.data?.result) ? lookup.data.result : [];
    const zone = list.find((item) => normalizeDomain(item && item.name) === name) || list[0];
    if (zone && zone.id) return { skipped: false, zone };
  }
  return { skipped: false, zone: null };
}

async function enableEmailRouting(env, zone, domain) {
  const zoneName = normalizeDomain(zone.name);
  const isSubdomain = domain !== zoneName;
  if (isSubdomain) {
    const dns = await cfApi(env, 'POST', `/zones/${zone.id}/email/routing/dns`, { name: domain });
    if (dns.ok || routingAlreadyOk(dns)) return { ok: true, message: '' };
    return { ok: false, message: cfError(dns) || '子域开启 Email Routing 失败' };
  }
  const enable = await cfApi(env, 'POST', `/zones/${zone.id}/email/routing/enable`);
  if (enable.ok || routingAlreadyOk(enable)) return { ok: true, message: '' };
  const dns = await cfApi(env, 'POST', `/zones/${zone.id}/email/routing/dns`, { name: domain });
  if (dns.ok || routingAlreadyOk(dns)) return { ok: true, message: '' };
  return { ok: false, message: cfError(enable) || cfError(dns) || '开启 Email Routing 失败' };
}

async function ensureCatchAll(env, domain) {
  const workerName = text(env.WORKER_NAME) || 'gpt-plus-mail';
  const found = await findZone(env, domain);
  if (found.skipped) {
    return {
      routing: 'manual',
      name_servers: [],
      message: '域名已加入列表。请确认 Cloudflare Email Routing 的 Catch-all 转到 Worker gpt-plus-mail。',
    };
  }
  const zone = found.zone;
  if (!zone) {
    return {
      routing: 'missing_zone',
      name_servers: [],
      message: 'Cloudflare 账号里还没有这个站点。先添加站点，复制两台 NS，再到阿里云改 DNS 服务器。',
    };
  }
  const nameServers = Array.isArray(zone.name_servers) ? zone.name_servers.map(hostOf) : [];
  if (zone.paused || (zone.status && zone.status !== 'active')) {
    return pendingNsResult(nameServers);
  }
  const enabled = await enableEmailRouting(env, zone, domain);
  if (!enabled.ok) {
    if (/not active|pending|inactive|uninitialized|paused/i.test(enabled.message)) {
      return pendingNsResult(nameServers, enabled.message);
    }
    return {
      routing: 'error',
      name_servers: nameServers,
      message: enabled.message,
    };
  }
  const catchAll = await cfApi(env, 'PUT', `/zones/${zone.id}/email/routing/rules/catch_all`, {
    name: 'Send to gpt-plus-mail worker',
    enabled: true,
    matchers: [{ type: 'all' }],
    actions: [{ type: 'worker', value: [workerName] }],
  });
  if (!catchAll.ok) {
    return {
      routing: 'error',
      name_servers: nameServers,
      message: cfError(catchAll) || 'Catch-all 未能转到 gpt-plus-mail',
    };
  }
  const zoneName = normalizeDomain(zone.name);
  return {
    routing: 'ok',
    name_servers: nameServers,
    message: domain === zoneName
      ? 'Email Routing Catch-all 已指向 gpt-plus-mail'
      : '子域已开通 Email Routing（MX），Catch-all 已指向 gpt-plus-mail',
  };
}

async function saveDomains(env, domains) {
  await ensureSchema(env);
  for (const domain of domains) {
    await env.DB.prepare(
      'INSERT OR IGNORE INTO managed_domains (domain, created_at) VALUES (?, ?)',
    ).bind(domain, Date.now()).run();
  }
}

async function inspectDomains(env, domains, { enable = false } = {}) {
  const results = [];
  for (const domain of domains) {
    try {
      const dns = await testDomainDns(domain);
      const routing = enable ? await ensureCatchAll(env, domain) : { routing: 'skipped', name_servers: [], message: '' };
      const zoneNs = routing.name_servers || [];
      const zoneNsOk = zoneNs.length > 0 && zoneNs.every((item) => item.endsWith('.ns.cloudflare.com') || item === 'ns.cloudflare.com');
      const nsOk = dns.ns_ok || zoneNsOk;
      const ok = nsOk && dns.mx_ok && (routing.routing === 'ok' || routing.routing === 'manual' || routing.routing === 'skipped');
      results.push({
        ...dns,
        ok,
        ns_ok: nsOk,
        ns: zoneNs.length ? zoneNs : dns.ns,
        routing: routing.routing || '',
        name_servers: zoneNs.length ? zoneNs : (dns.ns || []),
        message: [dns.message, routing.message].filter(Boolean).join(' '),
      });
    } catch (error) {
      results.push({
        domain,
        ok: false,
        ns_ok: false,
        mx_ok: false,
        ns: [],
        mx: [],
        routing: 'error',
        name_servers: [],
        message: error && error.message ? String(error.message) : '检测失败',
      });
    }
  }
  return results;
}

function adminPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>GPT-Plus 邮箱管理</title>
  <style>
    :root { --bg:#f4f6f8; --card:#fff; --line:#e6e8eb; --ink:#1f2328; --muted:#6b7280; --accent:#1f4ed8; --bad:#b42318; --ok:#0f7b3a; --warn:#9a6700; }
    * { box-sizing: border-box; }
    body { margin:0; font-family: ui-sans-serif, system-ui, Segoe UI, sans-serif; background:var(--bg); color:var(--ink); }
    .wrap { max-width: 1080px; margin: 0 auto; padding: 28px 18px 60px; }
    h1 { font-size: 22px; margin: 0 0 6px; }
    p.sub { margin: 0 0 22px; color: var(--muted); font-size: 13px; }
    .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 18px; margin-bottom: 16px; }
    label { display:block; font-size: 12px; color: var(--muted); margin-bottom: 6px; }
    input, select, textarea, button { font: inherit; }
    input, select, textarea { width: 100%; padding: 9px 10px; border: 1px solid var(--line); border-radius: 8px; background: #fff; }
    textarea { min-height: 96px; resize: vertical; }
    button { border: 0; border-radius: 8px; padding: 9px 14px; background: var(--accent); color: #fff; cursor: pointer; }
    button.ghost { background: #eef1f6; color: var(--ink); }
    button.danger { background: #fff; color: var(--bad); border: 1px solid #f0c7c3; }
    .row { display:flex; gap: 10px; align-items: end; flex-wrap: wrap; }
    .row > * { flex: 1; min-width: 180px; }
    .row button { flex: 0 0 auto; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--line); vertical-align: top; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .muted { color: var(--muted); }
    .err { color: var(--bad); font-size: 13px; margin-top: 8px; }
    .ok { color: var(--ok); font-size: 13px; margin-top: 8px; }
    .mail { white-space: pre-wrap; word-break: break-word; background: #f7f8fa; border-radius: 8px; padding: 12px; font-size: 12px; max-height: 360px; overflow: auto; }
    .suffix-list { display:flex; flex-wrap:wrap; gap:8px; list-style:none; padding:0; margin:8px 0 0; }
    .suffix-list li { background:#eef1f6; padding:6px 10px; border-radius:8px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
    .hidden { display: none; }
    .top { display:flex; justify-content: space-between; gap: 12px; align-items: center; }
    .guide { background:#f7f8fa; border-radius:10px; padding:12px 14px; font-size:13px; line-height:1.65; color:var(--ink); }
    .guide ol { margin: 8px 0 0; padding-left: 18px; }
    .guide code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; background:#eef1f6; padding:1px 5px; border-radius:4px; }
    .pill { display:inline-block; font-size:11px; padding:2px 7px; border-radius:999px; margin-left:6px; }
    .pill.ok { background:#e7f6ec; color:var(--ok); }
    .pill.bad { background:#fdecea; color:var(--bad); }
    .pill.warn { background:#fff7e6; color:var(--warn); }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div>
        <h1>GPT-Plus 邮箱管理</h1>
        <p class="sub">查看 CF 收信域名、批量加入新域名、检测阿里云解析、创建测试邮箱。注册任务仍由控制台自动取码。</p>
      </div>
      <button class="ghost hidden" id="logoutBtn" type="button">退出</button>
    </div>

    <div class="card" id="loginCard">
      <label>管理令牌</label>
      <div class="row">
        <div><input id="token" type="password" autocomplete="current-password" placeholder="部署时写入设置的 CF Worker API Key" /></div>
        <button type="button" id="loginBtn">登录</button>
      </div>
      <p class="muted" style="margin:10px 0 0">令牌保存在 GPT-Plus 个人设置 → 注册供应商 → CF Worker 域名邮箱。页面不会回显已保存的密钥。</p>
      <p class="err hidden" id="loginErr"></p>
    </div>

    <div id="app" class="hidden">
      <div class="card">
        <label>阿里云域名怎么解析才会进这套邮箱</label>
        <div class="guide">
          Email Routing 要求域名的 <b>DNS 服务器改成 Cloudflare</b>。只在阿里云「云解析 DNS」里加 MX 是不够的，邮件进不了 Worker。
          <ol>
            <li>在 <b>同一个 Cloudflare 账号</b>里添加站点。</li>
            <li>打开该站点「概述」，复制两台 DNS 服务器，形如 <code>xxx.ns.cloudflare.com</code>。</li>
            <li>登录阿里云 → <b>域名</b> → 域名列表 → 管理 → <b>DNS 修改</b>（不要去云解析里改 MX）。</li>
            <li>把 DNS 服务器改成刚才那两台并保存。原阿里云解析记录会停用，网站 A/CNAME 要改到 Cloudflare DNS 里。</li>
            <li>等生效（通常几分钟，最长 48 小时）。本页点「测试解析」：NS 应是 <code>*.ns.cloudflare.com</code>，MX 应是 <code>route1/2/3.mx.cloudflare.net</code>。</li>
            <li>测试通过后，域名会出现在可用后缀里。还要在 GPT-Plus 个人设置 → 邮箱域名 勾上并保存，注册才会用它。</li>
          </ol>
        </div>
      </div>
      <div class="card">
        <label>批量添加域名</label>
        <textarea id="bulkDomains" placeholder="每行一个，也可用逗号/空格分隔&#10;mail.example.com"></textarea>
        <div class="row" style="margin-top:10px">
          <button type="button" id="addDomainsBtn">添加并检测</button>
          <button class="ghost" type="button" id="testDomainsBtn">测试解析</button>
        </div>
        <p class="muted" style="margin:10px 0 0">添加后会写入本面板可用列表，并尽量打开 Cloudflare Email Routing（Catch-all → gpt-plus-mail）。解析未切到 Cloudflare 时会给出要填的 NS。</p>
        <p class="err hidden" id="domainMsg"></p>
        <div id="domainResults" style="margin-top:12px"></div>
      </div>
      <div class="card">
        <label>可用邮箱后缀</label>
        <p class="muted" id="suffixCount" style="margin: 4px 0 0">加载中…</p>
        <ul class="suffix-list" id="suffixList"></ul>
      </div>
      <div class="card">
        <div class="row">
          <div>
            <label>收信域名</label>
            <select id="domain"></select>
          </div>
          <button type="button" id="createBtn">创建邮箱</button>
          <button class="ghost" type="button" id="refreshBtn">刷新</button>
        </div>
        <p class="ok hidden" id="created"></p>
      </div>
      <div class="card">
        <label>已创建邮箱</label>
        <div id="addresses" class="muted">加载中…</div>
      </div>
      <div class="card">
        <div class="row">
          <div>
            <label>查看收件箱</label>
            <input id="look" placeholder="完整邮箱地址" />
          </div>
          <button type="button" id="openBtn">打开</button>
        </div>
        <div id="mails" style="margin-top:12px" class="muted">选择一个邮箱后显示最近邮件。</div>
      </div>
    </div>
  </div>
  <script>
    const $ = (id) => document.getElementById(id);
    const headers = { 'content-type': 'application/json' };
    async function api(path, options = {}) {
      const res = await fetch(path, { credentials: 'same-origin', ...options, headers: { ...headers, ...(options.headers || {}) } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || data.error || ('HTTP ' + res.status));
      return data;
    }
    function showLogin(err) {
      $('loginCard').classList.remove('hidden');
      $('app').classList.add('hidden');
      $('logoutBtn').classList.add('hidden');
      $('loginErr').classList.toggle('hidden', !err);
      $('loginErr').textContent = err || '';
    }
    function fmt(ts) {
      if (!ts) return '';
      const d = new Date(Number(ts));
      return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
    }
    function escapeHtml(value) {
      return String(value || '').replace(/[&<>"']/g, (ch) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
    }
    function pill(ok, label) {
      return '<span class="pill ' + (ok ? 'ok' : 'bad') + '">' + escapeHtml(label) + '</span>';
    }
    function renderDomainResults(results) {
      const rows = results || [];
      if (!rows.length) { $('domainResults').innerHTML = ''; return; }
      $('domainResults').innerHTML = '<table><thead><tr><th>域名</th><th>NS</th><th>MX</th><th>说明</th></tr></thead><tbody>'
        + rows.map((row) => {
          const ns = (row.name_servers && row.name_servers.length ? row.name_servers : row.ns) || [];
          return '<tr><td class="mono">' + escapeHtml(row.domain) + pill(row.ok, row.ok ? '通过' : '未就绪') + '</td>'
            + '<td>' + pill(row.ns_ok, row.ns_ok ? 'Cloudflare' : '未切') + '<div class="muted mono">' + ns.map(escapeHtml).join('<br>') + '</div></td>'
            + '<td>' + pill(row.mx_ok, row.mx_ok ? 'Email Routing' : '不对') + '</td>'
            + '<td>' + escapeHtml(row.message || '') + '</td></tr>';
        }).join('')
        + '</tbody></table>';
    }
    async function loadMails(address) {
      $('look').value = address;
      const data = await api('/admin/mails?address=' + encodeURIComponent(address) + '&limit=30');
      const rows = data.results || [];
      if (!rows.length) {
        $('mails').innerHTML = '<span class="muted">暂无邮件。给这个地址发一封信后再刷新。</span>';
        return;
      }
      $('mails').innerHTML = rows.map((row) => {
        const body = row.content || row.raw || row.html || '';
        return '<div style="margin:0 0 14px"><b>' + escapeHtml(row.subject || '(无主题)') + '</b>'
          + '<div class="muted">' + escapeHtml(row.from || '') + '</div>'
          + '<div class="mail">' + escapeHtml(body.slice(0, 8000)) + '</div></div>';
      }).join('');
    }
    async function refresh() {
      const [cfg, list] = await Promise.all([api('/api/config'), api('/admin/addresses')]);
      const domains = cfg.emailDomains || cfg.domains || [];
      $('domain').innerHTML = domains.map((d) => '<option value="'+escapeHtml(d)+'">'+escapeHtml(d)+'</option>').join('');
      $('suffixCount').textContent = '共 ' + domains.length + ' 个可用后缀';
      $('suffixList').innerHTML = domains.length
        ? domains.map((d) => '<li>' + escapeHtml(d) + '</li>').join('')
        : '<li class="muted">暂无域名</li>';
      const items = list.items || [];
      if (!items.length) {
        $('addresses').innerHTML = '<span class="muted">还没有创建过邮箱。</span>';
        return;
      }
      $('addresses').innerHTML = '<table><thead><tr><th>邮箱</th><th>域名</th><th>创建时间</th></tr></thead><tbody>'
        + items.map((row) => '<tr><td class="mono"><a href="#" data-addr="'+escapeHtml(row.address)+'">'+escapeHtml(row.address)+'</a></td><td>'+escapeHtml(row.domain)+'</td><td class="muted">'+escapeHtml(fmt(row.created_at))+'</td></tr>').join('')
        + '</tbody></table>';
      $('addresses').querySelectorAll('a[data-addr]').forEach((el) => {
        el.addEventListener('click', (ev) => { ev.preventDefault(); loadMails(el.dataset.addr).catch((e) => { $('mails').textContent = e.message; }); });
      });
    }
    async function boot() {
      try {
        await api('/admin/session');
        $('loginCard').classList.add('hidden');
        $('app').classList.remove('hidden');
        $('logoutBtn').classList.remove('hidden');
        await refresh();
      } catch {
        showLogin();
      }
    }
    $('loginBtn').onclick = async () => {
      try {
        await api('/admin/login', { method: 'POST', body: JSON.stringify({ token: $('token').value }) });
        $('token').value = '';
        await boot();
      } catch (e) { showLogin(e.message === 'unauthorized' ? '令牌不正确' : e.message); }
    };
    $('logoutBtn').onclick = async () => { await api('/admin/logout', { method: 'POST' }); showLogin(); };
    $('createBtn').onclick = async () => {
      const data = await api('/admin/new_address', { method: 'POST', body: JSON.stringify({ domain: $('domain').value }) });
      $('created').classList.remove('hidden');
      $('created').textContent = '已创建 ' + data.email;
      await refresh();
      await loadMails(data.email);
    };
    $('refreshBtn').onclick = () => refresh();
    $('openBtn').onclick = () => loadMails($('look').value.trim());
    $('addDomainsBtn').onclick = async () => {
      $('domainMsg').classList.add('hidden');
      try {
        const data = await api('/admin/domains', { method: 'POST', body: JSON.stringify({ text: $('bulkDomains').value, test: true }) });
        $('bulkDomains').value = '';
        renderDomainResults(data.results || []);
        await refresh();
      } catch (e) {
        $('domainMsg').classList.remove('hidden');
        $('domainMsg').className = 'err';
        $('domainMsg').textContent = e.message;
      }
    };
    $('testDomainsBtn').onclick = async () => {
      $('domainMsg').classList.add('hidden');
      try {
        const typed = $('bulkDomains').value.trim();
        const data = await api('/admin/domains/test', {
          method: 'POST',
          body: JSON.stringify(typed ? { text: typed } : {}),
        });
        renderDomainResults(data.results || []);
      } catch (e) {
        $('domainMsg').classList.remove('hidden');
        $('domainMsg').className = 'err';
        $('domainMsg').textContent = e.message;
      }
    };
    boot();
  </script>
</body>
</html>`;
}

export default {
  async email(message, env) {
    const to = text(message.to).toLowerCase();
    const from = text(message.from);
    const subject = text(message.headers?.get?.('subject'));
    let raw = '';
    try {
      raw = await new Response(message.raw).text();
    } catch {
      raw = '';
    }
    await env.DB.prepare(
      `INSERT INTO mails (address, to_addr, from_addr, subject, content, html, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(to, to, from, subject, raw.slice(0, 200000), '', Date.now()).run();
  },

  async fetch(request, env) {
    try {
      return await routeRequest(request, env);
    } catch (error) {
      return json({ ok: false, message: String(error && error.message ? error.message : error).slice(0, 300) }, 500);
    }
  },
};

async function routeRequest(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204 });
    }
    if ((url.pathname === '/' || url.pathname === '/admin' || url.pathname === '/index.html') && request.method === 'GET') {
      return new Response(adminPage(), {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
    if (url.pathname === '/api/config' && request.method === 'GET') {
      const domains = await listDomains(env);
      return json({ emailDomains: domains, domains });
    }
    if (url.pathname === '/admin/login' && request.method === 'POST') {
      let body = {};
      try { body = await request.json(); } catch { body = {}; }
      const token = text(body.token || body.api_key);
      if (!text(env.ADMIN_TOKEN) || token !== text(env.ADMIN_TOKEN)) {
        return json({ message: 'unauthorized' }, 401);
      }
      return json({ ok: true }, 200, { 'set-cookie': authCookie(token) });
    }
    if (url.pathname === '/admin/logout' && request.method === 'POST') {
      return json({ ok: true }, 200, { 'set-cookie': authCookie('', true) });
    }
    if (!authorized(request, env)) {
      return json({ message: 'unauthorized' }, 401);
    }
    if (url.pathname === '/admin/session' && request.method === 'GET') {
      return json({ ok: true });
    }
    if (url.pathname === '/admin/addresses' && request.method === 'GET') {
      const rows = await env.DB.prepare(
        'SELECT address, domain, created_at FROM addresses ORDER BY created_at DESC LIMIT 100'
      ).all();
      return json({ items: rows.results || [] });
    }
    if (url.pathname === '/admin/domains' && request.method === 'POST') {
      let body = {};
      try { body = await request.json(); } catch { body = {}; }
      const incoming = parseDomainList(body.domains || body.text || body.domain);
      if (!incoming.length) return json({ message: '请填写至少一个域名' }, 400);
      try {
        await saveDomains(env, incoming);
      } catch (error) {
        return json({ message: error && error.message ? String(error.message) : '写入域名失败' }, 500);
      }
      const results = await inspectDomains(env, incoming, { enable: true });
      let domains = incoming;
      try { domains = await listDomains(env); } catch { /* keep incoming */ }
      const failed = results.some((row) => row.routing === 'error');
      return json({ ok: !failed, results, domains, message: failed ? (results.find((row) => row.routing === 'error') || {}).message : '' });
    }
    if (url.pathname === '/admin/domains/test' && request.method === 'POST') {
      let body = {};
      try { body = await request.json(); } catch { body = {}; }
      const incoming = parseDomainList(body.domains || body.text || body.domain);
      const targets = incoming.length ? incoming : await listDomains(env);
      const results = await inspectDomains(env, targets, { enable: false });
      return json({ ok: true, results });
    }
    if (url.pathname === '/admin/domains/delete' && request.method === 'POST') {
      let body = {};
      try { body = await request.json(); } catch { body = {}; }
      const domain = normalizeDomain(body.domain);
      if (!domain) return json({ message: '缺少域名' }, 400);
      if (domainsFromEnv(env).includes(domain)) {
        return json({ message: '内置域名不能从这里删除' }, 400);
      }
      await ensureSchema(env);
      await env.DB.prepare('DELETE FROM managed_domains WHERE domain = ?').bind(domain).run();
      return json({ ok: true, domains: await listDomains(env) });
    }
    if (url.pathname === '/admin/new_address' && request.method === 'POST') {
      let body = {};
      try { body = await request.json(); } catch { body = {}; }
      const allowed = await listDomains(env);
      const requested = normalizeDomain(body.domain);
      const domain = allowed.includes(requested) ? requested : allowed[0];
      if (!domain) return json({ message: 'no domain configured' }, 400);
      const email = `${randomLocal()}@${domain}`;
      await env.DB.prepare(
        'INSERT OR REPLACE INTO addresses (address, domain, created_at) VALUES (?, ?, ?)'
      ).bind(email, domain, Date.now()).run();
      return json({ email, address: email });
    }
    if (url.pathname === '/admin/mails' && request.method === 'GET') {
      const address = text(url.searchParams.get('address')).toLowerCase();
      const limit = Math.max(1, Math.min(50, Number(url.searchParams.get('limit')) || 20));
      const sql = address
        ? `SELECT subject, content, html, from_addr, created_at FROM mails WHERE address = ? OR to_addr = ? ORDER BY created_at DESC LIMIT ?`
        : `SELECT subject, content, html, from_addr, address, created_at FROM mails ORDER BY created_at DESC LIMIT ?`;
      const rows = address
        ? await env.DB.prepare(sql).bind(address, address, limit).all()
        : await env.DB.prepare(sql).bind(limit).all();
      return json({
        results: (rows.results || []).map((row) => ({
          subject: row.subject || '',
          content: row.content || '',
          raw: row.content || '',
          html: row.html || '',
          from: row.from_addr || '',
          address: row.address || address,
        })),
      });
    }
    return json({ message: 'not found' }, 404);
}
