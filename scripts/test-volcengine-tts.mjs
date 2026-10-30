import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { synthesizeVolcengine } from '../src/volcengine-tts.js';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tts-test-'));
const apiKeyPath = path.join(dir, 'key');
await fs.writeFile(apiKeyPath, 'test-credential', { mode: 0o600 });
const audio = Buffer.from('fake-mp3');
const event = (code, data = null) => `data: ${JSON.stringify({ code, data })}\r\n\r\n`;
const success = event(0, audio.toString('base64')) + event(20000000);
function response(text) {
  const bytes = Buffer.from(text);
  return new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.subarray(i, i + 3));
    controller.close();
  } }));
}
const base = { text: '你好', tts: { apiKeyPath }, maxBytes: 1024 };
try {
  const output = await synthesizeVolcengine({ ...base, fetchImpl: async (url, options) => {
    assert.equal(url, 'https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['X-Api-Key'], 'test-credential');
    assert.equal(options.headers['X-Api-Resource-Id'], 'seed-tts-2.0');
    assert.equal(JSON.parse(options.body).req_params.speaker, 'zh_female_tianmeitaozi_uranus_bigtts');
    return response(success);
  } });
  assert.deepEqual(output, audio);
  await synthesizeVolcengine({ ...base, style: 'playful', tts: { apiKeyPath, voice: 'S_fixture', resourceId: 'seed-icl-2.0', expressive: true }, fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(options.headers['X-Api-Resource-Id'], 'seed-icl-2.0');
    assert.equal(body.req_params.speaker, 'S_fixture');
    assert.equal(body.req_params.model, 'seed-tts-2.0-expressive');
    assert.ok(JSON.parse(body.req_params.additions).context_texts[0].includes('轻快俏皮'));
    assert.equal(body.req_params.text, '你好');
    return response(success);
  } });
  let voiceRequests = 0;
  await synthesizeVolcengine({ ...base, tts: { apiKeyPath, voice: 'S_fixture', resourceId: 'seed-icl-2.0', fallbackVoices: [{ voice: 'zh_female_tianmeitaozi_uranus_bigtts', resourceId: 'seed-tts-2.0' }] }, fetchImpl: async (_url, options) => {
    voiceRequests++;
    if (voiceRequests === 1) return response(`data: ${JSON.stringify({ code: 45000030, message: 'InvalidSpeaker' })}\n`);
    assert.equal(JSON.parse(options.body).req_params.speaker, 'zh_female_tianmeitaozi_uranus_bigtts');
    return response(success);
  } });
  assert.equal(voiceRequests, 2);
  for (const stream of [event(45000000), event(20000000), event(0, audio.toString('base64')), event(0, 'not-base64!')]) {
    await assert.rejects(synthesizeVolcengine({ ...base, fetchImpl: async () => response(stream) }));
  }
  await assert.rejects(synthesizeVolcengine({ ...base, maxBytes: 1, fetchImpl: async () => response(success) }));
  await assert.rejects(synthesizeVolcengine({ ...base, fetchImpl: async () => new Response('', { status: 403 }) }));
  await assert.rejects(synthesizeVolcengine({ ...base, text: 'test-credential', fetchImpl: () => assert.fail('Must reject before transmission') }));
  console.log('PASS: split SSE stream, auth/speaker, API error, empty/incomplete audio, invalid base64, size limit, HTTP error, credential guard');
} finally { await fs.rm(dir, { recursive: true, force: true }); }
