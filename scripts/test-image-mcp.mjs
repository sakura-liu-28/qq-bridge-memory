import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await fs.mkdtemp(path.join(root, '.tmp-image-mcp-'));
const requests = [];
const api = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  requests.push({ url: req.url, body: JSON.parse(raw), token: req.headers['x-agent-token'], agent: req.headers['x-agent-call'] });
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, sent: 1, messageId: '12345', model: 'fixture-image' }));
});
await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
let client;
try {
  await fs.cp(path.join(root, 'src'), path.join(temp, 'src'), { recursive: true });
  await fs.writeFile(path.join(temp, 'config.json'), JSON.stringify({
    consolePort: api.address().port, consoleToken: 'fixture-console-token',
    socialV2: { tools: { generateImage: true, describeImage: true, selfLife: true }, selfLife: { enabled: true }, imageGeneration: { enabled: true }, vision: { enabled: true } }
  }));
  client = new Client({ name: 'image-mcp-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(temp, 'src/mcp-snowluma-safe.js')], cwd: temp, stderr: 'pipe' }));
  const listed = await client.listTools();
  assert.ok(listed.tools.some(tool => tool.name === 'qq_generate_image'));
  const result = await client.callTool({ name: 'qq_generate_image', arguments: { key: 'private:123', token: 'fixture-agent-token', prompt: '一只猫' } });
  assert.equal(result.isError, undefined);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/socialV2/generate-image');
  assert.equal(requests[0].token, 'fixture-agent-token');
  assert.equal(requests[0].agent, '1');
  assert.equal(requests[0].body.prompt, '一只猫');
  assert.ok(listed.tools.some(tool => tool.name === 'qq_describe_image'));
  await client.callTool({ name: 'qq_describe_image', arguments: { key: 'private:123', token: 'fixture-agent-token', messageId: '20', question: '这是什么' } });
  assert.equal(requests[1].url, '/api/socialV2/describe-image');
  assert.equal(requests[1].token, 'fixture-agent-token');
  assert.equal(requests[1].body.messageId, '20');
  assert.ok(listed.tools.some(tool => tool.name === 'qq_self_life'));
  await client.callTool({ name: 'qq_self_life', arguments: { key: 'private:123', token: 'fixture-agent-token', action: 'state' } });
  assert.equal(requests[2].url, '/api/socialV2/self-life');
  assert.equal(requests[2].token, 'fixture-agent-token');
  assert.equal(requests[2].body.action, 'state');
  const renamed = await client.callTool({ name: 'qq_self_life', arguments: { key: 'private:123', token: 'fixture-agent-token', action: 'nickname', text: '示例伙伴今天有点皮' } });
  assert.equal(renamed.isError, undefined);
  assert.equal(requests[3].body.action, 'nickname');
  assert.equal(requests[3].body.text, '示例伙伴今天有点皮');
  console.log('PASS MCP生图/识图工具注册、会话令牌传递与独立接口调用');
} finally {
  await client?.close();
  await new Promise(resolve => api.close(resolve));
  await fs.rm(temp, { recursive: true, force: true });
}
