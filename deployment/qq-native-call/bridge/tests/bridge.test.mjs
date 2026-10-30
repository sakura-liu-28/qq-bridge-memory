import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import test from "node:test";

import {
  buildAcceptParams,
  parseBridgeSettings,
  isCallerAllowed,
  plugin_cleanup,
  plugin_init,
  summarizeValue,
} from "../napcat-plugin/index.mjs";

test("verified native Accept mapping uses the inviter as the session key", () => {
  const invite = [
    1,
    "inviter-uid",
    ["bot-uid"],
    3,
    "relation-id",
    5,
    6,
    7,
    8,
    9,
    1,
    "denoise-model",
  ];
  assert.deepEqual(buildAcceptParams(invite), [
    1,
    "inviter-uid",
    ["inviter-uid"],
    3,
    "relation-id",
    true,
    "denoise-model",
  ]);
});

test("invalid invite shape is rejected before invoking AVSDK", () => {
  assert.throws(() => buildAcceptParams([1, "uid"]), /incomplete/);
  const invite = Array(12).fill(null);
  assert.throws(() => buildAcceptParams(invite), /native Accept signature/);
});

test("diagnostic summaries redact sensitive fields and omit string contents", () => {
  const summary = summarizeValue({
    accessToken: "do-not-log-this",
    callerName: "Alice",
    nested: { cookie: "also-secret" },
  });
  const serialized = JSON.stringify(summary);
  assert.doesNotMatch(serialized, /do-not-log-this|also-secret|Alice/);
  assert.equal(summary.keys.find((item) => item.key === "accessToken").value, "[REDACTED]");
});

