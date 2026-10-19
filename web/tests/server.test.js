import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createWebServer, managementConfig, runnerConfig } from "../server.mjs";

const token = "test_token_for_local_session";
async function start(server, context) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  return `http://127.0.0.1:${server.address().port}`;
}

test("接続先とトークンは起動設定で固定し、外部URLを拒否する", () => {
  assert.equal(runnerConfig(undefined, undefined), null);
  assert.deepEqual(runnerConfig("http://127.0.0.1:9123", token), {
    origin: "http://127.0.0.1:9123",
    token,
  });
  for (const url of [
    "https://example.com",
    "http://localhost:9123",
    "http://127.0.0.1:9123/api",
    "http://user@127.0.0.1:9123",
    "http://127.0.0.1:9123/#x",
  ])
    assert.throws(() => runnerConfig(url, token));
  assert.throws(() => runnerConfig("http://127.0.0.1:9123", '<script>"'));
  assert.deepEqual(managementConfig("management_token_value", "local", "admin"), {
    token: "management_token_value",
    organizationId: "local",
    administratorId: "admin",
    oidcEnabled: false,
  });
  assert.throws(() => managementConfig("short", "local", "admin"));
});

test("管理ログイン後だけ管理トークンで研修APIへ接続する", async (t) => {
  const received = [];
  const upstream = await start(
    http.createServer((req, res) => {
      received.push({
        url: req.url,
        management: req.headers["x-reprokit-management-session"],
        learner: req.headers["x-reprokit-session"],
        organizationId: req.headers["x-reprokit-organization-id"],
        userId: req.headers["x-reprokit-user-id"],
      });
      res.setHeader("Content-Type", "application/json");
      res.end("[]");
    }),
    t,
  );
  const management = managementConfig("management_token_value", "local", "admin");
  const origin = await start(
    createWebServer({
      runner: runnerConfig(upstream, token),
      management,
      admin: { username: "admin", password: "local-password-123" },
    }),
    t,
  );
  assert.equal((await fetch(`${origin}/api/training/materials`)).status, 401);
  assert.equal(
    (
      await fetch(`${origin}/api/admin/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "wrong-password" }),
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await fetch(`${origin}/api/training/materials`, {
        headers: { "X-Reprokit-Session": token },
      })
    ).status,
    401,
  );
  const login = await fetch(`${origin}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "local-password-123" }),
  });
  assert.equal(login.status, 204);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const users = await fetch(`${origin}/api/identity/users`, { headers: { Cookie: cookie } });
  assert.equal(users.status, 200);
  assert.equal(received[0].management, management.token);
  assert.equal(received[0].learner, undefined);
  assert.equal(received[0].organizationId, "local");
  assert.equal(received[0].userId, "admin");
  assert.equal(
    (
      await fetch(`${origin}/api/training/learner/assignment`, {
        headers: { "X-Reprokit-Session": token },
      })
    ).status,
    200,
  );
  assert.equal(received[1].management, undefined);
  assert.equal(received[1].learner, token);
});

test("OIDCログイン主体をサーバー側セッションへ保存して管理APIへ渡す", async (t) => {
  const received = [];
  const upstream = await start(
    http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      received.push({
        url: req.url,
        method: req.method,
        management: req.headers["x-reprokit-management-session"],
        organizationId: req.headers["x-reprokit-organization-id"],
        userId: req.headers["x-reprokit-user-id"],
        body,
      });
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/api/auth/oidc/start") {
        res.end(
          JSON.stringify({
            authorizationUrl:
              "https://idp.example.test/authorize?state=opaque-state&nonce=opaque-nonce",
          }),
        );
        return;
      }
      if (req.url === "/api/auth/oidc/callback") {
        res.end(JSON.stringify({ organizationId: "local", userId: "reviewer" }));
        return;
      }
      res.end("[]");
    }),
    t,
  );
  const management = managementConfig("management_token_value", "local", "admin", true);
  const origin = await start(
    createWebServer({ runner: runnerConfig(upstream, token), management }),
    t,
  );
  const config = await (await fetch(`${origin}/api/admin/config`)).json();
  assert.deepEqual(config, { oidcEnabled: true });
  const startResponse = await fetch(`${origin}/api/admin/oidc/start`, { redirect: "manual" });
  assert.equal(startResponse.status, 303);
  assert.equal(
    startResponse.headers.get("location"),
    "https://idp.example.test/authorize?state=opaque-state&nonce=opaque-nonce",
  );
  assert.equal(received[0].management, management.token);
  const oidcCookie = startResponse.headers.get("set-cookie").split(";")[0];
  const callback = await fetch(
    `${origin}/api/admin/oidc/callback?state=opaque-state&code=authorization-code`,
    { headers: { "Sec-Fetch-Site": "cross-site", Cookie: oidcCookie }, redirect: "manual" },
  );
  assert.equal(callback.status, 303);
  assert.equal(callback.headers.get("location"), "/admin");
  const cookie = callback.headers.getSetCookie()[0].split(";")[0];
  assert.match(callback.headers.get("set-cookie"), /SameSite=Lax/);
  assert.deepEqual(JSON.parse(received[1].body), {
    state: "opaque-state",
    code: "authorization-code",
  });
  const materials = await fetch(`${origin}/api/training/materials`, {
    headers: { Cookie: cookie },
  });
  assert.equal(materials.status, 200);
  assert.equal(received[2].organizationId, "local");
  assert.equal(received[2].userId, "reviewer");
  assert.equal(received[2].management, management.token);
});

