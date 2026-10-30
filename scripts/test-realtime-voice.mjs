import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter, once } from 'node:events';
import http from 'node:http';
import WebSocket from 'ws';
import { connectRealtime, realtimeSettings, realtimeSession, realtimePersona, VIVI_VOICE } from '../src/realtime-voice.js';
import { createCallServer } from '../src/realtime-call-server.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'realtime-test-'));
const key=path.join(root,'key');fs.writeFileSync(key,'private-test-key');
const settings={apiKeyPath:key,voice:VIVI_VOICE,enableMusic:true};
const config={socialV2:{voice:{enabled:true,tts:{apiKeyPath:key},realtime:{enabled:true,voice:VIVI_VOICE,enableMusic:true,role:'示例伙伴'}}}};
let server,client;
let phase='core';
const deadline=setTimeout(()=>{console.error('realtime test timeout at '+phase);process.exit(1);},12000);
try{
  assert.throws(()=>realtimeSettings({}),/未启用/);
  assert.equal(realtimeSettings(config).voice,VIVI_VOICE);
  assert.throws(()=>realtimePersona(root,'../../key'),/配置无效/);
  const session=realtimeSession({voice:VIVI_VOICE,instructions:'自然说话',enableMusic:true});
  assert.equal(session.extension.dialog.extra.enable_music,true);assert.equal(session.session.audio.output.format.type,'pcm_s16le');
  class Socket extends EventEmitter{readyState=0;bufferedAmount=0;sent=[];send(s){this.sent.push(JSON.parse(s));}close(){this.readyState=3;}terminate(){this.readyState=3;}}
  let socket,opts;const events=[],logs=[];let ended=0;
  const call=connectRealtime({settings,instructions:'测试人设',emit:e=>events.push(e),onEnd:()=>ended++,log:s=>logs.push(s),createSocket:(url,options)=>{opts=options;assert.equal(url,'wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue');return socket=new Socket();}});
  assert.deepEqual(Object.keys(opts.headers),['X-Api-Key']);
  socket.readyState=1;socket.emit('open');assert.equal(socket.sent[0].session.audio.output.voice,VIVI_VOICE);
  socket.emit('message',Buffer.from(JSON.stringify({type:'session.created'})));
  call.audio(Buffer.alloc(640));call.command('mute');call.command('unmute');call.command('interrupt');
  assert.deepEqual(socket.sent.slice(1).map(x=>x.type),['input_audio_buffer.append','input_audio_mute.commit','input_audio_unmute.commit','response.cancel']);
  socket.emit('message',Buffer.from(JSON.stringify({type:'response.output_audio.delta',delta:Buffer.alloc(960).toString('base64')})));
  assert.ok(events.some(e=>e.type==='audio'));
  socket.emit('message',Buffer.from(JSON.stringify({type:'error',message:'private-test-key secret internal path',code:'bad'})));
  assert.equal(ended,1);assert.ok(!JSON.stringify(events).includes('private-test-key'));assert.ok(!logs.join('').includes('private-test-key'));
  call.stop();assert.equal(ended,1);

  phase='http';
  const project=path.resolve(path.dirname(new URL(import.meta.url).pathname),'..');
  const actions=[];
  server=createCallServer({root:project,getConfig:()=>config,log:()=>{},connect:({emit,onEnd})=>{
    setImmediate(()=>emit({type:'ready'}));return{audio:b=>actions.push(['audio',b.length]),command:t=>{actions.push(['command',t]);if(t==='stop')onEnd();},stop:()=>actions.push(['stop'])};
  }});
  server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base+'/api/settings')).status,401);
  const home=await fetch(base);assert.equal(home.status,200);assert.ok(!(await home.text()).includes('private-test-key'));
  const cookie=home.headers.get('set-cookie').split(';')[0];
  const response=await fetch(base+'/api/settings',{headers:{cookie}});assert.equal(response.status,200);assert.ok(!(await response.text()).includes('private-test-key'));
  const invalidHostStatus=await new Promise(resolve=>http.get(base+'/',{headers:{Host:'evil.example'}},response=>{response.resume();resolve(response.statusCode);}));
  assert.equal(invalidHostStatus,403);
  async function rejected(headers,status){await new Promise((resolve,reject)=>{const ws=new WebSocket(base.replace('http:','ws:')+'/call',{headers});ws.on('unexpected-response',(_r,r)=>{r.resume();try{assert.equal(r.statusCode,status);resolve();}catch(e){reject(e)}ws.terminate();});ws.on('error',()=>{});ws.on('open',()=>{ws.close();reject(Error('unauthorized upgrade'));});});}
  phase='websocket';
  await rejected({origin:base},403);await rejected({origin:'https://evil.example',cookie},403);
  client=new WebSocket(base.replace('http:','ws:')+'/call',{headers:{origin:base,cookie}});
  const readyPromise=once(client,'message');
  await once(client,'open');const [ready]=await readyPromise;assert.equal(JSON.parse(ready).type,'ready');
  await rejected({origin:base,cookie},409);
  client.send(Buffer.alloc(640));client.send(JSON.stringify({type:'stop'}));await once(client,'close');
  assert.ok(actions.some(a=>a[0]==='audio'&&a[1]===640));assert.ok(actions.some(a=>a[0]==='command'&&a[1]==='stop'));

  phase='worklet';
  let Processor;const messages=[];
  vm.runInNewContext(fs.readFileSync(path.join(project,'public/realtime-audio-worklet.js'),'utf8'),{
    sampleRate:48000,AudioWorkletProcessor:class{port={postMessage:e=>messages.push(e)}} ,registerProcessor:(_name,p)=>{Processor=p;},Float32Array,Int16Array,Math
  });
  const processor=new Processor();processor.process([[new Float32Array(960).fill(.2)]],[[new Float32Array(960)]]);
  assert.equal(messages.filter(x=>x.type==='capture').length,1);assert.equal(messages[0].buffer.byteLength,640);
  processor.port.onmessage({data:{type:'muted',value:true}});processor.process([[new Float32Array(960)]],[[new Float32Array(960)]]);assert.equal(messages.filter(x=>x.type==='capture').length,1);
  processor.port.onmessage({data:{type:'play',samples:new Float32Array(100).fill(.5)}});const output=new Float32Array(128);processor.process([],[[output]]);assert.ok(output.some(x=>x>.1));
  processor.port.onmessage({data:{type:'clear'}});const cleared=new Float32Array(128);processor.process([],[[cleared]]);assert.ok(cleared.every(x=>x===0));
  console.log('PASS realtime protocol, persona/path guards, audio/mute/cancel/stop, credential redaction, HTTP/WS origin and cookie isolation, single call, audio resampling and playback cleanup');
}finally{phase='cleanup';client?.terminate();if(server){server.close();await once(server,'close');}clearTimeout(deadline);fs.rmSync(root,{recursive:true,force:true});}
