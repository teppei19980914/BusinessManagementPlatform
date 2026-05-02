# Cron 定期実行 (Operations)

本ドキュメントは、Vercel Cron の構成と cron-job.org ウォームアップ設定を集約する (OPERATION.md §8〜§11)。

---

## §8. 定期実行 (Cron) 構成

## 8. 定期実行 (Cron) 構成

本アプリには以下の定期実行がある。

| 目的 | 実行元 | エンドポイント | 頻度 | 認証 |
|---|---|---|---|---|
| **ウォームアップ** (コールドスタート抑制) | **外部**: cron-job.org | `GET /api/health` | **5 分間隔** (業務時間帯のみ推奨) | 不要 (公開エンドポイント) |
| ウォームアップ保険 | Vercel Cron (Hobby プラン) | `GET /api/health` | 日次 00:00 UTC | 不要 |
| 未使用アカウントロック | Vercel Cron | `POST /api/admin/users/lock-inactive` | 日次 03:00 UTC | `Authorization: Bearer ${CRON_SECRET}` または admin セッション |
| **アプリ内通知 (PR feat/notifications-mvp)** | Vercel Cron | `POST /api/cron/daily-notifications` | **日次 22:00 UTC (= JST 翌日 7:00)** | `Authorization: Bearer ${CRON_SECRET}` のみ (cron 専用) |
| **Tenant 月次リセット (PR #2-d / T-03)** | Vercel Cron | `POST /api/cron/tenant-monthly-reset` | **毎月 1 日 00:00 UTC (= JST 09:00)** | `Authorization: Bearer ${CRON_SECRET}` のみ |

※ `/api/cron/cleanup-accounts` は PR #115 で削除 (デッドコード)。`/api/admin/users/lock-inactive` に一本化した (旧名 `cleanup-inactive`、feat/account-lock で改名)。vercel.json の `crons` も同 endpoint を参照。

### 「アプリ内通知」cron の挙動 (PR feat/notifications-mvp、2026-05-01)

**処理内容** (1 リクエストで以下を順次実行):

1. **開始通知生成**: ACT (`type='activity'`) で `status='not_started'` AND `plannedStartDate=today (JST)` AND `assigneeId IS NOT NULL` のタスクを抽出 → 各 assignee に通知作成
2. **終了通知生成**: 同 ACT で `status≠'completed'` AND `plannedEndDate=today (JST)` AND `assigneeId IS NOT NULL` のタスクを抽出 → 各 assignee に通知作成
3. **古い通知の物理削除**: `readAt > 30日` の既読通知を `deleteMany`

**コスト**: アプリ内通知のみ (メール / push 不使用)、Vercel Cron Hobby = 2/day 無料枠で完結。

**重複抑止**: `dedupeKey = '{type}:{taskId}:{YYYY-MM-DD}'` の UNIQUE 制約 + `createMany skipDuplicates: true` で 2 重生成を DB レベルで弾く。cron が時間内に再呼出されても安全。

**監視ポイント**:
- レスポンスの `data.generated.{startCreated, endCreated}` が想定外に 0 連続 → cron 落ち or タスクの date / status / assignee 設定不全の疑い
- レスポンスの `data.cleaned.deleted` が累積で増えない → 既読通知が永続化される異常 (UI 側の既読化が動いていない可能性)

**手動実行** (動作確認用):

```bash
curl -X POST https://tasukiba.vercel.app/api/cron/daily-notifications \
  -H "Authorization: Bearer ${CRON_SECRET}"
```

`200 OK` + `data.source='cron'` で正常動作。

### 「Tenant 月次リセット」cron の挙動 (PR #2-d / T-03、2026-05-02)

提案エンジン v2 の課金モデル運用に必須のバッチ。**毎月 1 日 00:00 UTC** (= JST 09:00) に実行。

**処理内容** (1 リクエストで以下を順次実行):

1. **月初リセット**: `lastResetAt < 当月初 (UTC)` のテナントの `currentMonthApiCallCount` / `currentMonthApiCostJpy` を 0 にリセットし、`lastResetAt` を当月初に更新
2. **プラン変更予約適用**: `scheduledPlanChangeAt <= now` のテナントに `scheduledNextPlan` を `plan` として適用 (Beginner ダウングレードの翌月適用)。適用後は scheduled 列を NULL に戻す

**冪等性保証**: 再実行しても結果は同じ。Vercel Cron の at-least-once 配信仕様で複数回起動されても安全。

**手動実行** (動作確認用):

```bash
curl -X POST https://tasukiba.vercel.app/api/cron/tenant-monthly-reset \
  -H "Authorization: Bearer ${CRON_SECRET}"
```

レスポンス例 (3 テナントをリセット、1 テナントのプラン変更を適用):
```json
{
  "data": {
    "source": "cron",
    "resetCount": 3,
    "planAppliedCount": 1,
    "invalidPlanSkippedCount": 0
  }
}
```

**監視ポイント**:
- `resetCount` が 0 が連続 → cron 落ち or 全テナントが既にリセット済 (= 当月内 2 回目以降の実行は正常 0)
- `invalidPlanSkippedCount > 0` → DB 不整合の検知。`scheduledNextPlan` に未知の値が混入。`system_error_logs` で当該テナント ID を確認

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

Vercel Hobby プランの Cron Jobs は **日次 (1 日 1 回) の頻度制限** があり、5 分間隔のウォームアップには対応できない。Pro プラン ($20/月) にアップグレードするか、外部 cron サービスを使う必要がある。本プロジェクトはコスト優先で **外部 cron (cron-job.org)** を採用。

ref: <https://vercel.com/docs/cron-jobs/usage-and-pricing>

---


## §9. cron-job.org ウォームアップ設定手順

## 9. cron-job.org ウォームアップ設定手順

### 9.1 新規ジョブ作成

1. <https://console.cron-job.org/dashboard> にログイン
2. **「CREATE CRONJOB」** をクリック
3. 以下を入力:

| 項目 | 値 |
|---|---|
| Title | `tasukiba warm-up` |
| URL | `https://tasukiba.vercel.app/api/health` |
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

## 10. ヘルスチェックエンドポイント仕様

### 10.1 エンドポイント

`GET https://tasukiba.vercel.app/api/health`

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

## 11. 死活監視

### 11.1 cron-job.org による監視

`/api/health` への 5 分毎の ping により、以下を実質監視できる:
- Vercel Function の起動可否
- Supabase DB への接続可否
- レスポンス時間 (`responseTimeMs`)

### 11.2 障害通知フロー

1. cron-job.org がエンドポイント失敗を検知 → 登録メールに通知
2. 運用担当が Vercel ダッシュボード・Supabase ダッシュボードで状態確認
3. 必要なら Vercel ログ・Supabase ログを確認して原因切り分け (本書 §6 障害対応へ)

---

