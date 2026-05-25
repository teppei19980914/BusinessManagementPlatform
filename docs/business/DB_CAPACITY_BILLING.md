# DB 容量従量課金 仕様書 (Business Logic + Operational Spec)

> **対象読者**: テナント管理者 / システム管理者 / 開発者 / 経理担当者
> **根拠 ADR**: [ADR-0020](../adr/0020-db-capacity-usage-based-billing.md)
> **実装 PR**: PR #443 (2026-05-25)
> **最終更新**: 2026-05-25

---

## 0. 1 ページサマリ (TL;DR)

| 項目 | 内容 |
|---|---|
| **何を課金するか** | テナントが PostgreSQL に保有する全データ (プロジェクト / 資産 / **ユーザ** / Knowledge / RiskIssue / Retrospective / Memo / 添付ファイルメタデータ / 監査ログ etc. = **36 テーブル横断**) |
| **無料枠** | **50MB / tenant** (SI 単位 = 50,000,000 bytes) |
| **超過単価** | **1GB tier ごとに ¥50** (1MB 未満は繰上、1GB = 1000MB、税抜) |
| **ハードキャップ** | **50GB / tenant** (技術安全のため、超過時 write 拒否) |
| **計測時点** | **月中 peak** (= 月内の最大値、月末削除→月初再投入の抜け道防止) |
| **計測頻度** | write 経由で即時 + daily cron で全テナント再計算 |
| **請求実行** | 月初 1 日 00:00 UTC の cron で前月分を確定 / 月途中退会は退会時に即時 |
| **請求送信** | 単一 transaction で ApiCallLog 記録 → Stripe Meter Event 経由で月末請求書に計上 |

---

## 1. 課金モデル

### 1.1 単価構造 (階段関数型)

DB 容量超過分は **1GB tier 単位** で ¥50 ずつ加算される階段関数型料金体系。

```
使用量 (peak)             課金額 (税抜)
─────────────────────────────────────
0 ~ 50MB (無料枠)          ¥0
51MB ~ 1,050MB             ¥50  (tier 1)
1,051MB ~ 2,050MB          ¥100 (tier 2)
2,051MB ~ 3,050MB          ¥150 (tier 3)
...
49,051MB ~ 50,000MB        ¥2,500 (tier 50 / ハードキャップ)
```

### 1.2 計算式

```ts
billable_mb = ceil(max(0, peak_bytes - 50MB) / 1MB)     // 1MB 切上
gb_tier     = ceil(billable_mb / 1000)                  // 1000MB tier 切上
cost_jpy    = gb_tier × ¥50                             // tier × ¥50
```

**実装**: [src/config/db-capacity-pricing.ts](../../src/config/db-capacity-pricing.ts) `calculateOverageJpy(peakBytes)`

### 1.3 計算例

| 月中 peak | 課金対象 (-50MB) | GB tier | 請求額 (税抜) | 備考 |
|---|---|---|---|---|
| 30MB | 0 | 0 | **¥0** | 無料枠内 |
| 50MB ちょうど | 0 | 0 | **¥0** | 無料枠ぎりぎり |
| 50MB + 1 byte | 1MB (切上) | 1 | **¥50** | tier 1 開始 |
| 100MB | 50MB | 1 | **¥50** | tier 1 内 |
| 1,050MB | 1,000MB | 1 | **¥50** | tier 1 上限 |
| 1,051MB | 1,001MB | 2 | **¥100** | tier 2 開始 |
| 2,050MB | 2,000MB | 2 | **¥100** | tier 2 上限 |
| 5GB | 4,950MB | 5 | **¥250** | tier 5 |
| 10GB | 9,950MB | 10 | **¥500** | tier 10 |
| 50GB (ハードキャップ) | 49,950MB | 50 | **¥2,500** | tier 50 (= 最大) |

### 1.4 単位定義 (SI)

| 単位 | 値 |
|---|---|
| 1MB | 10⁶ bytes = 1,000,000 bytes |
| 1GB | 10⁹ bytes = 1,000MB = 1,000,000,000 bytes |
| 50MB (無料枠) | 50,000,000 bytes |
| 50GB (ハードキャップ) | 50,000,000,000 bytes |

