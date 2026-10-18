import { buildFrontend } from "./scripts/frontend.mjs";
import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const files = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/runner", ["runner.html", "text/html; charset=utf-8"]],
  ["/admin", ["admin.html", "text/html; charset=utf-8"]],
  ["/assets/reprokit-icon.png", ["assets/reprokit-icon.png", "image/png"]],
  ["/assets/reprokit-logo.png", ["assets/reprokit-logo.png", "image/png"]],
]);

export function runnerConfig(origin, token) {
  if (!origin && !token) return null;
  const url = new URL(origin);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !/^[A-Za-z0-9_-]{16,256}$/.test(token ?? "")
  )
    throw new Error("Runner origin and session token must identify a local HTTP Runner");
  return { origin: url.origin, token };
}

export function managementConfig(token, organizationId, administratorId, oidcEnabled = false) {
  if (!token && !organizationId && !administratorId && !oidcEnabled) return null;
  if (
    !/^[A-Za-z0-9_-]{16,256}$/.test(token ?? "") ||
    !/^[a-z0-9][a-z0-9._-]{0,62}$/.test(organizationId ?? "") ||
    !/^[a-z0-9][a-z0-9._-]{0,62}$/.test(administratorId ?? "") ||
    typeof oidcEnabled !== "boolean"
  )
    throw new Error("Management configuration is invalid");
  return { token, organizationId, administratorId, oidcEnabled };
}

function sameToken(actual, expected) {
  const a = Buffer.from(actual ?? ""),
    b = Buffer.from(expected ?? "");
  return a.length === b.length && timingSafeEqual(a, b);
}

async function requestBody(request, limit = 256 << 10) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > limit) {
      const error = new Error("request too large");
      error.code = "REQUEST_TOO_LARGE";
      throw error;
    }
    chunks.push(chunk);
  }
  return bytes ? Buffer.concat(chunks) : undefined;
}

function cookieValue(request, name) {
  for (const item of (request.headers.cookie ?? "").split(";")) {
    const [key, ...value] = item.trim().split("=");
    if (key === name) return value.join("=");
  }
  return "";
}

// 受講画面は公開済み教材を選ぶためのlessonId一件だけを受け入れる。
// 任意のクエリを静的ファイル配信へ通さない。
function hasLessonQuery(url) {
  const lessonIDs = url.searchParams.getAll("lessonId");
  return (
    ["/", "/runner"].includes(url.pathname) &&
    lessonIDs.length === 1 &&
    [...url.searchParams.keys()].every((key) => key === "lessonId") &&
    /^[a-z0-9][a-z0-9._-]{0,62}\/[a-z0-9][a-z0-9._-]{0,62}$/.test(lessonIDs[0])
  );
}

