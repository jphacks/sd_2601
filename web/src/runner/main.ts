import type {
  Assignment,
  Container,
  LabRef,
  LabSession,
  LabSnapshot,
  LabState,
  LearnerLesson,
  MarkerObservation,
  StudySession,
  VolumePolicy,
} from "../shared/types.ts";
import { requiredElement, errorMessage } from "../shared/dom.ts";
import "../shared/base.css";
import {
  ApiError,
  StudyApi,
  LESSON_ID,
  canStart,
  endpointURL,
  hasComparisonEndpoints,
  stateLabels,
} from "../shared/study-api.ts";
import { localRecord, saveLocal } from "../shared/storage.ts";

const api = new StudyApi(requiredElement<HTMLMetaElement>('meta[name="reprokit-session"]').content);
const app = requiredElement("#app");
const notice = requiredElement("#notice");
const errorBox = requiredElement("#error");
const dialog = requiredElement<HTMLDialogElement>("#confirmation");
type TextDraftKey =
  `prediction:${string}` | `observation:${string}` | `answer:${string}` | "reflection";
type Drafts = Partial<Record<TextDraftKey, string>> &
  Partial<Record<`predicted:${string}`, boolean>>;
interface SavedRecord {
  studyId?: string;
  bindings?: Partial<Record<LabRef, string>>;
  drafts?: Drafts;
}
interface MenuItem {
  id: string;
  title: string;
  index?: number;
}
const labRefs: LabRef[] = ["vulnerable", "fixed"];
let lesson: LearnerLesson;
let study: StudySession | undefined;
let training: { assignment?: Assignment } = {};
let storageKey: string;
let drafts: Drafts = {};
let bindings: Partial<Record<LabRef, string>> = {};
let labs: Partial<Record<LabRef, LabSnapshot>> = {};
let labErrors: Partial<Record<LabRef, string>> = {};
let markers: Partial<Record<LabRef, MarkerObservation>> = {};
let resumeId: string | undefined;

function currentStudy(): StudySession {
  if (!study) throw new Error("受講セッションがありません。");
  return study;
}

let generation = 0,
  polling = false;
let page = "overview",
  busy = false,
  loadFailed = false;
const requestedLessonID = (() => {
  const values = new URLSearchParams(window.location.search).getAll("lessonId");
  if (values.length === 0) return LESSON_ID;
  if (
    values.length !== 1 ||
    !/^[a-z0-9][a-z0-9._-]{0,62}\/[a-z0-9][a-z0-9._-]{0,62}$/.test(values[0])
  )
    return null;
  return values[0];
})();
const titles = { vulnerable: "脆弱版", fixed: "修正版" };
const escape = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  );
const list = (values: string[]) =>
  `<ul>${values.map((value) => `<li>${escape(value)}</li>`).join("")}</ul>`;
const button = (id: string, text: string, attrs = "") =>
  `<button id="${id}" ${attrs}>${text}</button>`;
const text = (value: unknown) => `<p>${escape(value)}</p>`;

function announce(message: string) {
  notice.textContent = message;
}
function showError(error: unknown) {
  errorBox.hidden = false;
  errorBox.textContent = `${errorMessage(error)} 操作結果が不明な場合は「状態を更新する」で確認してください。`;
}
function persist() {
  if (!saveLocal(storageKey, { studyId: study?.id ?? resumeId, bindings, drafts })) {
    errorBox.hidden = false;
    errorBox.textContent =
      "ブラウザに保存できません。このタブを閉じる前に回答を保存してください。Lab Session IDも控えてください。";
  }
}
function stepIndex(id: string) {
  return lesson.spec.steps.findIndex((step) => step.id === id);
}
function menu(): MenuItem[] {
  const steps = lesson.spec.steps.filter((step) => step.id !== "cleanup");
  return [
    { id: "overview", title: "教材と学習目標" },
    ...steps.map((step) => ({ id: step.id, title: step.title, index: stepIndex(step.id) })),
    { id: "comparison", title: "原因・修正を比較する" },
    { id: "assessment", title: "確認課題に回答する" },
    { id: "cleanup", title: "Labを片付ける", index: stepIndex("cleanup") },
    { id: "reflection", title: "振り返りを記録する" },
  ];
}
function unlocked(item: MenuItem) {
  if (item.id === "overview") return true;
  if (!study) return false;
  if (item.id === "reflection") return currentStudy().stepIndex >= lesson.spec.steps.length;
  if (item.index !== undefined) return item.index <= currentStudy().stepIndex;
  return currentStudy().stepIndex >= stepIndex("cleanup");
}

