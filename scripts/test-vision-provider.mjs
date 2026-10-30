import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describeImages, parseVisionCommand } from '../src/vision-provider.js';
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vision-fixture-'));
const apiKeyPath = path.join(dir, 'key');
await fs.writeFile(apiKeyPath, 'fixture-vision-key');
const settings = { enabled: true, provider: 'zhipu', apiKeyPath, model: 'glm-4.6v-flash' };
const images = [{ mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=', url: 'http://private.invalid', file: '/private/path' }];
const response = text => new Response(JSON.stringify({ choices: [{ message: { content: text } }] }));
const noFetch = () => assert.fail('非法请求不得调用服务');
try {
  assert.equal(parseVisionCommand('图片能识别吗'), null);
  assert.ok(parseVisionCommand('/识图').question);
  const result = await describeImages({ images, question: '这是什么', settings, fetchImpl: async (url, init) => {
    assert.equal(url, 'https://open.bigmodel.cn/api/paas/v4/chat/completions');
    assert.equal(init.headers.Authorization, 'Bearer fixture-vision-key');
    const body = JSON.parse(init.body);
    assert.equal(body.model, settings.model);
    assert.ok(body.messages[0].content[1].image_url.url.startsWith('data:image/png;base64,'));
    assert.ok(!init.body.includes('/private/path') && !init.body.includes('private.invalid'));
    return response('一只猫');
  } });
  assert.equal(result.text, '一只猫');
  const silicon = await describeImages({ images, settings: { ...settings, provider: 'siliconflow', model: 'Qwen/Qwen3.5-4B' }, fetchImpl: async (url, init) => {
    assert.equal(url, 'https://api.siliconflow.cn/v1/chat/completions');
    assert.equal(JSON.parse(init.body).model, 'Qwen/Qwen3.5-4B');
    return response('一只猫');
  } });
  assert.equal(silicon.text, '一只猫', '带组织前缀的合法模型名称可调用');
  for (const change of [{ images: [] }, { images: [{ mimeType: 'image/png', data: 'bad!' }] }, { settings: { ...settings, model: 'paid-model' } }, { settings: { ...settings, enabled: false } }, { question: 'fixture-vision-key' }, { question: 'secret=abcdefgh' }]) {
    await assert.rejects(describeImages({ images, question: '猫', settings, fetchImpl: noFetch, ...change }));
  }
  for (const answer of ['', 'fixture-vision-key', 'password=abcdefgh']) await assert.rejects(describeImages({ images, settings, fetchImpl: async () => response(answer) }));
  let calls = 0;
  await assert.rejects(describeImages({ images, settings, fetchImpl: async () => { calls++; throw new Error('private-secret'); } }), e => !e.message.includes('private-secret'));
  assert.equal(calls, 1);
  await assert.rejects(describeImages({ images, settings, fetchImpl: async () => { throw new DOMException('fixture', 'TimeoutError'); } }), /超时/);
  const queued = { ...settings, providers: { volcengine: { apiKeyPath, freeOnlyConfirmed: true }, zhipu: { apiKeyPath } }, queue: [
    { provider: 'volcengine', model: 'doubao-seed-2-1-lite-260915', capability: 'vision', enabled: true, freeEligible: true },
    { provider: 'zhipu', model: settings.model, capability: 'vision', enabled: true, freeEligible: true }
  ] };
  const seen = [];
  assert.equal((await describeImages({ images, settings: queued, fetchImpl: async (url, init) => {
    seen.push(JSON.parse(init.body).model);
    return seen.length === 1 ? new Response(JSON.stringify({ error: { code: 'QuotaExceeded', message: 'Your account has exhausted its free trial quota' } }), { status: 429 }) : response('识别成功');
  } })).text, '识别成功');
  assert.deepEqual(seen, ['doubao-seed-2-1-lite-260915', 'glm-4.6v-flash']);
  console.log('PASS 独立识图协议、凭据/URL隔离、免费型号校验、额度切换、空响应及异常处理');
} finally { await fs.rm(dir, { recursive: true, force: true }); }
