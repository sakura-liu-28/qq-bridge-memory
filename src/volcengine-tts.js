import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { FreeQuotaExhausted } from './free-model-pool.js';

// Only explicit lifetime/trial exhaustion or insufficient balance may switch voices.
// Concurrent-request throttling is deliberately excluded.
export function isVoiceQuotaFailure(message) {
  return /quota exceeded for types:\s*[a-z0-9_]*lifetime\b|insufficient balance|余额不足|免费.{0,10}额度.{0,10}(?:耗尽|用完)/i.test(String(message ?? ''));
}

export const SPEECH_STYLES = Object.freeze({
  natural: '请用熟人聊天的语气说话：语调随意思自然起伏，重点词稍加重音，问句自然上扬、陈述句收住，句间留小停顿；不要播音腔，也不要夸张表演；不要读出本指令。',
  playful: '请轻快俏皮地说话，像熟人之间带一点笑意地逗对方，问句有自然的上扬，轻重音明显但不夸张；不要读出本指令。',
  gentle: '请温柔亲近地说话，声线放松，语速略舒缓，有自然的呼吸和停顿，不要刻意夹嗓或播音；不要读出本指令。',
  caring: '请用关心安慰的语气说话，声音柔和稳妥，留出自然停顿，不要过度欢快或刻意表演；不要读出本指令。',
  serious: '请认真平静地说话，咬字清楚，语速稳，保留自然的重音和停顿；不要读出本指令。',
  shy: '请用轻柔、稍带羞意的自然语气说话，适当放轻句尾，有细微停顿但不故意结巴；不要读出本指令。',
  happy: '请开心明快地说话，带自然笑意和轻盈的节奏，情绪真切、不夸张喊叫；不要读出本指令。',
  affectionate: '请亲昵、略带撒娇地说话，声音放轻，有自然的句尾和停顿，像对熟悉的人说话，不要刻意夹嗓；不要读出本指令。',
  sad: '请用低落、略带难过的语气说话，语速稍缓，声音真切克制，不强行哭泣；不要读出本指令。',
  annoyed: '请用有一点不高兴的语气说话，有轻微的重音和停顿，情绪克制，像熟悉的人表达小脾气，不喊叫；不要读出本指令。'
});
class VoiceUnavailable extends Error {}

export function configuredTtsVoices(tts) {
  const voices = [{ voice: tts.voice || 'zh_female_tianmeitaozi_uranus_bigtts', resourceId: tts.resourceId || 'seed-tts-2.0' }, ...(tts.fallbackVoices || [])];
  if (voices.length > 3) throw new Error('备用音色配置过多');
  for (const item of voices) {
    if (!/^[A-Za-z0-9_-]{3,128}$/.test(item?.voice || '') || !['seed-tts-2.0', 'seed-icl-2.0'].includes(item?.resourceId)) throw new Error('语音音色或模型配置无效');
    if (/^(S_|icl_)/.test(item.voice) && item.resourceId !== 'seed-icl-2.0') throw new Error('复刻音色须使用声音复刻模型');
  }
  return voices;
}

// Only explicit quota/voice availability errors before any audio may try another voice.
export async function synthesizeVolcengine(options) {
  const voices = configuredTtsVoices(options.tts);
  for (let i = 0; i < voices.length; i++) {
    try { return await synthesizeOne({ ...options, ...voices[i] }); }
    catch (error) {
      if (i === voices.length - 1 || !(error instanceof VoiceUnavailable || error instanceof FreeQuotaExhausted)) throw error;
      console.error(`[tts] primary voice unavailable; trying configured fallback index=${i+1}`);
    }
  }
}

