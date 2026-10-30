export function configuredCallers(config) {
  const native = config.socialV2?.voice?.realtime?.native || {};
  const values = Object.hasOwn(native, 'allowedCallers') ? (Array.isArray(native.allowedCallers) ? native.allowedCallers : []) : [native.privateQQ || config.socialV2?.selfLife?.privateQQ];
  return [...new Set(values.map(v => String(v ?? '').trim()).filter(v => /^[1-9]\d*$/.test(v) && Number.isSafeInteger(Number(v))))].slice(0, 30);
}
// Only public voice settings cross this boundary; credentials and AV endpoints stay server-side.
export function voiceBridgeView(config, { mode = '', role = '', paused = false, keyConfigured = false, restartRequired = false } = {}) {
  const v = config.socialV2?.voice || {}, r = v.realtime || {}, n = r.native || {};
  return {
    enabled: r.enabled === true, nativeEnabled: n.enabled === true,
    callerQQ: String(n.privateQQ || config.socialV2?.selfLife?.privateQQ || ''), allowedCallers: configuredCallers(config),
    voice: String(r.voice || 'zh_female_vv_jupiter_bigtts'), voiceName: String(r.voiceName || ''),
    maxSeconds: Math.min(3600, Math.max(60, Number(n.maxSeconds) || 1800)),
    voiceEnabled: v.enabled !== false, keyConfigured, mode, role, paused, restartRequired
  };
}
export function updateVoiceBridge(config, input) {
  const fail = message => { throw Object.assign(new Error(message), { statusCode: 400 }); };
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('设置格式无效');
  const fields = new Set(['enabled', 'nativeEnabled', 'voice', 'voiceName', 'maxSeconds', 'allowedCallers']);
  if (Object.keys(input).some(k => !fields.has(k))) fail('包含不允许修改的语音设置');
  for (const name of ['enabled', 'nativeEnabled']) if (typeof input[name] !== 'boolean') fail('通话开关必须为布尔值');
  if (typeof input.voice !== 'string' || !/^[A-Za-z0-9_-]{3,128}$/.test(input.voice)) fail('音色 ID 应为 3～128 位字母、数字、下划线或短横线');
  if (typeof input.voiceName !== 'string' || input.voiceName.length > 60 || /[\x00-\x1f\x7f]/.test(input.voiceName)) fail('音色名称须在 60 字以内');
  if (!Number.isInteger(input.maxSeconds) || input.maxSeconds < 60 || input.maxSeconds > 3600) fail('单次通话时长须为 60～3600 秒的整数');
  const view = voiceBridgeView(config);
  const callers = input.allowedCallers === undefined ? view.allowedCallers : input.allowedCallers;
  if (!Array.isArray(callers) || callers.length > 30 || callers.some(v => typeof v !== 'string' || !/^[1-9]\d*$/.test(v) || !Number.isSafeInteger(Number(v)))) fail('接听 QQ 号须为有效号码列表，最多 30 个');
  const allowedCallers = [...new Set(callers)];
  if (input.nativeEnabled && !input.enabled) fail('请先开启实时通话，或同时关闭 QQ 电话接听');
  if (input.enabled && !view.voiceEnabled) fail('语音总开关已关闭，请先在二代设置中启用语音');
  if (input.nativeEnabled && !allowedCallers.length) fail('开启 QQ 电话前请至少填写一个允许接听的 QQ 号');
  const v = config.socialV2?.voice || {}, r = v.realtime || {}, n = r.native || {};
  return { ...config, socialV2: { ...config.socialV2, voice: { ...v, realtime: {
    ...r, enabled: input.enabled, voice: input.voice, voiceName: input.voiceName.trim(),
    native: { ...n, enabled: input.nativeEnabled, maxSeconds: input.maxSeconds, allowedCallers }
  } } } };
}
