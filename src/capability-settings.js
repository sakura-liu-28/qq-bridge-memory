import fs from 'node:fs';
import path from 'node:path';
import { configuredTtsVoices } from './volcengine-tts.js';
import { serviceAccess } from './service-connections.js';

const PROVIDERS = { volcengine: '火山引擎', zhipu: '智谱', siliconflow: '硅基流动', bailian: '阿里百炼', edge: 'Edge TTS', openai: '自定义 API' };
const MODELS = {
  image: [['zhipu', 'cogview-3-flash'], ['siliconflow', 'Kwai-Kolors/Kolors'], ['volcengine', 'doubao-seedream-4-0-20260415'], ['bailian', 'qwen-image-2.0']],
  vision: [['zhipu', 'glm-4.6v-flash'], ['zhipu', 'glm-4.1v-thinking-flash'], ['zhipu', 'glm-4v-flash'], ['siliconflow', 'Qwen/Qwen3.5-4B'], ['bailian', 'qwen3.5-flash']],
};
const TTS = [
  { provider: 'volcengine', model: 'zh_female_vv_uranus_bigtts', resourceId: 'seed-tts-2.0', label: 'Vivi' },
  { provider: 'volcengine', model: 'zh_female_tianmeitaozi_uranus_bigtts', resourceId: 'seed-tts-2.0', label: '桃子' },
  { provider: 'edge', model: 'zh-CN-XiaoxiaoNeural', label: '晓晓' },
  { provider: 'edge', model: 'zh-CN-YunxiNeural', label: '云希' },
];
const idFor = option => option.connectionId ? `service:${option.connectionId}` : `${option.provider}:${option.model}`;
function section(config, type) {
  const social = config.socialV2 || {}, voice = social.voice || {};
  return type === 'tts' ? voice.tts || {} : type === 'asr' ? voice.asr || {} : type === 'image' ? social.imageGeneration || {} : social.vision || {};
}
function readable(file) { try { return path.isAbsolute(file || '') && fs.statSync(file).isFile() && Boolean(fs.accessSync(file, fs.constants.R_OK) === undefined); } catch { return false; } }
function credential(config, type, provider, connectionId) {
  if (connectionId) {
    const service = config.socialV2?.serviceConnections?.find(item => item.id === connectionId && item.type === type);
    return service ? serviceAccess(service) : {};
  }
  const settings = section(config, type);
  if (settings.connectionId && settings.providerSettings?.[provider]) {
    const saved = settings.providerSettings[provider];
    return { ...saved, apiKeyPath: saved.apiKeyPath || (type === 'asr' ? config.socialV2?.voice?.tts?.apiKeyPath : undefined) };
  }
  if (settings.connectionId) return settings.providers?.[provider] || {};
  if (type === 'asr') return { ...settings, apiKeyPath: settings.apiKeyPath || config.socialV2?.voice?.tts?.apiKeyPath };
  return settings.providers?.[provider] || (settings.provider === provider || (!settings.provider && ['volcengine', 'zhipu'].includes(provider)) ? settings : {});
}
export function capabilityView(config) {
  const cards = [];
  for (const type of ['tts', 'asr', 'vision', 'image']) {
    const settings = section(config, type), options = new Map();
    const add = raw => {
      if (!raw.provider || !raw.model) return;
      const value = { ...raw, id: idFor(raw), label: raw.label || `${PROVIDERS[raw.provider] || raw.provider} · ${raw.model}` };
      const access = credential(config, type, value.provider, value.connectionId);
      value.configured = value.provider === 'edge' ? readable(settings.pythonPath) : readable(access.apiKeyPath);
      options.set(value.id, value);
    };
    if (type === 'tts') {
      for (const option of TTS) add(option);
      for (const [provider, value] of Object.entries(settings.providerSettings || {})) if (value?.voice) add({ provider, model: value.voice, resourceId: value.resourceId, label: `已保存音色 · ${value.voice}` });
      if (settings.voice) add({ provider: settings.provider || 'volcengine', model: settings.voice, resourceId: settings.resourceId || 'seed-tts-2.0', label: settings.voiceName ? `当前音色 · ${settings.voiceName}` : `已配置音色 · ${settings.voice}` });
    } else if (type === 'asr') add({ provider: 'volcengine', model: 'asr-2.0', label: '火山引擎 · 流式语音识别 2.0' });
    else {
      for (const [provider, model] of MODELS[type]) add({ provider, model });
      for (const option of settings.queue || []) if (PROVIDERS[option.provider] && !option.connectionId) add({ provider: option.provider, model: option.model });
      if (settings.model) add({ provider: settings.provider || (type === 'image' ? 'volcengine' : 'zhipu'), model: settings.model });
    }
    for (const service of config.socialV2?.serviceConnections || []) if (service.type === type) add({ provider: service.provider, model: service.model, connectionId: service.id, resourceId: serviceAccess(service).resourceId, label: `${service.name} · ${service.model}` });
    const active = (settings.queue || []).find(option => option.enabled && option.capability === type);
    const provider = type === 'asr' ? 'volcengine' : active?.provider || settings.provider || (type === 'vision' ? 'zhipu' : 'volcengine');
    const model = type === 'tts' ? settings.voice || TTS[0].model : type === 'asr' ? 'asr-2.0' : active?.model || settings.model || MODELS[type][0][1];
    cards.push({ type, title: { tts: '语音合成', asr: '语音识别', vision: '图片识别', image: '图片生成' }[type],
      enabled: settings.enabled === true, selected: idFor({ provider, model, connectionId: ['tts', 'asr'].includes(type) ? settings.connectionId : active?.connectionId || settings.connectionId }), options: [...options.values()],
      automatic: settings.automatic !== false, privateQQ: type === 'asr' ? String(settings.privateQQ || '') : undefined,
      maxSeconds: type === 'asr' ? Number(settings.maxSeconds) || 120 : undefined,
      freeOnlyConfirmed: credential(config, type, provider, settings.connectionId).freeOnlyConfirmed === true,
      fixedReference: type === 'image' ? settings.fixedReference === true : undefined,
      hasReference: type === 'image' ? readable(settings.referenceImagePath) : undefined,
      freeFallback: type === 'tts' ? settings.freeFallback?.enabled === true : undefined,
      fallbackVoices: type === 'tts' ? (settings.fallbackVoices || []).map(item => item.voice) : undefined,
      queue: type === 'image' || type === 'vision' ? (settings.queue || []).map(item => ({ id: idFor(item), enabled: item.enabled === true })) : undefined,
    });
  }
  return { cards };
}
function invalid(message) { return Object.assign(new Error(message), { statusCode: 400 }); }

