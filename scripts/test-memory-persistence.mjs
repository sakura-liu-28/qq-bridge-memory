import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';

async function withServer(h, run) {
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise(r => server.once('listening', r));
  const call = async (action, body) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/socialV2/${action}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'x-console-token': 'fixture-console-token', 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, ...await res.json() };
  };
  try { await run(call); } finally { await new Promise(r => server.close(r)); }
}
const item = { key: 'private:123', category: 'memberImpression', content: '喜欢简短回复', extra: { target: '偏好：回复长度', replace: true } };
const h = await bridgeHarness();
let disk;
try {
  await withServer(h, async call => {
    const saved = await call('memory-append', item);
    assert.equal(saved.persisted, true);
    assert.equal((await call('memory-append', { ...item, content: '解释技术问题时喜欢详细回复' })).persisted, true);
    const state = await call('memory?key=private%3A123');
    assert.deepEqual(state.raw.memberImpressions[item.extra.target].traits, ['解释技术问题时喜欢详细回复']);
    assert.deepEqual((await call('memory?key=group%3A456')).raw.memberImpressions, {});
    const file = path.join(h.temp, 'state/social-v2.json');
    disk = fs.readFileSync(file, 'utf8');
    fs.unlinkSync(file);
    fs.mkdirSync(file); // Simulate a filesystem that cannot accept the atomic rename.
    const failed = await call('memory-append', { ...item, content: '不能保存这条' });
    assert.equal(failed.ok, false);
    assert.equal(failed.status, 500);
    const after = await call('memory?key=private%3A123');
    assert.deepEqual(after.raw.memberImpressions[item.extra.target].traits, ['解释技术问题时喜欢详细回复']);
    const removeFailed = await call('memory-remove', { key: item.key, category: item.category, target: item.extra.target });
    assert.equal(removeFailed.ok, false);
    assert.ok((await call('memory?key=private%3A123')).raw.memberImpressions[item.extra.target]);
    fs.rmdirSync(file);
    fs.writeFileSync(file, disk);
  });
} finally { await h.close(); }
const h2 = await bridgeHarness({ files: { 'state/social-v2.json': disk } });
try {
  await withServer(h2, async call => {
    const loaded = await call('memory?key=private%3A123');
    assert.deepEqual(loaded.raw.memberImpressions[item.extra.target].traits, ['解释技术问题时喜欢详细回复']);
    assert.match(h2.buildWakePromptV2('private:123', 'private'), /解释技术问题时喜欢详细回复/);
    assert.equal((await call('memory-remove', { key: item.key, category: item.category, target: item.extra.target })).persisted, true);
    assert.deepEqual((await call('memory?key=private%3A123')).raw.memberImpressions, {});
  });
} finally { await h2.close(); }
console.log('PASS: durable memory, atomic correction, cross-chat isolation, write/delete failure rollback, restart loading, wake injection, forgetting');
