// ChatGPT / OpenAI 邮箱验证码提取。
// 英文 tm.openai.com 信是 HTML 为主，正文是
// “Enter this temporary verification code to continue:” + 6 位数字。
// 必须丢掉 SendGrid 跟踪链（url3243.email.openai.com/ls/click）里的数字。

const MAGIC_URL = /https?:\/\/[^\s<>"']+(?:magic|verify|verification|login|auth)[^\s<>"']*/gi;
const TRACKING_URL = /https?:\/\/(?:[\w.-]+\.)?(?:email\.openai\.com|sendgrid\.net)[^\s<>"']*/gi;
const TRACKING_HOST = /url\d+\.email\.openai\.com[^\s<>"']*/gi;
const GENERIC_URL = /https?:\/\/[^\s<>"']+/gi;

const CHATGPT_FROM = /noreply@(?:tm\.)?openai\.com|(?:chatgpt|openai)\s*<[^>]*(?:tm\.)?openai\.com/i;
const CHATGPT_HINT = /openai|chatgpt|noreply@tm\.openai\.com|tm\.openai\.com/i;
const CHATGPT_SUBJECT = /your temporary chatgpt verification code|temporary (?:chatgpt )?verification code|chatgpt verification code|验证码|校验码/i;

function looksLikeChatgptVerification(message = {}) {
  const from = String(message.from || '');
  const subject = String(message.subject || '');
  if (CHATGPT_SUBJECT.test(subject) || CHATGPT_FROM.test(from)) return true;
  return CHATGPT_HINT.test(`${from} ${subject}`) && /verification code|验证码|校验码/i.test(`${from} ${subject}`);
}

function decodeQuotedPrintable(value) {
  const raw = String(value || '');
  if (!/=(?:[0-9A-Fa-f]{2}|\r?\n)/.test(raw)) return raw;
  return raw
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function stripTagsAndUrls(value) {
  return decodeQuotedPrintable(value)
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(TRACKING_URL, ' ')
    .replace(TRACKING_HOST, ' ')
    .replace(GENERIC_URL, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(nbsp|#160);/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, ' ')
    .trim();
}

function otpFromMatch(raw) {
  const code = String(raw || '').replace(/\D/g, '');
  return code.length >= 4 && code.length <= 8 ? code : '';
}

function sixDigitOtp(raw) {
  const code = otpFromMatch(raw);
  return code.length === 6 ? code : '';
}

function fromHtmlBlocks(html) {
  const decoded = decodeQuotedPrintable(html)
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ');
  for (const block of decoded.matchAll(/<(td|span|div|b|strong|p|h[1-6])\b[^>]*>([\s\S]{0,120}?)<\/\1>/gi)) {
    const code = sixDigitOtp(stripTagsAndUrls(block[2]));
    if (code) return code;
  }
  for (const item of decoded.matchAll(/font-size\s*:\s*(\d{2,3})\s*px[^>]*>([^<]*\d{6}[^<]*)</gi)) {
    if (Number(item[1]) >= 18) {
      const code = sixDigitOtp(item[2]);
      if (code) return code;
    }
  }
  return '';
}

function extractMagicUrl(body) {
  const matches = String(body || '').match(MAGIC_URL) || [];
  for (const raw of matches) {
    const url = String(raw).replace(/&amp;/g, '&').replace(/[)>.,]+$/, '');
    if (/email\.openai\.com|sendgrid\.net|\/ls\/click|\/wf\/open/i.test(url)) continue;
    return url;
  }
  return '';
}

function extractLabeledCode(plain, message) {
  const enter = plain.match(
    /enter this temporary verification code to continue[:\s]*((?:[0-9]\s*){6})/i
  );
  const entered = sixDigitOtp(enter?.[1]);
  if (entered) return entered;

  const labeled = plain.match(
    /(?:your temporary chatgpt verification code|temporary\s+(?:chatgpt\s+)?verification\s+code|verification\s+code|one[- ]time\s+(?:password|code)|验证码|校验码)[^0-9]{0,200}((?:[0-9]\s*){4,8})/i
  );
  const candidate = otpFromMatch(labeled?.[1]);
  if (candidate.length === 6) return candidate;
  if (candidate && !looksLikeChatgptVerification(message)) return candidate;
  return '';
}

function extractVerificationMessage(message = {}) {
  const subject = String(message.subject || '');
  const html = String(message.html || message.body || '');
  const text = String(message.text || '');
  const combined = `${subject}\n${text}\n${html}`;
  const url = extractMagicUrl(combined);
  const code =
    fromHtmlBlocks(html)
    || extractLabeledCode(stripTagsAndUrls(combined), message)
    || sixDigitOtp((stripTagsAndUrls(combined).match(/(?:^|\s)((?:[0-9]\s*){6})(?=\s|$)/) || [])[1]);
  if (url || code) return { url, code, message };
  return { url: '', code: '', message: null };
}

module.exports = {
  extractVerificationMessage,
  looksLikeChatgptVerification,
  stripTagsAndUrls,
};
