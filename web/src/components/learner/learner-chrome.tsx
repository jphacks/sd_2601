import type { RefObject } from "react";
import type { LearnerState, SampleLesson } from "../../learner/lesson-data.ts";
import { LabConsole } from "./lab-console.tsx";
import { LessonOutline } from "./lesson-outline.tsx";

interface HeaderProps {
  state: LearnerState;
  menuOpen: boolean;
  consoleOpen: boolean;
  onMenuOpen: () => void;
  onDarkToggle: () => void;
}

export function LearnerHeader({
  state,
  menuOpen,
  consoleOpen,
  onMenuOpen,
  onDarkToggle,
}: HeaderProps) {
  return (
    <header>
      {state.view === "detail" && (
        <button
          className="menu-toggle"
          aria-label="学習メニューを開く"
          aria-expanded={menuOpen}
          aria-controls="learning-menu"
          onClick={onMenuOpen}
        >
          <span aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        </button>
      )}
      <button className="logo" data-a="home" aria-label="Reprokit ホーム">
        <img src="/assets/reprokit-logo.png" alt="Reprokit" />
      </button>
      <div className="hd">
        {state.lab === "running" && (
          <button
            className="btn sm"
            data-a="console"
            aria-haspopup="dialog"
            aria-expanded={consoleOpen}
          >
            {"検証コンソール"}
          </button>
        )}
        <button className="btn sm" id="theme" onClick={onDarkToggle}>
          {"表示切替"}
        </button>
      </div>
    </header>
  );
}

export function LearnerMenuDialog({
  state,
  lesson,
  dialogRef,
  onOpenChange,
}: {
  state: LearnerState;
  lesson: SampleLesson;
  dialogRef: RefObject<HTMLDialogElement | null>;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <dialog
      ref={dialogRef}
      id="learning-menu"
      className="outline-dialog"
      aria-labelledby="learning-menu-title"
      onClose={() => onOpenChange(false)}
      onClick={(event) => {
        if (event.target === event.currentTarget) dialogRef.current?.close();
      }}
    >
      <div className="outline-dialog-header">
        <h2 id="learning-menu-title">{"学習メニュー"}</h2>
        <button
          className="menu-close"
          aria-label="学習メニューを閉じる"
          onClick={() => dialogRef.current?.close()}
          autoFocus
        >
          {"×"}
        </button>
      </div>
      <LessonOutline state={state} lesson={lesson} id="mobile-lesson-outline" />
    </dialog>
  );
}

export function ConsoleDialog({
  state,
  dialogRef,
  onOpenChange,
}: {
  state: LearnerState;
  dialogRef: RefObject<HTMLDialogElement | null>;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <dialog
      ref={dialogRef}
      className="console-dialog"
      aria-labelledby="console-title"
      onClose={() => onOpenChange(false)}
      onClick={(event) => {
        if (event.target === event.currentTarget) dialogRef.current?.close();
      }}
    >
      <div className="console-dialog-header">
        <h2 id="console-title">{"検証コンソール"}</h2>
        <button
          className="menu-close"
          data-a="close-console"
          aria-label="検証コンソールを閉じる"
          autoFocus
        >
          {"×"}
        </button>
      </div>
      <LabConsole state={state} idPrefix="dialog-console" />
    </dialog>
  );
}
