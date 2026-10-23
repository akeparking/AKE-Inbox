# 本地缺口补齐与后续真实验收

本轮只更新独立本地 Inbox。VPS、官网、真实 Google 上传和 CRM 写入均未修改。前一阶段的源码、交付包和迁移前数据库备份保存在私有运行目录 `private/before-gap-closure-20261022`；原研究目录保持原样。

## 已补齐的执行路径

| 项目 | 实现与本地验证 | 仍需区分的边界 |
|---|---|---|
| 分页 | 访客、询盘、回执使用签名游标；时间线按 sequence 连续加载。221 位访客、1021 条事件无重复/遗漏；坐席能越过 210 条无权记录取得较早授权询盘 | 在线访客 lastSeen 变化时刷新第一页；没有把一次测试当作生产负载压测 |
| 跨域表单 | 注册 iframe origin；加密、15 分钟、限定表单用途的上下文；postMessage 校验 origin、source、challenge；同意改变后刷新上下文。后端先持久化，再 HMAC 回传 | 不读取第三方 iframe DOM；第三方平台须提供真实后端收件回执。失效/撤回上下文仍保存真实收件，来源保持未知 |
| 跨渠道身份 | 新增原生询盘详情关联入口，核对两个会话、权限、revision、原因、证据和稳定 requestId。邮件仅信任邮箱，WhatsApp 仅信任号码；补充联系方式须人工确认 | 客户资料原件保留；关联不自动把两个浏览器合成一个 visitor，也不把短编号当客户身份 |
| 公司/身份冲突 | 两组已有 CRM 记录时拒绝关联；多已验证标识冲突进入人工核查，暂停自动 CRM 同步、客户/商机写入和有效确认 | 本地用虚构公司与捕获的 CRM 调用验证；真实公司合并不自动执行 |
| 多附件 | 原生附件 ID 排序后计算摘要和固定 part；部分已映射时只继续剩余部分。首版最多 10 个附件、单文件 20 MiB、总量 40 MiB | 这是受控连接策略，不是对 WhatsApp 平台最大限制的声明。单文件上限可用 WAHA_MAX_ATTACHMENT_BYTES 调整，总量为其两倍 |
| WAHA 回执 | 使用固定版本上游持久 ack 仓储验证乱序、缺失部分、READ/PLAYED；同一原生消息的状态聚合串行执行。真实组合消息 4 个部分送达，完成任务重放无新增回执 | 固定为单个 WAHA 应用实例；多实例部署须额外使用跨进程锁。接收端没有另做本轮组合消息的人工打开确认 |
| 断线/受限 | 发送前重新查询 session；网络异常、STOPPED、FAILED、SCAN_QR_CODE 不占用发送 claim。WORKING 状态下发送结果不确定进入 review，禁止自动重发 | QR 过期和网络错误用故障注入；真实 provider 限流/封禁不主动触发，WORKING 不保证平台一定允许发送 |
| 数据恢复 | 一致性快照导出两个本地数据库，恢复到新数据库；逐表比对；复制独立归档并核对哈希；固定 Chatwoot Rails 模型读取恢复后的消息和全部附件 | 不启动恢复副本的消息 worker，不复制/启动 WhatsApp 会话；异机、异地灾备和 provider 重新认证属于后续运行验收 |
| 桥接回滚 | 共享 owner、revision、发送账本、切换水位。必须先 paused；不确定/在途消息阻止切换；已发送及水位之前的消息不能由另一个桥重放 | 本地 PostgreSQL + 协议验证；未切换现网号码，也没有把契约验证写成真实 Evolution 接管成功 |

## 接口与迁移

