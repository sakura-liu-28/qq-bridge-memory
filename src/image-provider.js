import fs from 'node:fs/promises';
import path from 'node:path';
import { SENSITIVE_RE } from './sensitive.js';
import { safeFetchBuffer, looksLikeImageBuffer } from './safe-fetch.js';
import { getFreeModelPool, FreeQuotaExhausted, isFreeQuotaFailure } from './free-model-pool.js';
import { generateVolcengineImageOnce, DEFAULT_IMAGE_MODEL, ImageRequestError } from './volcengine-image.js';

class ImageProviderError extends Error {}
const FIXED_ENDPOINTS = {
  zhipu: 'https://open.bigmodel.cn/api/paas/v4/images/generations',
  siliconflow: 'https://api.siliconflow.cn/v1/images/generations'
};
export function bailianEndpoint(base, suffix) {
  if (!/^https:\/\/ws-[a-z0-9-]+\.cn-beijing\.maas\.aliyuncs\.com\/(?:api\/v1|compatible-mode\/v1)$/.test(String(base))) throw new ImageProviderError('百炼北京业务空间地址无效');
  return `${base}/${suffix}`;
}
async function readJson(response, maxBytes = 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > maxBytes) throw new ImageProviderError('生图响应过大');
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ImageProviderError('生图服务返回无效数据'); }
}

