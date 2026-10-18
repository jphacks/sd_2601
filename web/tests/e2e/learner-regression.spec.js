import { test, expect } from "@playwright/test";
import { mockRunner } from "./fixture.js";

const openButton = (page) => page.locator('[data-a="open"][data-v="fb"]');

async function openLesson(page, options = {}) {
  const fixture = await mockRunner(page, options);
  await page.goto("/");
  await openButton(page).click();
  return fixture;
}

async function beginLesson(page) {
  await page.getByRole("button", { name: "学習を開始する ↓", exact: true }).click();
  await expect(page.locator("#phase-0")).toBeVisible();
}

async function deployLab(page) {
  await page.locator('[data-a="deploy"]').click();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "起動する", exact: true }).click();
  await expect(page.locator(".st")).toHaveText("RUNNING");
}

test("教材一覧は分野ごとの件数を表示する", async ({ page }) => {
  await mockRunner(page);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "すべて 2", exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "コマンドインジェクション 1", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "パストラバーサル 1", exact: true })).toBeVisible();
});

test("コマンドインジェクションで教材を絞り込める", async ({ page }) => {
  await mockRunner(page);
  await page.goto("/");
  await page.getByRole("button", { name: "コマンドインジェクション 1", exact: true }).click();
  await expect(page.locator(".lcard")).toHaveCount(1);
  await expect(openButton(page)).toContainText("File Browser");
});

test("公開済みのgo-git教材を開ける", async ({ page }) => {
  await mockRunner(page);
  await page.goto("/");
  await page.getByRole("button", { name: "パストラバーサル 1", exact: true }).click();
  const goGit = page.locator('[data-a="open"][data-v="gg"]');
  await expect(goGit).toBeEnabled();
  await expect(goGit).toContainText("go-git");
  await goGit.click();
  await expect(page.getByRole("heading", { name: "go-git", exact: true })).toBeVisible();
});

test("教材詳細にCVEとLabの固定参照を表示する", async ({ page }) => {
  await openLesson(page);
  await expect(page.getByRole("heading", { name: "File Browser", exact: true })).toBeVisible();
  await expect(page.locator(".facts")).toContainText("CVE-2026-54088");
  await expect(page.locator(".facts")).toContainText("fork追加Lab");
});

test("go-gitもFile Browserと同じ受講レイアウトとLab操作を使う", async ({ page }) => {
  const fixture = await mockRunner(page, { lesson: "go-git" });
  await page.goto("/");
  await page.locator('[data-a="open"][data-v="gg"]').click();

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "go-git", exact: true })).toBeVisible();
  await expect(page.locator("#lesson-outline")).toBeVisible();
  await expect(page.locator(".tm")).toContainText("演習環境");
  await expect(page.getByRole("button", { name: "▶ DEPLOY" })).toBeVisible();
  await page.getByRole("button", { name: "▶ DEPLOY" }).click();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "起動する", exact: true }).click();
  await expect(page.locator(".st")).toHaveText("RUNNING");
  await expect(page.locator('a[href="http://127.0.0.1:18082"]')).toBeVisible();
  expect(
    fixture.calls.some(
      (call) =>
        call.path === "/api/labs" && call.body.lessonId === "path-traversal/go-git-loose-reference",
    ),
  ).toBeTruthy();
});

test("教材詳細では実在サイトに試さない注意を表示する", async ({ page }) => {
  await openLesson(page);
  await expect(page.locator(".prb")).toContainText("実在のサイトには試さないでください。");
});

test("学習開始前は最初の章だけが選択可能である", async ({ page }) => {
  await openLesson(page);
  const steps = page.locator("#lesson-outline button[data-a='go']");
  await expect(steps).toHaveCount(6);
  await expect(steps.nth(0)).toBeDisabled();
  await expect(steps.nth(1)).toBeDisabled();
  await expect(page.locator(".lesson-phase")).toHaveCount(0);
});

test("学習開始で最初の章に移動する", async ({ page }) => {
  await openLesson(page);
  await beginLesson(page);
  await expect(page.locator("#phase-title-0")).toHaveText("ログイン拒否を確認する");
  await expect(page.locator("#lesson-outline")).toContainText("0 / 6 ステップ完了");
});

test("次へで次章を解放し進捗を更新する", async ({ page }) => {
  await openLesson(page);
  await beginLesson(page);
  await page.locator('#phase-0 [data-a="next"]').click();
  await expect(page.locator("#phase-1")).toBeVisible();
  await expect(page.locator("#lesson-outline")).toContainText("1 / 6 ステップ完了");
  await expect(page.locator("#lesson-outline button[data-a='go']").nth(1)).toBeEnabled();
});

