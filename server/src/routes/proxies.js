const express = require('express');
const db = require('../db');
const { encrypt, decrypt } = require('../utils/crypto');
const { normalizeProxyType, parseProxies } = require('../utils/proxyParser');
const { testProxy } = require('../utils/proxyTest');

const router = express.Router();

const toItem = (row) => ({
  id: row.id,
  group_name: row.group_name,
  name: row.name || '',
  proxy_type: row.proxy_type,
  host: row.host,
  port: row.port,
  username: row.username || '',
  has_password: Boolean(row.password_enc),
  status: row.status,
  latency: row.latency,
  region: row.region || '',
  remark: row.remark || '',
  created_at: row.created_at,
});

// 列表(可按分组筛选 + 分页)
router.get('/', (req, res) => {
  const group = String(req.query.group || '').trim();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(200, Math.max(10, parseInt(req.query.pageSize, 10) || 10));
  const where = ['user_id = ?'];
  const params = [req.user.id];
  if (group) {
    where.push('group_name = ?');
    params.push(group);
  }
  const total = db.prepare(`SELECT COUNT(*) AS c FROM proxies WHERE ${where.join(' AND ')}`).get(...params).c;
  const rows = db
    .prepare(
      `SELECT * FROM proxies WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ? OFFSET ?`
    )
    .all(...params, pageSize, (page - 1) * pageSize);
  res.json({ items: rows.map(toItem), total, page, pageSize });
});

// 分组列表 + 计数
router.get('/groups', (req, res) => {
  const rows = db
    .prepare('SELECT group_name, COUNT(*) AS count FROM proxies WHERE user_id = ? GROUP BY group_name ORDER BY group_name')
    .all(req.user.id);
  res.json(rows);
});

router.post('/', (req, res) => {
  const { group_name, name, proxy_type, host, port, username, password, remark } = req.body || {};
  if (!host || !port) return res.status(400).json({ message: 'host 和 port 不能为空' });
  const normalizedType = normalizeProxyType(proxy_type);
  if (!normalizedType) return res.status(400).json({ message: '代理类型仅支持 http、https、socks5/socks5h' });
  const info = db
    .prepare(
      `INSERT INTO proxies (user_id, group_name, name, proxy_type, host, port, username, password_enc, remark, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      req.user.id,
      String(group_name || '默认分组').trim(),
      name || '',
      normalizedType,
      String(host).trim(),
      Number(port),
      username || '',
      encrypt(password || ''),
      remark || '',
      '可用'
    );
  res.json({ id: info.lastInsertRowid, status: '可用' });
});

router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM proxies WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!existing) return res.status(404).json({ message: '代理不存在' });
  const { group_name, name, proxy_type, host, port, username, password, remark } = req.body || {};
  const normalizedType = proxy_type === undefined ? existing.proxy_type : normalizeProxyType(proxy_type);
  if (!normalizedType) return res.status(400).json({ message: '代理类型仅支持 http、https、socks5/socks5h' });
  db.prepare(
    `UPDATE proxies SET group_name = ?, name = ?, proxy_type = ?, host = ?, port = ?,
     username = ?, password_enc = ?, remark = ? WHERE id = ? AND user_id = ?`
  ).run(
    group_name !== undefined ? String(group_name).trim() : existing.group_name,
    name ?? existing.name,
    normalizedType,
    host !== undefined ? String(host).trim() : existing.host,
    port !== undefined ? Number(port) : existing.port,
    username ?? existing.username,
    password !== undefined && password !== '' ? encrypt(password) : existing.password_enc,
    remark ?? existing.remark,
    existing.id,
    req.user.id
  );
  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  const info = db.prepare('DELETE FROM proxies WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  if (info.changes === 0) return res.status(404).json({ message: '代理不存在' });
  res.json({ ok: true });
});

router.post('/batch-delete', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
  if (!ids.length) return res.status(400).json({ message: '请选择要删除的代理' });
  const placeholders = ids.map(() => '?').join(',');
  const info = db
    .prepare(`DELETE FROM proxies WHERE user_id = ? AND id IN (${placeholders})`)
    .run(req.user.id, ...ids);
  res.json({ deleted: info.changes });
});

router.post('/clear-all', (req, res) => {
  const group = String(req.body?.group || '').trim();
  const info = group
    ? db.prepare('DELETE FROM proxies WHERE user_id = ? AND group_name = ?').run(req.user.id, group)
    : db.prepare('DELETE FROM proxies WHERE user_id = ?').run(req.user.id);
  res.json({ deleted: info.changes });
});

router.post('/:id/test', async (req, res) => {
  const row = db.prepare('SELECT * FROM proxies WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ message: '代理不存在' });
  try {
    const result = await testProxy(row, decrypt(row.password_enc));
    const status = result.ok ? '可用' : '失败';
    const region = result.ok ? [result.country, result.region, result.city].filter(Boolean).join(' / ') : '';
    db.prepare(
      'UPDATE proxies SET status = ?, latency = ?, region = ? WHERE id = ? AND user_id = ?'
    ).run(status, result.latency || 0, region, row.id, req.user.id);
    res.json({
      ok: Boolean(result.ok),
      status,
      latency: result.latency || 0,
      region,
      ip: result.ip || '',
      message: result.message || (result.ok ? '可用' : '失败'),
    });
  } catch (e) {
    db.prepare("UPDATE proxies SET status = '失败' WHERE id = ? AND user_id = ?").run(row.id, req.user.id);
    res.status(400).json({ ok: false, message: String(e.message || e).slice(0, 160) });
  }
});

// 批量导入
router.post('/batch-import', (req, res) => {
  const group = String(req.body?.group_name || '默认分组').trim();
  const rows = parseProxies(req.body?.text || '', group);
  if (!rows.length) return res.json({ success: 0, total: 0 });
  const insert = db.prepare(
    `INSERT INTO proxies (user_id, group_name, proxy_type, host, port, username, password_enc, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const tx = db.transaction(() => {
    for (const r of rows) {
      insert.run(
        req.user.id,
        r.group_name,
        r.proxy_type,
        r.host,
        r.port,
        r.username,
        encrypt(r.password || ''),
        r.status || '可用'
      );
    }
  });
  tx();
  res.json({ success: rows.length, total: rows.length, status: '可用' });
});

module.exports = router;