- 增量迁移 `006_marketing_controls.sql`：identity_conflict、marketing_bridge_owners、marketing_bridge_dispatches、分页索引。兼容重跑，不删除旧业务表。
- `public/iframe-context`：siteId、sessionToken、formId、childOrigin；只供已注册父站获取限定用途凭证。浏览器不能将它当作 sessionToken 上传事件或直接确认收件。
- 原生营销操作增加 `inquiry_timeline`、`identity_preview`、`link_identity`、`bridge_status`、`bridge_transition`。查询游标绑定账户、视图及必要的用户/会话范围，一小时失效；权限每次请求重新检查。
- `link_identity` 使用 conversationId、otherConversationId、两个 expectedRevision、confirmed、reason、evidenceRefs、requestId。原有 `/conversations/:id/link` 也复用这一规则，调用方须携带这些新增核查字段。
- `bridge_transition` 使用 inboxId、provider、expectedRevision、lastKnownMessageId、reason；管理员执行。lastKnownMessageId 必须是停桥后核查原生 Inbox 和两个队列得到的最新消息水位。
- `/bridge/claim` 与 `/bridge/receipt` 为内部 Evolution 适配使用；原生持久消息、归档和现有发送控制仍须通过。

## 本地运行及回滚顺序

1. 备份数据库和归档，应用 004–006 迁移；build 后重启本地 Core/worker。没有改 Ruby initializer 时无需重启原生 web。
2. `local.sh start` 自动准备只含本地表单签名 key 的 frame.env，并启动 `frame-backend`。测试入口为 `http://localhost:14621/iframe`，跨域 fixture 为 `http://127.0.0.1:14629`。只绑定本机。
3. 新 WAHA Inbox 首次注册 owner 为 paused，核对历史消息水位，再启用 waha。已经存在的本地接待测试号保留为 waha owner。
4. 切换到 Evolution 前，须先把新版本 relay 与 Core 同步部署，并设置 relay 的 `marketing_bridge_control: true`。新 relay 会把 provider=evolution 传给准入接口；已登记 Inbox 缺少共享控制配置时拒绝发送。旧版 relay 不能参与双桥共存验收。
5. 单桥切换：暂停当前 owner → 等待在途完成 → 核对 review（无确证不得清账重发）→ 记录两个队列/原生消息水位 → 调整本地 callback → 按 revision 启用目标 owner → 仅用新测试消息验收。回退按同一顺序执行，水位只能前进。
6. 回滚本轮界面/采集：关闭对应功能开关，保留 006 表、事件、回执和审计。不能把旧发送代码直接接回一个已有共享账本的号码；先暂停并核对。不执行 `down -v`。

复现：`unit-postgres.mjs`、`gap-browser.py`、`integration.mjs`、`waha-guard.test.cjs`、`waha-status.cjs`、`waha-multipart.cjs`、`recovery.mjs`。WAHA 上游测试在固定镜像内执行，使用独立 SQLite 与捕获的传输。恢复测试只接受 Linux 私有运行目录，创建独立数据库，不覆盖原库。所有私有配置通过 LOCAL_RUNTIME_ROOT 指定，不提交到源码。

## Google 与 CRM 后续状态

| 集成 | 需要准备/确认 | 执行及验收范围 |
|---|---|---|
| Google | 用户已确认指定询盘有效并获准按点击标识回传；Cloud / OAuth 已完成此前验收。当前等待代运营解决广告账户创建转化权限，未上传、未排程 | 默认队列继续 Mock。授权后核对目标，再校验、单条上传和按目的地回读；历史 CMP 仍未知，没有匹配证据时 matching 也为 unknown |
| OKKI CRM | 前一阶段已用明确的虚构记录完成正式租户的线索、客户和跟进写入、回读及零新增重放。本轮不新增 CRM 写入 | 真正 UI→正式 CRM、真实客户跨渠道确证和联系人覆盖更新仍需独立验收。有效线索确认不制造商机或金额 |

生产官网的 CMP、LiteSpeed、现有表单后台回执、生产组织权限，以及真实双桥号码切换另行验收。L1–L4 仍需正式定义，不新增猜测映射。当前仍不能宣布完整替代 OKKI Marketing。

后续本地补齐已增加：提前加载的同意桥接、连续导航序列、WordPress 收件状态与人工重试、专用本地收件调度、真实/Mock 队列隔离与回传关闭门控、空数据卷安装命令和实际队列恢复演练。实现、依赖、测试入口与边界见 [README.md](README.md)；交付中的最新 HTML 和本地可靠性章节记录实际结果，不将故障注入当作外部平台真实验收。
