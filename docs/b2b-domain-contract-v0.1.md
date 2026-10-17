# Reprokit 法人研修ドメイン契約 v0.1

> **ステータス：レビュー待ち（2026-10-17）**  
> 対象Issue：[#5 ToB研修MVPのドメイン契約とコード所有境界を確定する](https://github.com/jphacks/sd_2601/issues/5)  
> 本書は、法人向け研修MVPを2名で並行開発するための共有契約を定める。Lesson SchemaやHTTP APIの完全仕様ではなく、後続実装が互いの内部実装へ依存しないための最小境界を正本とする。

## 1. 設計原則

1. **学習と実行を分離する。** Lessonは学習内容、Labは再現環境を表す。
2. **管理状態と実行状態を分離する。** 管理プレーンは研修を管理し、RunnerはローカルLabの実状態を管理する。
3. **参照は固定する。** Course、Assignment、Lab Sessionは利用開始時の版を保持し、公開中の更新へ暗黙追従しない。
4. **ブラウザに実行権限を渡さない。** UIは許可済みのLessonとLab IDだけをローカルAPIへ渡し、任意コマンド、Compose、URL、パスを渡さない。
5. **実行前に検査する。** Labの取得は起動を意味せず、固定リビジョンの解決、安全性検査、明示確認後にだけ起動する。
6. **CVE IDを学習の主キーにしない。** CVEは根拠情報であり、Lesson IDとLab IDは製品内の安定識別子を使う。
7. **提出物で理解を確認する。** 細かな操作ログを、原因・修正・再発防止の説明に代わる評価材料にしない。

## 2. 境界と責務

```text
Management Plane                         Local Execution Plane
┌──────────────────────────┐            ┌──────────────────────────┐
│ Organization / Course     │            │ Reprokit Local Server    │
│ Assignment / Submission   │            │ Runner / Go Core         │
│ Completion / Audit        │            │ Lab Session / Lockfile   │
│ Published Lesson metadata │            │ Docker Compose Runtime   │
└─────────────┬────────────┘            └─────────────┬────────────┘
              │ versioned Lesson package              │ approved Lab only
              └──────────────────────┬─────────────────┘
                                     ▼
                              Learner Web UI
```

### 2.1 管理プレーン

管理プレーンは次を正本として持つ。

- Organizationとユーザー所属
- CourseとCourseに含めるLesson Version
- Assignmentの対象、期限、完了条件
- SubmissionとCompletion
- Lessonの公開状態とレビュー履歴
- 研修管理上の監査イベント

管理プレーンは、コンテナの実行状態、ホスト上のパス、Dockerリソース、認証情報を正本として持たない。

### 2.2 ローカル実行プレーン

ローカル実行プレーンは次を正本として持つ。

- 承認済みLabの取得状態
- 解決済みManifestとLockfile
- 安全性検査結果
- Lab Sessionの実行状態
- Docker Compose project、コンテナ、ネットワーク、Volume
- ローカルに公開した接続先とポート

RunnerはCourse、Assignment、評価結果を管理しない。Runnerが返す状態は研修の完了を意味しない。

### 2.3 Lessonパッケージ

Lessonパッケージは管理プレーンとローカル実行プレーンを接続する版管理された入力である。本文、学習手順、確認課題、根拠情報と、承認済みLabへの論理参照を含む。Composeファイルや任意の実行コマンドをUIからRunnerへ転送する用途には使わない。

## 3. ドメイン用語

| 用語 | 責務 | 安定識別子 | 版固定 |
| --- | --- | --- | --- |
| Organization | 法人単位のテナント境界 | `organizationId` | しない |
| Course | 研修目的に合わせてLessonを順序付ける | `courseId` | `courseVersion` |
| Lesson | 実在事例を学ぶ教材の論理的なまとまり | `lessonId` | `lessonVersion` |
| Lab | 脆弱版または修正版の再現環境 | Manifestの`metadata.id` | Manifest SHA、source revision、image digestをLockfileで固定 |
| Assignment | Courseを対象者へ割り当てた記録 | `assignmentId` | 作成時の`courseVersion`を固定 |
| Submission | 受講者が提出した回答 | `submissionId` | 対象`assignmentId`と`lessonVersion`を保持 |
| Completion | 完了条件を満たした判定記録 | `completionId` | 判定時のAssignmentとSubmissionを参照 |
| Lab Session | 受講者端末上の一時的なLab実行単位 | `labSessionId` | `lessonVersion`、Lab ID、Lockfileを固定 |

### 3.1 Organization

法人単位のデータ境界を表す。MVPが単一組織であっても、管理データには将来の組織分離を妨げない`organizationId`を持たせる。Lab SessionのDocker内部データをOrganizationへアップロードすることは既定動作にしない。

### 3.2 Course

順序付けたLesson Versionと完了条件を持つ。Courseが公開された後にLessonの最新版が変わっても、そのCourse Versionは暗黙更新しない。

### 3.3 Lesson

学習目標、前提知識、実在事例、手順、観察点、原因、修正、再発防止、確認課題を持つ。CVE IDや原典は証拠情報として保持するが、CVE IDをLesson IDや表示名に使うことを必須にしない。

### 3.4 Lab

再現環境だけを表し、教材本文や受講状態を持たない。既存の`reprokit.dev/v1alpha1` Lab Manifestを正本とし、`metadata.id`を論理IDとして参照する。具体的なGit SHA、Composeハッシュ、image digestは解決後のLockfileで固定する。

### 3.5 Assignment

あるCourse Versionを特定の受講者またはグループへ割り当てる。期限、完了条件、再受講可否を保持する。受講開始後にCourseを更新する場合は、新しいAssignmentまたは明示的な移行操作を必要とする。

### 3.6 Submission

受講者が提出した確認課題の回答を保持する。Labのコンテナログ、シェル履歴、ホスト上のファイルをSubmissionへ自動添付しない。

### 3.7 Completion

Assignmentの完了判定を表す。Labを起動した、PoCの期待結果が得られた、技術的なBootable/Verified判定に成功した、という事実だけではCompletionにしない。

### 3.8 Lab Session

ローカル端末または企業管理の隔離環境上で動く一時的な実行単位。1つのLab Sessionは、1つのLesson Version、1つのLab参照、1つの解決済みLockfileに結び付く。

## 4. エンティティ間の関係

```text
Organization
├─ User / Group
├─ Course ── ordered ──> Lesson Version ── references ──> Lab
└─ Assignment ── pins ──> Course Version
   ├─ Submission ── answers ──> Lesson Version
   └─ Completion ── evaluated from ──> Submission(s)

Learner device
└─ Lab Session ── pins ──> Lesson Version + Lab ID + Lockfile
```

Labは複数Lessonから参照できる。Lessonは、役割が異なる複数Labを参照できる。初期用途では`vulnerable`と`fixed`を使用する。

## 5. LessonからLabを参照する契約

### 5.1 論理形式

Lesson Schemaは[#7](https://github.com/jphacks/sd_2601/issues/7)で確定するが、Lab参照は少なくとも次の意味を持たなければならない。

```yaml
apiVersion: reprokit.dev/v1alpha1
kind: Lesson
metadata:
  id: path-normalization/non-public-file-access
  version: 1.0.0
  title: URLの正規化不備により非公開ファイルを読み取られる
spec:
  evidence:
    cves:
      - CVE-2021-41773
    references:
      - type: vendor-advisory
        url: https://example.invalid/advisory
  labs:
    - ref: vulnerable
      labId: vulhub/httpd-cve-2021-41773
      purpose: reproduce
    - ref: fixed
      labId: reprokit/httpd-cve-2021-41773-fixed
      purpose: compare-fix
```

この例は最終Schemaではなく、後続実装が保持すべき意味契約を示す。

### 5.2 必須規則

- `metadata.id`と`metadata.version`の組でLesson Versionを一意にする。
- `labs[].ref`はLesson内で一意とし、UIと学習手順はこの論理名を使う。
- `labs[].labId`はRegistryにあるLab Manifestの`metadata.id`を指す。
- LessonにGit URL、ホストパス、Composeパス、image tagを直接記載しない。
- Labを使う学習ステップは、存在する`labs[].ref`だけを参照する。
- Runnerは`labId`をRegistryから解決し、ManifestとLockfileの検証を必ず通す。
- Lesson更新時にLab参照を変えた場合は、新しいLesson Versionとして公開する。
- 脆弱版と修正版の同時起動または切り替え方式はRunner側が決め、LessonはRuntime内部へ依存しない。

## 6. 学習UIとRunnerの最小インターフェース

HTTPのパスやJSON Schemaの最終形は実装Issueで確定する。本節は、学習UIが利用できる操作と渡してよい値を定める。

### 6.1 操作一覧

| 操作 | 入力 | 主な出力 | 状態変更 |
| --- | --- | --- | --- |
| ListLessons | なし、または教材フィルター | 公開Lessonの概要 | なし |
| GetLesson | `lessonId`、`lessonVersion` | Lesson本文とLab論理参照 | なし |
| PrepareLab | `lessonId`、`lessonVersion`、`labRef` | `labSessionId`、取得・検査結果 | `absent`から`prepared` |
| GetLabStatus | `labSessionId` | 状態、接続先、安全性概要、失敗情報 | なし |
| StartLab | `labSessionId`、明示確認 | 起動後の状態 | `prepared`から`running` |
| StopLab | `labSessionId` | 停止後の状態 | `running`から`stopped` |
| DeleteLab | `labSessionId`、Volume削除方針 | 削除結果、残存リソース | 任意状態から`deleted` |

### 6.2 許可する入力

- 公開済みの`lessonId`
- 固定済みの`lessonVersion`
- Lesson内で宣言された`labRef`
- Runnerが発行した`labSessionId`
- 定義済みの明示確認値
- 定義済みのVolume削除方針

### 6.3 禁止する入力

- 任意のCVE IDを実行対象として直接渡すこと
- 任意のGit URL、ブランチ、コミットを渡すこと
- 任意のComposeファイル、ホストパス、imageを渡すこと
- 任意のシェルコマンド、PoCコマンド、環境変数を渡すこと
- 任意のポートや外部公開アドレスを指定すること
- 第三者のホスト名やURLを攻撃対象として渡すこと

### 6.4 最小レスポンス

Runnerは少なくとも次をUIへ返す。

```json
{
  "labSessionId": "01J...",
  "lesson": {
    "id": "path-normalization/non-public-file-access",
    "version": "1.0.0",
    "labRef": "vulnerable"
  },
  "lab": {
    "id": "vulhub/httpd-cve-2021-41773",
    "sourceRevision": "0123456789abcdef0123456789abcdef01234567"
  },
  "state": "prepared",
  "safety": {
    "checked": true,
    "externalExposure": false
  },
  "endpoints": [],
  "failure": null
}
```

`endpoints`はRunnerが決定したループバック接続先だけを含む。内部ファイルパス、Docker認証情報、セッショントークンを返さない。

## 7. Lab Sessionの状態遷移

```text
absent
  │ PrepareLab
  ▼
preparing ── failure ──> error
  │ resolve + fetch + lock + safety check
  ▼
prepared
  │ StartLab
  ▼
starting ─── failure ──> error
  │
  ▼
running ── StopLab ──> stopping ──> stopped
  │                                      │
  └────────────── DeleteLab ─────────────┘
                         ▼
                      deleting ──> deleted
```

- `PrepareLab`はコンテナを起動しない。
- `StartLab`は`prepared`だけから開始し、安全性検査を再確認する。
- `StopLab`と`DeleteLab`は可能な範囲で冪等にする。
- `error`は失敗した操作、利用者向けメッセージ、再試行可能性を保持する。
- `deleted`後に再利用する場合は、新しいLab Sessionを作る。
- 学習進捗とLab Session状態は独立させる。Labを削除してもSubmissionは削除しない。

## 8. 受講状態の最小契約

### 8.1 Assignment状態

```text
assigned -> in_progress -> submitted -> completed
                          └───────────> needs_retry
```

- 初回の教材閲覧または明示的な開始で`in_progress`になる。
- 必須回答の提出で`submitted`になる。
- 評価基準を満たしたときだけ`completed`になる。
- Lab起動、停止、技術検証の成功だけで`completed`にしない。

### 8.2 Submissionの最小データ

- `submissionId`
- `organizationId`
- `assignmentId`
- `learnerId`
- `lessonId`と`lessonVersion`
- 課題ごとの回答
- 提出日時
- 評価状態と評価者（評価済みの場合）

PoCの生ログ、シェル履歴、Lab内のデータは既定では含めない。

## 9. セキュリティ境界

- ローカルHTTP APIは`127.0.0.1`だけでListenする。
- Host、Origin、CSRF、ローカルセッションを検証する。
- UIとCLIは同じGo Coreの安全性検査を利用する。
- Manifestの検証、Lockfileの整合性検査、Compose許可リストを迂回するAPIを作らない。
- RunnerはDockerを完全な隔離境界として説明しない。
- 管理プレーンへDocker socket、レジストリ認証、ホストパス、Lab内の機密情報を送信しない。
- AIによるCVE取り込みは本契約の外側にあり、承認済みLabへ昇格するまでRunnerから参照できない。

## 10. コード所有境界

### 10.1 @Saku0512：Core / Runnerレーン

主な所有範囲：

- `cmd/reprokit/`
- `internal/lab/`
- `internal/runtime/`
- `internal/security/`
- `internal/manifest/`
- `internal/lockfile/`
- `internal/registry/`
- `registry/`
- `schemas/manifest-*`
- `schemas/lock-*`
- Lab/Runtime/Securityに直接関係するテストと文書

### 10.2 @yui-szk：Learning / Trainingレーン

主な所有範囲：

- `web/`
- `lessons/`
- `internal/lesson/`
- `schemas/lesson-*`
- `docs/training/`
- Lesson、受講体験、研修ガイドに直接関係するテストと文書

### 10.3 共有領域

次は共有領域とし、担当者間の事前合意または相互レビューを必要とする。

- `go.mod`、`go.sum`
- `README.md`
- `cmd/reprokit/`の公開サブコマンド構成
- ローカルHTTP APIの公開契約
- `internal/training/`
- `docs/b2b-domain-contract-v0.1.md`
- CI設定
- リポジトリ全体へ影響するビルド設定

## 11. 並行開発ルール

1. **1 Issue 1ブランチ**とし、ブランチ名にIssue番号を含める。
2. PRは原則として担当レーンのファイルだけを変更する。
3. 共有領域を変更する場合は、機能実装とは別の小さなPRに分離する。
4. 契約変更は先に本書または対応Schemaを更新し、両担当者が合意してから実装する。
5. `go.mod`や共通エントリポイントを変更するPRを同時に複数開かない。
6. Lesson側はRunner内部パッケージへ直接依存せず、公開インターフェースだけを使う。
7. Runner側はLesson本文やUI構造を解釈せず、解決済みのLab参照だけを受け取る。
8. 統合Issueで大規模な横断修正を行わず、問題を元の担当Issueへ戻す。

### 推奨ブランチ名

- `feat/<issue>-<short-description>`
- `fix/<issue>-<short-description>`
- `docs/<issue>-<short-description>`

## 12. 変更管理

本契約を変更するPRは、次を記載する。

- 変更する契約と理由
- 影響を受けるIssue、Schema、API、保存データ
- 後方互換性の有無
- 移行方法
- @Saku0512 と @yui-szk のレビュー結果

破壊的変更では、Lesson Version、Lab Manifest、Lockfile、保存済みSubmissionのどれに影響するかを明記する。

## 13. 後続Issueへの決定事項

| Issue | 本書で固定する入力 | 後続Issueで決めること |
| --- | --- | --- |
| #6 Lab Resolver | LessonはLab IDだけを参照し、Runnerが固定リビジョンへ解決する | 取得・キャッシュ・Lockfile生成の実装 |
| #7 Lesson Schema | LessonとLabを分離し、論理`labRef`からLab IDを参照する | JSON Schemaの厳密な形状 |
| #8 Security | Start前に必ず安全性検査を通す | Compose許可・拒否ルールのコード |
| #9 Runtime | PrepareとStartを分離し、状態遷移を守る | Docker Compose操作の実装 |
| #10 Lesson API | UIは公開Lesson Versionを取得する | 保存方式とHTTPパスの詳細 |
| #11 Learner UI | 任意実行入力を持たず、定義済み操作だけを呼ぶ | UIフレームワークと画面実装 |
| #13 Compare | Lessonは`vulnerable`、`fixed`等の論理参照を使う | 同時起動か切り替えかの実装 |
| #15 Training API | AssignmentがCourse Versionを固定し、Submissionで理解を記録する | 永続化とAPIの詳細 |

## 14. レビュー項目

- [ ] 用語と責務に重複または空白がない
- [ ] LessonからLabへの参照が既存Manifest/Registryと両立する
- [ ] UIが任意の実行入力をRunnerへ渡せない
- [ ] Runnerの状態と研修完了状態が分離されている
- [ ] 2名の主な変更対象が重複していない
- [ ] 共有領域の変更手順が明記されている
- [ ] @yui-szk がLearning / Trainingレーンの境界をレビューしている
