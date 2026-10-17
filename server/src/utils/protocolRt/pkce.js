'use strict';

const crypto = require('node:crypto');
const {
  AUTH_BASE, CODEX_AUDIENCE, CODEX_CLIENT_ID, CODEX_REDIRECT_URI, CODEX_SCOPE,
} = require('./constants');

function b64url(value) {
  return Buffer.from(value).toString('base64url');
}

function newPkceState() {
  const verifier = b64url(crypto.randomBytes(64));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(32));
  return { verifier, challenge, state };
}

function buildCodexAuthorizeUrl(challenge, state, deviceId = '') {
  const params = new URLSearchParams({
    client_id: CODEX_CLIENT_ID,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    codex_cli_simplified_flow: 'true',
    id_token_add_organizations: 'true',
    redirect_uri: CODEX_REDIRECT_URI,
    response_type: 'code',
    scope: CODEX_SCOPE,
    state,
  });
  if (deviceId) params.set('device_id', deviceId);
  return `${AUTH_BASE}/oauth/authorize?${params.toString()}`;
}

function buildOauth2AuthUrl({ challenge, state, loginVerifier = '' } = {}) {
  const params = new URLSearchParams({
    client_id: CODEX_CLIENT_ID,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    codex_cli_simplified_flow: 'true',
    id_token_add_organizations: 'true',
    redirect_uri: CODEX_REDIRECT_URI,
    response_type: 'code',
    scope: CODEX_SCOPE,
    state,
    audience: CODEX_AUDIENCE,
  });
  if (loginVerifier) params.set('login_verifier', loginVerifier);
  else params.set('prompt', 'login');
  return `${AUTH_BASE}/api/oauth/oauth2/auth?${params.toString()}`;
}

module.exports = { newPkceState, buildCodexAuthorizeUrl, buildOauth2AuthUrl };
