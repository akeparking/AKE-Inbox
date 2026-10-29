# 真实平台接入与验收

广告报表、原生表单收件、CRM 转化回传和 AI 使用独立配置。`GET /api/v1/saas/integrations` 只返回配置状态与最近收件同步结果，不返回访问令牌。组织管理员管理密钥；销售确认业务事实；平台回执与匹配状态分别记录。

## Meta

广告连接使用官方 Insights API，账户原币种与时区通过 API 校验。账户 ID 只填数字；API 版本和平台转化动作由管理员明确配置。同步按日期、账户、广告系列覆盖同一维度，不重复累计；缺失指标保持未知。

原生表单支持两种可同时使用的入口：

- 签名 Webhook：配置应用密钥、验证令牌及获授权的主页；平台应用须具备管理主页订阅的权限。
- 官方 API 定时读取：在设置页配置主页令牌并启用定时收件，每 5 分钟查询一次。只使用获授权的表单数据读取权限；不更改主页订阅、表单或广告。可指定表单 ID，留空时发现主页的启用表单。

首次读取从组织切换时间开始，后续读取带重叠窗口以处理延迟。成功时间只在整轮完成后推进；失败和重启后可重读。Webhook 与定时读取使用相同平台线索 ID、标准化内容和持久收件账本，因此同一线索只产生一份询盘。原生表单提交不会自动成为广告数据使用同意或人工有效询盘。

原生表单的 CRM 阶段使用 `system_generated`、真实 `lead_id` 和 CRM 来源字段。网站初次收件 CAPI 仍使用独立适配器；网站的后续 CRM 阶段使用 `other`，不会伪造原生表单 ID。购买金额只取已确认的赢单事实。

## Google

Google Ads 读数需要 `https://www.googleapis.com/auth/adwords`，Data Manager 回传需要 `https://www.googleapis.com/auth/datamanager`。二者不可互相替代。

Google 在 2026-09-09 停用 developer token，访问等级改由 Google Cloud 项目管理。代码保留旧配置字段以兼容已有客户端，但不再要求或发送该令牌。真实账户读数还要求 Cloud 项目获批 Explorer 或更高访问等级。

刷新令牌、客户端 ID、客户端密钥与访问令牌按组织加密保存。广告读取在明确的 401 后刷新并重试一次；Data Manager 在发起业务发送或回执查询前检查到期时间。刷新失败只返回脱敏错误，不把不确定的上传当作授权失败重试。

Google 默认仅校验，HTTP 200 只证明本次校验通过。正式发送必须由管理员启用，并对真实且已获同意的业务事件人工确认。有效询盘和赢单使用各自的转化动作；未配置赢单目标时拒绝上传，不使用有效询盘目标代替。已有事件 ID、发生时间及历史发送记录不得为测试改写。

## AI

支持 OpenAI 兼容与 Anthropic 兼容协议。模型地址必须是运维允许的 HTTPS 来源，禁止跟随重定向传递密钥。Anthropic 请求使用 Messages 协议；可按服务商要求关闭扩展思考。请求在网关超时之前终止。

摘要、字段建议、翻译和回复草稿都保存在独立建议记录中，同时记录请求模型和实际返回模型。截断响应、工具调用或疑似密钥输出不会成为可用建议。建议不会覆盖人工字段、确认有效、改变商机阶段或自动发送客户消息。

## 升级与回滚

新增 `011_live_integrations.sql`，保存原生线索同步进度、脱敏错误和 AI 模型审计字段。先备份数据库与字段加密密钥，再执行迁移及强制 RLS 脚本，之后更新 API 和 worker。旧迁移文件保持不变。

需要企业出站代理时，Node 24 使用 `NODE_USE_ENV_PROXY=1` 和私密环境中的 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY`。代理不写入公共源码；本机和 Docker 内部服务放入排除列表。不要对失败的转化上传执行网络层自动重试。

关闭定时收件只停止新轮询；关闭广告连接停止新同步。回滚保留既有询盘、建议、收件进度和平台回执，不能用旧数据库覆盖新业务。

## 证据层级

分别记录隔离数据库测试、真实 API 读取、真实 AI 调用、平台仅校验、正式受理、处理结果和平台匹配。空结果不是新收件成功；仅校验不等于已上传；没有真实合格事件时保留待验收项。

参考：[Google Ads 访问等级](https://developers.google.com/google-ads/api/docs/api-policy/access-levels)、[Google Data Manager 目标](https://developers.google.com/data-manager/api/devguides/concepts/destinations)、[Meta 原生表单 CRM 事件规范](https://developers.facebook.com/documentation/ads-commerce/conversions-api/conversion-leads-integration/payload-specification)。
