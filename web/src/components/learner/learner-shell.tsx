import type { MouseEvent, RefObject } from "react";
import type { LearningNote, NoteAnswerID } from "../../learner/learning-note.ts";
import type { LearnerState } from "../../learner/lesson-data.ts";
import { LessonList } from "./lesson-catalog.tsx";
import { ConsoleDialog, LearnerHeader, LearnerMenuDialog } from "./learner-chrome.tsx";
import { LabModal } from "./lab-modal.tsx";
import { LessonDetail } from "./lesson-views.tsx";
import { NoteEditor, NoteLibrary } from "../../learner/learning-notes.tsx";
import { lessonByID } from "../../learner/lesson-data.ts";

interface LearnerShellProps {
  state: LearnerState;
  dark: boolean;
  message: string;
  menuOpen: boolean;
  consoleOpen: boolean;
  menuRef: RefObject<HTMLDialogElement | null>;
  consoleDialogRef: RefObject<HTMLDialogElement | null>;
  viewRef: RefObject<HTMLDivElement | null>;
  onAction: (event: MouseEvent<HTMLDivElement>) => void;
  onMenuOpen: () => void;
  onMenuOpenChange: (open: boolean) => void;
  onConsoleOpenChange: (open: boolean) => void;
  onDarkToggle: () => void;
  onPhaseChange: (phase: number) => void;
  onStateChange: (patch: Partial<LearnerState>) => void;
  note: LearningNote;
  noteStatus: string;
  noteFailure: string;
  onNoteAnswer: (id: NoteAnswerID, answer: string) => void;
  onNoteStep: (step: number) => void;
  onNoteSave: () => void;
  onNoteRetry: () => void;
  onNoteEdit: () => void;
  onNoteRead: () => void;
  onNoteBack: () => void;
}

export function LearnerShell({
  state,
  dark,
  message,
  menuOpen,
  consoleOpen,
  menuRef,
  consoleDialogRef,
  viewRef,
  onAction,
  onMenuOpen,
  onMenuOpenChange,
  onConsoleOpenChange,
  onDarkToggle,
  onPhaseChange,
  onStateChange,
  note,
  noteStatus,
  noteFailure,
  onNoteAnswer,
  onNoteStep,
  onNoteSave,
  onNoteRetry,
  onNoteEdit,
  onNoteRead,
  onNoteBack,
}: LearnerShellProps) {
  const lesson = lessonByID(state.lesson);
  return (
    <div onClick={onAction}>
      <div
        className={`app ${state.view === "detail" ? "learning" : state.view === "notes" || state.view === "note" ? "notes" : ""}`}
      >
        <LearnerHeader
          state={state}
          menuOpen={menuOpen}
          consoleOpen={consoleOpen}
          onMenuOpen={onMenuOpen}
          onDarkToggle={onDarkToggle}
        />
        <div id="view" ref={viewRef} style={{ minHeight: 0, overflow: "hidden" }}>
          {state.view === "list" ? <LessonList state={state} /> : null}
          {state.view === "detail" ? (
            <LessonDetail state={state} lesson={lesson} onPhaseChange={onPhaseChange} />
          ) : null}
          {state.view === "notes" ? (
            <NoteLibrary
              lesson={lessonByID("fb")}
              note={note}
              failure={noteFailure}
              onEdit={onNoteEdit}
              onRead={onNoteRead}
            />
          ) : null}
          {state.view === "note" ? (
            <NoteEditor
              lesson={lessonByID("fb")}
              note={note}
              status={noteStatus}
              failure={noteFailure}
              onAnswer={onNoteAnswer}
              onStep={onNoteStep}
              onSave={onNoteSave}
              onRetry={onNoteRetry}
              onBack={onNoteBack}
            />
          ) : null}
        </div>
      </div>
      {state.view === "detail" && (
        <LearnerMenuDialog
          state={state}
          lesson={lesson}
          dialogRef={menuRef}
          onOpenChange={onMenuOpenChange}
        />
      )}
      <ConsoleDialog
        state={state}
        dialogRef={consoleDialogRef}
        onOpenChange={onConsoleOpenChange}
      />
      <div id="modal">
        <LabModal state={state} onChange={onStateChange} />
      </div>
      <div className={`toast ${message ? "on" : ""}`} id="toast" role="status">
        {message}
      </div>
    </div>
  );
}
