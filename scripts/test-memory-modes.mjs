import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { createLongTermMemory } from '../src/long-term-memory.js';

test('mode switch and explicit copy retain legacy bytes; management is denied to agents; long mode wakes and survives restart', async () => {
  const files = { 'state/current-role.json': { role: '角色甲', mode: 'active' }, 'roles/角色甲.md': '# 角色甲',
    'config.personal.json': { version: 1, rolePolicies: { '角色甲': { sessionPrompts: { 'private:123': '本私聊的专属称呼为小林' } } } } };
  const h = await bridgeHarness({ files }); h.setMode('reserved2');
  const server = h.startConsoleServer(); if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const request = async (url, body, agent = false) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${url}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token', ...(agent ? { 'x-agent-token': h.getSocialV2State('private:123').agentToken } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, ...await response.json() };
  };
  try {
    assert.equal((await request('/api/memory/settings')).settings.mode, 'lightweight');
    assert.equal((await request('/api/socialV2/memory-append', { key: 'private:123', category: 'memberImpression', content: '喜欢简短回复', extra: { target: '偏好：回复' } })).persisted, true);
    const legacy = fs.readFileSync(path.join(h.temp, 'state/social-v2.json'), 'utf8');
    assert.equal((await request('/api/memory/settings', { mode: 'long-term' }, true)).status, 403);
    assert.equal((await request('/api/memory/settings', { mode: 'long-term', autoOrganize: false })).persisted, true);
    assert.equal(fs.readFileSync(path.join(h.temp, 'state/social-v2.json'), 'utf8'), legacy);
    assert.equal((await request('/api/memory/import', { key: 'private:123' })).imported, true);
    assert.equal(fs.readFileSync(path.join(h.temp, 'state/social-v2.json'), 'utf8'), legacy);
    assert.match(h.buildWakePromptV2('private:123', 'private'), /长期记忆[\s\S]*喜欢简短回复/);
    assert.match(h.buildWakePromptV2('private:123', 'private'), /专属称呼为小林/);
    assert.doesNotMatch(h.buildWakePromptV2('group:456', 'group'), /专属称呼为小林/);
    const edit = await request('/api/socialV2/memory-append', { key: 'private:123', category: 'memberImpression', content: '技术问题需要详细回复', extra: { target: '偏好：回复', replace: true } }, true);
    assert.equal(edit.persisted, true);
    assert.match((await request('/api/socialV2/memory?key=private:123')).formatted, /详细回复/);
    h.appendSocialV2Message('private:123', '测试', 'x'.repeat(500), 'x'.repeat(500), false, true, 1);
    assert.equal(h.longMemory.exportScope('角色甲', 'private:123').messages.at(-1).text.length, 500);
    assert.equal((await request('/api/memory/export?key=private:123', undefined, true)).status, 403);
    assert.equal((await request('/api/memory/settings', { mode: 'lightweight' })).persisted, true);
    assert.match((await request('/api/socialV2/memory?key=private:123')).formatted, /喜欢简短回复/);
    assert.doesNotMatch((await request('/api/socialV2/memory?key=private:123')).formatted, /需要详细回复/);
    const diskConfig = JSON.parse(fs.readFileSync(path.join(h.temp, 'config.json'))); assert.equal(diskConfig.dsh.authToken, 'fixture-only');
    await request('/api/memory/settings', { mode: 'long-term' });
    assert.match(h.buildWakePromptV2('private:123', 'private'), /需要详细回复/);
  } finally { await new Promise(resolve => server.close(resolve)); await h.close(); }
});