export async function generateImage({ prompt, settings, useReference = false, secrets = [], fetchImpl = fetch, downloadImpl = safeFetchBuffer }) {
  try {
    if (settings?.enabled !== true) throw new ImageProviderError('图片生成尚未启用');
    const input = String(prompt ?? '').trim();
    if (!input) throw new ImageProviderError('请提供图片描述');
    if (SENSITIVE_RE.test(input) || secrets.some(s => s && input.includes(s))) throw new ImageProviderError('图片描述含内部信息，已阻止生成');
    // A fixed character reference is an administrator policy, not an optional
    // model argument. Older MCP clients may explicitly send false.
    useReference = settings.fixedReference === true || useReference === true;
    const provider = settings.provider || 'volcengine';
    const configuredQueue = settings.queue ?? [{ provider, model: settings.model || DEFAULT_IMAGE_MODEL, capability: 'image', enabled: true, freeEligible: true }];
    // Never fall back to text-only generation and silently lose the identity.
    const queue = useReference ? configuredQueue.filter(entry => entry?.provider === 'volcengine') : configuredQueue;
    if (useReference && !queue.some(entry => entry?.enabled === true && entry?.freeEligible === true && entry?.capability === 'image')) {
      throw new ImageProviderError('当前没有可用的角色参考图模型，已停止生成；请联系管理员检查配置与额度');
    }
    return await getFreeModelPool(`image:${settings.apiKeyPath || provider}`, settings.quotaStatePath).run('image', queue, async entry => {
      const credential = entry.connectionId ? settings.connections?.[entry.connectionId] : settings.providers?.[entry.provider] ?? (entry.provider === provider ? settings : null);
      if (!credential) throw new ImageProviderError('生图供应商密钥尚未配置');
      if (entry.provider === 'volcengine') return generateVolcengineImageOnce({ prompt: input, settings: { ...settings, ...credential, model: entry.model, enabled: true }, useReference, secrets, fetchImpl, freeQuotaReserved: Boolean(entry.requestBudget) });
      if (useReference) throw new ImageProviderError('当前免费图片模型尚未接入角色参考图，请先生成普通图片');
      let endpoint, payload;
      if (entry.provider === 'zhipu' && entry.model === 'cogview-3-flash') {
        endpoint = FIXED_ENDPOINTS.zhipu;
        payload = { model: entry.model, prompt: input, size: '1024x1024', quality: 'standard', watermark_enabled: true };
      } else if (entry.provider === 'siliconflow' && entry.model === 'Kwai-Kolors/Kolors') {
        endpoint = FIXED_ENDPOINTS.siliconflow;
        payload = { model: entry.model, prompt: input, image_size: '1024x1024', batch_size: 1 };
      } else if (entry.provider === 'bailian' && /^qwen-image-2\.0(?:-pro)?(?:-\d{4}-\d{2}-\d{2})?$/.test(entry.model)) {
        if (credential.freeOnlyConfirmed !== true) throw new ImageProviderError('请先开启百炼目标模型的免费额度用完即停');
        endpoint = credential.endpoint || bailianEndpoint(credential.apiBase, 'services/aigc/multimodal-generation/generation');
        payload = { model: entry.model, input: { messages: [{ role: 'user', content: [{ text: input }] }] }, parameters: { n: 1, size: '2048*2048', prompt_extend: false, watermark: true } };
      } else if (entry.provider === 'openai' && credential.endpoint && /^[a-z0-9][a-z0-9._:/@+-]{0,199}$/i.test(entry.model)) {
        endpoint = credential.endpoint;
        payload = { model: entry.model, prompt: input, n: 1, size: '1024x1024' };
      } else throw new ImageProviderError('该供应商或图片模型未列入已核实免费生图配置');
      if (!path.isAbsolute(credential.apiKeyPath ?? '')) throw new ImageProviderError('生图密钥文件尚未配置');
      const apiKey = (await fs.readFile(credential.apiKeyPath, 'utf8')).trim();
      if (!apiKey || /\s/.test(apiKey) || input.includes(apiKey)) throw new ImageProviderError('生图密钥或图片描述无效');
      console.error(`[image] request provider=${entry.provider} model=${entry.model} chars=${input.length}`);
      const response = await fetchImpl(credential.endpoint || endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(180000),
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${apiKey}` }, body: JSON.stringify(payload) });
      const data = await readJson(response, entry.provider === 'openai' ? 28 * 1024 * 1024 : undefined);
      if (!response.ok) {
        if (isFreeQuotaFailure(response.status, data)) throw new FreeQuotaExhausted();
        throw new ImageProviderError(`生图请求失败（HTTP ${response.status}），请检查平台权限、模型与额度`);
      }
      if (data?.error || data?.code) throw new ImageProviderError('生图服务未生成图片，请检查模型与描述');
      if (entry.provider === 'openai' && typeof data?.data?.[0]?.b64_json === 'string') {
        const encoded = data.data[0].b64_json;
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new ImageProviderError('生图服务返回无效图片');
        const buffer = Buffer.from(encoded, 'base64');
        if (!buffer.length || buffer.length > 20 * 1024 * 1024 || !looksLikeImageBuffer(buffer)) throw new ImageProviderError('生图服务返回无效图片');
        console.error(`[image] generated provider=${entry.provider} model=${entry.model} bytes=${buffer.length}`);
        return { buffer, model: entry.model, provider: entry.provider };
      }
      const url = entry.provider === 'bailian' ? data?.output?.choices?.[0]?.message?.content?.find(item => item?.image)?.image
        : entry.provider === 'siliconflow' ? data?.images?.[0]?.url : data?.data?.[0]?.url;
      if (typeof url !== 'string' || !url.startsWith('https://')) throw new ImageProviderError('生图服务没有返回有效图片地址');
      // Fetch without the provider credential; pin DNS and validate each redirect.
      const result = await downloadImpl(url, 20 * 1024 * 1024);
      if (!result?.buffer || result.buffer.length > 20 * 1024 * 1024 || !looksLikeImageBuffer(result.buffer)) throw new ImageProviderError('生图服务返回无效图片');
      console.error(`[image] generated provider=${entry.provider} model=${entry.model} bytes=${result.buffer.length}`);
      return { buffer: result.buffer, model: entry.model, provider: entry.provider };
    });
  } catch (error) {
    console.error(`[image] provider failed type=${error?.name || 'Error'}`);
    if (error instanceof ImageProviderError || error instanceof ImageRequestError) throw error;
    if (error?.code === 'ENOENT' || error?.code === 'EACCES') throw new ImageProviderError('生图密钥文件无法读取');
    if (['TimeoutError', 'AbortError'].includes(error?.name)) throw new ImageProviderError('图片生成超时，请稍后再试');
    throw new ImageProviderError('图片生成失败或免费队列已不可用，请检查平台配置与额度');
  }
}
