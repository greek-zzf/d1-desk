# D1 Desk

账号级 Cloudflare 工作台：浏览 D1，以及用 Cloudflare Email Routing / Email Sending 收发邮件。

邮件收发逻辑参考官方 [agentic-inbox](https://github.com/cloudflare/agentic-inbox)：入站走 Worker `email()` + `postal-mime`，出站走 `send_email` binding，元数据进本项目的 D1（`d1-desk-mail`），附件进 R2（`d1-desk-mail`）。没有搬 AI Agent / MCP。

## 本地运行

```bash
cd d1-desk
pnpm install
cp .dev.vars.example .dev.vars
# 编辑 .dev.vars，填一个随机 AUTH_SECRET
pnpm dev
```

打开 http://localhost:8788

登录页粘贴 **Cloudflare API Token**（需要 `Account / D1 / Edit`）。Token 只放在 HttpOnly Cookie 里，不会写进仓库。

### 创建 Token

1. 打开 [API Tokens](https://dash.cloudflare.com/profile/api-tokens)
2. Create Token → Custom token
3. Permissions:
   - Account · D1 · Edit
   - Account · Account Settings · Read
4. 创建后复制一次，贴进 D1 Desk

## 部署到 Workers

```bash
pnpm exec wrangler secret put AUTH_SECRET
pnpm deploy
```

部署后访问 `https://d1-desk.g6hqzht56f.workers.dev`，收藏这个地址即可。

`AUTH_SECRET` 用来签名登录 Cookie，任意足够长的随机字符串都行：

```bash
openssl rand -base64 32
```

## 邮件

1. 在 `wrangler.jsonc` 的 `vars.DOMAINS` 填你的发信域名（如 `example.com`）。可选 `EMAIL_ADDRESSES` 限制允许创建的地址，逗号分隔。
2. 域名开启 [Email Routing](https://developers.cloudflare.com/email-routing/)，建一条 **catch-all → 这个 Worker** 的规则。
3. 开启 [Email Sending](https://developers.cloudflare.com/email-service/)，才能对外发信（任意收件人需要 Workers Paid）。
4. 部署后登录 D1 Desk → **邮件** → 新建邮箱（例如 `hello@example.com`）。没建邮箱的地址会被忽略。
5. 邮件页右侧是 **Agent**（Workers AI）。新邮件会自动起草回复到草稿箱，不会直接发送。需要 Workers AI 额度（免费套餐有每日 neurons）。

本地可用 wrangler 模拟入站：

```bash
curl --request POST 'http://localhost:8788/cdn-cgi/handler/email' \
  --url-query 'from=sender@example.com' \
  --url-query 'to=hello@example.com' \
  --header 'Content-Type: text/plain' \
  --data-raw $'From: sender@example.com\nTo: hello@example.com\nSubject: Test\n\nHello from D1 Desk'
```

## 快捷键

| 按键 | 作用 |
|------|------|
| ⌘K / Ctrl+K | 切换数据库 |
| ⌘↵ / Ctrl+Enter | 运行 SQL |
| 双击单元格 | 编辑并保存 |
