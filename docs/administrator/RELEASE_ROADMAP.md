# リリースロードマップ — 2026/05 プレリリース → 2026/06 正式リリース

- 作成日: 2026-04-22
- プレリリース予定: 2026-05-01 (ホームページ上で公開、招待制のため外部 login 不可の試験運転継続)
- 正式リリース予定: 2026-06-01
- 関連: [docs/developer/PLAN.md](../developer/PLAN.md) (MVP 開発計画) / [docs/developer/TESTING_STRATEGY.md](../developer/TESTING_STRATEGY.md)

## 全体方針

| 期間 | 主テーマ | アウトプット |
|---|---|---|
| **〜 4/30** | **リポジトリ整理** | チーム開発可能なコード+ドキュメント構造 |
| **5/1 〜 5/31** | **外部公開に向けた環境対応** | 3 環境 (local/on-prem/cloud) の動作と手順書 |
| **6/1 〜** | **運用保守** | 監視・インシデント対応・継続改善ループ |

今後の主作業は **プログラム改修ではなく仕組みづくり** が中心。PR の粒度は小さく、ドキュメント・設定・手順書の整備を重視する。

---

## Phase 1: 4 月中 — リポジトリ整理 (〜 2026-04-30)

### 目的
**他の開発者が git clone してすぐ参画できる状態** にする。属人的な前提や雑多なファイルを除去し、構造とドキュメントで自己説明可能にする。

### 1.1 チーム開発インフラ

| # | 項目 | 現状 | 目標 |
|---|---|---|---|
| 1 | `CODEOWNERS` | 未作成 | ディレクトリごとにレビュア指定 |
| 2 | `.github/PULL_REQUEST_TEMPLATE.md` | 未作成 | PR 作成時の必須項目を構造化 |
| 3 | `.github/ISSUE_TEMPLATE/` | 未作成 | バグ報告 / 機能要望 / 質問の 3 テンプレ |
| 4 | `SECURITY.md` | 未作成 | 脆弱性報告窓口 (public-facing になる前に必須) |
| 5 | `CONTRIBUTING.md` | 既存 | プレリリース前の見直し (古い記述があれば update) |
| 6 | `.editorconfig` | 未確認 | チームメンバーのエディタ設定統一 |
| 7 | Branch protection rules | 未確認 | main: レビュー必須・CI green 必須・force push 禁止 |

### 1.2 ディレクトリ/ファイル構造

| # | 項目 | 作業内容 |
|---|---|---|
| 1 | `docs/` 棚卸し | 10+ ファイルある。重複・古い内容があれば統廃合 (特に performance/, knowledge/ の旧レポート) |
| 2 | `.claude/` の公開可否判断 | Claude 設定・memory seed はチーム共有すべきか個人所有かを決める |
| 3 | ルート直下のファイル整理 | `instrumentation.ts`, `next-env.d.ts` 等の説明コメントを確認 |
| 4 | `scripts/` 整理 | 開発補助スクリプトの役割を README に索引化 |
| 5 | 不要コメント / TODO 棚卸し | `TODO:` / `FIXME:` をリストアップ、不要なら削除、必要なら Issue 化 |
| 6 | `src/generated/` | Prisma 生成物。`.gitignore` に入れるか commit 続行かの判断統一 |

### 1.3 README.md 刷新

現状の README を **新規参入者視点** で読み直し、下記を明示:
- [ ] サービス概要 (1 画面で分かる)
- [ ] 前提環境 (Node / pnpm / Docker バージョン)
- [ ] 3 コマンドで起動できる手順 (clone → install → dev)
- [ ] プロジェクト構造 (ディレクトリツリー + 各役割)
- [ ] ドキュメント索引 ([DEVELOPER_GUIDE.md](../developer/DEVELOPER_GUIDE.md), [OPERATION.md](./OPERATION.md), [TESTING_STRATEGY.md](../developer/TESTING_STRATEGY.md) 等への pointer)
- [ ] 貢献手順 ([CONTRIBUTING.md](../../CONTRIBUTING.md) へ)

### 1.4 定期的な自動チェックの強化

