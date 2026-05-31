# 運用保守ロードマップ — 未実装の整備計画・将来機能 (2026/06/01 後)

> **本書の位置づけ**
>
> 本書は **6/1 正式リリース後に段階的に取り組む「未実装」の整備計画・将来機能** を集約する。すなわち「これから整備する分」だけを残す前向きな計画書であり、**現状の実装状態を記述するものではない**。
>
> - **現状の監視・記録・アラート設計 (実装済み)** → [../design/OBSERVABILITY.md](../design/OBSERVABILITY.md)
> - **インフラの将来移行 (トリガー条件・移行先評価)** → [./MIGRATION_TO_AWS.md](./MIGRATION_TO_AWS.md)
> - **障害対応 SOP・運用手順 (runbook)** → [./operate/INCIDENT_RESPONSE.md](./operate/INCIDENT_RESPONSE.md)
>
> **運用ルール**: 各項目が完了したら、該当記述を `design/` または `operations/` 配下の正規ドキュメント (上記等) へ **昇格** し、本書からは **除去** する。本書は常に「未完了の計画」のみを保持する。
>
> 出典: 本書は archive 予定の `docs/roadmap/RELEASE_ROADMAP.md` §2.6 / §3 から、未実装かつ運用保守に必要な計画を無損失で移植したもの。実装済み機能 (マルチテナント基盤 / per-API-call 課金 ADR-0019 / 提案エンジン 3 軸スコアリング / テナント管理 UI・削除 / Stripe / chat 意味検索 / 提案の「なぜ?」説明文生成) は移植対象外。

---

## 目次

