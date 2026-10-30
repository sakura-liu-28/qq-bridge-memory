// Offline regression: no QQ gateway, provider API or production state is used.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { synthesizeSpeech } from '../src/online-tts.js';

const h = await bridgeHarness({ config: { socialV2: {
  send: { burstMaxMessages: 0, maxMessageChars: 0, burstIntervalMinMs: 1, burstIntervalMaxMs: 1,
    longGapProbability: 0, maxSendPerMinute: 0, maxSendPerHour: 0 },
  wake: { preSleepWaitEnabled: false }, proactive: { sleep: { enabled: false } }
} } });
let server;
try {
  h.setMode('reserved2');
  const token = h.getSocialV2State('private:123').agentToken;
  server = h.startConsoleServer();
  if (!server.listening) await new Promise(r => server.once('listening', r));
  const call = async (route, body, agentToken = token) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
      method: 'POST', headers: { 'content-type': 'application/json',
        'x-console-token': 'fixture-console-token', 'x-agent-call': '1', 'x-agent-token': agentToken },
      body: JSON.stringify(body)
    });
    return { status: r.status, body: await r.json() };
  };
  const messages = Array.from({ length: 9 }, (_, i) => `${i} ${'今天想和你聊聊。'.repeat(80)}`);
  for (const route of ['/api/socialV2/send-message', '/api/socialV2/send-burst']) {
    const sent = () => h.calls.http.filter(c => c.url.endsWith('/send_private_msg'));
    const before = sent().length;
    const r = await call(route, { key: 'private:123', messages, gapMode: 'fixed', gapMs: 1 });
    assert.equal(r.status, 200, JSON.stringify(r));
    assert.equal(sent().length - before, 9);
    assert.ok(sent().at(-1).body.message.some(segment => segment.type === 'text' && segment.data.text.length > 500), '长消息不得被静默截断');
    assert.equal((await call(route, { key: 'private:123', messages }, 'wrong')).status, 403);
    h.cfg.socialV2.send.burstMaxMessages = 2;
    assert.equal((await call(route, { key: 'private:123', messages })).status, 400);
    h.cfg.socialV2.send.burstMaxMessages = 0;
    h.cfg.socialV2.send.maxMessageChars = 20;
    assert.equal((await call(route, { key: 'private:123', messages: [messages[0]] })).status, 400);
    h.cfg.socialV2.send.maxMessageChars = 0;
  }
  assert.equal((await call('/api/send/private', { userId: '123', message: messages[0], token })).status, 200);
  assert.equal((await call('/api/socialV2/send-message', {
    key: 'private:123', messages: ['secret=abcdefgh']
  })).status, 403, '不限长度不应绕过敏感信息拦截');
  for (const reason of ['private', 'proactiveCheck', 'replyCheck']) {
    const prompt = h.buildWakePromptV2('private:123', reason);
    assert.ok(prompt.includes('强制沉睡前观察已关闭'));
    assert.ok(!prompt.includes('【沉睡前强制等待】'));
    assert.ok(prompt.includes('正当'));
  }
  // Non-owner background wakes remain forbidden even with the nighttime gate disabled.
  await h.sendWakePromptV2('group:456', 'proactiveCheck');
  assert.equal(h.calls.prompts.length, 0);
  console.log('PASS zero limits allow long/multiple messages; explicit limits, privacy and owner scope remain enforced');
} finally {
  if (server) await new Promise(r => server.close(r));
  await h.close();
}

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'expression-tts-'));
try {
  const executable = path.join(dir, 'fake-python');
  await fs.writeFile(executable, `#!${process.execPath}\n` +
    `const fs=require('node:fs'); const text=fs.readFileSync(process.argv[4],'utf8');
if(text.length<=400)process.exit(2); fs.writeFileSync(process.argv[5],Buffer.from('fake audio'));\n`, { mode: 0o700 });
  const config = { socialV2: { voice: { enabled: true, tts: {
    enabled: true, provider: 'edge', pythonPath: executable, voice: 'zh-CN-XiaoxiaoNeural', rate: '+0%'
  } } } };
  const audio = await synthesizeSpeech({ text: '你好。'.repeat(160), config, root: dir });
  assert.ok((await fs.stat(audio.file)).size > 0);
  await audio.cleanup();
  await assert.rejects(synthesizeSpeech({ text: '', config, root: dir }), /不能为空/);
  await assert.rejects(synthesizeSpeech({ text: 'secret=abcdefgh', config, root: dir }), /敏感|内部/);
  console.log('PASS speech longer than 400 characters reaches synthesis; empty and sensitive content rejected');
} finally { await fs.rm(dir, { recursive: true, force: true }); }
