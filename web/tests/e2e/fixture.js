import { readFile } from "node:fs/promises";

// 教材をテスト内で受講者向け形式へ射影する。講師用回答はHTTPレスポンスに載せない。
export async function mockRunner(page, options = {}) {
  const lessonFile =
    options.lesson === "go-git"
      ? "go-git-loose-reference-path-traversal.json"
      : "filebrowser-auth-hook.json";
  const source = JSON.parse(
    await readFile(new URL(`../../../lessons/${lessonFile}`, import.meta.url)),
  );
  const lesson = structuredClone(source);
  for (const step of lesson.spec.steps) {
    step.hintCount = step.hints.length;
    delete step.hints;
  }
  lesson.spec.assessment = lesson.spec.assessment.map(({ id, question }) => ({ id, question }));
  const study = {
    id: "a".repeat(32),
    lessonId: lesson.metadata.id,
    lessonVersion: lesson.metadata.version,
    stepIndex: options.stepIndex ?? 0,
    revealedHints: {},
    answers: {},
    hints: {},
  };
  const training = {
    assignment: {
      id: "b".repeat(32),
      lessonId: lesson.metadata.id,
      lessonVersion: lesson.metadata.version,
      learnerId: "local-learner",
      status: "assigned",
    },
  };
  const labs = {},
    calls = [];
  let errorOnce = options.failStart,
    studyErrorOnce = options.failResume;
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    const body = request.postDataJSON();
    calls.push({
      path,
      method: request.method(),
      body,
      query: url.search,
      token: request.headers()["x-reprokit-session"],
    });
    const respond = (value, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
    if (path === "/api/lessons")
      return respond([
        { id: lesson.metadata.id, version: lesson.metadata.version, title: lesson.metadata.title },
      ]);
    if (path === "/api/lessons/detail") return respond(lesson);
    if (path === "/api/training/learner/assignment") return respond(training);
    if (path === "/api/training/learner/start") {
      training.assignment.status = "in_progress";
      return respond(training.assignment);
    }
    if (path === "/api/training/learner/submissions") {
      training.assignment.status = "submitted";
      return respond({ id: "c".repeat(32), evaluation: "pending" }, 201);
    }
    if (path === "/api/study-sessions") return respond(study, 201);
    if (path === `/api/study-sessions/${study.id}`) {
      if (studyErrorOnce) {
        studyErrorOnce = false;
        return respond({ failure: "study temporarily unavailable" }, 503);
      }
      return respond(study);
    }
    if (path.startsWith(`/api/study-sessions/${study.id}/labs/`))
      return respond({
        lessonId: study.lessonId,
        lessonVersion: study.lessonVersion,
        labRef: path.split("/").at(-1),
      });
    if (path.endsWith("/advance")) {
      study.stepIndex++;
      return respond(study);
    }
    if (path.includes("/hints/")) {
      const id = path.split("/").at(-1),
        step = source.spec.steps.find((item) => item.id === id);
      study.revealedHints[id] = (study.revealedHints[id] ?? 0) + 1;
      study.hints[id] = step.hints.slice(0, study.revealedHints[id]);
      return respond(study);
    }
    if (path.includes("/answers/")) {
      study.answers[path.split("/").at(-1)] = body.answer;
      return respond(study);
    }
    if (path === "/api/labs") {
      const fixed = body.labRef === "fixed";
      const goGit = lesson.metadata.id === "path-traversal/go-git-loose-reference";
      const id = fixed
        ? "22222222-2222-4222-8222-222222222222"
        : "11111111-1111-4111-8111-111111111111";
      labs[id] = {
        labSessionId: id,
        labId: goGit ? "reprokit/go-git-cve-2026-71557" : "vulhub/filebrowser-cve-2026-54088",
        state: "prepared",
        safetyChecked: !options.unsafe,
        externalExposure: false,
        endpoints: options.paired
          ? [
              { service: "vulnerable", address: "127.0.0.1", port: 18080 },
              { service: "fixed", address: "127.0.0.1", port: 18081 },
            ]
          : [
              {
                service: goGit ? (fixed ? "fixed" : "vulnerable") : "filebrowser",
                address: "127.0.0.1",
                port: fixed ? 18083 : goGit ? 18082 : 18080,
              },
            ],
        resources: { containers: [], networks: [], volumes: [] },
        retainedVolumes: [],
        failure: null,
      };
      if (options.delayPrepare) await new Promise((resolve) => setTimeout(resolve, 150));
      return respond(labs[id]);
    }
    const id = path.split("/")[3],
      lab = labs[id];
    if (!lab) return respond({ failure: "unknown test session" }, 404);
    if (path.includes("/logs/")) {
      const service = path.split("/").at(-1);
      return respond({ service, content: `${service} log\n` });
    }
    if (path.includes("/actions/")) {
      const [service, action] = path.split("/").slice(-2);
      return respond({ service, action, output: "success\n" });
    }
    if (request.method() === "GET" && options.statusGate) {
      const snapshot = structuredClone(lab);
      await options.statusGate();
      return respond(snapshot);
    }
    if (path.endsWith("/start")) {
      if (errorOnce) {
        errorOnce = false;
        lab.state = "error";
        lab.failure = { operation: "start", message: "image digest mismatch" };
        return respond({ session: lab, failure: "image digest mismatch" }, 500);
      }
      lab.state = "running";
      lab.resources = {
        containers: [{ name: "filebrowser", state: "running" }],
        networks: ["lab-network"],
        volumes: ["lab-data"],
      };
    } else if (path.includes("/markers/")) {
      return respond({
        service: path.endsWith("/vulnerable") ? "vulnerable" : "fixed",
        exists: path.endsWith("/vulnerable"),
        ...(path.endsWith("/vulnerable") ? { content: "uid=1000(filebrowser)" } : {}),
      });
    } else if (path.endsWith("/stop")) {
      lab.state = "stopped";
      lab.failure = null;
    } else if (request.method() === "DELETE") {
      lab.state = "deleted";
      lab.failure = null;
      lab.retainedVolumes = url.searchParams.get("volumePolicy") === "retain" ? ["lab-data"] : [];
      lab.resources = { containers: [], networks: [], volumes: lab.retainedVolumes };
    }
    return respond(lab);
  });
  return { lesson, study, labs, calls };
}
