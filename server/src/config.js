const path = require('path');
const dotenv = require('dotenv');

// .env 位于项目根目录(server 的上一级)
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

const config = {
  port: parseInt(process.env.PORT, 10) || 8585,
  jwtSecret: process.env.JWT_SECRET || 'dev_only_insecure_secret',
  aesKey: process.env.AES_KEY || '0'.repeat(64),
  jwtExpiresIn: '7d',
  // 未分配套餐用户的默认限额
  defaultMaxAccounts: 3,
  defaultMaxEmails: 3,
  dbPath: process.env.GPT_PLUS_DB_PATH || path.join(__dirname, '..', 'data', 'app.db'),
  webDist: path.join(__dirname, '..', '..', 'web', 'dist'),
};

module.exports = config;
