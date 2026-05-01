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

> **🎉 ステータス: ✅ 個人開発範囲でクローズ (2026-04-23)**
>
> **クローズ判定基準**: 個人開発 (本プロジェクトの現在のフェーズ) として必要な整備は完了。
> 以下の項目は **チーム開発開始時に再開** する設計:
> - §1.1-7 Branch protection rules (GitHub UI 設定、一人開発では承認者不在のため保留)
> - §1.1-5 CONTRIBUTING.md 大幅見直し (チーム受け入れ時に必要、現状記述は現役で運用可能)
> - §1.2-2 `.claude/` の公開可否判断 (チームメンバー合意事項)
> - §1.2-4 scripts/ 索引化 (3 スクリプトなので個人開発では未着手で可)
> - §1.2-5 TODO/FIXME 棚卸し (Phase 2 で実施)
>
> **対応 PR**: PR #100-#108 で全整備完了。
> **再開トリガ**: 2 人目以降の開発者が本リポジトリに参画するタイミング。

### 目的
**他の開発者が git clone してすぐ参画できる状態** にする。属人的な前提や雑多なファイルを除去し、構造とドキュメントで自己説明可能にする。

### 1.1 チーム開発インフラ

| # | 項目 | 現状 | 目標 |
|---|---|---|---|
| 1 | `CODEOWNERS` | ✅ 作成 (PR #108) | ディレクトリごとにレビュア指定 |
| 2 | `.github/PULL_REQUEST_TEMPLATE.md` | ✅ 作成 (PR #108) | PR 作成時の必須項目を構造化 |
| 3 | `.github/ISSUE_TEMPLATE/` | ✅ 作成 (PR #108) | バグ報告 / 機能要望 / 質問の 3 テンプレ + config.yml で SECURITY.md 誘導 |
| 4 | `SECURITY.md` | ✅ 既存 (PR #97) | 脆弱性報告窓口 (public-facing になる前に必須) |
| 5 | `CONTRIBUTING.md` | 🟡 既存 (PR #108 で path 更新済、大幅見直しは Phase 2 で) | プレリリース前の見直し (古い記述があれば update) |
| 6 | `.editorconfig` | ✅ 作成 (PR #108) | チームメンバーのエディタ設定統一 |
| 7 | Branch protection rules | ⚠️ **GitHub UI で要設定** (下記参照) | main: レビュー必須・CI green 必須・force push 禁止 |

**Branch protection rules の推奨設定** (GitHub → Settings → Branches → Add rule):
- Branch name pattern: `main`
- ☑ Require a pull request before merging
- ☑ Require approvals (1 以上)
- ☑ Require review from Code Owners
- ☑ Require status checks to pass before merging
  - `CI / Lint / Test / Build`
  - `Security Scan / pnpm audit`
  - `Dependency Review`
  - `Playwright E2E + Visual Regression`
- ☑ Require branches to be up to date before merging
- ☑ Require linear history (Squash or Rebase のみ許可)
- ☐ Allow force pushes (**無効**)
- ☐ Allow deletions (**無効**)

### 1.2 ディレクトリ/ファイル構造

| # | 項目 | 作業内容 |
|---|---|---|
| 1 | `docs/` 棚卸し | ✅ 完了 (PR #101 生バイナリ削除 / PR #107 役割別再編成) |
| 2 | `.claude/` の公開可否判断 | 🟡 未判断 (Phase 2 で決定) |
| 3 | ルート直下のファイル整理 | ✅ instrumentation.ts / next-env.d.ts の説明コメントは docblock あり |
| 4 | `scripts/` 整理 | 🟡 3 スクリプト (check-e2e-coverage / cleanup-orphan-user / print-migration) で役割明確、索引化は Phase 2 で |
| 5 | 不要コメント / TODO 棚卸し | 🟡 Phase 2 で grep 棚卸し → Issue 化 |
| 6 | `src/generated/` | ✅ `.gitignore` 登録済 (`/src/generated/prisma`) |

### 1.3 README.md 刷新

現状の README を **新規参入者視点** で読み直し、下記を明示 (PR #107 で docs/beginner/README.md を新設し役割分担済):

- [x] サービス概要 (1 画面で分かる) — ルート [README.md](../../README.md)
- [x] 前提環境 (Node / pnpm / Docker バージョン) — [docs/beginner/README.md §1.1](../beginner/README.md)
- [x] 3 コマンドで起動できる手順 (clone → install → dev) — [docs/beginner/README.md §1](../beginner/README.md)
- [x] プロジェクト構造 (ディレクトリツリー + 各役割) — [docs/beginner/README.md §2.1](../beginner/README.md)
- [x] ドキュメント索引 — [docs/README.md](../README.md) が役割別索引を担当
- [x] 貢献手順 — [CONTRIBUTING.md](../../CONTRIBUTING.md) へ誘導

### 1.4 定期的な自動チェックの強化

- [x] `pnpm audit` を **日次** cron で実行 (PR #82 `security.yml`、週次より厳密)
- [x] outdated dependencies を月次 cron で通知 (PR #108 `dependency-outdated.yml`)
- [x] カバレッジ閾値 80% (PR #84) の運用継続
- [x] dependency-review action を PR に追加 (PR #108 `dependency-review.yml`)

### 1.5 Phase 1 完了の定義

**個人開発範囲でクローズ (2026-04-23)**。チーム化時に残項目を再開。

- [x] 新規開発者が README だけ見て 30 分以内に dev 環境立ち上げ可能 (PR #107 で docs/beginner/README.md 整備)
- [x] PR 作成時に template が自動挿入され、必須欄が空だと push が躊躇される (PR #108)
- [ ] main ブランチが保護されていて直 push 不可 — **チーム化時に GitHub UI 設定 (§1.1 参照)**
- [x] docs 配下のドキュメント索引がトップ README から辿れる (PR #107 の docs/README.md)
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
- [ ] 四半期 threat-modeling (STRIDE) 実施 — **本リリースでは提案エンジン v2 の脅威モデル ([SUGGESTION_ENGINE_THREAT_MODEL.md](../security/SUGGESTION_ENGINE_THREAT_MODEL.md)) を必須実施**
- [ ] 監査ログの改ざん耐性確認

### 2.6 提案エンジン v2 の実装 (T-03 / 6月1日リリース必達)

本サービスの核心機能である提案エンジンの根本的な性能向上。詳細は [SUGGESTION_ENGINE_PLAN.md](../developer/SUGGESTION_ENGINE_PLAN.md) を参照。LLM API への継続的な金銭コストが発生する初の機能であり、悪用された場合のリスクが極めて高いため、悪用防止と監視を最優先で設計する。

#### 6月1日リリース (v1) で投入

- [ ] **マルチテナント基盤**: Tenant テーブル新設、全業務エンティティへの tenantId 追加、default-tenant への migration、認可境界の徹底
- [ ] **テナント単位のコスト管理**: subscription_tier / current_month_token_usage / monthly_token_limit / suggestionDailyLLMCalls を Tenant テーブルに配置、Vercel Cron での月初・日次リセット
- [ ] **Phase 1**: LLM (Claude Haiku) による自動タグ抽出
- [ ] **Phase 2**: pgvector + Voyage AI Embedding による意味検索 (テナント内に閉じる)
- [ ] **初期データ**: 資格試験事例・著名な法則を独自要約したナレッジ 30〜100 件 (default-tenant 投入 + テナント別シーディング機構)
- [ ] **5 層悪用防止**: シークレット保護 / 認証強化 / テナント単位 rate limit + トークン上限 + 日次 LLM 呼び出しキャップ / プロンプトインジェクション対策 / workspace 上限
- [ ] **コスト保護 (提案多用対策)**: Phase 3 の re-ranking 結果を 5〜10 分間 Postgres キャッシュ、テナント単位日次キャップで超過時 Phase 2 に縮退
- [ ] **監視・異常検知 (最小実装)**: llm_call_log + token_usage_audit (tenant 単位) + 日次集計 + admin 通知
- [ ] **AGPL ライセンス適用**: LICENSE ファイル更新
- [ ] **git pre-commit hook**: gitleaks による API キー検知
- [ ] **GitHub Push Protection 有効化**: repo 設定変更

#### v1.x バージョンアップで段階的に追加

- [ ] **テナント管理 UI**: admin 専用画面でのテナント作成・招待・削除
- [ ] **テナント招待メール**: 新規外部ユーザの受け入れフロー
- [ ] **テナント slug の URL ルーティング**: `tasukiba.vercel.app/{tenantSlug}/...` への移行
- [ ] **Phase 3**: LLM Re-ranking と説明文生成 (Haiku、6月中旬目標)
- [ ] **Sonnet ティーザー機能**: 無料ユーザの月 3 回までの Pro 体験
- [ ] **30 日無料試用機能**: Pro プランの体験期間
- [ ] **Stripe 連携**: Pro プランのサブスク課金 (テナント単位)
- [ ] **観測ダッシュボード UI**: `/admin/observability/llm` (Phase 3c の一部、テナント単位の使用量可視化を含む)
- [ ] **テナント削除機能**: カスケード削除 + 孤児レコード検出バッチ

### 2.6.1 インフラスケーラビリティの将来評価

現状のインフラ (Vercel Hobby + Supabase Free) は試験運用には十分だが、外部ユーザ拡大に伴い制約に直面する可能性がある。詳細は [DESIGN.md §34.13](../developer/DESIGN.md) を参照。

**移行判断のトリガー条件** を以下に明記し、定期的な評価対象とする。

第一に、月次の Vercel Function timeout エラー率が 1% を超えた場合。これはサービス品質悪化のシグナルとなる。第二に、Supabase データベースサイズが Free / Pro プランの 80% に達した場合。第三に、月間 Anthropic / Voyage の API 利用料が \$100 を超えた場合 (= 事業として成立する規模に到達)。第四に、ユーザから「動作が遅い」というフィードバックが構造的に集まった場合。

**移行候補** は AWS ECS Fargate / Azure Container Apps / Google Cloud Run のいずれか。Next.js を `output: 'standalone'` で Docker 化し、PostgreSQL は AWS RDS / Azure Database for PostgreSQL に移行する。Prisma による DB 抽象化と Next.js の標準対応により、移行工数は 1〜2 週間程度と見込まれる。

これらは将来の判断材料として記録するが、v1 リリース時点ではすべて Vercel + Supabase で運用する。本格的な事業拡大段階で再評価する。

### 2.7 Phase 2 完了の定義 (= プレリリース可能な状態)

- [ ] 3 環境すべてで `pnpm dev` が通る
- [ ] 3 環境の手順書が [OPERATION.md](./OPERATION.md) に記載済
- [ ] on-prem Docker image が作れる (CI で検証)
- [ ] `/login` が外部からも理解可能な案内になっている
- [ ] 利用規約 / プライバシーポリシーが設置済
- [ ] `SECURITY.md` 設置済
- [ ] **提案エンジン v2 (Phase 1 + Phase 2) が安定動作**
- [ ] **5 層悪用防止が完全実装され、threat model のすべての項目が対策済**
- [ ] **Anthropic / Voyage AI の workspace 月間ハード上限が設定済**
- [ ] **AGPL ライセンスでの公開が法務確認済**

---

## Phase 3: 6 月以降 — 運用保守 (2026-06-01 〜)

### 目的
**継続的にサービスを提供し続ける体制** を整備する。障害時・セキュリティ事故時・機能要望時の対応ルートを明確化し、属人性を下げる。

### 3.1 監視・アラート (Observability)

> **方針**: 既存の `audit_logs` / `auth_event_logs` を DB に記録する自前実装路線と整合させ、
> ログ・監視データも **本サービス内で一元管理 + 自作ダッシュボードで可視化** を目指す。
> 必要最小限だけ外部サービスを併用 (Vercel Analytics 等の無料枠)。

#### 3.1.0 現状 (2026-04-23 時点)

| 種別 | 現状 |
|---|---|
| 業務ログ | ✅ `audit_logs` / `auth_event_logs` / `role_change_logs` を DB 記録 |
| アクセスログ (HTTP) | ❌ 未実装 |
| 構造化ロガー (pino 等) | ❌ 未導入 (`console.*` のみ) |
| Vercel Analytics / Speed Insights | ❌ 未有効化 |
| エラー詳細 (stack + context) | ❌ 未構造化 |
| ダッシュボード | ❌ 未実装 |

#### 3.1.1 Phase 3a — 軽量・即効 (1-2 PR、費用ゼロ)

**目的**: 現在 "真っ暗" な状態から、最低限の観測性を手に入れる。

- [ ] **Vercel Speed Insights 有効化** (`@vercel/speed-insights` 追加)
  - 計測対象: TTFB / LCP / CLS / INP (Web Vitals)
  - 無料枠: 月 10,000 計測 (招待制なら十分)
- [ ] **構造化ロガー導入** (推奨: **pino** — 軽量 / Edge 互換 / JSON 出力)
  - `console.*` を `logger.info/warn/error` に段階的に置換
  - 出力フォーマット: `{ time, level, msg, request_id, user_id, path, ... }`
  - Vercel ログ画面で JSON 検索可能に
- [ ] **middleware でアクセスログ記録** (`access_logs` テーブル新設)
  - 記録内容: `method / path / status / duration_ms / user_id / ip_hash / ua / request_id`
  - 既存 `audit_logs` と同じ設計方針で一貫性確保
  - プライバシー: IP は SHA-256 ハッシュで保存 (GDPR 配慮)
- [ ] **request-id 発行 middleware**
  - UUID を発行して `X-Request-Id` response header に付与
  - 以降の全ログに同 ID を付与 → 障害調査時に 1 リクエストの全処理を追跡可能

#### 3.1.2 Phase 3b — 中期 (Phase 3a 完了後)

**目的**: 障害調査のスピードを上げる。

- [ ] **エラーログ構造化** (`error_logs` テーブル新設)
  - stack + request_id + user_id + context (操作名 / 入力サマリ) を DB 記録
  - フロントエンド例外も `/api/errors` 経由で収集
- [ ] **Prisma slow query log**
  - 一定閾値超 (例: 500ms) のクエリを自動記録
  - `slow_queries` テーブル or 既存 `error_logs` 流用
- [ ] **Server Timing ヘッダ活用**
  - サーバ内の DB 時間・認証時間を response header に付与
  - DevTools Network タブで待ち時間内訳が可視化

#### 3.1.3 Phase 3c — 長期・自作ダッシュボード

**目的**: 外部サービス非依存で、サービス内に監視機能を組み込む。

- [ ] **/admin/observability 画面** (admin のみアクセス可)
  - 時系列グラフ: 応答速度 / エラー率 / DB 負荷 / リクエスト数
  - 認証イベント統計: ログイン成功/失敗 / MFA 失敗 / ロック発生
  - 業務操作統計: `audit_logs` の集計 (作成/更新/削除の件数トレンド)
- [ ] **アラート通知**
  - 閾値ルール (5xx 急増 / cold start 悪化 / 認証失敗集中 / Supabase 容量逼迫)
  - 通知先: 管理者メール (既存 Brevo 利用) / 将来 Slack webhook
- [ ] **ステータスページ** (必要に応じて、外部公開後)
  - `/status` エンドポイント + 過去 30 日の稼働率表示
- [ ] **ログ保存期間ポリシー**
  - access_logs: 90 日 (量が多いため論理削除 → 物理削除)
  - error_logs: 180 日
  - audit_logs: 既存ポリシー踏襲 (法令要求に応じて調整)
- [ ] **オンコール輪番制** (チーム化後、現状は個人開発のため保留)

#### 3.1.4 技術選択の tradeoff

**路線 A: 外部サービス** (Sentry / Datadog / New Relic) と **路線 B: 自前実装** (本プロジェクト採用)

| 観点 | 外部サービス | **自前実装 (採用)** |
|---|---|---|
| 初期コスト | 🟢 低 (SDK 追加のみ) | 🟡 中 (DB 設計 + middleware + 画面) |
| 月額費用 | 🔴 $0-200 (規模次第) | 🟢 ゼロ |
| 観測品質 | 🟢 高 (最初から成熟) | 🟡 中 (段階的に育てる) |
| ロックイン | 🔴 あり (移行コスト高) | 🟢 なし |
| データ所有 | 🟡 外部 (規約依存) | 🟢 自社 DB 内 |
| プライバシー制御 | 🟡 ベンダー依存 | 🟢 完全コントロール |
| 学習コスト | 🟢 低 | 🟡 中 |
| カスタマイズ性 | 🔴 制限あり | 🟢 無制限 (業務ドメイン特化可能) |
| チーム成熟度 | 🟢 すぐ共有可能 | 🟡 社内教育必要 |

**本プロジェクトが自前路線を採る理由**:
1. 既存 `audit_logs` / `auth_event_logs` が既に DB 記録設計 → 一貫性
2. 招待制サービスでユーザ数が限定 → 自前でも負荷耐性あり
3. 管理画面内に監視を組み込む方針 (ユーザ希望) → 外部 URL 行き来が不要になり運用楽
4. Vercel Hobby + Supabase Free でゼロコスト運用を継続

**ただし例外として Phase 3a の `Vercel Speed Insights` のみ外部依存を許容**:
- 理由: Web Vitals (LCP/CLS/INP) は **実ブラウザ計測が必要** で自前実装不可
- 費用: 無料枠で十分
- ロックイン: Vercel 上で稼働中なので追加ロックインなし

#### 3.1.5 Phase 3a 開始時の判断事項

実装着手時に以下を決定する (本 roadmap 作成時点では未決):

1. **ロガー選択**: pino (推奨) / winston / 自作 のいずれか
2. **access_logs の粒度**: HTTP リクエスト単位 (全件) / ユーザー操作単位 (audit と同等)
3. **保存期間**: 30 日 / 90 日 / 無期限 (量次第)
4. **IP 保存形式**: 生 IP / SHA-256 ハッシュ / 国コードのみ
5. **user agent 保存**: 生文字列 / パーサで正規化 (Browser 名 + OS + Device 型のみ)

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
