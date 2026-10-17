const username = process.env.SMOKE_USERNAME;
const password = process.env.SMOKE_PASSWORD;
if (!username || !password) {
  console.error('SMOKE_USERNAME/SMOKE_PASSWORD required');
  process.exit(1);
}

const BASE = 'http://127.0.0.1:8585';
const quantity = Number(process.env.SMOKE_QUANTITY || 3);
const concurrency = Number(process.env.SMOKE_CONCURRENCY || 1);
const redact = (value) => String(value || '').replace(/^(.{3}).*(@.*)$/, '$1***$2');

async function json(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.message || ('HTTP ' + response.status));
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

async function main() {
  const login = await json(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const headers = { Authorization: 'Bearer ' + login.token, 'Content-Type': 'application/json' };
  const options = await json(BASE + '/api/register/options', { headers });
  const status = await json(BASE + '/api/register/status', { headers });
  console.log(JSON.stringify({
    unused: options.unused_emails,
    cloak_max: options.cloak?.max_concurrency,
    default_proxy: options.default_proxy_group,
    running: status.running,
    quantity,
    concurrency,
  }));
  if (status.running) throw new Error('register already running');
  if (!options.unused_emails || options.unused_emails < quantity) throw new Error('not enough unused children');

  const started = await json(BASE + '/api/register/start', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      quantity,
      concurrency,
      mail_provider: 'mailcom',
      proxy_group: '__auto__:GB',
      set_password: true,
      enable_totp_2fa: true,
      get_refresh_token: false,
      register_mode: 'headless_click',
      performance_profile: 'safe',
      headless: true,
      humanize: true,
      attempts: 1,
      email_timeout_ms: 180000,
    }),
  });
  console.log(JSON.stringify({
    started: {
      run_id: started.run_id,
      target: started.target,
      concurrency: started.concurrency,
      unused: started.unused,
      warning: started.warning || '',
    },
  }));

  const deadline = Date.now() + 22 * 60 * 1000;
  let last = '';
  while (Date.now() < deadline) {
    const now = await json(BASE + '/api/register/status', { headers });
    const line = [now.running, now.success, now.failed, now.retried, now.message].join('|');
    if (line !== last) {
      last = line;
      console.log(JSON.stringify({
        t: new Date().toISOString(),
        running: now.running,
        success: now.success,
        failed: now.failed,
        retried: now.retried,
        message: String(now.message || '').replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (m) => redact(m)).slice(0, 200),
      }));
    }
    if (!now.running && now.finished) {
      const batch = await json(BASE + '/api/register/batches/' + started.run_id, { headers }).catch(() => null);
      const jobs = (batch?.jobs || batch?.results || []).map((job) => ({
        email: redact(job.email),
        status: job.status,
        progress: job.progress,
        error_code: job.error_code || '',
        error: String(job.error || '').slice(0, 180),
      }));
      console.log(JSON.stringify({ done: true, jobs }, null, 2));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  console.error('WATCH_TIMEOUT');
  process.exit(2);
}

main().catch((error) => {
  console.error(String(error.message || error).slice(0, 240));
  process.exit(1);
});
