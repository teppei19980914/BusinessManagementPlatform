# たすきば Knowledge Relay - 運用手順書

- 初版: 2026-04-17
- 対象環境: Vercel（Hobby プラン）+ Supabase（Free プラン）

---

## 1. 運用概要

本書は本番環境の運用手順を記述する。監視・定期実行・障害対応の手順を含む。

関連ドキュメント:
- [DESIGN.md](./DESIGN.md) — 設計書本体
- [SPECIFICATION.md](./SPECIFICATION.md) — 機能仕様
- [knowledge/KNW-002_performance-optimization-patterns.md](./knowledge/KNW-002_performance-optimization-patterns.md) — パフォーマンス観点の再発防止ルール
- [performance/20260417/after/cold-start-and-data-growth-analysis.md](./performance/20260417/after/cold-start-and-data-growth-analysis.md) — コールドスタート対策の根拠

---

## 2. 定期実行（Cron）構成

本アプリには 2 種類の定期実行がある。

| 目的 | 実行元 | エンドポイント | 頻度 | 認証 |
|---|---|---|---|---|
| **ウォームアップ**（コールドスタート抑制）| **外部**: cron-job.org | `GET /api/health` | **5 分間隔**（業務時間帯のみ推奨）| 不要（公開エンドポイント） |
| ウォームアップ保険 | Vercel Cron（Hobby プラン）| `GET /api/health` | 日次 00:00 UTC | 不要 |
| 未使用アカウント削除 | Vercel Cron | `POST /api/cron/cleanup-accounts` | 日次 | `Authorization: Bearer ${CRON_SECRET}` |

### 2.1 なぜ外部 cron サービスを使うのか

Vercel Hobby プランの Cron Jobs は **日次（1 日 1 回）の頻度制限**があり、5 分間隔のウォームアップには対応できない。Pro プラン（$20/月）にアップグレードするか、外部 cron サービスを使う必要がある。本プロジェクトはコスト優先で**外部 cron（cron-job.org）**を採用。

ref: <https://vercel.com/docs/cron-jobs/usage-and-pricing>

---

## 3. cron-job.org によるウォームアップ設定手順

### 3.1 新規ジョブ作成

1. <https://console.cron-job.org/dashboard> にログイン
2. **「CREATE CRONJOB」** をクリック
3. 以下を入力:

| 項目 | 値 |
|---|---|
| Title | `tasukiba warm-up` |
| URL | `https://tasukiba.vercel.app/api/health` |
| Execution schedule | **Every 5 minutes**（Common schedules のプリセット、または Custom で `*/5 * * * *`）|
| Enabled | ✅ ON |

オプション（推奨）:

| 項目 | 値 | 理由 |
|---|---|---|
| Request method | GET | DB ping のみの副作用なし設計 |
| Notification on failure | ON | 失敗検知を有効化 |
| Execution window | 業務時間帯のみ（例: 平日 07:00-22:00 JST）| 深夜帯のウォームアップは不要。業務時間外はコスト最適 |

### 3.2 動作確認

1. ジョブ作成後、**「SAVE」** で保存
2. Dashboard に戻って **Last Events** で最初の実行を確認
3. HTTP 応答が **200 OK**・レスポンス時間が 2 秒以下であることを確認
4. 応答本文例:
   ```json
   {
     "status": "ok",
     "timestamp": "2026-04-17T10:30:14.123Z",
     "db": "ok",
     "responseTimeMs": 145
   }
   ```

### 3.3 アラート設定（推奨）

cron-job.org の **Settings → Notifications** で以下を有効化:
- E-mail on failure: ON
- 通知先メールアドレス: 運用責任者

---

## 4. ヘルスチェックエンドポイント仕様

### 4.1 エンドポイント

`GET https://tasukiba.vercel.app/api/health`

### 4.2 応答

| 状態 | HTTP | body.status | body.db |
|---|---|---|---|
| 正常 | 200 | `ok` | `ok` |
| DB エラー | 503 | `degraded` | `error` |
| DB タイムアウト（5 秒）| 503 | `degraded` | `timeout` |

### 4.3 処理内容

- `SELECT 1` を DB に実行（最小の DB ping）
- 応答時間を `responseTimeMs` に含む
- 副作用なし（書き込みなし）
- キャッシュ禁止（`dynamic = 'force-dynamic'`）

---

## 5. 死活監視

### 5.1 cron-job.org による監視

`/api/health` への 5 分毎の ping により、以下を実質監視できる:
- Vercel Function の起動可否
- Supabase DB への接続可否
- レスポンス時間（`responseTimeMs`）

### 5.2 障害通知フロー

1. cron-job.org がエンドポイント失敗を検知 → 登録メールに通知
2. 運用担当が Vercel ダッシュボード・Supabase ダッシュボードで状態確認
3. 必要なら Vercel ログ・Supabase ログを確認して原因切り分け

---

## 6. 環境変数チェックリスト（本番）

| 変数 | 必須 | 用途 |
|---|---|---|
| `DATABASE_URL` | ✅ | Supabase Pooler 接続文字列 |
| `DIRECT_URL` | ✅ | マイグレーション用（Pooler バイパス）|
| `AUTH_SECRET` / `NEXTAUTH_SECRET` | ✅ | NextAuth セッション署名 |
| `CRON_SECRET` | ✅ | `/api/cron/*` の Bearer 認証 |
| Mail provider 設定 | ✅ | Brevo 等（詳細は DESIGN.md §18）|

`/api/health` は環境変数なしで動作する（DATABASE_URL 不通でも `db: error` を返して 503 で応答）。

---

## 7. 既存改修履歴

| 日付 | 改修 | 参照 |
|---|---|---|
| 2026-04-17 | パフォーマンス改修（listTasksWithTree・Gantt 背景最適化・TaskTreeNode memo 化・Knowledge limit 削減） | PR #25 |
| 2026-04-17 | `/api/health` + instrumentation + Vercel 日次 cron 追加 | PR-α（本 PR） |

---

## 8. 今後追加予定の運用項目

- Vercel Speed Insights 有効化（TTFB / LCP / CLS の継続記録）
- Supabase `pg_stat_statements` 活用（遅いクエリの自動検知）
- 障害発生時のロールバック手順書
