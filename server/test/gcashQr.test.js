'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractGcashQr,
  extractQrFromHtml,
  isImageUrl,
  isQrImageValue,
  isAdyenRedirectUrl,
  isPlaceholderQrValue,
  imageLooksLikeQr,
  looksLikeQrPayload,
  isGcashShortCode,
} = require('../src/utils/gcashQr');

const FIXTURE_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const ADYEN_REDIRECT = 'https://checkoutshopper-live.adyen.com/checkoutshopper/checkoutPaymentRedirect?redirectData=fixture';
const LOADER_URL = 'https://m.gcash.com/gcashapp/gcash-merchants-auth/src/assets/gcat_loader.png';
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function sessionFromPages(pages) {
  const calls = [];
  return {
    calls,
    request: async (url, opts = {}) => {
      calls.push({ url: String(url), method: String(opts.method || 'GET').toUpperCase() });
      const page = pages.shift();
      if (!page) {
        return { status: 404, headers: { 'content-type': 'text/plain' }, text: 'missing', url: String(url) };
      }
      return {
        status: page.status || 200,
        headers: page.headers || { 'content-type': page.contentType || 'text/html' },
        text: page.text || '',
        data: page.data,
        buffer: page.buffer,
        url: page.url || String(url),
      };
    },
  };
}

test('Adyen HTML fixture extracts a data URL QR', () => {
  const html = `
    <html><body>
      <div class="adyen-checkout__qr-code">
        <img class="adyen-checkout__qr-code__image" alt="QR Code" src="${FIXTURE_PNG}" />
      </div>
    </body></html>
  `;
  const extracted = extractQrFromHtml(html);
  assert.equal(extracted, FIXTURE_PNG);
  assert.equal(isQrImageValue(extracted), true);
});

test('Adyen JSON action qrCodeData is preferred over the redirect URL', () => {
  const html = `
    <html><body>
      <script type="application/json">{"action":{"type":"qrCode","paymentMethodType":"gcash","qrCodeData":"00020101021226580014com.gcash.www0111payload"}}</script>
      <a href="${ADYEN_REDIRECT}">continue</a>
    </body></html>
  `;
  const extracted = extractQrFromHtml(html);
  assert.match(extracted, /^000201/);
  assert.equal(isAdyenRedirectUrl(extracted), false);
  assert.equal(isImageUrl(ADYEN_REDIRECT), false);
  assert.equal(isQrImageValue(ADYEN_REDIRECT), false);
});

test('extractGcashQr turns Adyen HTML fixture into a data URL', async () => {
  const html = `<html><body><img class="adyen-checkout__qr-code__image" src="${FIXTURE_PNG}" alt="QR" /></body></html>`;
  const session = sessionFromPages([{ text: html }]);
  const result = await extractGcashQr({ session, url: ADYEN_REDIRECT });
  assert.equal(result.qr, FIXTURE_PNG);
  assert.equal(result.missing_qr, false);
  assert.equal(result.link, ADYEN_REDIRECT);
  assert.equal(session.calls.length, 1);
});

test('extractGcashQr generates a PNG from Adyen qrCodeData', async () => {
  const html = `<html><body><script>const action={"type":"qrCode","qrCodeData":"00020101021226580014com.gcash.www0111payload"};</script></body></html>`;
  const session = sessionFromPages([{ text: html }]);
  const result = await extractGcashQr({ session, url: ADYEN_REDIRECT });
  assert.match(result.qr, /^data:image\/png;base64,/);
  assert.equal(result.missing_qr, false);
});

test('redirect HTML without QR is not a complete success', async () => {
  const logs = [];
  const session = sessionFromPages([{ text: '<html><body><p>Redirecting to GCash</p></body></html>' }]);
  const result = await extractGcashQr({
    session,
    url: ADYEN_REDIRECT,
    emit: (_step, message) => logs.push(String(message)),
  });
  assert.equal(result.qr, '');
  assert.equal(result.missing_qr, true);
  assert.ok(logs.some((line) => /已有跳转链但未抽到二维码/.test(line)));
  assert.equal(logs.some((line) => /redirectData=/.test(line)), false);
});

test('GCash loader and other placeholder assets are never treated as QR', () => {
  const html = `
    <html><body>
      <img class="gcash-qr" src="${LOADER_URL}" alt="GCash QR" />
      <img src="https://m.gcash.com/assets/spinner.gif" />
      <img src="https://m.gcash.com/assets/placeholder.png" />
    </body></html>
  `;
  assert.equal(isPlaceholderQrValue(LOADER_URL), true);
  assert.equal(isImageUrl(LOADER_URL), false);
  assert.equal(isQrImageValue(LOADER_URL), false);
  assert.equal(isImageUrl('https://m.gcash.com/assets/spinner.gif'), false);
  assert.equal(isImageUrl('https://m.gcash.com/assets/placeholder.png'), false);
  assert.equal(extractQrFromHtml(html), '');
  assert.equal(imageLooksLikeQr(TINY_PNG), false);
});

test('loader HTML plus a real QR keeps the real code', () => {
  const html = `
    <html><body>
      <img src="${LOADER_URL}" class="loader" />
      <img class="adyen-checkout__qr-code__image" alt="QR Code" src="${FIXTURE_PNG}" />
    </body></html>
  `;
  assert.equal(extractQrFromHtml(html), FIXTURE_PNG);
});

