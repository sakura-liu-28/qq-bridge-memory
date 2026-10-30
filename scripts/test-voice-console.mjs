import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { voiceBridgeView, updateVoiceBridge } from '../src/voice-console.js';
const config = { socialV2: { voice: { enabled: true, tts: { apiKeyPath: '/fixture/private-key' }, realtime: { enabled: true, apiKeyPath: '/fixture/private-key', voice: 'S_fixture', role: '示例伙伴', enableMusic: false, native: { enabled: true, privateQQ: '987654321', tokenFile: '/fixture/control-token', bridgeUrl: 'http://127.0.0.1:6110', maxSeconds: 1800 } } } } };
const input = { enabled: false, nativeEnabled: false, voice: 'S_updated', voiceName: '新音色', maxSeconds: 900 };
const next = updateVoiceBridge(config, input);
assert.deepEqual(updateVoiceBridge(config,{...input,allowedCallers:['123','124','123']}).socialV2.voice.realtime.native.allowedCallers,['123','124']);
assert.throws(()=>updateVoiceBridge(config,{...input,allowedCallers:['0']}));
assert.throws(()=>updateVoiceBridge(config,{...input,allowedCallers:['123abc']}));
assert.equal(next.socialV2.voice.realtime.native.privateQQ, '987654321');
assert.equal(next.socialV2.voice.realtime.native.tokenFile, '/fixture/control-token');
assert.equal(next.socialV2.voice.realtime.enableMusic, false);
assert.equal(config.socialV2.voice.realtime.voice, 'S_fixture');
assert.doesNotMatch(JSON.stringify(voiceBridgeView(config)), /private-key|control-token|bridgeUrl|apiKeyPath/);
for (const bad of [{ ...input, maxSeconds: 1 }, { ...input, nativeEnabled: true }, { ...input, privateQQ: '999' }, { ...input, tokenFile: '/etc/passwd' }, { ...input, voice: '<script>' }, null]) assert.throws(() => updateVoiceBridge(config, bad));
const h = await bridgeHarness({ config });
const server = h.startConsoleServer();
if (!server.listening) await new Promise(r => server.once('listening', r));
const call = async (body, headers = {}) => {
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/voice/bridge-settings`, { method: body === undefined ? 'GET' : 'POST', headers: { 'x-console-token': 'fixture-console-token', 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, ...await res.json() };
};
try {
  assert.equal((await call()).settings.callerQQ, '987654321');
  assert.equal((await call(undefined, { 'x-agent-token': h.getSocialV2State('private:123').agentToken })).status, 403);
  assert.equal((await call(undefined, { 'x-agent-call': '1' })).status, 403);
  assert.equal((await call({...input,allowedCallers:['123','124']})).persisted, true);
  assert.deepEqual(h.cfg.socialV2.voice.realtime.native.allowedCallers,['123','124']);
  assert.equal(h.cfg.socialV2.voice.realtime.voice, 'S_updated');
  const file = path.join(h.temp, 'config.json');
  const disk = fs.readFileSync(file, 'utf8');
  assert.equal(JSON.parse(disk).socialV2.voice.realtime.native.privateQQ, '987654321');
  assert.equal((await call({ ...input, enabled: true })).status, 400, 'enabling requires a usable server key');
  assert.equal(fs.readFileSync(file, 'utf8'), disk);
  fs.renameSync(file, file + '.saved'); fs.mkdirSync(file);
  assert.equal((await call({ ...input, voice: 'S_unpersisted' })).ok, false);
  assert.equal(h.cfg.socialV2.voice.realtime.voice, 'S_updated', 'failed save cannot change live settings');
  fs.rmdirSync(file); fs.renameSync(file + '.saved', file);
  const h2 = await bridgeHarness({ config: JSON.parse(disk) });
  try { assert.equal(h2.cfg.socialV2.voice.realtime.voice, 'S_updated'); } finally { await h2.close(); }
  console.log('PASS voice settings: credential filtering, admin-only access, validation, durable updates, caller preservation, write rollback, restart loading');
} finally { await new Promise(r => server.close(r)); await h.close(); }
