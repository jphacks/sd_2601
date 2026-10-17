# 研修結果 CSV と監査イベント v1

Issue #21 の研修管理 API における出力と監査の契約を定める。管理 UI はこの文書の対象外とする。

## 受講結果 CSV

`GET /api/training/exports/results.csv?organizationId={organizationId}` は、指定組織の Assignment を CSV として返す。レスポンスは `Content-Type: text/csv; charset=utf-8`、UTF-8（BOM なし）、RFC 4180 の引用規則、LF 改行を使う。日時は UTC の RFC 3339 形式で出力する。

列は次の順で固定する。

```text
learner_id,course_id,course_version,status,completed_at,evaluation_result
```

- `status` は Assignment の状態である。
- `completed_at` は Completion がある場合だけ出力する。
- `evaluation_result` は、評価待ちなら `pending`、完了なら `accepted`、再受講なら `needs_retry` とする。それ以外の状態では空欄とする。
- 実装は全体を文字列やバイト列として組み立てず、ヘッダーと各レコードを順に writer へ出力する。行の順序は保証しない。
- 表計算ソフトで数式として解釈され得る `=`, `+`, `-`, `@`, タブ、CR、LF から始まる外部由来セルは、先頭へアポストロフィを付けて無害化する。

CSV には回答本文、Lab Session、コンテナ・ネットワーク・Volume、接続先、秘密情報、任意コマンド、操作履歴を含めない。

## 監査イベント

監査イベントは組織ごとに private な研修状態へ永続化し、`GET /api/training/audit-events?organizationId={organizationId}` で時刻順に取得できる。イベントは識別子、操作者、対象、状態遷移、発生時刻だけを保持し、回答本文や Lab の内部データを保持しない。

| action | 記録する契機 |
| --- | --- |
| `course_published` | 初めての Course Version を公開したとき |
| `course_updated` | 同じ Course ID の新しい不変 Version を公開したとき |
| `assignment_created` | 受講者または Cohort へ割り当てたとき |
| `assignment_status_changed` | 受講開始、提出、評価によって Assignment 状態が変わったとき |

Course は不変である。更新は既存 Version の上書きではなく、新しい Version の公開として扱う。

ローカルMVPでは、Webシェルだけが持つ管理トークンをRunnerが検証し、認証済みの組織IDと管理者IDを管理APIへ設定する。ブラウザが別の `organizationId`、`actorId`、`evaluatorId` を指定した場合は拒否する。受講開始・提出に伴う状態変更では、固定された受講者IDを操作者として記録する。管理トークン、ログインパスワード、Cookieは監査イベントやCSVへ保存・出力しない。
