# Cron 定期実行 (Operations)

本ドキュメントは、**外部 cron (cron-job.org)** を用いた定期実行の構成と、ウォームアップ・ヘルスチェック・死活監視を集約する。

2026-05-18 に Vercel Cron から cron-job.org に移行済 (ADR-0023)。旧 vercel.json の `crons` セクションは廃止。

> 🆕 **ADR-0019 (2026-05-24) 反映**: 月初 embedding backfill cron (`*-embedding-backfill` featureUnit) は全プラン無料化 (cost=0)。Tenant counter / Beginner 上限を消費せず、Stripe queue にも投入しない。fair-use-limit (月 10,000 calls/tenant) は適用される。詳細: [ADR-0019](../adr/0019-billable-feature-units-and-free-tier-expansion.md)

---

## §8. 定期実行 (Cron) 構成

### 8. 定期実行 (Cron) 構成

本アプリには以下の定期実行がある。**すべて cron-job.org から HTTP POST/GET で起動** し、認証は `Authorization: Bearer ${CRON_SECRET}` で行う (公開エンドポイントの `/api/health` のみ認証不要)。

| 目的 | 実行元 | エンドポイント | 頻度 | 認証 |
|---|---|---|---|---|
| **ウォームアップ** (コールドスタート抑制) | cron-job.org | `GET /api/health` | **5 分間隔** (業務時間帯のみ推奨) | 不要 (公開エンドポイント) |
| 未使用アカウントロック | cron-job.org | `POST /api/admin/users/lock-inactive` | 日次 03:00 UTC | `Authorization: Bearer ${CRON_SECRET}` または admin セッション |
| **アプリ内通知 (PR feat/notifications-mvp)** | cron-job.org | `POST /api/cron/daily-notifications` | **日次 22:00 UTC (= JST 翌日 7:00)** | `Authorization: Bearer ${CRON_SECRET}` のみ (cron 専用) |
| **Tenant 月次リセット (PR #2-d / T-03)** | cron-job.org | `POST /api/cron/tenant-monthly-reset` | **毎月 1 日 00:00 UTC (= JST 09:00)** | `Authorization: Bearer ${CRON_SECRET}` のみ |
| **Stripe Usage Record flush (PR-S6)** | cron-job.org | `POST /api/cron/stripe-usage-flush` | 日次 05:00 UTC (= JST 14:00) | `Authorization: Bearer ${CRON_SECRET}` のみ |
| **Stripe 引落失敗 auto-suspend (PR-S6)** | cron-job.org | `POST /api/cron/stripe-auto-suspend` | 日次 04:00 UTC (= JST 13:00) | `Authorization: Bearer ${CRON_SECRET}` のみ |
| **Stripe ↔ DB 状態照合 (PR-V7 #5)** | cron-job.org | `POST /api/cron/stripe-reconcile` | 月次 06:00 UTC (= JST 15:00、毎月 1 日) | `Authorization: Bearer ${CRON_SECRET}` のみ |
| **日次使用量集計 + 異常検知 (PR #7 / T-03)** | cron-job.org | `POST /api/cron/daily-usage-aggregation` | 日次 02:00 UTC (= JST 11:00) | `Authorization: Bearer ${CRON_SECRET}` のみ |

※ `/api/cron/cleanup-accounts` は PR #115 で削除 (デッドコード)。`/api/admin/users/lock-inactive` に一本化した (旧名 `cleanup-inactive`、feat/account-lock で改名)。

### 「アプリ内通知」cron の挙動 (PR feat/notifications-mvp、2026-05-01)

**処理内容** (1 リクエストで以下を順次実行):

1. **開始通知生成**: ACT (`type='activity'`) で `status='not_started'` AND `plannedStartDate=today (JST)` AND `assigneeId IS NOT NULL` のタスクを抽出 → 各 assignee に通知作成
2. **終了通知生成**: 同 ACT で `status≠'completed'` AND `plannedEndDate=today (JST)` AND `assigneeId IS NOT NULL` のタスクを抽出 → 各 assignee に通知作成
3. **古い通知の物理削除**: `readAt > 30日` の既読通知を `deleteMany`

**コスト**: アプリ内通知のみ (メール / push 不使用)、cron-job.org Free 枠で完結。

**重複抑止**: `dedupeKey = '{type}:{taskId}:{YYYY-MM-DD}'` の UNIQUE 制約 + `createMany skipDuplicates: true` で 2 重生成を DB レベルで弾く。cron が時間内に再呼出されても安全。

**監視ポイント**:
- レスポンスの `data.generated.{startCreated, endCreated}` が想定外に 0 連続 → cron 落ち or タスクの date / status / assignee 設定不全の疑い
- レスポンスの `data.cleaned.deleted` が累積で増えない → 既読通知が永続化される異常 (UI 側の既読化が動いていない可能性)

**手動実行** (動作確認用):

```bash
curl -X POST https://tasukiba.netlify.app/api/cron/daily-notifications \
  -H "Authorization: Bearer ${CRON_SECRET}"
```

`200 OK` + `data.source='cron'` で正常動作。

### 「Tenant 月次リセット」cron の挙動 (PR #2-d / T-03、2026-05-02)

提案エンジン v2 の課金モデル運用に必須のバッチ。**毎月 1 日 00:00 UTC** (= JST 09:00) に実行。

**処理内容** (1 リクエストで以下を順次実行):

1. **前月分の snapshot 保存**: `tenant_monthly_usage_history` に当月リセット直前の値を保存 (請求書生成の正本データ)
2. **月初リセット**: `lastResetAt < 当月初 (UTC)` のテナントの `currentMonthApiCallCount` / `currentMonthApiCostJpy` を 0 にリセットし、`lastResetAt` を当月初に更新
3. **プラン変更予約適用 (legacy)**: `scheduledPlanChangeAt <= now` のテナントに `scheduledNextPlan` を `plan` として適用。適用後は scheduled 列を NULL に戻す。
   - 2026-05-14: 新規にこの予約をセットするコードパスは廃止 (Expert↔Pro は即時反映、Beginner ダウングレードは完全禁止)。
   - 本処理は **legacy DB レコード対策** として残置。旧コード期間に作られた予約レコードがあれば月初 cron で適用される。新規テナントでは通常 0 件適用となる。
4. **Storage プラン適用** (legacy 同様、予約があれば適用)
5. **embedding=NULL 一括補完バッチ**: 縮退モード中に embedding 生成を skip した行を、新しい月の予算枠で一括補完する。対象テーブル: **`projects` / `knowledges` / `risks_issues` / `retrospectives` / `memos`** (2026-05-15 で `memos` 追加)。「公開範囲: 自分のみ」(Knowledge/RiskIssue/Retrospective: `visibility='draft'` / Memo: `visibility='private'`) は補完対象外。1 テナント・1 テーブルあたり最大 128 件、`generateAndPersistBatchEmbeddings` で **1 業務操作 = 1 ApiCallLog** に集約する。featureUnit は `${tableName}-embedding-backfill` (例: `project-embedding-backfill`、`memo-embedding-backfill`)
6. **テナント物理削除**: 90 日経過した削除済テナントの業務データを物理削除 (users は保持)

**冪等性保証**: 再実行しても結果は同じ。cron-job.org の at-least-once 配信仕様で複数回起動されても安全。embedding 補完は「既に embedding がある行」は候補に含まないため重複生成なし。

**手動実行** (動作確認用):

```bash
curl -X POST https://tasukiba.netlify.app/api/cron/tenant-monthly-reset \
  -H "Authorization: Bearer ${CRON_SECRET}"
```

レスポンス例 (3 テナントをリセット、1 テナントのプラン変更を適用、embedding を 12 件補完):
```json
{
  "data": {
    "source": "cron",
    "resetCount": 3,
    "planAppliedCount": 1,
    "invalidPlanSkippedCount": 0,
    "embeddingBackfillTenantCount": 3,
    "embeddingBackfillGeneratedCount": 12
  }
}
```

**監視ポイント**:
- `resetCount` が 0 が連続 → cron 落ち or 全テナントが既にリセット済 (= 当月内 2 回目以降の実行は正常 0)
- `invalidPlanSkippedCount > 0` → DB 不整合の検知。`scheduledNextPlan` に未知の値が混入。`system_error_logs` で当該テナント ID を確認
- `embeddingBackfillGeneratedCount` が増えない → 縮退モード中の NULL embedding が積み上がっている可能性。テナント単位の `Tenant.beginnerMonthlyCallLimit` / `monthlyBudgetCapJpy` の設定見直しを検討

### 「未使用アカウントロック」の挙動 (feat/account-lock 改修、2026-04-25)

旧仕様 (PR #89) は閾値経過の非 admin を **論理削除** していたが、ナレッジ参照のため
アカウントを残し **isActive=false (ロック)** にする方針へ変更:

- **ロック対象**: `lastLoginAt` (未ログインなら `createdAt`) から 30 日経過した非 admin
- **挙動**: `users.isActive = false` のみ更新 (deletedAt セット / ProjectMember 物理
  削除は **行わない**)
- **影響**: ログイン不可になるが、過去のナレッジ/課題/振り返り等の作成者表示はそのまま
- **解除手段**: `/admin/users` で当該ユーザ行を編集 → 「有効化」をオン → 保存
- **監査**: action='UPDATE' / entityType='user' / after.reason='30 日無アクティブ自動ロック'
  を audit_log に記録

### 8.1 なぜ外部 cron サービスを使うのか

ADR-0023 で Netlify に移行した際、cron 実装の選択肢として以下を検討:

| 候補 | 不採用理由 |
|---|---|
| Netlify Scheduled Functions | Function 呼び出し回数を消費する (Personal は credits 1,000/月の中で消費)。デプロイサイズも増える |
| 旧 Vercel Cron (Hobby) | 日次 (1 日 1 回) の頻度制限あり。商用 TOS 違反のため Vercel 自体を採用不可 |
| **外部 cron (cron-job.org)** ✅ | **1 分間隔まで Free、deploy 影響なし、外部から手動 trigger も容易** |

本プロジェクトはコスト優先 + 設定変更容易性で **外部 cron (cron-job.org)** を採用。`/api/cron/*` ルートは `CRON_SECRET` Bearer 認証で守られているため、外部からの呼び出しでも安全。

ref: <https://docs.cron-job.org/>

---


## §9. cron-job.org ウォームアップ設定手順

### 9. cron-job.org ウォームアップ設定手順

### 9.1 新規ジョブ作成

1. <https://console.cron-job.org/dashboard> にログイン
2. **「CREATE CRONJOB」** をクリック
3. 以下を入力:

| 項目 | 値 |
|---|---|
| Title | `tasukiba warm-up` |
| URL | `https://tasukiba.netlify.app/api/health` |
| Execution schedule | **Every 5 minutes** (Common schedules のプリセット、または Custom で `*/5 * * * *`) |
| Enabled | ✅ ON |

オプション (推奨):

| 項目 | 値 | 理由 |
|---|---|---|
| Request method | GET | DB ping のみの副作用なし設計 |
| Notification on failure | ON | 失敗検知を有効化 |
| Execution window | 業務時間帯のみ (例: 平日 07:00-22:00 JST) | 深夜帯のウォームアップは不要。業務時間外はコスト最適 |

### 9.2 動作確認

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

### 9.3 アラート設定 (推奨)

cron-job.org の **Settings → Notifications** で以下を有効化:
- E-mail on failure: ON
- 通知先メールアドレス: 運用責任者

---


## §10. ヘルスチェックエンドポイント仕様

### 10. ヘルスチェックエンドポイント仕様

### 10.1 エンドポイント

`GET https://tasukiba.netlify.app/api/health`

### 10.2 応答

| 状態 | HTTP | `body.status` | `body.db` |
|---|---|---|---|
| 正常 | 200 | `ok` | `ok` |
| DB エラー | 503 | `degraded` | `error` |
| DB タイムアウト (5 秒) | 503 | `degraded` | `timeout` |

### 10.3 処理内容

- `SELECT 1` を DB に実行 (最小の DB ping)
- 応答時間を `responseTimeMs` に含む
- 副作用なし (書き込みなし)
- キャッシュ禁止 (`dynamic = 'force-dynamic'`)
- `/api/health` は環境変数なしで動作する (`DATABASE_URL` 不通でも `db: error` を返して 503 応答)

---


## §11. 死活監視

### 11. 死活監視

### 11.1 cron-job.org による監視

`/api/health` への 5 分毎の ping により、以下を実質監視できる:
- Netlify Function の起動可否
- Supabase DB への接続可否
- レスポンス時間 (`responseTimeMs`)

### 11.2 障害通知フロー

1. cron-job.org がエンドポイント失敗を検知 → 登録メールに通知
2. 運用担当が Netlify ダッシュボード・Supabase ダッシュボードで状態確認
3. 必要なら Netlify Function ログ・Supabase ログを確認して原因切り分け (本書 §6 障害対応へ)

---

## §12. cron 登録漏れの検知 (cron-watchdog パターン)

cron-job.org への登録漏れリスク (Vercel Cron なら vercel.json コミットで自動登録だったが、外部 cron は手動登録が必要) への対策として、**「期待スケジュールに対し N 時間記録なし」の watchdog** を実装している。

- 新規 cron 追加時は `src/config/cron-jobs.ts` の `CRON_JOBS` に `expectedMaxGapHours` を必ず設定 (daily=25h, monthly=35日×24h)
- cron 健全性は `src/services/cron-health.service.ts` の `checkAllCronHealth` で 1 query で取得し、診断ダッシュボードに表示
- 過去事例: 2026-05-19 の本番調査で `tenant-monthly-reset` が cron-job.org に未登録だったため 5/1 以降一度も実行されておらず、誰も気付けなかった事故が発生 (詳細: memory `feedback_cron_watchdog_pattern`)

---
