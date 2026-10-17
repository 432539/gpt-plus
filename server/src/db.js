const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const config = require('./config');

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

const db = new Database(config.dbPath);

// WAL 模式提升读写并发,busy_timeout 避免写锁冲突直接报错
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  level INTEGER NOT NULL DEFAULT 1,
  max_accounts INTEGER NOT NULL DEFAULT 5,
  max_emails INTEGER NOT NULL DEFAULT 5,
  duration_days INTEGER NOT NULL DEFAULT 30,
  remark TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  level INTEGER NOT NULL DEFAULT 1,
  plan_id INTEGER REFERENCES plans(id) ON DELETE SET NULL,
  plan_expires_at TEXT,
  status INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS gpt_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  password_enc TEXT DEFAULT '',
  email_type TEXT NOT NULL DEFAULT 'gmail',
  plan_type TEXT NOT NULL DEFAULT 'Free',
  status TEXT NOT NULL DEFAULT '未检测',
  expires_at TEXT,
  remark TEXT DEFAULT '',
  access_token TEXT DEFAULT '',
  refresh_token TEXT DEFAULT '',
  id_token TEXT DEFAULT '',
  session_token TEXT DEFAULT '',
  client_id TEXT DEFAULT '',
  client_secret TEXT DEFAULT '',
  chatgpt_account_id TEXT DEFAULT '',
  vmail_id TEXT DEFAULT '',
  vmail_token TEXT DEFAULT '',
  gmail_access_token TEXT DEFAULT '',
  gmail_refresh_token TEXT DEFAULT '',
  gmail_client_id TEXT DEFAULT '',
  gmail_client_secret TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_gpt_accounts_user ON gpt_accounts(user_id);

CREATE TABLE IF NOT EXISTS emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  address TEXT NOT NULL,
  password_enc TEXT DEFAULT '',
  provider TEXT DEFAULT '',
  usage TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  remark TEXT DEFAULT '',
  label TEXT DEFAULT '',
  fetch_url TEXT DEFAULT '',
  mailbox_type TEXT DEFAULT 'password',
  client_id TEXT DEFAULT '',
  refresh_token TEXT DEFAULT '',
  last_check TEXT DEFAULT '',
  last_result TEXT DEFAULT '',
  mother_id INTEGER,
  is_mother INTEGER NOT NULL DEFAULT 0,
  used_at TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_emails_user ON emails(user_id);

-- mail.com 收件缓存(历史邮件)
CREATE TABLE IF NOT EXISTS email_mails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email_id INTEGER NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  mail_uid TEXT NOT NULL,
  subject TEXT DEFAULT '',
  from_addr TEXT DEFAULT '',
  to_addr TEXT DEFAULT '',
  mail_date TEXT DEFAULT '',
  body TEXT DEFAULT '',
  fetched_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  UNIQUE(email_id, mail_uid)
);
CREATE INDEX IF NOT EXISTS idx_email_mails_email ON email_mails(email_id);

