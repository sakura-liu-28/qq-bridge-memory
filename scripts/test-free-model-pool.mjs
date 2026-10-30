import assert from 'node:assert/strict';
import { createFreeModelPool, FreeQuotaExhausted, isFreeQuotaFailure } from '../src/free-model-pool.js';

const entry = (model, capability = 'image', extra = {}) => ({ provider: 'fixture', model, capability, enabled: true, freeEligible: true, ...extra });
const pool = createFreeModelPool();
const calls = [];
assert.equal(await pool.run('image', [entry('one'), entry('two'), entry('three')], async e => {
  calls.push(e.model);
  if (e.model === 'one') throw new FreeQuotaExhausted();
  return e.model;
}), 'two');
assert.deepEqual(calls, ['one', 'two']);
assert.equal(await pool.run('image', [entry('one'), entry('two')], async e => e.model), 'two', '用完的模型不会每次重新消耗调用');
await assert.rejects(pool.run('voice', [entry('two')], () => assert.fail('不得跨功能调用')));
await assert.rejects(pool.run('image', [entry('paid', 'image', { freeEligible: false })], () => assert.fail('不得转付费')));
let attempts = 0;
await assert.rejects(pool.run('image', [entry('network'), entry('next')], () => { attempts++; throw new Error('network'); }), /network/);
assert.equal(attempts, 1, '网络错误不应重复生图或自动切换');
assert.equal(isFreeQuotaFailure(429, { error: { code: 'QuotaExceeded', message: 'Your account has exhausted its free trial quota for this model' } }), true);
for (const detail of [
  { code: 'ModelAccountIpmRateLimitExceeded', message: 'Too many requests' },
  { code: 'QuotaExceeded', message: 'The request has exceeded the quota' },
  { code: 'AccessDenied', message: 'free quota exhausted' }
]) assert.equal(isFreeQuotaFailure(429, { error: detail }), false, '限流/排队/鉴权失败不是免费额度耗尽');
const restored = createFreeModelPool({ state: structuredClone(pool.state) });
assert.equal(await restored.run('image', [entry('one'), entry('two')], async e => e.model), 'two');
console.log('PASS 免费模型按序切换、耗尽记账、用途隔离、禁付费、非额度错误不切换');

const bounded = createFreeModelPool({ persistent: true });
const limited = entry('bounded', 'image', { requestBudget: { maxRequests: 2 } });
let liveCalls = 0;
const concurrent = await Promise.allSettled(Array.from({ length: 6 }, () => bounded.run('image', [limited], async () => {
  liveCalls++;
  await new Promise(resolve => setTimeout(resolve, 5));
  return 'image';
})));
assert.equal(liveCalls, 2, '并发不能超过免费本地上限');
assert.equal(concurrent.filter(x => x.status === 'fulfilled').length, 2);
assert.equal(bounded.state.requestCounts['fixture/bounded'], 2);
const noPersistence = createFreeModelPool();
await assert.rejects(noPersistence.run('image', [limited], () => assert.fail('次数限制不得只保存在内存')), /持久化/);
const uncertain = createFreeModelPool({ persistent: true });
await assert.rejects(uncertain.run('image', [limited], () => { throw new Error('timeout'); }), /timeout/);
assert.equal(uncertain.state.requestCounts['fixture/bounded'], 1, '超时未知结果仍占用预留次数');
console.log('PASS 免费次数持久化要求、并发预占、超时不退还，达到上限不再请求');
