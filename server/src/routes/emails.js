const express = require('express');
const db = require('../db');
const { encrypt, decrypt } = require('../utils/crypto');
const { checkWritable, getPlanContext } = require('../utils/plan');
const { parseEmailImport } = require('../utils/emailParser');
const { readSettings, domainAllowed } = require('../utils/settings');
const { testReceive } = require('../utils/mailReceive');
const mailcom = require('../utils/mailcomService');
const { utcStamp } = require('../utils/datetime');

const router = express.Router();

const LIST_COLS =
  'id, address, provider, usage, status, remark, label, fetch_url, mailbox_type, client_id, ' +
  'last_check, last_result, mother_id, is_mother, used_at, created_at, updated_at';

router.get('/', (req, res) => {
  const keyword = String(req.query.keyword || '').trim();
  const type = String(req.query.mailbox_type || '').trim();
  const status = String(req.query.status || '').trim();
  const where = ['user_id = ?'];
  const params = [req.user.id];
  if (keyword) {
    const like = `%${keyword}%`;
    where.push(`(
      address LIKE ? OR remark LIKE ? OR usage LIKE ? OR label LIKE ?
      OR id IN (
        SELECT DISTINCT mother_id FROM emails
        WHERE user_id = ? AND mother_id IS NOT NULL AND mother_id != 0
          AND (address LIKE ? OR remark LIKE ? OR label LIKE ?)
      )
      OR mother_id IN (
        SELECT id FROM emails
        WHERE user_id = ? AND is_mother = 1
          AND (address LIKE ? OR remark LIKE ? OR label LIKE ?)
      )
    )`);
    params.push(like, like, like, like, req.user.id, like, like, like, req.user.id, like, like, like);
  }
  if (type) {
    where.push('mailbox_type = ?');
    params.push(type);
  }
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  const rows = db
    .prepare(
      `SELECT ${LIST_COLS},
         (SELECT COUNT(*) FROM emails c WHERE c.mother_id = emails.id) AS child_count
       FROM emails WHERE ${where.join(' AND ')} ORDER BY id DESC`
    )
    .all(...params);
  res.json(rows);
});

