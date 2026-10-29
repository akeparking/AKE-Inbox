# AKE Inbox v0.3.1 · 并发与 Meta 回传修复

修复 v0.3.0 审查复现的五个问题：六请求并发造成连接池停滞、来源更正后发送旧关联、新旧 Meta 通道重复上传、旧适配器误判回执/自动重试、同意升级后缺少浏览器与点击上下文。新增隔离 PostgreSQL 与 Mock 回归，按相同的 Ponytail Audit、Codex 原生分析、Semgrep CE 和 Gitleaks 流程复查。

- 本版包含 Windows x64 ZIP、完整标签源码 ZIP/TAR.GZ、离线说明、兼容信息、发布报告和 SHA-256 校验清单。Windows ZIP 未签名。
- **修复主要在服务端。** 从托盘退出旧客户端后可更换 Windows ZIP；办公室 Core API 和 worker 也需一起更新。只换客户端不会应用服务端修复。
- 从 v0.3.0 升级没有新增数据库迁移；更早版本须先执行已有迁移至 009。升级前等待旧进程在途发送完成，保留配置、密钥、渠道绑定和全部回执。
- 旧自动 Meta Live 任务进入待核对，不能直接重放；新入口 Test/Live 均检查旧账本。发布不会启用真实广告回传、连接渠道或修改现网服务。
- Windows 实机通知、资源测量、8 小时观察，以及真实渠道/CRM/Meta 端验收未在本版执行。按既定增量发布政策记录这些边界，不将历史验收写作本次通过。

详见随包发布报告及 [v0.3.1 发布说明](https://github.com/akeparking/AKE-Inbox/blob/v0.3.1/docs/RELEASE_REPORT_v0.3.1.md)。