function render(focusId?: string) {
  if (!lesson) return;
  const items = menu();
  const active = items.find((item) => item.id === page);
  app.innerHTML = `
    <div class="lesson-header"><div><p class="eyebrow">実在事例で学ぶ / ${escape(lesson.spec.case.product)}</p>
      <h1>${escape(lesson.metadata.title)}</h1>
      <p class="muted">${lesson.spec.durationMinutes}分 · 開発者向け · 教材 v${escape(lesson.metadata.version)} · 研修状態: ${escape(training.assignment?.status ?? "未割り当て")}</p></div>
      <div class="progress-summary"><span>学習手順の記録</span><strong>${study?.stepIndex ?? 0}<small> / ${lesson.spec.steps.length}</small></strong><progress aria-label="学習手順の進捗" max="${lesson.spec.steps.length}" value="${study?.stepIndex ?? 0}"></progress></div></div>
    <div class="workspace">
      <nav class="lesson-nav" aria-label="学習の順序"><p class="eyebrow">学習の流れ</p><ol>${items.map((item, index) => `<li><button id="nav-${item.id}" data-page="${item.id}" ${unlocked(item) ? "" : "disabled"} ${page === item.id ? 'aria-current="step"' : ""}><span class="step-number">${String(index + 1).padStart(2, "0")}</span><span>${escape(item.title)}</span></button></li>`).join("")}</ol></nav>
      <main id="content" tabindex="-1"><section class="card lesson-card" aria-labelledby="page-title"><p class="eyebrow">${page === "overview" ? "LESSON OVERVIEW" : "LEARNING WORKSPACE"}</p><h2 id="page-title" tabindex="-1">${escape(active?.title)}</h2>${content()}</section></main>
      <aside id="labs" aria-label="ローカルLabの状態">${labPanel()}</aside>
    </div>
    <footer>Reprokit · 学習記録とLabの実行状態は別に管理されます。回答の保存は理解度の合格判定ではありません。</footer>`;
  bindEvents();
  if (focusId) document.getElementById(focusId)?.focus({ preventScroll: true });
}