test("前の内容へ戻っても章を非表示にしない", async ({ page }) => {
  await openLesson(page);
  await beginLesson(page);
  await page.locator('#phase-0 [data-a="next"]').click();
  await page.locator('#phase-1 [data-a="prev"]').click();
  await expect(page.locator("#phase-0")).toBeVisible();
  await expect(page.locator("#phase-1")).toBeVisible();
});

test("表示テーマを切り替えられる", async ({ page }) => {
  await mockRunner(page);
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: "表示切替" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("ロゴから教材一覧へ戻れる", async ({ page }) => {
  await openLesson(page);
  await page.getByRole("button", { name: "Reprokit ホーム" }).click();
  await expect(page.getByRole("heading", { name: "教材を選ぶ", exact: true })).toBeVisible();
});

test("Lab起動の確認なしでは実行できない", async ({ page }) => {
  const fixture = await openLesson(page);
  await page.locator('[data-a="deploy"]').click();
  await expect(page.getByRole("dialog")).toContainText("127.0.0.1のみ");
  await expect(page.getByRole("button", { name: "起動する", exact: true })).toBeDisabled();
  expect(fixture.calls.filter((call) => call.path === "/api/labs")).toHaveLength(0);
});

test("Lab起動確認をキャンセルしても準備リクエストを送らない", async ({ page }) => {
  const fixture = await openLesson(page);
  await page.locator('[data-a="deploy"]').click();
  await page.getByRole("button", { name: "やめる", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(fixture.calls.filter((call) => call.path === "/api/labs")).toHaveLength(0);
});

test("Labを明示確認して起動すると固定参照だけを送る", async ({ page }) => {
  const fixture = await openLesson(page);
  await deployLab(page);
  const request = fixture.calls.find((call) => call.path === "/api/labs" && call.method === "POST");
  expect(request.body).toEqual({
    lessonId: "command-injection/filebrowser-auth-hook",
    lessonVersion: "1.0.0",
    labRef: "vulnerable",
  });
});

test("稼働中のLabは脆弱版と修正版を順序どおり表示する", async ({ page }) => {
  await openLesson(page, { paired: true });
  await deployLab(page);
  const endpoints = page.locator(".tm .r2 .mono");
  await expect(endpoints).toHaveCount(2);
  await expect(endpoints.nth(0)).toHaveText("http://127.0.0.1:18080");
  await expect(endpoints.nth(1)).toHaveText("http://127.0.0.1:18081");
});

test("稼働中のLabを停止できる", async ({ page }) => {
  const fixture = await openLesson(page);
  await deployLab(page);
  await page.locator('[data-a="stop"]').click();
  await expect(page.locator(".st")).toHaveText("STOPPED");
  expect(fixture.calls.filter((call) => call.path.endsWith("/stop"))).toHaveLength(1);
});

test("Lab削除のキャンセルでは削除リクエストを送らない", async ({ page }) => {
  const fixture = await openLesson(page);
  await deployLab(page);
  await page.locator('[data-a="destroy"]').click();
  await page.getByRole("button", { name: "やめる", exact: true }).click();
  expect(fixture.calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
  await expect(page.locator(".st")).toHaveText("RUNNING");
});

test("Lab削除は初期値でVolumeを保持する", async ({ page }) => {
  const fixture = await openLesson(page);
  await deployLab(page);
  await page.locator('[data-a="destroy"]').click();
  await expect(page.locator("#vol")).toHaveValue("keep");
  await page.getByRole("button", { name: "削除する", exact: true }).click();
  await expect(page.locator(".st")).toHaveText("READY");
  expect(fixture.calls.filter((call) => call.method === "DELETE")[0].query).toBe(
    "?volumePolicy=retain",
  );
});

test("検証コンソールを開閉できる", async ({ page }) => {
  await openLesson(page);
  await deployLab(page);
  await page.getByRole("button", { name: "検証コンソール", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "検証コンソール" })).toBeVisible();
  await page.getByRole("button", { name: "検証コンソールを閉じる" }).click();
  await expect(page.getByRole("dialog", { name: "検証コンソール" })).toBeHidden();
});

test("小画面の学習メニューを開閉できる", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openLesson(page);
  await page.getByRole("button", { name: "学習メニューを開く" }).click();
  await expect(page.getByRole("dialog", { name: "学習メニュー" })).toBeVisible();
  await page.getByRole("button", { name: "学習メニューを閉じる" }).click();
  await expect(page.getByRole("dialog", { name: "学習メニュー" })).toBeHidden();
});

test("ヒントとやり直しで再現手順の表示を戻せる", async ({ page }) => {
  await openLesson(page);
  await beginLesson(page);
  await page.locator('#phase-0 [data-a="next"]').click();
  await page.getByRole("button", { name: "ヒントを見る" }).click();
  await expect(page.getByText("このCVEは「認証の結果が出る前」")).toBeVisible();
  await page.getByRole("button", { name: "やり直す" }).click();
  await expect(page.getByText("このCVEは「認証の結果が出る前」")).toHaveCount(0);
});
