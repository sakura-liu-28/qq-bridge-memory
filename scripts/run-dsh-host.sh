#!/bin/sh
# 由 launchd 调用：启动 QQ 栈的 DSH host（3080）。
# 关键点：DSH_HOME 必须指向 .local/dsh，否则凭据读错会 401；
# BAISHAN_API_KEY 从文件读，不写进 plist。
cd "$(dirname "$0")/.." || exit 1
export DSH_HOME="${DSH_HOME:-$PWD/.local/dsh}"
. ./scripts/runtime-node.sh
export BAISHAN_API_KEY="$(cat .local/baishan.key)"
export SILICONFLOW_API_KEY="$(cat .local/secrets/siliconflow-api-key)"
export BAILIAN_API_KEY="$(cat .local/secrets/bailian-api-key)"
export ZHIPU_API_KEY="$(cat .local/secrets/zhipu-api-key)"
exec "$QQ_BRIDGE_NODE" \
  "$PWD/.local/dsh-cli/node_modules/@deepseek-ai/dsh/lib/bin.js" \
  web --no-open --port 3080