> Supabase 公式料金体系 (`$0.125/GB-month`) と整合させるため SI 単位を採用 (binary GiB ではない)。

### 1.5 税の取扱

- 上記単価は **税抜** 表記
- 消費税 (現状 10%) は請求書発行時に `src/config/billing.ts` の `TAX_RATE = 0.10` で一括加算
- Stripe Meter Event にも税抜額で送信、Stripe Tax 設定で自動付与可能

---

## 2. 計測 (What gets measured, When)

### 2.1 何が計測されるか

`tenant_id` カラムを持つ **全テーブル** (= 36 テーブル) の `pg_column_size` を集計。

#### 直接 tenant_id を持つテーブル (28 件)

| カテゴリ | テーブル |
|---|---|
| 基本 | `tenants`, `users`, `customers`, `projects`, `knowledges`, `risks_issues`, `retrospectives`, `memos`, `stakeholders` |
| 関連 | `comments`, `mentions`, `attachments`, `notifications` |
| 認証/トークン | `email_verification_tokens`, `password_reset_tokens`, `recovery_codes`, `password_histories` |
| 監査 | `audit_logs`, `auth_event_logs`, `role_change_logs`, `system_error_logs` |
| 課金/履歴 | `api_call_logs`, `billing_history`, `stripe_usage_record_queue`, `tenant_monthly_usage_history` |
| その他 | `tenant_consent_logs`, `tenant_import_preview`, `suggestion_explanations`, `email_send_logs` |

#### JOIN 経由でテナントに紐づくテーブル (8 件)

| テーブル | JOIN 経路 |
|---|---|
| `tasks` | → projects.tenant_id |
| `task_progress_logs` | → tasks → projects.tenant_id |
| `estimates` | → projects.tenant_id |
| `project_members` | → projects.tenant_id |
| `knowledge_projects` | → knowledges.tenant_id |
| `task_knowledges` | → knowledges.tenant_id |
| `risk_issue_projects` | → risks_issues.tenant_id |
| `retrospective_projects` | → retrospectives.tenant_id |

> **重要**: テーブル一覧は `information_schema.columns` から **動的列挙** されるため、将来 `tenant_id` カラムを持つテーブルが追加されたら自動的に課金対象に含まれる。CI ガード ([scripts/verify-tenant-storage-coverage.ts](../../scripts/verify-tenant-storage-coverage.ts)) で schema との整合性を検証。

実装: [src/services/tenant-storage-tables.service.ts](../../src/services/tenant-storage-tables.service.ts) `calculateTenantStorageBytesDynamic()`

### 2.2 いつ計測されるか (3 経路の補完層)

DB 容量は以下 **3 経路** で計測・更新され、相互に補完しあう設計:

```
┌──────────────────────────────────────────────────────────────────────────┐
│  経路 A: write 経由 (即時)                                                │
│    /api/projects POST → service → storage-guard.precheckStorageLimit()    │
│      → tx で実 write → assertStorageLimitInTx                             │
│      → pg_column_size 計測 → storage_bytes_peak_this_month を MAX 更新    │
│  対象: import 系 (data-import / external-data-import) の write 経路       │
└──────────────────────────────────────────────────────────────────────────┘
                                  ↓ 補完
┌──────────────────────────────────────────────────────────────────────────┐
│  経路 B: daily cron (= 一般 CRUD は経路 A を通らないため日次補完)         │
│    POST /api/cron/daily-notifications (毎日 09:00 UTC)                    │
│      → updateAllStorageBytesUsed() で全テナント再計算                     │
│      → storage_bytes_used 更新 + storage_bytes_peak_this_month を MAX 同期│
│  対象: 全テナント (deletedAt=null)、一般 CRUD で書込まれたデータも補足    │
└──────────────────────────────────────────────────────────────────────────┘
                                  ↓ 補完
┌──────────────────────────────────────────────────────────────────────────┐
│  経路 C: 月初 cron (= 前月 peak を確定して請求)                           │
│    POST /api/cron/tenant-monthly-reset (毎月 1 日 00:00 UTC)              │
│      → processTenantDbCapacityOverage()                                   │
│      → 前月 peak から課金額算出 → ApiCallLog INSERT → Stripe queue        │
│      → peak リセット (= 現在値を新月の起点に)                             │
└──────────────────────────────────────────────────────────────────────────┘
```

