import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_IMAGE_MODEL, generateVolcengineImage, parseImageCommand } from '../src/volcengine-image.js';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-image-test-'));
const apiKeyPath = path.join(temp, 'key');
await fs.writeFile(apiKeyPath, 'fixture-image-credential', { mode: 0o600 });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=', 'base64');
const settings = { enabled: true, freeOnlyConfirmed: true, apiKeyPath, model: DEFAULT_IMAGE_MODEL };
const response = (data) => new Response(JSON.stringify(data));
let calls = 0;
try {
  assert.deepEqual(parseImageCommand('/生图 一只猫'), { prompt: '一只猫' });
  assert.deepEqual(parseImageCommand('/生图'), { prompt: '' });
  for (const text of ['图片能生成吗', '我想 /生图 一只猫', '/生图说明', '普通聊天']) assert.equal(parseImageCommand(text), null);
  const result = await generateVolcengineImage({ prompt: '一只猫', settings, fetchImpl: async (url, init) => {
    calls++;
    assert.equal(url, 'https://ark.cn-beijing.volces.com/api/v3/images/generations');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, 'Bearer fixture-image-credential');
    const body = JSON.parse(init.body);
    assert.equal(body.model, DEFAULT_IMAGE_MODEL);
    assert.equal(body.prompt, '一只猫');
    assert.equal(body.response_format, 'b64_json');
    assert.equal(body.watermark, true);
    assert.equal(body.image, undefined);
    return response({ data: [{ b64_json: png.toString('base64') }], usage: { generated_images: 1 } });
  } });
  assert.deepEqual(result.buffer, png);
  assert.equal(calls, 1, '生成请求只发送一次');
  for (const data of [{}, { data: [] }, { error: { message: 'fixture-image-credential' } }, { data: [{ error: { message: 'denied' } }] }, { data: [{ b64_json: 'not base64!' }] }, { data: [{ b64_json: Buffer.from('not an image').toString('base64') }] }]) {
    await assert.rejects(generateVolcengineImage({ prompt: '猫', settings, fetchImpl: async () => response(data) }), error => !error.message.includes('fixture-image-credential'));
  }
  for (const status of [401, 403, 429, 500]) await assert.rejects(generateVolcengineImage({ prompt: '猫', settings, fetchImpl: async () => new Response('fixture-image-credential', { status }) }), error => !error.message.includes('fixture-image-credential'));
  const noFetch = () => assert.fail('无效配置或敏感信息不得调用远端');
  for (const prompt of ['', 'fixture-image-credential', 'secret=abcdefg', 'token-fixture']) await assert.rejects(generateVolcengineImage({ prompt, settings, secrets: ['token-fixture'], fetchImpl: noFetch }));
  await assert.rejects(generateVolcengineImage({ prompt: '猫', settings: { ...settings, enabled: false }, fetchImpl: noFetch }));
  await assert.rejects(generateVolcengineImage({ prompt: '猫', settings, useReference: true, fetchImpl: noFetch }), /参考图/);
  const referenceImagePath = path.join(temp, 'reference.png');
  await fs.writeFile(referenceImagePath, png);
  await generateVolcengineImage({ prompt: '换一件蓝色外套', settings: { ...settings, referenceImagePath }, useReference: true, fetchImpl: async (_url, init) => {
    assert.equal(JSON.parse(init.body).image, `data:image/png;base64,${png.toString('base64')}`);
    return response({ data: [{ b64_json: png.toString('base64') }] });
  } });
  await generateVolcengineImage({ prompt: '穿浅色毛衣，挑眉笑', settings: { ...settings, referenceImagePath, fixedReference: true }, useReference: false, fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.image, `data:image/png;base64,${png.toString('base64')}`);
    assert.ok(body.prompt.includes('同一张脸'));
    assert.ok(body.prompt.includes('穿浅色毛衣，挑眉笑'));
    assert.ok(body.prompt.startsWith('本次画面要求：穿浅色毛衣，挑眉笑'));
    assert.ok(body.prompt.includes('本次指定表情优先于参考图表情'));
    assert.ok(body.prompt.includes('允许眉毛高低、眼睑开合、嘴角方向'));
    assert.ok(!body.prompt.includes('眼形、鼻形和嘴形'), '身份参考不能锁定表情肌肉形态');
    return response({ data: [{ b64_json: png.toString('base64') }] });
  } });
  let attempts = 0;
  await assert.rejects(generateVolcengineImage({ prompt: '猫', settings, fetchImpl: async () => { attempts++; throw new DOMException('timeout', 'TimeoutError'); } }), /超时/);
  assert.equal(attempts, 1, '超时不自动重试、避免重复扣费');
  console.log('PASS 生图协议、独立模型、命令分流、参考图、空响应、HTTP错误、超时及凭据保护');
} finally { await fs.rm(temp, { recursive: true, force: true }); }
