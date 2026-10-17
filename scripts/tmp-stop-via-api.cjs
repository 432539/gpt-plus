const username = process.env.SMOKE_USERNAME;
const password = process.env.SMOKE_PASSWORD;
if (!username || !password) {
  console.error('SMOKE_USERNAME/SMOKE_PASSWORD required');
  process.exit(1);
}

async function main() {
  const login = await fetch('http://127.0.0.1:8585/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const loginBody = await login.json();
  if (!login.ok) {
    console.error('LOGIN_FAILED ' + login.status);
    process.exit(1);
  }
  const token = loginBody.token;
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  const status = await (await fetch('http://127.0.0.1:8585/api/register/status', { headers })).json();
  console.log(JSON.stringify({
    before: {
      running: status.running,
      run_id: status.run_id,
      success: status.success,
      failed: status.failed,
      retried: status.retried,
      message: String(status.message || '').slice(0, 160),
    },
  }));
  if (status.running) {
    const stop = await fetch('http://127.0.0.1:8585/api/register/stop', { method: 'POST', headers });
    const stopBody = await stop.json().catch(() => ({}));
    console.log(JSON.stringify({ stop_http: stop.status, stop_ok: stopBody.ok || stopBody.message || true }));
  }
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const now = await (await fetch('http://127.0.0.1:8585/api/register/status', { headers })).json();
    if (!now.running) {
      console.log(JSON.stringify({
        after: {
          running: now.running,
          finished: now.finished,
          message: String(now.message || '').slice(0, 160),
        },
      }));
      return;
    }
  }
  console.error('STOP_TIMEOUT');
  process.exit(2);
}

main().catch((error) => {
  console.error(String(error.message || error).slice(0, 200));
  process.exit(1);
});
