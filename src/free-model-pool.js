import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Quota exhaustion is different from rate limits, content rejection and network
// failures. Only an explicit free-quota failure may advance the model queue.
export class FreeQuotaExhausted extends Error {
  constructor() { super('当前模型免费额度已耗尽'); this.code = 'FREE_QUOTA_EXHAUSTED'; }
}

export function isFreeQuotaFailure(status, payload) {
  const error = payload?.error ?? payload;
  if (status === 403 && error?.code === 'AllocationQuota.FreeTierOnly') return true;
  return [403, 429].includes(status) && error?.code === 'QuotaExceeded'
    && /(?:exhausted.{0,30}free (?:trial )?quota|free (?:trial )?quota.{0,30}exhausted|免费.{0,12}额度.{0,12}(?:耗尽|用完|消耗完毕))/i.test(String(error?.message ?? ''));
}

const pools = new Map();
// A shared state file preserves exhausted models across features and restarts.
// Administrators select this path; the model cannot choose files to read/write.
export function getFreeModelPool(scope, statePath = '') {
  if (statePath && !path.isAbsolute(statePath)) throw new Error('免费额度状态文件必须为绝对路径');
  const id = statePath || scope;
  if (!pools.has(id)) {
    let state = { exhausted: {} };
    if (statePath) {
      try {
        state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        if (!state || typeof state !== 'object' || !state.exhausted || typeof state.exhausted !== 'object' || Array.isArray(state.exhausted)) throw new Error('invalid state');
      } catch (error) {
        if (error.code !== 'ENOENT') throw new Error('免费额度状态文件无法读取，请检查后再启用');
      }
    }
    pools.set(id, createFreeModelPool({ state, persistent: Boolean(statePath), persist: next => {
      if (!statePath) return;
      const temp = `${statePath}.${crypto.randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temp, JSON.stringify(next), { mode: 0o600, flag: 'wx' });
        fs.renameSync(temp, statePath);
      } finally { try { fs.unlinkSync(temp); } catch {} }
    } }));
  }
  return pools.get(id);
}

export function createFreeModelPool({ state = { exhausted: {} }, persist = () => {}, persistent = false } = {}) {
  state.exhausted ??= {};
  state.requestCounts ??= {};
  if (typeof state.requestCounts !== 'object' || Array.isArray(state.requestCounts)) throw new Error('免费额度调用计数损坏，已停止调用');
  const markExhausted = async (entry, reason = 'free-quota-exhausted') => {
    state.exhausted[`${entry.connectionId ? entry.connectionId + ':' : ''}${entry.provider}/${entry.model}`] = { at: new Date().toISOString(), reason };
    await persist(state);
  };
  return {
    state,
    markExhausted,
    async run(capability, entries, attempt) {
      const queue = (Array.isArray(entries) ? entries : []).filter(entry =>
        entry?.capability === capability && entry.enabled === true && entry.freeEligible === true
        && typeof entry.model === 'string' && entry.model && typeof entry.provider === 'string' && entry.provider);
      const visited = new Set();
      for (const entry of queue) {
        // The same provider/model shares its quota even in different feature queues.
        const id = `${entry.connectionId ? entry.connectionId + ':' : ''}${entry.provider}/${entry.model}`;
        if (visited.has(id) || state.exhausted[id]) continue;
        visited.add(id);
        const used = state.requestCounts[id] ?? 0;
        if (!Number.isSafeInteger(used) || used < 0) throw new Error('免费额度调用计数无效，已停止调用');
        if (entry.requestBudget) {
          const limit = entry.requestBudget.maxRequests;
          if (capability !== 'image' || !persistent || !Number.isSafeInteger(limit) || limit < 1) throw new Error('图片次数上限必须配置正整数并启用持久化记账');
          if (used >= limit) {
            state.exhausted[id] = { at: new Date().toISOString(), reason: 'local-request-budget' };
            await persist(state);
            console.error(`[model-pool] local budget exhausted model=${entry.model} used=${used} limit=${limit}`);
            continue;
          }
        }
        // Reserve and persist BEFORE making the request. Concurrent callers cannot
        // overrun the cap; a timeout or process crash still consumes one reservation.
        state.requestCounts[id] = used + 1;
        await persist(state);
        try {
          const result = await attempt(entry);
          return result;
        } catch (error) {
          if (!(error instanceof FreeQuotaExhausted)) throw error;
          state.exhausted[id] = { at: new Date().toISOString(), reason: 'free-quota-exhausted' };
          await persist(state);
          console.error(`[model-pool] exhausted capability=${capability} model=${entry.model}`);
        }
      }
      throw new Error('该功能的免费模型额度已用完或暂无可用模型，已停止调用，不会自动转为付费');
    }
  };
}
