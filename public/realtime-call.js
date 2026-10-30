const $=id=>document.getElementById(id);
let settings,call=null,epoch=0,clock;
function error(message){$('error').textContent=message;$('error').hidden=!message;}
function status(text){$('status').textContent=text;}
function controls(connected){$('start').disabled=connected||!settings;$('mute').disabled=!connected;$('interrupt').disabled=!connected;$('stop').disabled=!connected;}
async function end(message='通话已结束'){
  epoch++;const old=call;call=null;clearInterval(clock);controls(false);document.body.classList.remove('active');$('mute').setAttribute('aria-pressed','false');$('mute').textContent='静音';
  if(old){old.ready=false;try{old.socket?.send(JSON.stringify({type:'stop'}));}catch{}old.socket?.close();old.stream?.getTracks().forEach(track=>track.stop());old.source?.disconnect();old.node?.disconnect();try{await old.context?.close();}catch{}}
  status(message);
}
async function start(){
  if(call)return;const generation=++epoch;error('');status('正在请求麦克风…');controls(true);
  const current={ready:false,muted:false,started:Date.now()};call=current;
  try{
    if(!navigator.mediaDevices?.getUserMedia)throw new Error('请用支持麦克风的浏览器打开本机通话页面');
    current.stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
    if(generation!==epoch){current.stream.getTracks().forEach(track=>track.stop());return;}
    current.context=new AudioContext({sampleRate:16000,latencyHint:'interactive'});await current.context.resume();
    await current.context.audioWorklet.addModule('/audio-worklet.js');if(generation!==epoch){await current.context.close();return;}
    current.node=new AudioWorkletNode(current.context,'qqbridge-audio',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1]});
    current.source=current.context.createMediaStreamSource(current.stream);current.source.connect(current.node);current.node.connect(current.context.destination);
    current.node.port.onmessage=({data})=>{
      if(call!==current)return;
      if(data.type==='capture'&&current.ready&&!current.muted&&current.socket.readyState===WebSocket.OPEN){if(current.socket.bufferedAmount>262144){error('网络发送积压，请检查连接后重新接通');void end();return;}try{current.socket.send(data.buffer);}catch{error('连接已中断，请重新接通');void end();}}
      if(data.type==='drained'&&current.ready)status(current.muted?'麦克风已静音':'示例伙伴在听');
      if(data.type==='overflow'){error('播放缓冲积压，请重新接通');void end();}
    };
    status('正在接通示例伙伴…');current.socket=new WebSocket(`ws://${location.host}/call`);current.socket.binaryType='arraybuffer';
    current.socket.onmessage=({data})=>{
      if(call!==current)return;
      try{
        const event=JSON.parse(data);
        if(event.type==='ready'){current.ready=true;current.started=Date.now();status('示例伙伴在听');document.body.classList.add('active');clock=setInterval(()=>{const n=Math.floor((Date.now()-current.started)/1000);$('duration').textContent=`${String(Math.floor(n/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`;},1000);}
        if(event.type==='user.started'){current.node.port.postMessage({type:'clear'});status('正在听你说…');}
        if(event.type==='assistant.started')status('示例伙伴在说话…');
        if(event.type==='audio'){
          const raw=atob(event.audio),bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));const view=new DataView(bytes.buffer);const samples=new Float32Array(Math.floor(bytes.length/2));for(let i=0;i<samples.length;i++)samples[i]=view.getInt16(i*2,true)/32768;current.node.port.postMessage({type:'play',samples},[samples.buffer]);
        }
        if(event.type==='interrupted'){current.node.port.postMessage({type:'clear'});status(current.muted?'麦克风已静音':'示例伙伴在听');}
        if(event.type==='error'){error(event.message);void end('未能继续通话');}
        if(event.type==='ended')void end();
      }catch{error('通话数据异常，请重新接通');void end();}
    };
    current.socket.onerror=()=>{if(call===current){error('无法接通实时语音，请稍后重试');void end('未接通');}};
    current.socket.onclose=()=>{if(call===current)void end();};
    for(const track of current.stream.getAudioTracks())track.onended=()=>{if(call===current){error('麦克风已断开，请重新接通');void end();}};
  }catch(cause){console.error('[realtime-ui] start failed',cause.name||'Error');if(generation!==epoch)return;error(cause.name==='NotAllowedError'?'请允许浏览器使用麦克风，再点击接通':cause.message||'麦克风启动失败');await end('未接通');}
}
$('start').addEventListener('click',()=>void start());
$('stop').addEventListener('click',()=>void end());
$('mute').addEventListener('click',()=>{if(!call?.ready)return;call.muted=!call.muted;call.node.port.postMessage({type:'muted',value:call.muted});call.stream.getAudioTracks().forEach(t=>{t.enabled=!call.muted;});call.socket.send(JSON.stringify({type:call.muted?'mute':'unmute'}));$('mute').setAttribute('aria-pressed',String(call.muted));$('mute').textContent=call.muted?'取消静音':'静音';status(call.muted?'麦克风已静音':'示例伙伴在听');});
$('interrupt').addEventListener('click',()=>{if(!call?.ready)return;call.node.port.postMessage({type:'clear'});call.socket.send(JSON.stringify({type:'interrupt'}));});
$('portrait').addEventListener('error',()=>{$('portrait').hidden=true;});
window.addEventListener('pagehide',()=>void end());
try{console.info('[realtime-ui] loading settings');const response=await fetch('/api/settings');const data=await response.json();if(!response.ok||data.ok!==true)throw new Error(data.error||'读取通话配置失败');settings=data;$('name').textContent=data.name;$('voice').textContent=data.voice+' · 实时语音';console.info('[realtime-ui] settings ready');controls(false);}catch(cause){console.error('[realtime-ui] settings failed',cause.name||'Error');error(cause.message||'无法读取通话配置');status('暂时无法接通');}
