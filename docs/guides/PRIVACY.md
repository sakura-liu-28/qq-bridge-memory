# 私有数据与公开代码

公开仓库只包含代码、配置模板和通用角色示例。个人配置、密钥、角色、聊天记录、记忆库及音频应保存在部署环境中，不提交到公开仓库。

`config.json`、`config.personal.json`、`state/`、`audio/`、`.local/` 和个人角色文件由 `.gitignore` 排除。真实凭据使用本地文件保存；示例配置只填写占位符。

发布前运行 `node scripts/privacy-scan.mjs --tracked-only` 检查跟踪文件。扫描结果需要人工确认，不能代替对个人资料、图片和 Git 历史的检查。
