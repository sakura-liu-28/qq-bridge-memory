import { isIP } from 'node:net';
import { isPrivateIp } from './safe-fetch.js';

// An address chooses a server, not a wire protocol. Each template uses an
// adapter already implemented in this repository.
export const SERVICE_TEMPLATES = [
  { id: 'tts:volcengine', type: 'tts', provider: 'volcengine', label: '语音合成 · 火山引擎', endpoint: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse', models: ['zh_female_vv_uranus_bigtts', 'zh_female_tianmeitaozi_uranus_bigtts'] },
  { id: 'asr:volcengine', type: 'asr', provider: 'volcengine', label: '语音识别 · 火山引擎', endpoint: 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream', models: ['asr-2.0'] },
  { id: 'vision:zhipu', type: 'vision', provider: 'zhipu', label: '图片识别 · 智谱', endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', models: ['glm-4.6v-flash', 'glm-4.1v-thinking-flash', 'glm-4v-flash'] },
  { id: 'vision:siliconflow', type: 'vision', provider: 'siliconflow', label: '图片识别 · 硅基流动', endpoint: 'https://api.siliconflow.cn/v1/chat/completions', models: ['Qwen/Qwen3.5-4B'] },
  { id: 'vision:volcengine', type: 'vision', provider: 'volcengine', label: '图片识别 · 火山引擎', endpoint: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions', models: [], quotaConfirmation: true },
  { id: 'vision:bailian', type: 'vision', provider: 'bailian', label: '图片识别 · 百炼', endpoint: '', models: ['qwen3.5-flash'], quotaConfirmation: true },
  { id: 'image:zhipu', type: 'image', provider: 'zhipu', label: '图片生成 · 智谱', endpoint: 'https://open.bigmodel.cn/api/paas/v4/images/generations', models: ['cogview-3-flash'] },
  { id: 'image:siliconflow', type: 'image', provider: 'siliconflow', label: '图片生成 · 硅基流动', endpoint: 'https://api.siliconflow.cn/v1/images/generations', models: ['Kwai-Kolors/Kolors'] },
  { id: 'image:volcengine', type: 'image', provider: 'volcengine', label: '图片生成 · 火山引擎', endpoint: 'https://ark.cn-beijing.volces.com/api/v3/images/generations', models: ['doubao-seedream-4-0-20260415'], quotaConfirmation: true },
  { id: 'image:bailian', type: 'image', provider: 'bailian', label: '图片生成 · 百炼', endpoint: '', models: ['qwen-image-2.0'], quotaConfirmation: true },
  { id: 'vision:openai', type: 'vision', provider: 'openai', label: '标准识图 · Chat Completions', endpoint: '', models: [] },
  { id: 'image:openai', type: 'image', provider: 'openai', label: '标准生图 · Images Generations', endpoint: '', models: [] },
];
const fail = message => { throw Object.assign(new Error(message), { statusCode: 400 }); };
export function serviceEndpoint(value, type) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { fail('请填写完整的 API 请求地址'); }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== (type === 'asr' ? 'wss:' : 'https:') || url.username || url.password || url.search || url.hash
      || ['localhost', 'metadata.google.internal'].includes(host) || host.endsWith('.localhost') || host.endsWith('.local')
      || (isIP(host) && isPrivateIp(host)) || String(value).length > 2048) fail('API 地址需为公网 HTTPS 地址（语音识别使用 WSS），不能包含凭据或查询参数');
  return url.href.replace(/\/$/, '');
}
export function serviceConnectionsView(config) {
  return { templates: SERVICE_TEMPLATES, services: (config.socialV2?.serviceConnections || []).map(({ id, name, type, provider, protocol, model, endpoint, freeOnlyConfirmed, apiKeyPath }) =>
    ({ id, name, type, provider, protocol: protocol || `${type}:${provider}`, model, endpoint, freeOnlyConfirmed: freeOnlyConfirmed === true, configured: !!apiKeyPath })) };
}
export function resolveServiceTemplate(input) {
  const type = input.type || String(input.template || '').split(':')[0];
  if (!['tts', 'asr', 'vision', 'image'].includes(type)) fail('请选择服务用途');
  const protocol = input.template || input.protocol || 'auto';
  if (protocol !== 'auto') {
    const template = SERVICE_TEMPLATES.find(item => item.id === protocol && item.type === type);
    if (!template) fail('该接口格式不支持所选用途');
    return template;
  }
  let url;
  try { url = new URL(String(input.endpoint || '').trim()); } catch { fail('请填写完整的 API 地址'); }
  const known = SERVICE_TEMPLATES.find(item => item.type === type && item.endpoint && new URL(item.endpoint).hostname === url.hostname);
  const provider = known?.provider || (type === 'tts' || type === 'asr' ? 'volcengine'
    : /\.maas\.aliyuncs\.com$/.test(url.hostname) || url.pathname.includes('/multimodal-generation/') ? 'bailian' : 'openai');
  return SERVICE_TEMPLATES.find(item => item.id === `${type}:${provider}`);
}
export function updateServiceConnection(config, input, { id, keyFile } = {}) {
  const template = resolveServiceTemplate(input);
  const name = String(input.name || '').trim();
  if (name.length > 60 || /[\x00-\x1f]/.test(name)) fail('备注名称最多 60 字，不能包含控制字符');
  const next = structuredClone(config); next.socialV2 ||= {};
  const entries = next.socialV2.serviceConnections || [];
  const old = entries.find(item => item.id === id);
  if (input.id && !old) fail('服务不存在，请刷新列表');
  if (old && old.type !== template.type) fail('已有服务不能更换用途，请另外添加服务');
  if (!old && entries.length >= 50) fail('最多保存 50 个服务，请先删除不用的服务');
  const model = String(input.model || '').trim();
  const customAllowed = template.provider === 'openai' ? /^[a-z0-9][a-z0-9._:/@+-]{0,199}$/i.test(model)
    : template.type === 'asr' ? false : template.type === 'tts' ? /^[A-Za-z0-9_-]{3,128}$/.test(model)
    : template.provider === 'volcengine' ? (template.type === 'image' ? /^(?:doubao-seedream-|ep-)[a-z0-9-]+$/.test(model) : /^[a-z0-9./-]{1,128}$/i.test(model))
    : template.provider === 'bailian' ? (template.type === 'image' ? /^qwen-image-2\.0(?:-pro)?(?:-\d{4}-\d{2}-\d{2})?$/.test(model) : /^[a-z0-9./-]{1,128}$/i.test(model)) : false;
  if (!template.models.includes(model) && !customAllowed) fail('该模型尚未接入，请从推荐模型中选择');
  let endpoint = serviceEndpoint(input.endpoint, template.type);
  // Accept a standard API base or a complete request URL. Explicit legacy
  // templates retain their full-URL contract.
  if (!input.template && ['vision', 'image'].includes(template.type) && template.provider !== 'bailian') {
    const url = new URL(endpoint);
    const suffix = template.type === 'vision' ? 'chat/completions' : 'images/generations';
    if (url.pathname === '/') endpoint = template.endpoint || endpoint + '/v1/' + suffix;
    else if (/\/v\d+$/.test(url.pathname)) endpoint += '/' + suffix;
  }
  const apiKeyPath = keyFile || old?.apiKeyPath;
  if (!apiKeyPath) fail('首次添加服务需要填写 API Key');
  if (template.quotaConfirmation && input.freeOnlyConfirmed !== true) fail('请先在平台开启免费额度用完即停，并勾选确认');
  const item = { id, name: name || new URL(endpoint).hostname, type: template.type, provider: template.provider,
    protocol: input.template || input.protocol || 'auto', model, endpoint, apiKeyPath, freeOnlyConfirmed: input.freeOnlyConfirmed === true };
  next.socialV2.serviceConnections = old ? entries.map(value => value.id === id ? item : value) : [...entries, item];
  return next;
}

export function serviceAccess(service) {
  return { apiKeyPath: service.apiKeyPath, endpoint: service.endpoint, freeOnlyConfirmed: service.freeOnlyConfirmed,
    ...(service.type === 'tts' ? { voice: service.model, resourceId: /^(S_|icl_)/.test(service.model) ? 'seed-icl-2.0' : 'seed-tts-2.0' } : {}) };
}
