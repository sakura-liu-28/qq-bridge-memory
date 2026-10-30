import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { configuredCallers } from './voice-console.js';

export function nativeConfigView(config, permitted = true, sessionContext) {
  const v = config.socialV2?.voice || {}, r = v.realtime || {}, n = r.native || {};
  return {
    allow: { private: config.allow?.private ?? config.allow?.privates ?? [] },
    deny: { private: config.deny?.private ?? config.deny?.privates ?? [] },
    allowAllWhenEmpty: config.allowAllWhenEmpty === true,
    socialV2: { enabled: config.socialV2?.enabled, memory: { mode: config.socialV2?.memory?.mode || 'lightweight' }, selfLife: { privateQQ: config.socialV2?.selfLife?.privateQQ },
      voice: { enabled: v.enabled, tts: { apiKeyPath: v.tts?.apiKeyPath },
        realtime: { enabled: r.enabled, voice: r.voice, voiceName: r.voiceName, role: r.role, enableMusic: r.enableMusic, ...(sessionContext ? { sessionContext } : {}),
          native: { enabled: n.enabled === true && permitted, privateQQ: n.privateQQ, allowedCallers: configuredCallers(config), bridgeUrl: n.bridgeUrl, tokenFile: n.tokenFile, maxSeconds: n.maxSeconds } } } }
  };
}
export async function startNativePolicyServer({ root, getConfig, gate = () => true, getSessionContext, log = console.error }) {
  if (getConfig().socialV2?.voice?.realtime?.native?.enabled !== true) return null;
  const directory = path.join(root,'.local/qq-av/runtime'), socketPath = path.join(directory,'qq-policy.sock');
  const token = fs.readFileSync(path.join(directory,'control.token'),'utf8').trim();
  if (Buffer.byteLength(token) < 32) throw new Error('native policy token unavailable');
  if (fs.existsSync(socketPath)) {
    if (!fs.lstatSync(socketPath).isSocket()) throw new Error('native policy socket path is occupied');
    const alive = await new Promise((resolve,reject) => { const s=net.connect(socketPath);s.setTimeout(1000);s.once('connect',()=>{s.destroy();resolve(true);});s.once('timeout',()=>{s.destroy();resolve(true);});s.once('error',e=>{if(['ECONNREFUSED','ENOENT'].includes(e.code))resolve(false);else reject(e);}); });
    if (alive) throw new Error('native policy server already running');
    if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
  }
  const server = http.createServer((req,res) => {
    const supplied = Buffer.from(String(req.headers.authorization || ''));
    const expected = Buffer.from('Bearer '+token);
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied,expected)) {res.writeHead(401);return res.end();}
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400); return res.end(); }
    if (req.method !== 'GET' || url.pathname !== '/config') {res.writeHead(404);return res.end();}
    try {
      const config = getConfig(), caller = url.searchParams.get('caller');
      const allowed = config.allow?.private || config.allow?.privates || [], denied = config.deny?.private || config.deny?.privates || [];
      if (caller && (!gate() || !configuredCallers(config).includes(caller) || denied.map(String).includes(caller)
        || !(allowed.map(String).includes(caller) || (!allowed.length && config.allowAllWhenEmpty === true)))) { res.writeHead(403); return res.end(); }
      const sessionContext = caller && getSessionContext ? getSessionContext(caller) : undefined;
      res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});
      res.end(JSON.stringify(nativeConfigView(config,gate(),sessionContext)));
    } catch { log('[qq-call] policy read failed');res.end('{}'); }
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve);});
  fs.chmodSync(socketPath,0o600);log('[qq-call] private policy socket ready');
  return server;
}
export function getNativeConfigViaSocket(socketPath, tokenFile, caller) {
  const token=fs.readFileSync(tokenFile,'utf8').trim();
  if (Buffer.byteLength(token)<32) return Promise.reject(new Error('native policy token unavailable'));
  return new Promise((resolve,reject)=>{
    const request=http.get({socketPath,path:'/config'+(caller ? '?caller='+encodeURIComponent(String(caller)) : ''),headers:{authorization:'Bearer '+token},timeout:2000},res=>{
      let text='';res.on('data',chunk=>{text+=chunk;if(text.length>16384)res.destroy(new Error('native policy response too large'));});
      res.on('error',reject);res.on('end',()=>{try{if(res.statusCode!==200)throw new Error('native policy unauthorized');resolve(JSON.parse(text));}catch{reject(new Error('native policy unavailable'));}});
    });
    request.on('timeout',()=>request.destroy(new Error('native policy timeout')));request.on('error',reject);
  });
}
