#!/usr/bin/env node
'use strict';
// Marine 的 Chrome native messaging host：收抓取内容 → 跑 codex exec → 回结构化话术。
// 用 ~/.codex/auth.json 鉴权，调用桌面 app 自带的 codex 二进制（无需单独装 CLI）。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function hostLog(s) { try { fs.appendFileSync('/tmp/marine-host.log', new Date().toISOString() + ' ' + s + '\n'); } catch (e) {} }
hostLog('host 启动（被 Chrome 拉起）');

function findCodex() {
  const cands = [
    '/Applications/Codex.app/Contents/Resources/codex',
    path.join(os.homedir(), '.local/bin/codex'),
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
  ];
  for (const p of cands) { try { if (fs.existsSync(p)) return p; } catch (e) {} }
  return 'codex'; // 退回 PATH
}

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['direct', 'replies'],
  properties: {
    direct: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['text', 'angle'], properties: { text: { type: 'string' }, angle: { type: 'string' } } } },
    replies: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['targetId', 'target', 'text'], properties: { targetId: { type: 'string' }, target: { type: 'string' }, text: { type: 'string' } } } },
  },
};

function generate(msg) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'marine-'));
  const schemaFile = path.join(ws, 'schema.json');
  const outFile = path.join(ws, 'out.json');
  fs.writeFileSync(schemaFile, JSON.stringify(SCHEMA));

  const prompt = [
    (msg.skill || ''),
    '', '====== 本次抓取内容 ======', '',
    '## 正文', (msg.maintext || '（无正文）'),
    '', '## 评论', (msg.comments || '（无评论）'),
    '', '## 字幕', (msg.subtitle || '（无字幕）'),
    '', '====== 任务 ======',
    '按上面 Skill 的口径与风格参数，针对评论与内容产出截流话术，以 JSON 输出：',
    'direct = 直评数组（每条 text + angle，共 3 条、角度各不同），',
    'replies = 回复数组（挑评论区最适合接话的几条）。每条必须包含：',
    '  targetId = 评论行里的 id 值（评论列表每条形如 [id=...]；没有 id 才填空字符串），',
    '  target = “@作者（「评论原文片段」）”，',
    '  text = 要填入该评论回复框的回复内容。',
    '每条 direct 与 reply 的 text 都必须自然出现品牌名 Scholay。只输出 JSON。',
  ].join('\n');

  const codex = findCodex();
  const args = ['exec', '-C', ws, '-s', 'read-only', '--skip-git-repo-check', '--color', 'never',
    '--output-schema', schemaFile, '-o', outFile];
  const r = spawnSync(codex, args, { input: prompt, encoding: 'utf8', timeout: 240000, maxBuffer: 128 * 1024 * 1024 });

  if (r.error) return { ok: false, error: 'spawn 失败：' + r.error.message + '（codex=' + codex + '）' };
  if (r.status !== 0) return { ok: false, error: 'codex exec 退出码 ' + r.status + '：' + String(r.stderr || '').slice(-600) };
  let out;
  try { out = JSON.parse(fs.readFileSync(outFile, 'utf8')); }
  catch (e) {
    const raw = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8').slice(0, 400) : '(无 out.json)';
    return { ok: false, error: '解析输出失败：' + e.message + '；原始：' + raw };
  }
  return { ok: true, direct: out.direct || [], replies: out.replies || [] };
}

// ---- native messaging（4 字节本地字节序长度前缀 + UTF-8 JSON）----
function send(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([len, body]));
}

let acc = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  acc = Buffer.concat([acc, chunk]);
  while (acc.length >= 4) {
    const len = acc.readUInt32LE(0);
    if (acc.length < 4 + len) break;
    const body = acc.slice(4, 4 + len);
    acc = acc.slice(4 + len);
    let msg;
    try { msg = JSON.parse(body.toString('utf8')); } catch (e) { send({ ok: false, error: 'bad message' }); continue; }
    hostLog('收到消息 type=' + (msg && msg.type));
    if (msg && msg.type === 'ping') { send({ ok: true, pong: true, codex: findCodex() }); continue; }
    if (msg && msg.type === 'generate') {
      try {
        const r = generate(msg);
        hostLog('生成完成 ok=' + r.ok + (r.ok ? (' direct=' + (r.direct || []).length + ' replies=' + (r.replies || []).length) : (' error=' + r.error)));
        send(r);
      } catch (e) { hostLog('生成异常 ' + (e && e.message)); send({ ok: false, error: String((e && e.message) || e) }); }
      continue;
    }
    send({ ok: false, error: 'unknown type' });
  }
});
process.stdin.on('end', () => process.exit(0));
