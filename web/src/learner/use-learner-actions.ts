import type { Dispatch, MouseEvent, MutableRefObject, SetStateAction } from "react";
import type { LabRef } from "../shared/types.ts";
import type { LearnerState } from "./lesson-data.ts";
import { PH } from "./lesson-data.ts";

interface UseLearnerActionsOptions {
  state: LearnerState;
  update: (patch: Partial<LearnerState>) => void;
  setState: Dispatch<SetStateAction<LearnerState>>;
  setMessage: Dispatch<SetStateAction<string>>;
  setMenuOpen: Dispatch<SetStateAction<boolean>>;
  menuRef: MutableRefObject<HTMLDialogElement | null>;
  pendingPhaseRef: MutableRefObject<{ phase: number; previous?: number } | null>;
  deployLab: () => Promise<void>;
  stopLab: () => Promise<void>;
  destroyLab: () => Promise<void>;
  showLogs: (service: LabRef) => Promise<void>;
  readMarker: (service: LabRef) => Promise<void>;
  observeService: (service: LabRef) => Promise<void>;
  compareMarker: (service: LabRef) => Promise<void>;
  setConsoleOpen: Dispatch<SetStateAction<boolean>>;
}

export function createLearnerActionHandler({
  state,
  update,
  setState,
  setMessage,
  setMenuOpen,
  menuRef,
  pendingPhaseRef,
  deployLab,
  stopLab,
  destroyLab,
  showLogs,
  readMarker,
  observeService,
  compareMarker,
  setConsoleOpen,
}: UseLearnerActionsOptions) {
  return async function action(event: MouseEvent<HTMLDivElement>) {
    const target =
      event.target instanceof Element ? event.target.closest<HTMLElement>("[data-a]") : null;
    if (!target || (target instanceof HTMLButtonElement && target.disabled)) return;
    const { a, v, i } = target.dataset;
    switch (a) {
      case "home":
        update({ view: "list" });
        break;
      case "notes":
        menuRef.current?.close();
        setMenuOpen(false);
        update({ view: "notes" });
        break;
      case "write-note":
        update({ view: "note" });
        break;
      case "open":
        if (v === "gg") {
          window.location.assign("/runner?lessonId=path-traversal%2Fgo-git-loose-reference");
          break;
        }
        update({ view: "detail", p: -1 });
        break;
      case "begin":
        pendingPhaseRef.current = { phase: 0 };
        setState((previous) => ({ ...previous, p: 0, revealed: Math.max(0, previous.revealed) }));
        break;
      case "cat":
        update({ cat: v ?? "all" });
        break;
      case "go":
        if (Number(i) > state.revealed) break;
        menuRef.current?.close();
        setMenuOpen(false);
        pendingPhaseRef.current = { phase: Number(i) };
        update({ p: Number(i) });
        break;
      case "next": {
        const phase = Number(i);
        const next = Math.min(PH.length - 1, phase + 1);
        if (phase < PH.length - 1) pendingPhaseRef.current = { phase: next, previous: phase };
        setState((previous) => ({
          ...previous,
          done: { ...previous.done, [phase]: true },
          revealed: Math.max(previous.revealed, next),
          p: next,
        }));
        if (phase === PH.length - 1) setMessage("お疲れさまでした。DESTROYでLabを片付けましょう");
        break;
      }
      case "prev":
        pendingPhaseRef.current = { phase: Math.max(0, Number(i) - 1) };
        update({ p: Math.max(0, Number(i) - 1) });
        break;
      case "hint":
        update({ hint: Math.min(3, state.hint + 1) });
        break;
      case "repro":
        await observeService("vulnerable");
        break;
      case "rst":
        update({ repro: false, hint: 0 });
        break;
      case "pick":
        if (Number(i) <= state.pos) update({ pick: Number(i) });
        break;
      case "back":
        update({ pos: Math.max(0, state.pos - 1), pick: Math.max(0, state.pos - 1) });
        break;
      case "fwd":
        update({ pos: Math.min(5, state.pos + 1), pick: Math.min(5, state.pos + 1) });
        break;
      case "compare":
        if (v === "vulnerable" || v === "fixed") await compareMarker(v);
        break;
      case "deploy":
        update({ modal: "deploy", ok: false });
        break;
      case "mc":
        update({ modal: null });
        break;
      case "go-deploy":
        if (state.ok) await deployLab();
        break;
      case "stop":
        await stopLab();
        break;
      case "destroy":
        update({ modal: "destroy" });
        break;
      case "go-destroy":
        await destroyLab();
        break;
      case "copy":
        try {
          await navigator.clipboard.writeText(v ?? "");
          setMessage("コピーしました");
        } catch {
          setMessage("コピーできませんでした");
        }
        break;
      case "console":
        setConsoleOpen(true);
        break;
      case "close-console":
        setConsoleOpen(false);
        break;
      case "logs":
        if (v === "vulnerable" || v === "fixed") await showLogs(v);
        break;
      case "marker":
        if (v === "vulnerable" || v === "fixed") await readMarker(v);
        break;
    }
  };
}
