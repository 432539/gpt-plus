'use strict';

const { AUTH_BASE, CODEX_CLIENT_ID, CODEX_REDIRECT_URI, CONSENT_URL, REDIRECT_STATUSES } = require('./constants');
const { absUrl, continueUrl, extractCode, isCodexCallbackUrl, urlForLog } = require('./parse');
const { buildCodexAuthorizeUrl, buildOauth2AuthUrl, newPkceState } = require('./pkce');
const {
  extractLoginVerifier, extractWorkspaceId, follow, headerValue, jsonHeaders, navHeaders, protocolRequest,
} = require('./http');

function pickOrgs(body) {
  if (!body || typeof body !== 'object') return [];
  const data = body.data;
  const src = data && typeof data === 'object' && Array.isArray(data.orgs)
    ? data.orgs
    : (Array.isArray(body.orgs) ? body.orgs : []);
  return src.filter(item => item && typeof item === 'object');
}

function pickPersonalOrFirst(orgs) {
  if (!orgs.length) return null;
  return orgs.find(item => String(item.kind || '').toLowerCase() === 'personal') || orgs[0];
}

async function workspaceIdFromDump(session, profile, deviceId, referer) {
  let workspaceId = await extractWorkspaceId(session);
  if (workspaceId) return workspaceId;
  const dump = await protocolRequest(session, 'GET', `${AUTH_BASE}/api/accounts/client_auth_session_dump`, {
    headers: {
      ...jsonHeaders(profile, deviceId, referer || `${AUTH_BASE}/email-verification`),
    },
  });
  const dj = dump.data && typeof dump.data === 'object' ? dump.data : {};
  const workspaces = dj.workspaces
    || (dj.client_auth_session && typeof dj.client_auth_session === 'object'
      ? dj.client_auth_session.workspaces
      : []);
  if (Array.isArray(workspaces) && workspaces[0]?.id) return String(workspaces[0].id);
  return extractWorkspaceId(session);
}

async function submitConsentAndExtractCode(session, profile, deviceId, {
  consentUrl, challenge, state, log, checkpoint,
} = {}) {
  const consentReferer = /\/consent/.test(consentUrl || '') ? consentUrl : CONSENT_URL;
  let { code } = await follow(session, profile, deviceId, consentUrl || CONSENT_URL, {
    referer: `${AUTH_BASE}/`, log, checkpoint,
  });
  if (code) {
    log?.('  consent GET 链已直接给出 authorization code');
    return code;
  }

  const workspaceId = await workspaceIdFromDump(session, profile, deviceId, `${AUTH_BASE}/email-verification`);
  log?.(`  workspace_id=${workspaceId ? '有' : '无'}`);
  let authCode = '';
  if (workspaceId) {
    const rws = await protocolRequest(session, 'POST', `${AUTH_BASE}/api/accounts/workspace/select`, {
      headers: jsonHeaders(profile, deviceId, consentReferer),
      json: { workspace_id: workspaceId },
    });
    log?.(`  workspace/select 状态：${rws.status}`);
    if (REDIRECT_STATUSES.has(rws.status) && headerValue(rws.headers, 'location')) {
      const loc = absUrl(headerValue(rws.headers, 'location'));
      authCode = extractCode(loc);
      if (!authCode) {
        ({ code: authCode } = await follow(session, profile, deviceId, loc, {
          referer: consentReferer, log, checkpoint,
        }));
      }
    } else if ([200, 201, 204].includes(rws.status)) {
      const wsBody = rws.data && typeof rws.data === 'object' ? rws.data : {};
      const wsNext = continueUrl(wsBody);
      const orgs = pickOrgs(wsBody);
      const pageType = wsBody.page && typeof wsBody.page === 'object' ? String(wsBody.page.type || '') : '';
      authCode = wsNext ? extractCode(absUrl(wsNext)) : '';
      const needOrg = !authCode && (orgs.length || String(wsNext).includes('/codex/organization')
        || ['organization_select', 'organization'].includes(pageType));
      if (needOrg) {
        const org = pickPersonalOrFirst(orgs);
        if (org?.id) {
          const orgBody = { org_id: String(org.id) };
          const projects = Array.isArray(org.projects) ? org.projects : [];
          if (projects[0]?.id) orgBody.project_id = String(projects[0].id);
          else if (org.default_project_id) orgBody.project_id = String(org.default_project_id);
          else if (org.project_id) orgBody.project_id = String(org.project_id);
          const orgReferer = wsNext ? absUrl(wsNext) : consentReferer;
          const rorg = await protocolRequest(session, 'POST', `${AUTH_BASE}/api/accounts/organization/select`, {
            headers: jsonHeaders(profile, deviceId, orgReferer),
            json: orgBody,
          });
          log?.(`  organization/select 状态：${rorg.status}`);
          if (REDIRECT_STATUSES.has(rorg.status) && headerValue(rorg.headers, 'location')) {
            const loc = absUrl(headerValue(rorg.headers, 'location'));
            authCode = extractCode(loc);
            if (!authCode) {
              ({ code: authCode } = await follow(session, profile, deviceId, loc, {
                referer: orgReferer, log, checkpoint,
              }));
            }
          } else if ([200, 201].includes(rorg.status)) {
            const orgNext = continueUrl(rorg.data);
            if (orgNext) {
              ({ code: authCode } = await follow(session, profile, deviceId, absUrl(orgNext), {
                referer: orgReferer, log, checkpoint,
              }));
            }
          }
        }
      }
      if (!authCode && wsNext) {
        ({ code: authCode } = await follow(session, profile, deviceId, absUrl(wsNext), {
          referer: consentReferer, log, checkpoint,
        }));
      }
    }
  }

  if (!authCode && challenge && state) {
    const loginVerifier = await extractLoginVerifier(session);
    const oauth2Url = buildOauth2AuthUrl({ challenge, state, loginVerifier });
    log?.(`  回退 oauth2/auth（login_verifier=${loginVerifier ? '有' : '无'}）追 code`);
    ({ code: authCode } = await follow(session, profile, deviceId, oauth2Url, {
      referer: consentReferer, log, checkpoint,
    }));
    if (authCode) log?.('  oauth2/auth 链提取到 code（经 consent_challenge 完成授权）');
  }
  return authCode;
}

