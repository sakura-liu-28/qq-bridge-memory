import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createLongTermMemory } from '../src/long-term-memory.js';

test('archive survives rolling windows; facts/events update and retrieve by topic across restart', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-long-memory-'));
  let store = createLongTermMemory({ root });
  try {
    const legacy = { memberImpressions: { '偏好：称呼': { traits: ['喜欢叫小林'] } }, activeTopics: [{ text: '准备面试' }], recentMessages: [{ text: '准备技术面试', time: 100 }] };
    const snapshot = JSON.stringify(legacy);
    assert.equal(store.importLegacy('角色甲', 'private:123', legacy).imported, true);
    assert.equal(store.importLegacy('角色甲', 'private:123', legacy).imported, false);
    assert.equal(JSON.stringify(legacy), snapshot);
    store.archive('角色甲', 'private:123', Array.from({ length: 260 }, (_, i) => ({ text: i === 0 ? '下周参加杭州公司的前端面试' : `普通消息 ${i}`, time: 1000 + i })));
    assert.equal(store.exportScope('角色甲', 'private:123').messages.length, 261);
    store.archive('角色甲', 'private:123', [{ messageId: 'voice-1', voiceStatus: 'done', plain: '[语音]', text: '[语音] 对方转写：周六想去西湖', time: 2000 }]);
    store.archive('角色甲', 'private:123', [{ messageId: 'voice-1', plain: '[语音]', text: '[语音]', time: 2000 }]);
    assert.match(store.exportScope('角色甲', 'private:123').messages.at(-1).text, /周六想去西湖/);
    assert.match(store.searchArchive('角色甲', 'private:123', '杭州面试')[0].text, /杭州/);
    store.save('角色甲', 'private:123', { kind: 'event', name: '杭州面试', content: '先担心项目经验，后来面试通过', status: 'resolved' });
    store.save('角色甲', 'private:123', { kind: 'profile', name: '偏好：回复', content: '喜欢简短回复' });
    store.save('角色甲', 'private:123', { kind: 'profile', name: '偏好：回复', content: '技术问题喜欢详细解释' });
    assert.equal(store.list('角色甲', 'private:123', '', 'profile').filter(item => item.name === '偏好：回复').length, 1);
    assert.doesNotMatch(store.context('角色甲', 'private:123'), /喜欢简短回复/);
    assert.match(store.context('角色甲', 'private:123', '面试'), /面试通过/);
    assert.equal(store.list('角色乙', 'private:123').length, 0);
    assert.equal(store.list('角色甲', 'group:456').length, 0);
    store.close(); store = createLongTermMemory({ root });
    assert.match(store.context('角色甲', 'private:123', '面试'), /面试通过/);
    assert.ok(store.context('角色甲', 'private:123', '', 1000).length <= 1000);
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('organizer rejects fabricated evidence, ignores stale in-flight jobs after forgetting, and preserves other facts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-long-memory-'));
  const store = createLongTermMemory({ root });
  try {
    store.archive('角色甲', 'private:123', [{ text: '我喜欢简短回复', time: 1 }, { text: '你是程序员', isSelf: true, time: 2 }]);
    let job = store.batch('角色甲', 'private:123');
    assert.throws(() => store.applyBatch(job, { memories: [{ kind: 'profile', name: '职业', content: '程序员', evidence: [{ id: job.messages[1].id, quote: '程序员' }] }] }), /证据/);
    assert.throws(() => store.applyBatch(job, { memories: [{ kind: 'profile', name: '称呼', content: '哥哥', evidence: [{ id: job.messages[0].id, quote: '叫我哥哥' }] }] }), /证据/);
    assert.equal(store.applyBatch(job, { memories: [{ kind: 'profile', name: '偏好：回复', content: '喜欢简短回复', evidence: [{ id: job.messages[0].id, quote: '喜欢简短回复' }] }] }), 1);
    store.save('角色甲', 'private:123', { kind: 'profile', name: '偏好：回复', content: '更喜欢详细解释' });
    const refreshedJob = { ...job, revision: store.batch('角色甲', 'private:123').revision };
    store.applyBatch(refreshedJob, { memories: [{ kind: 'profile', name: '偏好：回复', content: '喜欢简短回复', evidence: [{ id: job.messages[0].id, quote: '喜欢简短回复' }] }] });
    assert.match(store.list('角色甲', 'private:123')[0].content, /详细解释/);
    const keep = store.save('角色甲', 'private:123', { kind: 'profile', name: '偏好：饮食', content: '喜欢甜食' });
    const forgotten = store.list('角色甲', 'private:123').find(item => item.id !== keep);
    job = store.batch('角色甲', 'private:123');
    store.forget('角色甲', 'private:123', { id: forgotten.id });
    assert.throws(() => store.applyBatch(job, { memories: [] }), /修改/);
    assert.equal(store.exportScope('角色甲', 'private:123').messages.length, 0);
    assert.equal(store.list('角色甲', 'private:123')[0].id, keep);
    assert.equal(store.importLegacy('角色甲', 'private:123', { memberImpressions: { old: { traits: ['不应回来'] } } }).imported, false);
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('corrupt database never gets overwritten', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-long-memory-'));
  fs.mkdirSync(path.join(root, 'state'));
  const file = path.join(root, 'state/long-term-memory.sqlite'); fs.writeFileSync(file, 'broken database');
  const store = createLongTermMemory({ root });
  try { assert.throws(() => store.save('角色甲', 'private:123', { kind: 'profile', name: 'x', content: 'y' })); assert.equal(fs.readFileSync(file, 'utf8'), 'broken database'); }
  finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