test('extractGcashQr waits past the GCash loader then keeps the real QR', async () => {
  const loaderHtml = `<html><body><img class="gcash-qr" src="${LOADER_URL}" /></body></html>`;
  const qrHtml = `<html><body><img class="adyen-checkout__qr-code__image" src="${FIXTURE_PNG}" /></body></html>`;
  const session = sessionFromPages([{ text: loaderHtml }, { text: qrHtml }]);
  const logs = [];
  const result = await extractGcashQr({
    session,
    url: 'https://m.gcash.com/gcashapp/gcash-merchants-auth',
    emit: (_step, message) => logs.push(String(message)),
    sleep: async () => {},
  });
  assert.equal(result.qr, FIXTURE_PNG);
  assert.equal(result.missing_qr, false);
  assert.equal(result.qr.includes('gcat_loader'), false);
  assert.ok(logs.some((line) => /继续等待/.test(line)));
  assert.equal(session.calls.length >= 2, true);
});

test('extractGcashQr never stores the GCash loader as a successful code', async () => {
  const loaderHtml = `<html><body><img class="gcash-qr" src="${LOADER_URL}" /></body></html>`;
  const session = sessionFromPages(Array.from({ length: 8 }, () => ({ text: loaderHtml })));
  const result = await extractGcashQr({
    session,
    url: 'https://m.gcash.com/gcashapp/gcash-merchants-auth',
    sleep: async () => {},
  });
  assert.equal(result.qr, '');
  assert.equal(result.missing_qr, true);
  assert.equal(String(result.qr).includes('gcat_loader'), false);
});

test('tiny downloaded PNG is rejected as a placeholder, not a QR', async () => {
  const html = '<html><body><img src="https://checkoutshopper-live.adyen.com/checkoutshopper/images/qr.png" alt="QR" /></body></html>';
  const session = sessionFromPages([
    { text: html },
    { headers: { 'content-type': 'image/png' }, buffer: TINY_PNG },
  ]);
  const result = await extractGcashQr({
    session,
    url: ADYEN_REDIRECT,
    sleep: async () => {},
  });
  assert.equal(result.qr, '');
  assert.equal(result.missing_qr, true);
});

test('rendered canvas QR is preferred over the GCash loader', async () => {
  const session = sessionFromPages([
    { text: `<html><body><img src="${LOADER_URL}" /><canvas width="180" height="180"></canvas></body></html>` },
  ]);
  session.evaluate = async () => FIXTURE_PNG;
  const result = await extractGcashQr({
    session,
    url: 'https://m.gcash.com/gcashapp/gcash-merchants-auth',
    sleep: async () => {},
  });
  assert.equal(result.qr, FIXTURE_PNG);
  assert.equal(result.missing_qr, false);
});

test('loader page with an auto-submit form follows the hop instead of waiting in place', async () => {
  const formHtml = `
    <html><body>
      <img src="${LOADER_URL}" />
      <form method="POST" action="https://checkoutshopper-live.adyen.com/checkoutshopper/pay">
        <input type="hidden" name="redirectResult" value="fixture" />
      </form>
    </body></html>
  `;
  const qrHtml = `<html><body><img class="adyen-checkout__qr-code__image" src="${FIXTURE_PNG}" /></body></html>`;
  const session = sessionFromPages([{ text: formHtml }, { text: qrHtml }]);
  const logs = [];
  const result = await extractGcashQr({
    session,
    url: ADYEN_REDIRECT,
    emit: (_step, message) => logs.push(String(message)),
    sleep: async () => {},
  });
  assert.equal(result.qr, FIXTURE_PNG);
  assert.equal(session.calls[1].method, 'POST');
  assert.ok(logs.some((line) => /跟随下一跳/.test(line)));
  assert.equal(logs.some((line) => /继续等待/.test(line)), false);
});

test('Adyen auto-submit form is followed on the same session before reading QR', async () => {
  const formHtml = `
    <html><body>
      <form method="POST" action="https://checkoutshopper-live.adyen.com/checkoutshopper/pay">
        <input type="hidden" name="redirectResult" value="fixture" />
      </form>
    </body></html>
  `;
  const qrHtml = `<html><body><img class="adyen-checkout__qr-code__image" src="${FIXTURE_PNG}" /></body></html>`;
  const session = sessionFromPages([{ text: formHtml }, { text: qrHtml }]);
  const result = await extractGcashQr({ session, url: ADYEN_REDIRECT });
  assert.equal(result.qr, FIXTURE_PNG);
  assert.equal(session.calls[1].method, 'POST');
  assert.match(session.calls[1].url, /\/checkoutshopper\/pay$/);
});

test('GCSHLNKV short codes and short.dynamic.link count as QR payloads', () => {
  assert.equal(isGcashShortCode('GCSHLNKVabcdefgh'), true);
  assert.equal(looksLikeQrPayload('GCSHLNKVabcdefgh'), true);
  assert.equal(looksLikeQrPayload('https://short.dynamic.link/GCSHLNKVabcdefgh'), true);
  assert.equal(looksLikeQrPayload('https://m.gcash.com/gcashapp/gcash-merchants-auth/src/assets/gcat_loader.png'), false);
});
