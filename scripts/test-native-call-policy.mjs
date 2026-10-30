import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { nativeConfigView,startNativePolicyServer,getNativeConfigViaSocket } from '../src/native-call-policy.js';
const root=fs.mkdtempSync('/tmp/native-policy-');const dir=path.join(root,'.local/qq-av/runtime');fs.mkdirSync(dir,{recursive:true,mode:0o700});fs.writeFileSync(dir+'/control.token','x'.repeat(64));fs.writeFileSync(dir+'/wrong.token','y'.repeat(64));
const config={consoleToken:'secret-console',dsh:{authToken:'secret-dsh'},snowluma:{accessToken:'secret-qq'},allow:{private:['123']},socialV2:{voice:{tts:{apiKey:'secret-tts',apiKeyPath:'/allowed/key-file'},realtime:{enabled:true,native:{enabled:true,allowedCallers:['123'],tokenFile:'/call/runtime/control.token'}}}}};
let server,gate=true;
try{
 const view=nativeConfigView(config);assert.doesNotMatch(JSON.stringify(view),/secret-console|secret-dsh|secret-qq|secret-tts/);assert.equal(view.socialV2.voice.tts.apiKeyPath,'/allowed/key-file');
 server=await startNativePolicyServer({root,getConfig:()=>config,gate:()=>gate,getSessionContext:caller=>({key:'private:'+caller,role:'测试角色',rolePrompt:'本会话专属称呼',memory:'长期记忆背景'}),log:()=>{}});const socket=dir+'/qq-policy.sock';assert.equal(fs.statSync(socket).mode&0o777,0o600);
 assert.equal((await getNativeConfigViaSocket(socket,dir+'/control.token')).socialV2.voice.realtime.native.enabled,true);
 await assert.rejects(getNativeConfigViaSocket(socket,dir+'/wrong.token'),/unavailable/);
 const scoped=await getNativeConfigViaSocket(socket,dir+'/control.token','123');assert.equal(scoped.socialV2.voice.realtime.sessionContext.key,'private:123');assert.match(scoped.socialV2.voice.realtime.sessionContext.memory,/长期记忆/);
 assert.equal((await getNativeConfigViaSocket(socket,dir+'/control.token')).socialV2.voice.realtime.sessionContext,undefined);
 await assert.rejects(getNativeConfigViaSocket(socket,dir+'/control.token','456'),/unavailable/);
 gate=false;await assert.rejects(getNativeConfigViaSocket(socket,dir+'/control.token','123'),/unavailable/);assert.equal((await getNativeConfigViaSocket(socket,dir+'/control.token')).socialV2.voice.realtime.native.enabled,false);
 config.deny={private:['123']};assert.deepEqual((await getNativeConfigViaSocket(socket,dir+'/control.token')).deny.private,['123']);
 await assert.rejects(startNativePolicyServer({root,getConfig:()=>config}),/already running/);assert.ok(server.listening);
 const status=await new Promise((resolve,reject)=>{http.get({socketPath:socket,path:'/other',headers:{authorization:'Bearer '+'x'.repeat(64)}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));}).on('error',reject);});assert.equal(status,404);
}finally{if(server)await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});}
console.log('PASS 私有策略 socket：无公网端口、精确鉴权、配置过滤、热更新与拒绝覆盖活跃服务');
