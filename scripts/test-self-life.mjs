import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSelfLife, AVATAR_INTERVAL_MS } from '../src/self-life.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-life-'));
let clock = 1800000000000, sends = [], generated = 0;
let settings = { enabled: true, nickname: true };
const opts = {
  statePath: path.join(dir, 'life.json'), getSettings: () => settings,
  getImageSettings: () => ({ enabled: true, fixedReference: true, referenceImagePath: '/fixture/qqbridge.png' }),
  getGateway: () => ({ httpUrl: 'https://gateway.invalid', accessToken: 'fixture-key' }), now: () => clock,
  generate: async options => { generated++; assert.equal(options.useReference, true); assert.equal(options.settings.fixedReference, true); return { buffer: Buffer.from('fixture-image') }; },
  fetchImpl: async (url, init) => { sends.push({ url, params: JSON.parse(init.body) }); return new Response(JSON.stringify({ status: 'ok', retcode: 0, data: { tid: 'post-123' } })); },
  log: () => {}
};
try {
  let life = createSelfLife(opts);
  await life.run({ action: 'avatar', imagePrompt: '浅色毛衣，抿嘴笑' });
  assert.ok(sends.at(-1).url.endsWith('/set_qq_avatar'));
  assert.ok(sends.at(-1).params.file.startsWith('base64://'));
  assert.equal(life.status().avatar.canChange, false);
  life = createSelfLife(opts);
  await assert.rejects(life.run({ action: 'avatar', imagePrompt: '换件衣服' }), /间隔尚未结束/);
  assert.equal(generated, 1, '七天内重启也不重新生图');
  settings.avatarIntervalMs = 0;
  life = createSelfLife(opts);
  assert.equal(life.status().avatar.canChange, true, '关闭间隔后重启立即可更换');
  assert.equal(life.status().avatar.nextAllowedAt, null);
  await life.run({ action: 'avatar', imagePrompt: '在阳台，侧脸笑' });
  await life.run({ action: 'avatar', imagePrompt: '换件衣服，正面看镜头' });
  assert.equal(life.status().avatar.canChange, true);
  delete settings.avatarIntervalMs;
  assert.equal(life.status().avatar.canChange, false, '恢复间隔仍保留最近操作时间');
  clock += AVATAR_INTERVAL_MS;
  await life.run({ action: 'avatar', imagePrompt: '低马尾，窗边光' });
  for (let n = 0; n < 4; n++) {
    await life.run({ action: 'dynamic', text: `今天的心情 ${n}` });
    await life.run({ action: 'signature', text: `抬头看看云 ${n}` });
  }
  assert.equal(sends.filter(s => s.url.endsWith('/send_qzone_msg')).length, 4);
  assert.equal(sends.filter(s => s.url.endsWith('/set_self_longnick')).length, 4);
  assert.equal(sends.find(s => s.url.endsWith('/send_qzone_msg')).params.ugc_right, 4);
  assert.equal(sends.at(-1).params.longNick, '抬头看看云 3');
  const renamed = await life.run({ action: 'nickname', text: '示例伙伴今天有点皮' });
  assert.equal(renamed.nickname, '示例伙伴今天有点皮');
  assert.ok(sends.at(-1).url.endsWith('/set_qq_profile'));
  assert.deepEqual(sends.at(-1).params, { nickname: '示例伙伴今天有点皮' }, '改昵称不能清空签名、性别或其他资料');
  assert.equal(createSelfLife(opts).status().nickname.lastConfirmed, '示例伙伴今天有点皮');
  assert.equal((await life.run({ action: 'nickname', text: '示例伙伴今天有点皮' })).duplicate, true);
  await assert.rejects(life.run({ action: 'nickname', text: '示例伙伴\n改名' }), /控制字符/);
  await assert.rejects(life.run({ action: 'nickname', text: '小'.repeat(21) }), /20/);
  await assert.rejects(life.run({ action: 'nickname', text: '示例伙伴', imagePrompt: '头像' }), /不支持配图/);
  settings.nickname = false;
  await assert.rejects(life.run({ action: 'nickname', text: '示例伙伴' }), /未启用/);
  settings.nickname = true;
  assert.equal((await life.run({ action: 'dynamic', text: '今天的心情 3' })).duplicate, true);
  await life.run({ action: 'dynamic', text: '换毛衣啦', imagePrompt: '浅色毛衣，轻轻挑眉' });
  assert.equal(sends.at(-1).params.images.length, 1);
  await assert.rejects(life.run({ action: 'signature', text: 'secret=abcdefgh' }), /内部信息/);
  await assert.rejects(life.run({ action: 'signature', text: 'a'.repeat(81) }), /80/);
  const before = sends.length;
  settings.enabled = false;
  await assert.rejects(life.run({ action: 'dynamic', text: '不应发布' }), /尚未启用/);
  assert.equal(sends.length, before);
  settings.enabled = true;
  // Revocation during image generation must stop the profile mutation.
  let allowed = true;
  const revoked = createSelfLife({ ...opts, generate: async () => { allowed = false; return { buffer: Buffer.from('image') }; } });
  await assert.rejects(revoked.run({ action: 'dynamic', text: '取消测试', imagePrompt: '毛衣', assertAllowed: () => { if (!allowed) throw Error('revoked'); } }));
  assert.equal(sends.length, before);
  // A timeout is ambiguous: persist it and prevent automatic duplicate posts.
  const uncertain = createSelfLife({ ...opts, fetchImpl: async () => { throw new DOMException('fixture', 'TimeoutError'); } });
  await assert.rejects(uncertain.run({ action: 'dynamic', text: '等待确认' }), /待核实/);
  assert.equal(createSelfLife(opts).status().pending.action, 'dynamic');
  await assert.rejects(createSelfLife(opts).run({ action: 'signature', text: '也不能绕过' }), /待核实/);
  assert.equal(createSelfLife(opts).status().pending.action, 'dynamic', '失败不能清除其他请求的未确认操作');
  const failedOpts = { ...opts, statePath: path.join(dir, 'failed.json'), fetchImpl: async () => new Response(JSON.stringify({ status: 'failed', retcode: 400 })) };
  await assert.rejects(createSelfLife(failedOpts).run({ action: 'signature', text: '今天心情很好' }), /未完成/);
  assert.equal(createSelfLife(failedOpts).status().pending, null, '网关明确失败允许之后重新操作');
  console.log('PASS 自主头像七天持久化、同脸配图、动态签名不限次、去重、敏感信息、撤权、超时防重复');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }

