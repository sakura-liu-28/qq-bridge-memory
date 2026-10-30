"""Allow only the user-approved voice bridge in the pinned NapCat bundle."""
from pathlib import Path
import re
import shutil
import sys

bundle = Path(sys.argv[1] if len(sys.argv) > 1 else '/app/napcat/napcat.mjs')
source = bundle.read_text()
plugin_id = 'napcat-plugin-maibot-qq-voice-call'
pattern = r'(new Set\(\[\s*"napcat-plugin-builtin",\s*"napcat-plugin-cleaner",\s*"napcat-plugin-ssqq",\s*"napcat-plugin-qce")(\s*\]\))'
if len(re.findall(pattern, source)) != 1:
    raise SystemExit('Pinned NapCat official whitelist changed; review before building')
backup = bundle.with_suffix('.mjs.before-qqbridge-whitelist')
if backup.exists():
    raise SystemExit('Whitelist backup already exists; refusing to overwrite')
shutil.copy2(bundle, backup)
bundle.write_text(re.sub(pattern, lambda match: match[1] + ',\n  "' + plugin_id + '"' + match[2], source, count=1))
print('Allowed one reviewed plugin: ' + plugin_id)
