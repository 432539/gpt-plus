// 从 mail.com 收件箱提取 ChatGPT 邮箱验证码。HTTP/IMAP 收件直连，不走邮箱/注册代理。
const db = require('../db');
const { fetchInbox, fetchBody } = require('./mailcomService');
const { toMatches, recipientsOf } = require('./mailcom');
const { extractVerificationMessage, looksLikeChatgptVerification } = require('./verificationMail');

const OPENAI_HINT = /openai|chatgpt|noreply|tm\.openai\.com/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function extract(message = {}) {
  return extractVerificationMessage(message);
}

function mailboxOtpError(message, code, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function classifyMailboxError(error) {
  const code = String(error?.code || '');
  const message = String(error?.message || error);
  if (
    ['MAILCOM_BAD_CREDENTIALS', 'MAILCOM_ACCOUNT_INTERCEPTED', 'MAILCOM_LOGIN_REJECTED', 'MAILPIT_AUTH'].includes(code) ||
    /账号或密码错误|bad credentials|authentication failed|invalid credentials|人工验证|账号.*拦截|Mailpit 管理接口认证失败/i.test(message)
  ) {
    return { terminal: true, kind: 'credentials', message };
  }
  if (/邮箱不存在|找不到对应母号|mailbox (?:not found|does not exist)|凭据无法解密/i.test(message)) {
    return { terminal: true, kind: 'credentials', message };
  }
  if (
    error?.retryable === true
    || /登录被重定向|assistance|interception|logininterception|换 sid 失败|传输失败/i.test(message)
  ) {
    return { terminal: false, kind: 'login', message };
  }
  return { terminal: false, kind: 'transport', message };
}

function hasRecipient(mail) {
  return recipientsOf(mail?.to).length > 0;
}

function isTargetRecipient(mail, expectedTo) {
  if (!expectedTo) return true;
  if (!hasRecipient(mail)) return true;
  return toMatches(mail.to, expectedTo);
}

function isChatgptSignupOtpMail(mail) {
  return looksLikeChatgptVerification(mail)
    || OPENAI_HINT.test(`${mail?.from || ''} ${mail?.subject || ''}`);
}

async function pollMailboxOtp({
  fetchInboxFn,
  fetchBodyFn,
  timeoutMs = 300000,
  intervalMs = 3000,
  minIntervalMs = 1000,
  after = 0,
  expectedTo = '',
  sourceLabel = 'mail.com',
  log = () => {},
  cancelled = null,
  sleepFn = sleep,
  now = () => Date.now(),
}) {
  const end = now() + timeoutMs;
  const fetched = new Set();
  let lastDebug = 0;
  let lastTransient = '';
  let lastKind = '';
  let inboxReadable = false;
  let otherAliasChatgpt = 0;
  while (now() < end) {
    if (cancelled?.()) throw new Error('邮箱验证码等待已取消');
    try {
      // fetchInbox creates a separate protocol client, so workers must not block
      // one another merely because aliases share the same mother mailbox.
      const { mails } = await fetchInboxFn();
      inboxReadable = true;
      lastKind = '';
      const recent = (mails || []).filter((m) => {
        if (!after) return true;
        const receivedAt = m.date ? new Date(m.date).getTime() : 0;
        return !receivedAt || receivedAt >= after - 15000;
      });
      for (const mail of recent) {
        if (!isTargetRecipient(mail, expectedTo)) {
          if (isChatgptSignupOtpMail(mail)) otherAliasChatgpt += 1;
          continue;
        }
        const fromSubject = extract({
          from: mail.from || '',
          subject: mail.subject || '',
          text: '',
          html: '',
        });
        if (fromSubject.code) return fromSubject;
        const id = String(mail.id || '');
        let body = '';
        if (id && !fetched.has(id)) {
          const likely =
            looksLikeChatgptVerification(mail)
            || OPENAI_HINT.test(`${mail.from || ''} ${mail.subject || ''}`)
            || recent.length <= 8;
          if (likely) {
            fetched.add(id);
            try {
              body = await fetchBodyFn(id);
            } catch (error) {
              const classified = classifyMailboxError(error);
              if (classified.terminal) throw error;
              lastTransient = classified.message;
              lastKind = classified.kind;
            }
          }
        }
        const hit = extract({
          from: mail.from || '',
          subject: mail.subject || '',
          text: body,
          html: body,
          body,
        });
        if (hit.code) return hit;
      }
    } catch (e) {
      const classified = classifyMailboxError(e);
      if (classified.terminal) {
        const error = new Error(`邮箱读取失败：${classified.message}`);
        error.code = e?.code || 'MAILBOX_TERMINAL';
        throw error;
      }
      lastTransient = classified.message;
      lastKind = classified.kind;
      if (now() - lastDebug > 20000) {
        lastDebug = now();
        if (classified.kind === 'login') {
          log(`${sourceLabel} 登录失败，继续重试：${classified.message.slice(0, 140)}`, 'warning');
        } else {
          log(`${sourceLabel} 暂时不可用，继续等待：${classified.message.slice(0, 140)}`, 'debug');
        }
      }
      if (classified.kind === 'login') {
        await sleepFn(Math.max(minIntervalMs, Number(intervalMs) || 3000));
        continue;
      }
    }
    const remainSec = Math.max(0, Math.ceil((end - now()) / 1000));
    log(
      lastKind === 'login' && lastTransient
        ? `等待 ${sourceLabel} 验证邮件（登录未完成：${lastTransient.slice(0, 80)}，剩余 ${remainSec}s）…`
        : `等待 ${sourceLabel} 验证邮件（剩余 ${remainSec}s）…`,
      'debug'
    );
    await sleepFn(Math.max(minIntervalMs, Number(intervalMs) || 3000));
  }
  if (inboxReadable) {
    throw mailboxOtpError(
      otherAliasChatgpt
        ? '未收到验证邮件（收件箱可读，但没有寄给该子号的 ChatGPT 验证码）'
        : '未收到验证邮件（收件箱可读，没有匹配的 ChatGPT 验证码）',
      'MAILBOX_OTP_NOT_RECEIVED',
      { inboxReadable: true, otherAliasChatgpt },
    );
  }
  throw mailboxOtpError(
    `等待验证邮件超时${lastTransient ? `（最后一次收件错误：${lastTransient.slice(0, 140)}）` : ''}`,
    'MAILBOX_OTP_FETCH_FAILED',
    { inboxReadable: false, lastKind },
  );
}

async function waitMailOtp(
  userId,
  emailId,
  options = {}
) {
  const row = db.prepare('SELECT mother_id, address FROM emails WHERE id = ? AND user_id = ?').get(emailId, userId);
  if (!row) throw new Error('邮箱不存在');
  const log = options.log || (() => {});
  log('邮箱收件直连，不走代理', 'info');
  return pollMailboxOtp({
    ...options,
    expectedTo: options.expectedTo || row.address || '',
    log,
    fetchInboxFn: () => fetchInbox(userId, emailId, { amount: 30 }),
    fetchBodyFn: (mailId) => fetchBody(userId, emailId, mailId),
  });
}

module.exports = {
  waitMailOtp,
  pollMailboxOtp,
  classifyMailboxError,
  extract,
  isTargetRecipient,
  isChatgptSignupOtpMail,
};
