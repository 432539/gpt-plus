const test = require('node:test');
const assert = require('node:assert/strict');
const {
  REGISTER_CONGRATS_COPY,
  prettifyRegisterLog,
  registerCongratsMessage,
} = require('../src/utils/registerLogCopy');

test('register success copy is yellow-bold source text', () => {
  assert.equal(REGISTER_CONGRATS_COPY, '恭喜你,注册成功!');
  assert.equal(registerCongratsMessage('demo@example.test'), 'demo@example.test：恭喜你,注册成功!');
  assert.equal(prettifyRegisterLog('demo@example.test：注册成功，耗时 12s'), 'demo@example.test：恭喜你,注册成功!');
});

test('rewrites headless register logs into cute Chinese without English or URLs', () => {
  assert.equal(
    prettifyRegisterLog('注册选项：设置密码=是 启用TOTP 2FA=是 模式=headless_click 静态资源优化=开'),
    '这次会设好密码，二次验证也会打开，轻轻点点页面就能注册',
  );
  assert.equal(
    prettifyRegisterLog('无头模拟：打开 ChatGPT 注册入口（5%）'),
    '正在打开注册小门（5%）',
  );
  assert.equal(
    prettifyRegisterLog('已进入认证域：https://auth.openai.com/api/accounts/authorize'),
    '已经走进注册小屋啦',
  );
  assert.equal(
    prettifyRegisterLog('必须先设置密码再获取验证码（当前 waiting https://auth.openai.com/email-verification）'),
    '先设好密码，再去拿验证码哦',
  );
  assert.equal(
    prettifyRegisterLog('[headless-click] 步骤 2/5：已找到密码框 input[autocomplete="new-password"]，正在输入'),
    '第2步：正在填写密码',
  );
  assert.doesNotMatch(prettifyRegisterLog('已进入认证域：https://auth.openai.com/create-account/password'), /https?:\/\//);
  assert.doesNotMatch(prettifyRegisterLog('[headless-click] 点这里 input[autocomplete="username"]'), /autocomplete|headless-click/i);
  assert.match(
    prettifyRegisterLog('注册失败：必须先点击设置密码并填写密码，不能直接走邮箱验证码'),
    /必须先点击设置密码/,
  );
});

test('cloak browser logs drop English names, fingerprints and launch flags', () => {
  assert.equal(prettifyRegisterLog('CloakBrowser 导航 null'), '浏览器正在打开页面');
  assert.equal(
    prettifyRegisterLog('CloakBrowser 会话就绪，fingerprint=ab12cd34ef56'),
    '浏览器已经准备好啦',
  );
  assert.equal(
    prettifyRegisterLog('启动 CloakBrowser（headless=true，humanize=true，proxy=on，profile=persistent）'),
    '正在叫醒浏览器',
  );
  const leftover = prettifyRegisterLog('浏览器会话就绪 fingerprint=deadbeef0123 headless=true');
  assert.match(leftover, /浏览器/);
  assert.doesNotMatch(leftover, /fingerprint|headless|deadbeef/i);
});

test('does not swallow email prefix or empty out already-cute success', () => {
  assert.equal(
    prettifyRegisterLog('kid@example.test：恭喜你,注册成功!'),
    'kid@example.test：恭喜你,注册成功!',
  );
  assert.equal(prettifyRegisterLog(''), '');
});
