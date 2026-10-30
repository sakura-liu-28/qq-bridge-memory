import fs from 'node:fs/promises';
import path from 'node:path';
import { SENSITIVE_RE } from './sensitive.js';
import { looksLikeImageBuffer } from './safe-fetch.js';
import { getFreeModelPool, FreeQuotaExhausted, isFreeQuotaFailure } from './free-model-pool.js';
import { bailianEndpoint } from './image-provider.js';

const PROVIDERS = {
  zhipu: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
  volcengine: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
  siliconflow: 'https://api.siliconflow.cn/v1/chat/completions'
};
const FREE_ZHIPU_MODELS = new Set(['glm-4.6v-flash', 'glm-4.1v-thinking-flash', 'glm-4v-flash']);
class VisionError extends Error {}

export function parseVisionCommand(text) {
  const match = /^\/识图(?:\s+([\s\S]*))?$/.exec(String(text ?? '').trim());
  return match ? { question: (match[1] ?? '').trim() || '请描述这张图片，并按需要识别其中的文字。' } : null;
}

async function readJson(response) {
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new VisionError('识图服务返回数据过大');
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new VisionError('识图服务返回无效数据'); }
}

export async function describeImages({ images, question, settings, secrets = [], fetchImpl = fetch }) {
  const started = Date.now();
  try {
    if (settings?.enabled !== true) throw new VisionError('图片识别尚未启用');
    const input = String(question || '请描述这张图片，并按需要识别其中的文字。').trim();
    if (input.length > 4000) throw new VisionError('识图问题过长，请精简后再试');
    if (SENSITIVE_RE.test(input) || secrets.some(s => s && input.includes(s))) throw new VisionError('识图问题含内部信息，已阻止调用');
    const valid = (Array.isArray(images) ? images : []).filter(item => item?.data);
    if (!valid.length) throw new VisionError('没有可识别的图片，请附图或引用本会话中含图片的消息');
    if (valid.length > 4) throw new VisionError('一次最多识别 4 张图片');
    let bytes = 0;
    const content = [{ type: 'text', text: input }];
    for (const image of valid) {
      if (!/^image\/(png|jpeg|webp|gif)$/.test(image.mimeType) || typeof image.data !== 'string'
          || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.data)) throw new VisionError('识图图片格式无效');
      const buffer = Buffer.from(image.data, 'base64');
      bytes += buffer.length;
      if (bytes > 10 * 1024 * 1024 || !looksLikeImageBuffer(buffer)) throw new VisionError('识图图片无效或总大小超过 10MB');
      // Transport URLs, local paths and the original metadata never reach the model.
      content.push({ type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.data}` } });
    }
    const provider = settings.provider || 'zhipu';
    const queue = settings.queue ?? [{ provider, model: settings.model || 'glm-4.6v-flash', capability: 'vision', enabled: true, freeEligible: true }];
    return await getFreeModelPool(settings.apiKeyPath || 'vision', settings.quotaStatePath).run('vision', queue, async entry => {
      const credential = entry.connectionId ? settings.connections?.[entry.connectionId] : settings.providers?.[entry.provider] ?? (entry.provider === provider ? settings : null);
      if (!credential || !path.isAbsolute(credential.apiKeyPath ?? '')) throw new VisionError('识图密钥尚未配置，请联系管理员');
      const endpoint = credential.endpoint || (entry.provider === 'bailian' ? bailianEndpoint(credential.baseURL, 'chat/completions') : PROVIDERS[entry.provider]);
      if (!endpoint) throw new VisionError('识图供应商尚未接入');
      if (entry.provider === 'zhipu' && !FREE_ZHIPU_MODELS.has(entry.model)) throw new VisionError('该智谱模型未列入已核实免费识图清单');
      if (entry.provider === 'siliconflow' && entry.model !== 'Qwen/Qwen3.5-4B') throw new VisionError('该硅基模型未列入已核实免费识图清单');
      if (['volcengine', 'bailian'].includes(entry.provider) && credential.freeOnlyConfirmed !== true) throw new VisionError('请先确认识图模型已开启免费额度用完即停');
      if (!/^[a-z0-9][a-z0-9._:/@+-]{0,199}$/i.test(entry.model)) throw new VisionError('识图模型配置无效');
      const apiKey = (await fs.readFile(credential.apiKeyPath, 'utf8')).trim();
      if (!apiKey || /\s/.test(apiKey)) throw new VisionError('识图密钥无效，请联系管理员');
      if (input.includes(apiKey)) throw new VisionError('识图问题含凭据，已阻止调用');
      console.error(`[vision] request provider=${entry.provider} model=${entry.model} images=${valid.length} bytes=${bytes} chars=${input.length}`);
      const response = await fetchImpl(endpoint, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120000),
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: entry.model, messages: [{ role: 'user', content }], stream: false, max_tokens: entry.model === 'glm-4v-flash' ? 1024 : 2048,
          ...(entry.provider === 'zhipu' && entry.model === 'glm-4.6v-flash' ? { thinking: { type: 'disabled' } } : {}),
          ...(['bailian', 'siliconflow'].includes(entry.provider) ? { enable_thinking: false } : {}) })
      });
      const data = await readJson(response);
      if (!response.ok) {
        if (isFreeQuotaFailure(response.status, data)) throw new FreeQuotaExhausted();
        throw new VisionError(`图片识别失败（HTTP ${response.status}），请检查密钥、模型开通状态或平台额度`);
      }
      const answer = data?.choices?.[0]?.message?.content;
      if (data?.error || typeof answer !== 'string' || !answer.trim()) throw new VisionError('识图服务未返回有效文字，请稍后再试');
      if (SENSITIVE_RE.test(answer) || [apiKey, ...secrets].some(s => s && answer.includes(s))) throw new VisionError('识图结果含内部信息，已阻止返回');
      console.error(`[vision] success provider=${entry.provider} model=${entry.model} chars=${answer.length} elapsedMs=${Date.now() - started}`);
      return { text: answer.trim(), model: entry.model, provider: entry.provider };
    });
  } catch (error) {
    console.error(`[vision] failed type=${error?.name || 'Error'} elapsedMs=${Date.now() - started}`);
    if (error instanceof VisionError) throw error;
    if (error?.code === 'ENOENT' || error?.code === 'EACCES') throw new VisionError('识图密钥无法读取，请联系管理员');
    if (['TimeoutError', 'AbortError'].includes(error?.name)) throw new VisionError('图片识别超时，请稍后再试');
    throw new VisionError('图片识别失败或免费队列已不可用，请检查配置与额度');
  }
}
