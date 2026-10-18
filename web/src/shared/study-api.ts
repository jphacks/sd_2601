import type {
  ActionObservation,
  Assignment,
  Endpoint,
  LabBinding,
  LabRef,
  LabSession,
  LabSnapshot,
  LabState,
  LearnerLesson,
  LessonSummary,
  LogSnapshot,
  MarkerObservation,
  StudySession,
  Submission,
  VolumePolicy,
} from "./types.ts";
export const LESSON_ID = "command-injection/filebrowser-auth-hook";
const studyPattern = /^[0-9a-f]{32}$/;
const labPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

function identifier(value: string, pattern: RegExp) {
  if (!pattern.test(value)) throw new Error("Session IDが不正です。");
  return value;
}

export class ApiError extends Error {
  status: number;
  session?: LabSession;

  constructor(status: number, payload: unknown) {
    const failure =
      typeof payload === "object" && payload !== null
        ? (payload as { failure?: unknown; session?: LabSession })
        : undefined;
    const message = typeof payload === "string" ? payload : failure?.failure;
    super(
      typeof message === "string" && message
        ? message
        : `Runnerへの接続に失敗しました（HTTP ${status}）。`,
    );
    this.status = status;
    this.session = failure?.session;
  }
}

// 呼び出し先と入力の形を操作ごとに固定し、自由入力を実行設定へ転用しない。
export class StudyApi {
  token: string;
  request: typeof fetch;
  lessonID: string;

  constructor(token: string, request = globalThis.fetch.bind(globalThis), lessonID = LESSON_ID) {
    this.token = token;
    this.request = request;
    this.lessonID = lessonID;
  }

  selectLesson(lessonID: string) {
    this.lessonID = identifier(lessonID, /^[a-z0-9][a-z0-9._-]{0,62}\/[a-z0-9][a-z0-9._-]{0,62}$/);
  }

  async call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const response = await this.request(path, {
      method,
      headers: {
        "X-Reprokit-Session": this.token,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
    const raw = await response.text();
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = raw;
    }
    if (!response.ok) throw new ApiError(response.status, payload);
    return payload as T;
  }

  lessons(): Promise<LessonSummary[]> {
    return this.call<LessonSummary[]>("/api/lessons");
  }
  detail(version: string): Promise<LearnerLesson> {
    const query = new URLSearchParams({ lessonId: this.lessonID, lessonVersion: version });
    return this.call<LearnerLesson>(`/api/lessons/detail?${query}`);
  }
  create(version: string): Promise<StudySession> {
    return this.call<StudySession>("/api/study-sessions", "POST", {
      lessonId: this.lessonID,
      lessonVersion: version,
    });
  }
  study(id: string): Promise<StudySession> {
    return this.call<StudySession>(`/api/study-sessions/${identifier(id, studyPattern)}`);
  }
  advance(id: string): Promise<StudySession> {
    return this.call<StudySession>(
      `/api/study-sessions/${identifier(id, studyPattern)}/advance`,
      "POST",
    );
  }
  hint(id: string, step: string): Promise<StudySession> {
    return this.call<StudySession>(
      `/api/study-sessions/${identifier(id, studyPattern)}/hints/${encodeURIComponent(step)}`,
      "POST",
    );
  }
  answer(id: string, question: string, answer: string): Promise<StudySession> {
    return this.call<StudySession>(
      `/api/study-sessions/${identifier(id, studyPattern)}/answers/${encodeURIComponent(question)}`,
      "PUT",
      { answer },
    );
  }
  trainingAssignment(): Promise<{ assignment: Assignment }> {
    return this.call<{ assignment: Assignment }>("/api/training/learner/assignment");
  }
  startTraining(): Promise<Assignment> {
    return this.call<Assignment>("/api/training/learner/start", "POST", {});
  }
  submitTraining(id: string): Promise<Submission> {
    return this.call<Submission>("/api/training/learner/submissions", "POST", {
      studySessionId: identifier(id, studyPattern),
    });
  }
  binding(id: string, ref: LabRef): Promise<LabBinding> {
    if (!["vulnerable", "fixed"].includes(ref)) throw new Error("未定義のLab参照です。");
    return this.call<LabBinding>(`/api/study-sessions/${identifier(id, studyPattern)}/labs/${ref}`);
  }
  prepare(version: string, ref: LabRef): Promise<LabSession> {
    if (!["vulnerable", "fixed"].includes(ref)) throw new Error("未定義のLab参照です。");
    return this.call<LabSession>("/api/labs", "POST", {
      lessonId: this.lessonID,
      lessonVersion: version,
      labRef: ref,
    });
  }
  status(id: string): Promise<LabSession> {
    return this.call<LabSession>(`/api/labs/${identifier(id, labPattern)}`);
  }
  marker(id: string, ref: LabRef): Promise<MarkerObservation> {
    if (!["vulnerable", "fixed"].includes(ref)) throw new Error("未定義の比較対象です。");
    return this.call<MarkerObservation>(`/api/labs/${identifier(id, labPattern)}/markers/${ref}`);
  }
  logs(id: string, ref: LabRef): Promise<LogSnapshot> {
    if (!["vulnerable", "fixed"].includes(ref)) throw new Error("未定義の比較対象です。");
    return this.call<LogSnapshot>(`/api/labs/${identifier(id, labPattern)}/logs/${ref}`);
  }
  listTmp(id: string, ref: LabRef): Promise<ActionObservation> {
    if (!["vulnerable", "fixed"].includes(ref)) throw new Error("未定義の比較対象です。");
    return this.call<ActionObservation>(
      `/api/labs/${identifier(id, labPattern)}/actions/${ref}/list_tmp`,
      "POST",
    );
  }
  start(id: string): Promise<LabSession> {
    return this.call<LabSession>(`/api/labs/${identifier(id, labPattern)}/start`, "POST", {
      confirmed: true,
    });
  }
  stop(id: string): Promise<LabSession> {
    return this.call<LabSession>(`/api/labs/${identifier(id, labPattern)}/stop`, "POST");
  }
  delete(id: string, policy: VolumePolicy): Promise<LabSession> {
    if (!["retain", "delete"].includes(policy)) throw new Error("Volume方針が不正です。");
    return this.call<LabSession>(
      `/api/labs/${identifier(id, labPattern)}?volumePolicy=${policy}`,
      "DELETE",
    );
  }
}

export const stateLabels: Record<LabState, string> = {
  absent: "未準備",
  preparing: "取得・検査中",
  prepared: "準備済み",
  starting: "起動中",
  running: "稼働中",
  stopping: "停止中",
  stopped: "停止済み",
  deleting: "削除中",
  deleted: "削除済み",
  error: "失敗",
};

export function canStart(lab: LabSnapshot | null | undefined): lab is LabSnapshot {
  return (
    lab != null &&
    ["prepared", "stopped"].includes(lab.state) &&
    lab.safetyChecked === true &&
    lab.externalExposure === false
  );
}

export function endpointURL(endpoint: Endpoint) {
  if (
    endpoint.address !== "127.0.0.1" ||
    !Number.isInteger(endpoint.port) ||
    endpoint.port < 1 ||
    endpoint.port > 65535
  )
    return null;
  return `http://127.0.0.1:${endpoint.port}`;
}

export function hasComparisonEndpoints(lab: LabSnapshot | null | undefined) {
  return ["vulnerable", "fixed"].every((ref) =>
    lab?.endpoints?.some((endpoint) => endpoint.service === ref && endpointURL(endpoint)),
  );
}
