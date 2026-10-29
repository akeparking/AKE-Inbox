# AKE Inbox v0.4.2 · 五项审查修复与 SaaS 回归

在 v0.4.0 的 Inbox＋CRM 多租户功能上合入全部五项审查修复：连接池并发、来源更正竞争、重复 Meta 上传、同意升级上下文和不完整回执。保留现有租户隔离、客户项目、报价、成交、AI、营销报表与桌面接待入口。

- 新增 19 项回归，包括五项修复的 14 项测试及 5 项 SaaS 回执、并发和租户隔离测试。
- 使用同样的 Ponytail Audit、Codex 原生分析、Semgrep CE 和 Gitleaks 复查；实际结果与覆盖边界见随包验证及审查文件。
- 修复主要位于服务端：需一起更新 Core API 和 worker，等待旧发送结束并保留账本。只更换 Windows ZIP 不会应用服务端修复。
- 从 v0.4.0 升级无新增 SQL；较早版本需要已有迁移至 010，不能重置账号、配置、渠道或业务数据。
- 提供未签名 Windows x64 ZIP、准确标签完整源码 ZIP/TAR.GZ、离线说明和 SHA-256 清单。
- 本次不部署现网或启用真实平台发送。真实 Windows、8 小时观察及真实渠道/CRM/广告平台验收未执行。

详见 [v0.4.2 版本报告](https://github.com/akeparking/AKE-Inbox/blob/v0.4.2/docs/RELEASE_REPORT_v0.4.2.md)。
