import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SENSITIVE_RE } from './sensitive.js';
import { generateImage } from './image-provider.js';

export const AVATAR_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
export class SelfLifeError extends Error {}

// One account-wide store: the avatar interval survives sessions and restarts.
export function createSelfLife({ statePath, getSettings, getImageSettings, getGateway, generate = generateImage, fetchImpl = fetch, now = Date.now, log = console.error }) {
  let busy = false;
  function avatarIntervalMs() {
    const configured = Number(getSettings()?.avatarIntervalMs);
    return Number.isFinite(configured) && configured >= 0 ? configured : AVATAR_INTERVAL_MS;
  }
  function load() {
    try {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (!state || state.version !== 1 || !Array.isArray(state.recentDynamics)
          || !Number.isSafeInteger(state.lastAvatarAt) || state.lastAvatarAt < 0) throw new Error();
      return state;
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, lastAvatarAt: 0, recentDynamics: [], pending: null };
      throw new SelfLifeError('自主资料状态无法读取，已停止修改，请联系管理员');
    }
  }
  function save(state) {
    const tmp = `${statePath}.${crypto.randomUUID()}.tmp`;
    try { fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, statePath); }
    finally { try { fs.unlinkSync(tmp); } catch {} }
  }
  function status() {
    const settings = getSettings();
    const state = load();
    return {
      enabled: settings?.enabled === true,
      avatar: { enabled: settings?.avatar !== false, lastChangedAt: state.lastAvatarAt || null,
        nextAllowedAt: state.lastAvatarAt && avatarIntervalMs() > 0 ? state.lastAvatarAt + avatarIntervalMs() : null,
        canChange: settings?.enabled === true && settings?.avatar !== false && !state.pending && (!state.lastAvatarAt || now() - state.lastAvatarAt >= avatarIntervalMs()) },
      dynamic: { enabled: settings?.dynamic !== false, limit: null, visibility: settings?.qzoneVisibility ?? 4, lastPublishedAt: state.lastDynamicAt ?? null },
      signature: { enabled: settings?.signature !== false, limit: null, lastChangedAt: state.lastSignatureAt ?? null },
      nickname: { enabled: settings?.nickname === true, limit: null, lastChangedAt: state.lastNicknameAt ?? null, lastConfirmed: state.lastNickname ?? null },
      pending: state.pending ? { action: state.pending.action, at: state.pending.at, uncertain: true } : null
    };
  }
  function checkText(value, label, max, secrets) {
    if (typeof value !== 'string' || !value.trim() || [...value.trim()].length > max) throw new SelfLifeError(`${label}不能为空，且不能超过 ${max} 字`);
    const text = value.trim();
    if (SENSITIVE_RE.test(text) || secrets.some(s => s && text.includes(s))) throw new SelfLifeError(`${label}包含内部信息，已阻止操作`);
    return text;
  }
  async function run({ action, text, imagePrompt, secrets = [], assertAllowed = () => {} }) {
    assertAllowed();
    const settings = getSettings();
    if (settings?.enabled !== true) throw new SelfLifeError('自主动态与资料功能尚未启用');
    if (action === 'state') return { ok: true, ...status() };
    if (!['dynamic', 'signature', 'avatar', 'nickname'].includes(action) || settings[action] === false
        || (action === 'nickname' && settings.nickname !== true)) throw new SelfLifeError('当前自主资料动作未启用');
    if (busy) throw new SelfLifeError('正在处理上一项资料操作，请等待结果，不要重复调用');
    busy = true;
    let state, sending = false, reserved = false;
    try {
      state = load();
      if (state.pending) throw new SelfLifeError('上一项资料操作结果待核实，已停止重复操作，请联系管理员检查');
      const content = action === 'avatar' ? '' : checkText(text, { signature: '个性签名', nickname: 'QQ 昵称', dynamic: '动态正文' }[action], { signature: 80, nickname: 20, dynamic: 2000 }[action], secrets);
      const prompt = action === 'avatar' ? checkText(imagePrompt, '头像描述', 2000, secrets)
        : imagePrompt == null ? null : checkText(imagePrompt, '配图描述', 2000, secrets);
      if (['signature', 'nickname'].includes(action) && prompt) throw new SelfLifeError('个性签名和昵称不支持配图');
      if (action === 'nickname' && /[\r\n\u0000-\u001f\u007f]/u.test(content)) throw new SelfLifeError('QQ 昵称不能包含换行或控制字符');
      if (action === 'avatar' && state.lastAvatarAt && now() - state.lastAvatarAt < avatarIntervalMs()) throw new SelfLifeError('头像更换间隔尚未结束，目前还未到可更换时间');
      const fingerprint = crypto.createHash('sha256').update(JSON.stringify([content, prompt])).digest('hex');
      if (action === 'dynamic' && state.recentDynamics.includes(fingerprint)) return { ok: true, changed: false, duplicate: true };
      if (action === 'signature' && state.signatureHash === fingerprint) return { ok: true, changed: false, duplicate: true };
      if (action === 'nickname' && state.lastNickname === content) return { ok: true, changed: false, duplicate: true };
      const visibility = settings.qzoneVisibility ?? 4;
      if (action === 'dynamic' && ![1, 4, 64].includes(visibility)) throw new SelfLifeError('动态可见范围配置无效');
      let params, endpoint;
      log(`[self-life] request action=${action} chars=${content.length} image=${Boolean(prompt)}`);
      let image;
      if (prompt) {
        const imageSettings = getImageSettings();
        if (imageSettings?.fixedReference !== true || !path.isAbsolute(imageSettings.referenceImagePath ?? '')) throw new SelfLifeError('请先配置并启用示例伙伴的固定参考照片');
        image = await generate({ prompt: action === 'avatar' ? `真人风格单人头像，面部清晰居中，适合正方形裁剪。${prompt}` : prompt,
          settings: imageSettings, useReference: true, secrets });
        if (!image?.buffer?.length) throw new SelfLifeError('没有生成有效图片，未修改 QQ 资料');
      }
      if (action === 'avatar') { endpoint = 'set_qq_avatar'; params = { file: `base64://${image.buffer.toString('base64')}` }; }
      if (action === 'signature') { endpoint = 'set_self_longnick'; params = { longNick: content }; }
      // Omit optional profile fields: the gateway preserves the current signature and other details.
      if (action === 'nickname') { endpoint = 'set_qq_profile'; params = { nickname: content }; }
      if (action === 'dynamic') { endpoint = 'send_qzone_msg'; params = { content, ugc_right: visibility, ...(image ? { images: [`base64://${image.buffer.toString('base64')}`] } : {}) }; }
      assertAllowed();
      state.pending = { action, at: now() };
      save(state); // Fail before the external mutation if durable accounting fails.
      reserved = true;
      const gateway = getGateway();
      sending = true;
      const response = await fetchImpl(`${gateway.httpUrl.replace(/\/+$/, '')}/${endpoint}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60000),
        headers: { 'content-type': 'application/json', ...(gateway.accessToken ? { authorization: `Bearer ${gateway.accessToken}` } : {}) },
        body: JSON.stringify(params)
      });
      const body = await response.json();
      if (body?.status === 'failed' && body?.retcode !== 0) {
        sending = false;
        throw new SelfLifeError(`QQ 网关未完成${{ dynamic: '动态发布', signature: '签名修改', avatar: '头像更换', nickname: '昵称修改' }[action]}，请检查接口支持与账号状态`);
      }
      if (!response.ok || body?.status !== 'ok' || body?.retcode !== 0) throw new SelfLifeError('QQ 网关未返回明确成功，结果待核实，请勿自动重试');
      if (action === 'dynamic' && (typeof body.data?.tid !== 'string' || !body.data.tid.trim())) throw new SelfLifeError('QQ 空间未返回动态编号，结果待核实，请勿自动重试');
      const at = now();
      if (action === 'avatar') state.lastAvatarAt = at;
      if (action === 'signature') { state.lastSignatureAt = at; state.signatureHash = fingerprint; }
      if (action === 'nickname') { state.lastNicknameAt = at; state.lastNickname = content; }
      if (action === 'dynamic') { state.lastDynamicAt = at; state.recentDynamics = [...state.recentDynamics, fingerprint].slice(-100); }
      state.pending = null;
      save(state);
      log(`[self-life] completed action=${action} at=${at}`);
      return { ok: true, changed: true, action, at, ...(action === 'dynamic' ? { tid: String(body.data.tid) } : {}), ...(action === 'nickname' ? { nickname: content } : {}), ...(action === 'avatar' ? { nextAllowedAt: avatarIntervalMs() > 0 ? at + avatarIntervalMs() : null } : {}) };
    } catch (error) {
      if (reserved && state?.pending && !sending) {
        state.pending = null;
        try { save(state); } catch { throw new SelfLifeError('自主资料状态保存失败，已停止修改，请联系管理员'); }
      }
      log(`[self-life] failed action=${action} type=${error?.name || 'Error'} uncertain=${sending}`);
      if (error instanceof SelfLifeError) throw error;
      throw new SelfLifeError(sending ? '资料操作结果待核实，请勿自动重试；请联系管理员检查' : '自主资料操作失败，请稍后再试');
    } finally { busy = false; }
  }
  return { run, status };
}
