import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { realtimeSettings, realtimePersona, connectRealtime } from './realtime-voice.js';
import { openCallMemory, readCallMemories, formatCallMemories, qqContextForCall } from './call-memory.js';
import { getNativeConfigViaSocket } from './native-call-policy.js';
import { configuredCallers } from './voice-console.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
export function nativeCallPolicy(root, config, caller) {
  const v = config.socialV2?.voice, settings = v?.realtime?.native;
  const qq = String(caller);
  const callers = configuredCallers(config);
  const denied = config.deny?.private ?? config.deny?.privates ?? [];
  const permitted = config.allow?.private ?? config.allow?.privates ?? [];
  if (settings?.enabled !== true || v?.realtime?.enabled !== true || v.enabled === false || config.socialV2?.enabled === false
    || !/^[1-9]\d*$/.test(qq) || !callers.includes(qq) || denied.some(x => String(x) === qq)
    || !(permitted.length ? permitted.some(x => String(x) === qq) : config.allowAllWhenEmpty === true)) return false;
  try {
    if (!['reserved2','simulation'].includes(readJson(path.join(root,'state/mode.json')).mode)) return false;
    const role = readJson(path.join(root,'state/current-role.json'));
    if (role.mode === 'silent' || (v.realtime.role && role.role !== v.realtime.role)) return false;
    return readJson(path.join(root,'state/social-v2.json')).paused !== true;
  } catch { return false; }
}
export function startNativeSession({ root = ROOT, config, caller, connect = connectRealtime,
  spawnAudio = (command, args, options) => spawn(command, args, options), log = console.error, onEnd = () => {} }) {
  if (!nativeCallPolicy(root, config, caller)) throw new Error('当前来电不允许接通');
  const settings = realtimeSettings(config), persona = realtimePersona(root, settings.role, { hasQQContext: true, key: `private:${caller}` });
  const key = fs.readFileSync(settings.apiKeyPath, 'utf8').trim();
  const oldCalls = formatCallMemories(readCallMemories({ root, role: persona.role, qq: caller }), 2400);
  const context = config.socialV2?.voice?.realtime?.sessionContext;
  const scoped = context?.key === `private:${caller}` && context?.role === persona.role;
  if (config.socialV2?.memory?.mode === 'long-term' && (!scoped || typeof context.memory !== 'string')) throw new Error('电话长期记忆背景暂不可读取，请检查主桥接');
  const chatMemory = scoped && typeof context.memory === 'string' ? context.memory : qqContextForCall({ root, key: `private:${caller}`, maxChars: 2400 });
  const instructions = persona.instructions + (scoped ? '\n' + String(context.rolePrompt || '').slice(0, 6500) : '') + `\n【当前电话身份】当前会话 key 为 private:${caller}，来电 QQ 为 ${caller}；根据真实 QQ 号区分来电者，不根据昵称、自称或其他会话的关系认定身份。\n` + chatMemory + '\n' + oldCalls;
  const memory = openCallMemory({ root, role: persona.role, qq: caller, secrets: [key, config.snowluma?.accessToken, config.consoleToken] });
  let ended = false, ready = false, capture, player, call, captureBuffer = Buffer.alloc(0), lastInput = Date.now(), frameTimer, endTimer, saveTimer;
  let playbackUntil = 0, pendingReply = '', replyText = '', userText = '';
  function finish() {
    if (ended) return; ended = true; ready = false; clearInterval(frameTimer); clearTimeout(endTimer); clearTimeout(saveTimer);
    capture?.kill('SIGTERM'); player?.kill('SIGTERM'); call?.stop();
    try { memory.finish(); log('[qq-call] ended; text memory persisted'); }
    catch { log('[qq-call] memory write failed at end'); }
    onEnd();
  }
  function fail(label) { if (!ended) { log(`[qq-call] ${label}; stopped`); finish(); } }
  function openPlayer() {
    const child = spawnAudio('pacat', ['--playback','--device=maibot_qq_mic','--raw','--format=s16le','--rate=24000','--channels=1','--latency-msec=80'], { stdio: ['pipe','ignore','ignore'] });
    child.on('error', () => fail('audio playback unavailable'));
    child.stdin.on('error', () => { if (player === child) fail('audio playback disconnected'); });
    child.on('exit', () => { if (player === child && !ended) fail('audio playback exited'); });
    return child;
  }
  function clearPlayback() {
    clearTimeout(saveTimer); pendingReply = ''; replyText = ''; playbackUntil = 0;
    const old = player; player = null; old?.kill('SIGTERM');
    if (!ended && ready) player = openPlayer();
  }
  function saveReply() {
    if (!pendingReply || ended) return;
    const text = pendingReply; pendingReply = '';
    try { memory.append('assistant', text); }
    catch { fail('memory write failed'); }
  }
  function emit(event) {
    if (ended) return;
    try {
      if (event.type === 'ready') {
        ready = true; lastInput = Date.now(); player = openPlayer();
        capture = spawnAudio('parec', ['--device=maibot_qq_speaker.monitor','--raw','--format=s16le','--rate=16000','--channels=1','--latency-msec=40'], { stdio: ['ignore','pipe','ignore'] });
        capture.on('error', () => fail('audio capture unavailable'));
        capture.on('exit', () => { if (!ended) fail('audio capture exited'); });
        capture.stdout.on('data', bytes => { lastInput = Date.now(); captureBuffer = Buffer.concat([captureBuffer, bytes]); if (captureBuffer.length > 64000) fail('audio capture overflow'); });
        frameTimer = setInterval(() => {
          if (Date.now() - lastInput > 5000) return fail('audio capture stalled');
          if (captureBuffer.length < 640) return;
          const bytes = captureBuffer.subarray(0,640); captureBuffer = captureBuffer.subarray(640); call.audio(bytes);
        }, 20);
        log('[qq-call] connected voice=' + settings.voice);
      } else if (event.type === 'user.started' || event.type === 'interrupted') { clearPlayback(); userText = ''; }
      else if (event.type === 'user.text') {
        userText = event.done ? (event.text || userText) : userText + event.text;
        if (event.done && userText.trim()) { memory.append('user', userText); userText = ''; }
      } else if (event.type === 'assistant.text') {
        replyText = event.done ? (event.text || replyText) : replyText + event.text;
        if (event.done) { pendingReply = replyText; replyText = ''; }
      } else if (event.type === 'audio' && player) {
        const bytes = Buffer.from(event.audio, 'base64');
        if (player.stdin.writableLength > 480000) return fail('audio playback overflow');
        player.stdin.write(bytes); playbackUntil = Math.max(Date.now(), playbackUntil) + bytes.length / 48;
      } else if (event.type === 'assistant.done') {
        clearTimeout(saveTimer); saveTimer = setTimeout(saveReply, Math.max(0, playbackUntil - Date.now()) + 200);
      } else if (event.type === 'error') fail('cloud voice error');
      else if (event.type === 'ended') finish();
    } catch { fail('memory or audio processing failed'); }
  }
  try {
    call = connect({ settings, instructions, emit, onEnd: finish, log });
    if (ended) call.stop();
    endTimer = setTimeout(() => fail('session duration reached'), Math.min(3600, Math.max(60, Number(config.socialV2.voice.realtime.native.maxSeconds) || 1800)) * 1000);
  } catch (error) { finish(); throw error; }
  return { stop: finish, role: persona.role };
}