test('background organizer uses a tool-free preset, saves validated facts and never sends QQ replies', async () => {
  const h = await bridgeHarness({ config: { socialV2: { memory: { mode: 'long-term', autoOrganize: false } } },
    files: { 'state/current-role.json': { role: '角色甲', mode: 'active' } } });
  h.setMode('reserved2'); h.setPresets(['qq-chat', 'qq-chat-v2', 'qq-memory']);
  try {
    h.appendSocialV2Message('private:123', '用户', '我喜欢简短回复', '我喜欢简短回复', false, true, 1);
    const evidence = h.longMemory.batch('角色甲', 'private:123').messages[0];
    h.api.sessions.prompt = async params => {
      h.calls.prompts.push(params);
      const waiter = h.learnerWaiters.get(params.sessionId)[0];
      waiter.resolve(JSON.stringify({ memories: [{ kind: 'profile', name: '偏好：回复', content: '喜欢简短回复', evidence: [{ id: evidence.id, quote: '喜欢简短回复' }] }] }));
      return { result: { ok: true, value: {} } };
    };
    assert.equal((await h.organizeMemory('private:123', true)).persisted, true);
    assert.equal(h.calls.created[0].agentPreset, 'qq-memory');
    assert.equal(h.calls.sent.length, 0);
    assert.match(h.buildWakePromptV2('private:123', 'private'), /喜欢简短回复/);
    assert.doesNotMatch(h.calls.prompts[0].content[0].text, new RegExp(h.getSocialV2State('private:123').agentToken));
    await h.handleRecallNotice({ notice_type: 'friend_recall', user_id: 123, message_id: 1 });
    assert.equal(h.longMemory.list('角色甲', 'private:123').length, 0);
    assert.equal(h.longMemory.exportScope('角色甲', 'private:123').messages.length, 0);
  } finally { await h.close(); }
});

test('lightweight strategy retains old facts and expired thoughts across append/restart, and archives beyond the recent window', async () => {
  const old = Date.now() - 365 * 24 * 60 * 60 * 1000;
  const topics = Array.from({ length: 65 }, (_, i) => ({ text: `历史话题${i}`, lastMentionAt: old }));
  const thoughts = Array.from({ length: 65 }, (_, i) => ({ text: `过去的想法${i}`, expiresAt: old }));
  const impressions = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`好友${i}`, { traits: Array.from({ length: 15 }, (_, j) => `特质${j}`), lastSeenAt: old }]));
  const h = await bridgeHarness({ files: { 'state/current-role.json': { role: '角色甲', mode: 'active' },
    'state/social-v2.json': { conversations: { 'private:123': { activeTopics: topics, pendingThoughts: thoughts, memberImpressions: impressions } } } } });
  h.setMode('reserved2');
  const server = h.startConsoleServer(); if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const call = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/socialV2/${path}`, {
      method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token' }, body: body ? JSON.stringify(body) : undefined });
    return response.json();
  };
  try {
    for (const category of ['activeTopic', 'pendingThought', 'memberImpression']) {
      assert.equal((await call('memory-append', { key: 'private:123', category, content: '新增记忆', extra: { target: '好友0' } })).persisted, true);
    }
    h.loadSocialV2State();
    const stored = (await call('memory?key=private:123')).raw;
    assert.equal(stored.activeTopics.length, 66);
    assert.equal(stored.pendingThoughts.length, 66);
    assert.equal(Object.keys(stored.memberImpressions).length, 65);
    assert.equal(stored.memberImpressions['好友0'].traits.length, 16);
    assert.ok(stored.pendingThoughts.some(item => item.text === '过去的想法0'));
    for (let i = 0; i < 240; i++) h.appendSocialV2Message('private:123', '好友', i === 0 ? '很久前谈过天文望远镜' : `聊天消息${i}`, undefined, false, false, i + 1);
    assert.equal(h.longMemory.exportScope('角色甲', 'private:123').messages.length, 240);
    assert.match((await call('memory?key=private:123&query=' + encodeURIComponent('天文望远镜'))).formatted, /天文望远镜/);
    h.longMemory.close();
    const reopened = createLongTermMemory({ root: h.temp });
    try { assert.equal(reopened.exportScope('角色甲', 'private:123').messages.length, 240); } finally { reopened.close(); }
    assert.equal((await call('memory-clear', { key: 'private:123' })).persisted, true);
    assert.equal((await call('memory?key=private:123&query=' + encodeURIComponent('天文望远镜'))).raw.history.length, 0);
  } finally { await new Promise(resolve => server.close(resolve)); await h.close(); }
});
