class QQBridgeAudio extends AudioWorkletProcessor {
  constructor(){
    super();this.frame=new Int16Array(320);this.fill=0;this.phase=0;this.sum=0;this.count=0;this.muted=false;
    this.ring=new Float32Array(24000*60);this.read=0;this.write=0;this.available=0;this.playPhase=0;this.playing=false;
    this.port.onmessage=({data})=>{
      if(data.type==='muted')this.muted=data.value;
      if(data.type==='clear'){this.available=0;this.read=this.write;this.playPhase=0;this.playing=false;}
      if(data.type==='play'){
        const samples=data.samples;
        if(samples.length>this.ring.length-this.available){this.port.postMessage({type:'overflow'});return;}
        for(const value of samples){this.ring[this.write]=value;this.write=(this.write+1)%this.ring.length;this.available++;}
        this.playing=true;
      }
    };
  }
  process(inputs,outputs){
    const input=inputs[0]?.[0];
    if(input&&!this.muted){
      for(const sample of input){
        this.sum+=sample;this.count++;this.phase+=16000;
        if(this.phase>=sampleRate){
          const value=Math.max(-1,Math.min(1,this.sum/this.count));this.frame[this.fill++]=Math.round(value*(value<0?32768:32767));
          this.phase-=sampleRate;this.sum=0;this.count=0;
          if(this.fill===320){this.port.postMessage({type:'capture',buffer:this.frame.buffer},[this.frame.buffer]);this.frame=new Int16Array(320);this.fill=0;}
        }
      }
    }
    const output=outputs[0]?.[0];
    if(output)for(let i=0;i<output.length;i++){
      if(this.available>1){
        const a=this.ring[this.read],b=this.ring[(this.read+1)%this.ring.length];output[i]=a+(b-a)*this.playPhase;
        this.playPhase+=24000/sampleRate;const consume=Math.floor(this.playPhase);this.playPhase-=consume;
        const n=Math.min(consume,this.available);this.read=(this.read+n)%this.ring.length;this.available-=n;
      }else{output[i]=0;if(this.playing){this.playing=false;this.port.postMessage({type:'drained'});}}
    }
    return true;
  }
}
registerProcessor('qqbridge-audio',QQBridgeAudio);
