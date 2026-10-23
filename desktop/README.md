# AKE Inbox Windows 客户端 · 0.2.0-rc.1

Windows x64 接待工作台，连接办公室 WSL 的 Inbox 服务。整个发布文件夹必须保持完整，运行 `AKE-Inbox.exe`。当前为未签名候选版本，没有自动更新。

本机入口：接待台 `http://localhost:14720/app/login`，客户与知识 `http://localhost:14721/sales/inbox`。其他接待员使用管理员提供的 HTTPS 地址。两个入口分别登录。

登录后，在接待台点击“接待中”或“下线”切换状态。主机按有权限且心跳有效的在线成员轮询，全员离线时使用主机配置的 API 模型接待。切换工作区会保持接待心跳；关闭窗口保留托盘，仍然算在线。离席请下线或从托盘退出，退出后最长 75 秒失去在线资格。

APP 只保存主机地址；会话在独立用户目录，可在设置页清除。模型 Key、渠道密钥与数据库只在办公室主机。主机关机、睡眠或断网时不能继续 AI 接待。

已在实际 Windows EXE 验证登录、心跳、切换工作区后续约及页面隔离。其他验收见 [部署说明](../docs/inbox-office-desktop.md)。

从仓库根目录在 WSL、Node 24+ 执行：

```sh
npm --prefix desktop ci --workspaces=false
npm --prefix desktop test
npm --prefix desktop run package:win
```

远程网页禁用 Node 集成，启用沙箱、上下文隔离和来源限制。访问远程主机必须使用 HTTPS，不绕过证书校验；页面没有读取本机文件或执行命令的权限。