### 2.3 月中 peak とは

**月内のいかなる時点における最大使用量**。

```
時系列:    Day 1       Day 15      Day 25     Day 30 (月末)
使用量:    100MB    →   500MB   →  100MB   →   100MB
peak:      100MB    →   500MB   →  500MB   →   500MB  ← この値で月末課金
                                  ↑ 削除しても peak は維持
                                  ↑ 抜け道防止: 月末削除→月初再投入では peak が下がらない
```

**理由**: 月末直前に大量データを export+削除して、月初に再 import するパターン (= Supabase 原価は GB-Hours で発生しているが、たすきば側は ¥0 になる) を防止するため。

### 2.4 ハードキャップ (= 技術的な上限)

ハードキャップ **50GB** は **コスト上限ではなく、他テナント保護の技術的安全弁**:

- Supabase Pro 標準 Compute = Micro (1GB RAM)
- 単一テナントが 50GB を超えると embedding index が RAM を圧迫 → 他テナントの cache hit ratio 破壊
- 50GB 到達時は write 拒否、read / export は継続可能

到達時の挙動:
- POST/PATCH/DELETE で `403 STORAGE_LIMIT_EXCEEDED` を返す
- メッセージ: 「データ容量が上限 50GB に達しました。データを削除してから再度お試しください。データの読み取り・エクスポートは引き続き可能です。」
- 救済: テナント管理者が古いデータを削除 → 自動復帰

---

## 3. 請求タイミングとフロー

### 3.1 通常時 (月初 cron による前月分確定)

```
Timeline:
  ...
  2026-06-30 23:59:59  ← 6 月の最終秒
  ─────────────────────────────────────────────────────
  2026-07-01 00:00 UTC ← cron 起動 (毎月 1 日)
    │
    ├─ Step 1: processTenantDbCapacityOverage() ★ ADR-0020 新規
    │    │
    │    ├─ 各テナント (deletedAt=null) について:
    │    │   ├─ storage_bytes_peak_this_month を読出 (= 6 月の最大値)
    │    │   ├─ calculateOverageJpy(peak) で課金額算出
    │    │   └─ 課金額 > 0 なら以下を単一 transaction で:
    │    │       ├─ ApiCallLog INSERT (featureUnit='db-capacity-overage',
    │    │       │                     costJpy=N, createdAt=2026-06-30 末瞬間)
    │    │       ├─ Tenant.currentMonthApiCostJpy increment
    │    │       ├─ StripeUsageRecordQueue enqueue (callType='db_capacity_overage',
    │    │       │                                 quantity=N, nextSendAt=now)
    │    │       └─ AuditLog INSERT (= 監査・調査用)
    │    └─ peak リセット (= 7 月の起点に現在値を設定)
    │
    ├─ Step 2: saveMonthlyUsageSnapshots()
    │    └─ TenantMonthlyUsageHistory に 6 月分 snapshot (= 上記 ApiCallLog 含めた SUM)
    │
    ├─ Step 3: resetTenantMonthlyCounters()
    │    └─ currentMonthApiCallCount / currentMonthApiCostJpy リセット
    │
    └─ Step 4-7: その他既存ステップ (plan 適用 / embedding backfill / purge)

  2026-07-01 14:00 UTC ← daily cron (Stripe usage flush)
    │
    └─ flushStripeUsageRecordQueue()
        ├─ StripeUsageRecordQueue から未送信を取得
        ├─ Stripe billing.meterEvents.create() で送信
        │   - event_name: 'tasukiba_db_capacity_overage_jpy'
        │   - payload.value: quantity (= costJpy 円整数)
        │   - identifier: usage:db_capacity_overage:{apiCallLogId} (= 重複防止)
        │   - timestamp: 2026-06-30 末瞬間 (= 前月内なので 6 月分として計上)
        └─ 成功 → queue 行に sentAt 記録
```

