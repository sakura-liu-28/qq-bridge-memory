import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { createRoleExperiences, formatRoleExperiences } from '../src/role-experiences.js';

const config = { allow: { private: [123, 789], groups: [456] }, socialV2: { sticker: { enabled: false }, proactive: { enabled: false } } };
const files = { 'config.personal.json': { version: 1, privacy: { protectedQQs: ['987654321'] } }, 'state/current-role.json': { role: '示例伙伴', mode: 'active' } };
async function fixture(run, options = {}) {
  const h = await bridgeHarness({ config, files, ...options });
  h.setMode('reserved2');
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise(r => server.once('listening', r));
  const call = async (key, action, body, token = h.getSocialV2State(key).agentToken) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/socialV2/${action}${body ? '' : `${action.includes('?') ? '&' : '?'}key=${encodeURIComponent(key)}`}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'x-console-token': 'fixture-console-token', 'x-agent-call': '1', 'x-agent-token': token, 'content-type': 'application/json' },
      body: body ? JSON.stringify({ key, ...body }) : undefined
    });
    return { status: res.status, ...await res.json() };
  };
  const receive = async (key, sender, text) => {
    h.appendSocialV2Message(key, sender, text, text, false, false, 100);
    assert.equal((await call(key, 'unread')).ok, true);
  };
  const send = (key, text) => call(key, 'send-message', { messages: [text] });
  try { return await run({ h, call, receive, send, file: path.join(h.temp, 'state/role-experiences.json') }); }
  finally { await new Promise(r => server.close(r)); await h.close(); }
}

test('actual send creates a shared experience; local preferences stay local; query, prompt and restart see it', async () => {
  const disk = await fixture(async ({ h, receive, send, call, file }) => {
    await h.handleIncoming('private', '789', { user_id: 789, self_id: 999, message_id: 77, sender: { nickname: '小明' }, message: [{ type: 'text', data: { text: '今天在玩原神，卡在一个任务了' } }] }, h.cfg);
    await call('private:789', 'unread');
    assert.equal((await send('private:789', '我跟小明聊了原神任务，给了他一点建议')).ok, true);
    const shared = await call('private:123', 'memory?category=experience&query=原神');
    assert.equal(shared.raw.experiences.length, 1);
    assert.equal(shared.raw.experiences[0].key, 'private:789');
    assert.match(shared.formatted, /小明.*原神/s);
    assert.match(h.buildWakePromptV2('private:123', 'private'), /实际聊天摘录.*原神/);
    assert.match((await call('private:123', 'prompt')).experiences, /小明.*原神/s);
    await call('private:789', 'memory-append', { category: 'memberImpression', content: '喜欢喝抹茶', extra: { target: '偏好：饮料' } });
    assert.deepEqual((await call('private:123', 'memory')).raw.memberImpressions, {});
    const summarized = await call('private:789', 'memory-append', { category: 'experience', content: '与小明聊了原神任务，并给了建议。' });
    assert.equal(summarized.persisted, true);
    assert.equal((await call('private:123', 'memory?category=experience')).raw.experiences[0].kind, 'summary');
    return fs.readFileSync(file, 'utf8');
  });
  await fixture(async ({ h }) => {
    assert.match(h.buildWakePromptV2('group:456', 'bootstrap'), /与小明聊了原神任务/);
    fs.writeFileSync(path.join(h.temp, 'state/current-role.json'), JSON.stringify({ role: '示例角色乙', mode: 'active' }));
    assert.doesNotMatch(h.buildWakePromptV2('private:123', 'private'), /原神/);
    fs.writeFileSync(path.join(h.temp, 'state/current-role.json'), JSON.stringify({ role: '示例伙伴', mode: 'active' }));
    h.cfg.allow.private = [123];
    assert.doesNotMatch(h.buildWakePromptV2('private:123', 'private'), /原神/);
  }, { files: { ...files, 'state/role-experiences.json': disk } });
});

