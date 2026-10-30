# Sourced by launchers: prefer a supported node, including launchd's minimal PATH.
if [ -z "${QQ_BRIDGE_NODE:-}" ]; then
  QQ_BRIDGE_NODE="$(command -v node || true)"
  if ! "$QQ_BRIDGE_NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)' 2>/dev/null; then
    QQ_BRIDGE_NODE=""
    for candidate in "$HOME"/.nvm/versions/node/*/bin/node; do
      if "$candidate" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)' 2>/dev/null; then QQ_BRIDGE_NODE="$candidate"; fi
    done
  fi
fi
if [ -z "$QQ_BRIDGE_NODE" ] || ! "$QQ_BRIDGE_NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)' 2>/dev/null; then
  echo 'qq-bridge requires Node.js >=22.13 (recommended: Node.js 24).' >&2
  exit 1
fi
export QQ_BRIDGE_NODE