### 3.2 月途中退会時 (即時請求)

退会タイミングで当月分を即時請求 (R5 横断対応):

```
2026-06-15 14:00 JST  ← テナント管理者が退会操作
  │
  └─ deleteTenant() API 起動
      │
      ├─ Step A: billTenantWithdrawal() ★ ADR-0020 新規
      │    └─ billOneTenantDbCapacityOverage({
      │        billingScope: 'current-month-on-withdrawal',
      │        // 同じ tx で ApiCallLog + counter + Stripe queue + audit_log を確定
      │        // requestId = 'db-capacity-overage-{tid}-2026-06-current-month-on-withdrawal'
      │        // ApiCallLog.createdAt = 退会時刻 (= 6 月内なので 6 月分)
      │      })
      │
      ├─ Step B: 当月 API 利用量も snapshot
      │    └─ ApiCallLog SUM (BILLABLE_FEATURE_UNITS で集計)
      │        - db-capacity-overage 含む (= Step A で INSERT 済)
      │        - project-upsert / suggestion-explanation 等の API 課金分も含む
      │
      ├─ Step C: TenantMonthlyUsageHistory upsert (= 当月分の最終確定)
      │
      └─ Step D: tenant.deletedAt = NOW() (= 論理削除)

  続けて翌日 14:00 UTC の Stripe usage flush で db_capacity_overage 含めて
  Stripe Meter Event 送信、6 月末請求書に計上される。
```

### 3.3 Stripe 側の請求書生成

```
2026-06-30                              ← Stripe 課金期間終了
2026-07-01 ~ 2026-07-03                 ← Stripe が 6 月分の usage を集計
2026-07-03 (Stripe configured day)      ← invoice 生成
  │
  ├─ 6 月内に受信した Meter Event を集計:
  │    - tasukiba_haiku_api_call  : N1 (Expert ユーザの project-upsert 等)
  │    - tasukiba_sonnet_api_call : N2 (Pro ユーザの suggestion-explanation 等)
  │    - tasukiba_db_capacity_overage_jpy : N3 (= DB 容量超過額の合計円整数)
  │
  ├─ Subscription Price で集計:
  │    - Haiku price (¥10/call) × N1
  │    - Sonnet price (¥15/call) × N2
  │    - DB capacity price (¥1/unit) × N3 = N3 円 (= 完全一致 invariant)
  │
  └─ 自動決済 (credit_card 払い) or 銀行振込請求書発行 (invoice 払い)
```

---

## 4. 4 層防御 (Level システム)

テナントの月中 peak に応じて 4 段階の警告/制限が発火:

| Level | 閾値 | 動作 | 通知 |
|---|---|---|---|
| **none** | 0 ~ 1GB | 通常運用 | — |
| **L1** | 1GB ~ 10GB | 通常運用 (請求は発生) | テナント管理者画面に警告 banner |
| **L2** | 10GB ~ 50GB | 通常運用 (高額請求警告) | super_admin に通知 (recordError warn) |
| **L3** | 50GB 以上 (ハードキャップ) | **write 拒否** | super_admin に緊急通知 + テナントに 403 エラー |
| **L4** | (instance-wide) Compute 推奨容量の 80% | super_admin に Compute upgrade 検討 alert | recordError + ダッシュボード banner |

実装: [src/config/db-capacity-pricing.ts](../../src/config/db-capacity-pricing.ts) `classifyDbCapacityLevel()`

### 4.1 通知ルール (R12)

| 通知種類 | チャネル | 冪等性 |
|---|---|---|
| 使用量 (L1-L4) ユーザ向け | **テナント設定画面に表示のみ** (メール送信なし) | 設定画面アクセス時に最新値を表示、能動通知なし |
| 使用量 super_admin 向け | recordError ログ + ダッシュボード banner | Level 昇格時のみ発火 (= 横ばい / 降格時は通知しない、spam 防止) |
| **単価変更 (≠ 使用量)** | **メール送信 + LP 掲示** (法務必須) | 単発イベント (年に数回以下) |

---

