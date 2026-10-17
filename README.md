# Reprokit

**実際のCVEを、処理経路を追いながら自分で試して理解するための、初学者向け体験型セキュリティ学習ツールです。**

> [!IMPORTANT]
> 現在はFile Browser教材を対象にした初期実装段階です。学習とLab操作の入口はローカルWeb UIのみで、利用者向けCLIは提供しません。

## 製品概要

Reprokitは、脆弱性の説明を読むだけでなく、管理されたローカル環境で安全な実験を行い、入力がどの処理を通って危険な動作へ到達するのかを一段ずつ学ぶOSSです。

学習画面はローカルWeb UI、環境の取得・起動・停止はGo製Runnerが担当します。脆弱なLabは自動起動せず、公開ポートは原則として`127.0.0.1`へ限定します。

## 起動方法

必要なものはNode.js 22以上、`backend/go.mod`で指定したGo toolchain、Gitです。Labを実際に起動する場合は、Docker Engine 28以上とDocker Compose v2.36.1以上も必要です。教材の閲覧だけではDockerを操作しません。

リポジトリ直下で、依存関係の導入、Web成果物の生成、ローカル起動を順に行います。

```sh
npm ci
npm run web:install
npm run web:build
npm run web:start
```

起動後に表示される `http://127.0.0.1:4173` をブラウザで開いてください。Webシェルは同時にGo Runnerを起動し、接続先と認証トークンを専用パイプで受け渡します。URLやトークンを手入力する必要はありません。

研修管理画面は起動時に表示される `/admin` です。`REPROKIT_ADMIN_USERNAME` と `REPROKIT_ADMIN_PASSWORD` で管理ログインを固定できます。パスワードを設定しない場合は、起動ごとに一時パスワードを生成して端末へ表示します。

1. 「学習を始める」を選ぶ。
2. 「Labを準備する」で固定済みソースを取得・検査する。この操作だけではコンテナは起動しません。
3. 安全性検査とloopback接続先を確認してから、「安全性を確認して起動する」を明示的に選ぶ。
4. 演習後は画面からLabを停止し、Volume方針を確認して削除する。

既定ポートを変える場合は `REPROKIT_WEB_PORT`、状態保存先を変える場合は `REPROKIT_STATE_DIR` を起動前に設定できます。Labの接続先は固定値を推測せず、画面に表示された `127.0.0.1` のURLを使ってください。詳しい運用・検証手順は[Web UI README](web/README.md)を参照してください。

## 初期教材

| 教材 | 主題 | Labの提供元 |
| --- | --- | --- |
| CVE-2021-41773 | Apache HTTP Serverのパス正規化不備によるパストラバーサル | `Saku0512/vulhub`がupstreamから継承するLab |
| CVE-2026-54088 | File Browser Hook Authenticationの未認証OSコマンドインジェクション | `Saku0512/vulhub`へ追加する独自Lab |

教材は「入力 → 変換 → 信頼境界 → 危険な処理 → 影響 → 修正」の順に表示し、脆弱版と修正版の違いまで説明します。詳細は[初期教材方針](docs/initial-lessons.md)を参照してください。

## Labの扱い

- Reprokit用にforkした[`Saku0512/vulhub`](https://github.com/Saku0512/vulhub)を、単一のLabカタログとして内部利用します。
- forkの`master`は`vulhub/vulhub`を取り込みつつ、未収録CVEの独自Labを追加します。
- ReprokitはVulhubのCLIを起動するのではなく、forkの`master`を一度コミットSHAへ解決し、同じSHAから対象ディレクトリを取得して検査後にDocker Composeで実行します。
- upstream由来Labとfork追加Labは、Manifest、Lockfile、安全性検査、明示起動の規則を共有します。

## 学習の流れ

1. 教材を選び、前提知識と学習目標を読む。
2. 脆弱性へ到達する処理経路を一段ずつ確認する。
3. 固定されたLabを取得し、安全性と公開ポートを確認する。
4. Labを明示的に起動し、無害な検証を自分で実行する。
5. 観察結果、根本原因、修正方法を理解する。
6. Labを停止・削除する。

## 開発技術

- Core / Local Runner: Go
- Runtime: Docker Compose
- Lab catalog: [`Saku0512/vulhub`](https://github.com/Saku0512/vulhub)（`vulhub/vulhub`のfork）
- Metadata: YAML / JSON Schema
- Frontend: JavaScript

## ドキュメント

- [プロダクト方針](docs/product-vision.md)
- [初期教材方針](docs/initial-lessons.md)
- [Vulhub fork連携・Lab昇格設計](docs/lab-catalog-runtime-v0.1.md)
- [Vulhub連携MVP](docs/vulhub-learning-mvp.md)
- [アーキテクチャ](docs/architecture-v0.1.md)
- [学習インターフェース](docs/interface-study.md)
- [研修管理・受講連携 API](docs/training/management-api-v1.md)
- [研修結果CSV・監査イベント](docs/training/export-audit-v1.md)
- [セキュリティ仕様](docs/security-v1.md)

## 安全上の注意

Reprokitが扱うLabには意図的に脆弱なソフトウェアが含まれます。自分が所有する環境または明示的な許可を得た環境だけで利用し、第三者のシステムを対象にしないでください。Dockerを完全な隔離境界とはみなしません。

## ライセンス

[MIT License](LICENSE)
