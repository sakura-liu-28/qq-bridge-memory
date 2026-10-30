import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encode, decode } from 'silk-wasm';
import { recordRefs, encodeAsrPacket, decodeAsrPacket, decodeVoice, downloadQQVoice } from '../src/volcengine-asr.js';
import { gzipSync } from 'node:zlib';
import { bridgeHarness } from './audit-bridge-harness.mjs';
assert.deepEqual(recordRefs([{type:'record',data:{file:'file.silk'}},{type:'record',data:{file:'/etc/passwd'}},{type:'record',data:{file:'https://host/secret'}}]),['file.silk']);
const json=Buffer.from(JSON.stringify({result:{text:'你好'}}));const payload=gzipSync(json),len=Buffer.alloc(4);len.writeUInt32BE(payload.length);const result=decodeAsrPacket(Buffer.concat([Buffer.from([0x11,0x92,0x11,0]),len,payload]));assert.equal(result.last,true);assert.equal(result.value.result.text,'你好');assert.throws(()=>decodeAsrPacket(Buffer.alloc(3)));
assert.equal(encodeAsrPacket(2,Buffer.alloc(6400),true)[1],0x22);
const silk=await encode(Buffer.alloc(16000*2),16000);const pcm=await decodeVoice(silk.data);assert.ok(pcm.length>=30000);await assert.rejects(decodeVoice(silk.data,{maxSeconds:.1}),/太长/);
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'qq-asr-'));try{fs.mkdirSync(path.join(temp,'cache'));fs.writeFileSync(path.join(temp,'secret'),Buffer.from('secret'));fs.symlinkSync(path.join(temp,'secret'),path.join(temp,'cache/escape'));await assert.rejects(downloadQQVoice('file.silk',{gateway:{httpUrl:'http://127.0.0.1:3000'},readRoots:[{remote:'/qq',local:path.join(temp,'cache')}],fetchImpl:async()=>({ok:true,json:async()=>({status:'ok',retcode:0,data:{file:'/qq/escape'}})})}),/没有提供/);}finally{fs.rmSync(temp,{recursive:true,force:true});}
const config={socialV2:{recallReactions:true,selfLife:{privateQQ:'123'},voice:{enabled:true,asr:{enabled:true}}}};
const event=(id=10,user=123)=>({user_id:user,self_id:999,message_id:id,message:[{type:'record',data:{file:'voice.silk'}}]});
let count=0,release;
const h=await bridgeHarness({config,globals:{transcribeQQVoice:async()=>{count++;if(release)await new Promise(r=>release=r);return {text:'我明天想吃桃子'};}}});
try{
 h.setMode('reserved2');await h.handleIncoming('private','123',event(),h.cfg);assert.equal(count,1);const m=h.getSocialV2State('private:123').unread.at(-1);assert.equal(m.voiceStatus,'done');assert.match(m.text,/明天想吃桃子/);assert.equal(h.calls.sent.length,0,'识别不额外发字幕消息');
 h.cfg.allow.private.push('124');await h.handleIncoming('private','124',event(11,124),h.cfg);assert.equal(count,1,'其他人的语音不识别');
 await h.handleIncoming('group','456',event(12),h.cfg);assert.equal(count,1,'群里的语音不识别');
 h.socialV2.paused=true;await h.handleIncoming('private','123',event(13),h.cfg);assert.equal(count,1,'暂停后不识别');h.socialV2.paused=false;
 release=true;const pending=h.handleIncoming('private','123',event(14),h.cfg);while(typeof release!=='function')await new Promise(r=>setImmediate(r));await h.handleRecallNotice({notice_type:'friend_recall',user_id:123,self_id:999,message_id:14});release();await pending;const recalled=h.getSocialV2State('private:123').recentMessages.find(m=>m.messageId==='14');assert.equal(recalled.voiceStatus,'recalled');assert.equal(recalled.text,'[这条消息已撤回]');
}finally{await h.close();}
const bad=await bridgeHarness({config,globals:{transcribeQQVoice:async()=>{throw new Error('secret provider diagnostic');}}});try{bad.setMode('reserved2');await bad.handleIncoming('private','123',event(),bad.cfg);const m=bad.getSocialV2State('private:123').unread.at(-1);assert.equal(m.voiceStatus,'failed');assert.match(m.text,/没有听清/);assert.doesNotMatch(m.text,/secret/);}finally{await bad.close();}
console.log('PASS QQ ASR: binary protocol, SILK decoding, file bounds, private sender isolation, pause, recall, failure and no caption sends');
