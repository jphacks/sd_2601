import type { LearnerState } from "./lesson-data.ts";
import { requiredElement } from "../shared/dom.ts";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { initialState, L, lessonByID } from "./lesson-data.ts";
import { LearnerShell } from "../components/learner/learner-shell.tsx";
import { NoteEditor, NoteLibrary } from "./learning-notes.tsx";
import { finishNote, readNote, writeNote } from "./learning-note.ts";
import type { LearningNote, NoteAnswerID } from "./learning-note.ts";
import { StudyApi } from "../shared/study-api.ts";
import { useLearnerLab } from "./use-learner-lab.ts";
import { createLearnerActionHandler } from "./use-learner-actions.ts";
import "@fontsource/noto-sans-jp/400.css";
import "@fontsource/noto-sans-jp/500.css";
import "@fontsource/noto-sans-jp/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./learner.css";

const api = new StudyApi(
  document.querySelector<HTMLMetaElement>('meta[name="reprokit-session"]')?.content ?? "",
);
const noteLesson = {
  lessonId: "command-injection/filebrowser-auth-hook",
  lessonVersion: "1.0.0",
};
const requestedLesson = (() => {
  const values = new URLSearchParams(window.location.search).getAll("lessonId");
  if (values.length !== 1) return undefined;
  return L.find((lesson) => lesson.lessonId === values[0]);
})();

function App() {
  const [state, setState] = useState(() =>
    requestedLesson
      ? { ...initialState, lesson: requestedLesson.id, view: "detail" as const }
      : initialState,
  );
  const [noteState, setNoteState] = useState(() => readNote(noteLesson));
  const [noteStatus, setNoteStatus] = useState("");
  const [dark, setDark] = useState(false);
  const [message, setMessage] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const menu = useRef<HTMLDialogElement>(null);
  const consoleDialog = useRef<HTMLDialogElement>(null);
  const view = useRef<HTMLDivElement>(null);
  const pendingPhase = useRef<{ phase: number; previous?: number } | null>(null);
  const update = (patch: Partial<LearnerState>) =>
    setState((previous) => ({ ...previous, ...patch }));
  const selectedLesson = lessonByID(state.lesson);
  const trackPhase = useCallback((phase: number) => {
    setState((previous) => (previous.p === phase ? previous : { ...previous, p: phase }));
  }, []);

  function persistNote(note: LearningNote, status = "下書きをこのブラウザに保存しました") {
    const saved = writeNote(note);
    setNoteState({
      note,
      failure: saved
        ? ""
        : "ブラウザに保存できませんでした。画面を閉じずに、保存設定や空き容量を確認して再試行してください。",
    });
    setNoteStatus(saved ? status : "変更はこの画面内にのみ保持されています。");
    return saved;
  }

  function answerNote(id: NoteAnswerID, answer: string) {
    persistNote({ ...noteState.note, draft: { ...noteState.note.draft, [id]: answer } });
  }

  function saveNote() {
    const next = finishNote(noteState.note);
    if (!next) return;
    // 永続化できた場合だけカードを更新し、失敗時は編集中の回答を残す。
    if (!writeNote(next)) {
      setNoteState((previous) => ({
        ...previous,
        failure:
          "カードを保存できませんでした。画面を閉じずに、ブラウザの保存設定や空き容量を確認して再試行してください。",
      }));
      setNoteStatus("変更はこの画面内にのみ保持されています。");
      return;
    }
    setNoteState({ note: next, failure: "" });
    setNoteStatus("");
    update({ view: "notes" });
    setMessage("まとめをカードに保存しました");
  }

  const { deployLab, stopLab, destroyLab, showLogs, readMarker, observeService, compareMarker } =
    useLearnerLab({ api, lesson: selectedLesson, state, update, setState, setMessage });
  const action = createLearnerActionHandler({
    state,
    update,
    setState,
    setMessage,
    setMenuOpen,
    menuRef: menu,
    pendingPhaseRef: pendingPhase,
    deployLab,
    stopLab,
    destroyLab,
    showLogs,
    readMarker,
    observeService,
    compareMarker,
    setConsoleOpen,
  });

  useEffect(() => {
    if (menuOpen) menu.current?.showModal();
    else menu.current?.close();
  }, [menuOpen]);

  useEffect(() => {
    if (consoleOpen) consoleDialog.current?.showModal();
    else consoleDialog.current?.close();
  }, [consoleOpen]);

  useEffect(() => {
    const compact = window.matchMedia("(max-width: 1000px)");
    const resize = () => {
      if (!compact.matches) {
        menu.current?.close();
        setMenuOpen(false);
      }
    };
    compact.addEventListener("change", resize);
    return () => compact.removeEventListener("change", resize);
  }, []);

  // 章の追加後に移動し、通常のスクロールやLab状態更新では位置を変えない。
  useLayoutEffect(() => {
    if (pendingPhase.current === null) return;
    const { phase, previous } = pendingPhase.current;
    const heading = view.current?.querySelector<HTMLElement>(`#phase-title-${phase}`);
    pendingPhase.current = null;
    if (!heading) return;
    heading.focus({ preventScroll: true });
    const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "instant"
      : "smooth";
    const previousBlock =
      previous === undefined
        ? null
        : view.current?.querySelector<HTMLElement>(`#phase-${previous}`);
    if (previousBlock) {
      // 「次へ」は読み終えた章の下端を基準にし、次章の余白と導入を残す。
      const detail = previousBlock.closest<HTMLElement>(".detail")!;
      detail.scrollTo({
        top:
          detail.scrollTop +
          previousBlock.getBoundingClientRect().bottom -
          detail.getBoundingClientRect().top,
        behavior,
      });
    } else {
      heading.scrollIntoView({ behavior, block: "start" });
    }
  }, [state]);

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }, [dark]);
  useEffect(() => {
    api.selectLesson(selectedLesson.lessonId);
  }, [selectedLesson.lessonId]);
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(""), 2200);
    return () => clearTimeout(timer);
  }, [message]);
  useEffect(() => {
    if (!state.modal) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") update({ modal: null });
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [state.modal]);
  return (
    <LearnerShell
      state={state}
      dark={dark}
      message={message}
      menuOpen={menuOpen}
      consoleOpen={consoleOpen}
      menuRef={menu}
      consoleDialogRef={consoleDialog}
      viewRef={view}
      onAction={action}
      onMenuOpen={() => setMenuOpen(true)}
      onMenuOpenChange={setMenuOpen}
      onConsoleOpenChange={setConsoleOpen}
      onDarkToggle={() => setDark((previous) => !previous)}
      onPhaseChange={trackPhase}
      onStateChange={update}
      note={noteState.note}
      noteStatus={noteStatus}
      noteFailure={noteState.failure}
      onNoteAnswer={answerNote}
      onNoteStep={(step) => persistNote({ ...noteState.note, step })}
      onNoteSave={saveNote}
      onNoteRetry={() => persistNote(noteState.note)}
      onNoteEdit={() => update({ view: "note" })}
      onNoteRead={() => update({ view: "detail", p: -1 })}
      onNoteBack={() => update({ view: "notes" })}
    />
  );
}

createRoot(requiredElement("#root")).render(<App />);
