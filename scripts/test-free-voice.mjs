import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { synthesizeFreeSpeech } from '../src/bailian-tts.js';
import { synthesizeVolcengine, isVoiceQuotaFailure } from '../src/volcengine-tts.js';
import { FreeQuotaExhausted } from '../src/free-model-pool.js';
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'free-voice-'));
const key = path.join(dir, 'key'); await fs.writeFile(key, 'fixture-credential');
const entry = { provider: 'bailian', model: 'qwen3-tts-flash', capability: 'tts', enabled: true, freeEligible: true };
const settings = { enabled: true, freeOnlyConfirmed: true, apiKeyPath: key, queue: [entry], quotaStatePath: path.join(dir,'ledger.json') };
const wav = Buffer.alloc(48); wav.write('RIFF'); wav.write('WAVE',8);
let requests=0;
try {
 const audio = await synthesizeFreeSpeech({text:'你好',settings,maxBytes:1024,fetchImpl:async(url,opts)=>{
   requests++;assert.equal(url,'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation');assert.equal(JSON.parse(opts.body).input.voice,'Cherry');
   return Response.json({output:{audio:{url:'http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/test.wav?signature=x'}}});
 },downloadImpl:async url=>{assert.ok(url.startsWith('https://'));return {buffer:wav};}});
 assert.deepEqual(audio,wav);
 await assert.rejects(synthesizeFreeSpeech({text:'你好',settings,maxBytes:1024,fetchImpl:async()=>Response.json({code:'AllocationQuota.FreeTierOnly'},{status:403})}),/停止调用/);
 await assert.rejects(synthesizeFreeSpeech({text:'你好',settings,maxBytes:1024,fetchImpl:()=>assert.fail('exhausted must persist')}),/停止调用/);
 assert.ok(JSON.parse(await fs.readFile(settings.quotaStatePath,'utf8')).exhausted['bailian/qwen3-tts-flash']);
 await assert.rejects(synthesizeFreeSpeech({text:'你好',settings:{...settings,freeOnlyConfirmed:false},maxBytes:1024,fetchImpl:()=>assert.fail()}),/保护/);
 assert.equal(requests,1);
 assert.ok(isVoiceQuotaFailure('quota exceeded for types: speech_lifetime'));
 assert.equal(isVoiceQuotaFailure('quota exceeded for types: concurrency'),false);
 const base={text:'你好',tts:{apiKeyPath:key},maxBytes:1024};
 await assert.rejects(synthesizeVolcengine({...base,fetchImpl:async()=>new Response('data: '+JSON.stringify({code:45000030,message:'quota exceeded for types: speech_lifetime'})+'\n')}),FreeQuotaExhausted);
 await assert.rejects(synthesizeVolcengine({...base,fetchImpl:async()=>new Response('data: '+JSON.stringify({code:0,data:Buffer.from('partial').toString('base64')})+'\ndata: '+JSON.stringify({code:45000030,message:'quota exceeded for types: speech_lifetime'})+'\n')}),e=>!(e instanceof FreeQuotaExhausted));
 console.log('PASS 免费语音保护、WAV格式、持久化停用、桃子仅明确额度耗尽且无音频时切换');
} finally {await fs.rm(dir,{recursive:true,force:true});}
