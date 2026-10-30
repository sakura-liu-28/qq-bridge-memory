import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { gzipSync, gunzipSync } from 'node:zlib';
import WebSocket from 'ws';
import { isSilk, decode, getDuration } from 'silk-wasm';

export const ASR_URL = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream';
const MAX_BYTES = 20 * 1024 * 1024;
export function recordRefs(segments) {
  return (Array.isArray(segments) ? segments : []).filter(s => s?.type === 'record').map(s => String(s.data?.file_id || s.data?.file || '')).filter(s => /^[A-Za-z0-9_.=-]{1,4096}$/.test(s) && !s.includes('..')).slice(0, 2);
}
export function encodeAsrPacket(type, value, last = false) {
  const payload = gzipSync(type === 1 ? Buffer.from(JSON.stringify(value)) : value);
  const size = Buffer.alloc(4); size.writeUInt32BE(payload.length);
  return Buffer.concat([Buffer.from([0x11, (type << 4) | (last ? 2 : 0), type === 1 ? 0x11 : 0x01, 0]), size, payload]);
}
export function decodeAsrPacket(bytes) {
  const data = Buffer.from(bytes);
  if (data.length < 8 || data.length > 1024*1024) throw new Error('语音识别服务数据无效');
  const headerSize = (data[0] & 15) * 4, kind = data[1] >> 4, flags = data[1] & 15;
  let offset = headerSize;
  if (headerSize < 4 || data.length < offset + 4) throw new Error('语音识别服务数据无效');
  if (flags & 1) offset += 4;
  let errorCode;
  if (kind === 15) { errorCode = data.readUInt32BE(offset); offset += 4; }
  if (data.length < offset + 4) throw new Error('语音识别服务数据无效');
  const length = data.readUInt32BE(offset); offset += 4;
  if (length !== data.length - offset) throw new Error('语音识别服务数据无效');
  let body = data.subarray(offset);
  if ((data[2] & 15) === 1) body = gunzipSync(body, { maxOutputLength: 1024 * 1024 });
  if (errorCode) throw new Error(`语音识别服务拒绝请求（${errorCode}）`);
  const value = JSON.parse(body.toString());
  return { value, last: !!(flags & 2) };
}
export async function decodeVoice(bytes, { maxSeconds = 120, ffmpegPath = 'ffmpeg' } = {}) {
  const buffer = Buffer.from(bytes);
  if (!buffer.length || buffer.length > MAX_BYTES) throw new Error('语音文件为空或过大');
  if (isSilk(buffer)) {
    if (getDuration(buffer) > maxSeconds * 1000) throw new Error('这条语音太长，暂时无法识别');
    const result = await decode(buffer, 16000);
    const pcm = Buffer.from(result.data);
    if (!pcm.length || pcm.length > maxSeconds * 32000) throw new Error('语音解码结果无效');
    return pcm;
  }
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-f', 's16le', '-acodec', 'pcm_s16le', '-ac', '1', '-ar', '16000', 'pipe:1'], { stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks = []; let size = 0, settled = false;
    const finish = error => { if (settled) return; settled = true; clearTimeout(timer); if (error) { child.kill('SIGKILL'); reject(error); } else if (!size) reject(new Error('语音解码结果为空')); else resolve(Buffer.concat(chunks)); };
    const timer = setTimeout(() => finish(new Error('语音解码超时')), 30000);
    child.on('error', () => finish(new Error('无法启动语音解码器')));
    child.stdout.on('data', chunk => { size += chunk.length; if (size > maxSeconds * 32000) return finish(new Error('这条语音太长，暂时无法识别')); chunks.push(chunk); });
    child.on('close', code => finish(code === 0 ? null : new Error('语音格式暂不支持')));
    child.stdin.on('error', () => {}); child.stdin.end(buffer);
  });
}