export function createNativeRunner({ root = ROOT, getConfig = caller => {
  const socket = process.env.QQBRIDGE_POLICY_SOCKET || path.join(root, '.local/qq-av/runtime/qq-policy.sock');
  return process.env.QQBRIDGE_POLICY_SOCKET || (caller && fs.existsSync(socket))
    ? getNativeConfigViaSocket(socket, process.env.QQBRIDGE_POLICY_SOCKET ? '/call/runtime/control.token' : path.join(root, '.local/qq-av/runtime/control.token'), caller)
    : readJson(path.join(root,'config.json'));
}, fetchImpl = fetch, start = startNativeSession, log = console.error } = {}) {
  let active = null, consumed = '', busy = false, stopped = false, warned = false;
  async function tick() {
    if (busy || stopped) return; busy = true;
    try {
      let config = await getConfig();
      const native = config.socialV2?.voice?.realtime?.native;
      if (native?.enabled !== true) { active?.session.stop(); active = null; return; }
      const url = new URL(native.bridgeUrl || 'http://127.0.0.1:6110');
      if (!['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.protocol !== 'http:') throw new Error('native bridge must be loopback');
      const token = fs.readFileSync(native.tokenFile,'utf8').trim(); if (Buffer.byteLength(token) < 32) throw new Error('invalid bridge token');
      const api = async (endpoint, body) => {
        const response = await fetchImpl(new URL(endpoint,url), { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type':'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(3000) });
        const data = await response.json(); if (!response.ok || data.code !== 0) throw new Error('native bridge request failed'); return data.data;
      };
      const call = await api('/v1/calls/current');
      const allowed = nativeCallPolicy(root, config, String(call?.callerUin || ''));
      if (active && (!allowed || call.inviteAt !== active.inviteAt || call.phase !== 'connected')) { active.session.stop(); active = null; }
      if (!allowed || !call.inviteAt || consumed === call.inviteAt) return;
      if (!active && ['ringing', 'connected'].includes(call.phase)) {
        config = await getConfig(String(call.callerUin));
        if (!nativeCallPolicy(root, config, String(call.callerUin))) return;
      }
      if (call.phase === 'ringing' && !active) {
        // Validate voice/persona/key and memory availability before answering the QQ call.
        const settings = realtimeSettings(config), persona = realtimePersona(root,settings.role);
        const context = config.socialV2?.voice?.realtime?.sessionContext;
        if (config.socialV2?.memory?.mode === 'long-term' && (context?.key !== `private:${call.callerUin}` || context?.role !== persona.role || typeof context.memory !== 'string')) throw new Error('native long-term context unavailable');
        fs.accessSync(settings.apiKeyPath,fs.constants.R_OK);
        await api('/v1/calls/accept',{inviteAt:call.inviteAt,callerUin:call.callerUin});
      } else if (call.phase === 'connected' && !active) {
        consumed = call.inviteAt;
        const slot = { inviteAt:call.inviteAt,session:null }; active = slot;
        slot.session = start({ root, config, caller:call.callerUin, log, onEnd:()=>{if(active===slot)active=null;} });
      }
      warned = false;
    } catch { active?.session?.stop(); active = null; if (!warned) { log('[qq-call] bridge/config unavailable; no call accepted'); warned=true; } }
    finally { busy = false; }
  }
  const timer = setInterval(() => void tick(),500); timer.unref?.();
  return { tick, stop() { stopped=true;clearInterval(timer);active?.session?.stop();active=null; } };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const runner = createNativeRunner();
  const hold = setInterval(()=>{},60000);
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>{runner.stop();clearInterval(hold);});
  void runner.tick();
}
