# AKE Inbox v0.4.3

完整保留 v0.4.2 的并发、去重、回执与多租户修复。本版接入 Meta 官方广告读数和原生表单定时收件，增加 Google OAuth 持久刷新及 Anthropic 兼容 AI。实际模型响应与人工字段分别保存。

Google Ads 新增 OAuth 授权仍待账号本人完成；Google Data Manager 的真实仅校验与正式上传分别记录。没有以空收件或仅校验冒充转化回传验收。

Windows 客户端继续使用协议 2，保留本地用户数据与渠道绑定。服务器需同时升级 Core、SaaS API/worker 与迁移 011；只有更新 Windows ZIP 不会应用服务端改动。所有平台凭据留在私密服务端配置。

本次客户端回归和打包验证记录在版本附件；继承既有 Windows 实机基线，不将未执行的实机操作标为本次通过。
