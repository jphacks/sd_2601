import type { LearnerState, SampleLesson } from "../../learner/lesson-data.ts";

type LessonOutlineProps = { state: LearnerState; lesson: SampleLesson; id?: string };

export function LessonOutline({ state: S, lesson, id = "lesson-outline" }: LessonOutlineProps) {
  return (
    <nav id={id} className="lesson-outline" aria-label="学習の流れ">
      <p className="outline-title">学習の流れ</p>
      <p className="outline-progress">
        {Object.keys(S.done).length} / {lesson.phases.length} ステップ完了
      </p>
      <ol>
        {lesson.phases.map((phase, i) => (
          <li key={phase[0]}>
            <button
              className={`outline-step ${S.done[i] ? "done" : ""}`}
              data-a="go"
              data-i={i}
              disabled={i > S.revealed}
              aria-current={i === S.p ? "step" : undefined}
              aria-controls={i <= S.revealed ? `phase-${i}` : undefined}
            >
              <span className="step-number" aria-hidden="true">
                {S.done[i] ? "✓" : i + 1}
              </span>
              <span>
                <b>{phase[0]}</b>
                <small>{phase[1]}</small>
              </span>
            </button>
          </li>
        ))}
      </ol>
      {lesson.id === "fb" && (
        <button className="btn" data-a="notes">
          {"まとめノートを見る"}
        </button>
      )}
    </nav>
  );
}
