import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  REGISTER_STATUS_LABELS,
  defaultRegisterConcurrency,
  registrationPayload,
  accountRtPayload,
  preferRegisterGroup,
  preferPayGroup,
  resolveRegisterProxyGroup,
  registerProxyChoices,
  smsRegistrationProxyFor,
  splitMailMix,
  DEFAULT_REGISTER_PROXY_GROUP,
  DEFAULT_RT_PHONE_COUNTRY,
  DEFAULT_RT_PROXY_COUNTRY,
} from '../src/utils/registerUi.js';

test('registration UI exposes every terminal and active status in Chinese', () => {
  assert.deepEqual(
    ['queued', 'running', 'success', 'failed', 'partial', 'skipped', 'cancelled']
      .map(status => REGISTER_STATUS_LABELS[status]),
    ['排队', '运行中', '成功', '失败', '部分完成', '已跳过', '已取消'],
  );
});

test('register dialog default concurrency follows Cloak max instead of sticky 1', () => {
  assert.equal(defaultRegisterConcurrency(5), 5);
  assert.equal(defaultRegisterConcurrency(2), 2);
  assert.equal(defaultRegisterConcurrency(1), 1);
  assert.equal(defaultRegisterConcurrency(0), 3);
});

test('registration UI builds a complete deterministic start payload', () => {
  const payload = registrationPayload({
    count: 300,
    concurrency: 4,
    mail_provider: 'herosms',
    mail_domain: 'outlook.com',
    proxy_group: '__auto__:JP',
    phone_country: 'BR',
    phone_max_price: '0.22',
    set_password: true,
    enable_totp_2fa: true,
    get_refresh_token: true,
    register_mode: 'headless_click',
    performance_profile: 'throughput',
    visible: true,
    humanize: true,
    attempts: 9,
    email_timeout_seconds: 60,
  });
  assert.equal(payload.quantity, 300);
  assert.equal(payload.concurrency, 4);
  assert.equal(payload.mail_provider, 'herosms');
  assert.equal(payload.get_refresh_token, false);
  assert.equal(payload.phone_country, undefined);
  assert.equal(payload.phone_max_price, undefined);
  assert.equal(payload.register_mode, 'headless_click');
  assert.equal(payload.performance_profile, 'throughput');
  assert.equal(payload.headless, false);
  assert.equal(payload.humanize, true);
  assert.equal(payload.attempts, 3);
  assert.equal(payload.email_timeout_ms, 60000);
});

test('registration payload defaults proxy, headless click, and never sends unused fields', () => {
  const payload = registrationPayload({ count: 1 });
  assert.equal(payload.proxy_group, DEFAULT_REGISTER_PROXY_GROUP);
  assert.equal(DEFAULT_REGISTER_PROXY_GROUP, '__auto__:GB');
  assert.equal(payload.mail_provider, 'mailcom');
  assert.equal(payload.register_mode, 'headless_click');
  assert.equal(payload.get_refresh_token, false);
  assert.equal(payload.humanize, true);
  assert.equal(payload.phone_country, undefined);
  assert.equal(payload.imported_mailboxes, undefined);
  assert.equal(registrationPayload({ count: 2001 }).quantity, 2000);
  assert.equal(registrationPayload({ register_mode: 'protocol' }).register_mode, 'protocol');
});

test('registration payload keeps Mailpit when selected', () => {
  const payload = registrationPayload({ count: 2, mail_provider: 'mailpit' });
  assert.equal(payload.mail_provider, 'mailpit');
  assert.equal(payload.mailcom_share, undefined);
  assert.equal(payload.cfworker_share, undefined);
});

test('splitMailMix matches server 5:5 and 3:7 splits', () => {
  assert.deepEqual(splitMailMix(100, 5, 5), { mailcom: 50, cfworker: 50 });
  assert.deepEqual(splitMailMix(100, 3, 7), { mailcom: 30, cfworker: 70 });
  assert.deepEqual(splitMailMix(10, 5, 5), { mailcom: 5, cfworker: 5 });
  assert.deepEqual(splitMailMix(11, 5, 5), { mailcom: 5, cfworker: 6 });
});

test('account RT payload keeps proxy and phone countries independent', () => {
  const payload = accountRtPayload({
    proxy_group: '__auto__:JP',
    proxy_country: 'JP',
    phone_country: 'US',
    concurrency: 9,
    phone_max_price: '0.42',
    visible: true,
    performance_profile: 'throughput',
  }, [7, 8], 5);
  assert.deepEqual(payload.ids, [7, 8]);
  assert.equal(payload.proxy_group, '__auto__:JP');
  assert.equal(payload.proxy_country, 'JP');
  assert.equal(payload.phone_country, 'US');
  assert.equal(payload.concurrency, 5);
  assert.equal(payload.phone_max_price, 0.42);
  assert.equal(payload.headless, false);
});