## 5. UI 動作

### 5.1 テナント管理者ダッシュボード

**画面**: `/settings/tenant` (テナント管理者がログイン後アクセス)
**コンポーネント**: [src/app/(dashboard)/settings/tenant/db-capacity-section.tsx](../../src/app/(dashboard)/settings/tenant/db-capacity-section.tsx)

表示内容 (server component で自テナントのみ):

```
┌─────────────────────────────────────────────────────────────┐
│ DB 容量 (従量課金)                       [Level バッジ]     │
├─────────────────────────────────────────────────────────────┤
│ 現在の使用量          月中ピーク (請求根拠)   想定請求額    │
│ 250 MB                300 MB                  ¥50           │
│ 最新: 2026-06-14 09:00  到達: 2026-06-10 14:30   月末 cron で確定 │
│                                                              │
│ [─────────────────────░░░░░░░░░░░░░░] (0.6%)               │
│ 0                          50GB ハードキャップ              │
│                                                              │
│ ▶ 料金体系を表示                                            │
└─────────────────────────────────────────────────────────────┘
```

### 5.2 システム管理者ダッシュボード

**画面**: `/admin/super` (super_admin role のみアクセス可)
**コンポーネント**: [src/app/(dashboard)/admin/super/db-capacity-alerts-card.tsx](../../src/app/(dashboard)/admin/super/db-capacity-alerts-card.tsx)

表示内容 (全テナント集計 + 警告レベルテナント一覧):

```
┌─────────────────────────────────────────────────────────────┐
│ DB 容量アラート (ADR-0020)                                  │
├─────────────────────────────────────────────────────────────┤
│ drift 検知           tenant peak SUM    pg_database_size    │
│ 12.3% (正常)         3.5 GB             3.9 GB              │
│                                                              │
│ ⚠️ 1 件 のテナントが circuit breaker open 中 (要復旧)        │
│                                                              │
│ 警告レベルテナント (3 件)                                   │
│ ┌─────────┬──────────┬───────────┬─────────────────────┐   │
│ │ テナント │ Level    │ 月中 peak │ peak 到達日時       │   │
│ ├─────────┼──────────┼───────────┼─────────────────────┤   │
│ │ Acme #5 │ L2 (10GB)│ 12.0 GB   │ 2026-06-12 10:23   │   │
│ │ Beta #8 │ L1 (1GB) │ 3.2 GB    │ 2026-06-08 15:10   │   │
│ │ Gamma#11│ L1 (1GB) │ 1.5 GB    │ 2026-06-14 09:00   │   │
│ └─────────┴──────────┴───────────┴─────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

---

## 6. drift 検知 (整合性監視)

全テナント peak SUM と PostgreSQL の `pg_database_size` を比較し、想定外の乖離を検知:

```
drift_ratio = (db_instance_size - tenant_peak_sum) / tenant_peak_sum

