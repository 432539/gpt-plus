const db = require('../db');
const config = require('../config');

// 获取用户当前套餐信息与限额;管理员不受限
function getPlanContext(user) {
  const ctx = {
    plan: null,
    expired: false,
    maxAccounts: config.defaultMaxAccounts,
    maxEmails: config.defaultMaxEmails,
    unlimited: user.role === 'admin',
  };
  if (user.plan_id) {
    const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(user.plan_id);
    if (plan) {
      ctx.plan = plan;
      ctx.maxAccounts = plan.max_accounts;
      ctx.maxEmails = plan.max_emails;
      if (user.plan_expires_at && new Date(user.plan_expires_at) < new Date()) {
        ctx.expired = true;
      }
    }
  }
  return ctx;
}

// 写操作前校验:套餐过期只读;创建时校验限额
function checkWritable(user, table, isCreate) {
  const ctx = getPlanContext(user);
  if (ctx.unlimited) return null;
  if (ctx.expired) return '套餐已过期,当前为只读状态,请联系管理员续费';
  if (isCreate) {
    const count = db
      .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE user_id = ?`)
      .get(user.id).c;
    const max = table === 'gpt_accounts' ? ctx.maxAccounts : ctx.maxEmails;
    if (count >= max) {
      return `已达到套餐限额(最多 ${max} 条),请升级套餐`;
    }
  }
  return null;
}

module.exports = { getPlanContext, checkWritable };
