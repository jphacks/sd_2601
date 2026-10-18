import type { LearnerState, SampleLesson } from "../../learner/lesson-data.ts";
import { endpointURL } from "../../shared/study-api.ts";

interface GenericLessonPhaseListProps {
  lesson: SampleLesson;
  state: LearnerState;
}

const instructions = [
  "Runnerが準備したローカルLabだけを対象にします。第三者のGitサーバー、任意のリポジトリ、ホスト上のファイルは対象にしません。",
  "上のDEPLOYでLabを準備・検査してから起動してください。表示された127.0.0.1の接続先だけを利用します。",
  "脆弱版の接続先を別タブで開き、/api/observe を追加して固定入力の結果を確認します。入力、本文、クエリは追加しません。",
  "固定参照 refs/heads/../../config が loose reference の保存先へ変換される過程を考えます。親ディレクトリ要素を許容すると、基準ディレクトリ外へ到達します。",
  "修正版の接続先でも /api/observe を開きます。同じ固定参照に対して result と configurationIntact が脆弱版とどう異なるか確認します。",
  "参照名をパスへ使う前に許可形式を検証し、基準ディレクトリから逸脱しないことを確認する回帰テストを整理します。",
];

const expected = [
  "固定入力だけを使う理由と、Labが一時ディレクトリ内で完結することを説明できる。",
  "脆弱版と修正版のサービスがrunningとなり、接続先がloopbackに限定されている。",
  "脆弱版では result が vulnerable、configurationIntact が false である。",
  "文字列の形式検証と、ファイルシステムの保存先検証が別の責務であることを説明できる。",
  "修正版では result が fixed、configurationIntact が true である。",
  "許可形式の検証、基準ディレクトリからの逸脱防止、設定ファイルが変わらない回帰テストを提案できる。",
];

export function GenericLessonPhaseList({ lesson, state }: GenericLessonPhaseListProps) {
  const endpoints = (state.runtime?.endpoints ?? [])
    .map((endpoint) => ({ ...endpoint, url: endpointURL(endpoint) }))
    .filter((endpoint) => endpoint.url);
  return (
    <div className="lesson-sections">
      {lesson.phases.slice(0, state.revealed + 1).map((phase, index) => (
        <section
          key={phase[0]}
          id={`phase-${index}`}
          data-phase={index}
          className="lesson-phase"
          aria-labelledby={`phase-title-${index}`}
        >
          <p className="phase-kicker">
            STEP {String(index + 1).padStart(2, "0")} / {lesson.phases.length}
          </p>
          <h2 className="ph" id={`phase-title-${index}`} tabIndex={-1}>
            {phase[0]}
          </h2>
          <p className="lead2">{phase[1]}</p>
          <div className="phase-body">
            <div className="card">
              <h3>やってみること</h3>
              <p>{instructions[index]}</p>
              <div className="reveal">
                <b>期待結果</b>
                <p>{expected[index]}</p>
              </div>
              {(index === 2 || index === 4) && (
                <div className="act">
                  {endpoints.length ? (
                    endpoints.map((endpoint) => (
                      <a
                        className="btn sm"
                        href={endpoint.url ?? undefined}
                        target="_blank"
                        rel="noopener noreferrer"
                        key={`${endpoint.service}:${endpoint.port}`}
                      >
                        {endpoint.service === "fixed" ? "修正版" : "脆弱版"}を別タブで開く ↗
                      </a>
                    ))
                  ) : (
                    <span className="console-empty">
                      上のDEPLOYでLabを起動すると接続先を開けます。
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
          <div className="nav">
            <button className="btn" data-a="prev" data-i={index} disabled={index === 0}>
              前の内容へ
            </button>
            <button
              className="btn primary"
              data-a="next"
              data-i={index}
              disabled={index === lesson.phases.length - 1 && state.done[index]}
            >
              {index === lesson.phases.length - 1
                ? state.done[index]
                  ? "学習を完了しました"
                  : "完了する"
                : `次へ：${lesson.phases[index + 1][0]} ↓`}
            </button>
          </div>
        </section>
      ))}
    </div>
  );
}
