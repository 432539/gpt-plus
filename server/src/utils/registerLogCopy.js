'use strict';

const REGISTER_CONGRATS_COPY = '恭喜你,注册成功!';

function registerCongratsMessage(email) {
  const name = String(email || '').trim();
  return name ? `${name}：${REGISTER_CONGRATS_COPY}` : REGISTER_CONGRATS_COPY;
}

function splitEmailPrefix(text) {
  const raw = String(text || '');
  const idx = raw.indexOf('：');
  if (idx <= 0) return { email: '', body: raw };
  const head = raw.slice(0, idx);
  if (!head.includes('@') || /\s/.test(head)) return { email: '', body: raw };
  return { email: head, body: raw.slice(idx + 1) };
}

const REWRITES = [
  [/REGISTER_ASSET_OPT_V1[\s\S]*/, '页面小零件已经帮你省了一点加载'],
  [/^启动\s*CloakBrowser.*/, '正在叫醒浏览器'],
  [/CloakBrowser 会话就绪.*/, '浏览器已经准备好啦'],
  [/CloakBrowser 导航.*/, '浏览器正在打开页面'],
  [/CloakBrowser 会话已销毁.*/, '浏览器先休息一下'],
  [/CloakBrowser 注册 profile 已回收/, '浏览器小屋已经收起来啦'],
  [/CloakBrowser 注册 profile 回收失败.*/, '浏览器小屋没收干净，先继续哦'],
  [/协议请求\b.*/, '浏览器正在轻轻问一下页面'],
  [/协议上下文导航.*/, '浏览器正在换个页面'],
  [/协议上下文 .+ 在 \d+ms 内无响应.*/, '页面有点慢，浏览器再等一等'],
  [/注册选项：.*/, (text) => (
    /启用TOTP 2FA=否/.test(text)
      ? '这次会设好密码，二次验证先不开，轻轻点点页面就能注册'
      : '这次会设好密码，二次验证也会打开，轻轻点点页面就能注册'
  )],
  [/无头模拟：打开 ChatGPT 注册入口/, '正在打开注册小门'],
  [/无头模拟：进入邮箱注册入口/, '走进邮箱注册小门'],
  [/无头模拟：输入邮箱并继续/, '正在填写邮箱'],
  [/无头模拟：点击密码框并输入密码/, '正在填写密码'],
  [/无头模拟：等待邮箱验证码/, '正在等邮箱验证码'],
  [/无头模拟：填写用户资料/, '正在填写小资料'],
  [/无头模拟：页面注册完成/, '页面注册完成啦'],
  [/无头模拟：跳过通行密钥\/中间页/, '路过中间页，继续往前走'],
  [/已进入认证域.*/, '已经走进注册小屋啦'],
  [/必须先设置密码再获取验证码.*/, '先设好密码，再去拿验证码哦'],
  [/\[headless-click\]\s*注册入口已就绪/, '注册小门已经打开啦'],
  [/\[headless-click\]\s*页面注册链路完成.*/, '页面这边已经注册好啦'],
  [/\[headless-click\]\s*登录入口导航第 \d+\/3 次超时.*/, '注册小门有点慢，再轻轻试一次'],
  [/\[headless-click\]\s*第 \d+ 次回调事务探测已落地/, '回头看了一眼，已经接上啦'],
  [/\[headless-click\]\s*第 \d+ 次回调事务探测尚未落地.*/, '回头看了一眼，还在路上哦'],
  [/第 \d+ 次回调事务探测已落地/, '回头看了一眼，已经接上啦'],
  [/第 \d+ 次回调事务探测尚未落地.*/, '回头看了一眼，还在路上哦'],
  [/^注册成功[，,].*/, REGISTER_CONGRATS_COPY],
  [/^注册成功$/, REGISTER_CONGRATS_COPY],
  [/^\[headless-click\]\s*点击设置密码(?:\/Continue with password)?.*/, '点一下设置密码'],
  [/^点击设置密码(?:\/Continue with password)?.*/, '点一下设置密码'],
  [/^\[headless-click\]\s*步骤 1\/5：输入邮箱/, '第1步：填上邮箱'],
  [/^步骤 1\/5：输入邮箱/, '第1步：填上邮箱'],
  [/^\[headless-click\]\s*步骤 2\/5：.*/, '第2步：正在填写密码'],
  [/^步骤 2\/5：.*/, '第2步：正在填写密码'],
  [/^\[headless-click\]\s*步骤 3\/5：等待邮箱验证码/, '第3步：正在等邮箱验证码'],
  [/^步骤 3\/5：等待邮箱验证码/, '第3步：正在等邮箱验证码'],
  [/^输入验证码$/, '正在填验证码'],
  [/^\[headless-click\]\s*步骤 4\/5：.*/, '第4步：正在填写小资料'],
  [/^步骤 4\/5：.*/, '第4步：正在填写小资料'],
  [/^\[headless-click\]\s*步骤 5\/5：.*/, '第5步：页面注册完成啦'],
  [/^步骤 5\/5：.*/, '第5步：页面注册完成啦'],
  [/认证页可操作阶段.*/, '注册小屋已经打开，看看现在到哪一步'],
  [/认证页从 .+ 转为.*/, '页面换了个样子，继续往下走'],
  [/未稳定进入密码页.*/, '还没走进密码页，再帮你开一下'],
  [/打开密码注册页失败.*/, '密码页有点倔，暂时没打开'],
  [/密码已提交，下一阶段.*/, '密码交上去啦，继续往下走'],
  [/验证码页出现但尚未设置密码.*/, '先回去设密码，验证码先等等'],
  [/阶段误判为资料页.*/, '还没到资料页，再等一等'],
  [/资料已写入.*/, '小资料填好啦'],
  [/等待密码\/验证码\/资料页.*/, '还在等密码、验证码或资料页出现'],
  [/验证码页仍无跳转.*/, '验证码交上去了，页面还没动，再轻轻推一下'],
  [/资料页校验未通过.*/, '资料页还缺了点东西，再填一遍'],
  [/资料页已重新填写.*/, '资料又填了一遍，继续往前走'],
  [/网页已生成 authorize 跳转.*/, '页面想跳一下但没跳成，再帮你推一把'],
  [/页面注册完成，开始创建并激活 TOTP 2FA/, '页面注册好啦，接着打开二次验证'],
  [/未勾选 2FA.*/, '这次没开二次验证，页面注册好就先收工'],
  [/注册后启用 TOTP 2FA/, '接着打开二次验证'],
  [/TOTP 2FA 已激活.*/, '二次验证已经打开啦'],
  [/2FA 未设置成功，不入库/, '二次验证还没设好，先不收进号簿'],
  [/收到停止指令，正在结束 Cloak 会话/, '收到停止指令，正在轻轻关掉浏览器'],
  [/初始化 ChatGPT 注册协议/, '正在准备注册'],
  [/提交 ChatGPT 注册邮箱协议/, '正在提交注册邮箱'],
  [/触发 ChatGPT 远程邮箱验证/, '正在打开注册小屋'],
  [/设置 ChatGPT 登录密码/, '正在设置登录密码'],
  [/发送 ChatGPT 无密码注册验证码/, '正在发送验证码'],
  [/提交 ChatGPT 邮箱 OTP 协议/, '正在提交验证码'],
  [/提交 ChatGPT 注册资料协议/, '正在提交小资料'],
  [/完成 ChatGPT OAuth 回调/, '正在完成注册回跳'],
  [/提取 ChatGPT access token/, '正在取出登录凭证'],
  [/校验 ChatGPT access token/, '正在核对登录凭证'],
  [/换取可续期的 ChatGPT 凭据/, '换取可续期凭证'],
  [/\[protocol-recovery\].*/, '刚才卡住了一下，浏览器还在，再试一次'],
  [/\[authorize\].*/, '登录小门还没开好，再轻轻试一次'],
  [/\[oauth-callback\].*已经落地.*/, '授权已经接上啦，继续往下走'],
  [/\[oauth-callback\].*/, '授权还在路上，再等一等'],
  [/mail\.com 收件直连.*/, '邮箱收件直连，不走代理'],
  [/Mailpit 收件走内网 API.*/, '信箱收件走内网'],
];

