'use strict';

const AUTH_BASE = 'https://auth.openai.com';
const CHATGPT_BASE = 'https://chatgpt.com';
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_REDIRECT_URI = 'http://localhost:1455/auth/callback';
const CODEX_SCOPE = 'openid profile email offline_access';
const CODEX_AUDIENCE = 'https://api.openai.com/v1';
const SENTINEL_SDK_VERSION = '20260810913b';
const SENTINEL_URL = 'https://sentinel.openai.com/backend-api/sentinel/req';
const SENTINEL_SDK_URL = `https://sentinel.openai.com/sentinel/${SENTINEL_SDK_VERSION}/sdk.js`;
const SENTINEL_FRAME_REFERER = `https://sentinel.openai.com/backend-api/sentinel/frame.html?sv=${SENTINEL_SDK_VERSION}`;
const CONSENT_URL = `${AUTH_BASE}/sign-in-with-chatgpt/codex/consent`;
const AUTHORIZE_GATE_STATUSES = new Set([403, 429, 503]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const PHONE_ROTATIONS = 6;
const PHONE_PAGE_TYPES = new Set(['add_phone', 'phone_otp_verification']);
const CONSENT_PAGE_TYPES = new Set([
  'sign_in_with_chatgpt_codex_consent',
  'external_url',
  'consent',
]);

const EXTRACT_PROFILE = Object.freeze({
  user_agent: (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
    + 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
  ),
  sec_ch_ua: '"Google Chrome";v="136", "Chromium";v="136", "Not_A Brand";v="99"',
  sec_ch_ua_platform: '"Windows"',
  locale: 'en-US,en;q=0.9',
  oai_language: 'en-US',
  language: 'en-US',
  languages: 'en-US,en',
  timezone: 'Asia/Tokyo',
  sentinel_platform: 'Win32',
  screen: '1920x1080',
  impersonate: 'chrome136',
});

module.exports = {
  AUTH_BASE,
  CHATGPT_BASE,
  CODEX_CLIENT_ID,
  CODEX_REDIRECT_URI,
  CODEX_SCOPE,
  CODEX_AUDIENCE,
  SENTINEL_SDK_VERSION,
  SENTINEL_URL,
  SENTINEL_SDK_URL,
  SENTINEL_FRAME_REFERER,
  CONSENT_URL,
  AUTHORIZE_GATE_STATUSES,
  REDIRECT_STATUSES,
  PHONE_ROTATIONS,
  PHONE_PAGE_TYPES,
  CONSENT_PAGE_TYPES,
  EXTRACT_PROFILE,
};