test("静的ファイルを限定し、API未設定を成功表示しない", async (t) => {
  const origin = await start(createWebServer(), t);
  const page = await fetch(origin);
  assert.equal(page.status, 200);
  const pageText = await page.text();
  assert.match(pageText, /<html lang="ja">/);
  assert.match(
    pageText,
    /<link rel="icon" type="image\/png" href="\/assets\/reprokit-icon\.png" \/>/,
  );
  assert.match(page.headers.get("content-security-policy"), /connect-src 'self'/);
  const admin = await fetch(`${origin}/admin`);
  assert.equal(admin.status, 200);
  const adminText = await admin.text();
  assert.match(adminText, /研修管理へログイン/);
  assert.match(
    adminText,
    /<link rel="icon" type="image\/png" href="\/assets\/reprokit-icon\.png" \/>/,
  );
  const runner = await fetch(`${origin}/runner`);
  assert.equal(runner.status, 200);
  assert.match(
    await runner.text(),
    /<link rel="icon" type="image\/png" href="\/assets\/reprokit-icon\.png" \/>/,
  );
  assert.equal(
    (await fetch(`${origin}/runner?lessonId=path-traversal%2Fgo-git-loose-reference`)).status,
    200,
  );
  assert.equal((await fetch(`${origin}/runner?lessonId=unexpected&extra=value`)).status, 404);
  assert.equal(
    (await fetch(`${origin}/?lessonId=path-traversal%2Fgo-git-loose-reference`)).status,
    200,
  );
  const logo = await fetch(`${origin}/assets/reprokit-logo.png`);
  assert.equal(logo.status, 200);
  assert.equal(logo.headers.get("content-type"), "image/png");
  const icon = await fetch(`${origin}/assets/reprokit-icon.png`);
  assert.equal(icon.status, 200);
  assert.equal(icon.headers.get("content-type"), "image/png");
  assert.equal((await fetch(`${origin}/api/lessons`)).status, 503);
  assert.equal((await fetch(`${origin}/package.json`)).status, 404);
  assert.equal((await fetch(`${origin}/src/../server.mjs`)).status, 404);
  for (const entry of ["app", "runner", "admin"]) {
    const script = await fetch(`${origin}/generated/${entry}.js`);
    assert.equal(script.status, 200);
    assert.equal(script.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.ok((await script.text()).length > 0);
  }
  assert.equal((await fetch(`${origin}/src/runner/main.ts`)).status, 404);
  assert.equal((await fetch(`${origin}/src/shared/types.ts`)).status, 404);
});

test("同一Originとトークンを検証して既存APIだけをRunnerへ転送する", async (t) => {
  const received = [];
  const upstream = await start(
    http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      received.push({
        url: req.url,
        host: req.headers.host,
        origin: req.headers.origin,
        token: req.headers["x-reprokit-session"],
        body,
      });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    }),
    t,
  );
  const origin = await start(createWebServer({ runner: runnerConfig(upstream, token) }), t);
  const headers = {
    "X-Reprokit-Session": token,
    Origin: origin,
    "Content-Type": "application/json",
  };
  assert.equal(
    (
      await fetch(`${origin}/api/labs`, {
        method: "POST",
        headers,
        body: JSON.stringify({ lessonId: "fixed", lessonVersion: "1.0.0", labRef: "vulnerable" }),
      })
    ).status,
    200,
  );
  assert.equal(received[0].origin, upstream);
  assert.equal(received[0].host, new URL(upstream).host);
  assert.equal(received[0].token, token);
  assert.equal(received.length, 1);
  const actionID = "11111111-1111-4111-8111-111111111111";
  assert.equal(
    (
      await fetch(`${origin}/api/labs/${actionID}/actions/vulnerable/list_tmp`, {
        method: "POST",
        headers,
      })
    ).status,
    200,
  );
  assert.equal(received[1].url, `/api/labs/${actionID}/actions/vulnerable/list_tmp`);
  assert.equal(received.length, 2);
  assert.equal(
    (await fetch(`${origin}/api/labs/${actionID}/logs/vulnerable`, { headers })).status,
    200,
  );
  assert.equal(received[2].url, `/api/labs/${actionID}/logs/vulnerable`);
  assert.equal(received.length, 3);
  assert.equal(
    (await fetch(`${origin}/api/lessons`, { headers: { Origin: "https://evil.test" } })).status,
    403,
  );
  assert.equal((await fetch(`${origin}/api/lessons`)).status, 401);
  assert.equal((await fetch(`${origin}/api/shell`, { method: "POST", headers })).status, 404);
  // fetchがHostを書き換える環境があるため、生のHTTP要求で拒否を検証する。
  const rejectedHost = await new Promise((resolve, reject) => {
    http
      .get(origin, { headers: { Host: "evil.test" } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      })
      .on("error", reject);
  });
  assert.equal(rejectedHost, 403);
  assert.equal(received.length, 3);
  const page = await (await fetch(origin)).text();
  assert.ok(page.includes(`name="reprokit-session" content="${token}"`));
});

test("転送先のリダイレクトをたどらず、失敗を表示できる", async (t) => {
  const upstream = await start(
    http.createServer((req, res) => res.writeHead(302, { Location: "https://example.com" }).end()),
    t,
  );
  const origin = await start(createWebServer({ runner: runnerConfig(upstream, token) }), t);
  const response = await fetch(`${origin}/api/lessons`, {
    headers: { "X-Reprokit-Session": token },
  });
  assert.equal(response.status, 502);
});
