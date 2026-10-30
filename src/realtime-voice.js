import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { loadPersonalSettings, personalRolePrompt } from './personal-settings.js';

export const REALTIME_URL = 'wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue';
export const PEACH_VOICE = 'zh_female_tianmeitaozi_uranus_bigtts';
export const VIVI_VOICE = 'zh_female_vv_jupiter_bigtts';

export function realtimeSettings(config) {
  const voice = config.socialV2?.voice;
  const settings = voice?.realtime ?? {};
  const apiKeyPath = settings.apiKeyPath || voice?.tts?.apiKeyPath;
  const speaker = settings.voice || VIVI_VOICE;
  if (voice?.enabled === false || settings.enabled !== true) throw new Error('实时通话尚未启用');
  if (!path.isAbsolute(apiKeyPath ?? '')) throw new Error('请先配置语音密钥文件');
  if (!/^[a-zA-Z0-9_-]{3,128}$/.test(speaker)) throw new Error('实时通话音色配置无效');
  return { apiKeyPath, voice: speaker, voiceName: settings.voiceName || (speaker === VIVI_VOICE ? 'Vivi' : speaker === PEACH_VOICE ? '桃子 2.0' : '已配置的音色'), enableMusic: settings.enableMusic === true, port: settings.port ?? 3110, role: settings.role };
}

export function realtimePersona(root, configuredRole, { hasQQContext = false, key = '' } = {}) {
  let role = configuredRole;
  if (!role) {
    try { role = JSON.parse(fs.readFileSync(path.join(root, 'state/current-role.json'), 'utf8')).role; }
    catch { role = '示例伙伴'; }
  }
  if (typeof role !== 'string' || !/^[\p{L}\p{N}_ -]{1,50}$/u.test(role)) throw new Error('通话角色配置无效');
  let text;
  try { text = fs.readFileSync(path.join(root, 'roles', role + '.md'), 'utf8'); }
  catch { throw new Error('无法读取通话角色，请检查角色文件'); }
  if (!text.trim()) throw new Error('通话角色内容为空');
  if (key) text += '\n' + personalRolePrompt(loadPersonalSettings(root), role, key);
  const memoryHint = hasQQContext ? '你在QQ里和电话里保持同一个角色身份。参考后附的同一来电者聊天记忆；不知道的事坦诚询问。' : '此通话没有注入QQ聊天历史，不知道的事坦诚询问。';
  const phoneStyle = `
【正在和熟悉的人打电话；以下电话表达规则优先于人设里关于打字、分条发消息、表情包和每次接两句的规则】
沿用上面的人物身份、亲密关系和性格，接着你们已有的关系聊天。接通不重新介绍自己，不把对方当第一次见面的客户。
先听他这句话具体在说什么、是什么情绪，再直接接话。熟悉的事可以有自己的看法，拿不准就自然问一句；玩笑能接梗、反逗，认真或难受时就收住，不把所有话都理解成求建议。
像贴着电话随口说话：长短随内容变化，一句话够就停，有事想说才多说。能接一个具体细节就接那个细节，不先复述或总结他的话，不机械地每轮补问题，不用固定“回应＋关心＋追问”的模板。
少说“我理解你的感受”“有什么可以帮你”“还有什么想聊的”“我会一直陪着你”这类套话。被夸可以有点得意，被逗可以笑着顶一句，不只礼貌道谢；称呼按关系自然使用，不每句喊哥哥。
声音清淡、亲近、松弛，有自己的情绪：开心时声音亮一点，逗人时带一点笑意，认真时平稳，安慰时放轻，被夸时可以害羞或小得意，也允许短暂犹豫和改口。语速、重音和短停顿跟着意思变化；不全程甜腻、俏皮或同一声调，不刻意堆语气词、笑声、气音。
例如他问“想我没”，可以顺着你们的关系逗一句“你都打过来了，还问这个”，也可以直接说想；只是示范接话的感觉，不背这句话或固定套路。
按语义理解口误、同音字和识别误差；不确定的关键内容再确认。记忆里没有发生的事不编成共同经历，也不猜对方没说完的意思。
直接说中文口语，不念Markdown、动作旁白、语气标签或工具调用，不声称已经发QQ消息、改资料或执行任何外部操作。`;
  return { role, instructions: text.slice(0, 6500) + '\n' + phoneStyle + '\n' + memoryHint + '对方明确请你唱歌时可以使用服务的原生唱歌能力，不先作冗长介绍。' };

}

export function realtimeSession({ voice, instructions, enableMusic = false }) {
  return { type: 'session.create', session: { model: '1.2.6.1', instructions,
    audio: { input: { format: { type: 'pcm', rate: 16000 } },
      output: { format: { type: 'pcm_s16le', rate: 24000 }, voice } } },
    extension: { dialog: { extra: { enable_music: enableMusic } } } };
}

