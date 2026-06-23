#!/bin/sh
# 安装 Marine 的 Chrome native messaging host（macOS / Chrome）。
# 自动绑定当前项目的稳定扩展 ID，并兼容 Chrome 里历史加载过的旧 ID。
# 用法：直接双击运行，或 `sh install.sh <扩展ID> [扩展ID...]`。
set -e

DIR=$(cd "$(dirname "$0")" && pwd)
PROJECT_DIR=$(cd "$DIR/.." && pwd)
HOST_JS="$DIR/marine-codex-host.js"
INSTALL_HOST_DIR="$HOME/.marine-codex-host"
INSTALLED_HOST_JS="$INSTALL_HOST_DIR/marine-codex-host.js"
WRAPPER="$INSTALL_HOST_DIR/run-host.sh"
HOST_NAME="com.marine.codex"
TARGET_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
TARGET="$TARGET_DIR/$HOST_NAME.json"

NODE=$(command -v node || true)
if [ -z "$NODE" ]; then echo "✗ 找不到 node，请先装 Node.js。"; exit 1; fi

IDS=$("$NODE" - "$PROJECT_DIR" "$TARGET" "$@" <<'NODE'
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const project = path.resolve(process.argv[2]);
const target = process.argv[3];
const args = process.argv.slice(4);
const ids = new Set();

function addId(id) {
  id = String(id || '').trim();
  if (/^[a-p]{32}$/.test(id)) ids.add(id);
}

for (const raw of args) {
  for (const part of String(raw).split(/[\s,]+/)) addId(part);
}

try {
  const manifest = JSON.parse(fs.readFileSync(path.join(project, 'manifest.json'), 'utf8'));
  if (manifest.key) {
    const hash = crypto.createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest();
    let id = '';
    for (const b of hash.subarray(0, 16)) {
      id += String.fromCharCode(97 + (b >> 4));
      id += String.fromCharCode(97 + (b & 15));
    }
    addId(id);
  }
} catch {}

try {
  const existing = JSON.parse(fs.readFileSync(target, 'utf8'));
  for (const origin of existing.allowed_origins || []) {
    const m = String(origin).match(/^chrome-extension:\/\/([a-p]{32})\/$/);
    if (m) addId(m[1]);
  }
} catch {}

const chromeRoot = path.join(os.homedir(), 'Library/Application Support/Google/Chrome');
function scan(dir, depth = 0) {
  if (depth > 3) return;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) scan(p, depth + 1);
    else if (entry.name === 'Preferences' || entry.name === 'Secure Preferences') inspectPrefs(p);
  }
}
function inspectPrefs(file) {
  let prefs;
  try { prefs = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; }
  const settings = prefs.extensions && prefs.extensions.settings || {};
  for (const [id, s] of Object.entries(settings)) {
    const extPath = s && s.path ? path.resolve(String(s.path)) : '';
    if (extPath === project) addId(id);
  }
}
scan(chromeRoot);

process.stdout.write(Array.from(ids).join('\n'));
NODE
)

if [ -z "$IDS" ]; then
  echo "未能自动识别扩展 ID。打开 chrome://extensions，找到「Marine」，复制它名字下面那串扩展 ID（32 个 a–p 字母）。"
  printf "把扩展 ID 粘到这里然后回车：\n> "
  read MANUAL_ID
  MANUAL_ID=$(printf '%s' "$MANUAL_ID" | tr -d '[:space:]')
  case "$MANUAL_ID" in
    [a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p]) IDS="$MANUAL_ID" ;;
    *) echo "✗ 扩展 ID 无效，已取消。"; exit 1 ;;
  esac
fi

ALLOWED=$("$NODE" - <<'NODE' $IDS
const ids = process.argv.slice(2);
const origins = Array.from(new Set(ids)).map(id => `chrome-extension://${id}/`);
process.stdout.write(JSON.stringify(origins, null, 2).replace(/\n/g, '\n  '));
NODE
)

mkdir -p "$INSTALL_HOST_DIR"
cp "$HOST_JS" "$INSTALLED_HOST_JS"
cat > "$WRAPPER" <<EOF
#!/bin/sh
exec "$NODE" "$INSTALLED_HOST_JS" "\$@"
EOF
chmod +x "$WRAPPER" "$INSTALLED_HOST_JS"

mkdir -p "$TARGET_DIR"
cat > "$TARGET" <<EOF
{
  "name": "$HOST_NAME",
  "description": "Marine ↔ Codex bridge",
  "path": "$WRAPPER",
  "type": "stdio",
  "allowed_origins": $ALLOWED
}
EOF

echo ""
echo "✓ 已安装 native host，绑定扩展 ID："
printf '%s\n' "$IDS" | sed 's/^/    - /'
echo "    $TARGET"
echo "✓ host 可执行文件：$WRAPPER"
CODEX="/Applications/Codex.app/Contents/Resources/codex"
[ -x "$CODEX" ] && echo "✓ 找到 codex：$CODEX" || echo "⚠ 没找到桌面 Codex 自带的 codex，host 会回退到 PATH 里的 codex。"
echo ""
echo "下一步：如果刚改过扩展或第一次加载，请在 chrome://extensions 重新加载 Marine，然后开侧边栏点「本地智能体」。"