// Source IDs come only from a received QQ record segment. Never read a model-supplied path.
export async function downloadQQVoice(fileId, { gateway, fetchImpl = fetch, readRoots = [] }) {
  if (recordRefs([{ type: 'record', data: { file: fileId } }])[0] !== fileId) throw new Error('QQ 语音标识无效');
  const response = await fetchImpl(String(gateway.httpUrl).replace(/\/+$/, '') + '/get_record', {
    method: 'POST', headers: { 'content-type': 'application/json', ...(gateway.accessToken ? { authorization: `Bearer ${gateway.accessToken}` } : {}) },
    body: JSON.stringify({ file_id: fileId, out_format: '' }), signal: AbortSignal.timeout(20000)
  });
  const body = await response.json();
  if (!response.ok || body?.status !== 'ok' || body?.retcode !== 0) throw new Error('无法读取这条 QQ 语音，请稍后重试');
  const result = body.data || {};
  if (typeof result.base64 === 'string' && result.base64.length <= Math.ceil(MAX_BYTES * 4 / 3) + 4 && /^[A-Za-z0-9+/]*={0,2}$/.test(result.base64)) {
    const bytes = Buffer.from(result.base64, 'base64'); if (bytes.length) return bytes;
  }
  // An operator may map NapCat's cache into the bridge read-only. Resolve both paths
  // to prevent symlink escapes; no broad filesystem fallback or permission changes.
  for (const mapping of readRoots) {
    if (!path.isAbsolute(mapping.remote || '') || !path.isAbsolute(mapping.local || '') || !path.isAbsolute(result.file || '')) continue;
    const relative = path.relative(mapping.remote, result.file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
    const root = fs.realpathSync(mapping.local), file = fs.realpathSync(path.join(root, relative));
    if (!file.startsWith(root + path.sep)) continue;
    const stat = fs.statSync(file); if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_BYTES) throw new Error('QQ 语音文件大小无效');
    return fs.readFileSync(file);
  }
  throw new Error('QQ 网关没有提供可读取的语音数据，请检查语音缓存映射');
}
function reserveAsr(settings, seconds) {
  if (!settings.quotaFile || !Number.isFinite(settings.maxTotalSeconds) || settings.maxTotalSeconds <= 0) throw new Error('语音识别额度保护尚未配置');
  let used = 0;
  try { const state = JSON.parse(fs.readFileSync(settings.quotaFile, 'utf8')); used = state.usedSeconds; if (!Number.isFinite(used) || used < 0) throw new Error(); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('语音识别额度记录无法读取，已暂停识别'); }
  if (used + seconds > settings.maxTotalSeconds) throw new Error('语音识别保护额度已用完');
  fs.mkdirSync(path.dirname(settings.quotaFile), { recursive: true, mode: 0o700 });
  const temp = settings.quotaFile + '.' + crypto.randomUUID();
  fs.writeFileSync(temp, JSON.stringify({ usedSeconds: used + seconds, updatedAt: new Date().toISOString() }), { mode: 0o600 }); fs.renameSync(temp, settings.quotaFile);
}
export async function transcribeQQVoice({ fileId, gateway, settings, apiKeyPath, log = console.error, fetchImpl = fetch,
  createSocket = (url, options) => new WebSocket(url, options) }) {
  const maxSeconds = Math.min(300, Math.max(1, Number(settings.maxSeconds) || 120));
  const source = await downloadQQVoice(fileId, { gateway, fetchImpl, readRoots: settings.readRoots || [] });
  const pcm = await decodeVoice(source, { maxSeconds, ffmpegPath: settings.ffmpegPath || 'ffmpeg' });
  const seconds = pcm.length / 32000;
  const apiKey = fs.readFileSync(apiKeyPath, 'utf8').trim();
  if (!apiKey || /\s/.test(apiKey)) throw new Error('语音识别密钥配置无效');
  reserveAsr(settings, Math.ceil(seconds));
  log(`[asr] request seconds=${Math.ceil(seconds)} bytes=${source.length}`);
  return new Promise((resolve, reject) => {
    const socket = createSocket(settings.endpoint || ASR_URL, { headers: { 'X-Api-Key': apiKey, 'X-Api-Resource-Id': 'volc.seedasr.sauc.duration', 'X-Api-Request-Id': crypto.randomUUID() }, maxPayload: 1024*1024, handshakeTimeout: 12000, followRedirects: false });
    let settled = false, timer, sending, result = '';
    const finish = error => { if (settled) return; settled = true; clearTimeout(timer); clearInterval(sending); socket.terminate(); if (error) { log('[asr] failed'); reject(error); } else { log(`[asr] completed chars=${result.length}`); resolve({ text: result, seconds }); } };
    timer = setTimeout(() => finish(new Error('语音识别超时，请稍后重试')), (seconds + 30) * 1000);
    socket.on('open', () => {
      socket.send(encodeAsrPacket(1, { user: { uid: 'qq-bridge' }, audio: { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1 }, request: { model_name: 'bigmodel', enable_itn: true, enable_punc: true, enable_ddc: false } }));
      let offset = 0;
      sending = setInterval(() => {
        if (socket.readyState !== 1) return;
        if (socket.bufferedAmount > 262144) return finish(new Error('语音识别网络积压，请稍后重试'));
        const chunk = pcm.subarray(offset, offset + 6400); offset += chunk.length;
        socket.send(encodeAsrPacket(2, chunk, offset >= pcm.length));
        if (offset >= pcm.length) clearInterval(sending);
      }, 200);
    });
    socket.on('message', bytes => {
      try {
        const { value, last } = decodeAsrPacket(bytes);
        if (value.code != null && ![0, 1000, 20000000].includes(value.code)) return finish(new Error('语音识别服务拒绝请求，请检查额度和权限'));
        const text = value.result?.text ?? value.payload_msg?.result?.text;
        if (typeof text === 'string') result = text.trim().slice(0, 12000);
        if (last) finish(result ? null : new Error('没能听清这条语音，请重新说一次'));
      } catch (error) { finish(error?.message?.startsWith('语音识别服务') ? error : new Error('语音识别服务数据无效')); }
    });
    socket.on('unexpected-response', (_req, response) => { response.resume(); finish(new Error('语音识别鉴权未通过，请检查服务开通状态')); });
    socket.on('error', () => finish(new Error('语音识别连接失败，请稍后重试')));
    socket.on('close', () => { if (!settled) finish(new Error('语音识别连接中断，请稍后重试')); });
  });
}