const h = await bridgeHarness({ config: { ownerQQ: null, dsh: { authToken: 'fixture-only' }, socialV2: {
  tools: { selfLife: true }, selfLife: { enabled: true, nickname: true, roleName: '示例伙伴', privateQQ: '123' }
} }, files: { 'state/current-role.json': { role: '示例伙伴', mode: 'active' }, 'roles/示例伙伴.md': '# 示例伙伴\n温柔自然' } });
let server;
try {
  h.setMode('reserved2');
  const st = h.getSocialV2State('private:123');
  const group = h.getSocialV2State('group:456');
  assert.ok(h.buildWakePromptV2('private:123', 'timeout').includes('不是到期必须换'));
  assert.ok(h.buildWakePromptV2('private:123', 'proactiveCheck').includes('qq_self_life'));
  assert.ok(!h.buildWakePromptV2('group:456', 'timeout').includes('【自主生活】'));
  server = h.startConsoleServer(); if (!server.listening) await new Promise(r => server.once('listening', r));
  const call = async (key, token, action = 'state') => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/socialV2/self-life`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token', 'x-agent-call': '1', ...(token ? { 'x-agent-token': token } : {}) },
      body: JSON.stringify({ key, action, text: '今天心情很好' })
    }); return { status: r.status, body: await r.json() };
  };
  assert.equal((await call('private:123', null)).status, 403);
  assert.equal((await call('private:123', 'wrong')).status, 403);
  assert.equal((await call('group:456', group.agentToken)).status, 403);
  const state = await call('private:123', st.agentToken);
  assert.equal(state.body.ok, true, JSON.stringify(state));
  assert.equal(state.body.dynamic.limit, null);
  assert.equal(state.body.signature.limit, null);
  const changed = await call('private:123', st.agentToken, 'signature');
  assert.equal(changed.body.ok, true, JSON.stringify(changed));
  assert.ok(h.calls.http.some(c => c.url.endsWith('/set_self_longnick')));
  const renamed = await call('private:123', st.agentToken, 'nickname');
  assert.equal(renamed.body.ok, true, JSON.stringify(renamed));
  assert.ok(h.selfIdentityTextV2().includes('今天心情很好'), '改名后立即刷新模型知道的QQ昵称');
  assert.equal(h.cfg.socialV2.selfLife.roleName, '示例伙伴', '显示昵称不改变角色及记忆归属');
  h.cfg.socialV2.tools.selfLife = false;
  assert.equal((await call('private:123', st.agentToken)).status, 403);
  console.log('PASS 自主资料入口只允许管理员私聊、会话令牌和开关校验、真实桥接网关链路');
} finally { if (server) await new Promise(r => server.close(r)); await h.close(); }
