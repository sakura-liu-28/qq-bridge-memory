import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { checkProactiveOpportunity, isProactiveAccount, isProactiveSleepTime, normalizeProactiveMisses } from '../src/proactive-check.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

test('eligible misses increase 40% to 60%, 80%, then 100%', () => {
  let misses = 0;
  for (const expected of [0.4, 0.6, 0.8]) {
    const result = checkProactiveOpportunity({ probability: 0.4, misses, random: () => 0.99 });
    assert.ok(Math.abs(result.probability - expected) < 1e-12);
    assert.equal(result.triggered, false);
    misses = result.misses;
  }
  const result = checkProactiveOpportunity({ probability: 0.4, misses, random: () => 0.99 });
  assert.equal(result.probability, 1);
  assert.equal(result.triggered, true);
  assert.equal(result.misses, 3, 'acceptance, not merely drawing a success, resets the streak');
});

test('ineligible checks and disabled probability do not draw or increase misses', () => {
  const random = () => { throw new Error('must not draw'); };
  for (const input of [{ eligible: false, probability: 0.4 }, { probability: 0 }]) {
    const result = checkProactiveOpportunity({ misses: 2, random, ...input });
    assert.equal(result.attempted, false);
    assert.equal(result.misses, 2);
  }
  assert.equal(normalizeProactiveMisses(Infinity), 0);
  assert.equal(normalizeProactiveMisses(-8), 0);
  assert.equal(normalizeProactiveMisses(100), 5);
  assert.equal(checkProactiveOpportunity({ probability: 0.004, random: () => 0 }).probability, 0.004);
});

test('pending-thought, recent-reply and frequent-message factors still apply', () => {
  const result = checkProactiveOpportunity({
    probability: 0.4, misses: 1, pendingThoughts: 1,
    recentReply: true, frequentReplies: true, random: () => 0.99,
  });
  assert.ok(Math.abs(result.probability - 0.6 * 1.4 * 0.5 * 0.3) < 1e-12);
  assert.equal(result.misses, 2);
});

async function fixture(options = {}) {
  let now = Date.parse('2026-10-27T04:00:00Z');
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
    getHours() { return 12; }
  }
  const math = Object.create(Math);
  math.random = () => 0.99;
  const h = await bridgeHarness({
    config: { socialV2: { proactive: { probability: 0.4, checkIntervalMinMs: 60000, checkIntervalMaxMs: 60000, idleThresholdMs: 600000 } } },
    ...options,
    globals: { Date: Clock, Math: math, setTimeout: (fn, ms) => ({ fn, ms, unref() {} }), clearTimeout() {} },
  });
  h.setMode('reserved2');
  return { h, now, setNow(value) { now = Date.parse(value); } };
}

test('real scheduler skips active conversations and persists eligible misses', async () => {
  const { h, now } = await fixture();
  try {
    const st = h.getSocialV2State('private:123');
    st.lastIncomingAt = now;
    st.proactiveTimer.fn();
    assert.equal(st.proactiveMisses, 0, 'not idle long enough');
    st.lastIncomingAt = now - 11 * 60000;
    h.socialV2.paused = true;
    st.proactiveTimer.fn();
    assert.equal(st.proactiveMisses, 0, 'paused timers do not accumulate misses');
    h.socialV2.paused = false;
    h.scheduleProactiveCheckV2('private:123');
    st.proactiveTimer.fn();
    assert.equal(st.proactiveMisses, 1);
    const saved = JSON.parse(fs.readFileSync(path.join(h.temp, 'state/social-v2.json'), 'utf8'));
    assert.equal(saved.conversations['private:123'].proactiveMisses, 1);
  } finally { await h.close(); }
});

test('only DSH acceptance resets the streak; rejected/offline wakes preserve it and memory', async () => {
  const { h } = await fixture();
  try {
    const st = h.getSocialV2State('private:123');
    st.proactiveMisses = 3;
    st.memberImpressions = { preference: { content: 'fixture-memory' } };
    st.recentMessages = [{ seq: 1, isSelf: false, text: 'fixture-history', time: Date.now() }];
    const memoryBefore = JSON.stringify(st.memberImpressions);
    const historyBefore = JSON.stringify(st.recentMessages);
    h.setReady(false);
    assert.equal((await h.deliverPrompt('private:123', 'fixture', { wakeReason: 'proactiveCheck', silent: true })).queued, true);
    assert.equal(st.proactiveMisses, 3);
    h.setReady(true);
    const prompt = h.api.sessions.prompt;
    h.api.sessions.prompt = async () => ({ result: { ok: false, error: { code: 'fixture', message: 'rejected' } } });
    assert.equal((await h.deliverPrompt('private:123', 'fixture', { wakeReason: 'proactiveCheck', silent: true })).ok, false);
    assert.equal(st.proactiveMisses, 3);
    h.api.sessions.prompt = prompt;
    assert.equal((await h.deliverPrompt('private:123', 'fixture', { wakeReason: 'proactiveCheck', silent: true })).ok, true);
    assert.equal(st.proactiveMisses, 0);
    assert.equal(JSON.stringify(st.memberImpressions), memoryBefore);
    assert.equal(JSON.stringify(st.recentMessages), historyBefore);
    assert.equal(h.calls.archived.length, 0);
  } finally { await h.close(); }
});

