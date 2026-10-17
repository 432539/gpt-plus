'use strict';

const path = require('path');
module.paths.unshift(path.join(__dirname, '..', 'server', 'node_modules'));
const { chromium } = require('playwright-core');

const BASE = 'http://localhost:5173';
const SESSION = 'http://127.0.0.1:18765/session';

function pick(text, re) {
  return re.test(String(text || ''));
}

async function main() {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--disable-dev-shm-usage', '--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const puts = [];
  page.on('request', (req) => {
    if (req.method() === 'PUT' || req.method() === 'POST' || req.method() === 'GET') {
      const url = req.url();
      if (/\/api\/(settings|accounts)/.test(url)) {
        puts.push({ method: req.method(), path: new URL(url).pathname });
      }
    }
  });

  const report = { ok: true, steps: [], fixes: [], login: 'jwt-local' };

  try {
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const injected = await page.evaluate(async (sessionUrl) => {
      const res = await fetch(sessionUrl);
      if (!res.ok) return { ok: false, status: res.status };
      const data = await res.json();
      if (!data.token || !data.user) return { ok: false, status: 'missing-session' };
      localStorage.setItem('gp_token', data.token);
      localStorage.setItem('gp_user', JSON.stringify(data.user));
      return { ok: true, username: data.user.username };
    }, SESSION);
    if (!injected.ok) {
      report.ok = false;
      report.login = `session-inject-failed:${injected.status}`;
      report.steps.push('登录：本地 JWT 注入失败');
      console.log(JSON.stringify(report, null, 2));
      await browser.close();
      process.exit(1);
    }
    report.login = `jwt-local user=${injected.username}`;

    await page.goto(`${BASE}/accounts`, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForSelector('.channel-banner', { timeout: 15000 });
    const gbBanner = await page.locator('.channel-banner').innerText();
    const gbTitle = await page.locator('.topbar__title').innerText();
    const gbActive = await page.locator('a.nav__item', { hasText: '账号管理(GB)' }).getAttribute('class');
    const gcActiveOnGb = await page.locator('a.nav__item', { hasText: '账号管理(GC)' }).getAttribute('class');
    if (!pick(gbBanner, /GB · PayPal/) || gbTitle !== '账号管理(GB)') {
      report.ok = false;
      report.steps.push(`GB 页文案不对：title=${gbTitle} banner=${gbBanner.slice(0, 80)}`);
    } else {
      report.steps.push('侧栏进入 /accounts，标题与 banner 为 GB PayPal');
    }
    if (!/router-link-active/.test(gbActive || '') || /router-link-active/.test(gcActiveOnGb || '')) {
      report.ok = false;
      report.fixes.push('侧栏高亮串页');
      report.steps.push('GB 页侧栏高亮错误');
    } else {
      report.steps.push('GB 菜单高亮，GC 未误亮');
    }

    const gbReg = await page.getByRole('button', { name: '开始注册', exact: true }).count();
    if (!gbReg) {
      report.ok = false;
      report.steps.push('GB 缺少「开始注册」按钮');
    }

    const beforePuts = puts.length;
    const payToggle = page.locator('.pipe-toggle', { hasText: '支付' }).first();
    const payOn = await payToggle.getAttribute('class');
    await payToggle.click();
    await page.waitForTimeout(800);
    await payToggle.click();
    await page.waitForTimeout(800);
    const pipelinePuts = puts.slice(beforePuts).filter((item) => item.method === 'PUT');
    const gbWroteGc = pipelinePuts.some((item) => item.path.includes('pipeline-gc'));
    const gbWroteGb = pipelinePuts.some((item) => item.path === '/api/settings/pipeline');
    if (gbWroteGc) {
      report.ok = false;
      report.fixes.push('GB 开关误写 pipeline_gc');
      report.steps.push('GB 流水线开关写错通道');
    } else if (!gbWroteGb) {
      report.ok = false;
      report.steps.push(`GB 流水线开关未打到 /settings/pipeline（on=${payOn} puts=${JSON.stringify(pipelinePuts)}）`);
    } else {
      report.steps.push('GB 流水线开关 PUT /api/settings/pipeline，并已拨回');
    }

    await page.locator('a.nav__item', { hasText: '账号管理(GC)' }).click();
    await page.waitForURL(/\/accounts-gc/, { timeout: 15000 });
    await page.waitForSelector('.channel-banner-gc', { timeout: 15000 });
    const gcBanner = await page.locator('.channel-banner').innerText();
    const gcTitle = await page.locator('.topbar__title').innerText();
    if (!pick(gcBanner, /GC · GCash/) || gcTitle !== '账号管理(GC)') {
      report.ok = false;
      report.steps.push(`GC 页文案不对：title=${gcTitle} banner=${gcBanner.slice(0, 80)}`);
    } else {
      report.steps.push('侧栏进入 /accounts-gc，标题与 banner 为 GC GCash');
    }

    const gcReg = await page.getByRole('button', { name: '开始注册(GC)' }).count();
    if (!gcReg) {
      report.ok = false;
      report.steps.push('GC 缺少「开始注册(GC)」');
    }

    const fixture = page.locator('tr', { hasText: 'gc-click-fixture@example.invalid' }).first();
    await fixture.waitFor({ timeout: 15000 });
    const extracted = fixture.getByRole('button', { name: '已提链', exact: true });
    await extracted.click();
    await page.waitForSelector('.gcash-wall', { timeout: 10000 });
    const wallText = await page.locator('.gcash-wall').innerText();
    const hasQr = await page.locator('.gcash-qr').count();
    const hasOpen = await page.getByRole('button', { name: '打开 GCash 链接' }).count();
    const hasCopy = await page.getByRole('button', { name: '复制链接' }).count();
    if (!hasQr && !/没有二维码|打开或复制链接|请先出码/.test(wallText)) {
      report.ok = false;
      report.fixes.push('支付墙空白');
      report.steps.push('已提链打开支付墙但内容空白');
    } else {
      report.steps.push(`已提链打开支付墙 qr=${hasQr} open=${hasOpen} copy=${hasCopy}`);
    }
    if (/paypal|extract_link/i.test(wallText)) {
      report.ok = false;
      report.fixes.push('GC 支付墙露出 PayPal extract_link');
    }
    await page.locator('.modal-footer .btn-ghost', { hasText: '取消' }).click();
    await page.waitForTimeout(400);

    await fixture.getByRole('button', { name: '支付墙' }).click();
    await page.waitForSelector('.gcash-wall', { timeout: 10000 });
    report.steps.push('行内「支付墙」再次打开弹层');
    await page.locator('.modal-footer .btn-ghost', { hasText: '取消' }).click();

    await page.getByRole('button', { name: '开始注册(GC)' }).click();
    await page.waitForSelector('.modal, .dialog, [class*="modal"]', { timeout: 8000 }).catch(() => {});
    const regTitle = await page.locator('h2, .modal-title, .dialog-title').first().innerText().catch(() => '');
    const bodyText = await page.locator('body').innerText();
    if (!/批量注册\(GC/.test(bodyText) && !/GC \/ PH/.test(regTitle + bodyText)) {
      report.ok = false;
      report.steps.push(`注册弹层文案不对：${(regTitle || bodyText).slice(0, 80)}`);
    } else {
      report.steps.push('打开「开始注册(GC)」弹层，代理锁 PH');
    }
    if (!/__auto__:PH|PH 菲律宾/.test(bodyText)) {
      report.ok = false;
      report.steps.push('GC 注册弹层未锁定 PH 代理');
    }
    const closeReg = page.getByRole('button', { name: '取消' }).or(page.getByRole('button', { name: '关闭' })).first();
    if (await closeReg.count()) await closeReg.click();
    await page.waitForTimeout(300);

    await page.getByRole('button', { name: '批量操作' }).click();
    const detectItem = page.getByRole('button', { name: /检测.*GCash/ });
    const extractItem = page.getByRole('button', { name: /出码/ });
    const payItem = page.getByRole('button', { name: /支付墙/ });
    const rtItem = page.getByRole('button', { name: /拿 RT\(PH\)/ });
    if (!(await detectItem.count()) || !(await extractItem.count()) || !(await payItem.count()) || !(await rtItem.count())) {
      report.ok = false;
      report.steps.push('批量操作缺少 GC 入口');
    } else {
      report.steps.push('批量操作可见：检测 GCash / 出码 / 支付墙 / 拿 RT(PH)');
    }
    await detectItem.click();
    await page.waitForTimeout(500);
    const opText = await page.locator('body').innerText();
    if (!/检测 GCash 资格/.test(opText)) {
      report.ok = false;
      report.steps.push('检测弹层标题未随 channel 变化');
    } else {
      report.steps.push('打开「检测 GCash 资格」弹层');
    }
    const closeOp = page.getByRole('button', { name: '取消' }).or(page.getByRole('button', { name: '关闭' })).first();
    if (await closeOp.count()) await closeOp.click();

    const beforeGc = puts.length;
    const gcPayToggle = page.locator('.pipe-toggle', { hasText: '支付墙' }).first();
    await gcPayToggle.click();
    await page.waitForTimeout(800);
    await gcPayToggle.click();
    await page.waitForTimeout(800);
    const gcPuts = puts.slice(beforeGc).filter((item) => item.method === 'PUT');
    const gcWroteGb = gcPuts.some((item) => item.path === '/api/settings/pipeline' && !item.path.includes('pipeline-gc'));
    const gcWroteGc = gcPuts.some((item) => item.path.includes('pipeline-gc'));
    if (gcWroteGb && !gcWroteGc) {
      report.ok = false;
      report.fixes.push('GC 开关误写 pipeline');
      report.steps.push('GC 流水线开关写到了 GB pipeline');
    } else if (!gcWroteGc) {
      report.ok = false;
      report.steps.push(`GC 流水线开关未打到 /settings/pipeline-gc puts=${JSON.stringify(gcPuts)}`);
    } else {
      report.steps.push('GC 流水线开关 PUT /api/settings/pipeline-gc，并已拨回');
    }

    await page.locator('a.nav__item', { hasText: '账号管理(GB)' }).click();
    await page.waitForURL(/\/accounts$/, { timeout: 15000 });
    const gbHasFixture = await page.locator('td', { hasText: 'gc-click-fixture@example.invalid' }).count();
    if (gbHasFixture) {
      report.ok = false;
      report.fixes.push('GB 列表混入 GC fixture');
      report.steps.push('回到 GB 列表仍看到 GC fixture');
    } else {
      report.steps.push('回到 GB 列表看不到 GC fixture');
    }
  } catch (error) {
    report.ok = false;
    report.steps.push(`异常：${error.message}`);
  } finally {
    await browser.close();
  }

  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

main().catch((error) => {
  console.log(JSON.stringify({ ok: false, login: 'script-error', steps: [error.message] }, null, 2));
  process.exit(1);
});
