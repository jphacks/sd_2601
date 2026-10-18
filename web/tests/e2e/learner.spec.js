import { test, expect } from "@playwright/test";
import { mockRunner } from "./fixture.js";
import { testOutputDir } from "./paths.js";
import { join } from "node:path";

async function keyboardClick(page, locator) {
  for (let index = 0; index < 100; index++) {
    if (await locator.evaluate((node) => node === document.activeElement)) {
      await page.keyboard.press("Enter");
      return;
    }
    await page.keyboard.press("Tab");
  }
  throw new Error("キーボードで操作対象へ到達できませんでした");
}
const vulnerable = (page) => page.getByRole("region", { name: "脆弱版", exact: true });
const fixed = (page) => page.getByRole("region", { name: "修正版", exact: true });

test("公開済みgo-git教材を指定して汎用受講画面でLabを準備できる", async ({ page }) => {
  const fixture = await mockRunner(page, { lesson: "go-git" });
  await page.goto("/runner?lessonId=path-traversal%2Fgo-git-loose-reference");

  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "Git参照名の検証不足で設定ファイルを書き換えられる",
  );
  await page.getByRole("button", { name: "学習を始める" }).click();
  await vulnerable(page).getByRole("button", { name: "Labを準備する" }).click();
  await expect(vulnerable(page)).toContainText("準備済み");
  await vulnerable(page).getByRole("button", { name: "安全性を確認して起動する" }).click();
  await page.getByRole("button", { name: "確認してLabを起動する", exact: true }).click();
  await expect(vulnerable(page).getByRole("link", { name: /127.0.0.1:18082/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "脆弱版のマーカーを確認する" })).toHaveCount(0);

  expect(
    fixture.calls.some(
      (call) =>
        call.path === "/api/labs" &&
        call.method === "POST" &&
        call.body.lessonId === "path-traversal/go-git-loose-reference" &&
        call.body.labRef === "vulnerable",
    ),
  ).toBeTruthy();
});

