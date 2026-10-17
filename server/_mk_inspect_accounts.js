'use strict';

const Database = require('better-sqlite3');
const db = new Database('C:\\Users\\Administrator\\Desktop\\gpt-plus\\server\\data\\app.prod-sync.db', { readonly: true });

const prefixes = ['otp412e1', 'otpa7969', 'otp93b32'];
for (const prefix of prefixes) {
  const rows = db.prepare(`
    SELECT id, user_id, substr(email,1,8) AS prefix, progress, plan_type, rebind_status,
           extract_attempts, CASE WHEN access_token IS NULL OR access_token='' THEN 0 ELSE 1 END AS has_at,
           CASE WHEN refresh_token IS NULL OR refresh_token='' THEN 0 ELSE 1 END AS has_rt,
           CASE WHEN gcash_link IS NULL OR gcash_link='' THEN 0 ELSE 1 END AS has_link,
           CASE WHEN gcash_qr IS NULL OR gcash_qr='' THEN 0 ELSE 1 END AS has_qr,
           extract_attempted_at, extract_failed_at, gcash_extracted_at
    FROM gpt_accounts WHERE email LIKE ? LIMIT 1
  `).get(`${prefix}%`);
  console.log('ACCOUNT', JSON.stringify(row));
  const logs = db.prepare(`
    SELECT level, substr(message,1,200) AS msg, created_at
    FROM operation_logs
    WHERE message LIKE ?
      AND (message LIKE '%ERROR%' OR message LIKE '%error%' OR message LIKE '%retry%'
        OR message LIKE '%confirm%' OR message LIKE '%start_payment%' OR message LIKE '%success%'
        OR message LIKE '%GCASH%' OR message LIKE '%HTTP%' OR message LIKE '%开始 MK%')
    ORDER BY id DESC
    LIMIT 12
  `).all(`%${prefix}%`);
  console.log('EVENTS', JSON.stringify(logs, null, 2));
}