function content() {
  const spec = lesson.spec;
  if (page === "overview")
    return `
    <p class="lead">${escape(spec.case.background)}</p>
    <h3>この教材で身につけること</h3>${list(spec.objectives)}
    <div class="info-grid"><div><h3>対象者</h3>${text(spec.audience)}</div><div><h3>前提知識</h3>${list(spec.prerequisites)}</div></div>
    <div class="callout"><h3>演習はローカルLab限定です</h3><p>Runnerが返した127.0.0.1の接続先だけを使ってください。Dockerは完全な隔離境界ではありません。準備操作だけではLabは起動しません。</p></div>
    <details><summary>対象バージョン・出典・ライセンスを確認する</summary>${text(spec.case.affectedVersions)}${text(spec.evidence.cves.join(" / "))}<ul>${spec.evidence.references.map((reference) => `<li>${safeLink(reference.url, reference.title)}</li>`).join("")}</ul>${text(`${spec.license.name} — ${spec.license.attribution}`)}</details>
    <div class="actions">${button("begin", resumeId && !study ? "受講状態を再取得する" : study ? "学習を再開する" : "学習を始める", 'class="primary"')}</div>`;
  if (page === "comparison")
    return `
    <h3>原因</h3>${text(spec.analysis.cause)}<h3>影響</h3>${text(spec.analysis.impact)}
    <div class="comparison"><section><span class="tag">脆弱版</span>${text(spec.comparison.vulnerable)}</section><section><span class="tag fixed">修正版</span>${text(spec.comparison.fixed)}</section></div>
    <h3>修正で変わったこと</h3>${text(spec.comparison.difference)}${text(spec.analysis.remediation)}
    <h3>再発を防ぐために</h3>${list(spec.prevention)}
    ${spec.evidence.references
      .filter((reference) => reference.type === "patch")
      .map((reference) => safeLink(reference.url, "公式の修正差分を確認する ↗"))
      .join("")}
    ${navigation("assessment", "確認課題へ進む")}`;
  if (page === "assessment")
    return `
    <p>観察できたことと未確認のことを分け、原因と対策を自分の言葉で説明してください。回答はこの端末の受講セッションAPIへ保存します。</p>
    ${spec.assessment
      .map((question, index) => {
        const answer = drafts[`answer:${question.id}`] ?? currentStudy().answers[question.id] ?? "";
        return `<section class="question"><label for="answer-${question.id}"><strong>問${index + 1}</strong> ${escape(question.question)}</label><textarea id="answer-${question.id}" data-draft="answer:${question.id}" rows="5" maxlength="12000">${escape(answer)}</textarea><div class="answer-status">${currentStudy().answers[question.id] === answer && answer.trim() ? "API保存済み" : "未保存の回答"}</div></section>`;
      })
      .join("")}
    <div class="actions">${button("save-answers", "回答を保存する", 'class="primary"')}</div>
    ${navigation("cleanup", "後片付けへ進む")}`;
  if (page === "reflection")
    return `
    <div class="callout"><h3>学習手順を記録しました</h3><p>Labの起動や回答保存だけでは研修修了と判定しません。未確認の観察がある場合は、研修担当者へ共有してください。</p></div>
    <h3>確認課題の保存</h3>${text(spec.assessment.every((question) => currentStudy().answers[question.id]?.trim()) ? "全問の回答がAPIに保存されています。" : "未回答の課題があります。確認課題の画面で保存してください。")}
    <h3>Labの後片付け</h3>${text(cleanupSummary())}
    <label for="reflection">開発やコードレビューで次に確認すること</label><textarea id="reflection" data-draft="reflection" rows="5">${escape(drafts.reflection ?? "")}</textarea>
    <p class="muted">振り返りはこのブラウザの下書きに保存します。</p>${button("save-reflection", "振り返りを記録する", 'class="primary"')}`;
  const step = spec.steps.find((step) => step.id === page);
  if (!step) throw new Error("学習ステップが見つかりません。");
  const predicted = drafts[`predicted:${page}`];
  const observed = drafts[`observation:${page}`] ?? "";
  const revealed = currentStudy().hints?.[page] ?? [];
  const markerRef =
    lesson.metadata.id === LESSON_ID
      ? page === "observe-marker"
        ? "vulnerable"
        : page === "compare-fixed"
          ? "fixed"
          : null
      : null;
  return `
    ${step.labRef ? `<span class="tag ${step.labRef === "fixed" ? "fixed" : ""}">対象：${titles[step.labRef]}</span>` : ""}
    <h3>手順</h3>${text(step.instruction)}
    ${
      page === "cleanup"
        ? `<div class="callout"><h3>停止・削除・残存確認</h3><p>${escape(cleanupSummary())}</p><p>右のLabカードで各Sessionを停止し、Volume方針を確認して削除します。「状態を更新する」で残存を再確認してください。</p></div>`
        : `
      <label for="prediction">結果を予想する</label><textarea id="prediction" data-draft="prediction:${page}" rows="3" placeholder="何が起きるか、どこを観察するかを書いてください。">${escape(drafts[`prediction:${page}`] ?? "")}</textarea>
      ${button("record-prediction", predicted ? "予想を記録し直す" : "予想を記録して期待結果を開く")}
      ${predicted ? `<div class="expected"><h3>期待結果</h3>${text(step.expectedResult)}<h3>観察のポイント</h3>${text(step.observation)}</div>` : ""}
    `
    }
    ${markerRef ? markerPanel(markerRef) : ""}
    <section class="hints" aria-label="段階的なヒント"><h3>考えるためのヒント <small>${revealed.length} / ${step.hintCount}</small></h3>${revealed.length ? list(revealed) : '<p class="muted">必要になったら、一つずつ開けます。</p>'}${button("hint", "次のヒントを開く", revealed.length >= step.hintCount ? "disabled" : "")}</section>
    <label for="observation">${page === "cleanup" ? "後片付けの確認メモ" : "観察メモ"}</label><textarea id="observation" data-draft="observation:${page}" rows="4" placeholder="確認した結果、予想との差、未確認の事項を記録してください。">${escape(observed)}</textarea>
    <p class="muted">予想とメモはこのブラウザに下書き保存します。</p>
    <div class="actions">${button("previous", "前の画面へ戻る")}${button("next", "メモを記録して次へ進む", 'class="primary"')}</div>`;
}

