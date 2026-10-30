// reserved2 提示词与插件边界的静态契约；不调用模型，不向 QQ 发送消息。
// 这些检查只能防止关键协议/能力被误删，不能证明聊天质量无损。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import yaml from 'js-yaml';

const preset = yaml.load(fs.readFileSync(
  new URL('../dsh/agent-presets/qq-chat-v2/agent.cordis.yml', import.meta.url), 'utf8',
));
const persona = preset.find((row) => row.id === 'persona');
const prefix = persona?.config?.prefix ?? '';

test('reserved2 YAML resolves to the expected persona and template variables', () => {
  assert.equal(persona?.name, '@deepseek-ai/dsh-persona');
  assert.match(prefix, /\{\{model\}\}/);
  // DSH 0.2.1 起 agent loop 只注册 provider / model 两个提示词变量（0.2.0 还有 cwd），
  // 未知变量会让 system prompt 装配直接抛错 ⇒ 每回合 error、模型一次都不跑。
  // 这里钉住「只用已注册变量」，而不只是「有 {{model}}」。
  const used = [...JSON.stringify(persona.config).matchAll(/\{\{([a-z][a-z0-9_]*)\}\}/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(used)].filter((v) => !['provider', 'model'].includes(v)), []);
  assert.equal(Object.hasOwn(persona.config, 'text'), false);
});

test('local/admin tool restrictions and existing compaction budgets stay intact', () => {
  assert.deepEqual(preset.map((row) => row.id), [
    'persona', 'tool-web', 'tool-ask-user', 'tool-todo', 'qq-tool-restrict', 'compaction',
  ]);
  assert.deepEqual(preset.find((row) => row.id === 'tool-web').config, { search: false, fetch: false });
  assert.equal(preset.find((row) => row.id === 'qq-tool-restrict').name, './qq-tool-restrict.mjs');
  const compaction = preset.find((row) => row.id === 'compaction');
  assert.deepEqual(compaction.isolate, { compaction: true, toolResultPruner: true });
  assert.deepEqual(compaction.config.find((row) => row.id === 'tool-result-pruner').config, {
    thresholdChars: 50000, headChars: 45000, tailChars: 2000,
  });
  for (const text of ['你没有本地工具', '群友没有管理权限', 'API 令牌', '角色由桥接注入']) {
    assert.ok(prefix.includes(text), `missing safety rule: ${text}`);
  }
});

test('snapshots are optional, partial snapshots require reading, and watermarks are not message IDs', () => {
  assert.match(prefix, /可能附带【本次消息快照】/);
  assert.match(prefix, /partial=true[^。]*继续读取/);
  assert.match(prefix, /readThroughSeq 是桥接本地的 seq，不是 QQ messageId/);
  assert.match(prefix, /没有水位[^。]*省略 throughSeq/);
  assert.match(prefix, /首次进入会话、角色变化[^。]*qq_get_prompt/);
});

test('closing acknowledges only the read watermark and observation follows configuration', () => {
  for (const text of ['qq_mark_read(throughSeq=', 'qq_set_wake_config(config=', '不需先 mark_read',
    'wake.preSleepWaitEnabled', '关闭时可以直接收尾', 'preSleepWaitRemainingMs', 'canSleepNow',
    'purpose="reply"', 'purpose="messages"', '读取和思考花掉的时间也算，已安静足够就立即返回']) {
    assert.ok(prefix.includes(text), `missing protocol: ${text}`);
  }
});

test('media capabilities and actual-result requirements remain available', () => {
  for (const text of ['不会自动发送到 QQ', 'qq_get_message_images', 'qq_get_forward_msg', 'nestedForwardIds',
    'qq_send_poke', 'qq_list_stickers', 'qq_get_sticker_image', 'qq_send_sticker', 'qq_collect_sticker',
    'qq_sticker_note', 'qq_get_self_image', 'qq_set_sticker_remark', '只有管理端明确开启后才能用',
    'qq_list_voices', 'qq_send_voice', 'verified=true 才代表这条语音确实落地', 'qq_speak',
    '不要假装发了语音', 'qq_generate_image', 'qq_self_life', 'mcp__web-search-safe__web_search',
    'mcp__web-search-safe__web_fetch', '作为 token 参数传入', 'triggers.speakerIds', '不凭记忆乱填']) {
    assert.ok(prefix.includes(text), `missing capability: ${text}`);
  }
});

test('autonomous expression retains memory privacy and reasoned nighttime contact', () => {
  for (const text of ['回复没有固定条数、字数、格式', '可以连续调用', '夜间', '正当且值得此刻说的理由',
    '不是必须开口的理由', '不能编造紧急情况', '【记忆卫生与事实】', 'qq_memory_append',
    'qq_memory_query', 'qq_memory_remove', 'qq_memory_clear', 'qq_slang_query', 'qq_slang_submit',
    '不重复提交', '不要用 [SILENT]']) {
    assert.ok(prefix.includes(text), `missing autonomy or privacy rule: ${text}`);
  }
  for (const removed of ['约七成', '3~5 轮', '最多 2 条', '你只代表 DeepSeek', '必须・沉睡前']) {
    assert.ok(!prefix.includes(removed), `obsolete behavioral rule: ${removed}`);
  }
});

console.log(`reserved2 persona prefix: ${prefix.length} characters (not a model-token estimate)`);

test('published personas and presets contain personality and generic policy without private account bindings', () => {
  const role = fs.readFileSync(new URL('../roles/示例伙伴.md', import.meta.url), 'utf8');
  assert.doesNotMatch(role, /private:\d+/);
  assert.match(role, /不预设私人关系/);
  assert.match(role, /关系、称呼和共同经历以当前会话/);
  for (const name of ['qq-chat', 'qq-chat-v2']) {
    const rows = yaml.load(fs.readFileSync(new URL(`../dsh/agent-presets/${name}/agent.cordis.yml`, import.meta.url), 'utf8'));
    const text = rows.find(row => row.id === 'persona').config.prefix;
    assert.doesNotMatch(text, /private:\d+|【示例伙伴角色的会话身份/);
    for (const rule of ['角色卡仅定义人格', '受保护会话连匿名概述和暗示也不允许', '人格本身不授予任何操作权限']) assert.ok(text.includes(rule), name + ' missing ' + rule);
  }
});