function takeProgressSuffix(text) {
  const match = String(text || '').match(/（\d+%）\s*$/);
  return match ? match[0] : '';
}

function rewriteRegisterLog(body) {
  const raw = String(body || '');
  if (raw.includes(REGISTER_CONGRATS_COPY)) return REGISTER_CONGRATS_COPY;
  const progress = takeProgressSuffix(raw);
  const text = progress ? raw.slice(0, -progress.length) : raw;
  for (const [pattern, replacement] of REWRITES) {
    if (!pattern.test(text)) continue;
    pattern.lastIndex = 0;
    const next = typeof replacement === 'function' ? replacement(text) : replacement;
    return `${next}${progress}`;
  }
  return raw;
}

function scrubLeftovers(text) {
  let value = String(text || '');
  value = value.replace(/https?:\/\/[^\s)\]，。；、]*/gi, '');
  value = value.replace(/\bwww\.[^\s)\]，。；、]*/gi, '');
  value = value.replace(/[a-zA-Z][\w.-]*\[[^\]]+\]/g, '');
  value = value.replace(/\[(?:headless-click|register|authorize|oauth-callback|protocol-recovery|REGISTER_ASSET_OPT_V1|sentinel|oauth)\]\s*/gi, '');
  value = value.replace(/\bMailpit\b/g, '信箱');
  value = value.replace(/fingerprint\s*=\s*[a-f0-9]+/gi, '');
  value = value.replace(/\bheadless\s*=\s*(true|false)\b/gi, '');
  value = value.replace(/\bhumanize\s*=\s*(true|false)\b/gi, '');
  value = value.replace(/\bproxy\s*=\s*(on|off)\b/gi, '');
  value = value.replace(/\bprofile\s*=\s*persistent\b/gi, '');
  value = value.replace(/CloakBrowser/gi, '浏览器');
  value = value.replace(/\bCloak\b/g, '浏览器');
  value = value.replace(/\bChatGPT\b/g, '注册');
  value = value.replace(/\bTOTP(?:\s*2FA)?\b/gi, '二次验证');
  value = value.replace(/\b2FA\b/g, '二次验证');
  value = value.replace(/\bBrowserContext\b/g, '浏览器');
  value = value.replace(/\bContinue with password\b/gi, '设置密码');
  value = value.replace(/\baccess token\b/gi, '登录凭证');
  value = value.replace(/\bOTP\b/g, '验证码');
  value = value.replace(/(\d+)s(?=[）)…])/g, '$1秒');
  value = value.replace(/\bnull\b/g, '');
  value = value.replace(/\babout:blank\b/gi, '');
  value = value.replace(/\bHTTP\s+\d{3}\b/g, '网页不太高兴');
  value = value.replace(/\b[A-Z][A-Z0-9_]{5,}\b/g, '');
  value = value.replace(/\s{2,}/g, ' ');
  value = value.replace(/[（(]\s*[)）]/g, '');
  value = value.replace(/\s+[，。；、]+/g, (match) => match.trim().slice(-1));
  value = value.replace(/[：:]\s*$/g, '');
  return value.replace(/\s{2,}/g, ' ').trim();
}

function prettifyRegisterLog(message) {
  const raw = String(message || '').trim();
  if (!raw) return '';
  const { email, body } = splitEmailPrefix(raw);
  const pretty = scrubLeftovers(rewriteRegisterLog(body));
  if (!pretty) return '';
  return email ? `${email}：${pretty}` : pretty;
}

module.exports = {
  REGISTER_CONGRATS_COPY,
  registerCongratsMessage,
  prettifyRegisterLog,
};