function serviceError(event) {
  const code = String(event.error?.code || event.status_code || event.code || 'unknown');
  const text = String(event.error?.message || event.message || '');
  if (/quota|exhaust|balance|额度|余额/i.test(text)) return '实时语音额度不足，通话已结束，请检查控制台额度';
  if (/speaker|voice|音色/i.test(text)) return '实时语音服务拒绝了当前音色，请检查音色配置';
  if (code === '45000030') return '实时语音资源未授权，请检查服务开通状态';
  return `实时语音服务返回错误（${/^[a-zA-Z0-9_-]{1,40}$/.test(code) ? code : 'unknown'}），请稍后重试`;
}

export function connectRealtime({ settings, instructions, emit, onEnd = () => {}, log = console.error,
  createSocket = (url, options) => new WebSocket(url, options) }) {
  let key;
  try { key = fs.readFileSync(settings.apiKeyPath, 'utf8').trim(); }
  catch { throw new Error('无法读取语音密钥'); }
  if (!key || /\s/.test(key)) throw new Error('语音密钥格式无效');
  let ended = false, ready = false, inputFrames = 0, outputBytes = 0;
  // The v3 duplex endpoint only uses X-Api-Key. An old resource header causes 403.
  const socket = createSocket(REALTIME_URL, { headers: { 'X-Api-Key': key },
    handshakeTimeout: 12000, maxPayload: 2 * 1024 * 1024, followRedirects: false });
  const timeout = setTimeout(() => fail('实时语音连接超时，请稍后重试'), 15000);
  timeout.unref?.();
  function send(event) { if (socket.readyState === 1) socket.send(JSON.stringify(event)); }
  function stop() {
    if (ended) return;
    ended = true; clearTimeout(timeout);
    if (socket.readyState === 1) { send({ type: 'session.close' }); socket.close(1000); }
    else socket.terminate();
    const timer = setTimeout(() => socket.terminate(), 2000); timer.unref?.();
    log(`[realtime] ended inputFrames=${inputFrames} outputBytes=${outputBytes}`);
    emit({ type: 'ended' }); onEnd();
  }
  function fail(message) { if (!ended) { log('[realtime] failed'); emit({ type: 'error', message }); stop(); } }
  socket.on('open', () => {
    if (ended) return;
    log(`[realtime] session request voice=${settings.voice} personaChars=${instructions.length}`);
    send(realtimeSession({ voice: settings.voice, instructions, enableMusic: settings.enableMusic }));
  });
  socket.on('message', bytes => {
    if (ended) return;
    try {
      const event = JSON.parse(bytes.toString());
      switch (event.type) {
        case 'session.created': ready = true; clearTimeout(timeout); emit({ type: 'ready' }); log('[realtime] session ready'); break;
        case 'conversation.item.input_audio_transcription.started': emit({ type: 'user.started' }); break;
        case 'conversation.item.input_audio_transcription.delta': emit({ type: 'user.text', text: String(event.delta || event.text || ''), done: false }); break;
        case 'conversation.item.input_audio_transcription.completed': emit({ type: 'user.text', text: String(event.text || ''), done: true }); break;
        case 'response.output_text.delta': emit({ type: 'assistant.text', text: String(event.delta || ''), done: false }); break;
        case 'response.output_text.done': emit({ type: 'assistant.text', text: String(event.text || ''), done: true }); break;
        case 'response.output_audio.started': emit({ type: 'assistant.started' }); break;
        case 'response.output_audio.delta': {
          const audio = event.delta;
          if (typeof audio !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(audio)) throw new Error();
          outputBytes += Buffer.byteLength(audio, 'base64'); emit({ type: 'audio', audio }); break;
        }
        case 'response.output_audio.done': emit({ type: 'assistant.done' }); break;
        case 'response.canceled': emit({ type: 'interrupted' }); break;
        case 'session.closed': stop(); break;
        case 'error': fail(serviceError(event)); break;
      }
    } catch { fail('实时语音返回了无法处理的数据，请重新接通'); }
  });
  socket.on('unexpected-response', (_req, response) => {
    response.resume(); fail(response.statusCode === 403 ? '实时语音鉴权未通过，请检查服务和密钥权限' : '实时语音连接失败，请稍后重试');
  });
  socket.on('error', () => fail('实时语音连接中断，请重新接通'));
  socket.on('close', () => { if (!ended) fail('实时语音连接已断开，请重新接通'); });
  return {
    audio(bytes) {
      if (ended || !ready) return;
      if (!Buffer.isBuffer(bytes) || bytes.length !== 640) return fail('录音数据格式无效，请重新接通');
      if (socket.bufferedAmount > 262144) return fail('网络发送积压，通话已结束，请检查连接');
      inputFrames++; send({ type: 'input_audio_buffer.append', audio: bytes.toString('base64') });
    },
    command(type) {
      if (ended) return;
      if (type === 'stop') return stop();
      if (!ready) return;
      if (type === 'mute') send({ type: 'input_audio_mute.commit' });
      else if (type === 'unmute') send({ type: 'input_audio_unmute.commit' });
      else if (type === 'interrupt') send({ type: 'response.cancel' });
      else if (type === 'commit') send({ type: 'input_audio_buffer.commit' });
      else fail('不支持的通话操作');
    }, stop
  };
}