function markerPanel(ref: LabRef) {
  const marker = markers[ref];
  const lab = labs[ref];
  const ready = lab?.state === "running";
  const result = !marker
    ? "固定の/tmp/successだけを確認します。任意のパスやコマンドはRunnerへ渡しません。"
    : marker.exists
      ? `マーカーを確認しました。内容: ${escape(marker.content)}`
      : "マーカーはありません。修正版ではこの結果が期待値です。";
  return `<div class="callout ${marker?.exists ? "" : "warning"}"><h3>マーカーを観察する</h3><p>${result}</p>${button(`observe-${ref}`, `${titles[ref]}のマーカーを確認する`, `data-lab="${ref}" data-operation="marker" ${ready ? "" : "disabled"}`)}</div>`;
}

function safeLink(url: string, title: string) {
  try {
    if (new URL(url).protocol === "https:")
      return `<a href="${escape(url)}" target="_blank" rel="noopener noreferrer">${escape(title)}</a>`;
  } catch {
    /* 不正な出典URLはリンクにしない。 */
  }
  return escape(title);
}
function navigation(target: string, label: string) {
  return `<div class="actions">${button("previous", "前の画面へ戻る")}${button(`go-${target}`, label, `class="primary" data-page="${target}"`)}</div>`;
}
function cleanupSummary() {
  const values = Object.values(labs);
  if (!values.length)
    return "このブラウザにはLab Sessionの記録がありません。未準備と、他のブラウザでの起動は区別してください。";
  if (values.every((lab) => lab.state === "deleted") && !Object.values(labErrors).some(Boolean))
    return "記録されたSessionは削除済みです。残存リソースと保持VolumeはLabカードで確認してください。";
  return "削除済みと確認できていないSessionがあります。Labカードで状態と残存リソースを確認してください。";
}

