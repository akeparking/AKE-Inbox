# Meta Ads 回传

Inbox v0.2.0 的增量功能：管理员在询盘详情中准备真实阶段事件，在「Meta Ads 回传」中点击「一键回传」。后端直接调用 Meta Conversions API，无需另建 Gateway，也不依赖 Ads CLI、Ads MCP 或 OKKI 轮询。

默认关闭，启用后默认仍为 **Mock**。本地验证不等于 Meta 正式受理、匹配或广告优化验收。

## 使用

1. 打开「营销 → 询盘」，核对来源和原始收件。
2. 选择「准备回传事件」，填写核验依据。有效阶段须先使用既有「确认有效线索」流程；成交阶段须填写真实成交时间和依据。
3. 按收到线索 → 有效线索 → 成交线索顺序点击「一键回传」。已记录事件不再提供发送按钮。
4. 在询盘详情或「Meta Ads 回传」查看模式、事件时间、受理状态和回执编号。页面最多显示最近 200 条，完整账本仍保留在数据库中。

| 来源 / 阶段 | Meta 事件 | 来源参数 | 身份与时间 |
|---|---|---|---|
| 网站收件 | `Lead` | `website`，原始 `event_source_url` | 实际收件时间；同意后的 fbc 或散列联系方式 |
| 网站线索在 Inbox 人工确认有效 | `QualifiedLead` | `other` | 真实人工确认时间；不冒充原生表单 Conversion Leads |
| 网站线索人工确认成交 | `ConvertedLead` | `other` | 操作者提供的真实成交时间及依据；不创建订单或收入 |
| Meta 原生表单的以上三个阶段 | 同名事件 | `system_generated`；`event_source=crm`；`lead_event_source` | 核验的原生 `leadgen_id`；Lead 使用 Meta 原始提交时间，有效阶段使用人工确认时间，成交使用真实成交时间 |

网站点击标识从实际观察到的 `fbclid` 生成 fbc 并加密保存；无广告数据同意时不采集。Google 点击标识保持独立。邮箱按小写、去首尾空格后 SHA-256；电话须是明确的国际号码，去符号后 SHA-256。不发送明文联系方式。原生表单 ID 不散列，不得使用 OKKI ID、广告 ID 或网站线索 ID 代替。

网站 Lead 的浏览器 User-Agent 从已获广告数据同意的会话请求头采集、加密保存，并只用于对应网站事件。历史记录缺少原始浏览器信息时阻止网站 Lead 回传，不以服务器 User-Agent 补造。

## 配置与运行

应用已有 PostgreSQL、Inbox 认证及字段加密配置之外，需要：

```dotenv
META_FEEDBACK_ENABLED=true
META_FEEDBACK_MODE=mock
META_DATASET_ID=
META_ACCESS_TOKEN=
META_GRAPH_VERSION=v26.0
META_LEAD_EVENT_SOURCE=AKE Inbox
META_TEST_EVENT_CODE=
```

`META_FEEDBACK_MODE` 独立于 Google 的 `ADS_MODE`：`mock` 不访问 Meta；`test` 需要数据集、令牌和当前 Test Events 代码；`live` 拒绝测试询盘且不携带测试代码。令牌仅保留在服务器环境/密钥存储中，通过 Authorization 请求头发送。API 版本必须在实际启用时再次核验，示例版本不是永久有效保证。

Meta 当前 Using the API 文档明确说明，带 `test_event_code` 的事件仍进入 Events Manager，可用于定向及广告衡量。只有 Mock 完全不出站。Test 与 Live 共用发送防重：测试已受理或结果未知的阶段不能在正式模式重发；已受理的测试初始阶段可作为后续真实阶段的前序回执。

标记为虚构测试的询盘不能进入 Test 或 Live，只能 Mock。真实客户的受控 Test Events 验收使用真实客户记录和真实业务事件，不修改旧时间，也不把蓝色官网测试资料发到 Meta。

运行迁移、构建后按现有部署方式加载 Core 和 Chatwoot 扩展。新增迁移为 `008_meta_feedback.sql` 和 `009_meta_legacy_receipts.sql`，不修改原询盘和 Google 回执。

新增原生认证操作：`meta_feedback`（查看）、`meta_prepare`（准备）、`meta_send`（发送），沿用 `/ake_marketing/:operation` 与管理员权限。浏览器不接触 Meta 令牌。不得直接向公网暴露内部 `marketing/native` 接口。

