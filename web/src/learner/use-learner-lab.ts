import type { Dispatch, SetStateAction } from "react";
import type { LabRef, LabSession } from "../shared/types.ts";
import type { LearnerState, SampleLesson } from "./lesson-data.ts";
import { useEffect, useRef } from "react";
import { ApiError, canStart, StudyApi } from "../shared/study-api.ts";

interface UseLearnerLabOptions {
  api: StudyApi;
  lesson: SampleLesson;
  state: LearnerState;
  update: (patch: Partial<LearnerState>) => void;
  setState: Dispatch<SetStateAction<LearnerState>>;
  setMessage: Dispatch<SetStateAction<string>>;
}

function labState(session: LabSession | null): LearnerState["lab"] {
  if (session?.state === "running") return "running";
  if (session?.state === "stopped") return "stopped";
  if (session?.state === "error") return "failed";
  return "ready";
}

function rememberLabSession(storageKey: string, session: LabSession) {
  if (!session?.labSessionId) return;
  try {
    window.localStorage.setItem(storageKey, session.labSessionId);
  } catch {
    // Lab Sessionは画面内の状態だけで継続する。
  }
}

function forgetLabSession(storageKey: string) {
  try {
    window.localStorage.removeItem(storageKey);
  } catch {
    // 保存先が使えない場合も、削除操作の結果は維持する。
  }
}

function resetLabState(): Partial<LearnerState> {
  return {
    repro: false,
    comparison: {},
    logs: {},
    logLoading: null,
    logFailure: null,
    markers: {},
    markerLoading: null,
    markerFailure: null,
  };
}

