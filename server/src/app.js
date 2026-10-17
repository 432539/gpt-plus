const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const config = require('./config');
require('./db'); // 初始化数据库
require('./utils/registerJob').reconcileStaleRuns();

const { authRequired, adminRequired } = require('./middleware/auth');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // 部署在 Nginx 等反向代理后时正确识别客户端 IP

app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(express.json({ limit: '20mb' }));

// API 路由
app.use('/api/auth', require('./routes/auth'));
app.use('/api/dashboard', authRequired, require('./routes/dashboard'));
app.use('/api/global-extract', authRequired, require('./routes/globalExtract'));
app.use('/api/domain-stats', authRequired, require('./routes/domainStats'));
app.use('/api/accounts', authRequired, require('./routes/accounts'));
app.use('/api/mk-gcash', authRequired, require('./mkGcash/routes'));
app.use('/api/emails', authRequired, require('./routes/emails'));
app.post('/api/mailpit/webhook', require('./routes/mailpit').webhookHandler);
app.use('/api/mailpit', authRequired, require('./routes/mailpit'));
app.use('/api/profile', authRequired, require('./routes/profile'));
app.use('/api/settings', authRequired, require('./routes/settings'));
app.use('/api/proxies', authRequired, require('./routes/proxies'));
app.use('/api/logs', authRequired, require('./routes/logs'));
app.use('/api/syncs', authRequired, require('./routes/syncs'));
app.use('/api/register', authRequired, require('./routes/register'));
app.use('/api/admin', authRequired, adminRequired, require('./routes/admin'));

app.use('/api', (req, res) => res.status(404).json({ message: '接口不存在' }));

// 生产模式:托管前端构建产物,SPA 路由回退到 index.html
if (fs.existsSync(config.webDist)) {
  app.use(
    express.static(config.webDist, {
      setHeaders(res, filePath) {
        if (path.basename(filePath) === 'index.html') {
          res.setHeader('Cache-Control', 'no-store');
        }
      },
    })
  );
  app.get(/^\/(?!api\/).*/, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(config.webDist, 'index.html'));
  });
}

// 统一错误处理
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ message: '服务器内部错误' });
});

function ignoreTransientSocketCrash(error) {
  return ['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH'].includes(error?.code);
}

function ignorePlaywrightRouteCrash(error) {
  return /Route is already handled/i.test(String(error?.message || ''));
}

function ignoreNonFatalRuntimeCrash(error) {
  if (ignoreTransientSocketCrash(error)) {
    console.warn(`忽略未处理套接字错误: ${error.code}`);
    return true;
  }
  if (ignorePlaywrightRouteCrash(error)) {
    console.warn('忽略 Playwright 重复 route.fulfill');
    return true;
  }
  return false;
}

process.on('uncaughtException', (error) => {
  if (ignoreNonFatalRuntimeCrash(error)) return;
  console.error(error);
  process.exit(1);
});

process.on('unhandledRejection', (error) => {
  if (ignoreNonFatalRuntimeCrash(error)) return;
  console.error(error);
});

app.listen(config.port, () => {
  console.log(`GPT-Plus 服务已启动: http://localhost:${config.port}`);
  if (require('./mkGcash/enabled').mkGcashEnabled()) {
    const limits = require('./mkGcash/limits');
    console.log(
      `MK_GCASH=1：开源 GCash 模块已启用 concurrency=${limits.MAX_CONCURRENCY} `
      + `session=${limits.MAX_SESSION_CONCURRENCY} monitors=${limits.MAX_ACTIVE_MONITORS}`,
    );
  }
  const pollersDisabled = /^(1|true|yes)$/i.test(String(process.env.DISABLE_POLLERS || ''));
  if (pollersDisabled) {
    console.log('DISABLE_POLLERS=1：未启动流水线/验活/提链轮询，也跳过注册结算回收');
    return;
  }
  require('./utils/registerJob').reconcilePendingSettlements().catch((error) => {
    console.warn('注册供应商残留资源清理失败:', error.message);
  });
  try {
    require('./utils/mailcomPoller').startPoller();
  } catch (e) {
    console.warn('mail.com 轮询启动失败:', e.message);
  }
  try {
    require('./utils/accountDetectPoller').startPoller();
  } catch (e) {
    console.warn('账号验活轮询启动失败:', e.message);
  }
  try {
    require('./utils/accountPipeline').startPoller();
  } catch (e) {
    console.warn('账号流水线启动失败:', e.message);
  }
  try {
    require('./utils/accountGcPipeline').startPoller();
  } catch (e) {
    console.warn('GC 账号流水线启动失败:', e.message);
  }
  try {
    require('./utils/globalExtractEngine').startPoller();
  } catch (e) {
    console.warn('全球提链监控启动失败:', e.message);
  }
});

function shutdownCloak() {
  if (shutdownCloak.ran) return;
  shutdownCloak.ran = true;
  import('./automation/cloak.js')
    .then((mod) => mod.closeAllRuntimes())
    .catch(() => {})
    .finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 15000).unref?.();
}
process.once('SIGTERM', shutdownCloak);
process.once('SIGINT', shutdownCloak);
