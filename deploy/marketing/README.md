# 本地 Inbox 营销扩展

此目录扩展现有原生 Chatwoot 工作台。广告投递为 Mock，CRM 保留既有受控连接。这里只启动本地 Compose，不含 VPS 部署动作。

## 已安装环境的启动

在仓库根目录设置 `LOCAL_RUNTIME_ROOT` 为本机私有运行目录，然后执行：

```bash
bash deploy/marketing/local.sh status
bash deploy/marketing/local.sh start
```

Inbox 为 `http://localhost:14620`，测试目录站为 `http://localhost:14621`，独立 WordPress 为 `http://localhost:14626`。账号在私有运行目录的 `private/accounts.json`；不要提交、导出或把该文件放入报告。已有浏览器登录可以继续使用。停止采用 `local.sh stop`，不删除数据库或媒体卷。

修改 TypeScript 后先运行 `local.sh build`，再重启本地 Core/worker；Ruby initializer 修改后重启本地 web/native-worker。JS 静态挂载刷新即可。启动脚本复用已安装的私有配置；新机器须先按交付的配置结构配置新测试账号和空数据库，不能复制生产账号、消息或 WhatsApp 会话。

## 数据流与边界

`collector → registered site + consent → Visitor / Visit / WebsiteEvent → persisted InquiryCase → native Inbox + existing intake queue → reviewed LeadQualified → four-stage delivery receipt`。

WhatsApp 使用官方 WAHA Chatwoot App。受控适配器校验真实原生出站消息的内容和附件摘要、当前权限/接管状态、已确认的收件人映射以及独立归档；随后才签发一次发送记录。客户端点击或短编号签发不创建成功询盘。实际入站消息才认领短编号。LID 只能使用 provider 核对的 PN 映射。

`waha-guard.cjs` 绑定已核验版本的内部模块。模块接口不匹配会退出，升级须重新验收。`AKE_CHATWOOT_PUBLIC_URL` 与 `AKE_CHATWOOT_INTERNAL_URL` 只转换原生消息已有的 Active Storage URL，不接受额外媒体地址。普通坐席不取得 WAHA 管理 API key。

## 迁移与回滚

- `004_marketing.sql` 增加站点、同意、访客、访次、事件、表单版本、询盘、来源关联、短编号、消息认领和回执记录；已有 Opportunity 关联允许为空，避免为有效线索制造商机。
- `005_marketing_waha.sql` 保存消息每个发送部分的稳定幂等键和 provider 回执。另有 `006_marketing_controls.sql`，增加冲突状态、共享桥接账本和分页索引；三个迁移均可重复运行。运行迁移前保存当前数据库备份，并用隔离库验证恢复。
- 先关闭对应新增行为：Core 的 `ATTRIBUTION_CAPTURE_ENABLED`、`ATTRIBUTION_UI_ENABLED`、`QUALIFIED_FEEDBACK_ENABLED`、`WHATSAPP_REFERENCE_ENABLED`、`WAHA_ENABLED`，Chatwoot 的 `AKE_MARKETING_UI_ENABLED`；整体开关为 `MARKETING_ENABLED`。关闭采集仍保留真实表单收件，返回“未采集”覆盖状态。原生消息接入由 `AKE_MARKETING_ENABLED` 管理，与界面显示开关分开。
- 保留新表、原始消息、媒体、审计和回执。回滚代码不要回滚已经产生的业务数据，也不要执行 `down -v`。停止 WAHA 出站后先核对在途状态，再决定由 WAHA 或 Evolution 中哪一个持有发送权。
- `review` 代表结果未确定，不能自动重发。此轮附件失败通过精确错误记录与 provider 回读证实发生在媒体下载阶段，人工保留审计后才重试原生原记录。没有这样的证据时继续待核对。
- 本地 `SAFE_FETCH_ALLOW_PRIVATE_NETWORK=true` 仅用于隔离 Compose 的内部 callback；生产继续使用受保护的 HTTPS 回调，不直接复制本地开放项。

## 主要验证入口

```bash
npm run build
node test/marketing/unit-postgres.mjs
node test/marketing/integration.mjs
node test/marketing/extra-integration.mjs
node test/marketing/flags.mjs
node --test test/marketing/waha-guard.test.cjs
```

以上数据库测试需要 `LOCAL_RUNTIME_ROOT`。浏览器测试使用 `test/marketing/browser.py` 和 `browser-cases.py`，需要 Python Playwright 与 `CHROMIUM_PATH`。真实 WhatsApp 收发验收必须使用独立自有测试号码及已批准对话对象，不能让测试脚本向生产联系人发送。

## 尚未授予“完整替代”结论

