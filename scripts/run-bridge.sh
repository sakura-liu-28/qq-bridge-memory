#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
export DSH_HOME="${DSH_HOME:-$PWD/.local/dsh}"
. ./scripts/runtime-node.sh
exec "$QQ_BRIDGE_NODE" src/bridge.js