function labPanel() {
  return `<div class="lab-panel-heading"><p class="eyebrow">LOCAL LAB RUNNER</p><h2>演習環境</h2><p>準備 → 安全性確認 → 明示起動</p></div>${lesson.spec.labs.map((reference) => labCard(reference.ref)).join("")}`;
}
function labCard(ref: LabRef) {
  const lab = labs[ref],
    state = lab?.state ?? "absent";
  const id = lab?.labSessionId;
  const active = ["running", "error"].includes(state);
  const transient = ["preparing", "starting", "stopping", "deleting"].includes(state);
  const primaryFirst = ref === "fixed" && sameComparisonLab() && !bindings.vulnerable;
  const shared =
    lab && Object.entries(bindings).some(([other, value]) => other !== ref && value === id);
  const endpoints = (lab?.endpoints ?? [])
    .filter((endpoint) => !shared || endpoint.service === ref)
    .map((endpoint) => {
      const url = endpointURL(endpoint);
      return url
        ? `<li>${escape(endpoint.service)}: ${state === "running" && !labErrors[ref] ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${url} ↗</a>` : escape(url)}</li>`
        : `<li>安全なloopback接続先として確認できません。</li>`;
    })
    .join("");
  return `<section class="card lab-card" aria-labelledby="lab-title-${ref}"><div class="lab-heading"><h3 id="lab-title-${ref}">${titles[ref]}</h3><span class="state state-${escape(state)}">${escape(stateLabels[state] ?? "状態不明")} <small>(${escape(state)})</small></span></div>
    ${id ? `<p class="session-id">Session <code>${escape(id)}</code></p>` : '<p class="muted">まだ環境を準備していません。</p>'}
    ${shared ? '<p class="muted">両版は同じ比較Lab Sessionです。起動・停止・削除は両方に適用されます。</p>' : ""}
    ${primaryFirst ? '<p class="muted">最初に脆弱版の準備操作で比較Labを取得してください。</p>' : ""}
    ${lab ? `<dl class="safety"><div><dt>安全性検査</dt><dd>${lab.safetyChecked === true ? "検査済み" : "未確認"}</dd></div><div><dt>外部への公開</dt><dd>${lab.externalExposure === false ? "なし" : "未確認・起動不可"}</dd></div></dl>${endpoints ? `<h4>Runnerの接続先</h4><ul class="endpoints">${endpoints}</ul>` : ""}` : ""}
    ${lab?.failure ? `<div class="callout warning"><strong>${escape(lab.failure.operation)}の失敗</strong>${text(lab.failure.message)}<p>再試行可否の情報はRunnerから提供されていません。状態更新後、停止・削除を確認してください。</p></div>` : ""}
    ${labErrors[ref] ? `<div class="callout warning" role="alert">${escape(labErrors[ref])}<p>最新状態は未確認です。新たに準備せず、状態を更新してください。</p></div>` : ""}
    <div class="lab-actions">
      ${button(`prepare-${ref}`, "Labを準備する", `data-lab="${ref}" data-operation="prepare" ${!study || primaryFirst || (id && state !== "deleted") ? "disabled" : ""}`)}
      ${button(`start-${ref}`, "安全性を確認して起動する", `class="primary" data-lab="${ref}" data-operation="start" ${canStart(lab) && !labErrors[ref] ? "" : "disabled"}`)}
      ${button(`stop-${ref}`, "Labを停止する", `data-lab="${ref}" data-operation="stop" ${id && active ? "" : "disabled"}`)}
      ${button(`refresh-${ref}`, "状態を更新する", `data-lab="${ref}" data-operation="status" ${id ? "" : "disabled"}`)}
      ${button(`delete-${ref}`, "Labを削除する", `class="danger" data-lab="${ref}" data-operation="delete" ${id && !transient && state !== "deleted" ? "" : "disabled"}`)}
    </div>
    ${lab ? resourceView(lab) : ""}
  </section>`;
}
function resourceView(lab: LabSnapshot) {
  const resources = lab.resources;
  if (!resources) return '<p class="muted">残存リソースは未取得です。</p>';
  const names = (values?: (string | Container)[]) =>
    values?.length
      ? values
          .map((value) => (typeof value === "string" ? value : `${value.name} (${value.state})`))
          .join(", ")
      : "なし";
  return `<details ${lab.state === "deleted" ? "open" : ""}><summary>残存リソースを確認する</summary><dl class="resources"><dt>コンテナ</dt><dd>${escape(names(resources.containers))}</dd><dt>ネットワーク</dt><dd>${escape(names(resources.networks))}</dd><dt>Volume</dt><dd>${escape(names(resources.volumes))}</dd><dt>保持したVolume</dt><dd>${escape(names(lab.retainedVolumes))}</dd></dl><p class="muted">公開ポートはコンテナに付随します。コンテナが残る場合、ポートの解放は未確認です。</p></details>`;
}

async function perform(task: () => Promise<void>, focusId: string, labsOnly = false) {
  if (busy) return;
  busy = true;
  generation++;
  errorBox.hidden = true;
  const controls = [
    ...app.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement>(
      labsOnly ? "button" : "button, textarea",
    ),
  ].map((control) => [control, control.disabled] as const);
  controls.forEach(([control]) => {
    control.disabled = true;
  });
  announce("処理しています…");
  try {
    await task();
  } catch (error) {
    showError(error);
    announce("処理に失敗しました。");
  } finally {
    busy = false;
    if (labsOnly) {
      controls.forEach(([control, disabled]) => {
        if (control.isConnected) control.disabled = disabled;
      });
      renderLabs(focusId);
    } else render(focusId);
  }
}
function navigate(target?: string) {
  if (
    !target ||
    busy ||
    !unlocked(menu().find((item) => item.id === target) ?? { id: "", title: "" })
  )
    return;
  page = target;
  render("page-title");
}
function bindEvents() {
  app
    .querySelectorAll<HTMLElement>("[data-page]")
    .forEach((control) => control.addEventListener("click", () => navigate(control.dataset.page)));
  app.querySelectorAll<HTMLTextAreaElement>("[data-draft]").forEach((control) =>
    control.addEventListener("input", () => {
      drafts[control.dataset.draft as TextDraftKey] = control.value;
      persist();
    }),
  );
  app
    .querySelectorAll<HTMLElement>("[data-operation]")
    .forEach((control) =>
      control.addEventListener("click", () =>
        labAction(control.dataset.lab, control.dataset.operation),
      ),
    );
  document.querySelector<HTMLElement>("#begin")?.addEventListener("click", () =>
    perform(async () => {
      if (!study) {
        study = resumeId ? await api.study(resumeId) : await api.create(lesson.metadata.version);
        if (
          study.lessonId !== lesson.metadata.id ||
          study.lessonVersion !== lesson.metadata.version
        )
          throw new Error("受講セッションの教材が一致しません。");
        resumeId = undefined;
        persist();
      }
      if (training.assignment) training.assignment = await api.startTraining();
      const index = Math.min(currentStudy().stepIndex, lesson.spec.steps.length - 1);
      page = lesson.spec.steps[index].id;
      announce("受講セッションを読み込みました。");
    }, "page-title"),
  );
  document.querySelector<HTMLElement>("#previous")?.addEventListener("click", () => {
    const items = menu();
    navigate(items[Math.max(0, items.findIndex((item) => item.id === page) - 1)].id);
  });
  document.querySelector<HTMLElement>("#record-prediction")?.addEventListener("click", () => {
    if (!drafts[`prediction:${page}`]?.trim()) {
      announce("先に予想を入力してください。");
      requiredElement("#prediction").focus();
      return;
    }
    drafts[`predicted:${page}`] = true;
    persist();
    render("record-prediction");
    announce("予想を記録し、期待結果を開きました。");
  });
  document.querySelector<HTMLElement>("#hint")?.addEventListener("click", () =>
    perform(async () => {
      study = await api.hint(currentStudy().id, page);
      announce("次のヒントを開きました。");
    }, "hint"),
  );
  document.querySelector<HTMLElement>("#next")?.addEventListener("click", () => {
    if (!drafts[`observation:${page}`]?.trim()) {
      announce("確認した結果または未確認の事項をメモしてください。");
      requiredElement("#observation").focus();
      return;
    }
    perform(async () => {
      if (stepIndex(page) === currentStudy().stepIndex)
        study = await api.advance(currentStudy().id);
      persist();
      const items = menu();
      page = items[items.findIndex((item) => item.id === page) + 1].id;
      announce("メモと進捗を記録しました。");
    }, "page-title");
  });
  document.querySelector<HTMLElement>("#save-answers")?.addEventListener("click", () =>
    perform(async () => {
      for (const question of lesson.spec.assessment) {
        const answer = drafts[`answer:${question.id}`] ?? currentStudy().answers[question.id] ?? "";
        if (!answer.trim()) throw new Error("全問に回答を入力してください。");
        if (new TextEncoder().encode(answer).length > 16384)
          throw new Error("回答が長すぎます。1問あたりUTF-8で16KB以内にしてください。");
      }
      for (const question of lesson.spec.assessment)
        study = await api.answer(
          currentStudy().id,
          question.id,
          drafts[`answer:${question.id}`] ?? currentStudy().answers[question.id],
        );
      if (training.assignment && ["assigned", "needs_retry"].includes(training.assignment.status))
        training.assignment = await api.startTraining();
      if (training.assignment?.status === "in_progress") {
        await api.submitTraining(currentStudy().id);
        training = await api.trainingAssignment();
      }
      announce("全問の回答を提出しました。理解度の評価は研修担当者が行います。");
    }, "save-answers"),
  );
  document.querySelector<HTMLElement>("#save-reflection")?.addEventListener("click", () => {
    persist();
    announce("振り返りをこのブラウザに記録しました。");
  });
}

function confirm(title: string, body: string, label: string): Promise<boolean> {
  requiredElement("#dialog-title").textContent = title;
  requiredElement("#dialog-body").innerHTML = body;
  requiredElement("#dialog-confirm").textContent = label;
  dialog.returnValue = "cancel";
  dialog.showModal();
  return new Promise<boolean>((resolve) =>
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), {
      once: true,
    }),
  );
}

async function labAction(ref: string | undefined, operation: string | undefined) {
  if (ref !== "vulnerable" && ref !== "fixed") return;
  if (!operation || !["prepare", "start", "stop", "delete", "marker", "status"].includes(operation))
    return;
  if (busy) return;
  const current = labs[ref];
  const shared =
    current &&
    Object.entries(bindings).some(
      ([other, value]) => other !== ref && value === current.labSessionId,
    );
  const target = shared ? "脆弱版・修正版の比較Lab" : titles[ref];
  const prepareRef =
    operation === "prepare" && ref === "fixed" && shared && sameComparisonLab()
      ? "vulnerable"
      : ref;
  let policy: VolumePolicy = "retain";
  if (operation === "start") {
    if (!canStart(current) || labErrors[ref]) return;
    if (
      !(await confirm(
        `${target}を起動しますか`,
        `<p>安全性検査済み・外部公開なしを確認しました。起動時にもRunnerが再検査します。Dockerは完全な隔離境界ではありません。</p><p>対象Session: <code>${escape(current?.labSessionId)}</code></p>`,
        "確認してLabを起動する",
      ))
    )
      return;
  }
  if (operation === "delete") {
    if (
      !(await confirm(
        `${target}を削除しますか`,
        `<p>対象Session: <code>${escape(current?.labSessionId)}</code></p><label for="volume-policy">Volumeの削除方針</label><select id="volume-policy"><option value="retain">Volumeを保持する</option><option value="delete">Volumeも削除する</option></select><p>回答と学習メモはLab削除後も保持します。</p>`,
        "方針を確認してLabを削除する",
      ))
    )
      return;
    policy =
      requiredElement<HTMLSelectElement>("#volume-policy").value === "delete" ? "delete" : "retain";
  }
  await perform(
    async () => {
      const id = current?.labSessionId;
      if (["prepare", "start", "stop", "delete"].includes(operation)) {
        const transient = (
          {
            prepare: "preparing",
            start: "starting",
            stop: "stopping",
            delete: "deleting",
          } as Record<string, LabState>
        )[operation];
        requiredElement(".state", requiredElement(`#lab-title-${ref}`).parentElement!).textContent =
          `${stateLabels[transient]} (${transient})`;
        announce(`${titles[ref]}: ${stateLabels[transient]}`);
      }
      try {
        if (operation === "prepare") {
          const reference = await api.binding(currentStudy().id, prepareRef);
          if (
            reference.lessonId !== lesson.metadata.id ||
            reference.lessonVersion !== lesson.metadata.version ||
            reference.labRef !== prepareRef
          )
            throw new Error("受講セッションのLab参照が一致しません。");
        }
        if (operation !== "prepare" && !id) throw new Error("Lab Sessionがありません。");
        if (operation === "marker") {
          const value = await api.marker(id!, ref);
          markers[ref] = value;
          announce(`${titles[ref]}: ${value.exists ? "マーカーあり" : "マーカーなし"}`);
        } else {
          const value =
            operation === "prepare"
              ? await api.prepare(lesson.metadata.version, prepareRef)
              : operation === "start"
                ? await api.start(id!)
                : operation === "stop"
                  ? await api.stop(id!)
                  : operation === "delete"
                    ? await api.delete(id!, policy)
                    : await api.status(id!);
          rememberLab(ref, value);
          announce(`${titles[ref]}: ${stateLabels[value.state] ?? value.state}`);
        }
        delete labErrors[ref];
      } catch (error) {
        if (error instanceof ApiError && error.session?.labSessionId)
          rememberLab(ref, error.session);
        labErrors[ref] = errorMessage(error);
        throw error;
      }
    },
    `${operation === "prepare" ? "start" : "refresh"}-${ref}`,
    operation !== "marker" && !["observe-marker", "compare-fixed"].includes(page),
  );
}
function rememberLab(ref: LabRef, value: LabSession) {
  if (
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value?.labSessionId) ||
    (bindings[ref] && labs[ref]?.state !== "deleted" && bindings[ref] !== value.labSessionId)
  )
    throw new Error("Runnerが異なるSessionを返しました。");
  bindings[ref] = value.labSessionId;
  if (sameComparisonLab() && hasComparisonEndpoints(value)) {
    for (const other of labRefs) {
      if (!bindings[other] || labs[other]?.state === "deleted")
        bindings[other] = value.labSessionId;
    }
  }
  for (const target of labRefs) {
    if (bindings[target] === value.labSessionId) {
      labs[target] = value;
      delete labErrors[target];
    }
  }
  persist();
}