async function resolveAuthorizationCode(session, profile, deviceId, {
  continueUrl: next, challenge, state, log, checkpoint,
} = {}) {
  const finalUrl = next ? absUrl(next) : CONSENT_URL;
  let code = '';
  if (/oauth2\/auth|consent_challenge|login_verifier/.test(finalUrl)) {
    log?.(`[RT-consent] 跟随 continue_url 直取 code：${urlForLog(finalUrl)}`);
    const followed = await follow(session, profile, deviceId, finalUrl, {
      referer: `${AUTH_BASE}/about-you`, log, checkpoint,
    });
    code = followed.code;
    if (code) log?.('  已从 continue_url 链路提取 code');
    else log?.(`  continue_url 直取未得 code（停在 ${urlForLog(followed.location)}）`);
  }
  if (!code) {
    let consentUrl = finalUrl;
    if (!/consent|sign-in-with-chatgpt|workspace|organization/.test(consentUrl)) consentUrl = CONSENT_URL;
    log?.('[RT-consent] 回退 workspace/select + oauth2/auth 提取 code');
    code = await submitConsentAndExtractCode(session, profile, deviceId, {
      consentUrl, challenge, state, log, checkpoint,
    });
  }
  return code;
}

async function exchangeCodeForTokens(session, profile, { code, verifier, log } = {}) {
  if (!code) throw new Error('缺少 authorization code，无法换取 token');
  log?.('[RT-token] POST /oauth/token（Codex CLI 换取 refresh_token）');
  const tokenResp = await protocolRequest(session, 'POST', `${AUTH_BASE}/oauth/token`, {
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': profile.user_agent,
      accept: 'application/json',
    },
    form: {
      grant_type: 'authorization_code',
      code,
      redirect_uri: CODEX_REDIRECT_URI,
      client_id: CODEX_CLIENT_ID,
      code_verifier: verifier,
    },
  });
  log?.(`  /oauth/token 状态：${tokenResp.status}`);
  if (tokenResp.status !== 200) {
    throw new Error(`Codex /oauth/token 失败 HTTP ${tokenResp.status}`);
  }
  const tok = tokenResp.data && typeof tokenResp.data === 'object' ? tokenResp.data : {};
  const refreshToken = String(tok.refresh_token || '');
  if (!refreshToken) throw new Error('token 响应缺少 refresh_token');
  log?.('  已获取 Codex refresh_token');
  return {
    refresh_token: refreshToken,
    access_token: String(tok.access_token || ''),
    id_token: String(tok.id_token || ''),
  };
}