drift_ratio < 50%  : ok (正常範囲)
drift_ratio 50-100%: warning (recordError warn、調査推奨)
drift_ratio ≥ 100%: critical (recordError error、計測漏れの疑い)
```

**乖離の主な原因**:
- 計測対象外のテーブル (例: migration 履歴、システム共通テーブル) の膨張
- 運営直接 SQL によるデータ投入 (= 課金対象外、運営持ち出し)
- PostgreSQL の auto-vacuum 遅延による dead tuple 膨張

**実行頻度**: 日次 cron で計測。閾値超過時に super_admin に通知。

実装: [src/services/tenant-storage.service.ts](../../src/services/tenant-storage.service.ts) `detectDbCapacityDrift()`

---

## 7. 安全性・整合性保証

### 7.1 Billing Invariant (誤請求防止の根本)

**`ApiCallLog SUM (featureUnit='db-capacity-overage') = 画面表示 = Stripe Meter quantity = 請求書計上額`**

すべて `ApiCallLog.costJpy` を真値として参照するため、各経路での値ズレ (drift) が物理的に発生しない設計:

- ApiCallLog INSERT (真値、月初 cron または退会時)
- Tenant.currentMonthApiCostJpy (audit のみ、表示には ApiCallLog SUM を使用)
- Stripe Queue.quantity (= ApiCallLog.costJpy 整数で完全一致、R6 案 A)
- 画面表示 (= ApiCallLog から都度 SUM)

### 7.2 二重課金防止 (Idempotency)

`requestId = db-capacity-overage-{tenantId}-{yearMonth}-{billingScope}` という **composite key** で:
- 月初 cron で previous-month scope の重複 INSERT 不可
- 退会時 current-month-on-withdrawal scope の重複 INSERT 不可
- Stripe Meter event identifier も同 requestId 基準で 24h 重複防止

### 7.3 fail-close (R3)

storage-guard の `pg_column_size` 計測が失敗した場合:
- **fail-close**: write を 403 で拒否 (= 攻撃者が意図的に DB を高負荷化して制限解除を狙う経路を物理的に閉じる)
- **circuit breaker**: 3 回連続失敗で `storageGuardCircuitOpenedAt` セット、以降の write を完全拒否
- 復旧: super_admin が原因調査後、`POST /api/admin/super/tenants/[id]/storage-guard-reset` で手動 close

### 7.4 並列性制御

- `SELECT ... FOR UPDATE` で tenant 行ロック (= 同テナント並列 write race 防止)
- 月初 cron 実行と同テナント write は SELECT FOR UPDATE で直列化

---

## 8. 単価変更ルール (法務的要件)

**料金の値上げまたは課金体系の変更時** (将来 ¥50 → ¥60 等):

> 効力発生日の **30 日以上前** から ユーザ規約 (Terms of Service) 該当ページに掲示し、
> かつ **登録メールアドレスへ通知** する。

- 値下げの場合は即時適用可
- ADR 改訂必須 (新 ADR-002X 起票)
- **過去使用分には旧単価適用** (= 遡及課金禁止)
- 適用タイミング: 告知日翌月の月初から、または告知日 + 30 日後の翌月初 (どちらか遅い方)

---

## 9. 既存料金体系との比較

| 項目 | 旧 4 段階プラン (PR-3 / 2026-05-15) | **ADR-0020 (現行)** |
|---|---|---|
| 課金モデル | 月額固定 (Standard ¥0 / Plus ¥500 / Pro ¥1,500 / Enterprise ¥5,000) | **階段関数型従量課金** |
| 無料枠 | 20MB (Standard) | **50MB / tenant** (SI 単位) |
| 超過時挙動 | プラン上限超過は 7 日 Grace 後 write 拒否 | **超過分を従量課金、50GB hard cap** |
| 計測時点 | 現在の使用量 | **月中 peak** (= 抜け道防止) |
| 計測網羅性 | 16 テーブル SQL ハードコード (新規テーブル追加時の漏れリスク) | **動的解決** (`information_schema` 由来) + CI ガード |
| 計測対象テーブル数 | 16 | **36 テーブル** (= 旧実装の 20+ テーブルが課金漏れだった) |
| 1GB ヘビーユーザ料金 | ¥1,500/月 (Pro Storage プラン強制) | **¥50/月 (-97% 値下げ)** |

---

## 10. 関連ドキュメント

- **ADR-0020** [docs/adr/0020-db-capacity-usage-based-billing.md](../adr/0020-db-capacity-usage-based-billing.md): 設計判断の根拠 / 検討された代替案 / リスク評価
- **ADR-0019** [docs/adr/0019-billable-feature-units-and-free-tier-expansion.md](../adr/0019-billable-feature-units-and-free-tier-expansion.md): API 課金 (`BILLABLE_FEATURE_UNITS`) と同設計原則
- **TENANT_AND_BILLING.md** [docs/business/TENANT_AND_BILLING.md](./TENANT_AND_BILLING.md): テナント運用と課金モデル全般
- **STRIPE_SETUP.md** [docs/operations/STRIPE_SETUP.md](../operations/STRIPE_SETUP.md): Stripe Dashboard セットアップ手順
- **STRIPE_BILLING.md** [docs/business/STRIPE_BILLING.md](./STRIPE_BILLING.md): Stripe Metered Billing 全般
- **ENV_VARS.md** [docs/operations/ENV_VARS.md](../operations/ENV_VARS.md): 関連環境変数 (STRIPE_PRICE_DB_CAPACITY_OVERAGE 他)
- **KDD_PATTERNS.md** [docs/knowledge/KDD_PATTERNS.md](../knowledge/KDD_PATTERNS.md): §5.X+130-137 (PR #443 実装時の発見と教訓 14 件)

---

## 11. FAQ

### Q1. ユーザを 1 人追加すると課金されますか?
A. はい。`users` テーブルも 36 計測対象テーブルに含まれます。ただし 1 ユーザレコード = 数 KB 程度で、50MB 無料枠内に多数のユーザが収まります。例: 1 ユーザ ≒ 2KB なら 25,000 ユーザまで無料枠内。

### Q2. ファイル添付 (画像 / PDF) は課金対象ですか?
A. v1 では添付は metadata のみ (= ファイル本体は外部 storage バケット未統合)、`attachments` テーブルの row size (~400 bytes/件) のみ課金。Supabase Storage (S3 風) 連携は v1.x 以降の拡張で別途設計。

### Q3. 月中に大量データを投入してすぐ削除した場合、課金されますか?
A. **はい**。月中 peak ベース請求のため、削除後でも当月の peak は記録され、月末請求に計上されます。これは月末削除→月初再投入の抜け道防止のための仕様。

### Q4. 50GB ハードキャップを超えそうな場合、どうすればいいですか?
A. ハードキャップ到達前にデータの整理 (古い Knowledge / Memo の削除、過去プロジェクトのアーカイブ) を推奨。ハードキャップは技術的安全上の制約 (他テナント保護) のため引き上げ不可。50GB 超のデータ運用が必要な場合は別途お問い合わせください (v1.x で個別 Compute 契約フローを検討予定)。

### Q5. 想定請求額と実際の請求額がズレることはありますか?
A. 設計上発生しません。`ApiCallLog.costJpy` を真値として全経路で参照する **billing invariant** を実装しているため、ダッシュボード表示・請求書・Stripe Meter で値は完全一致します ([feedback_billing_invariant.md](../../memory/) と整合)。

### Q6. テナント間でデータが混在することはありますか?
A. ありません。すべての計測 SQL は `WHERE tenant_id = $1` でフィルタされ、JOIN 経由のテーブルも親テーブルの tenant_id で絞り込まれます。`SELECT ... FOR UPDATE` で同テナント行ロックも実装。テナント越境防止は [feedback_tenant_isolation.md](../../memory/) と整合した設計です。

### Q7. 退会したテナントの当月分は請求されますか?
A. はい。退会 API (`deleteTenant`) 内で即時請求集計が走り、退会時刻までの DB 容量 peak + API 利用量を当月分として ApiCallLog INSERT + Stripe queue enqueue します。月途中退会の課金漏れは旧仕様の抜け道でしたが、ADR-0020 で塞がれました。

---

## 12. 実装根拠 (検証履歴)

PR #443 (2026-05-25) で 6 回連続フルスキャン検証を実施、累計 14 件の実バグを発見・全修正:

| 検証回 | 主な発見 |
|---|---|
| 1 回目 | 設計レビュー (実バグ 0) |
| 2 回目 | $queryRawUnsafe 3 件 + daily cron peak gap → 全修正 |
| 3 回目 | requestId / circuit breaker / 予約語 / audit_log / rollback / 税抜 (6 件) → 全修正 |
| 4 回目 | migration 運営除外 / N+1 / management auth (3 件) → 全修正 |
| 5 回目 | 実バグ 0 + docs 改善 2 件 |
| 6 回目 | findMany→aggregate / dynamic import / 認可+型ガード (3 件) → 全修正 |

詳細: [KDD_PATTERNS.md §5.X+130-137](../knowledge/KDD_PATTERNS.md)

---

**本ドキュメントの位置付け**: ADR-0020 が「設計判断の why」を記述するのに対し、本ドキュメントは「運用・実装の what / when / how」を記述します。仕様変更時は本ドキュメントと ADR-0020 の両方を更新してください。