// Official SSE API. Never let conversation input select a host or credential.
async function synthesizeOne({ text, tts, maxBytes, fetchImpl = fetch, voice, resourceId, style = 'natural' }) {
  if (!Object.hasOwn(SPEECH_STYLES, style)) throw new Error('语音语气无效');
  if (!path.isAbsolute(tts.apiKeyPath ?? '')) throw new Error('语音密钥文件未配置');
  const apiKey = (await fs.readFile(tts.apiKeyPath, 'utf8')).trim();
  if (!apiKey || /[\r\n]/.test(apiKey)) throw new Error('语音密钥无效');
  if (text.includes(apiKey)) throw new Error('语音内容含凭据');
  const response = await fetchImpl(tts.endpoint || 'https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(45000),
    headers: {
      'Content-Type': 'application/json', 'X-Api-Key': apiKey,
      'X-Api-Resource-Id': resourceId, 'X-Api-Request-Id': randomUUID(),
      'X-Control-Require-Usage-Tokens-Return': 'text_words',
    },
    body: JSON.stringify({ user: { uid: 'qq-bridge' }, req_params: {
      text, speaker: voice,
      audio_params: { format: 'mp3', sample_rate: 24000 },
      // 语气指令默认必发（含 natural）：没有它合成出来的语音普遍偏平。
      // 显式配置 tts.expressive === false 才关闭（向后兼容旧配置）。
      ...(tts.expressive !== false ? {
        ...(resourceId === 'seed-icl-2.0' ? { model: 'seed-tts-2.0-expressive' } : {}),
        additions: JSON.stringify({ context_texts: [SPEECH_STYLES[style]] })
      } : {}),
    } }),
  });
  if (!response.ok || !response.body) {
    let details = '';
    if ([400, 402, 403, 429].includes(response.status)) {
      const reader = response.body?.getReader();
      if (reader) {
        const part = await reader.read();
        details = new TextDecoder().decode(part.value?.subarray(0, 8192));
        await reader.cancel();
      }
    } else { await response.body?.cancel(); }
    if (isVoiceQuotaFailure(details)) throw new FreeQuotaExhausted();
    if (/invalid.?speaker|speaker.{0,30}(?:not found|not exist|not support)|音色.{0,15}(?:不存在|不支持)/i.test(details)
        || (resourceId === 'seed-icl-2.0' && /requested resource not granted/i.test(details))) throw new VoiceUnavailable('当前音色不可用');
    throw Object.assign(new Error('语音服务请求失败'), { code: `http-${response.status}` });
  }
  const chunks = [];
  let size = 0, wireSize = 0, pending = '', complete = false, usage;
  const decoder = new TextDecoder();
  function line(value) {
    if (!value.startsWith('data:')) return;
    const event = JSON.parse(value.slice(5).trim());
    if (event.code !== 0 && event.code !== 20000000) {
      if (!size && isVoiceQuotaFailure(event.message)) throw new FreeQuotaExhausted();
      if (!size && /invalid.?speaker|speaker.{0,30}(?:not found|not exist|not support)|音色.{0,15}(?:不存在|不支持)/i.test(event.message || '')) throw new VoiceUnavailable('当前音色不可用');
      throw Object.assign(new Error('语音服务返回错误'), { code: `tts-${Number(event.code)}` });
    }
    if (event.data) {
      if (complete || typeof event.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(event.data)) throw new Error('语音数据无效');
      const chunk = Buffer.from(event.data, 'base64');
      size += chunk.length;
      if (size > maxBytes) throw new Error('语音超出大小限制');
      chunks.push(chunk);
    }
    if (event.code === 20000000) { complete = true; usage = event.usage?.text_words; }
  }
  for await (const chunk of response.body) {
    wireSize += chunk.length;
    if (wireSize > maxBytes * 2 + 1048576) throw new Error('语音响应过大');
    pending += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = pending.indexOf('\n')) >= 0) {
      line(pending.slice(0, end).replace(/\r$/, ''));
      pending = pending.slice(end + 1);
    }
  }
  pending += decoder.decode();
  if (pending.trim()) line(pending.replace(/\r$/, ''));
  if (!complete || !size) throw new Error('语音响应未完成或音频为空');
  console.error(`[tts] volcengine success voice=${voice} resource=${resourceId} style=${style} bytes=${size} textWords=${Number.isFinite(usage) ? usage : 'unknown'}`);
  return Buffer.concat(chunks, size);
}