// 管理トークンはブラウザへ渡さず、Webシェル内のログインセッションからだけ利用する。
export function createWebServer({
  runner = null,
  management = null,
  admin = null,
  dist = false,
} = {}) {
  const root = new URL(dist ? "./dist/" : "./", import.meta.url);
  let frontendBuild;

  const adminSessions = new Map();
  const oidcFlows = new Map();
  const adminEnabled =
    management &&
    typeof admin?.username === "string" &&
    admin.username.length > 0 &&
    typeof admin?.password === "string" &&
    admin.password.length >= 12;
  const oidcEnabled = Boolean(runner && management?.oidcEnabled);
  const authenticatedSession = (request) => {
    const value = cookieValue(request, "reprokit_admin");
    const session = adminSessions.get(value);
    if (!session || session.expires <= Date.now()) {
      if (value) adminSessions.delete(value);
      return null;
    }
    return session;
  };
  const createAdminSession = (principal) => {
    const value = randomBytes(32).toString("base64url");
    for (const [key, session] of adminSessions) {
      if (session.expires <= Date.now()) adminSessions.delete(key);
    }
    if (adminSessions.size >= 64) adminSessions.delete(adminSessions.keys().next().value);
    adminSessions.set(value, { expires: Date.now() + 8 * 60 * 60 * 1000, principal });
    return value;
  };

  return http.createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    const ownOrigin = `http://127.0.0.1:${request.socket.localPort}`;
    const url = new URL(request.url, ownOrigin);
    const oidcCallback = url.pathname === "/api/admin/oidc/callback" && request.method === "GET";
    if (
      request.headers.host !== new URL(ownOrigin).host ||
      (request.headers.origin && request.headers.origin !== ownOrigin) ||
      (request.headers["sec-fetch-site"] === "cross-site" && !oidcCallback)
    ) {
      response.writeHead(403).end("invalid local origin");
      return;
    }
    if (url.origin !== ownOrigin) {
      response.writeHead(403).end("invalid request target");
      return;
    }
    if (url.pathname === "/runner" && hasLessonQuery(url)) {
      response.writeHead(303, { Location: `/?${url.searchParams}` }).end();
      return;
    }

    if (url.pathname === "/api/admin/login") {
      if (!adminEnabled) {
        response.writeHead(503).end("management login is unavailable");
        return;
      }
      if (request.method !== "POST") {
        response.writeHead(405).end("method not allowed");
        return;
      }
      if (!request.headers["content-type"]?.startsWith("application/json")) {
        response.writeHead(415).end("content type must be application/json");
        return;
      }
      try {
        const body = JSON.parse((await requestBody(request, 4096))?.toString() ?? "");
        const validShape =
          body &&
          Object.keys(body).sort().join(",") === "password,username" &&
          typeof body.username === "string" &&
          typeof body.password === "string";
        if (
          !validShape ||
          !sameToken(body.username, admin.username) ||
          !sameToken(body.password, admin.password)
        ) {
          response.writeHead(401).end("invalid management credentials");
          return;
        }
        const session = createAdminSession({
          organizationId: management.organizationId,
          userId: management.administratorId,
        });
        response.setHeader(
          "Set-Cookie",
          `reprokit_admin=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`,
        );
        response.writeHead(204).end();
      } catch (error) {
        response
          .writeHead(error.code === "REQUEST_TOO_LARGE" ? 413 : 400)
          .end("invalid login request");
      }
      return;
    }
    if (url.pathname === "/api/admin/config") {
      if (request.method !== "GET") {
        response.writeHead(405).end("method not allowed");
        return;
      }
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ oidcEnabled }));
      return;
    }
    if (url.pathname === "/api/admin/oidc/start") {
      if (!oidcEnabled) {
        response.writeHead(503).end("OIDC login is unavailable");
        return;
      }
      if (request.method !== "GET" || url.search) {
        response.writeHead(request.method === "GET" ? 400 : 405).end("invalid OIDC request");
        return;
      }
      try {
        const upstream = await fetch(`${runner.origin}/api/auth/oidc/start`, {
          method: "POST",
          headers: {
            "X-Reprokit-Management-Session": management.token,
            Origin: runner.origin,
            "Content-Type": "application/json",
          },
          body: "{}",
          redirect: "error",
          signal: AbortSignal.timeout(15000),
        });
        if (!upstream.ok) throw new Error("OIDC start failed");
        const authorizationURL = new URL((await upstream.json()).authorizationUrl);
        const safeLoopback =
          authorizationURL.protocol === "http:" && authorizationURL.hostname === "127.0.0.1";
        if (
          (authorizationURL.protocol !== "https:" && !safeLoopback) ||
          authorizationURL.username ||
          authorizationURL.password
        )
          throw new Error("unsafe authorization URL");
        const states = authorizationURL.searchParams.getAll("state");
        if (states.length !== 1 || !states[0]) throw new Error("missing OIDC state");
        for (const [key, flow] of oidcFlows) {
          if (flow.expires <= Date.now()) oidcFlows.delete(key);
        }
        if (oidcFlows.size >= 64) oidcFlows.delete(oidcFlows.keys().next().value);
        const binding = randomBytes(32).toString("base64url");
        oidcFlows.set(binding, { state: states[0], expires: Date.now() + 5 * 60 * 1000 });
        response
          .writeHead(303, {
            Location: authorizationURL.href,
            "Set-Cookie": `reprokit_oidc=${binding}; HttpOnly; SameSite=Lax; Path=/api/admin/oidc/callback; Max-Age=300`,
          })
          .end();
      } catch {
        response.writeHead(502).end("OIDCログインを開始できません。");
      }
      return;
    }
    if (url.pathname === "/api/admin/oidc/callback") {
      const states = url.searchParams.getAll("state"),
        codes = url.searchParams.getAll("code");
      if (
        !oidcEnabled ||
        request.method !== "GET" ||
        states.length !== 1 ||
        codes.length !== 1 ||
        !states[0] ||
        !codes[0] ||
        [...url.searchParams.keys()].some((key) => key !== "state" && key !== "code")
      ) {
        response.writeHead(401).end("OIDC authentication failed");
        return;
      }
      const binding = cookieValue(request, "reprokit_oidc");
      const pendingFlow = oidcFlows.get(binding);
      if (binding) oidcFlows.delete(binding);
      if (
        !pendingFlow ||
        pendingFlow.expires <= Date.now() ||
        !sameToken(pendingFlow.state, states[0])
      ) {
        response.writeHead(401).end("OIDC authentication failed");
        return;
      }
      try {
        const upstream = await fetch(`${runner.origin}/api/auth/oidc/callback`, {
          method: "POST",
          headers: {
            "X-Reprokit-Management-Session": management.token,
            Origin: runner.origin,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ state: states[0], code: codes[0] }),
          redirect: "error",
          signal: AbortSignal.timeout(15000),
        });
        if (!upstream.ok) throw new Error("OIDC callback failed");
        const principal = await upstream.json();
        if (
          principal?.organizationId !== management.organizationId ||
          !/^[a-z0-9][a-z0-9._-]{0,62}$/.test(principal?.userId ?? "")
        )
          throw new Error("invalid OIDC principal");
        const session = createAdminSession(principal);
        response.setHeader("Set-Cookie", [
          `reprokit_admin=${session}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800`,
          "reprokit_oidc=; HttpOnly; SameSite=Lax; Path=/api/admin/oidc/callback; Max-Age=0",
        ]);
        response.writeHead(303, { Location: "/admin" }).end();
      } catch {
        response.writeHead(401).end("OIDC authentication failed");
      }
      return;
    }
    if (url.pathname === "/api/admin/session") {
      if (request.method !== "GET") {
        response.writeHead(405).end("method not allowed");
        return;
      }
      response.writeHead(authenticatedSession(request) ? 204 : 401).end();
      return;
    }
    if (url.pathname === "/api/admin/logout") {
      if (request.method !== "POST") {
        response.writeHead(405).end("method not allowed");
        return;
      }
      adminSessions.delete(cookieValue(request, "reprokit_admin"));
      response.setHeader(
        "Set-Cookie",
        "reprokit_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
      );
      response.writeHead(204).end();
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      if (!runner) {
        response.writeHead(503).end("ローカルRunnerの接続設定がありません。");
        return;
      }
      const learnerTraining = /^\/api\/training\/learner\/(?:assignment|start|submissions)$/.test(
        url.pathname,
      );
      const managementTraining =
        /^\/api\/training\/(?:materials|cohorts|assignments|audit-events|exports\/results\.csv|assignments\/[a-z0-9._-]{1,63}(?:\/submissions)?|submissions\/[a-z0-9._-]{1,63}\/review)$/.test(
          url.pathname,
        );
      const identityManagement =
        /^\/api\/identity\/(?:users(?:\/[a-z0-9._-]{1,63}\/(?:roles|disable))?|audit-events)$/.test(
          url.pathname,
        );
      const managementOperation = managementTraining || identityManagement;
      if (managementOperation) {
        if (!management || !authenticatedSession(request)) {
          response.writeHead(401).end("management login required");
          return;
        }
      } else if (!sameToken(request.headers["x-reprokit-session"], runner.token)) {
        response.writeHead(401).end("invalid local session");
        return;
      }
      const studyOperation =
        /^\/api\/(?:lessons(?:\/detail)?|study-sessions(?:\/[a-f0-9]{32}(?:\/advance|\/(?:hints|answers|labs)\/[a-z0-9-]+)?)?|labs(?:\/[a-f0-9-]{36}(?:\/(?:start|stop|markers\/(?:vulnerable|fixed)|logs\/(?:vulnerable|fixed)|actions\/(?:vulnerable|fixed)\/list_tmp))?)?)$/.test(
          url.pathname,
        );
      if (
        !/^(GET|POST|PUT|DELETE)$/.test(request.method) ||
        (!studyOperation && !learnerTraining && !managementOperation)
      ) {
        response.writeHead(404).end("unknown operation");
        return;
      }
      try {
        const body = await requestBody(request);
        const managementSession = managementOperation ? authenticatedSession(request) : null;
        const upstream = await fetch(`${runner.origin}${url.pathname}${url.search}`, {
          method: request.method,
          headers: {
            ...(managementOperation
              ? {
                  "X-Reprokit-Management-Session": management.token,
                  "X-Reprokit-Organization-ID": managementSession.principal.organizationId,
                  "X-Reprokit-User-ID": managementSession.principal.userId,
                }
              : { "X-Reprokit-Session": runner.token }),
            Origin: runner.origin,
            ...(request.headers["content-type"]
              ? { "Content-Type": request.headers["content-type"] }
              : {}),
          },
          body,
          redirect: "error",
          signal: AbortSignal.timeout(120000),
        });
        response.writeHead(upstream.status, {
          "Content-Type": upstream.headers.get("content-type") ?? "text/plain; charset=utf-8",
          ...(upstream.headers.get("content-disposition")
            ? { "Content-Disposition": upstream.headers.get("content-disposition") }
            : {}),
        });
        response.end(Buffer.from(await upstream.arrayBuffer()));
      } catch (error) {
        if (error.code === "REQUEST_TOO_LARGE") {
          response.writeHead(413).end("request too large");
        } else {
          response.writeHead(502).end("Runnerに接続できません。再実行前に状態を確認してください。");
        }
      }
      return;
    }
    const generated = /^\/generated\/[a-zA-Z0-9_.-]+\.(js|css|woff2?)$/.exec(url.pathname);
    if (generated && !dist) {
      frontendBuild ??= buildFrontend().catch((error) => {
        frontendBuild = null;
        throw error;
      });
      try {
        await frontendBuild;
      } catch {
        response.writeHead(500).end("frontend build failed");
        return;
      }
    }
    const asset =
      files.get(url.pathname) ??
      (generated
        ? [
            url.pathname.slice(1),
            {
              js: "text/javascript; charset=utf-8",
              css: "text/css; charset=utf-8",
              woff: "font/woff",
              woff2: "font/woff2",
            }[generated[1]],
          ]
        : null);
    if (!asset || request.method !== "GET" || (url.search && !hasLessonQuery(url))) {
      response.writeHead(404).end("not found");
      return;
    }
    try {
      let data = await readFile(new URL(asset[0], root));
      if ((asset[0] === "index.html" || asset[0] === "runner.html") && runner)
        data = Buffer.from(
          data
            .toString()
            .replace(
              'name="reprokit-session" content=""',
              `name="reprokit-session" content="${runner.token}"`,
            ),
        );
      response.writeHead(200, { "Content-Type": asset[1] });
      response.end(data);
    } catch {
      response.writeHead(404).end("asset not built");
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.REPROKIT_WEB_PORT ?? 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid Web port");
  const runner = runnerConfig(
    process.env.REPROKIT_RUNNER_ORIGIN,
    process.env.REPROKIT_RUNNER_TOKEN,
  );
  const management = managementConfig(
    process.env.REPROKIT_MANAGEMENT_TOKEN,
    process.env.REPROKIT_ORGANIZATION_ID,
    process.env.REPROKIT_ADMINISTRATOR_ID,
    process.env.REPROKIT_OIDC_ENABLED === "true",
  );
  const admin = process.env.REPROKIT_ADMIN_PASSWORD
    ? {
        username: process.env.REPROKIT_ADMIN_USERNAME ?? "admin",
        password: process.env.REPROKIT_ADMIN_PASSWORD,
      }
    : null;
  const server = createWebServer({
    runner,
    management,
    admin,
    dist: process.argv.includes("--dist"),
  });
  server.listen(port, "127.0.0.1", () =>
    console.log(`Reprokit Web: http://127.0.0.1:${port}${runner ? "" : " (Runner未接続)"}`),
  );
}