test('conversation tokens cannot impersonate a source; source-scoped editing and forgetting', async () => fixture(async ({ h, receive, send, call }) => {
  await receive('private:789', '小明', '聊游戏');
  await send('private:789', '聊了游戏');
  await receive('group:456', '小红', '聊电影');
  await send('group:456', '聊了电影');
  const entry = (await call('private:123', 'memory?category=experience')).raw.experiences.find(e => e.key === 'private:789');
  const forged = await call('private:789', 'memory', undefined, h.getSocialV2State('private:123').agentToken);
  assert.equal(forged.status, 403);
  assert.equal((await call('group:456', 'memory-append', { category: 'experience', content: '冒充小明的经历', extra: { experienceId: entry.id } })).ok, false);
  assert.equal((await call('group:456', 'memory-remove', { category: 'experience', content: entry.summary })).removed, 0);
  assert.equal((await call('private:789', 'memory-clear', { category: 'experience' })).persisted, true);
  const left = (await call('private:123', 'memory?category=experience')).raw.experiences;
  assert.equal(left.length, 1);
  assert.equal(left[0].key, 'group:456');
  assert.equal((await call('group:456', 'memory-clear', {})).persisted, true);
  assert.equal((await call('private:123', 'memory?category=experience')).raw.experiences.length, 0);
}));

test('smart strategy uses the same durable shared experience journal', async () => fixture(async ({ h, receive, send, call }) => {
  h.cfg.socialV2.memory.mode = 'long-term';
  await receive('private:789', '小明', '今天一起聊了天文');
  assert.equal((await send('private:789', '聊了望远镜和观星')).ok, true);
  const result = await call('private:123', 'memory?category=experience&query=天文');
  assert.equal(result.raw.experiences.length, 1);
  assert.match(result.formatted, /天文/);
  assert.equal((await call('private:789', 'memory-append', { category: 'experience', content: '与小明聊了天文和观星' })).persisted, true);
  assert.match((await call('private:123', 'memory')).raw.experiences[0].summary, /观星/);
  assert.equal((await call('private:789', 'memory-clear', {})).persisted, true);
  assert.equal((await call('private:123', 'memory?category=experience')).raw.experiences.length, 0);
}));

