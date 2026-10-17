import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EXTRACTED,
  EXTRACTING,
  GOT_RT,
  PAYING,
  activateLogsQuery,
  extractLogsQuery,
  logRouteState,
  overlayProgress,
  remarkDisplay,
} from '../src/utils/accountProgress.js';

test('in-flight extract overlays 提链中 ahead of pay and stored 已支付', () => {
  const row = { id: 9, email: 'live@example.test', progress: '已支付' };
  assert.equal(overlayProgress(row, {
    extract: { running: true, emails: ['live@example.test'], ids: [9], run_id: 'run-extract' },
    activate: { running: true, emails: ['live@example.test'], ids: [9] },
  }), EXTRACTING);
  assert.equal(overlayProgress(row, {
    extract: { running: false, emails: [], ids: [] },
    activate: { running: true, emails: [], ids: [9] },
  }), '已支付');
  assert.equal(overlayProgress(row, {
    extract: { running: false, emails: [], ids: [] },
    activate: { running: false, emails: [], ids: [] },
  }), '已支付');
  assert.equal(overlayProgress(row, {}, { 9: 'extract' }), EXTRACTING);
});

test('已提链 stays stored when no live job is running', () => {
  const row = { id: 3, email: 'done@example.test', progress: EXTRACTED };
  assert.equal(overlayProgress(row, {
    extract: { running: false, emails: [], ids: [] },
    activate: { running: false, emails: [], ids: [] },
  }), EXTRACTED);
});

test('remark shows 已拿RT after refresh token, not 已提链 or 已支付', () => {
  const row = {
    id: 4,
    email: 'rt@example.test',
    progress: EXTRACTED,
    has_refresh_token: true,
    remark: GOT_RT,
  };
  assert.equal(remarkDisplay(row), GOT_RT);
  assert.equal(remarkDisplay({
    ...row,
    progress: '已支付',
    has_refresh_token: true,
  }), GOT_RT);
  assert.equal(remarkDisplay({
    id: 5,
    progress: EXTRACTED,
    has_refresh_token: false,
    remark: '',
  }), EXTRACTED);
  assert.equal(remarkDisplay(row, {
    extract: { running: true, emails: ['rt@example.test'], ids: [4] },
    activate: { running: false, emails: [], ids: [] },
  }), GOT_RT);
  assert.equal(remarkDisplay(row, {
    extract: { running: false, emails: [], ids: [] },
    activate: { running: true, emails: ['rt@example.test'], ids: [4] },
  }, { 4: 'activate' }), GOT_RT);
});

test('live 支付中 overlay does not hide 已拿RT when the account already has RT', () => {
  const row = {
    id: 68,
    email: 'plus-rt@example.test',
    progress: '已支付',
    has_refresh_token: true,
    remark: GOT_RT,
  };
  assert.equal(remarkDisplay(row, {
    extract: { running: false, emails: [], ids: [] },
    activate: { running: true, emails: ['plus-rt@example.test'], ids: [68] },
  }), GOT_RT);
  assert.equal(overlayProgress(row, {
    extract: { running: false, emails: [], ids: [] },
    activate: { running: true, emails: ['plus-rt@example.test'], ids: [68] },
  }), '已支付');
});

test('已支付 / activated_at / 已拿RT win over live 支付中', () => {
  const livePay = {
    extract: { running: false, emails: [], ids: [] },
    activate: { running: true, emails: ['paid@example.test'], ids: [7] },
  };
  assert.equal(overlayProgress({
    id: 7,
    email: 'paid@example.test',
    progress: '已支付',
  }, livePay), '已支付');
  assert.equal(overlayProgress({
    id: 7,
    email: 'paid@example.test',
    progress: '已注册',
    activated_at: '2026-08-21 05:00:00',
  }, livePay), '已注册');
  assert.equal(overlayProgress({
    id: 7,
    email: 'paid@example.test',
    progress: '已支付',
    remark: GOT_RT,
  }, livePay), '已支付');
  assert.equal(overlayProgress({
    id: 7,
    email: 'paid@example.test',
    progress: PAYING,
    activated_at: '2026-08-21 05:00:00',
  }, livePay), '已支付');
  assert.equal(overlayProgress({
    id: 8,
    email: 'unpaid@example.test',
    progress: '已提链',
  }, {
    extract: { running: false, emails: [], ids: [] },
    activate: { running: true, emails: ['unpaid@example.test'], ids: [8] },
  }), PAYING);
  assert.equal(overlayProgress({
    id: 7,
    email: 'paid@example.test',
    progress: '已支付',
  }, livePay, { 7: 'activate' }), '已支付');
});

test('提链中 navigates to oauth logs with run_id when present', () => {
  assert.deepEqual(extractLogsQuery({ run_id: 'abc-123' }), { tab: 'oauth', run_id: 'abc-123' });
  assert.deepEqual(extractLogsQuery({}), { tab: 'oauth' });
  const tabs = [
    { key: 'pull' },
    { key: 'register' },
    { key: 'oauth' },
  ];
  assert.deepEqual(logRouteState({ tab: 'oauth', run_id: 'run-extract' }, tabs), {
    category: 'oauth',
    runId: 'run-extract',
  });
  assert.deepEqual(logRouteState({}, tabs), { category: 'pull', runId: '' });
});

test('支付中 navigates to activate logs with run_id when present', () => {
  assert.deepEqual(activateLogsQuery({ run_id: 'run-pay' }), { tab: 'activate', run_id: 'run-pay' });
  assert.deepEqual(activateLogsQuery({}), { tab: 'activate' });
});
