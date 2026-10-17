import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LOG_ROW_LIMIT,
  isNearLogBottom,
  mergeLogRows,
  nextLogScrollTop,
  sameLogRows,
  isCongratsActivateMessage,
  isCongratsRegisterMessage,
  logLevelText,
  logLineClassNames,
  logSourceText,
} from '../src/utils/logRows.js';

test('merges incremental log rows without duplicates in oldest-to-newest order', () => {
  const current = [7, 8, 9, 10].map((id) => ({ id, message: `old-${id}` }));
  const incoming = [9, 10, 11, 12].map((id) => ({ id, message: `new-${id}` }));
  const merged = mergeLogRows(current, incoming, 5);

  assert.deepEqual(merged.map((row) => row.id), [8, 9, 10, 11, 12]);
  assert.equal(merged.find((row) => row.id === 10).message, 'new-10');
  assert.equal(new Set(merged.map((row) => row.id)).size, merged.length);
});

test('keeps only the latest 100 rows with no pagination window', () => {
  const rows = Array.from({ length: 125 }, (_, index) => ({ id: index + 1 }));
  const merged = mergeLogRows([], rows);
  assert.equal(LOG_ROW_LIMIT, 100);
  assert.equal(merged.length, 100);
  assert.deepEqual(merged.map((row) => row.id), Array.from({ length: 100 }, (_, index) => index + 26));
  assert.equal(sameLogRows(merged, [...merged]), true);
});

test('bottom-scroll decision follows the user position before refresh', () => {
  assert.equal(isNearLogBottom({ scrollTop: 452, scrollHeight: 1000, clientHeight: 500 }), true);
  assert.equal(isNearLogBottom({ scrollTop: 300, scrollHeight: 1000, clientHeight: 500 }), false);
  assert.equal(nextLogScrollTop({ wasNearBottom: true, oldScrollTop: 452, newScrollHeight: 1080 }), 1080);
  assert.equal(nextLogScrollTop({ wasNearBottom: false, oldScrollTop: 300, newScrollHeight: 1080 }), 300);
});

test('congrats activate line is yellow-bold class only for that copy', () => {
  assert.equal(isCongratsActivateMessage('user@test：恭喜你,开通成功'), true);
  assert.equal(isCongratsActivateMessage('user@test：开通完成（Plus）'), false);
  assert.deepEqual(
    logLineClassNames({ level: 'success', message: 'a@b：恭喜你,开通成功' }),
    ['log-line--success', 'log-line--congrats'],
  );
  assert.deepEqual(
    logLineClassNames({ level: 'info', message: '跟随商户回跳 URL' }),
    ['log-line--info'],
  );
});

test('congrats register line is yellow-bold and does not recolor other OK rows', () => {
  assert.equal(isCongratsRegisterMessage('user@test：恭喜你,注册成功!'), true);
  assert.equal(isCongratsRegisterMessage('user@test：注册成功，耗时 12s'), false);
  assert.deepEqual(
    logLineClassNames({ level: 'success', message: 'a@b：恭喜你,注册成功!' }),
    ['log-line--success', 'log-line--congrats'],
  );
  assert.deepEqual(
    logLineClassNames({ level: 'success', message: 'a@b：二次验证已经打开啦' }),
    ['log-line--success'],
  );
  assert.equal(logLevelText('success', 'register'), '成功');
  assert.equal(logLevelText('success', 'activate'), 'OK');
  assert.equal(logSourceText('register', 'register'), '注册');
  assert.equal(logSourceText('rebind', 'account'), '换绑');
  assert.equal(logSourceText('activate', 'activate'), 'activate');
});