test('unread messages alone, denied/failed sends and unseen incoming text do not become experienced topics', async () => fixture(async ({ h, call, receive, send, file }) => {
  h.appendSocialV2Message('private:789', '小明', '从未被模型读到的话题', '从未被模型读到的话题', false, false, 1);
  assert.equal(fs.existsSync(file), false);
  await send('private:789', '我先打个招呼');
  assert.doesNotMatch((await call('private:123', 'memory?category=experience')).formatted, /从未被模型读到的话题/);
  await call('private:789', 'memory-clear', { category: 'experience' });
  await receive('private:789', '小明', '这次会发送失败');
  assert.equal((await call('private:789', 'send-message', { messages: ['不会发送'] }, 'invalid-token')).status, 403);
  assert.equal((await call('private:123', 'memory?category=experience')).raw.experiences.length, 0);
  const h2 = await bridgeHarness({ config, files, globals: { fetch: async () => { throw new Error('fixture gateway unavailable'); } } });
  try {
    h2.setMode('reserved2');
    // Exercise the real HTTP send handler, whose gateway fetch is the failing VM stub.
    const server = h2.startConsoleServer();
    if (!server.listening) await new Promise(r => server.once('listening', r));
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/socialV2/send-message`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token', 'x-agent-token': h2.getSocialV2State('private:789').agentToken }, body: JSON.stringify({ key: 'private:789', messages: ['失败消息'] }) });
      assert.equal((await res.json()).ok, false);
      assert.equal(fs.existsSync(path.join(h2.temp, 'state/role-experiences.json')), false);
    } finally { await new Promise(r => server.close(r)); }
  } finally { await h2.close(); }
}));

test('redaction, write failure rollback and corrupt file preservation', async () => fixture(async ({ h, receive, send, call, file }) => {
  const token = h.getSocialV2State('private:123').agentToken;
  await receive('private:789', '小明', `token=secret-value ${token} https://example.com/private?access=secret`);
  await send('private:789', '我知道了');
  const disk = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(disk, /secret-value|access=secret/);
  assert.equal(disk.includes(token), false);
  const socialFile = path.join(h.temp, 'state/social-v2.json');
  const socialDisk = fs.readFileSync(socialFile, 'utf8');
  fs.unlinkSync(socialFile);
  fs.mkdirSync(socialFile);
  assert.equal((await call('private:789', 'memory-clear', {})).ok, false);
  assert.equal(fs.readFileSync(file, 'utf8'), disk, 'failed combined clear restores shared experiences');
  fs.rmdirSync(socialFile);
  fs.writeFileSync(socialFile, socialDisk);
  fs.unlinkSync(file);
  fs.mkdirSync(file);
  assert.equal((await call('private:789', 'memory-append', { category: 'experience', content: '不应成功' })).ok, false);
  assert.doesNotThrow(() => h.recordSentMessagesV2('private:789', ['发送已经成功，记忆失败不能重复发']));
  assert.match(h.buildWakePromptV2('private:123', 'private'), /跨会话经历暂时无法读取/);
  fs.rmdirSync(file);
  fs.writeFileSync(file, disk);
  assert.doesNotMatch((await call('private:123', 'memory?category=experience')).formatted, /不应成功/);
  fs.writeFileSync(file, '{broken');
  assert.equal((await call('private:789', 'memory-clear', { category: 'experience' })).ok, false);
  h.recordSentMessagesV2('private:789', ['不覆盖损坏文件']);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
}));

test('permanent retention, burst deduplication and bounded prompt selection across conversations', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-experiences-'));
  let clock = Date.now();
  const file = path.join(dir, 'journal.json');
  const store = createRoleExperiences({ file, write: (f, value) => fs.writeFileSync(f, JSON.stringify(value)), sanitize: String, now: () => clock });
  const record = (key, seq) => store.record({ role: '示例伙伴', key, messages: [{ sender: '好友', seq, plain: `话题${seq}` }], replies: [`回复${seq}`] });
  try {
    record('private:789', 1);
    const id = record('private:123', 1).id;
    assert.equal(record('private:123', 1).id, id);
    assert.equal(store.list({ role: '示例伙伴' }).length, 2);
    store.summarize({ role: '示例伙伴', key: 'private:123', content: '与好友聊了具体话题。' });
    store.record({ role: '示例伙伴', key: 'private:123', messages: [{ sender: '好友', seq: 1, plain: '话题1' }], replies: ['后来补充了一句'] });
    assert.match(store.list({ role: '示例伙伴' }).find(e => e.id === id).summary, /与好友聊了具体话题。.*后来补充了一句/);
    for (let i = 2; i < 30; i++) { clock++; record('private:123', i); }
    const entries = store.list({ role: '示例伙伴' });
    assert.equal(entries.length, 12);
    assert.ok(entries.some(e => e.key === 'private:789'));
    assert.ok(formatRoleExperiences(entries, 'private:123').length < 4500);
    for (let i = 30; i < 220; i++) { clock++; record('private:123', i); }
    assert.equal(JSON.parse(fs.readFileSync(file)).entries.length, 220);
    clock += 31 * 24 * 60 * 60 * 1000;
    assert.equal(store.list({ role: '示例伙伴' }).length, 12);
    assert.equal(store.list({ role: '示例伙伴', query: '具体话题' }).length, 1);
    assert.equal(JSON.parse(fs.readFileSync(file)).entries.length, 220);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('protected private chat keeps local memory, reads other experiences, and cannot publish its own', async () => fixture(async ({ h, call, receive, send, file }) => {
  const key = 'private:987654321';
  await receive(key, '私聊对象', '专属私聊秘密，不可对外分享');
  assert.equal((await send(key, '这个约定只在我们之间')).ok, true);
  assert.equal(fs.existsSync(file), false, 'protected sends never create shared records');
  assert.equal((await call(key, 'memory-append', { category: 'activeTopic', content: '专属私聊秘密，不可对外分享' })).persisted, true);
  const rejected = await call(key, 'memory-append', { category: 'experience', content: '匿名概述私聊秘密' });
  assert.equal(rejected.status, 403);
  assert.match((await call(key, 'memory')).formatted, /专属私聊秘密/);
  await receive('private:789', '小明', '聊普通游戏');
  await send('private:789', '普通游戏聊得不错');
  for (const recipient of ['private:123', 'group:456']) {
    assert.doesNotMatch(JSON.stringify(await call(recipient, 'memory')), /专属私聊秘密|这个约定只在我们之间/);
    assert.doesNotMatch((await call(recipient, 'prompt')).experiences, /专属私聊秘密|这个约定只在我们之间/);
    assert.doesNotMatch(h.buildWakePromptV2(recipient, 'private'), /专属私聊秘密|这个约定只在我们之间/);
    assert.equal((await call(recipient, 'memory?category=experience&query=私聊秘密')).raw.experiences.length, 0);
  }
  assert.match((await call(key, 'memory?category=experience')).formatted, /普通游戏/);
  assert.match(h.buildWakePromptV2(key, 'private'), /本私聊绝对保密/);
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /专属私聊秘密|这个约定只在我们之间/);
}, { config: { ...config, allow: { private: [123, 789, 987654321], groups: [456] } } }));

test('startup removes legacy protected records for every role; formatting also rejects them', async () => {
  const at = Date.now();
  const entry = { id: 'private-fixture', key: 'private:987654321', role: '示例伙伴', at, inputSeq: 1, label: '私聊对象', summary: '遗留的保密内容', kind: 'summary' };
  const safe = { ...entry, id: 'safe-fixture', key: 'private:789', summary: '普通游戏内容' };
  assert.doesNotMatch(formatRoleExperiences([entry, safe], 'private:123', ['987654321']), /遗留的保密内容/);
  await fixture(async ({ call, file }) => {
    assert.deepEqual(JSON.parse(fs.readFileSync(file)).entries.map(e => e.id), ['safe-fixture']);
    const data = await call('private:123', 'memory?category=experience');
    assert.equal(data.raw.experiences.length, 1);
    assert.doesNotMatch(JSON.stringify(data), /遗留的保密内容/);
  }, { files: { ...files, 'state/role-experiences.json': { version: 1, entries: [entry, { ...entry, id: 'another-role', role: '示例角色乙' }, safe] } } });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-private-experiences-'));
  const file = path.join(dir, 'journal.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, entries: [entry, safe] }));
  const store = createRoleExperiences({ file, write: () => { throw new Error('fixture write failure'); }, sanitize: String, protectedQQs: ['987654321'] });
  try {
    assert.throws(() => store.purgePrivate(), /fixture write failure/);
    assert.deepEqual(store.list({ role: '示例伙伴' }).map(e => e.id), ['safe-fixture'], 'failed disk cleanup cannot expose protected records');
    assert.throws(() => store.summarize({ role: '示例伙伴', key: 'private:0987654321', content: '不能用别名绕过' }), /受保护会话/);
    assert.equal(store.record({ role: '示例伙伴', key: entry.key, replies: ['不可分享'] }), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('protected sender messages in a group are not turned into shared excerpts or summaries', async () => fixture(async ({ h, receive, send, call, file }) => {
  await receive('group:456', '小明', '普通群聊内容');
  await send('group:456', '普通群聊回复');
  const before = fs.readFileSync(file, 'utf8');
  h.appendSocialV2Message('group:456', '受保护对象', '群内受保护消息', '群内受保护消息', false, false, 101, [], '987654321');
  await call('group:456', 'unread');
  assert.equal((await send('group:456', '回应这条受保护消息')).ok, true);
  assert.equal((await call('group:456', 'memory-append', { category: 'experience', content: '不能概述群内受保护消息' })).status, 403);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.doesNotMatch((await call('private:123', 'memory?category=experience')).formatted, /群内受保护消息|回应这条受保护消息/);
}));
