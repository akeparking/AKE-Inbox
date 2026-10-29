# SaaS 部署与试点手册

本部署使用独立数据库与服务，不替换现有办公接待部署。需要现有受授权的 Chatwoot HTTPS 服务；一个 Account 只能绑定一个租户。所有原生附件和渠道凭据继续由 Chatwoot 管理。本库不修改 Chatwoot 数据表。

## 配置与启动

在源码目录之外创建权限为 700 的私密目录，设置 `SAAS_PRIVATE_DIR`。以下文件权限设为 600，禁止提交 Git。

| 文件 | 必填变量 |
|---|---|
| postgres.env | `POSTGRES_USER=postgres`、`POSTGRES_DB=inbox_saas`、独立强密码 `POSTGRES_PASSWORD`、另一强密码 `SAAS_RUNTIME_PASSWORD` |
| owner.env | 迁移专用 `DATABASE_URL=postgres://postgres:...@db:5432/inbox_saas` |
| runtime.env | `DATABASE_URL=postgres://saas_runtime:...@db:5432/inbox_saas`、32 字节 `FIELD_ENCRYPTION_KEY`（64 位 hex）、`SAAS_CHATWOOT_ORIGINS=https://your-chatwoot.example`、`SAAS_MODEL_ORIGINS=https://api.openai.com` |
| web.env | `WORKSPACE_PUBLIC_ORIGIN=https://your-workspace.example` |

运行 `docker compose -f deploy/saas/compose.yaml up -d --build`。数据库不暴露宿主端口；API 和 Web 仅绑定回环。通过已有 TLS 反向代理公开 Web，以及需要接入的签名 Webhook 路由。不要公开数据库、迁移服务或密钥文件。代理不得记录 Webhook 路径中的令牌和请求正文。

迁移以完整文件名登记（包括两个 007），校验已应用文件哈希；修改已应用迁移将拒绝启动迁移。旧数据库首次建立迁移账本时重放既有幂等迁移。备份后再升级。SaaS 迁移角色与运行角色分离；启动检查禁止超级用户、BYPASSRLS、业务表所有者运行服务，缺少强制 RLS 时拒绝启动。

## 开通组织

先在 Chatwoot 为公司建立或确认 Account 与个人成员。准备私密 JSON：

```json
{"name":"Example Company","slug":"example-company","chatwootAccountId":10,"chatwootUrl":"https://chat.example.test","adminUserId":"1","effectiveFrom":"2026-11-01T00:00:00Z","template":"general-b2b","timezone":"UTC","enabled":false}
```

使用运维环境变量 `SAAS_PROVISION_DATABASE_URL`、`FIELD_ENCRYPTION_KEY`，运行 `node scripts/saas-provision.cjs INPUT.json PRIVATE_RECEIPT.json`。脚本默认关闭组织；输出文件独占创建并保存签名密钥，不在终端打印。开通前核对 Account 与管理员，使用参数化 SQL 将该组织 `saas_tenants.enabled` 设为 true。切换时间以原项目起始时间为准，新项目由 Inbox 管理。旧项目保留在 OKKI，不双写。

管理员进入 `/saas`，使用组织标识与个人 Chatwoot 登录；成员须通过一次性邀请加入。移除成员会撤销本地会话。设置页可配置渠道、角色、阶段名、模型、已批准知识和广告回传。外部公司默认通用 B2B；AKE 模板只影响组织内知识与提示词，不向其他公司注入 AKE 资料。

## 收件和来源

- 网站服务端适配器向 `POST /api/v1/saas/intake/:slug` 提交规范化收件；签名为 `HMAC_SHA256(intakeSecret, unixSeconds + '.' + rawBody)`，请求头 `x-intake-timestamp`、`x-intake-signature`。密钥仅放服务端。保存真实事件 ID、项目 ID、收件时间及来源。先持久收件后才计真实询盘。
- Chatwoot 原生 `message_created` Webhook 使用 `/api/v1/saas/chatwoot/:slug/:token`。在管理员集成 API 设置 `chatwootWebhookToken` 与 `chatwootServiceToken`，令牌只写入私密平台配置。服务会用租户凭据回查真实消息，核验 Account 和已启用 Inbox。退信守护继续留在原生部署中。
- Meta 原生表单使用 `GET/POST /api/v1/saas/meta-leads/:slug`。管理员在 `integrations/metaLeads` 设置 appSecret、verifyToken 及获授权的 pageId/accountId/accessToken/apiVersion。验证原始请求签名后通过官方 Graph API 获取表单。表单提交本身不当作广告回传同意证据。
- 未归因的邮件/WhatsApp 使用 organic；不以邮件域名、姓名或系列名称猜测广告归因。不要只按消息时间切换旧项目。

## 同步、回传与回滚

广告账户在营销页配置。Google Ads 读数与 Data Manager 回传是不同授权面；Google 登录操作只能用已授权的 AKEparking Chrome。账户币种和时区须与官方元数据一致；每小时同步、每日 30 天重查。失败记录保留进度，重新同步不会重复累计。切换 Mock/live 或历史指标口径会被阻止，避免混合数据。

有效确认与赢单产生本地事实；回传需在营销页逐项人工确认。Google 默认 validateOnly，正式上传需管理员明确配置。平台受理不等于匹配或财务收入。发送意图先持久化；网络中断、重启或无法确认的回执进入核对状态，不自动重发。修改报价、撤回赢单、重开项目保留历史并重算报表，不重发旧事件。

停用一个租户：将其 `enabled=false`，新会话和后台租户扫描立即停止。暂停某广告源可直接关闭该连接。全局回滚先停止 worker，再停止新 Web/API 入口；保留数据库和审计，不回删迁移或业务数据。恢复旧办公入口不会把新业务写回 OKKI。

## 备份、恢复与监控

运行 `sh scripts/saas-backup.sh NEW_PRIVATE_BACKUP_DIRECTORY`。本脚本仅备份自有数据库；Chatwoot 的数据库、附件对象存储及凭据须沿用其独立备份流程。数据库备份无法替代字段加密密钥备份，两者分离保存。恢复演练只能在新空数据库：`pg_restore --no-owner --dbname=NEW_DATABASE business.dump`，随后重建运行角色授权并执行 `enable-rls.sql`。使用原加密密钥验证两租户登录、询盘、报价、知识和回执，检查哈希及计数。未经演练不覆盖正式库。

每租户 `/health` 显示使用量、待处理询盘、逾期跟进与待核对发信；同步记录显示最近同步、错误和进度；反馈表显示平台处理与匹配分层。运维监控检查同步延迟超过两小时、持续授权错误、逾期任务增长、待核对回执。不得在通知中附客户原文或其他租户数据。

## 验收边界

本地双租户和虚构平台验收不能替代真实试点。试点需 AKE 和至少一家外部公司各自管理员核对来源、真实收件、人工有效、商机、报价、赢单及平台回执。记录版本、组织、事件 ID（受控保存）、时间和结果层级；缺少账户或真实事件的项明确待验收。采购、库存、财务、历史迁移、自动订阅扣款及自动调预算不在本版范围。