function sameComparisonLab() {
  const vulnerable = lesson.spec.labs.find((lab) => lab.ref === "vulnerable");
  return (
    vulnerable && vulnerable.labId === lesson.spec.labs.find((lab) => lab.ref === "fixed")?.labId
  );
}

async function load() {
  errorBox.hidden = true;
  try {
    if (!requestedLessonID) throw new Error("教材リンクが正しくありません。");
    const catalog = await api.lessons();
    const summary = catalog.find((item) => item.id === requestedLessonID);
    if (!summary) throw new Error("指定された教材は公開されていません。");
    api.selectLesson(summary.id);
    lesson = await api.detail(summary.version);
    training = await api.trainingAssignment();
    if (
      lesson.metadata.id !== summary.id ||
      lesson.metadata.version !== summary.version ||
      !lesson.spec.labs.every((lab) => ["vulnerable", "fixed"].includes(lab.ref))
    )
      throw new Error("未対応の教材またはLab参照です。");
    if (
      training.assignment?.lessonId !== lesson.metadata.id ||
      training.assignment?.lessonVersion !== lesson.metadata.version
    )
      training = {};
    storageKey = `${lesson.metadata.id}@${lesson.metadata.version}`;
    const record = localRecord<SavedRecord>(storageKey, {});
    drafts = record.drafts ?? {};
    bindings = record.bindings ?? {};
    if (record.studyId) {
      resumeId = record.studyId;
      try {
        study = await api.study(record.studyId);
        if (
          study.lessonId !== lesson.metadata.id ||
          study.lessonVersion !== lesson.metadata.version
        )
          throw new Error("保存された受講セッションの教材が一致しません。");
      } catch (error) {
        study = undefined;
        if (error instanceof ApiError && error.status === 404) resumeId = undefined;
        showError(error);
      }
    }
    for (const ref of labRefs) {
      if (!bindings[ref]) continue;
      try {
        rememberLab(ref, await api.status(bindings[ref]!));
      } catch (error) {
        labs[ref] = { labSessionId: bindings[ref], state: "error" };
        labErrors[ref] = errorMessage(error);
      }
    }
    loadFailed = false;
    render();
    announce("教材を読み込みました。Labは自動起動しません。");
  } catch (error) {
    loadFailed = true;
    showError(error);
    app.innerHTML = `<main id="content" class="card loading"><h1>教材に接続できません</h1><p>ローカルRunnerと教材APIが起動しているか確認してください。</p>${button("retry-load", "接続を再試行する", 'class="primary"')}</main>`;
    requiredElement("#retry-load").addEventListener("click", load);
  }
}

