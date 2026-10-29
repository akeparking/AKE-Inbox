# API 与业务事件

API 前缀 `/api/v1/saas`。浏览器经同源 `/api/saas` BFF，凭 HttpOnly 会话认证；服务端租户身份只来自验证后的会话。除签名收件和登录验证接口外，不接受匿名访问。历史 `/api/v1` 接口在 office 模式保留；SaaS 模式拒绝旧默认账号路由。

## 路由清单

| 方法 | 路径 | 输入 / 输出与角色 |
|---|---|---|
| POST | `/session` | POST: 组织标识、个人邮箱密码、可选邀请码；GET: 已验证组织与角色 |
| GET | `/session` | POST: 组织标识、个人邮箱密码、可选邀请码；GET: 已验证组织与角色 |
| POST | `/logout` | 当前成员；撤销会话 |
| POST | `/intake/:slug` | 来源专属签名或 Webhook 令牌；由服务端确定租户 |
| POST | `/chatwoot/:slug/:token` | 来源专属签名或 Webhook 令牌；由服务端确定租户 |
| GET | `/records/:resource` | 已登录成员；仅当前组织记录 |
| GET | `/export/:resource` | 管理员 / 营销 / 销售；最多 10000 行，超限明确报错 |
| GET | `/leads/:id` | 已登录成员；仅当前组织记录 |
| POST | `/leads/:id/link` | 销售 / 管理员；有效确认、备注及 AI 也可由营销操作 |
| POST | `/leads/:id/qualify` | 销售 / 管理员；有效确认、备注及 AI 也可由营销操作 |
| POST | `/leads/:id/ai` | 销售 / 管理员；有效确认、备注及 AI 也可由营销操作 |
| POST | `/companies` | 销售 / 管理员；有效确认、备注及 AI 也可由营销操作 |
| GET | `/companies/:id` | 已登录成员；仅当前组织记录 |
| POST | `/companies/:id` | 销售 / 管理员；有效确认、备注及 AI 也可由营销操作 |
| POST | `/people` | 销售 / 管理员；有效确认、备注及 AI 也可由营销操作 |
| POST | `/people/:id` | 销售 / 管理员；有效确认、备注及 AI 也可由营销操作 |
| POST | `/opportunities` | 销售 / 管理员；有效确认、备注及 AI 也可由营销操作 |
| POST | `/opportunities/:id` | 销售 / 管理员；有效确认、备注及 AI 也可由营销操作 |
| POST | `/opportunities/:id/stage` | 销售 / 管理员；有效确认、备注及 AI 也可由营销操作 |
| POST | `/opportunities/:id/outcome` | 销售 / 管理员；有效确认、备注及 AI 也可由营销操作 |
| POST | `/tasks` | 销售 / 管理员；有效确认、备注及 AI 也可由营销操作 |
| POST | `/tasks/:id` | 销售 / 管理员；有效确认、备注及 AI 也可由营销操作 |
| POST | `/notes` | 销售 / 管理员；有效确认、备注及 AI 也可由营销操作 |
| POST | `/quotes` | 销售 / 管理员；有效确认、备注及 AI 也可由营销操作 |
| GET | `/pipeline` | 读取按组织；配置管理员；营销可安排广告同步 |
| POST | `/pipeline` | 读取按组织；配置管理员；营销可安排广告同步 |
| POST | `/knowledge` | 读取按组织；配置管理员；营销可安排广告同步 |
| POST | `/knowledge/:id` | 读取按组织；配置管理员；营销可安排广告同步 |
| GET | `/members` | 读取按组织；配置管理员；营销可安排广告同步 |
| POST | `/invitations` | 读取按组织；配置管理员；营销可安排广告同步 |
| POST | `/members/:id` | 读取按组织；配置管理员；营销可安排广告同步 |
| GET | `/channels` | 读取按组织；配置管理员；营销可安排广告同步 |
| POST | `/channels` | 读取按组织；配置管理员；营销可安排广告同步 |
| GET | `/conversations` | 已登录成员；仅当前组织记录 |
| GET | `/conversations/:id/messages` | 已登录成员；仅当前组织记录 |
| POST | `/conversations/:id/messages` | 销售 / 管理员；有效确认、备注及 AI 也可由营销操作 |
| POST | `/conversations/:id/takeover` | 销售 / 管理员；有效确认、备注及 AI 也可由营销操作 |
| GET | `/ad-connections` | 读取按组织；配置管理员；营销可安排广告同步 |
| POST | `/ad-connections` | 读取按组织；配置管理员；营销可安排广告同步 |
| POST | `/ad-connections/:id/sync` | 读取按组织；配置管理员；营销可安排广告同步 |
| POST | `/ad-connections/:id/toggle` | 读取按组织；配置管理员；营销可安排广告同步 |
| GET | `/sync-runs` | 已登录成员；仅当前组织记录 |
| GET | `/reports` | 已登录成员；仅当前组织记录 |
| GET | `/health` | 已登录成员；仅当前组织记录 |
| GET | `/integrations` | 读取按组织；配置管理员；营销可安排广告同步 |
| POST | `/integrations/:kind` | 读取按组织；配置管理员；营销可安排广告同步 |
| GET | `/meta-leads/:slug` | 来源专属签名或 Webhook 令牌；由服务端确定租户 |
| POST | `/meta-leads/:slug` | 来源专属签名或 Webhook 令牌；由服务端确定租户 |
| GET | `/feedback` | 管理员 / 营销；confirmed 人工确认；未知回执不可重发 |
| POST | `/feedback/:kind/:id/send` | 管理员 / 营销；confirmed 人工确认；未知回执不可重发 |
| POST | `/feedback/:kind/:id/retry` | 管理员 / 营销；confirmed 人工确认；未知回执不可重发 |

