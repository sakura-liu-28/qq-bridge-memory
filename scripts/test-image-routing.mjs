import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const image = { buffer: Buffer.from('fixture-image'), model: 'fixture-image-model' };
const config = { dsh: { authToken: 'fixture-only', provider: 'original-provider', model: 'original-chat-model' }, socialV2: { imageGeneration: { enabled: true }, tools: { generateImage: true } } };
const event = (text, user = 123) => ({ user_id: user, self_id: 999, message_id: 10, message: [{ type: 'text', data: { text } }] });
let generated = 0;
const generationOptions = [];
const h = await bridgeHarness({ config, globals: { generateImage: async options => { generated++; generationOptions.push(options); return image; } } });
let server;
try {
  h.setMode('reserved2');
  await h.handleIncoming('private', '123', event('/生图 一只猫'), h.cfg);
  assert.equal(generated, 1);
  assert.equal(generationOptions.at(-1).useReference, false);
  assert.equal(h.calls.created.length, 0, '直接生图不得创建聊天会话');
  assert.equal(h.calls.prompts.length, 0, '直接生图不得调用聊天模型');
  assert.equal(h.cfg.dsh.model, 'original-chat-model', '生图不得切换聊天模型');
  const outgoing = h.calls.http.find(call => call.url.endsWith('/send_private_msg'));
  assert.equal(outgoing.body.message[0].type, 'image');
  const st = h.getSocialV2State('private:123');
  assert.equal(st.replyCheckTimer, null, '直接生图不触发额外聊天回复检查');
  assert.equal(st.unread.length, 0, '直接生图不写入聊天模型未读队列');
  assert.equal(st.recentMessages.at(-1).messageId, '9001');

  await h.handleIncoming('private', '123', event('今天过得怎么样'), h.cfg);
  assert.equal(generated, 1, '普通聊天不得调用图片模型');
  assert.equal(st.unread.length, 1, '普通消息仍走原聊天调度');

  await h.handleIncoming('private', '123', event('/生图 猫', 222), h.cfg);
  assert.equal(generated, 1, '非管理员不得绕过原有命令权限');
  server = h.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const call = async (token, body) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/socialV2/generate-image`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token', 'x-agent-call': '1', ...(token ? { 'x-agent-token': token } : {}) },
      body: JSON.stringify(body)
    });
    return { status: res.status, body: await res.json() };
  };
  for (const token of [null, 'wrong-token']) assert.equal((await call(token, { key: 'private:123', prompt: '猫' })).status, 403);
  assert.equal(generated, 1, '鉴权失败必须在调用生图服务之前拒绝');
  assert.equal((await call(st.agentToken, { key: 'group:456', prompt: '猫' })).status, 403, '令牌不能跨会话生成');
  assert.equal((await call(st.agentToken, { key: 'private:123', prompt: '' })).status, 400);
  h.cfg.socialV2.imageGeneration.fixedReference = true;
  const success = await call(st.agentToken, { key: 'private:123', prompt: '浅色毛衣，挑眉笑', useReference: false });
  assert.equal(success.status, 200, JSON.stringify(success.body));
  assert.equal(success.body.sent, 1);
  assert.equal(generationOptions.at(-1).useReference, true, '工具传 false 不能绕过固定参考');
  await h.handleIncoming('private', '123', event('/生图 换一件毛衣'), h.cfg);
  assert.equal(generationOptions.at(-1).useReference, true, '直接命令也必须使用固定参考');
  h.cfg.socialV2.imageGeneration.enabled = false;
  const disabled = await call(st.agentToken, { key: 'private:123', prompt: '猫' });
  assert.equal(disabled.body.ok, false);
  assert.equal(generated, 3, '关闭开关后不能调用远端');
  console.log('PASS 直接生图跳过聊天模型；普通聊天、命令权限、会话令牌及开关隔离');
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await h.close();
}

let release;
const pendingImage = new Promise(resolve => { release = resolve; });
const race = await bridgeHarness({ config, globals: { generateImage: () => pendingImage } });
try {
  race.setMode('reserved2');
  const sending = race.handleIncoming('private', '123', event('/生图 猫'), race.cfg);
  // Let parsing/authorization enter the async generation call before revoking it.
  await new Promise(resolve => setTimeout(resolve, 20));
  race.cfg.socialV2.imageGeneration.enabled = false;
  release(image);
  await sending;
  assert.equal(race.calls.http.filter(call => call.body?.message?.[0]?.type === 'image').length, 0, '生成期间关闭权限后不得发送图片');
  assert.equal(race.calls.prompts.length, 0, '失败也不回退到聊天模型');
  console.log('PASS 生图过程中撤销权限可阻止发送；失败不回退聊天模型');
} finally { await race.close(); }

let attempts = 0;
const failed = await bridgeHarness({ config, globals: {
  generateImage: async () => image,
  fetch: async () => {
    attempts++;
    return { ok: attempts > 1, status: attempts > 1 ? 200 : 500,
      json: async () => attempts > 1 ? { status: 'ok', retcode: 0, data: { message_id: 55 } } : { status: 'failed', retcode: 1 } };
  }
} });
try {
  failed.setMode('reserved2');
  await failed.handleIncoming('private', '123', event('/生图 猫'), failed.cfg);
  assert.equal(failed.getSocialV2State('private:123').recentMessages.length, 0, '网关失败不得记录已发送');
  assert.ok(failed.calls.sent.some(call => call.text.includes('QQ 发送失败')), '发送失败必须反馈给用户');
  await failed.handleIncoming('private', '123', event('/生图 猫'), failed.cfg);
  assert.equal(failed.getSocialV2State('private:123').recentMessages.at(-1).messageId, '55', '一次失败不应堵住之后的发送');
  assert.equal(failed.calls.prompts.length, 0);
  console.log('PASS 网关发送失败有提示、不误报已发送，发送队列可恢复');
} finally { await failed.close(); }