router.get('/:id/password', (req, res) => {
  const row = db
    .prepare('SELECT password_enc, refresh_token FROM emails WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ message: '记录不存在' });
  res.json({ password: decrypt(row.password_enc), refresh_token: decrypt(row.refresh_token) });
});

function buildEmailWrite(body) {
  return {
    address: String(body.address || '').trim(),
    password: body.password || '',
    provider: body.provider || '',
    usage: body.usage || '',
    status: body.status || 'active',
    remark: body.remark || '',
    label: body.label || '',
    fetch_url: body.fetch_url || body.url || '',
    mailbox_type: body.mailbox_type || 'password',
    client_id: body.client_id || '',
    refresh_token: body.refresh_token || '',
  };
}

router.post('/', (req, res) => {
  const err = checkWritable(req.user, 'emails', true);
  if (err) return res.status(403).json({ message: err });
  const d = buildEmailWrite(req.body || {});
  if (!d.address) return res.status(400).json({ message: '邮箱地址不能为空' });
  const isMother = d.mailbox_type === 'mailcom' && d.password ? 1 : 0;
  const info = db
    .prepare(
      `INSERT INTO emails (user_id, address, password_enc, provider, usage, status, remark,
         label, fetch_url, mailbox_type, client_id, refresh_token, is_mother)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      req.user.id,
      d.address,
      encrypt(d.password),
      d.provider || (d.address.split('@')[1] || '').toLowerCase(),
      d.usage,
      isMother ? '正常' : d.status,
      d.remark,
      d.label,
      d.fetch_url,
      d.mailbox_type,
      d.client_id,
      encrypt(d.refresh_token),
      isMother
    );
  res.json({ id: info.lastInsertRowid });
});

router.put('/:id', (req, res) => {
  const err = checkWritable(req.user, 'emails', false);
  if (err) return res.status(403).json({ message: err });
  const existing = db.prepare('SELECT * FROM emails WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!existing) return res.status(404).json({ message: '记录不存在' });
  const b = req.body || {};
  const passwordEnc = b.password ? encrypt(b.password) : existing.password_enc;
  const refreshEnc = b.refresh_token ? encrypt(b.refresh_token) : existing.refresh_token;
  db.prepare(
    `UPDATE emails SET address = ?, password_enc = ?, provider = ?, usage = ?, status = ?, remark = ?,
       label = ?, fetch_url = ?, mailbox_type = ?, client_id = ?, refresh_token = ?,
       updated_at = datetime('now', 'localtime') WHERE id = ? AND user_id = ?`
  ).run(
    b.address !== undefined ? String(b.address).trim() : existing.address,
    passwordEnc,
    b.provider ?? existing.provider,
    b.usage ?? existing.usage,
    b.status ?? existing.status,
    b.remark ?? existing.remark,
    b.label ?? existing.label,
    b.fetch_url ?? b.url ?? existing.fetch_url,
    b.mailbox_type ?? existing.mailbox_type,
    b.client_id ?? existing.client_id,
    refreshEnc,
    existing.id,
    req.user.id
  );
  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM emails WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ message: '记录不存在' });
  const force = ['1', 'true', 'yes'].includes(String(req.query.force || '').toLowerCase());
  if (row.is_mother && !force) {
    return res.status(403).json({ message: '母号仅支持手工删除,请确认后再删(将同时删除其所有子号)' });
  }
  if (row.is_mother) {
    const children = db.prepare('SELECT id FROM emails WHERE mother_id = ? AND user_id = ?').all(row.id, req.user.id);
    const tx = db.transaction(() => {
      for (const c of children) db.prepare('DELETE FROM emails WHERE id = ?').run(c.id);
      db.prepare('DELETE FROM emails WHERE id = ?').run(row.id);
    });
    tx();
    return res.json({ ok: true, deleted_children: children.length });
  }
  db.prepare('DELETE FROM emails WHERE id = ? AND user_id = ?').run(row.id, req.user.id);
  res.json({ ok: true });
});

// ---- mail.com 母号/子号操作 ----
const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    res.status(400).json({ message: String(e.message || e).slice(0, 200) });
  }
};

// 同步子号(按 mail.com 现有别名对齐)
router.post('/:id/sync', wrap(async (req, res) => {
  const r = await mailcom.syncChildren(req.user.id, Number(req.params.id));
  res.json({ ok: true, ...r });
}));

// 拉满子号
router.post('/:id/pull', wrap(async (req, res) => {
  const cap = readSettings(req.user.id).mailcom.cap;
  const r = await mailcom.fillAliases(req.user.id, Number(req.params.id), cap);
  res.json({ ok: true, ...r });
}));

// 回收已使用子号(可选拉新)
router.post('/:id/recycle', wrap(async (req, res) => {
  const s = readSettings(req.user.id).mailcom;
  const repull = req.body?.repull !== undefined ? Boolean(req.body.repull) : s.auto_repull;
  const r = await mailcom.recycleUsed(req.user.id, Number(req.params.id), { repull, cap: s.cap });
  res.json({ ok: true, ...r });
}));

// 批量删除子号
router.post('/batch-delete-subs', wrap(async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
  if (!ids.length) return res.status(400).json({ message: '请选择要删除的子号' });
  const r = await mailcom.deleteChildren(req.user.id, ids);
  res.json({ ok: true, ...r });
}));

// 批量删除已使用(子号走协议删别名,普通邮箱只删本地)
router.post('/batch-delete-used', wrap(async (req, res) => {
  const r = await mailcom.deleteUsed(req.user.id);
  res.json({ ok: true, ...r });
}));

// 清空全部。includeMothers=true 时连母号一起删
router.post('/clear-all', wrap(async (req, res) => {
  const includeMothers = Boolean(req.body?.includeMothers);
  const r = await mailcom.clearAll(req.user.id, includeMothers);
  res.json({ ok: true, ...r });
}));

// 实时收件(缓存进历史)
router.get('/:id/inbox', wrap(async (req, res) => {
  const r = await mailcom.fetchInbox(req.user.id, Number(req.params.id), { amount: Number(req.query.amount) || 20 });
  res.json({ ok: true, ...r });
}));

// 历史邮件(本地缓存)
router.get('/:id/mails', (req, res) => {
  const rows = db
    .prepare(
      'SELECT id, mail_uid, subject, from_addr, to_addr, mail_date, fetched_at, (LENGTH(body) > 0) AS has_body ' +
        'FROM email_mails WHERE email_id = ? AND user_id = ? ORDER BY id DESC LIMIT 200'
    )
    .all(req.params.id, req.user.id);
  res.json(rows);
});

// 邮件正文(实时拉取并缓存)
router.get('/:id/mail/:mailId/body', wrap(async (req, res) => {
  const cached = db
    .prepare('SELECT body FROM email_mails WHERE email_id = ? AND mail_uid = ? AND user_id = ?')
    .get(req.params.id, req.params.mailId, req.user.id);
  if (cached && cached.body) return res.json({ ok: true, body: cached.body, cached: true });
  const body = await mailcom.fetchBody(req.user.id, Number(req.params.id), req.params.mailId);
  res.json({ ok: true, body });
}));

// 标记子号使用状态
router.post('/:id/used', (req, res) => {
  const used = Boolean(req.body?.used);
  const row = db.prepare('SELECT id FROM emails WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ message: '记录不存在' });
  db.prepare(
    "UPDATE emails SET status = ?, used_at = ?, updated_at = datetime('now','localtime') WHERE id = ? AND user_id = ?"
  ).run(used ? '已使用' : '未使用', used ? utcStamp() : '', row.id, req.user.id);
  res.json({ ok: true });
});

router.post('/batch-delete', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
  if (!ids.length) return res.status(400).json({ message: '请选择要删除的邮箱' });
  const placeholders = ids.map(() => '?').join(',');
  const info = db.prepare(`DELETE FROM emails WHERE user_id = ? AND id IN (${placeholders})`).run(req.user.id, ...ids);
  res.json({ deleted: info.changes });
});

// 批量导入(文本,多格式)
router.post('/batch-import', (req, res) => {
  const rows = parseEmailImport(req.body?.text || '');
  if (!rows.length) return res.json({ success: 0, skipped: 0, filtered: 0, total: 0, errors: [] });

  const settings = readSettings(req.user.id);
  const existing = new Set(
    db.prepare('SELECT LOWER(address) AS a FROM emails WHERE user_id = ?').all(req.user.id).map((r) => r.a)
  );

  const ctx = getPlanContext(req.user);
  let remaining = Infinity;
  if (ctx && ctx.plan && Number.isFinite(ctx.plan.max_emails)) {
    const used = db.prepare('SELECT COUNT(*) AS c FROM emails WHERE user_id = ?').get(req.user.id).c;
    remaining = Math.max(0, ctx.plan.max_emails - used);
  }

  const insert = db.prepare(
    `INSERT INTO emails (user_id, address, password_enc, mailbox_type, label, fetch_url, client_id, refresh_token, provider, is_mother)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  let success = 0;
  let skipped = 0;
  let filtered = 0;
  const errors = [];
  const seen = new Set();

  const tx = db.transaction(() => {
    for (const r of rows) {
      const addr = String(r.address || '').trim();
      if (!addr) continue;
      const low = addr.toLowerCase();
      if (existing.has(low) || seen.has(low)) {
        skipped += 1;
        continue;
      }
      if (!domainAllowed(settings, addr)) {
        filtered += 1;
        continue;
      }
      if (success >= remaining) {
        errors.push(`已达套餐邮箱上限,${addr} 起未导入`);
        break;
      }
      const isMother = r.mailbox_type === 'mailcom' && r.password ? 1 : 0;
      insert.run(
        req.user.id,
        addr,
        encrypt(r.password || ''),
        r.mailbox_type || 'password',
        r.label || '',
        r.url || r.fetch_url || '',
        r.client_id || '',
        encrypt(r.refresh_token || ''),
        (addr.split('@')[1] || '').toLowerCase(),
        isMother
      );
      seen.add(low);
      success += 1;
    }
  });
  tx();
  res.json({ success, skipped, filtered, total: rows.length, errors });
});

// 收件测试
router.post('/:id/test-receive', async (req, res) => {
  const row = db.prepare('SELECT * FROM emails WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ message: '记录不存在' });
  const isMailcom = row.mailbox_type === 'mailcom' || row.is_mother || row.mother_id;
  if (isMailcom) {
    try {
      const r = await mailcom.fetchInbox(req.user.id, Number(row.id), { amount: 20 });
      return res.json({ ok: true, message: `收到 ${r.count} 封邮件`, count: r.count });
    } catch (e) {
      return res.status(400).json({ ok: false, message: String(e.message || e).slice(0, 200) });
    }
  }
  const target = {
    address: row.address,
    mailbox_type: row.mailbox_type,
    fetch_url: row.fetch_url,
    client_id: row.client_id,
    refresh_token: decrypt(row.refresh_token),
    password: decrypt(row.password_enc),
  };
  let result;
  try {
    result = await testReceive(target);
  } catch (e) {
    result = { ok: false, message: String(e.message || e).slice(0, 200) };
  }
  if (result.ok && result.newRefreshToken) {
    db.prepare('UPDATE emails SET refresh_token = ? WHERE id = ? AND user_id = ?').run(
      encrypt(result.newRefreshToken),
      row.id,
      req.user.id
    );
  }
  const stamp = utcStamp();
  db.prepare('UPDATE emails SET last_check = ?, last_result = ? WHERE id = ? AND user_id = ?').run(
    stamp,
    result.message || '',
    row.id,
    req.user.id
  );
  res.json({ ...result, newRefreshToken: undefined, last_check: stamp });
});

module.exports = router;