test('only the configured primary private account receives autonomous wakes', async () => {
  assert.equal(isProactiveAccount('private:123', '123'), true);
  for (const key of ['private:789', 'group:123', 'group:456']) assert.equal(isProactiveAccount(key, '123'), false);
  assert.equal(isProactiveAccount('private:123', ''), false);
  const { h } = await fixture({ config: {
    ownerQQ: 123, allow: { private: ['123', '789'], groups: ['456'] },
    socialV2: { selfLife: { privateQQ: '123' }, proactive: { enabled: true } },
  } });
  try {
    for (const key of ['private:789', 'group:456']) {
      const st = h.getSocialV2State(key);
      assert.equal(st.proactiveTimer, null);
      for (const reason of ['proactiveCheck', 'timeout', 'replyCheck', 'bootstrap']) await h.sendWakePromptV2(key, reason);
    }
    assert.equal(h.calls.prompts.length, 0);
    assert.equal(h.calls.created.length, 0);
    const incoming = h.getSocialV2State('private:789');
    incoming.lastUnreadSeq = 1;
    incoming.unread = [{ seq: 1, text: 'fixture-incoming', isSelf: false, time: Date.now() }];
    await h.sendWakePromptV2('private:789', 'private');
    assert.equal(h.calls.prompts.length, 1, 'ordinary incoming messages from other accounts still receive replies');
  } finally { await h.close(); }
});

test('restart restores the persisted streak together with existing memory and history', async () => {
  const saved = { paused: false, conversations: { 'private:123': {
    proactiveMisses: 2, memberImpressions: { fixture: 'keep' },
    recentMessages: [{ text: 'keep-history', seq: 1 }], activeTopics: [{ content: 'keep-topic' }],
  } } };
  const { h } = await fixture({ files: { 'state/social-v2.json': saved } });
  try {
    const st = h.getSocialV2State('private:123');
    assert.equal(st.proactiveMisses, 2);
    assert.equal(st.memberImpressions.fixture, 'keep');
    assert.equal(st.recentMessages[0].text, 'keep-history');
    assert.equal(st.activeTopics[0].content, 'keep-topic');
    h.saveSocialV2State();
    const loaded = JSON.parse(fs.readFileSync(path.join(h.temp, 'state/social-v2.json'), 'utf8'));
    assert.equal(loaded.conversations['private:123'].proactiveMisses, 2);
  } finally { await h.close(); }
});

test('sleep has independent timezone-aware boundaries', () => {
  for (const time of ['2026-10-27T15:00:00Z', '2026-10-27T23:59:59Z']) {
    assert.equal(isProactiveSleepTime(new Date(time)), true);
  }
  for (const time of ['2026-10-27T14:59:59Z', '2026-10-28T00:00:00Z']) {
    assert.equal(isProactiveSleepTime(new Date(time)), false);
  }
  assert.equal(isProactiveSleepTime(new Date('2026-10-27T15:00:00Z'), { enabled: false }), false);
  assert.equal(isProactiveSleepTime(new Date('2026-10-27T04:00:00Z'), { start: '11:00', end: '13:00' }), true);
});

test('sleep preserves the streak and blocks autonomous wakes; morning resumes it', async () => {
  const { h, setNow } = await fixture();
  try {
    const st = h.getSocialV2State('private:123');
    st.proactiveMisses = 2;
    setNow('2026-10-27T15:00:00Z');
    st.proactiveTimer.fn();
    assert.equal(st.proactiveMisses, 2);
    for (const reason of ['proactiveCheck', 'timeout', 'replyCheck', 'bootstrap']) await h.sendWakePromptV2('private:123', reason);
    assert.equal(h.calls.prompts.length, 0);
    const queued = await h.deliverPrompt('private:123', 'queued-before-sleep', { wakeReason: 'proactiveCheck' });
    assert.equal(queued.skipped, true, 'dispatch rechecks sleep when a queued wake becomes ready');
    assert.equal(st.proactiveMisses, 2);
    setNow('2026-10-28T00:00:00Z');
    st.proactiveTimer.fn();
    assert.equal(st.proactiveMisses, 3, 'morning resumes at the accumulated 80%, rather than restarting at 40%');
    setNow('2026-10-28T15:00:00Z');
    st.lastUnreadSeq = 1;
    st.unread = [{ seq: 1, text: 'incoming-at-night', isSelf: false, time: Date.now() }];
    await h.sendWakePromptV2('private:123', 'private');
    assert.equal(h.calls.prompts.length, 1, 'a real inbound message can still receive a reply during sleep');
  } finally { await h.close(); }
});
