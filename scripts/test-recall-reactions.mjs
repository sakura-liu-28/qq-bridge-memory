import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const h = await bridgeHarness({ config: { ownerQQ: null, socialV2: { recallReactions: true } } });
const recall = (extra = {}) => ({ post_type: 'notice', notice_type: 'friend_recall', self_id: 999, user_id: 123, message_id: 80, ...extra });
try {
  h.setMode('reserved2');
  h.setSelfIdentity('示例伙伴', 999);
  const st = h.getSocialV2State('private:123');
  st.bootstrapSent = true;
  h.appendSocialV2Message('private:123', '对方', '你吃反了吗', '你吃反了吗', false, false, 80, [], 123);
  const prompt = h.buildWakePromptV2('private:123', 'private');
  assert.ok(prompt.includes('错字') || prompt.includes('错字、'));
  assert.ok(prompt.includes('结合前后文'));
  assert.ok(prompt.includes('只有确有多种解释'));
  assert.equal(st.unread.at(-1).text, '你吃反了吗', '语义理解不篡改消息原文');
  await h.handleRecallNotice(recall());
  const notice = st.unread.at(-1);
  assert.equal(notice.kind, 'recall');
  assert.equal(notice.messageId, null, '撤回通知不是新的QQ消息，不能冒用原消息ID');
  assert.equal(notice.recall.messageId, '80');
  assert.ok(notice.text.includes('俏皮'));
  assert.ok(notice.text.includes('不用每次都问'));
  assert.ok(notice.text.includes('未看见内容时不要假装知道'));
  assert.equal(st.unread.find(m => m.messageId === '80').text, '[这条消息已撤回]');
  assert.equal(st.pendingWakeReason, 'recall');
  const count = st.unread.length;
  await h.handleRecallNotice(recall());
  assert.equal(st.unread.length, count, '重复通知不能重复追问');
  await h.handleRecallNotice(recall({ user_id: 999, self_id: 999 }));
  await h.handleRecallNotice(recall({ user_id: 222 }));
  await h.handleRecallNotice(recall({ message_id: '' }));
  assert.equal(st.unread.length, count);
  await h.handleRecallNotice(recall({ message_id: -81 }));
  assert.equal(st.unread.at(-1).recall.messageId, '-81', '支持OneBot负数消息ID及未见过的撤回');
  assert.equal(h.calls.sent.length, 0, '由模型自主接话，不发送写死的追问');
  assert.equal(h.calls.images.length, 0, '不为恢复撤回内容请求原图');
  const group = h.getSocialV2State('group:456');
  group.bootstrapSent = true;
  group.wakeConfig.mode = 'active';
  await h.handleRecallNotice(recall({ notice_type: 'group_recall', group_id: 456, user_id: 222, operator_id: 333 }));
  assert.equal(group.unread.at(-1).recall.byOther, true);
  assert.ok(group.unread.at(-1).text.includes('不是本人主动撤回'));
  assert.equal(group.pendingWakeReason, 'recall');
  const privatePaused = h.getSocialV2State('private:123');
  h.socialV2.paused = true;
  const wake = privatePaused.pendingWakeReason;
  await h.handleRecallNotice(recall({ message_id: 82 }));
  assert.equal(privatePaused.pendingWakeReason, wake, '暂停时仅记录，不新增唤醒');
  h.socialV2.paused = false;
  fs.writeFileSync(path.join(h.temp, 'state/current-role.json'), JSON.stringify({ role: null, mode: 'silent' }));
  const silentCount = st.unread.length;
  await h.handleRecallNotice(recall({ message_id: 83 }));
  assert.equal(st.unread.length, silentCount, '静默时遵守原有权限');
  h.cfg.socialV2.recallReactions = false;
  await h.handleRecallNotice(recall({ message_id: 84 }));
  assert.equal(st.unread.length, silentCount);
  console.log('PASS 撤回通知接入、可调皮追问、原文标记、去重、白名单、管理员代撤、暂停静默、错字语义提示');
} finally { await h.close(); }

let releaseVision, enteredVision;
const visionPending = new Promise(resolve => { releaseVision = resolve; });
const visionEntered = new Promise(resolve => { enteredVision = resolve; });
const race = await bridgeHarness({ config: { socialV2: { recallReactions: true, tools: { describeImage: true }, vision: { enabled: true } } },
  globals: { describeImages: async () => { enteredVision(); return visionPending; } } });
try {
  race.setMode('reserved2');
  const incoming = race.handleIncoming('private', '123', { user_id: 123, self_id: 999, message_id: 90,
    message: [{ type: 'image', data: { file: 'fixture-image' } }] }, race.cfg);
  await visionEntered;
  await race.handleRecallNotice(recall({ message_id: 90 }));
  releaseVision({ text: '这段识图结果不应该恢复到撤回消息中', model: 'fixture' });
  await incoming;
  const original = race.getSocialV2State('private:123').recentMessages.find(m => m.messageId === '90');
  assert.equal(original.text, '[这条消息已撤回]');
  assert.equal(original.media.length, 0);
  console.log('PASS 识图进行中撤回不会把晚返回的图片内容重新放进消息');
} finally { await race.close(); }