async function handleChooseAnAccount(session, profile, deviceId, {
  chooseUrl, challenge, state, log, checkpoint,
} = {}) {
  log?.(`[RT-account] 处理 choose-an-account：${urlForLog(chooseUrl)}`);
  await checkpoint?.();
  const page = await protocolRequest(session, 'GET', chooseUrl || `${AUTH_BASE}/choose-an-account`, {
    headers: navHeaders(profile, deviceId, `${AUTH_BASE}/`),
  });
  log?.(`  choose-an-account GET 状态：${page.status}`);
  const loc = absUrl(headerValue(page.headers, 'location'));
  if (loc && isCodexCallbackUrl(loc)) return extractCode(loc);
  if (REDIRECT_STATUSES.has(page.status) && loc) {
    const followed = await follow(session, profile, deviceId, loc, {
      referer: chooseUrl, log, checkpoint,
    });
    if (followed.code) return followed.code;
  }
  let workspaceId = await extractWorkspaceId(session);
  const html = String(page.text || '');
  if (!workspaceId) {
    const patterns = [
      /name=["']workspace_id["'][^>]*value=["']([0-9a-f-]{36})["']/i,
      /value=["']([0-9a-f-]{36})["'][^>]*name=["']workspace_id["']/i,
      /"workspace_id"\s*:\s*"([0-9a-f-]{36})"/i,
      /"id"\s*:\s*"([0-9a-f-]{36})"[^}]{0,80}"kind"\s*:\s*"personal"/i,
    ];
    for (const pat of patterns) {
      const match = html.match(pat);
      if (match) {
        workspaceId = match[1];
        break;
      }
    }
  }
  if (!workspaceId) {
    workspaceId = await workspaceIdFromDump(session, profile, deviceId, `${AUTH_BASE}/choose-an-account`);
  }
  log?.(`  workspace_id=${workspaceId ? '有' : '无'}`);
  if (workspaceId) {
    const rws = await protocolRequest(session, 'POST', `${AUTH_BASE}/api/accounts/workspace/select`, {
      headers: jsonHeaders(profile, deviceId, `${AUTH_BASE}/choose-an-account`),
      json: { workspace_id: workspaceId },
    });
    log?.(`  workspace/select 状态：${rws.status}`);
    if (REDIRECT_STATUSES.has(rws.status) && headerValue(rws.headers, 'location')) {
      const next = absUrl(headerValue(rws.headers, 'location'));
      const code = extractCode(next);
      if (code) return code;
      const followed = await follow(session, profile, deviceId, next, {
        referer: `${AUTH_BASE}/choose-an-account`, log, checkpoint,
      });
      if (followed.code) return followed.code;
    } else if ([200, 201, 204].includes(rws.status)) {
      const nxt = continueUrl(rws.data);
      if (nxt) {
        const followed = await follow(session, profile, deviceId, absUrl(nxt), {
          referer: `${AUTH_BASE}/choose-an-account`, log, checkpoint,
        });
        if (followed.code) return followed.code;
      }
    }
  }
  return submitConsentAndExtractCode(session, profile, deviceId, {
    consentUrl: CONSENT_URL, challenge, state, log, checkpoint,
  });
}

async function acquireCodexRefreshToken(session, profile, deviceId, { log, checkpoint } = {}) {
  const { verifier, challenge, state } = newPkceState();
  const authorizeUrl = buildCodexAuthorizeUrl(challenge, state, deviceId);
  log?.('[RT-1] GET /oauth/authorize（Codex CLI / oaicli，初始化 PKCE 会话）');
  let { code, location } = await follow(session, profile, deviceId, authorizeUrl, {
    referer: `${AUTH_BASE}/`, log, checkpoint,
  });
  log?.(`  authorize 落点：${urlForLog(location || '')} code=${code ? '有' : '无'}`);
  if (!code) {
    if (String(location || '').includes('choose-an-account')) {
      code = await handleChooseAnAccount(session, profile, deviceId, {
        chooseUrl: location, challenge, state, log, checkpoint,
      });
    } else {
      let consentUrl = location || CONSENT_URL;
      if (!/consent|sign-in-with-chatgpt|workspace|organization|oauth2\/auth/.test(consentUrl)) {
        consentUrl = CONSENT_URL;
      }
      log?.(`[RT-2] consent 链换取 authorization code（seed=${urlForLog(consentUrl)}）`);
      code = await resolveAuthorizationCode(session, profile, deviceId, {
        continueUrl: consentUrl, challenge, state, log, checkpoint,
      });
    }
  }
  return exchangeCodeForTokens(session, profile, { code, verifier, log });
}

module.exports = {
  resolveAuthorizationCode,
  exchangeCodeForTokens,
  acquireCodexRefreshToken,
  handleChooseAnAccount,
  submitConsentAndExtractCode,
};