test('account RT payload defaults to GB proxy and Chile phone', () => {
  const payload = accountRtPayload({}, [3], 2);
  assert.equal(DEFAULT_RT_PROXY_COUNTRY, 'GB');
  assert.equal(DEFAULT_RT_PHONE_COUNTRY, 'CL');
  assert.equal(payload.proxy_country, 'GB');
  assert.equal(payload.phone_country, 'CL');
  assert.equal(payload.proxy_group, '__auto__:GB');
  assert.equal(accountRtPayload({ force: true }, [3], 1).force, true);
});

test('registration UI prefers 注册/JP groups for named lookup but empty request defaults to GB auto', () => {
  const groups = [{ group_name: '支付 GB', count: 4 }, { group_name: '注册 JP', count: 8 }, { group_name: '邮箱', count: 2 }];
  assert.equal(preferRegisterGroup(groups), '注册 JP');
  assert.equal(preferPayGroup(groups), '支付 GB');
  assert.equal(preferRegisterGroup([{ group_name: '支付 GB', count: 4 }, { group_name: '邮箱', count: 2 }]), DEFAULT_REGISTER_PROXY_GROUP);
  assert.equal(preferRegisterGroup([{ group_name: '支付 GB', count: 1 }]), DEFAULT_REGISTER_PROXY_GROUP);
  assert.equal(resolveRegisterProxyGroup('', groups), DEFAULT_REGISTER_PROXY_GROUP);
  assert.equal(resolveRegisterProxyGroup('  ', []), DEFAULT_REGISTER_PROXY_GROUP);
  assert.equal(resolveRegisterProxyGroup('__auto__:US', groups), '__auto__:US');
  assert.equal(smsRegistrationProxyFor('GB'), '__auto__:GB');
  assert.equal(smsRegistrationProxyFor('JP'), '__auto__:JP');
  assert.equal(smsRegistrationProxyFor(''), DEFAULT_REGISTER_PROXY_GROUP);
});

test('register proxy choices list configured auto pools before leftover groups', () => {
  const choices = registerProxyChoices(
    [{ group_name: '支付 GB', count: 3 }, { group_name: '注册 JP', count: 2 }],
    { active_pool: 'iprocket', configured: true },
  );
  assert.equal(choices[0].value, '__auto__:JP');
  assert.equal(choices[1].value, '__auto__:GB');
  assert.match(choices[0].label, /IPRocket/);
  assert.ok(choices.some(item => item.value === '__auto__:GB'));
  assert.ok(choices.some(item => item.value === '注册 JP'));
  assert.ok(!choices.some(item => item.value === '支付 GB' || item.value === ''));
});

test('Accounts DOM keeps mail.com/Mailpit register form and exposes humanize', () => {
  const source = readFileSync(new URL('../src/views/Accounts.vue', import.meta.url), 'utf8');
  const operations = source.slice(source.indexOf(':show="operationDialog"'), source.indexOf(':show="regDialog"'));
  const registration = source.slice(source.indexOf(':show="regDialog"'), source.indexOf(':show="rtDialog"'));
  const accountRt = source.slice(source.indexOf(':show="rtDialog"'), source.indexOf('</template>'));
  assert.doesNotMatch(source, /账号总数/);
  assert.doesNotMatch(source, /注册 \/ 获取 RT 批次/);
  assert.doesNotMatch(source, /class="reg-progress"/);
  assert.match(source, /pipeline-toggles/);
  assert.match(source, /startRowAcquireRt/);
  assert.match(source, />拿RT</);
  assert.doesNotMatch(operations, /邮箱供应商|mailOptions/);
  assert.match(registration, /mail\.com 子号/);
  assert.match(registration, /mail\.com \+ CF 按比例/);
  assert.doesNotMatch(registration, /mail\.com 份数/);
  assert.doesNotMatch(registration, /mixPreview/);
  assert.doesNotMatch(registration, /HeroSMS|SMSBower|CF Worker|邮箱列表 \/ 邮箱池/);
  assert.doesNotMatch(registration, /手机国家|单号最高价|Refresh Token|请选择注册代理/);
  assert.match(registration, /拟人化/);
  assert.match(registration, /动态代理：PH 菲律宾（CliProxy）/);
  assert.match(registration, /动态代理：GB 英国（CliProxy）/);
  assert.match(registration, /稳定模式只放慢页面操作/);
  assert.match(registration, /max="2000"/);
  assert.match(registration, /无头模拟点击/);
  assert.match(registration, /region-GB/);
  assert.doesNotMatch(registration, /不要用支付\/GB/);
  assert.match(accountRt, /:value="isGc \? 'PH' : 'GB'"/);
  assert.match(accountRt, /v-model="rtForm\.phone_country"/);
});