## 防重、故障与同意

- 事件按账户、数据集、模式、真实线索主体、阶段唯一；同一原生 Meta ID 跨询盘也不能重复登记同一阶段。
- 准备阶段冻结时间与加密载荷；发送前再次检查同意、身份冲突、测试标记、来源关联、模式、数据集和此前阶段。
- 每次发送先提交持久化占用，再访问 Meta。并发点击只有一次出站尝试；响应丢失、异常 200 或进程中断进入待核对，不能直接重发。
- 明确拒绝可以人工重试，沿用原 event_id 和原时间。超过七天的事件禁止发送，不能将旧时间改成今天。
- `events_received` 必须等于发送数且存在 `fbtrace_id`，才记录已受理；处理和匹配仍保持未知。没有用 Insights 统计或成功 HTTP 状态冒充单条匹配证据。
- 网站 Lead 使用 `inbox:website:lead:<inquiryId>`。Collector 返回相同 `metaEventId`；只有显式设置 `AKE_MARKETING.metaPixelId` 且页面已存在 fbq、客户已同意时，才调用现有 Pixel 并传同一个 `eventID`。Collector 不安装 Pixel。上线前须核对 GTM/插件中的其他 Lead 发送者，不能并行生成不同 ID。
- `marketing_meta_feedback` 保存当前状态，`marketing_meta_attempts` 保留每次尝试；日志只保留静态错误码和回执，不保存 Meta 原始错误消息。
- `marketing_meta_legacy_receipts` 保留核验导入的历史回执及加密来源证据。已受理、误发和结果未知的旧阶段均阻止再次发送；误发记录不会被当作有效的前序阶段。

## 旧 OKKI 网关如何替换

可替换的是独立的 **OKKI 状态轮询 → Meta 出站回传**。Inbox 仍可保留 OKKI 客户/商机同步；网站 Pixel、原生表单收件与其他渠道采集各自保留职责。

本次代码不会停止旧定时器、删除 SQLite 或更改已有 Meta 数据。正式切换前需要：

1. 明确每种阶段只由一个发送者负责，备份旧账本，核对已发、待发、结果未知的事件。
2. 用真实授权的 Test Events 完成 Meta 端验收，再决定切换时点；本地 Mock 不满足此条件。
3. 停止旧网关出站调度（例如 `GATEWAY_DISPATCH_MODE=none`），保留账本和回滚配置。不要让旧网关与 Inbox 并行回传同一阶段。
4. 旧的已回传 Lead 不应再补传；七天外的初始阶段也不能改时间。本版本没有旧账本导入界面，所以已有漏斗须先完成专门的历史回执迁移，再启用后续阶段。当前三个阶段之外的旧自定义阶段亦需单独核对。

## 本地蓝色官网验收

`test/marketing/blue-preview.php` 是本地 WordPress 专用测试面板，只在 `wp_get_environment_type()=local` 且 `ake_meta_test=1` 时运行。配置文件及 Collector 副本与它同目录；普通页面不加载面板；面板不写入 WordPress 内容或配置，测试数据写入本地 Inbox 数据库。测试面板使用独立注册站点、明确虚构资料、现有本地 Inbox 与 Mock 回传。

自动化覆盖：网站/原生表单载荷、真实时间、同意、角色/账户/询盘边界、并发点击、重启后的账本读取、明确拒绝重试、未知结果不重试、Mock/Test/Live 隔离、Meta 受理与匹配区分。浏览器验收从蓝色官网真实页面提交，经原生 Inbox 收件、人工确认与点击按钮，再回读持久化账本。

## 依据

2026-10-23 查阅用户提供的 Meta Ads 本地文档快照，并实时核对 [CRM Payload Specification](https://developers.facebook.com/documentation/ads-commerce/conversions-api/conversion-leads-integration/payload-specification)。实现同时依据 [CRM Developer Implementation](https://developers.facebook.com/documentation/ads-commerce/conversions-api/conversion-leads-integration/crm-integration/3-implementing-the-crm-integration)、[Server Event Parameters](https://developers.facebook.com/documentation/ads-commerce/conversions-api/parameters/server-event)、[Using the API](https://developers.facebook.com/documentation/ads-commerce/conversions-api/using-the-api)。
