import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { generateImage } from '../src/image-provider.js';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'image-provider-'));
const apiKeyPath=path.join(dir,'key');await fs.writeFile(apiKeyPath,'fixture-only-key');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=','base64');
const response=(data,status=200)=>new Response(JSON.stringify(data),{status});
const entry=(provider,model,extra={})=>({provider,model,capability:'image',enabled:true,freeEligible:true,...extra});
const providers={zhipu:{apiKeyPath},siliconflow:{apiKeyPath},bailian:{apiKeyPath,apiBase:'https://ws-fixture.cn-beijing.maas.aliyuncs.com/api/v1',freeOnlyConfirmed:true},volcengine:{apiKeyPath}};
const downloadImpl=async url=>{assert.equal(url,'https://public.invalid/image.png');return {buffer:png};};
try {
 for(const [provider,model] of [['zhipu','cogview-3-flash'],['siliconflow','Kwai-Kolors/Kolors'],['bailian','qwen-image-2.0']]) {
  const settings={enabled:true,provider,providers,queue:[entry(provider,model)]};
  const result=await generateImage({prompt:'一只猫',settings,downloadImpl,fetchImpl:async(url,init)=>{
   assert.equal(init.headers.Authorization,'Bearer fixture-only-key');const body=JSON.parse(init.body);assert.equal(body.model,model);
   if(provider==='zhipu'){assert.equal(body.watermark_enabled,true);return response({data:[{url:'https://public.invalid/image.png'}]});}
   if(provider==='siliconflow'){assert.equal(body.batch_size,1);return response({images:[{url:'https://public.invalid/image.png'}]});}
   assert.equal(body.parameters.n,1);assert.equal(body.parameters.watermark,true);return response({output:{choices:[{message:{content:[{image:'https://public.invalid/image.png'}]}}]}});
  }});
  assert.deepEqual(result.buffer,png);
 }
 const quotaStatePath=path.join(dir,'quota.json');
 const settings={enabled:true,providers,quotaStatePath,queue:[entry('volcengine','doubao-seedream-4-0-20260415',{requestBudget:{maxRequests:1}}),entry('zhipu','cogview-3-flash')]};
 const seen=[];
 const fetchImpl=async(url,init)=>{seen.push(JSON.parse(init.body).model);return url.includes('volces.com')?response({data:[{b64_json:png.toString('base64')}]}):response({data:[{url:'https://public.invalid/image.png'}]});};
 await generateImage({prompt:'猫',settings,fetchImpl,downloadImpl});
 await generateImage({prompt:'猫',settings,fetchImpl,downloadImpl});
 assert.deepEqual(seen,['doubao-seedream-4-0-20260415','cogview-3-flash']);
 const stored=JSON.parse(await fs.readFile(quotaStatePath,'utf8'));assert.equal(stored.requestCounts['volcengine/doubao-seedream-4-0-20260415'],1);
 assert.equal(stored.exhausted['volcengine/doubao-seedream-4-0-20260415'].reason,'local-request-budget');
 await assert.rejects(generateImage({prompt:'猫',settings:{enabled:true,provider:'zhipu',providers,queue:[entry('zhipu','paid-model')]},fetchImpl:()=>assert.fail('不得调用付费型号')}));
 const referenceImagePath=path.join(dir,'qqbridge.png');await fs.writeFile(referenceImagePath,png);
 const fixedSettings={...settings,fixedReference:true,referenceImagePath,quotaStatePath:path.join(dir,'fixed-quota.json'),queue:[entry('zhipu','cogview-3-flash'),entry('volcengine','doubao-seedream-4-0-20260415',{requestBudget:{maxRequests:1}})]};
 const fixedResult=await generateImage({prompt:'穿浅色毛衣，轻轻挑眉，抿嘴笑',settings:fixedSettings,useReference:false,fetchImpl:async(url,init)=>{
  assert.ok(url.includes('volces.com'),'固定参考必须跳过不支持参考的模型');
  const body=JSON.parse(init.body);assert.equal(body.image,`data:image/png;base64,${png.toString('base64')}`);
  assert.ok(body.prompt.includes('同一张脸'));assert.ok(body.prompt.includes('穿浅色毛衣'));
  return response({data:[{b64_json:png.toString('base64')}]});
 }});assert.deepEqual(fixedResult.buffer,png);
 await assert.rejects(generateImage({prompt:'再换一件衣服',settings:fixedSettings,fetchImpl:()=>assert.fail('额度耗尽不能降级到纯文生图')}));
 await assert.rejects(generateImage({prompt:'自拍',settings:{...fixedSettings,queue:[entry('zhipu','cogview-3-flash')]},fetchImpl:()=>assert.fail('无参考图模型不能发请求')}),/角色参考图模型/);
 await assert.rejects(generateImage({prompt:'自拍',settings:{...fixedSettings,quotaStatePath:path.join(dir,'missing-quota.json'),referenceImagePath:path.join(dir,'missing.png')},fetchImpl:()=>assert.fail('参考图丢失不能无图生成')}),/参考图无法读取/);
 console.log('PASS 固定参考强制同脸、保留换装描述、不支持参考及额度耗尽不降级、丢图明确报错');
 console.log('PASS 三家图片协议、凭据隔离、固定单图、持久化次数到限切换且不再调用原模型');
} finally {await fs.rm(dir,{recursive:true,force:true});}
