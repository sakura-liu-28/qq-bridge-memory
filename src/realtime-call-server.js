import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { realtimeSettings, realtimePersona, connectRealtime } from './realtime-voice.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAFE_CONFIG_ERRORS = new Set(['实时通话尚未启用', '请先配置语音密钥文件', '实时通话音色配置无效', '通话角色配置无效', '无法读取通话角色，请检查角色文件', '通话角色内容为空', '无法读取语音密钥', '语音密钥格式无效']);
const configError = error => SAFE_CONFIG_ERRORS.has(error?.message) ? error.message : '通话配置无法读取，请检查配置文件';
const SECURITY = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer', 'permissions-policy': 'microphone=(self), camera=()',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" };

export function createCallServer({ root = ROOT, getConfig = () => JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')),
  connect = connectRealtime, log = console.error } = {}) {
  const access = crypto.randomBytes(32).toString('hex');
  let active = null;
  const equal = value => { const b = Buffer.from(value || ''); const a = Buffer.from(access); return a.length === b.length && crypto.timingSafeEqual(a, b); };
  const validCookie = req => equal(String(req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('qqbridge_call='))?.slice('qqbridge_call='.length));
  const allowedHost = req => [`127.0.0.1:${server.address()?.port}`, `localhost:${server.address()?.port}`].includes(String(req.headers.host || '').toLowerCase());
  const json = (res, status, data) => { res.writeHead(status, { ...SECURITY, 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
  const server = http.createServer((req, res) => {
    if (!allowedHost(req)) return json(res, 403, { ok: false, error: '只允许从本机打开通话页面' });
    const url = new URL(req.url, 'http://localhost');
    if (req.method !== 'GET') return json(res, 405, { ok: false, error: '不支持的请求' });
    if (url.pathname === '/favicon.ico') { res.writeHead(204, SECURITY); return res.end(); }
    if (url.pathname === '/') {
      res.writeHead(200, { ...SECURITY, 'content-type': 'text/html; charset=utf-8',
        'set-cookie': `qqbridge_call=${access}; HttpOnly; SameSite=Strict; Path=/` });
      return res.end(fs.readFileSync(path.join(root, 'public/realtime-call.html')));
    }
    if (!validCookie(req)) return json(res, 401, { ok: false, error: '请先打开通话首页' });
    try {
      if (url.pathname === '/api/settings') {
        const config = getConfig(); const settings = realtimeSettings(config); const persona = realtimePersona(root, settings.role);
        return json(res, 200, { ok: true, name: persona.role, voice: settings.voiceName, inputRate: 16000, outputRate: 24000 });
      }
      if (url.pathname === '/avatar') {
        const reference = getConfig().socialV2?.imageGeneration?.referenceImagePath;
        if (!path.isAbsolute(reference || '') || !fs.existsSync(reference)) { res.writeHead(404, SECURITY); return res.end(); }
        const stat = fs.statSync(reference); if (!stat.isFile() || stat.size > 20*1024*1024) { res.writeHead(404, SECURITY); return res.end(); }
        res.writeHead(200, { ...SECURITY, 'content-type': 'image/png' }); return fs.createReadStream(reference).pipe(res);
      }
      const assets = { '/call.js': ['realtime-call.js', 'text/javascript'], '/call.css': ['realtime-call.css', 'text/css'], '/audio-worklet.js': ['realtime-audio-worklet.js', 'text/javascript'] };
      const asset = assets[url.pathname];
      if (!asset) return json(res, 404, { ok: false, error: '页面不存在' });
      res.writeHead(200, { ...SECURITY, 'content-type': asset[1] + '; charset=utf-8' }); res.end(fs.readFileSync(path.join(root, 'public', asset[0])));
    } catch (error) { log('[realtime] page/settings failed'); json(res, 503, { ok: false, error: configError(error) }); }
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    if (!allowedHost(req) || req.url !== '/call' || req.headers.origin !== `http://${req.headers.host}` || !validCookie(req)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    if (active) { socket.end('HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n'); return; }
    sockets.handleUpgrade(req, socket, head, client => sockets.emit('connection', client));
  });
  sockets.on('connection', client => {
    const slot = { client, call: null, alive: true }; active = slot;
    const emit = event => { if (client.readyState === 1) client.send(JSON.stringify(event)); };
    try {
      const settings = realtimeSettings(getConfig()); const persona = realtimePersona(root, settings.role);
      slot.call = connect({ settings, instructions: persona.instructions, emit, log,
        onEnd: () => { if (active === slot) active = null; client.close(1000); } });
    } catch (error) { log('[realtime] call setup failed'); emit({ type: 'error', message: configError(error) }); client.close(1011); if (active === slot) active = null; }
    client.on('message', (data, binary) => {
      try {
        if (binary) slot.call?.audio(data);
        else { const event = JSON.parse(data.toString()); slot.call?.command(event.type); }
      } catch { emit({ type: 'error', message: '通话请求无效，请重新接通' }); slot.call?.stop(); client.close(1008); }
    });
    client.on('pong', () => { slot.alive = true; });
    const cleanup = () => { slot.call?.stop(); if (active === slot) active = null; };
    client.on('close', cleanup); client.on('error', cleanup);
  });
  const heartbeat = setInterval(() => {
    if (!active) return;
    if (!active.alive) return active.client.terminate();
    active.alive = false; active.client.ping();
  }, 30000); heartbeat.unref();
  server.on('close', () => { clearInterval(heartbeat); active?.call?.stop(); sockets.close(); });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  const settings = realtimeSettings(config);
  if (!Number.isSafeInteger(settings.port) || settings.port < 1024 || settings.port > 65535) throw new Error('实时通话端口无效');
  const server = createCallServer();
  server.on('error', error => { console.error(`[realtime] listen failed ${error.code || 'unknown'}`); process.exitCode = 1; });
  server.listen(settings.port, '127.0.0.1', () => console.error(`[realtime] call page http://127.0.0.1:${settings.port}`));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { server.close(); setTimeout(() => process.exit(0), 2500).unref(); });
}