- [A. Observability 整備計画 (完全未着手)](#a-observability-整備計画-完全未着手)
  - [A.0 現状サマリ](#a0-現状サマリ)
  - [A.1 Phase 3a — 軽量・即効 (1-2 PR、費用ゼロ)](#a1-phase-3a--軽量即効-1-2-pr費用ゼロ)
  - [A.2 Phase 3b — 中期](#a2-phase-3b--中期)
  - [A.3 Phase 3c — 長期・自作ダッシュボード](#a3-phase-3c--長期自作ダッシュボード)
  - [A.4 技術選択の tradeoff (自前 vs 外部 SaaS)](#a4-技術選択の-tradeoff-自前-vs-外部-saas)
  - [A.5 Phase 3a 開始時の未決事項](#a5-phase-3a-開始時の未決事項)
- [B. 運用整備プロセス (未着手)](#b-運用整備プロセス-未着手)
  - [B.1 インシデント対応](#b1-インシデント対応)
  - [B.2 リリースサイクル](#b2-リリースサイクル)
  - [B.3 フィードバックループ](#b3-フィードバックループ)
  - [B.4 継続的改善](#b4-継続的改善)
  - [B.5 段階的な外部ユーザ受け入れ](#b5-段階的な外部ユーザ受け入れ)
- [C. v1.x 機能バックログ (未実装のみ)](#c-v1x-機能バックログ-未実装のみ)
- [関連ドキュメント](#関連ドキュメント)

---

## A. Observability 整備計画 (完全未着手)

> **方針**: 既存の `audit_logs` / `auth_event_logs` を DB に記録する自前実装路線と整合させ、ログ・監視データも **本サービス内で一元管理 + 自作ダッシュボードで可視化** を目指す。必要最小限だけ外部サービスを併用 (Netlify Analytics 等の無料枠)。
>
> ⚠️ 既に実装されている記録レイヤ (`audit_logs` / `auth_event_logs` / `system_error_logs` / `role_change_logs` / cron 実行ログ等) は [../design/OBSERVABILITY.md](../design/OBSERVABILITY.md) を真値とすること。本章は **そこに無い未実装分** (HTTP アクセスログ / 構造化ロガー / フロント例外収集 / slow query / 自作観測ダッシュボード等) のみを扱う。

### A.0 現状サマリ

未着手のギャップ (この埋め込みが本章の対象):

| 種別 | 現状 |
|---|---|
| アクセスログ (HTTP) | 未実装 |
| 構造化ロガー (pino 等) | 未導入 (`console.*` のみ) |
| Netlify Analytics | 未有効化 |
| フロントエンド例外の構造化収集 | 未実装 |
| Prisma slow query log | 未実装 |
| 観測ダッシュボード (時系列グラフ) | 未実装 |

### A.1 Phase 3a — 軽量・即効 (1-2 PR、費用ゼロ)

**目的**: 現在 "真っ暗" な状態から、最低限の観測性を手に入れる。

- [ ] **Web Vitals 計測有効化** (推奨: web-vitals npm or Netlify Analytics)
  - 計測対象: TTFB / LCP / CLS / INP (Web Vitals)
  - 無料枠: Netlify Analytics は $9/月の Add-on (Personal/Pro plan 共通)、または `web-vitals` npm で自前収集 (無料)
- [ ] **構造化ロガー導入** (推奨: **pino** — 軽量 / Edge 互換 / JSON 出力)
  - `console.*` を `logger.info/warn/error` に段階的に置換
  - 出力フォーマット: `{ time, level, msg, request_id, user_id, path, ... }`
  - Netlify Function ログ画面で JSON 検索可能に
- [ ] **middleware でアクセスログ記録** (`access_logs` テーブル新設)
  - 記録内容: `method / path / status / duration_ms / user_id / ip_hash / ua / request_id`
  - 既存 `audit_logs` と同じ設計方針で一貫性確保
  - プライバシー: IP は **SHA-256 ハッシュ** で保存 (GDPR 配慮)
- [ ] **request-id 発行 middleware**
  - UUID を発行して `X-Request-Id` response header に付与
  - 以降の全ログに同 ID を付与 → 障害調査時に 1 リクエストの全処理を追跡可能

### A.2 Phase 3b — 中期

**目的**: 障害調査のスピードを上げる。(Phase 3a 完了後に着手)

- [ ] **フロントエンド例外収集**
  - フロントエンド例外を `/api/errors` 経由で収集し DB 記録
  - stack + request_id + user_id + context (操作名 / 入力サマリ) を記録
  - ※ サーバ側エラーの秘匿保存 (`system_error_logs`) は実装済 (OBSERVABILITY.md §1)。本項はフロント例外の構造化収集が未着手分
- [ ] **Prisma slow query log** (`slow_queries` テーブル新設、または既存エラーログ流用)
  - 一定閾値超 (例: **500ms**) のクエリを自動記録
- [ ] **Server Timing ヘッダ活用**
  - サーバ内の DB 時間・認証時間を response header に付与
  - DevTools Network タブで待ち時間内訳が可視化

### A.3 Phase 3c — 長期・自作ダッシュボード

**目的**: 外部サービス非依存で、サービス内に監視機能を組み込む。

- [ ] **`/admin/observability` 画面** (admin のみアクセス可)
  - 時系列グラフ: 応答速度 / エラー率 / DB 負荷 / リクエスト数
  - 認証イベント統計: ログイン成功/失敗 / MFA 失敗 / ロック発生
  - 業務操作統計: `audit_logs` の集計 (作成/更新/削除の件数トレンド)
- [ ] **アラート通知**
  - 閾値ルール (5xx 急増 / cold start 悪化 / 認証失敗集中 / Supabase 容量逼迫)
  - 通知先: 管理者メール (既存 **Brevo** 利用) / 将来 **Slack webhook**
- [ ] **ステータスページ** (必要に応じて、外部公開後)
  - `/status` エンドポイント + 過去 30 日の稼働率表示
- [ ] **ログ保存期間ポリシー**
  - `access_logs`: **90 日** (量が多いため論理削除 → 物理削除)
  - `error_logs`: **180 日**
  - `audit_logs`: 既存ポリシー踏襲 (法令要求に応じて調整)
- [ ] **オンコール輪番制** (チーム化後、現状は個人開発のため保留)

### A.4 技術選択の tradeoff (自前 vs 外部 SaaS)

**路線 A: 外部サービス** (Sentry / Datadog / New Relic) と **路線 B: 自前実装** (本プロジェクト採用)

| 観点 | 外部サービス | **自前実装 (採用)** |
|---|---|---|
| 初期コスト | 低 (SDK 追加のみ) | 中 (DB 設計 + middleware + 画面) |
| 月額費用 | $0-200 (規模次第) | ゼロ |
| 観測品質 | 高 (最初から成熟) | 中 (段階的に育てる) |
| ロックイン | あり (移行コスト高) | なし |
| データ所有 | 外部 (規約依存) | 自社 DB 内 |
| プライバシー制御 | ベンダー依存 | 完全コントロール |
| 学習コスト | 低 | 中 |
| カスタマイズ性 | 制限あり | 無制限 (業務ドメイン特化可能) |
| チーム成熟度 | すぐ共有可能 | 社内教育必要 |

**本プロジェクトが自前路線を採る理由**:

1. 既存 `audit_logs` / `auth_event_logs` が既に DB 記録設計 → 一貫性
2. 招待制サービスでユーザ数が限定 → 自前でも負荷耐性あり
3. 管理画面内に監視を組み込む方針 (ユーザ希望) → 外部 URL 行き来が不要になり運用が楽
4. Netlify Personal ($9/月) + Supabase Free で最小コスト運用を継続

**ただし例外として Phase 3a の `Web Vitals 計測` のみ外部依存または自前実装を許容**:

- 理由: Web Vitals (LCP/CLS/INP) は **実ブラウザ計測が必要** で完全自前実装は困難
- 費用: `web-vitals` npm パッケージで自前収集 → DB 蓄積なら無料、Netlify Analytics 採用なら $9/月
- ロックイン: 標準 Web Vitals API のため移行コスト低

### A.5 Phase 3a 開始時の未決事項

実装着手時に以下 5 項目を決定する (本計画策定時点では未決):

1. **ロガー選択**: pino (推奨) / winston / 自作 のいずれか
2. **`access_logs` の粒度**: HTTP リクエスト単位 (全件) / ユーザー操作単位 (audit と同等)
3. **保存期間**: 30 日 / 90 日 / 無期限 (量次第)
4. **IP 保存形式**: 生 IP / SHA-256 ハッシュ / 国コードのみ
5. **user agent 保存**: 生文字列 / パーサで正規化 (Browser 名 + OS + Device 型のみ)

---

## B. 運用整備プロセス (未着手)

> 「継続的にサービスを提供し続ける体制」を整備する。障害時・セキュリティ事故時・機能要望時の対応ルートを明確化し、属人性を下げる。実装済みの障害対応 SOP は [./operate/INCIDENT_RESPONSE.md](./operate/INCIDENT_RESPONSE.md) を参照。本章はそれを補完する「プロセスとしての未整備分」。

### B.1 インシデント対応

- [ ] インシデント検知 → 対応 → 事後レビュー のワークフロー明文化
- [ ] **SLA / SLO** (可用性目標) の明記 (招待制なので緩めで OK)
- [ ] **ポストモーテム テンプレート** の整備
- [ ] **定期復旧訓練** (四半期、[../test/STRATEGY.md](../test/STRATEGY.md))

### B.2 リリースサイクル

- [ ] **リリースケイデンス決定** (例: 毎週金曜 / 月末 / 随時)
- [ ] **Feature flag 運用** (必要なら) — 現状は実装なし、必要時に検討
- [ ] **ユーザ向けリリースノート運用** (CHANGELOG.md or GitHub Releases)
- [ ] マイグレーション後のデータ検証手順

### B.3 フィードバックループ

- [ ] ユーザからの **機能要望 / バグ報告の受付窓口** (GitHub Issues or 外部フォーム)
- [ ] 定期的な **ユーザインタビュー** (月 1 / 四半期 1)
- [ ] **利用統計 (匿名)** の取得・分析 (PostHog / 自前実装など、プライバシーポリシーに則り)

### B.4 継続的改善

- [ ] **月次ふりかえり** (何が良かった / 何を改善する)
- [ ] **四半期ロードマップ更新**
- [ ] 累積データの性能劣化監視 ([../test/STRATEGY.md](../test/STRATEGY.md))
- [ ] 脆弱性対応方針の遵守 (critical: 24h / high: 7d / medium: 30d)

### B.5 段階的な外部ユーザ受け入れ

現状は招待制。将来的に外部公開する場合に整備:

- [ ] **登録 / サインアップ フロー設計**
- [ ] **負荷テスト** (現行は招待制なので未実施)
- [ ] **CAPTCHA / rate limiting** (bot 対策)
- [ ] **カスタマーサポート体制**

---

## C. v1.x 機能バックログ (未実装のみ)

> v1 リリース時点で未実装の機能。優先度・需要に応じて段階的に追加する。

- [ ] **テナント slug の URL ルーティング**: `tasukiba.com/{tenantSlug}/...` への移行
  - 現状は単一ドメインでテナントをセッション解決。path-based tenant routing は未採用 (SUGGESTION_ENGINE.md §34.11.6 参照)
- [ ] **LLM Re-ranking** (提案エンジン Phase 3 の第三段階)
  - pgvector 上位候補を Claude が並び替える段階。`@/services/suggestion.service.ts` に `rerank()` 関数を追加し、Phase 2 (embedding スコア) の結果を入力として受け取る設計
  - Pro (Sonnet) / 非 Pro (Haiku) のモデル分岐。プロンプトキャッシュは Anthropic SDK の prompt caching + Postgres アプリケーションレベルキャッシュ (5〜10 分 TTL) を併用
  - 縮退設計: 未実装・失敗時は Phase 2 の embedding スコア順をそのまま返す
  - ※ 同 Phase 3 の「なぜ?」説明文生成 (suggestion-explanation) は **実装済のため対象外**
- [ ] **Sonnet ティーザー機能**: 無料ユーザの **月 3 回までの Pro 体験** (Sonnet 出力を許可)。利用回数カウント用カラム (例: `teaser_uses_this_month`) で管理
- [ ] **30 日無料試用機能**: Pro プランの体験期間。`trial_ends_at` 相当のカラム + 外部 cron (cron-job.org) で日次に期限切れユーザを通常プランへダウングレード
- [ ] **観測ダッシュボード UI** `/admin/observability/llm` (A.3 Phase 3c の一部)
  - テナント単位の LLM 使用量可視化を含む
- [ ] **super_admin 画面に cache hit ratio 表示** (累積ストレージ・ハードキャップ撤廃の運用補完 / ADR-0030)
  - 2026-05-31 / ADR-0030「データはたすきばの命」で累積 50GB ハードキャップ・circuit-breaker を撤廃し、noisy-neighbor (Supabase Micro 1GB RAM の cache hit ratio 劣化) は **write を止めず Compute 増強で吸収**する方針に変更
  - その判断材料として、Supabase Postgres の cache hit ratio (`pg_statio_user_tables` 等) を super_admin ダッシュボードに表示し、Compute 増強の要否を可視化する
  - L4 instance-wide alert (Compute サイズ別閾値) と併せて「累積で write を止めない代わりの運用監視」を構成する

---

## 関連ドキュメント

- [../design/OBSERVABILITY.md](../design/OBSERVABILITY.md) — システム自己監視・記録・アラートの**現状実装**設計 (本書の Observability 計画が完了したら昇格先)
- [./MIGRATION_TO_AWS.md](./MIGRATION_TO_AWS.md) — インフラの将来移行 (トリガー条件・移行先評価)
- [./operate/INCIDENT_RESPONSE.md](./operate/INCIDENT_RESPONSE.md) — 障害対応 SOP・運用手順 (runbook)
- [../design/SUGGESTION_ENGINE.md](../design/SUGGESTION_ENGINE.md) — 提案エンジン技術設計 (LLM Re-ranking の設計詳細 §34.9)
- [../test/STRATEGY.md](../test/STRATEGY.md) — 自動 + 手動テスト戦略 (復旧訓練・性能劣化監視)
- [CONTRIBUTING.md](../../CONTRIBUTING.md) / [CLAUDE.md](../../CLAUDE.md) — 貢献規約 / 運用ガイド