// Pure config patch: never replace the full user's provider configuration with UI fields.
export function updateCapability(config, input, { keyFile } = {}) {
  const type = input?.type;
  if (!['tts', 'asr', 'vision', 'image'].includes(type)) throw invalid('能力类型无效');
  const current = capabilityView(config).cards.find(card => card.type === type);
  const option = current.options.find(value => value.id === input.selected);
  if (!option) throw invalid('请选择已接入的服务和模型');
  const next = structuredClone(config);
  next.socialV2 ||= {}; next.socialV2.voice ||= {}; next.socialV2.tools ||= {};
  const settings = { ...section(next, type) };
  settings.enabled = input.enabled === true;
  const access = { ...credential(next, type, option.provider, option.connectionId) };
  if (keyFile) access.apiKeyPath = keyFile;
  if (keyFile && option.connectionId) next.socialV2.serviceConnections.find(item => item.id === option.connectionId).apiKeyPath = keyFile;
  if (!settings.connectionId && option.connectionId) {
    const { enabled, providerSettings, connections, connectionId, ...original } = settings;
    const provider = settings.provider || (type === 'vision' ? 'zhipu' : 'volcengine');
    settings.providerSettings = { ...providerSettings, [provider]: { ...original, apiKeyPath: credential(config, type, provider).apiKeyPath } };
  }
  if (settings.connectionId && !option.connectionId) delete settings.endpoint;
  settings.connectionId = option.connectionId || '';
  settings.connections = Object.fromEntries((next.socialV2.serviceConnections || []).filter(item => item.type === type).map(item => [item.id, serviceAccess(item)]));
  if (type === 'tts') {
    if (settings.provider && settings.provider !== option.provider) settings.providerSettings = { ...settings.providerSettings, [settings.provider]: { voice: settings.voice, resourceId: settings.resourceId, pythonPath: settings.pythonPath } };
    const restored = option.connectionId ? {} : settings.providerSettings?.[option.provider] || {};
    Object.assign(settings, restored, { provider: option.provider, voice: option.model });
    if (option.connectionId) Object.assign(settings, access, { fallbackVoices: [] });
    if (option.provider === 'volcengine') {
      settings.resourceId = option.resourceId || 'seed-tts-2.0';
      if (access.apiKeyPath) settings.apiKeyPath = access.apiKeyPath;
      configuredTtsVoices({ ...settings, fallbackVoices: [] });
    }
    if (input.customVoice !== undefined && String(input.customVoice).trim()) {
      const voice = String(input.customVoice).trim();
      if (option.provider !== 'volcengine') throw invalid('自定义音色仅支持已接入的火山引擎');
      configuredTtsVoices({ voice, resourceId: /^(S_|icl_)/.test(voice) ? 'seed-icl-2.0' : 'seed-tts-2.0' });
      settings.voice = voice; settings.resourceId = /^(S_|icl_)/.test(voice) ? 'seed-icl-2.0' : 'seed-tts-2.0';
    }
    if (typeof input.pythonPath === 'string' && input.pythonPath.trim()) settings.pythonPath = input.pythonPath.trim();
    if (settings.enabled && option.provider === 'edge' && !readable(settings.pythonPath)) throw invalid('请先配置可执行且安装了 edge-tts 的 Python 路径');
    if (settings.enabled && option.provider === 'volcengine' && !readable(settings.apiKeyPath)) throw invalid('请先配置语音合成密钥');
    next.socialV2.voice.tts = settings;
  } else if (type === 'asr') {
    const qq = String(input.privateQQ ?? settings.privateQQ ?? '').trim();
    if (settings.enabled && !/^[1-9]\d*$/.test(qq)) throw invalid('请选择允许识别语音的私聊 QQ');
    const allowed = next.allow?.private || next.allow?.privates || [];
    const denied = next.deny?.private || next.deny?.privates || [];
    if (settings.enabled && (denied.map(String).includes(qq) || !(allowed.map(String).includes(qq) || (!allowed.length && next.allowAllWhenEmpty === true)))) throw invalid('语音识别对象必须在聊天白名单内');
    settings.privateQQ = qq;
    settings.maxSeconds = Math.min(300, Math.max(1, Math.trunc(Number(input.maxSeconds) || settings.maxSeconds || 120)));
    settings.maxTotalSeconds ||= 68400;
    if (access.apiKeyPath) settings.apiKeyPath = access.apiKeyPath;
    if (option.connectionId) settings.endpoint = access.endpoint;
    else if (access.endpoint) settings.endpoint = access.endpoint;
    if (settings.enabled && !readable(settings.apiKeyPath)) throw invalid('请先配置语音识别密钥');
    next.socialV2.voice.asr = settings;
  } else {
    settings.provider = option.provider; settings.model = option.model;
    if (input.freeOnlyConfirmed !== undefined && !option.connectionId) access.freeOnlyConfirmed = input.freeOnlyConfirmed === true;
    if (typeof input.serviceBase === 'string' && input.serviceBase.trim()) {
      const base = input.serviceBase.trim().replace(/\/$/, '');
      if (option.provider !== 'bailian' || !/^https:\/\/ws-[a-z0-9-]+\.cn-beijing\.maas\.aliyuncs\.com\/(?:api\/v1|compatible-mode\/v1)$/.test(base)) throw invalid('请填写百炼北京业务空间地址');
      if (type === 'image') access.apiBase = base; else access.baseURL = base;
    }
    if (settings.enabled && !readable(access.apiKeyPath)) throw invalid('请先配置所选服务的密钥');
    if (settings.enabled && ['bailian', 'volcengine'].includes(option.provider) && access.freeOnlyConfirmed !== true) throw invalid('请先在服务端开启免费额度用完即停，并勾选确认');
    if (settings.enabled && option.provider === 'bailian' && !access.endpoint && !access[type === 'image' ? 'apiBase' : 'baseURL']) throw invalid('请先填写百炼业务空间地址');
    if (!option.connectionId) settings.providers = { ...settings.providers, [option.provider]: access };
    if (access.apiKeyPath) settings.apiKeyPath = access.apiKeyPath;
    const queue = (settings.queue || []).map(item => {
      const service = next.socialV2.serviceConnections?.find(value => value.id === item.connectionId && value.type === type);
      return service ? { ...item, provider: service.provider, model: service.model } : { ...item };
    });
    const selected = queue.find(item => idFor(item) === option.id) || { provider: option.provider, model: option.model, ...(option.connectionId ? { connectionId: option.connectionId } : {}), capability: type, freeEligible: true };
    selected.model = option.model;
    selected.enabled = true;
    settings.queue = [selected, ...queue.filter(item => idFor(item) !== option.id)];
    if (input.backups !== undefined) {
      if (!Array.isArray(input.backups) || input.backups.length > 10 || new Set(input.backups).size !== input.backups.length || input.backups.includes(option.id)) throw invalid('备用服务不能重复，最多配置 10 个');
      const backups = input.backups.map(id => {
        const value = current.options.find(item => item.id === id);
        if (!value?.configured) throw invalid('备用服务不存在或尚未配置密钥');
        const credentialValue = credential(next, type, value.provider, value.connectionId);
        if (['volcengine', 'bailian'].includes(value.provider) && credentialValue.freeOnlyConfirmed !== true) throw invalid('备用服务也需要确认免费额度用完即停');
        return { ...(queue.find(item => idFor(item) === id) || {}), provider: value.provider, model: value.model, connectionId: value.connectionId || '', capability: type, enabled: true, freeEligible: true };
      });
      settings.queue = [selected, ...backups, ...queue.filter(item => ![option.id, ...input.backups].includes(idFor(item))).map(item => ({ ...item, enabled: false }))];
    }
    if (type === 'vision') { settings.automatic = input.automatic !== false; next.socialV2.vision = settings; }
    else {
      if (input.fixedReference !== undefined) settings.fixedReference = input.fixedReference === true;
      if (settings.enabled && settings.fixedReference && option.provider !== 'volcengine') throw invalid('固定角色参考图需要选择已接入的火山参考图模型');
      next.socialV2.imageGeneration = settings;
    }
  }
  if (['tts', 'asr'].includes(type) && settings.enabled) next.socialV2.voice.enabled = true;
  const flag = { tts: 'sendVoice', vision: 'describeImage', image: 'generateImage' }[type];
  if (flag && (type !== 'tts' || settings.enabled)) next.socialV2.tools[flag] = settings.enabled;
  return next;
}
