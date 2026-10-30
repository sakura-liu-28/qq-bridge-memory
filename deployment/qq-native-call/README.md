# 原生 QQ 电话

通过 Linux QQ、NapCat 与 AV 桥接听原生 QQ 电话，支持实时语音对话、来电权限检查和按角色、联系人隔离的通话记忆。

AV 桥来自 [ClaudiaGardner/maibot-qq-voice-call](https://github.com/ClaudiaGardner/maibot-qq-voice-call)，固定提交 `22f30c021cd3170f75af9dff66cc959a07ebda4b`，遵循本目录 LICENSE（GPL-3.0-only）。本项目增加来电者校验和动态白名单，不安装其 MaiBot/Qwen 后端。

Docker 构建通过 `--build-arg NAPCAT_BASE=<兼容的 NapCat 基础镜像>` 指定镜像，并在构建上下文中提供标准 `ca-certificates.crt`。`run.sh` 启动 AV Host、NapCat 和 `/opt/qq-bridge/src/qq-native-call.js`；`QQBRIDGE_AV_PREFLIGHT_ONLY=1` 可仅检查 AV SDK。容器进程 UID/GID 为 998，挂载目录需具有对应权限。

运行配置与数据由部署者提供，不随仓库分发。`QQBRIDGE_POLICY_SOCKET` 指向实时权限套接字；`/call/runtime/control.token` 用于控制接口认证，`/call/runtime/bot-uin` 指定机器人账号。电话权限、角色、聊天白名单和黑名单在通话期间持续检查；策略读取失败时拒绝接听。