-- 每个用户一行,敏感配置(license/接码密钥)加密后整体存 data_enc
CREATE TABLE IF NOT EXISTS user_settings (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data_enc TEXT DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- 代理池:按用户隔离,支持分组
CREATE TABLE IF NOT EXISTS proxies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_name TEXT NOT NULL DEFAULT '默认分组',
  name TEXT DEFAULT '',
  proxy_type TEXT NOT NULL DEFAULT 'http',
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  username TEXT DEFAULT '',
  password_enc TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT '可用',
  latency INTEGER,
  region TEXT DEFAULT '',
  remark TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_proxies_user ON proxies(user_id);

-- 业务运行日志(拉子号 / 注册 / 提链 / 开通)
CREATE TABLE IF NOT EXISTS operation_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'info',
  source TEXT DEFAULT '',
  ref TEXT DEFAULT '',
  run_id TEXT DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_operation_logs_user_cat ON operation_logs(user_id, category, id DESC);

-- 注册任务持久状态。每次运行一行，状态页读取用户最新一行。
CREATE TABLE IF NOT EXISTS registration_runs (
  run_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target INTEGER NOT NULL DEFAULT 0,
  concurrency INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0,
  success INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  retried INTEGER NOT NULL DEFAULT 0,
  running INTEGER NOT NULL DEFAULT 0,
  finished INTEGER NOT NULL DEFAULT 0,
  interrupted INTEGER NOT NULL DEFAULT 0,
  interruption_logged INTEGER NOT NULL DEFAULT 0,
  proxy_group TEXT DEFAULT '',
  message TEXT DEFAULT '',
  started_at TEXT DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  finished_at TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_registration_runs_user_started
  ON registration_runs(user_id, started_at DESC, updated_at DESC);

-- 注册批次与逐邮箱子任务。registration_runs 保留为旧状态接口的兼容投影。
CREATE TABLE IF NOT EXISTS registration_batches (
  batch_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'register',
  status TEXT NOT NULL DEFAULT 'running',
  total INTEGER NOT NULL DEFAULT 0,
  concurrency INTEGER NOT NULL DEFAULT 1,
  completed INTEGER NOT NULL DEFAULT 0,
  success INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  cancelled INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  partial INTEGER NOT NULL DEFAULT 0,
  queued INTEGER NOT NULL DEFAULT 0,
  running INTEGER NOT NULL DEFAULT 0,
  progress INTEGER NOT NULL DEFAULT 0,
  retried INTEGER NOT NULL DEFAULT 0,
  proxy_group TEXT DEFAULT '',
  message TEXT DEFAULT '',
  circuit_code TEXT DEFAULT '',
  circuit_count INTEGER NOT NULL DEFAULT 0,
  circuit_triggered INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  finished_at TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_registration_batches_user_created
  ON registration_batches(user_id, created_at DESC, updated_at DESC);

CREATE TABLE IF NOT EXISTS registration_jobs (
  job_id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES registration_batches(batch_id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'register',
  account_id INTEGER REFERENCES gpt_accounts(id) ON DELETE SET NULL,
  email_id INTEGER REFERENCES emails(id) ON DELETE SET NULL,
  email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  progress INTEGER NOT NULL DEFAULT 0,
  attempt INTEGER NOT NULL DEFAULT 0,
  capacity_attempt INTEGER NOT NULL DEFAULT 0,
  error_code TEXT DEFAULT '',
  error TEXT DEFAULT '',
  result TEXT DEFAULT '',
  partial INTEGER NOT NULL DEFAULT 0,
  settlement_provider TEXT DEFAULT '',
  settlement_id TEXT DEFAULT '',
  settlement_action TEXT DEFAULT '',
  settlement_status TEXT NOT NULL DEFAULT 'none',
  settlement_error_code TEXT DEFAULT '',
  settlement_error TEXT DEFAULT '',
  settlement_retry_at TEXT DEFAULT '',
  started_at TEXT DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  finished_at TEXT DEFAULT '',
  UNIQUE(batch_id, email)
);
CREATE INDEX IF NOT EXISTS idx_registration_jobs_batch_status
  ON registration_jobs(batch_id, status, job_id);
CREATE INDEX IF NOT EXISTS idx_registration_jobs_user_updated
  ON registration_jobs(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS registration_settlements (
  settlement_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES registration_jobs(job_id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL,
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL,
  action TEXT NOT NULL DEFAULT 'cancel',
  status TEXT NOT NULL DEFAULT 'open',
  error_code TEXT DEFAULT '',
  error TEXT DEFAULT '',
  retry_at TEXT DEFAULT '',
  claim_token TEXT DEFAULT '',
  claim_until TEXT DEFAULT '',
  settle_attempt INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  UNIQUE(job_id, resource_type, external_id)
);
CREATE INDEX IF NOT EXISTS idx_registration_settlements_pending
  ON registration_settlements(status, retry_at);

-- mail.com 登录态(sid/token)加密缓存,避免轮询每次 POST /login
CREATE TABLE IF NOT EXISTS mailcom_sessions (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mother_key TEXT NOT NULL,
  payload_enc TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  PRIMARY KEY (user_id, mother_key)
);

-- 已传送普通号 / 已上架 PLUS，不含 AT/RT
CREATE TABLE IF NOT EXISTS account_syncs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  kind TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  price_yuan TEXT NOT NULL DEFAULT '',
  remote_ok INTEGER NOT NULL DEFAULT 0,
  remote_id TEXT NOT NULL DEFAULT '',
  synced_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_account_syncs_user_kind ON account_syncs(user_id, kind, id DESC);
`);

// 迁移:为已存在的旧库补齐新增列(幂等)
function migrate() {
  const cols = db.prepare('PRAGMA table_info(gpt_accounts)').all().map((c) => c.name);
  const hadPlanType = cols.includes('plan_type');
  const addColumn = (name, ddl) => {
    if (!cols.includes(name)) db.exec(`ALTER TABLE gpt_accounts ADD COLUMN ${ddl}`);
  };
  addColumn('email_type', "email_type TEXT NOT NULL DEFAULT 'gmail'");
  addColumn('plan_type', "plan_type TEXT NOT NULL DEFAULT 'Free'");
  addColumn('access_token', "access_token TEXT DEFAULT ''");
  addColumn('refresh_token', "refresh_token TEXT DEFAULT ''");
  addColumn('id_token', "id_token TEXT DEFAULT ''");
  addColumn('session_token', "session_token TEXT DEFAULT ''");
  addColumn('client_id', "client_id TEXT DEFAULT ''");
  addColumn('client_secret', "client_secret TEXT DEFAULT ''");
  addColumn('chatgpt_account_id', "chatgpt_account_id TEXT DEFAULT ''");
  addColumn('vmail_id', "vmail_id TEXT DEFAULT ''");
  addColumn('vmail_token', "vmail_token TEXT DEFAULT ''");
  addColumn('gmail_access_token', "gmail_access_token TEXT DEFAULT ''");
  addColumn('gmail_refresh_token', "gmail_refresh_token TEXT DEFAULT ''");
  addColumn('gmail_client_id', "gmail_client_id TEXT DEFAULT ''");
  addColumn('gmail_client_secret', "gmail_client_secret TEXT DEFAULT ''");
  addColumn('totp_secret_enc', "totp_secret_enc TEXT DEFAULT ''");
  addColumn('mfa_factor_id', "mfa_factor_id TEXT DEFAULT ''");
  addColumn('mfa_factor_type', "mfa_factor_type TEXT DEFAULT ''");
  addColumn('mfa_enabled', 'mfa_enabled INTEGER NOT NULL DEFAULT 0');
  addColumn('password_set', 'password_set INTEGER NOT NULL DEFAULT 0');
  addColumn('security_ready', 'security_ready INTEGER NOT NULL DEFAULT 0');
  addColumn('hardening_status', "hardening_status TEXT DEFAULT ''");
  addColumn('hardening_error_code', "hardening_error_code TEXT DEFAULT ''");
  addColumn('hardening_error', "hardening_error TEXT DEFAULT ''");
  addColumn('hardening_updated_at', "hardening_updated_at TEXT DEFAULT ''");
  addColumn('mfa_enrolled_at', "mfa_enrolled_at TEXT DEFAULT ''");
  addColumn('last_detected_at', "last_detected_at TEXT DEFAULT ''");
  addColumn('last_refresh_at', "last_refresh_at TEXT DEFAULT ''");
  addColumn('last_security_state', "last_security_state TEXT DEFAULT ''");
  addColumn('token_invalidated', 'token_invalidated INTEGER NOT NULL DEFAULT 0');
  addColumn('has_trial', 'has_trial INTEGER');
  // Register checkpoints used to coerce unknown trial to '', which hid 未检测 from IS NULL polls.
  db.exec(`UPDATE gpt_accounts SET has_trial = NULL WHERE typeof(has_trial) = 'text' AND trim(has_trial) = ''`);
  addColumn('trial_label', "trial_label TEXT DEFAULT ''");
  addColumn('progress', "progress TEXT DEFAULT ''");
  addColumn('extract_link', "extract_link TEXT DEFAULT ''");
  addColumn('extracted_at', "extracted_at TEXT DEFAULT ''");
  addColumn('activated_at', "activated_at TEXT DEFAULT ''");
  addColumn('extract_failed_at', "extract_failed_at TEXT DEFAULT ''");
  addColumn('activation_retry_after_free_rt', 'activation_retry_after_free_rt INTEGER NOT NULL DEFAULT 0');
  addColumn('extract_attempts', 'extract_attempts INTEGER NOT NULL DEFAULT 0');
  addColumn('skip_platform_sync', 'skip_platform_sync INTEGER NOT NULL DEFAULT 0');
  addColumn('pay_attempts', 'pay_attempts INTEGER NOT NULL DEFAULT 0');
  addColumn('rt_attempts', 'rt_attempts INTEGER NOT NULL DEFAULT 0');
  addColumn('extract_attempted_at', "extract_attempted_at TEXT DEFAULT ''");
  addColumn('nvtokens_listed_at', "nvtokens_listed_at TEXT DEFAULT ''");
  addColumn('nvtokens_list_attempts', 'nvtokens_list_attempts INTEGER NOT NULL DEFAULT 0');
  addColumn('monitor_pool', 'monitor_pool INTEGER NOT NULL DEFAULT 0');
  addColumn('monitor_cool_until', "monitor_cool_until TEXT DEFAULT ''");
  addColumn('channel', "channel TEXT NOT NULL DEFAULT 'gb'");
  addColumn('gcash_link', "gcash_link TEXT DEFAULT ''");
  addColumn('gcash_qr', "gcash_qr TEXT DEFAULT ''");
  addColumn('gcash_cs_id', "gcash_cs_id TEXT DEFAULT ''");
  addColumn('gcash_extracted_at', "gcash_extracted_at TEXT DEFAULT ''");
  addColumn('original_email', "original_email TEXT DEFAULT ''");
  addColumn('rebind_email', "rebind_email TEXT DEFAULT ''");
  addColumn('rebind_status', "rebind_status TEXT DEFAULT ''");
  addColumn('rebind_error', "rebind_error TEXT DEFAULT ''");
  addColumn('rebind_attempts', 'rebind_attempts INTEGER NOT NULL DEFAULT 0');
  addColumn('rebind_attempted_at', "rebind_attempted_at TEXT DEFAULT ''");
  addColumn('rebind_done_at', "rebind_done_at TEXT DEFAULT ''");
  db.exec(`UPDATE gpt_accounts SET channel = 'gb' WHERE channel IS NULL OR trim(channel) = ''`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_gpt_accounts_user_channel ON gpt_accounts(user_id, channel)');
  db.exec(`UPDATE gpt_accounts SET monitor_pool = 0 WHERE COALESCE(channel, 'gb') = 'gc' AND COALESCE(monitor_pool, 0) != 0`);

  const extractedNow = new Date().toISOString().replace('T', ' ').slice(0, 19);
  db.prepare(
    `UPDATE gpt_accounts
     SET extracted_at = ?
     WHERE extract_link IS NOT NULL AND extract_link != ''
       AND (extracted_at IS NULL OR extracted_at = '')`
  ).run(extractedNow);
  db.exec(
    `UPDATE gpt_accounts
     SET progress = '已提链'
     WHERE extract_link IS NOT NULL AND extract_link != ''
       AND progress IN ('已支付', '已注册', '')`
  );

  // 旧库的 account_type 只在首次新增 plan_type 时迁移。若每次启动都复制，
  // 旧列的默认 Plus 会把注册边界刚写入的 Free 再次翻回 Plus。
  if (!hadPlanType && cols.includes('account_type')) {
    db.exec(`UPDATE gpt_accounts SET plan_type = account_type
             WHERE plan_type = 'Free' AND account_type IN ('Free','Plus','Pro','Team')`);
  }
  db.exec(`UPDATE gpt_accounts SET status = '正常' WHERE status = 'active'`);
  db.exec(`UPDATE gpt_accounts SET status = '已过期' WHERE status = 'disabled'`);

  // SQLite 不支持直接修改列默认值；重建代理表只调整 schema，原有状态原样保留。
  const proxyStatusCol = db.prepare('PRAGMA table_info(proxies)').all().find((c) => c.name === 'status');
  if (proxyStatusCol?.dflt_value !== "'可用'") {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE proxies_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          group_name TEXT NOT NULL DEFAULT '默认分组',
          name TEXT DEFAULT '',
          proxy_type TEXT NOT NULL DEFAULT 'http',
          host TEXT NOT NULL,
          port INTEGER NOT NULL,
          username TEXT DEFAULT '',
          password_enc TEXT DEFAULT '',
          status TEXT NOT NULL DEFAULT '可用',
          latency INTEGER,
          region TEXT DEFAULT '',
          remark TEXT DEFAULT '',
          created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
        );
        INSERT INTO proxies_new (
          id, user_id, group_name, name, proxy_type, host, port, username,
          password_enc, status, latency, region, remark, created_at
        )
        SELECT
          id, user_id, group_name, name, proxy_type, host, port, username,
          password_enc, status, latency, region, remark, created_at
        FROM proxies;
        DROP TABLE proxies;
        ALTER TABLE proxies_new RENAME TO proxies;
        CREATE INDEX idx_proxies_user ON proxies(user_id);
      `);
    })();
  }

  // emails 表补列
  const emailCols = db.prepare('PRAGMA table_info(emails)').all().map((c) => c.name);
  const addEmailCol = (name, ddl) => {
    if (!emailCols.includes(name)) db.exec(`ALTER TABLE emails ADD COLUMN ${ddl}`);
  };
  addEmailCol('label', "label TEXT DEFAULT ''");
  addEmailCol('fetch_url', "fetch_url TEXT DEFAULT ''");
  addEmailCol('mailbox_type', "mailbox_type TEXT DEFAULT 'password'");
  addEmailCol('client_id', "client_id TEXT DEFAULT ''");
  addEmailCol('refresh_token', "refresh_token TEXT DEFAULT ''");
  addEmailCol('last_check', "last_check TEXT DEFAULT ''");
  addEmailCol('last_result', "last_result TEXT DEFAULT ''");
  addEmailCol('mother_id', 'mother_id INTEGER');
  addEmailCol('is_mother', 'is_mother INTEGER NOT NULL DEFAULT 0');
  addEmailCol('used_at', "used_at TEXT DEFAULT ''");
  db.exec('CREATE INDEX IF NOT EXISTS idx_emails_mother ON emails(mother_id)');

  const logCols = db.prepare('PRAGMA table_info(operation_logs)').all().map((c) => c.name);
  if (!logCols.includes('run_id')) {
    db.exec("ALTER TABLE operation_logs ADD COLUMN run_id TEXT DEFAULT ''");
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_operation_logs_run ON operation_logs(user_id, category, run_id, id DESC)');

  const batchCols = db.prepare('PRAGMA table_info(registration_batches)').all().map((c) => c.name);
  if (!batchCols.includes('kind')) db.exec("ALTER TABLE registration_batches ADD COLUMN kind TEXT NOT NULL DEFAULT 'register'");
  const jobCols = db.prepare('PRAGMA table_info(registration_jobs)').all().map((c) => c.name);
  const addJobCol = (name, ddl) => {
    if (!jobCols.includes(name)) db.exec(`ALTER TABLE registration_jobs ADD COLUMN ${ddl}`);
  };
  addJobCol('kind', "kind TEXT NOT NULL DEFAULT 'register'");
  addJobCol('account_id', 'account_id INTEGER REFERENCES gpt_accounts(id) ON DELETE SET NULL');
  addJobCol('settlement_provider', "settlement_provider TEXT DEFAULT ''");
  addJobCol('settlement_id', "settlement_id TEXT DEFAULT ''");
  addJobCol('settlement_action', "settlement_action TEXT DEFAULT ''");
  addJobCol('settlement_status', "settlement_status TEXT NOT NULL DEFAULT 'none'");
  addJobCol('settlement_error_code', "settlement_error_code TEXT DEFAULT ''");
  addJobCol('settlement_error', "settlement_error TEXT DEFAULT ''");
  addJobCol('settlement_retry_at', "settlement_retry_at TEXT DEFAULT ''");
  const settlementCols = db.prepare('PRAGMA table_info(registration_settlements)').all().map((c) => c.name);
  const addSettlementCol = (name, ddl) => {
    if (!settlementCols.includes(name)) db.exec(`ALTER TABLE registration_settlements ADD COLUMN ${ddl}`);
  };
  addSettlementCol('claim_token', "claim_token TEXT DEFAULT ''");
  addSettlementCol('claim_until', "claim_until TEXT DEFAULT ''");
  addSettlementCol('settle_attempt', 'settle_attempt INTEGER NOT NULL DEFAULT 0');
  db.exec('CREATE INDEX IF NOT EXISTS idx_registration_jobs_settlement ON registration_jobs(settlement_status, settlement_retry_at)');

  db.exec(`
    CREATE TABLE IF NOT EXISTS account_syncs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      kind TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      price_yuan TEXT NOT NULL DEFAULT '',
      remote_ok INTEGER NOT NULL DEFAULT 0,
      remote_id TEXT NOT NULL DEFAULT '',
      synced_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_account_syncs_user_kind ON account_syncs(user_id, kind, id DESC);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS suffix_windows (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      window_kind TEXT NOT NULL,
      window_key TEXT NOT NULL,
      suffix TEXT NOT NULL,
      opened_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      PRIMARY KEY (user_id, window_kind, window_key, suffix)
    );
    CREATE INDEX IF NOT EXISTS idx_suffix_windows_lookup
      ON suffix_windows(user_id, window_kind, window_key);
  `);
  const suffixWindowCols = db.prepare('PRAGMA table_info(suffix_windows)').all().map((row) => row.name);
  if (!suffixWindowCols.includes('generated')) {
    db.exec('ALTER TABLE suffix_windows ADD COLUMN generated INTEGER NOT NULL DEFAULT 0');
  }
  if (!suffixWindowCols.includes('registered')) {
    db.exec('ALTER TABLE suffix_windows ADD COLUMN registered INTEGER NOT NULL DEFAULT 0');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS global_extract_plans (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 0,
      interval_minutes INTEGER NOT NULL DEFAULT 60,
      concurrency INTEGER NOT NULL DEFAULT 1,
      last_run_at TEXT DEFAULT '',
      next_run_at TEXT DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
    CREATE TABLE IF NOT EXISTS global_extract_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      channel_id TEXT NOT NULL,
      account_id INTEGER,
      started_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      finished_at TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT '',
      error_class TEXT DEFAULT '',
      verified_exit TEXT DEFAULT '',
      result_host TEXT DEFAULT '',
      duration_ms INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_global_extract_runs_user
      ON global_extract_runs(user_id, id DESC);
    CREATE TABLE IF NOT EXISTS global_extract_results (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      channel_id TEXT NOT NULL,
      last_status TEXT NOT NULL DEFAULT '',
      last_error_class TEXT DEFAULT '',
      last_ok_at TEXT DEFAULT '',
      last_at TEXT DEFAULT '',
      last_account_id INTEGER,
      verified_exit TEXT DEFAULT '',
      result_host TEXT DEFAULT '',
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      cooldown_until TEXT DEFAULT '',
      last_run_id INTEGER,
      PRIMARY KEY (user_id, channel_id)
    );
  `);
}
migrate();

// 种子数据:默认管理员与基础套餐
const seed = db.transaction(() => {
  const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
  if (!admin) {
    db.prepare(
      "INSERT INTO users (username, password_hash, role, level) VALUES (?, ?, 'admin', 99)"
    ).run('admin', bcrypt.hashSync('admin123', 10));
  }
  const planCount = db.prepare('SELECT COUNT(*) AS c FROM plans').get().c;
  if (planCount === 0) {
    const insert = db.prepare(
      'INSERT INTO plans (name, level, max_accounts, max_emails, duration_days, remark) VALUES (?, ?, ?, ?, ?, ?)'
    );
    insert.run('基础版', 1, 5, 5, 30, '入门套餐');
    insert.run('专业版', 2, 20, 20, 90, '进阶套餐');
    insert.run('旗舰版', 3, 100, 100, 365, '高级套餐');
  }
});
seed();

module.exports = db;
