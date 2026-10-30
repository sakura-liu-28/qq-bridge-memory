import fs from 'node:fs/promises';
import path from 'node:path';
import { safeFetchWav } from './safe-fetch.js';
import { getFreeModelPool, FreeQuotaExhausted, isFreeQuotaFailure } from './free-model-pool.js';

export async function synthesizeFreeSpeech({ text, settings, maxBytes, fetchImpl = fetch, downloadImpl = safeFetchWav }) {
  if (settings?.enabled !== true || settings.freeOnlyConfirmed !== true) throw new Error('免费备用语音尚未开启用完即停保护');
  return getFreeModelPool('free-voice', settings.quotaStatePath).run('tts', settings.queue, async entry => {
    if (entry.provider !== 'bailian' || entry.model !== 'qwen3-tts-flash') throw new Error('备用语音模型尚未核实');
    if (!path.isAbsolute(settings.apiKeyPath ?? '')) throw new Error('备用语音密钥文件未配置');
    const key = (await fs.readFile(settings.apiKeyPath, 'utf8')).trim();
    if (!key || /\s/.test(key) || text.includes(key)) throw new Error('备用语音密钥或内容无效');
    console.error(`[tts] free request provider=bailian model=${entry.model} chars=${text.length}`);
    const response = await fetchImpl('https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60000),
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: entry.model, input: { text, voice: 'Cherry', language_type: 'Chinese' } })
    });
    let size = 0; const chunks = [];
    for await (const chunk of response.body ?? []) {
      size += chunk.length;
      if (size > 1024 * 1024) throw new Error('备用语音响应过大');
      chunks.push(Buffer.from(chunk));
    }
    let data;
    try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('备用语音返回无效数据'); }
    if (!response.ok) {
      if (isFreeQuotaFailure(response.status, data)) throw new FreeQuotaExhausted();
      throw new Error(`备用语音请求失败（HTTP ${response.status}）`);
    }
    const url = data?.output?.audio?.url;
    // Official TTS returns signed OSS URLs. Upgrade HTTP to TLS before download.
    if (typeof url !== 'string') throw new Error('备用语音没有返回音频');
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || !/\.oss-cn-beijing\.aliyuncs\.com$/.test(parsed.hostname)) throw new Error('备用语音下载地址无效');
    parsed.protocol = 'https:';
    const result = await downloadImpl(parsed.toString(), maxBytes);
    const audio = result?.buffer;
    if (!audio || audio.length < 44 || audio.length > maxBytes || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') throw new Error('备用语音音频格式无效');
    console.error(`[tts] free ready model=${entry.model} bytes=${audio.length}`);
    return audio;
  });
}
