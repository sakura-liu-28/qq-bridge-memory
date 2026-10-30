#!/usr/bin/env bash
set -euo pipefail
export QQBRIDGE_POLICY_SOCKET=/call/runtime/qq-policy.sock
export PULSE_SERVER=unix:/call/runtime/pulse/native
children=()
cleanup() {
  trap - EXIT TERM INT
  if ((${#children[@]})); then kill -TERM "${children[@]}" 2>/dev/null || true; fi
}
trap cleanup EXIT TERM INT
# These are transient locks from a previous container boot, never QQ login data.
python3 - <<'PYCLEAN'
from pathlib import Path
root=Path('/call/runtime')
for relative in ['pulse/pid','pulse/native','av-host-profile/SingletonLock','av-host-profile/SingletonSocket','av-host-profile/SingletonCookie']:
 p=root/relative
 if p.exists() or p.is_symlink():p.unlink()
PYCLEAN
/call/scripts/run-av-host.sh & children+=("$!")
ready=0
for ((i=0;i<100;i++)); do
  if curl -fsS http://127.0.0.1:6111/healthz >/dev/null 2>&1; then ready=1; break; fi
  sleep .25
done
if [[ $ready != 1 ]]; then echo '[qqbridge-call] AV Host did not start' >&2; exit 1; fi
python3 - <<'PY'
import json,pathlib,urllib.request,time
key=pathlib.Path('/call/runtime/control.token').read_text().strip()
req=urllib.request.Request('http://127.0.0.1:6111/v1/status',headers={'Authorization':'Bearer '+key})
for attempt in range(60):
 data=json.load(urllib.request.urlopen(req,timeout=2))['data']
 if data.get('ready') and data.get('pluginFound') and 'postMessage' in data.get('methods',[]):break
 time.sleep(.25)
else:raise SystemExit('AVSDK plugin not ready')
print('[qqbridge-call] AVSDK preflight passed',flush=True)
PY
if [[ ${QQBRIDGE_AV_PREFLIGHT_ONLY:-0} == 1 ]]; then wait "${children[0]}"; exit; fi
QQBRIDGE_QQ_UIN=$(cat /call/runtime/bot-uin)
[[ $QQBRIDGE_QQ_UIN =~ ^[1-9][0-9]+$ ]] || { echo '[qqbridge-call] missing bot identity' >&2; exit 1; }
MAIBOT_QQ_CALL_BOT_UIN="$QQBRIDGE_QQ_UIN" /call/scripts/run-napcat.sh & children+=("$!")
node /opt/qq-bridge/src/qq-native-call.js & children+=("$!")
wait -n "${children[@]}"