// 自動更新は状態取得だけに限定し、準備・起動・停止・削除を実行しない。
setInterval(async () => {
  if (busy || polling || loadFailed || !lesson || document.hidden || dialog.open) return;
  const started = generation;
  polling = true;
  try {
    for (const ref of labRefs) {
      if (!bindings[ref] || labs[ref]?.state === "deleted") continue;
      try {
        const previousState = labs[ref]?.state;
        const value = await api.status(bindings[ref]!);
        if (busy || generation !== started) return;
        rememberLab(ref, value);
        delete labErrors[ref];
        if (previousState !== value.state)
          announce(`${titles[ref]}: ${stateLabels[value.state] ?? value.state}`);
      } catch (error) {
        if (busy || generation !== started) return;
        labErrors[ref] = errorMessage(error);
      }
    }
    if (busy || dialog.open) return;
    renderLabs();
  } finally {
    polling = false;
  }
}, 5000);

// Lab応答で本文を再描画すると入力中のメモを失うため、更新をLab領域に閉じる。
function renderLabs(focusId?: string) {
  const activeId = document.activeElement?.id;
  const editing = document.activeElement?.matches("textarea, select");
  requiredElement("#labs").innerHTML = labPanel();
  document
    .querySelectorAll<HTMLElement>("[data-operation]")
    .forEach((control) =>
      control.addEventListener("click", () =>
        labAction(control.dataset.lab, control.dataset.operation),
      ),
    );
  if (editing) return;
  if (focusId) document.getElementById(focusId)?.focus();
  else if (activeId?.match(/^(prepare|start|stop|refresh|delete)-/))
    document.getElementById(activeId)?.focus();
}

load();
