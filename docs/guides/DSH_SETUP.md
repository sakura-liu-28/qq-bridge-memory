# 安装与启动

需要 Node.js 22.13 以上，以及已运行的 DSH Web 和 SnowLuma OneBot 服务。

```bash
git clone https://github.com/sakura-liu-28/qq-bridge-memory.git
cd qq-bridge-memory
npm install
cp config.example.json config.json
```

在 `config.json` 填写 DSH 地址、OneBot HTTP / WebSocket 地址与令牌，以及聊天白名单和管理员 QQ。聊天模型与 API 在 DSH 侧配置。

```bash
node scripts/setup-dsh.mjs
npm start
```

安装预设后重启 DSH。浏览器打开 `http://127.0.0.1:3100`，使用启动日志中的控制台令牌登录。

控制台可选择角色、配置语音和图片服务、切换记忆方式并管理会话。仓库中的 `roles/示例伙伴.md` 可作为自定义角色的起点。

[项目来源](../../README.md#来源与依赖) · [功能首页](../../README.md)