- [ ] `pnpm audit` を週次 cron で実行して結果を Issue 化
- [ ] outdated dependencies を月次 cron で通知
- [ ] カバレッジ閾値 80% (PR #84) の運用継続
- [ ] dependency-review action を PR に追加 (GitHub 公式)

### 1.5 Phase 1 完了の定義

- [ ] 新規開発者が README だけ見て 30 分以内に dev 環境立ち上げ可能
- [ ] PR 作成時に template が自動挿入され、必須欄が空だと push が躊躇される
- [ ] main ブランチが保護されていて直 push 不可
- [ ] docs/ 配下のドキュメント索引がトップ README から辿れる

---

## Phase 2: 5 月中 — 外部公開に向けた環境対応 (5/1 〜 5/31)

### 目的
**3 環境 (local / on-prem / cloud) で同じコードベースが動作する** ようにし、各環境の手順書を整備する。ホームページ上での公開に備え、外部から見られる UI 品質も整える。

### 2.1 環境の分離と設定抽象化

| 環境 | 現状 | 目標 |
|---|---|---|
| **local** | Docker Compose あり | `docker-compose up` + `pnpm dev` で 1 コマンド相当に |
| **on-prem** | 未対応 | セルフホスト可能 (Nginx リバプロ + PM2 + PostgreSQL セルフ) |
| **cloud (Vercel+Supabase)** | 稼働中 | 既存を手順書として整理 |

#### 作業項目
- [ ] `.env.local.example` / `.env.onprem.example` / `.env.cloud.example` を用途別に分離
- [ ] `MAIL_PROVIDER` / DB connection / storage の環境判別ロジックを 1 箇所に集約
- [ ] on-prem 向け `Dockerfile` (app) + `docker-compose.onprem.yml` (app + Postgres + nginx)
- [ ] Next.js `output: 'standalone'` の on-prem 運用手順

### 2.2 デプロイ手順書の整備 (OPERATION.md 拡充)

- [ ] **cloud (Vercel + Supabase)**: 既存手順の再整理
- [ ] **on-prem**: セルフサーバへのデプロイ手順 (Docker ベース)
- [ ] **local**: 開発者参画時の初期セットアップ手順
- [ ] 各環境の **環境変数一覧** を表形式で (必須/任意、デフォルト値、変更の影響範囲)
- [ ] migration 適用手順を環境別に (Supabase CLI / `prisma migrate deploy` / 手動 SQL)
- [ ] ロールバック手順を環境別に

### 2.3 CI/CD の環境拡張

- [ ] CI で on-prem 向けビルド (Docker image build) のスモーク確認を追加
- [ ] CI で各環境の `.env.example` が壊れていないか検査
- [ ] Release tag の切り方を決定 (semver / calver)
- [ ] release note 自動生成 (release-drafter 等)

### 2.4 公開ページ側の準備

本体アプリは招待制なので「ログイン画面」が外部訪問者の最初の接点になる:
- [ ] `/login` の **初見訪問者向け案内** を整備 (「このサービスは招待制です」の明示、問い合わせ導線)
- [ ] 利用規約 / プライバシーポリシーの設置 (外部視認性、法的観点)
- [ ] favicon / OG 画像 (SNS 共有時の見栄え)
- [ ] `robots.txt` / `sitemap.xml` (検索エンジンへの露出コントロール — プレリリース中は `noindex` を検討)

### 2.5 セキュリティ & コンプライアンス (公開前)

- [ ] `SECURITY.md` に脆弱性報告窓口を明示 (外部からの reporter 対応)
- [ ] `pnpm audit` の critical / high 脆弱性を解消
- [ ] 依存ライブラリのライセンスを `pnpm licenses` で確認、商用利用不可のものが無いか
- [ ] 四半期 threat-modeling (STRIDE) 実施
- [ ] 監査ログの改ざん耐性確認

### 2.6 Phase 2 完了の定義 (= プレリリース可能な状態)

- [ ] 3 環境すべてで `pnpm dev` が通る
- [ ] 3 環境の手順書が [OPERATION.md](./OPERATION.md) に記載済
- [ ] on-prem Docker image が作れる (CI で検証)
- [ ] `/login` が外部からも理解可能な案内になっている
- [ ] 利用規約 / プライバシーポリシーが設置済
- [ ] `SECURITY.md` 設置済

---

## Phase 3: 6 月以降 — 運用保守 (2026-06-01 〜)

### 目的
**継続的にサービスを提供し続ける体制** を整備する。障害時・セキュリティ事故時・機能要望時の対応ルートを明確化し、属人性を下げる。

### 3.1 監視・アラート

- [ ] ダッシュボード整備: 応答速度 / エラー率 / DB 負荷 / コスト
- [ ] アラート ルール: 5xx 急増 / cold start 悪化 / DB 接続枯渇 / Supabase 容量逼迫
- [ ] オンコール輪番制 (チーム化後)
- [ ] ステータスページ (必要に応じて)

### 3.2 インシデント対応

- [ ] インシデント検知 → 対応 → 事後レビュー のワークフロー明文化
- [ ] SLA / SLO (可用性目標) の明記 (招待制なので緩めで OK)
- [ ] ポストモーテム テンプレート
- [ ] 定期復旧訓練 (四半期、TESTING_STRATEGY.md §3.5)

### 3.3 リリースサイクル

- [ ] リリースケイデンス決定 (例: 毎週金曜 / 月末 / 随時)
- [ ] Feature flag 運用 (必要なら) — 現状は実装なし、必要時に検討
- [ ] ユーザ向けリリースノート運用 (CHANGELOG.md or GitHub Releases)
- [ ] マイグレーション後のデータ検証手順

### 3.4 フィードバックループ

- [ ] ユーザからの機能要望 / バグ報告の受付窓口 (GitHub Issues or 外部フォーム)
- [ ] 定期的なユーザインタビュー (月 1 / 四半期 1)
- [ ] 利用統計 (匿名) の取得・分析 (PostHog / 自前実装など、プライバシーポリシーに則り)

### 3.5 継続的改善

- [ ] 月次ふりかえり (何が良かった / 何を改善する)
- [ ] 四半期ロードマップ更新
- [ ] 累積データの性能劣化監視 (TESTING_STRATEGY §2.9)
- [ ] 脆弱性対応方針の遵守 (critical: 24h / high: 7d / medium: 30d)

### 3.6 段階的な外部ユーザ受け入れ (必要時)

現状は招待制。将来的に外部公開する場合:
- [ ] 登録 / サインアップ フロー設計
- [ ] 負荷テスト (現行は招待制なので未実施)
- [ ] CAPTCHA / rate limiting (bot 対策)
- [ ] カスタマーサポート体制

---

## 変更管理の原則 (今後 2 ヶ月間)

> 「プログラム修正」フェーズから「仕組みづくり」フェーズへの転換。PR の粒度を小さく、ドキュメントと設定の整備を主とする。

### 本ロードマップ中の PR 指針

- **スコープを小さく保つ** (1 PR = 1 テーマ、レビュー負担を下げる)
- **ドキュメント変更が主** な PR が増える (コード変更は最小限)
- **破壊的変更を避ける** (現状動作を維持しながら環境対応を追加)
- **自動テストを壊さない** (PR #90 以降で整備した green state を保つ)

### 毎月末の進捗確認

- [ ] 4 月末: Phase 1 チェックリスト達成率を本ファイルに記録
- [ ] 5 月末: Phase 2 チェックリスト達成率を本ファイルに記録 + プレリリース OK 判定
- [ ] 6 月末以降: Phase 3 は継続タスクなので月次ふりかえりで進捗管理

---

## 関連ドキュメント

- [docs/developer/PLAN.md](../developer/PLAN.md) — MVP 開発計画 (本ロードマップの前提)
- [docs/developer/TESTING_STRATEGY.md](../developer/TESTING_STRATEGY.md) — 自動 + 手動テスト戦略
- [docs/administrator/OPERATION.md](./OPERATION.md) — 運用手順 (Phase 2 で拡充予定)
- [docs/developer/DESIGN.md](../developer/DESIGN.md) — アーキテクチャ設計
- [CONTRIBUTING.md](../../CONTRIBUTING.md) — 貢献規約
- [CLAUDE.md](../../CLAUDE.md) — 運用ガイド