test("キーボードで教材・Lab・回答・後片付けまで進み、再読み込み後も記録を保持する", async ({
  page,
}) => {
  test.setTimeout(120000);
  const fixture = await mockRunner(page);
  await page.goto("/runner");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("ログイン入力");
  await expect(page.getByRole("heading", { name: "この教材で身につけること" })).toBeVisible();
  await expect(vulnerable(page).getByRole("button", { name: "Labを準備する" })).toBeDisabled();
  await keyboardClick(page, page.getByRole("button", { name: "学習を始める" }));
  await expect(page.locator("#page-title")).toHaveText("検証の範囲を確認する");
  await keyboardClick(page, vulnerable(page).getByRole("button", { name: "Labを準備する" }));
  await expect(vulnerable(page)).toContainText("準備済み");
  expect(
    fixture.calls.filter(
      (call) => call.path.startsWith("/api/labs/") && call.path.endsWith("/start"),
    ),
  ).toHaveLength(0);
  await keyboardClick(
    page,
    vulnerable(page).getByRole("button", { name: "安全性を確認して起動する" }),
  );
  await expect(page.getByRole("dialog")).toContainText("11111111-1111-4111-8111-111111111111");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(
    vulnerable(page).getByRole("button", { name: "安全性を確認して起動する" }),
  ).toBeFocused();
  expect(
    fixture.calls.filter(
      (call) => call.path.startsWith("/api/labs/") && call.path.endsWith("/start"),
    ),
  ).toHaveLength(0);
  await keyboardClick(
    page,
    vulnerable(page).getByRole("button", { name: "安全性を確認して起動する" }),
  );
  await keyboardClick(
    page,
    page.getByRole("button", { name: "確認してLabを起動する", exact: true }),
  );
  await expect(vulnerable(page).getByRole("link", { name: /127.0.0.1:18080/ })).toBeVisible();

  for (const step of fixture.lesson.spec.steps.filter((step) => step.id !== "cleanup")) {
    await expect(page.locator("#page-title")).toHaveText(step.title);
    if (step.id === "set-boundary") {
      await expect(page.getByRole("heading", { name: "期待結果", exact: true })).toHaveCount(0);
      await page.getByLabel("結果を予想する").fill("認証前の処理を観察する");
      await keyboardClick(page, page.getByRole("button", { name: "予想を記録して期待結果を開く" }));
      await expect(page.getByRole("heading", { name: "期待結果", exact: true })).toBeVisible();
      await keyboardClick(page, page.getByRole("button", { name: "次のヒントを開く" }));
      await expect(page.getByRole("button", { name: "次のヒントを開く" })).toBeDisabled();
    }
    if (step.id === "observe-marker") {
      await keyboardClick(page, page.getByRole("button", { name: "脆弱版のマーカーを確認する" }));
      await expect(
        page.getByText("マーカーを確認しました。内容: uid=1000(filebrowser)"),
      ).toBeVisible();
    }
    if (step.id === "compare-fixed") {
      await keyboardClick(page, fixed(page).getByRole("button", { name: "Labを準備する" }));
      await expect(fixed(page)).toContainText("準備済み");
      await keyboardClick(
        page,
        fixed(page).getByRole("button", { name: "安全性を確認して起動する" }),
      );
      await keyboardClick(
        page,
        page.getByRole("button", { name: "確認してLabを起動する", exact: true }),
      );
      await expect(fixed(page).getByRole("link", { name: /127.0.0.1:18081/ })).toBeVisible();
      await keyboardClick(page, page.getByRole("button", { name: "修正版のマーカーを確認する" }));
      await expect(
        page.getByText("マーカーはありません。修正版ではこの結果が期待値です。"),
      ).toBeVisible();
    }
    await page
      .getByLabel("観察メモ", { exact: true })
      .fill("手順を確認。マーカーAPIは未対応のため観察は未確認。");
    await keyboardClick(page, page.getByRole("button", { name: "メモを記録して次へ進む" }));
  }
  await expect(page.locator("#page-title")).toHaveText("原因・修正を比較する");
  await expect(page.getByRole("heading", { name: "修正で変わったこと" })).toBeVisible();
  await keyboardClick(page, page.getByRole("button", { name: "確認課題へ進む" }));
  for (const question of fixture.lesson.spec.assessment)
    await page
      .getByLabel(new RegExp(question.question.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
      .fill("認証前の入力をos.Expandでシェル構文にしない。環境変数で分離する。");
  await keyboardClick(page, page.getByRole("button", { name: "回答を保存する", exact: true }));
  await expect(page.getByText("API保存済み", { exact: true })).toHaveCount(3);
  await keyboardClick(page, page.getByRole("button", { name: "後片付けへ進む" }));
  for (const card of [vulnerable(page), fixed(page)]) {
    await keyboardClick(page, card.getByRole("button", { name: "Labを停止する" }));
    await expect(card).toContainText("停止済み");
    await keyboardClick(page, card.getByRole("button", { name: "Labを削除する", exact: true }));
    await expect(page.getByLabel("Volumeの削除方針")).toHaveValue("retain");
    await keyboardClick(page, page.getByRole("button", { name: "方針を確認してLabを削除する" }));
    await expect(card).toContainText("削除済み");
    await expect(card).toContainText("保持したVolume");
    await keyboardClick(page, card.getByRole("button", { name: "状態を更新する" }));
  }
  await page
    .getByLabel("後片付けの確認メモ")
    .fill("両Sessionのコンテナとネットワークはなし。Volumeは保持。");
  await keyboardClick(page, page.getByRole("button", { name: "メモを記録して次へ進む" }));
  await expect(page.locator("#page-title")).toHaveText("振り返りを記録する");
  await page
    .getByLabel("開発やコードレビューで次に確認すること")
    .fill("認証前に到達する外部プロセス呼び出しをレビューする。");
  await keyboardClick(page, page.getByRole("button", { name: "振り返りを記録する", exact: true }));
  await page.reload();
  await expect(vulnerable(page)).toContainText("削除済み");
  await keyboardClick(page, page.getByRole("button", { name: /確認課題に回答する/ }));
  await expect(page.getByText("API保存済み", { exact: true })).toHaveCount(3);
  await keyboardClick(page, page.getByRole("button", { name: /検証の範囲を確認する/ }));
  await expect(page.getByLabel("結果を予想する")).toHaveValue("認証前の処理を観察する");
  await expect(page.getByRole("button", { name: "次のヒントを開く" })).toBeDisabled();
  expect(fixture.calls.every((call) => call.token === "test_token_for_local_session")).toBeTruthy();
  expect(
    fixture.calls.filter((call) => call.path === "/api/labs" && call.method === "POST"),
  ).toHaveLength(2);
  expect(
    fixture.calls.filter(
      (call) => call.path.startsWith("/api/labs/") && call.path.endsWith("/start"),
    ),
  ).toHaveLength(2);
  expect(
    fixture.calls
      .filter((call) => call.method === "DELETE")
      .every((call) => call.query === "?volumePolicy=retain"),
  ).toBeTruthy();
  await page.screenshot({ path: join(testOutputDir, "learner-desktop.png"), fullPage: true });
});

test("起動失敗のSessionを保持し、再読み込み後に停止・削除で回復できる", async ({ page }) => {
  const fixture = await mockRunner(page, { failStart: true });
  await page.goto("/runner");
  await page.getByRole("button", { name: "学習を始める" }).click();
  await vulnerable(page).getByRole("button", { name: "Labを準備する" }).click();
  await vulnerable(page).getByRole("button", { name: "安全性を確認して起動する" }).click();
  await page.getByRole("button", { name: "確認してLabを起動する", exact: true }).click();
  await expect(vulnerable(page)).toContainText("image digest mismatch");
  await expect(vulnerable(page).getByRole("button", { name: "Labを準備する" })).toBeDisabled();
  await expect(
    vulnerable(page).getByRole("button", { name: "安全性を確認して起動する" }),
  ).toBeDisabled();
  await page.reload();
  await expect(vulnerable(page)).toContainText("image digest mismatch");
  await vulnerable(page).getByRole("button", { name: "Labを停止する" }).click();
  await vulnerable(page).getByRole("button", { name: "Labを削除する", exact: true }).click();
  await page.getByLabel("Volumeの削除方針").selectOption("delete");
  await page.getByRole("button", { name: "方針を確認してLabを削除する" }).click();
  await expect(vulnerable(page)).toContainText("削除済み");
  expect(fixture.calls.filter((call) => call.method === "DELETE")[0].query).toBe(
    "?volumePolicy=delete",
  );
});

test("未検査Labを起動できず、準備を連打しても重複しない", async ({ page }) => {
  const fixture = await mockRunner(page, { unsafe: true, delayPrepare: true });
  await page.goto("/runner");
  await page.getByRole("button", { name: "学習を始める" }).click();
  const prepare = vulnerable(page).getByRole("button", { name: "Labを準備する" });
  await prepare.click();
  await expect(prepare).toBeDisabled();
  await expect(vulnerable(page)).toContainText("準備済み");
  await expect(
    vulnerable(page).getByRole("button", { name: "安全性を確認して起動する" }),
  ).toBeDisabled();
  expect(fixture.calls.filter((call) => call.path === "/api/labs")).toHaveLength(1);
});

test("小画面でLabを先に表示し、画面全体が横にはみ出さない", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockRunner(page);
  await page.goto("/runner");
  await expect(page.getByRole("button", { name: "学習を始める" })).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
  const main = await page.locator("#content").boundingBox(),
    labs = await page.locator("#labs").boundingBox();
  expect(labs.y).toBeLessThan(main.y);
  await page.screenshot({ path: join(testOutputDir, "learner-mobile.png"), fullPage: true });
});

test("API不通を成功表示せず、再接続できる", async ({ page }) => {
  await page.goto("/runner");
  await expect(page.getByRole("heading", { name: "教材に接続できません" })).toBeVisible();
  await mockRunner(page);
  await page.getByRole("button", { name: "接続を再試行する" }).click();
  await expect(page.getByRole("button", { name: "学習を始める" })).toBeVisible();
  await expect(page.getByRole("alert")).toBeHidden();
});

test("受講状態の取得失敗で既存IDを消さず、新しい受講を作らない", async ({ page }) => {
  const fixture = await mockRunner(page, { failResume: true });
  await page.goto("/runner");
  await page.getByRole("button", { name: "学習を始める" }).click();
  await vulnerable(page).getByRole("button", { name: "Labを準備する" }).click();
  await expect(vulnerable(page)).toContainText("準備済み");
  await page.reload();
  await page.getByRole("button", { name: "受講状態を再取得する" }).click();
  await expect(page.locator("#page-title")).toHaveText("検証の範囲を確認する");
  expect(
    fixture.calls.filter((call) => call.path === "/api/study-sessions" && call.method === "POST"),
  ).toHaveLength(1);
  await expect(vulnerable(page)).toContainText("11111111-1111-4111-8111-111111111111");
});

test("遅延した状態取得が起動結果を上書きせず、入力中のメモを消さない", async ({ page }) => {
  let release, started;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const requested = new Promise((resolve) => {
    started = resolve;
  });
  await mockRunner(page, {
    statusGate: async () => {
      started();
      await held;
    },
  });
  await page.goto("/runner");
  await page.getByRole("button", { name: "学習を始める" }).click();
  await vulnerable(page).getByRole("button", { name: "Labを準備する" }).click();
  await expect(vulnerable(page)).toContainText("準備済み");
  await requested;
  await vulnerable(page).getByRole("button", { name: "安全性を確認して起動する" }).click();
  await page.getByRole("button", { name: "確認してLabを起動する", exact: true }).click();
  await expect(vulnerable(page)).toContainText("稼働中");
  await page.getByLabel("観察メモ", { exact: true }).fill("処理中でもこのメモを保持する");
  const response = page.waitForResponse(
    (response) => response.request().method() === "GET" && response.url().includes("/api/labs/"),
  );
  release();
  await response;
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await expect(vulnerable(page)).toContainText("稼働中");
  await expect(page.getByLabel("観察メモ", { exact: true })).toHaveValue(
    "処理中でもこのメモを保持する",
  );
});

test("実比較Labの両serviceを一つのSessionで扱い、接続先と後片付けを混同しない", async ({
  page,
}) => {
  const fixture = await mockRunner(page, { paired: true });
  await page.goto("/runner");
  await page.getByRole("button", { name: "学習を始める" }).click();
  await expect(fixed(page).getByRole("button", { name: "Labを準備する" })).toBeDisabled();
  await vulnerable(page).getByRole("button", { name: "Labを準備する" }).click();
  await expect(vulnerable(page)).toContainText("準備済み");
  await expect(fixed(page)).toContainText("準備済み");
  await expect(fixed(page)).toContainText("両版は同じ比較Lab Session");
  await expect(fixed(page).getByRole("button", { name: "Labを準備する" })).toBeDisabled();
  await fixed(page).getByRole("button", { name: "安全性を確認して起動する" }).click();
  await expect(page.getByRole("dialog")).toContainText("脆弱版・修正版の比較Lab");
  await page.getByRole("button", { name: "確認してLabを起動する", exact: true }).click();
  await expect(vulnerable(page)).toContainText("稼働中");
  await expect(fixed(page)).toContainText("稼働中");
  await expect(vulnerable(page).getByRole("link", { name: /127.0.0.1:18080/ })).toBeVisible();
  await expect(fixed(page).getByRole("link", { name: /127.0.0.1:18081/ })).toBeVisible();
  await expect(vulnerable(page).getByRole("link", { name: /127.0.0.1:18081/ })).toHaveCount(0);
  await expect(fixed(page).getByRole("link", { name: /127.0.0.1:18080/ })).toHaveCount(0);
  await page.reload();
  await expect(fixed(page)).toContainText("稼働中");
  await fixed(page).getByRole("button", { name: "Labを停止する" }).click();
  await expect(vulnerable(page)).toContainText("停止済み");
  await vulnerable(page).getByRole("button", { name: "Labを削除する", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("脆弱版・修正版の比較Lab");
  await page.getByRole("button", { name: "方針を確認してLabを削除する" }).click();
  await expect(vulnerable(page)).toContainText("削除済み");
  await expect(fixed(page)).toContainText("削除済み");
  expect(
    fixture.calls.filter((call) => call.path === "/api/labs" && call.method === "POST"),
  ).toHaveLength(1);
  expect(
    fixture.calls.filter(
      (call) => call.path.startsWith("/api/labs/") && call.path.endsWith("/start"),
    ),
  ).toHaveLength(1);
  expect(fixture.calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
});