## 输入规则与错误

- 客户：名称、负责人、国家（可空）、网站、行业、组织字段；编辑携带 expectedVersion。
- 联系人：姓名、公司、邮箱/电话、语言、采购角色、负责人；公司关联须属于当前租户。
- 商机：primarySourceLeadId、name、ownerId、nextAction、idempotencyKey；项目方向、国家、预计金额可未知；有金额必须有币种。每个新项目使用新幂等键，重试使用原键。
- 报价：opportunityId、title、amount（可空）、currency、notes、previousId、idempotencyKey。首版 previousId 为空，后续必须引用最新版本。
- 结果：status=won/lost/reopened、expectedVersion、occurredAt、evidence、idempotencyKey；赢单必须给出金额及币种，零必须是真实零。
- 连接：provider、accountId、name、currency、timezone、mode、apiVersion、enabled、精确平台转化动作和加密 credentials。编辑已有连接携带 expectedVersion；历史口径不混改。
- HTTP 400 输入错误；401 会话/签名失效；403 角色或租户拒绝；404 当前租户不可见；409 版本、幂等或关联冲突；503 外部服务不可用。错误不回显 SQL 细节、客户原文或密钥。

## 事件与幂等

| 事实 | 持久表 | 唯一键 / 并发规则 | 出站副作用 |
|---|---|---|---|
| InquiryPersisted | inbox_messages + crm_ingestion_receipts | tenant + source + eventId；重复正文哈希一致 | 无自动广告发送 |
| LeadQualified | conversion_events + conversion_deliveries | qualified:workspace:lead:v1；数据库事务 | 独立核对后发送 |
| OpportunityCreated | opportunities + saas_operations | tenant + idempotencyKey | 不确认有效、不写 OKKI |
| QuoteVersionCreated | crm_quotes | tenant + opportunity + version；最新 previousId | 无自动邮件 |
| OpportunityWon | crm_outcomes + crm_business_events | tenant + opportunity + kind；首个赢单事件稳定 | 独立核对后发送 |
| OutcomeReopened / Corrected | crm_outcomes + stage_history | expectedVersion；追加历史 | 旧事件进入 review，不重发 |
| FeedbackDispatchIntent | crm_feedback_attempts | tenant + stable eventKey，先持久化再请求 | 受理、处理、匹配分开 |
| FeedbackRejectedRearmed | crm_feedback_history | 仅已明确授权/限流拒绝，保存原因 | 结果未知无法重置 |
| AdDayCompleted | ad_metric_daily + ad_sync_days | tenant + connection + date + campaign | 同日期替换，不累加 |
| ConversationReplyIntent | crm_outbound | tenant + operationKey + 内容哈希 | 未知状态待核对，不自动重发 |

收件跨已有 Store 事务时，原生收件与 Lead 可能先提交，receipt 最后提交；统一事件键、项目锁及重试读回恢复完整流程。报表只计存在 persisted receipt 的询盘，因此未完整收件不会成为虚假转化。Webhook 上游应对非 2xx 采用同一事件 ID 重试。

## 配置与证据边界

平台凭据通过管理员集成接口保存，数据库只保存租户派生密钥加密的正文。Google Ads 读数 Token 与 Data Manager 回传 Token 单独配置。Meta Lead Ads、Meta Insights 和 CRM CAPI 分开配置，不能把 lead ID、campaign ID、CRM ID 或 event ID 混用。

真实事件发送前须确认授权与同意证据。Mock 受理只证明本地行为；HTTP 200、平台受理和平台匹配是不同结果。撤回业务事实只修正自有报表，不冒充平台侧转化调整已完成。
