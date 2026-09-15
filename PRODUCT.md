# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

个人开发者管理自己的 Cloudflare 账号：在本地或自部署实例里完成日常数据与资源操作，而不是依赖 Cloudflare Dashboard 的通用控制台。

## Product Purpose

D1 Desk 是账号级 Cloudflare 工作台：浏览与操作 D1、Workers KV、Workers，并用 Cloudflare Email Routing / Email Sending 收发邮件（含 AI 起草回复）。成功标准是开发者能更快完成查改数据与账号内资源巡检，并在同一处处理邮件，而不把 API Token 写入仓库或本地持久文件。

## Positioning

相对 Cloudflare Dashboard 等邻近工具，D1 Desk 的差异在于：为日常数据操作优化的更快路径，以及把 D1、KV、Workers、邮件收进同一自托管工作台。

## Operating Context

- 登录：粘贴 Cloudflare API Token；Token 仅存于 HttpOnly Cookie，不落盘、不进仓库。
- 本地：`pnpm dev`（Wrangler，默认 http://localhost:8788）。
- 部署：Workers 自托管（`pnpm deploy` + `AUTH_SECRET`）。
- 主要工作流：选账号 → D1 库/表浏览与 SQL、KV namespace/key 读写、Workers 列表与 bindings / 日志、邮件收发与 Agent 起草。
- 邮件依赖：域名 Email Routing（catch-all → 本 Worker）、可选 Email Sending、本项目 D1/R2 存元数据与附件；Agent 需 Workers AI 额度。

## Capabilities and Constraints

**已有能力**

- D1：库列表、表浏览、单元格编辑、SQL 控制台、快捷键（⌘K 切库、⌘↵ 跑 SQL）。
- KV：Namespace 列表、前缀筛选、游标分页、查看/编辑/删除/新建 key（可选 TTL）。
- Workers：脚本列表与详情（handlers、usage model、bindings、compatibility flags、settings、Observability 日志）。
- 邮件：邮箱地址、收件箱/草稿、入站 Worker `email()` + postal-mime、出站 `send_email`、Agent 自动起草回复（不直接发送）。

**硬约束（必须保留）**

- 必须可自托管 / 部署到 Workers。
- API Token 绝不落盘（仅会话 Cookie）。
- 产品名：D1 Desk；界面现有中文文案与顶栏 `LEDGER` 标记为既有品牌痕迹。

**未定 / 未要求**

- 无障碍合规级别未指定。
- 团队共用或多账号协作不是当前目标用户场景。

## Brand Commitments

- 名称：D1 Desk
- 既有标记：顶栏 brand 含 `LEDGER`
- 登录页定位文案方向：账号级工作台（D1、KV、Workers、邮件）

## Evidence on Hand

- README 与可运行实现：`public/` 前端、`src/` Worker API、邮件逻辑参考官方 agentic-inbox（未搬 AI Agent/MCP）。
- 无独立客户证言、案例研究或对外营销素材；后续工作不得编造。

## Product Principles

1. 速度优先于控制台完整性：日常数据操作路径要短。
2. 一处收齐账号内常用面：D1、KV、Workers、邮件同工作台。
3. 自托管与会话安全不可妥协：Workers 部署、Token 不落盘。
4. 为个人开发者单账号场景设计，不为虚构的团队协作扩 scope。
