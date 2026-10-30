import fs from 'node:fs/promises';
import path from 'node:path';
import { SENSITIVE_RE } from './sensitive.js';
import { looksLikeImageBuffer } from './safe-fetch.js';
import { getFreeModelPool, FreeQuotaExhausted, isFreeQuotaFailure } from './free-model-pool.js';

export const DEFAULT_IMAGE_MODEL = 'doubao-seedream-4-0-20260415';
const ENDPOINT = 'https://ark.cn-beijing.volces.com/api/v3/images/generations';
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export class ImageRequestError extends Error {}

// Explicit commands bypass DSH entirely; ordinary conversation keeps its model.
export function parseImageCommand(text) {
  const match = /^\/生图(?:\s+([\s\S]*))?$/.exec(String(text ?? '').trim());
  return match ? { prompt: (match[1] ?? '').trim() } : null;
}

async function readResponse(response) {
  if (!response.body) throw new ImageRequestError('生图服务返回空响应');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > MAX_IMAGE_BYTES * 1.4 + 1048576) throw new ImageRequestError('生图服务返回的图片过大');
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ImageRequestError('生图服务返回无效数据'); }
}

/** Only administrator settings select credentials, model and reference files. */
async function generateImageOnce({ prompt, settings, useReference = false, secrets = [], fetchImpl = fetch, freeQuotaReserved = false }) {
  const started = Date.now();
  try {
    if (settings?.enabled !== true) throw new ImageRequestError('图片生成尚未启用');
    useReference = settings.fixedReference === true || useReference === true;
    if (settings.freeOnlyConfirmed !== true && !freeQuotaReserved) throw new ImageRequestError('请先配置持久化免费次数上限，或确认方舟免费额度用完即停');
    const input = String(prompt ?? '').trim();
    if (!input) throw new ImageRequestError('请提供图片描述，例如：/生图 一只晒太阳的橘猫');
    if (SENSITIVE_RE.test(input) || secrets.some((s) => s && input.includes(s))) throw new ImageRequestError('图片描述含内部信息或凭据，已阻止生成');
    if (!path.isAbsolute(settings.apiKeyPath ?? '')) throw new ImageRequestError('方舟生图密钥尚未配置，请联系管理员');
    const apiKey = (await fs.readFile(settings.apiKeyPath, 'utf8')).trim();
    if (!apiKey || /\s/.test(apiKey)) throw new ImageRequestError('方舟生图密钥无效，请联系管理员');
    if (input.includes(apiKey)) throw new ImageRequestError('图片描述含凭据，已阻止生成');
    const model = settings.model || DEFAULT_IMAGE_MODEL;
    if (!/^doubao-seedream-[a-z0-9-]+$/.test(model) && !/^ep-[a-z0-9-]+$/.test(model)) throw new ImageRequestError('生图模型配置无效');
    const payload = { model, prompt: input, size: settings.size || '2K', response_format: 'b64_json', watermark: true, stream: false };
    // Lite supports grouped output; explicitly request one image per invocation.
    if (!/-5-0-(?:pro|flash)-/.test(model)) payload.sequential_image_generation = 'disabled';
    if (useReference) {
      if (!path.isAbsolute(settings.referenceImagePath ?? '')) throw new ImageRequestError('尚未配置角色参考图，可以先生成普通图片');
      const stat = await fs.stat(settings.referenceImagePath);
      if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) throw new ImageRequestError('角色参考图无效或过大');
      const reference = await fs.readFile(settings.referenceImagePath);
      if (!looksLikeImageBuffer(reference)) throw new ImageRequestError('角色参考图不是有效图片');
      const mime = reference[0] === 0x89 ? 'image/png' : reference[0] === 0xff ? 'image/jpeg' : reference.toString('ascii', 0, 3) === 'GIF' ? 'image/gif' : 'image/webp';
      payload.image = `data:${mime};base64,${reference.toString('base64')}`;
      payload.prompt = `本次画面要求：${input}\n\n人物身份参考：参考图仅用于确认是同一位成年女性、同一张脸，脸部保持自然可辨的相似度即可，不要求逐像素复刻。保留脸型骨相、五官的相对位置与辨识特征，以及自然真实的皮肤质感。表情不是身份锁定项：允许眉毛高低、眼睑开合、嘴角方向、嘴部开合和面颊肌肉随本次表情要求自然变化。本次指定表情优先于参考图表情，不要仅换衣服而复制原图的眉眼与微笑；表情变化应在画面上清楚可辨，同时自然可信。只在本次明确要求保留原表情时才沿用原表情。动作、身体姿势、手势、头部朝向、视线、穿搭、发型、场景、镜头角度和构图都可按本次要求自由变化；不要默认沿用参考图的站坐姿势、歪头角度、窗边背景或半身构图。未指定时可以结合当下情境自然选择这些变化，保持人物脸部辨识特征即可。`;
    }
    console.error(`[image] request model=${model} chars=${input.length} reference=${useReference}`);
    const response = await fetchImpl(settings.endpoint || ENDPOINT, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(180000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      const detail = await readResponse(response).catch(() => null);
      if (isFreeQuotaFailure(response.status, detail)) throw new FreeQuotaExhausted();
      if ([402, 403, 429].includes(response.status)) throw new ImageRequestError('生图服务额度、权限或调用频率受限，请检查方舟开通管理');
      if (response.status === 401) throw new ImageRequestError('方舟生图密钥鉴权失败，请联系管理员');
      throw new ImageRequestError(`生图服务请求失败（HTTP ${response.status}），请稍后再试`);
    }
    const data = await readResponse(response);
    if (data?.error || data?.data?.[0]?.error) throw new ImageRequestError('生图服务未生成图片，请检查描述、模型开通状态与可用额度');
    const encoded = data?.data?.[0]?.b64_json;
    if (typeof encoded !== 'string' || !encoded || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new ImageRequestError('生图服务未返回有效图片');
    const buffer = Buffer.from(encoded, 'base64');
    if (buffer.length > MAX_IMAGE_BYTES || !looksLikeImageBuffer(buffer)) throw new ImageRequestError('生图服务返回的图片无效或过大');
    console.error(`[image] generated model=${model} bytes=${buffer.length} elapsedMs=${Date.now() - started}`);
    return { buffer, model };
  } catch (error) {
    // Provider/subprocess errors may contain keys, paths or the original prompt.
    const known = error?.code && /^[A-Z_0-9-]+$/i.test(String(error.code)) ? String(error.code) : error?.name || 'Error';
    console.error(`[image] failed type=${known} elapsedMs=${Date.now() - started}`);
    if (error?.code === 'ENOENT' || error?.code === 'EACCES') throw new ImageRequestError('生图密钥或参考图无法读取，请联系管理员');
    if (['TimeoutError', 'AbortError'].includes(error?.name)) throw new ImageRequestError('图片生成超时，请稍后再试');
    // Only our own user-facing messages may cross the tool boundary.
    if (error instanceof ImageRequestError || error instanceof FreeQuotaExhausted) throw error;
    throw new ImageRequestError('图片生成失败，请稍后再试');
  }
}

export async function generateVolcengineImage(options) {
  const settings = options.settings;
  if (settings?.enabled !== true) throw new ImageRequestError('图片生成尚未启用');
  const poolKey = settings.apiKeyPath || 'unconfigured';
  const queue = Array.isArray(settings.queue) ? settings.queue : [
    { provider: 'volcengine', model: settings.model || DEFAULT_IMAGE_MODEL, capability: 'image', enabled: true, freeEligible: true, ...(settings.requestBudget ? { requestBudget: settings.requestBudget } : {}) }
  ];
  return getFreeModelPool(poolKey, settings.quotaStatePath).run('image', queue, entry => {
    if (entry.provider !== 'volcengine') throw new ImageRequestError('该生图供应商尚未接入，请勿混用模型名称');
    return generateImageOnce({ ...options, settings: { ...settings, model: entry.model }, freeQuotaReserved: Boolean(entry.requestBudget) });
  });
}

export { generateImageOnce as generateVolcengineImageOnce };
