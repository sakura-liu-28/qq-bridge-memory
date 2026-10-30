import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
const candidate = fs.existsSync(new URL('../.local/qq-av/plugins/napcat-plugin-maibot-qq-voice-call/index.mjs',import.meta.url)) ? '../.local/qq-av/plugins/napcat-plugin-maibot-qq-voice-call/index.mjs' : '../deployment/qq-native-call/bridge/napcat-plugin/index.mjs';
const {isCallerAllowed}=await import(candidate);
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-multi-policy-')),socket=path.join(dir,'policy.sock');
let callers=['123','124'],enabled=true;
const server=http.createServer((req,res)=>{if(req.headers.authorization!=='Bearer fixture-token'){res.writeHead(401);return res.end();}res.end(JSON.stringify({allow:{private:['123','124']},socialV2:{voice:{realtime:{enabled:true,native:{enabled,allowedCallers:callers}}}}}));});
await new Promise(r=>server.listen(socket,r));
try{
 const config={policySocket:socket,allowedCallers:['123']};
 assert.equal(await isCallerAllowed(config,'124','fixture-token'),true);
 callers=['123'];assert.equal(await isCallerAllowed(config,'124','fixture-token'),false);
 assert.equal(await isCallerAllowed(config,'123','invalid-token'),false);
 enabled=false;assert.equal(await isCallerAllowed(config,'123','fixture-token'),false);
 await new Promise(r=>server.close(r));assert.equal(await isCallerAllowed(config,'123','fixture-token'),false);
 console.log('PASS AV callers: multiple numbers, immediate removal, authentication, disabled state, failed-policy denial');
}finally{if(server.listening)await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});}