export function useLearnerLab({
  api,
  lesson,
  state,
  update,
  setState,
  setMessage,
}: UseLearnerLabOptions) {
  const deployProgressTimer = useRef<number | null>(null);
  const deployProgressValue = useRef(0);
  const comparisonRequests = useRef({ vulnerable: 0, fixed: 0 });
  const storageKey = `reprokit:sample:${lesson.lessonId}:${lesson.version}:lab-session`;

  useEffect(
    () => () => {
      if (deployProgressTimer.current) window.clearInterval(deployProgressTimer.current);
    },
    [],
  );

  // 再読み込み後もRunnerが所有するSessionだけを状態取得する。
  useEffect(() => {
    let cancelled = false;
    let id;
    try {
      id = window.localStorage.getItem(storageKey);
    } catch {
      return undefined;
    }
    if (!id) return undefined;
    api
      .status(id)
      .then((runtime) => {
        if (cancelled) return;
        setState((previous) => ({
          ...previous,
          lab: labState(runtime),
          runtime,
          labFailure: null,
        }));
      })
      .catch(() => {
        if (!cancelled) forgetLabSession(storageKey);
      });
    return () => {
      cancelled = true;
    };
  }, [api, setState, storageKey]);

  function advanceDeployProgress(target: number): Promise<void> {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      deployProgressValue.current = target;
      update({ seg: target });
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      if (deployProgressTimer.current) window.clearInterval(deployProgressTimer.current);
      const timer = window.setInterval(() => {
        const seg = Math.min(target, deployProgressValue.current + 1);
        deployProgressValue.current = seg;
        update({ seg });
        if (seg === target) {
          window.clearInterval(timer);
          if (deployProgressTimer.current === timer) deployProgressTimer.current = null;
          resolve();
        }
      }, 120);
      deployProgressTimer.current = timer;
    });
  }

  async function withDeployProgress<T>(operation: Promise<T>, target: number): Promise<T> {
    // 通信失敗も直ちに捕捉し、進捗表示の完了後に同じエラーとして扱う。
    const result = operation.then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
    await advanceDeployProgress(target);
    const { value, error } = await result;
    if (error) throw error;
    return value as T;
  }

  function resetComparison() {
    // 停止・削除・再起動前の遅延レスポンスを比較結果へ戻さない。
    comparisonRequests.current.vulnerable++;
    comparisonRequests.current.fixed++;
    update({ comparison: {} });
  }

  async function deployLab() {
    if (state.lab === "deploying") return;
    resetComparison();
    deployProgressValue.current = 0;
    update({
      lab: "deploying",
      seg: 0,
      modal: null,
      labFailure: null,
      logs: {},
      logFailure: null,
      markers: {},
      markerFailure: null,
    });
    try {
      let runtime = state.runtime;
      if (!canStart(runtime))
        runtime = await withDeployProgress(api.prepare(lesson.version, "vulnerable"), 10);
      if (!canStart(runtime))
        throw new Error("安全性とloopback公開を確認できないため、Labを起動できません。");
      rememberLabSession(storageKey, runtime);
      update({ runtime });
      runtime = await withDeployProgress(api.start(runtime.labSessionId), 19);
      if (runtime.state !== "running") throw new Error("Labの起動状態を確認できませんでした。");
      rememberLabSession(storageKey, runtime);
      deployProgressValue.current = 20;
      update({ lab: "running", runtime, seg: 20 });
      setMessage("Labが起動しました。「別タブで開く」から画面を開けます");
    } catch (error) {
      const runtime = error instanceof ApiError ? error.session : undefined;
      if (runtime?.labSessionId) rememberLabSession(storageKey, runtime);
      update({
        lab: runtime ? labState(runtime) : "ready",
        runtime: runtime ?? state.runtime,
        labFailure: error instanceof Error ? error.message : "Labの起動に失敗しました。",
      });
      setMessage("Labを起動できませんでした。状態を確認してください。");
    }
  }

  async function stopLab() {
    if (!state.runtime?.labSessionId || state.lab === "deploying") return;
    resetComparison();
    update({ lab: "deploying", seg: 16, labFailure: null });
    try {
      const runtime = await api.stop(state.runtime.labSessionId);
      rememberLabSession(storageKey, runtime);
      update({
        lab: labState(runtime),
        runtime,
        logs: {},
        logFailure: null,
        markers: {},
        markerFailure: null,
      });
      setMessage("Labを停止しました");
    } catch (error) {
      const runtime = error instanceof ApiError ? error.session : undefined;
      if (runtime?.labSessionId) rememberLabSession(storageKey, runtime);
      update({
        lab: runtime ? labState(runtime) : "running",
        runtime: runtime ?? state.runtime,
        labFailure: error instanceof Error ? error.message : "Labの停止に失敗しました。",
      });
      setMessage("Labを停止できませんでした。状態を確認してください。");
    }
  }

  async function destroyLab() {
    if (!state.runtime?.labSessionId || state.lab === "deploying") return;
    resetComparison();
    update({ lab: "deploying", seg: 18, modal: null, labFailure: null });
    try {
      const runtime = await api.delete(
        state.runtime.labSessionId,
        state.vol === "keep" ? "retain" : "delete",
      );
      if (runtime.state !== "deleted") throw new Error("Labの削除状態を確認できませんでした。");
      forgetLabSession(storageKey);
      update({ ...resetLabState(), lab: "ready", runtime: null });
      setMessage(`削除しました（Volume：${state.vol === "keep" ? "保持" : "削除"}）`);
    } catch (error) {
      const runtime = error instanceof ApiError ? error.session : undefined;
      if (runtime?.labSessionId) rememberLabSession(storageKey, runtime);
      update({
        lab: runtime ? labState(runtime) : "failed",
        runtime: runtime ?? state.runtime,
        labFailure: error instanceof Error ? error.message : "Labの削除に失敗しました。",
      });
      setMessage("Labを削除できませんでした。状態を確認してください。");
    }
  }

  async function showLogs(service: LabRef) {
    if (!state.runtime?.labSessionId || state.lab !== "running") return;
    update({ logLoading: service, logFailure: null });
    try {
      const logs = await api.logs(state.runtime.labSessionId, service);
      setState((previous) => ({
        ...previous,
        logs: { ...previous.logs, [service]: logs },
        logLoading: null,
      }));
    } catch (error) {
      update({
        logLoading: null,
        logFailure: error instanceof Error ? error.message : "ログを取得できませんでした。",
      });
    }
  }

  async function readMarker(service: LabRef) {
    if (!state.runtime?.labSessionId || state.lab !== "running") return;
    update({ markerLoading: service, markerFailure: null });
    try {
      const marker = await api.marker(state.runtime.labSessionId, service);
      setState((previous) => ({
        ...previous,
        markers: { ...previous.markers, [service]: marker },
        markerLoading: null,
      }));
    } catch (error) {
      update({
        markerLoading: null,
        markerFailure: error instanceof Error ? error.message : "マーカーを確認できませんでした。",
      });
    }
  }

  async function observeService(service: LabRef) {
    if (!state.runtime?.labSessionId || state.lab !== "running") return;
    update({
      logLoading: service,
      markerLoading: service,
      logFailure: null,
      markerFailure: null,
    });
    const [logsResult, markerResult] = await Promise.allSettled([
      api.logs(state.runtime.labSessionId, service),
      api.marker(state.runtime.labSessionId, service),
    ]);
    setState((previous) => ({
      ...previous,
      repro: previous.repro || (service === "vulnerable" && markerResult.status === "fulfilled"),
      logs:
        logsResult.status === "fulfilled"
          ? { ...previous.logs, [service]: logsResult.value }
          : previous.logs,
      markers:
        markerResult.status === "fulfilled"
          ? { ...previous.markers, [service]: markerResult.value }
          : previous.markers,
      logLoading: null,
      markerLoading: null,
      logFailure:
        logsResult.status === "rejected"
          ? logsResult.reason instanceof Error
            ? logsResult.reason.message
            : "ログを取得できませんでした。"
          : null,
      markerFailure:
        markerResult.status === "rejected"
          ? markerResult.reason instanceof Error
            ? markerResult.reason.message
            : "マーカーを確認できませんでした。"
          : null,
    }));
  }

  async function compareMarker(service: LabRef) {
    if (
      !state.runtime?.labSessionId ||
      state.lab !== "running" ||
      state.comparison[service]?.loading
    )
      return;
    const sessionID = state.runtime.labSessionId;
    const requestID = ++comparisonRequests.current[service];
    setState((previous) => ({
      ...previous,
      comparison: { ...previous.comparison, [service]: { loading: true } },
    }));
    try {
      const marker = await api.marker(sessionID, service);
      if (marker.service !== service || typeof marker.exists !== "boolean")
        throw new Error("対象のマーカーを確認できませんでした。再取得してください。");
      if (requestID !== comparisonRequests.current[service]) return;
      setState((previous) => ({
        ...previous,
        comparison: { ...previous.comparison, [service]: { loading: false, marker } },
      }));
    } catch (error) {
      if (requestID !== comparisonRequests.current[service]) return;
      setState((previous) => ({
        ...previous,
        comparison: {
          ...previous.comparison,
          [service]: {
            loading: false,
            failure: error instanceof Error ? error.message : "マーカーを取得できませんでした。",
          },
        },
      }));
    }
  }

  return { deployLab, stopLab, destroyLab, showLogs, readMarker, observeService, compareMarker };
}