分页、跨域表单、身份/公司冲突、组合附件、乱序回执、断线故障注入、归档恢复和共享桥接控制已补齐本地路径与相应验证。OKKI 已以明确标注的虚构测试记录完成真实线索、客户和跟进写入、回读及无新增写入的重放；未创建商机或收入。真实 Google 回传、官网 LiteSpeed/CMP、真实双渠道客户、平台真实限制、生产双桥切换及异地灾备仍需验收；L1–L4 继续 unmapped。默认写入开关保持关闭，正式平台记录及证据仅在私有验收交付中保存。

客户建档从当前租户 `/v1/company/fields` 和 `/v1/company/companyEnums` 读取必填项与枚举。创建表单支持 `country`、`bizType`、`intentionLevel`，明确的“未知”枚举值 `0` 会保留；不推测缺失客户信息。租户新增了尚未支持的必填字段时，服务端阻止写入并提示补全。API 返回拒绝或结果不确定后，不自动重发；先回读、确认无记录并保留人工核对审计。

这次测试另观察到租户邮箱域名查重，以及线索编辑接口可能追加联系人。不得根据域名合并客户，也不得把该接口当作已验证的联系人覆盖更新接口。测试记录的更正保留原联系人、原收件和审计；真实客户联系人更新仍须独立验收。详见交付中的真实验收说明与 [GAP_CLOSURE.md](GAP_CLOSURE.md)。

Google 真实验收准备另补齐了投递预览的点击标识脱敏：`gclid`、`gbraid`、`wbraid` 和 `sessionAttributes` 不进入可展示的 payload preview，原始投递 payload 保持不变。真实数据库回归为 64 项通过。Cloud OAuth 授权和刷新已验证；当前广告账户用户创建离线转化被平台拒绝，真实事件尚未上传。需要账户管理员授予适用权限后，创建并回读次要转化目标，再完成单条校验、上传及目的地处理回读。任务授权不等同于广告账户平台权限。

## 后续本地可靠性补齐

最新数据库回归为 68 项。浏览器连续导航按捕获顺序处理，每条待传事件保留所属会话；登录等排除路径及同意前的导航不被补记。可先加载 `consent.js` 再延迟加载 `collector.js`：CMP 调用 `AKEMarketing.setConsent`，桥接只在内存保存最后一次四维选择，不采集事件、不写持久访客标识。WordPress 已将桥接放入 head，并按 LiteSpeed 官方接口排除桥接延迟；官网实际配置仍须独立验收。

WordPress 原生“工具 → Inbox 收件投递”显示最近 100 条收件状态。5 次失败转 review，管理员通过有 nonce 的原生操作重试，保留原收件编号、加密载荷和审计。相同编号不同内容被拒绝。数据库租约防止 Cron 与手动重试并发发送；遗漏调度会被恢复。`wordpress-cron` 仅运行本插件的到期收件任务，避免等待网站访问或被其他更新检查阻塞。该服务只在本地 WordPress profile 中启用；生产调度需要单独部署。

回传 worker 只能领取与当前 `ADS_MODE` 一致的投递；Mock 不查询真实平台回执。显式关闭 `QUALIFIED_FEEDBACK_ENABLED` 后既不领取，也不查询；既有真实 pending/review 回执保持原状。开关不能撤销已发生的外部上传。

新建一个空数据卷的本地环境（已有 Node 24+、依赖及构建产物、Docker 与固定镜像为前提）：

```bash
node deploy/marketing/bootstrap-local.mjs "$NEW_PRIVATE_RUNTIME" ake-mkt-rebuild-example 14720 "$LOCAL_NODE_IMAGE"
LOCAL_RUNTIME_ROOT="$NEW_PRIVATE_RUNTIME" bash deploy/marketing/local.sh status
```

`NEW_PRIVATE_RUNTIME` 必须是 `/home` 下尚不存在的目录；`LOCAL_NODE_IMAGE` 必须是已安装的 Node 24+ 镜像。脚本固定 Chatwoot 摘要，记录本地 Node/PostgreSQL/Redis 镜像 ID，并检查端口与已有卷，拒绝覆盖现有运行目录。它创建全新密钥、管理员、API Inbox、表单和站点；凭据只写到私有 `accounts.json`。新环境不安装 WordPress 内容、不启动 WhatsApp、不导入既有客户或 provider session。安装后的 stop/start 保留卷，使用原 `local.sh`；不要删除数据卷。已有运行环境默认端口和 profiles 保持原配置。

复现新增验证：`test/marketing/reliability-browser.py`、`wordpress-outbox-test.php`、`wordpress-outbox-browser.py`、`bootstrap-browser.py`、`queue-recovery.mjs`。后两者只接受独立重建环境；队列恢复使用该环境单独的 Redis DB 14，不能指向工作环境或生产。新机器依赖下载、WordPress 内容迁移、异机灾备、真实身份/消息平台限制及 Google 权限仍不是本地测试的替代证明。
