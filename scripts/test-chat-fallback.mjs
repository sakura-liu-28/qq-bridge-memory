import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { confirmedChatQuotaFailure, nextFreeChatModel } from '../src/chat-fallback.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';
assert.equal(confirmedChatQuotaFailure('AllocationQuota.FreeTierOnly','bailian'),true);
assert.equal(confirmedChatQuotaFailure('insufficient balance','baishan'),true);
for(const text of ['429 Too many requests','QuotaExceeded task queue full','network timeout','invalid key']) assert.equal(confirmedChatQuotaFailure(text,'zhipu'),false);
const queue=[{provider:'baishan',route:'baishan',model:'original',capability:'chat',enabled:true,freeEligible:false}, ...['one','two'].map(model=>({provider:'zhipu',route:'qq-zhipu',model,capability:'chat',enabled:true,freeEligible:true}))];
assert.equal(nextFreeChatModel(queue,{}, {provider:'baishan',model:'original'}).model,'one');
assert.equal(nextFreeChatModel(queue,{'zhipu/one':{}}, {provider:'qq-zhipu',model:'one'}).model,'two');
assert.equal(nextFreeChatModel(queue,{}, {provider:'manual-other',model:'override'}),null);
const h=await bridgeHarness({config:{dsh:{authToken:'fixture-only',provider:'baishan',model:'original'},modelRouting:{chat:{enabled:true,queue}}}});
try {
 h.setMode('reserved2');h.cfg.modelRouting.chat.quotaStatePath=path.join(h.temp,'state/free-quota.json');
 h.rememberModel('fixture-session',{provider:'baishan',model:'original'});
 assert.equal(await h.switchExhaustedChatModel('private:123','fixture-session','Too many requests'),false);
 assert.equal(h.cfg.dsh.model,'original');
 await h.switchExhaustedChatModel('private:123','fixture-session','InsufficientBalance',{safeToRetry:false});
 assert.equal(h.cfg.dsh.model,'one');assert.equal(h.cfg.dsh.provider,'qq-zhipu');
 const saved=JSON.parse(fs.readFileSync(path.join(h.temp,'config.json'),'utf8'));assert.equal(saved.dsh.model,'one');
 assert.equal(h.calls.prompts.length,0,'有过动作的失败回合不得自动重放');
 h.cfg.socialV2.imageGeneration={model:'image-unchanged'};h.cfg.socialV2.vision={model:'vision-unchanged'};
 h.rememberModel('second',{provider:'qq-zhipu',model:'one'});
 await h.switchExhaustedChatModel('private:123','second','QuotaExceeded: exhausted its free trial quota',{safeToRetry:false});
 assert.equal(h.cfg.dsh.model,'two');assert.equal(h.cfg.socialV2.imageGeneration.model,'image-unchanged');assert.equal(h.cfg.socialV2.vision.model,'vision-unchanged');
 console.log('PASS 聊天额度明确耗尽才切换、持久化选择、手动选择保护、用途隔离与不重放已行动回合');
} finally {await h.close();}
