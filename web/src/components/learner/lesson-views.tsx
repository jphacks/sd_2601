import type { LearnerState, SampleLesson } from "../../learner/lesson-data.ts";
import { useEffect, useRef } from "react";
import { LessonEnvironment } from "./lesson-environment.tsx";
import { GenericLessonPhaseList } from "./generic-lesson-phases.tsx";
import { LessonOutline } from "./lesson-outline.tsx";
import { LessonPhaseList } from "./lesson-phase-list.tsx";

export function LessonDetail({
  state: S,
  lesson,
  onPhaseChange,
}: {
  state: LearnerState;
  lesson: SampleLesson;
  onPhaseChange: (phase: number) => void;
}) {
  const detail = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = detail.current;
    if (!container) return;
    let frame = 0;
    const updatePosition = () => {
      const bounds = container.getBoundingClientRect();
      const top = Math.max(0, bounds.top) + Math.min(window.innerHeight * 0.25, 160);
      let phase = -1;
      for (const section of container.querySelectorAll<HTMLElement>("[data-phase]")) {
        if (section.getBoundingClientRect().top <= top) phase = Number(section.dataset.phase);
      }
      onPhaseChange(phase);
    };
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(updatePosition);
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      cancelAnimationFrame(frame);
      container.removeEventListener("scroll", onScroll);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [onPhaseChange]);

  return (
    <div className="detail" ref={detail}>
      <div className="lesson-layout">
        <button className="back lesson-back" data-a="home">
          ← 教材一覧へ戻る
        </button>
        <LessonOutline state={S} lesson={lesson} />
        <div className="in">
          <h1 className="t">{lesson.title}</h1>
          <div className="facts" style={{ marginTop: "8px" }}>
            <div>
              <span>{"CVE"}</span>
              {lesson.cve}
            </div>
            <div>
              <span>{"製品"}</span>
              {lesson.product}
            </div>
            <div>
              <span>{"Labの出どころ"}</span>
              {lesson.src}
              {"（"}
              {lesson.sha}
              {"）"}
            </div>
          </div>
          <LessonEnvironment state={S} />
          <div className="pro">
            <h2>{"概要"}</h2>
          </div>
          <div className="prb">
            {lesson.overview.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
            <p>
              <b>{"Labの画面は別タブで開きます。"}</b>
              {"実在のサイトには試さないでください。"}
            </p>
          </div>
          <div className="nav overview-actions">
            <button className="btn primary" data-a="begin">
              {S.revealed < 0 ? "学習を開始する ↓" : "Step 1を読み返す ↓"}
            </button>
          </div>
          {lesson.id === "fb" ? (
            <LessonPhaseList lesson={lesson} state={S} />
          ) : (
            <GenericLessonPhaseList lesson={lesson} state={S} />
          )}
        </div>
      </div>
    </div>
  );
}
