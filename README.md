# GPT-Plus 多用户管理控制台

基于 Node.js + Express + SQLite + Vue 3 的多用户 GPT 账号与邮箱管理控制台。本仓库是脱敏后的公开源码。

- 开源地址：[github.com/432539/gpt-plus](https://github.com/432539/gpt-plus)
- 交流：QQ 群 **1109037692**

登录页、侧栏和「个人设置 → 账户信息」里也写了同一开源地址和 QQ 群。

## 脱敏说明

仓库只保留程序和配置模板。服务器 IP、邮箱域名、API Key、License、代理账号、数据库和 `.env` 都不进代码，请在本机填写。

不要提交 `.env`、`server/data`、浏览器运行时目录，或任何真实密钥。部署脚本通过环境变量读取主机，不写死地址。

首次启动会创建管理员 `admin` / `admin123`。登录后请立刻修改密码。

## 本地启动

```bash
cp .env.example .env
npm run install:all
npm run dev:server
npm run dev:web
```

字段说明见 [docs/CONFIG.md](docs/CONFIG.md)。
