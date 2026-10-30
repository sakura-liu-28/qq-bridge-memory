import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { capabilityView, updateCapability } from '../src/capability-settings.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { describeImages } from '../src/vision-provider.js';
import { generateImage } from '../src/image-provider.js';
import { serviceEndpoint, updateServiceConnection } from '../src/service-connections.js';

test('capability selection retains secrets, queues, quotas and unrelated settings; exposes only public metadata', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-capability-'));
  const key = path.join(dir, 'secret.key'); fs.writeFileSync(key, 'fixture-secret-value');
  const config = { ownerQQ: 123, allow: { private: [123] }, snowluma: { accessToken: 'fixture-gateway-token' }, socialV2: { memory: { mode: 'long-term' }, voice: { tts: { enabled: true, provider: 'volcengine', voice: 'S_fixtureVoice', resourceId: 'seed-icl-2.0', apiKeyPath: key, freeFallback: { enabled: true, apiKeyPath: key } } }, vision: { enabled: true, provider: 'zhipu', model: 'glm-4v-flash', providers: { zhipu: { apiKeyPath: key }, siliconflow: { apiKeyPath: key } }, queue: [{ provider: 'zhipu', model: 'glm-4v-flash', capability: 'vision', enabled: true, freeEligible: true, requestBudget: { remaining: 7 } }] } } };
  try {
    const view = capabilityView(config); assert.equal(view.cards.length, 4); assert.equal(view.cards[0].selected, 'volcengine:S_fixtureVoice');
    assert.ok(view.cards[0].options.some(option => option.id === 'volcengine:S_fixtureVoice'));
    assert.doesNotMatch(JSON.stringify(view), /fixture-secret-value|fixture-gateway-token|secret\.key/);
    const snapshot = JSON.stringify(config);
    const next = updateCapability(config, { type: 'vision', selected: 'siliconflow:Qwen/Qwen3.5-4B', enabled: true });
    assert.equal(JSON.stringify(config), snapshot);
    assert.equal(next.socialV2.memory.mode, 'long-term');
    assert.equal(next.snowluma.accessToken, config.snowluma.accessToken);
    assert.deepEqual(next.socialV2.vision.queue[1].requestBudget, { remaining: 7 });
    assert.equal(next.socialV2.vision.providers.zhipu.apiKeyPath, key);
    assert.throws(() => updateCapability(config, { type: 'asr', selected: 'volcengine:asr-2.0', enabled: true, privateQQ: '456' }), /白名单/);
    const voice = updateCapability(config, { type: 'tts', selected: 'volcengine:S_fixtureVoice', enabled: true });
    assert.equal(voice.socialV2.voice.tts.voice, 'S_fixtureVoice');
    assert.deepEqual(voice.socialV2.voice.tts.freeFallback, config.socialV2.voice.tts.freeFallback);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('capability API rejects agents, persists selections, preserves blank keys and reference bytes', async () => {
  const h = await bridgeHarness(); h.setMode('reserved2');
  const server = h.startConsoleServer(); if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const call = async (url, body, agent = false) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${url}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token', ...(agent ? { 'x-agent-token': h.getSocialV2State('private:123').agentToken } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { response, json: async () => ({ status: response.status, ...await response.json() }) };
  };
  try {
    assert.equal((await (await call('/api/capabilities', undefined, true)).json()).status, 403);
    const input = { type: 'tts', selected: 'volcengine:zh_female_vv_uranus_bigtts', enabled: true, apiKey: 'fixture-secret-value' };
    const saved = await (await call('/api/capabilities', input)).json(); assert.equal(saved.persisted, true);
    assert.doesNotMatch(JSON.stringify(saved), /fixture-secret-value/);
    const file = path.join(h.temp, 'config.json'); const before = JSON.parse(fs.readFileSync(file)); const key = before.socialV2.voice.tts.apiKeyPath;
    assert.equal(fs.readFileSync(key, 'utf8'), input.apiKey);
    assert.equal((await (await call('/api/capabilities', { ...input, apiKey: '' })).json()).persisted, true);
    assert.equal(JSON.parse(fs.readFileSync(file)).socialV2.voice.tts.apiKeyPath, key);
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=';
    assert.equal((await (await call('/api/capabilities/reference', { data: png })).json()).persisted, true);
    const image = (await call('/api/capabilities/reference')).response;
    assert.equal(image.status, 200); assert.deepEqual(Buffer.from(await image.arrayBuffer()), Buffer.from(png, 'base64'));
    assert.equal((await (await call('/api/capabilities/reference', { data: 'bad' })).json()).status, 400);
    assert.equal(JSON.parse(fs.readFileSync(file)).dsh.authToken, 'fixture-only');
  } finally { await new Promise(resolve => server.close(resolve)); await h.close(); }
});

test('multiple services remain isolated, persist edits, enter candidates and route primary/fallback with their own URL and key', async () => {
  const h = await bridgeHarness(); h.setMode('reserved2');
  const server = h.startConsoleServer(); if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const call = async (path, body, method = body ? 'POST' : 'GET', agent = false) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method,
      headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token', ...(agent ? { 'x-agent-token': h.getSocialV2State('private:123').agentToken } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, ...await response.json() };
  };
  try {
    assert.equal((await call('/api/services', undefined, 'GET', true)).status, 403);
    for (const url of ['http://example.com/api', 'https://127.0.0.1/api', 'https://user:pass@example.com/api', 'https://example.com/api?key=secret']) assert.throws(() => serviceEndpoint(url, 'vision'));
    const input = { name: '识图一', template: 'vision:zhipu', model: 'glm-4v-flash', endpoint: 'https://vision-a.example/api', apiKey: 'fixture-service-key-a' };
    const a = await call('/api/services', input);
    assert.equal(a.persisted, true);
    const b = await call('/api/services', { ...input, name: '识图二', endpoint: 'https://vision-b.example/api', apiKey: 'fixture-service-key-b' });
    assert.equal(b.services.length, 2);
    assert.equal(b.cards.find(card => card.type === 'vision').options.filter(option => option.connectionId).length, 2);
    assert.doesNotMatch(JSON.stringify(b), /fixture-service-key|apiKeyPath|\.key"/);
    const selected = await call('/api/capabilities', { type: 'vision', selected: `service:${a.id}`, backups: [`service:${b.id}`], enabled: true, automatic: true });
    assert.equal(selected.persisted, true);
    const originalCandidate = selected.cards.find(card => card.type === 'vision').options.find(option => option.id === 'zhipu:glm-4v-flash');
    assert.equal(originalCandidate.configured, false, 'a connection key must not become an unrelated built-in credential');
    const requests = [];
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=';
    const result = await describeImages({ images: [{ data: png, mimeType: 'image/png' }], question: '看图片', settings: h.cfg.socialV2.vision,
      fetchImpl: async (url, init) => {
        requests.push({ url, key: init.headers.Authorization });
        return requests.length === 1 ? new Response(JSON.stringify({ error: { code: 'AllocationQuota.FreeTierOnly' } }), { status: 403 })
          : new Response(JSON.stringify({ choices: [{ message: { content: '一张图片' } }] }));
      } });
    assert.match(result.text, /图片/);
    assert.deepEqual(requests, [{ url: input.endpoint, key: 'Bearer fixture-service-key-a' }, { url: 'https://vision-b.example/api', key: 'Bearer fixture-service-key-b' }]);
    assert.equal((await call('/api/services', { id: a.id }, 'DELETE')).status, 400);
    const edited = await call('/api/services', { ...input, id: a.id, name: '识图一更新', endpoint: 'https://vision-updated.example/api', apiKey: '' });
    assert.equal(edited.persisted, true);
    assert.equal(h.cfg.socialV2.vision.connections[a.id].endpoint, 'https://vision-updated.example/api');
    assert.equal(fs.readFileSync(h.cfg.socialV2.vision.connections[a.id].apiKeyPath, 'utf8'), input.apiKey);
    const file = fs.readFileSync(path.join(h.temp, 'config.json'), 'utf8');
    assert.doesNotMatch(file, /fixture-service-key-a|fixture-service-key-b/);
    assert.equal((await call('/api/capabilities', { type: 'vision', selected: `service:${b.id}`, backups: [], enabled: true })).persisted, true);
    assert.equal((await call('/api/services', { id: a.id }, 'DELETE')).persisted, true);
    assert.equal((await call('/api/services')).services.length, 1);
  } finally { await new Promise(resolve => server.close(resolve)); await h.close(); }
});

test('switching stored voice/ASR connections restores the original credentials and keeps duration/voice quota protection', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-voice-services-'));
  const originalKey = path.join(directory, 'original.key'), secondKey = path.join(directory, 'second.key');
  fs.writeFileSync(originalKey, 'fixture-original-key'); fs.writeFileSync(secondKey, 'fixture-second-key');
  let config = { allow: { private: [123] }, socialV2: { voice: {
    tts: { provider: 'volcengine', enabled: true, voice: 'S_originalVoice', resourceId: 'seed-icl-2.0', apiKeyPath: originalKey, fallbackVoices: [{ voice: 'zh_female_vv_uranus_bigtts', resourceId: 'seed-tts-2.0' }] },
    asr: { enabled: true, privateQQ: '123', apiKeyPath: originalKey, maxTotalSeconds: 1234, quotaFile: '/fixture/asr-quota.json' }
  } } };
  try {
    config = updateServiceConnection(config, { template: 'tts:volcengine', name: '另一个语音服务', model: 'S_secondVoice', endpoint: 'https://voice.example/speech' }, { id: 'tts-two', keyFile: secondKey });
    config = updateCapability(config, { type: 'tts', selected: 'service:tts-two', enabled: true });
    assert.equal(config.socialV2.voice.tts.apiKeyPath, secondKey);
    assert.equal(config.socialV2.voice.tts.endpoint, 'https://voice.example/speech');
    config = updateCapability(config, { type: 'tts', selected: 'volcengine:S_originalVoice', enabled: false });
    assert.equal(config.socialV2.voice.tts.apiKeyPath, originalKey);
    assert.equal(config.socialV2.voice.tts.enabled, false);
    assert.equal(config.socialV2.voice.tts.fallbackVoices.length, 1);
    assert.equal(config.socialV2.voice.tts.endpoint, undefined);
    config = updateServiceConnection(config, { template: 'asr:volcengine', name: '另一个听语音服务', model: 'asr-2.0', endpoint: 'wss://asr.example/listen' }, { id: 'asr-two', keyFile: secondKey });
    config = updateCapability(config, { type: 'asr', selected: 'service:asr-two', enabled: true, privateQQ: '123' });
    assert.equal(config.socialV2.voice.asr.endpoint, 'wss://asr.example/listen');
    assert.equal(config.socialV2.voice.asr.maxTotalSeconds, 1234);
    config = updateCapability(config, { type: 'asr', selected: 'volcengine:asr-2.0', enabled: true, privateQQ: '123' });
    assert.equal(config.socialV2.voice.asr.apiKeyPath, originalKey);
    assert.equal(config.socialV2.voice.asr.endpoint, undefined);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('save-and-use applies the selected service in one durable write; a failed activation leaves the old config intact', async () => {
  const h = await bridgeHarness(); h.setMode('reserved2');
  const server = h.startConsoleServer(); if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const call = async body => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/services`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token' }, body: JSON.stringify(body) });
    return { status: response.status, ...await response.json() };
  };
  try {
    const input = { template: 'vision:zhipu', name: '快捷识图', endpoint: 'https://vision.example/api', model: 'glm-4v-flash', apiKey: 'fixture-quick-service-key', activate: true };
    const result = await call(input);
    assert.equal(result.activated, true);
    assert.equal(result.cards.find(card => card.type === 'vision').selected, 'service:' + result.id);
    assert.equal(h.cfg.socialV2.vision.enabled, true);
    assert.equal(h.cfg.socialV2.tools.describeImage, true);
    const file = path.join(h.temp, 'config.json');
    const before = fs.readFileSync(file, 'utf8');
    const keys = fs.readdirSync(path.join(h.temp, 'state/secrets'));
    const failed = await call({ ...input, template: 'asr:volcengine', model: 'asr-2.0', endpoint: 'wss://asr.example/api', privateQQ: '999999' });
    assert.equal(failed.status, 400);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.deepEqual(fs.readdirSync(path.join(h.temp, 'state/secrets')), keys);
  } finally { await new Promise(resolve => server.close(resolve)); await h.close(); }
});

test('custom API needs no provider or name, accepts model IDs, and editable formats update the active request without replacing its key', async () => {
  const h = await bridgeHarness(); h.setMode('reserved2');
  const server = h.startConsoleServer(); if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const call = async body => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/services`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token' }, body: JSON.stringify(body) });
    return { status: response.status, ...await response.json() };
  };
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=';
  try {
    const input = { type: 'vision', endpoint: 'https://custom-api.example/v1', model: 'vendor/custom_model:vision', apiKey: 'fixture-custom-key', activate: true };
    const saved = await call(input); assert.equal(saved.status, 200);
    const service = saved.services.find(item => item.id === saved.id);
    assert.equal(service.name, 'custom-api.example'); assert.equal(service.protocol, 'auto'); assert.equal(service.provider, 'openai');
    assert.equal(service.endpoint, input.endpoint + '/chat/completions');
    const key = h.cfg.socialV2.vision.connections[saved.id].apiKeyPath;
    const run = async (expectedUrl, expectedModel) => describeImages({ images: [{ data: png, mimeType: 'image/png' }], question: '看图片', settings: h.cfg.socialV2.vision,
      fetchImpl: async (url, init) => { assert.equal(url, expectedUrl); assert.equal(init.headers.Authorization, 'Bearer fixture-custom-key'); assert.equal(JSON.parse(init.body).model, expectedModel); return new Response(JSON.stringify({ choices: [{ message: { content: '接口实际返回的识图结果' } }] })); } });
    await run(service.endpoint, input.model);
    const edited = await call({ ...input, id: saved.id, name: '自己起的名字', protocol: 'vision:zhipu', endpoint: 'https://another.example/v1', model: 'glm-4v-flash', apiKey: '', activate: false });
    assert.equal(edited.status, 200); assert.equal(h.cfg.socialV2.vision.connections[saved.id].apiKeyPath, key);
    assert.equal(h.cfg.socialV2.vision.queue[0].provider, 'zhipu');
    await run('https://another.example/v1/chat/completions', 'glm-4v-flash');
    const before = fs.readFileSync(path.join(h.temp, 'config.json'), 'utf8');
    assert.equal((await call({ ...input, id: saved.id, type: 'image' })).status, 400);
    assert.equal(fs.readFileSync(path.join(h.temp, 'config.json'), 'utf8'), before);
    assert.doesNotMatch(JSON.stringify(edited), /fixture-custom-key|apiKeyPath/);
    const known = updateServiceConnection({}, { type: 'vision', endpoint: 'https://open.bigmodel.cn', model: 'glm-4v-flash' }, { id: 'known', keyFile: key });
    assert.equal(known.socialV2.serviceConnections[0].endpoint, 'https://open.bigmodel.cn/api/paas/v4/chat/completions');
  } finally { await new Promise(resolve => server.close(resolve)); await h.close(); }
});

test('custom image format uses its own model, URL and key and handles both image URLs and base64; invalid output is rejected', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-custom-image-'));
  const key = path.join(directory, 'image.key'); fs.writeFileSync(key, 'fixture-image-custom-key');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=', 'base64');
  try {
    let config = updateServiceConnection({}, { type: 'image', endpoint: 'https://custom-image.example/v1', model: 'custom/image_model:v2' }, { id: 'custom-image', keyFile: key });
    config = updateCapability(config, { type: 'image', selected: 'service:custom-image', enabled: true });
    const options = { prompt: '一棵树', settings: config.socialV2.imageGeneration };
    for (const data of [{ data: [{ b64_json: png.toString('base64') }] }, { data: [{ url: 'https://cdn.example/image.png' }] }]) {
      const result = await generateImage({ ...options, fetchImpl: async (url, init) => {
        assert.equal(url, 'https://custom-image.example/v1/images/generations'); assert.equal(init.headers.Authorization, 'Bearer fixture-image-custom-key');
        assert.equal(JSON.parse(init.body).model, 'custom/image_model:v2'); return new Response(JSON.stringify(data));
      }, downloadImpl: async url => { assert.equal(url, 'https://cdn.example/image.png'); return { buffer: png }; } });
      assert.deepEqual(result.buffer, png);
    }
    await assert.rejects(generateImage({ ...options, fetchImpl: async () => new Response(JSON.stringify({ data: [{ b64_json: 'invalid!' }] })) }), /无效图片/);
    await assert.rejects(generateImage({ ...options, fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'no access' } }), { status: 401 }) }), /HTTP 401/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
