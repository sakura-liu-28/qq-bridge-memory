import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';
const sends=[];
let gatewayResult='success';
const h=await bridgeHarness({config:{ownerQQ:987654321,allow:{private:['123','124','125','987654321'],groups:['456']},socialV2:{tools:{deleteFriend:true},friendship:{enabled:true,roleName:'示例伙伴'}}},files:{'state/current-role.json':{role:'示例伙伴',mode:'active'},'roles/示例伙伴.md':'# 示例伙伴\n朋友与恋人有明确边界'},globals:{fetch:async(url,init)=>{
  assert.ok(String(url).endsWith('/delete_friend'));
  sends.push(JSON.parse(init.body));
  if(gatewayResult==='timeout')throw new Error('fixture timeout');
  return {ok:true,json:async()=>({status:'ok',retcode:0})};
}}});
let server;
try{
 h.setMode('reserved2');
 const tokens=Object.fromEntries(['private:123','private:124','private:125','private:987654321','group:456'].map(key=>[key,h.getSocialV2State(key).agentToken]));
 server=h.startConsoleServer();if(!server.listening)await new Promise(r=>server.once('listening',r));
 const call=async(key,token=tokens[key],extra={})=>{const r=await fetch(`http://127.0.0.1:${server.address().port}/api/socialV2/delete-friend`,{method:'POST',headers:{'content-type':'application/json','x-console-token':'fixture-console-token','x-agent-call':'1',...(token?{'x-agent-token':token}:{})},body:JSON.stringify({key,reason:'对方反复冒犯，让我生气了',...extra})});return {status:r.status,body:await r.json()};};
 for(const [key,token]of[['private:987654321',tokens['private:987654321']],['group:456',tokens['group:456']],['private:123',null],['private:123','wrong'],['private:123',tokens['private:124']]])assert.equal((await call(key,token)).status,403);
 assert.equal((await call('private:123',tokens['private:123'],{user_id:987654321})).status,400);
 assert.equal((await call('private:123',tokens['private:123'],{block:true})).status,400);
 h.socialV2.paused=true;assert.equal((await call('private:123')).status,403);h.socialV2.paused=false;
 h.cfg.socialV2.tools.deleteFriend=false;assert.equal((await call('private:123')).status,403);h.cfg.socialV2.tools.deleteFriend=true;
 h.cfg.socialV2.friendship.enabled=false;assert.equal((await call('private:123')).status,403);h.cfg.socialV2.friendship.enabled=true;
 fs.writeFileSync(path.join(h.temp,'state/current-role.json'),JSON.stringify({role:'示例伙伴',mode:'silent'}));assert.equal((await call('private:123')).status,403);
 fs.writeFileSync(path.join(h.temp,'state/current-role.json'),JSON.stringify({role:'其他角色',mode:'active'}));assert.equal((await call('private:123')).status,403);
 fs.writeFileSync(path.join(h.temp,'state/current-role.json'),JSON.stringify({role:'示例伙伴',mode:'active'}));
 h.cfg.allow.private=['124','125','987654321'];assert.equal((await call('private:123')).status,403);h.cfg.allow.private.push('123');
 assert.equal(sends.length,0,'拒绝场景绝不调用网关');
 const success=await call('private:123');assert.equal(success.body.deleted,true,JSON.stringify(success));assert.deepEqual(sends,[{user_id:123,block:false}]);
 assert.equal((await call('private:123')).body.changed,false);assert.equal(sends.length,1,'成功后不重复删好友');
 gatewayResult='timeout';assert.equal((await call('private:124')).status,500);assert.equal((await call('private:124')).body.ok,false);assert.equal(sends.length,2,'超时后不重放');
 fs.writeFileSync(path.join(h.temp,'state/friend-deletions.json'),'broken');assert.equal((await call('private:125')).status,500);assert.equal(sends.length,2,'持久化损坏时停止删除');
 console.log('PASS 删好友：配置的受保护账号不可删除、会话鉴权、不跨目标、群聊/静默/暂停/撤权拒绝、成功确认、超时与重复保护');
}finally{if(server)await new Promise(r=>server.close(r));await h.close();}
