import assert from 'node:assert/strict';
import { resolveQQFace, formatQQFace } from '../src/qq-faces.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';
assert.equal(resolveQQFace('微笑').id,'14');assert.equal(resolveQQFace('0').name,'惊讶');assert.equal(resolveQQFace('不存在'),null);
assert.ok(formatQQFace('999999').includes('含义未知'));
const h=await bridgeHarness({config:{dsh:{authToken:'fixture-only'},socialV2:{tools:{sendFace:true,describeImage:true},vision:{enabled:true}}},globals:{describeImages:()=>assert.fail('known faces require no vision request')}});
let server;
try {
 h.setMode('reserved2');
 await h.handleIncoming('private','123',{user_id:123,self_id:999,message_id:80,message:[{type:'face',data:{id:14}}]},h.cfg);
 const st=h.getSocialV2State('private:123');assert.ok(st.unread.at(-1).text.includes('微笑'));assert.equal(st.unread.at(-1).visionStatus,'done');
 server=h.startConsoleServer();if(!server.listening)await new Promise(r=>server.once('listening',r));
 const call=async(token,body)=>{const r=await fetch(`http://127.0.0.1:${server.address().port}/api/socialV2/send-face`,{method:'POST',headers:{'content-type':'application/json','x-console-token':'fixture-console-token','x-agent-call':'1',...(token?{'x-agent-token':token}:{})},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
 assert.equal((await call(null,{key:'private:123',face:'微笑'})).status,403);
 assert.equal((await call(st.agentToken,{key:'group:456',face:'微笑'})).status,403);
 assert.equal((await call(st.agentToken,{key:'private:123',face:'999999'})).status,400);
 const sent=await call(st.agentToken,{key:'private:123',face:'微笑'});assert.equal(sent.body.sent,1);
 const outgoing=h.calls.http.find(x=>x.body?.message?.some(m=>m.type==='face'));assert.equal(outgoing.body.message[0].data.id,'14');
 h.cfg.socialV2.tools.sendFace=false;assert.equal((await call(st.agentToken,{key:'private:123',face:'微笑'})).body.ok,false);
 console.log('PASS QQ原生表情字典、无识图开销、真实face段发送、鉴权和开关隔离');
}finally{if(server)await new Promise(r=>server.close(r));await h.close();}