test("bridge settings load generated config and allow environment port overrides", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maibot-qq-call-"));
  try {
    fs.writeFileSync(
      path.join(tempDir, "bridge-config.json"),
      JSON.stringify({
        controlHost: "127.0.0.1",
        controlPort: 6110,
        avHost: "localhost",
        avPort: 6111,
        tokenFile: "/run/private/token",
      }),
    );
    const settings = parseBridgeSettings(
      { MAIBOT_QQ_CALL_BRIDGE_PORT: "6210" },
      tempDir,
    );
    assert.equal(settings.controlPort, 6210);
    assert.equal(settings.avHost, "localhost");
    assert.equal(settings.tokenFile, "/run/private/token");
    assert.equal(settings.token, "");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("bridge refuses non-loopback endpoints", () => {
  assert.throws(
    () => parseBridgeSettings({ MAIBOT_QQ_CALL_BRIDGE_HOST: "0.0.0.0" }, os.tmpdir()),
    /loopback/,
  );
});

async function unusedLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const selectedPort = address.port;
  await new Promise((resolve) => server.close(resolve));
  return selectedPort;
}

test("NapCat lifecycle exposes only authenticated call state", async () => {
  const controlPort = await unusedLoopbackPort();
  const avPort = await unusedLoopbackPort();
  const previous = {
    token: process.env.MAIBOT_QQ_CALL_BRIDGE_TOKEN,
    tokenFile: process.env.MAIBOT_QQ_CALL_BRIDGE_TOKEN_FILE,
    controlPort: process.env.MAIBOT_QQ_CALL_BRIDGE_PORT,
    avPort: process.env.MAIBOT_QQ_CALL_AV_HOST_PORT,
  };
  const token = "test-token-that-is-longer-than-thirty-two-bytes";
  process.env.MAIBOT_QQ_CALL_BRIDGE_TOKEN = token;
  delete process.env.MAIBOT_QQ_CALL_BRIDGE_TOKEN_FILE;
  process.env.MAIBOT_QQ_CALL_BRIDGE_PORT = String(controlPort);
  process.env.MAIBOT_QQ_CALL_AV_HOST_PORT = String(avPort);

  let registeredListener = null;
  const service = {
    isNull: () => false,
    addKernelAVSDKListener(value) {
      registeredListener = value;
      return 7;
    },
    removeKernelAVSDKListener(id) {
      assert.equal(id, 7);
      registeredListener = null;
    },
  };
  const context = {
    logger: { info() {}, warn() {}, error() {} },
    router: { get() {} },
    core: {
      selfInfo: {},
      context: { session: { getAVSDKService: () => service } },
    },
  };

  try {
    await plugin_init(context);
    assert.ok(registeredListener);
    const baseUrl = `http://127.0.0.1:${controlPort}`;
    const health = await fetch(`${baseUrl}/healthz`);
    assert.equal(health.status, 200);
    const unauthorized = await fetch(`${baseUrl}/v1/calls/current`);
    assert.equal(unauthorized.status, 401);
    const authorized = await fetch(`${baseUrl}/v1/calls/current`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(authorized.status, 200);
    const payload = await authorized.json();
    assert.equal(payload.data.phase, "idle");
  } finally {
    await plugin_cleanup();
    for (const [key, value] of Object.entries(previous)) {
      const envName = {
        token: "MAIBOT_QQ_CALL_BRIDGE_TOKEN",
        tokenFile: "MAIBOT_QQ_CALL_BRIDGE_TOKEN_FILE",
        controlPort: "MAIBOT_QQ_CALL_BRIDGE_PORT",
        avPort: "MAIBOT_QQ_CALL_AV_HOST_PORT",
      }[key];
      if (value === undefined) delete process.env[envName];
      else process.env[envName] = value;
    }
  }
  assert.equal(registeredListener, null);
});


test("SDK initialization callbacks do not cause a login feedback loop", async () => {
  const controlPort = await unusedLoopbackPort();
  const avPort = await unusedLoopbackPort();
  const token = "s".repeat(64);
  const names = ["MAIBOT_QQ_CALL_BRIDGE_TOKEN", "MAIBOT_QQ_CALL_BRIDGE_PORT", "MAIBOT_QQ_CALL_AV_HOST_PORT"];
  const saved = names.map(name => process.env[name]);
  [token, String(controlPort), String(avPort)].forEach((value, index) => { process.env[names[index]] = value; });
  let loginCalls = 0;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const avServer = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      loginCalls += 1;
      res.writeHead(200, {"Content-Type": "application/json"}); res.end('{"code":0}');
      setTimeout(() => { void fetch(`http://127.0.0.1:${controlPort}/v1/avsdk/output`, {
        method: "POST", headers, body: JSON.stringify({command: 20050, value: [0]})
      }).catch(() => {}); }, 40);
    });
  });
  await new Promise(resolve => avServer.listen(avPort, "127.0.0.1", resolve));
  try {
    await plugin_init({logger:{info(){},warn(){},error(){}}, router:{get(){}}, core:{
      selfInfo:{uid:"bot-uid",uin:"1234"},context:{session:{getAccountPath:()=>"/tmp/qq-test",getAVSDKService:()=>({addKernelAVSDKListener(){return 1;},removeKernelAVSDKListener(){}})}}
    }});
    await new Promise(resolve => setTimeout(resolve, 1300));
    const response = await fetch(`http://127.0.0.1:${controlPort}/v1/status`, {headers});
    const {data} = await response.json();
    assert.equal(loginCalls, 1);
    assert.equal(data.avHost.loginPosted, true);
    assert.equal(data.avHost.lastOutputCommand, 20050);
    assert.equal(data.avHost.lastLoginError, null);
  } finally {
    await plugin_cleanup();
    await new Promise(resolve => avServer.close(resolve));
    names.forEach((name,index) => {if(saved[index]===undefined)delete process.env[name];else process.env[name]=saved[index];});
  }
});


test("live private policy supports multiple callers, hot removal and fail-closed errors", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qq-callers-policy-"));
  const socket = path.join(dir, "policy.sock");
  let callers = ["123", "124"], enabled = true;
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== "Bearer fixture-token") { res.writeHead(401); return res.end(); }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({allow:{private:["123","124"]},socialV2:{voice:{realtime:{enabled:true,native:{enabled,allowedCallers:callers}}}}}));
  });
  await new Promise(resolve => server.listen(socket, resolve));
  const config = {policySocket:socket,allowedCallers:["123"]};
  try {
    assert.equal(await isCallerAllowed(config,"124","fixture-token"),true);
    callers=["123"];
    assert.equal(await isCallerAllowed(config,"124","fixture-token"),false);
    assert.equal(await isCallerAllowed(config,"123","wrong-token"),false);
    enabled=false;
    assert.equal(await isCallerAllowed(config,"123","fixture-token"),false);
    await new Promise(resolve => server.close(resolve));
    assert.equal(await isCallerAllowed(config,"123","fixture-token"),false);
  } finally { if(server.listening)await new Promise(resolve=>server.close(resolve));fs.rmSync(dir,{recursive:true,force:true}); }
});
