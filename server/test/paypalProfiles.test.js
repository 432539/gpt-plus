'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  paypalProfile,
  resolvePaypalProfile,
  wiredPaypalChannelIds,
  PAYPAL_MONITOR_CHANNELS,
} = require('../src/utils/paypalProfiles');

test('special PayPal profiles match the reference defaults', () => {
  const uk = paypalProfile('paypal_uk');
  assert.equal(uk.billingCountry, 'GB');
  assert.equal(uk.currency, 'GBP');
  assert.equal(uk.checkoutCountry, 'GB');
  assert.equal(uk.uiMode, 'custom');

  const th = paypalProfile('paypal_th');
  assert.equal(th.billingCountry, 'DE');
  assert.equal(th.currency, 'EUR');
  assert.equal(th.checkoutCountry, 'TH');
  assert.equal(th.updateCountry, 'TH');

  const hosted = paypalProfile('paypal_hosted');
  assert.equal(hosted.billingCountry, 'BR');
  assert.equal(hosted.currency, 'BRL');
  assert.equal(hosted.uiMode, 'hosted');
  assert.equal(hosted.checkoutCountry, 'BR');

  const generic = paypalProfile('paypal');
  assert.equal(generic.billingCountry, 'DE');
  assert.equal(generic.currency, 'EUR');
  assert.equal(generic.checkoutCountry, 'BR');
  assert.equal(generic.updateCountry, 'TR');
});

test('curated PayPal countries are independent channels and not a 50-country scan', () => {
  const ids = wiredPaypalChannelIds();
  assert.ok(ids.includes('paypal_us'));
  assert.ok(ids.includes('paypal_jp'));
  assert.equal(ids.includes('paypal_cy'), false);
  assert.ok(PAYPAL_MONITOR_CHANNELS.length >= 12);
  assert.ok(PAYPAL_MONITOR_CHANNELS.length <= 20);
  const us = paypalProfile('paypal_us');
  assert.equal(us.billingCountry, 'US');
  assert.equal(us.checkoutCountry, 'US');
  assert.equal(us.updateCountry, 'TR');
  assert.equal(resolvePaypalProfile('paypal_th').checkoutCountry, 'TH');
});
