# 月次請求業務運用ガイド (super_admin 向け)

最終更新: 2026-06-01 (ADR-0022 Embedding 課金反映)

> 🆕 **ADR-0022 (2026-06-01) Embedding 課金導入反映済**: 月次請求集計 (`billing-aggregation.service.ts`) は `BILLABLE_FEATURE_UNITS` (= LLM + Embedding + Storage Overage の合算、ADR-0022 で 4 階層化) を対象。**Beginner プラン** は Embedding 系も ¥0 維持 (= cost=0 で SUM 不変)、**Expert / Pro プラン** は Embedding 業務操作 ¥5/call (ADR-0029) が自動的に請求金額に乗る。月初 cron 自動リカバリ (`*-embedding-backfill`) は明示的 free のため請求金額には含まれない (= 不当請求リスク回避)。詳細: [ADR-0022](../../adr/0022-embedding-usage-based-billing.md)
>
> **ADR-0019 (2026-05-24) 反映済** (ADR-0022 で部分 supersede): Expert 単価 ¥5 → ¥10、Pro ¥15 据置。詳細: [ADR-0019](../../adr/0019-billable-feature-units-and-free-tier-expansion.md)、Stripe Price 切替手順: [STRIPE_SETUP.md](../setup/STRIPE_SETUP.md) §2.1 / §2.2-bis

## 概要

本ドキュメントは、たすきば Knowledge Relay のシステム管理者 (super_admin) が、
顧客テナントに対して月次の請求業務を行うためのオペレーション手順をまとめたものである。

**重要前提**: v1 (2026-06-01 リリース) は **Stripe 等の決済プロバイダ自動連携を実装していない**。
請求書の発行・送付・入金確認はすべて super_admin による手動オペレーションで行う。

## 請求サイクル (2026-05-14 確定)

| 項目 | 値 |
|---|---|
| 締日 (請求対象期間の区切り) | **月末** (1日〜末日をその月の利用分とする) |
| 請求書発行期限 | **翌月15日** (= 締日後 15 日以内に super_admin が請求書 PDF を発行・メール送付) |
| 支払期限 | **翌月25日** (= 締日後 25 日、請求書発行から最大 10 日間) |
| 未入金検知 | **翌月26日朝** (前日の支払期限到来後すぐに確認) |
| 滞納フロー開始 | **翌月26日以降** ([PAYMENT_DELINQUENCY_SOP.md](./PAYMENT_DELINQUENCY_SOP.md) に従う) |

**例: 5月利用分**:
- 5/1〜5/31: 利用発生
- 6/1: 月初 cron 実行 (5月分が `tenant_monthly_usage_history` に確定)
- 6/1〜6/15: 請求書発行 (super_admin が手動でCSVダウンロード→PDF作成→メール送付)
- 6/16〜6/25: 顧客振込期間
- 6/25: 支払期限
- 6/26 朝: 未入金確認 → 滞納時はフェーズ1 へ

## 対象システム範囲

- システム管理者ダッシュボード: `/admin/super`
- 使用量サマリ + CSV エクスポート画面: `/admin/super/usage`
- 関連 API: `GET /api/admin/super/usage/export`
- 関連サービス: `src/services/super-admin.service.ts`
  - `listAllTenants(options)` — 当月分の請求対象テナント一覧
  - `listMonthlyUsageHistory(months)` — 過去月の使用量履歴
  - `deleteTenant(tenantId, performerId)` — テナント削除 (セルフ解約 / super_admin 削除 共通)

## プラン別の課金モデル

| プラン | 基本料金 | LLM 単価 (per-call) | DB 容量 | ファイルストレージ |
|---|---|---|---|---|
| Beginner | 無料 | 月間 50 回 billable call 上限 (超過で書込停止) | 50MB 無料、超過 ¥50/GB (peak-based) | 100MB 無料、超過 ¥10/GB (peak-based) |
| Expert | なし | **¥10/call** (ADR-0019 / 2026-05-24 改定: ¥5 → ¥10) | 同上 | 同上 |
| Pro | なし | **¥15/call** (project-upsert) + **¥15/call** (suggestion-explanation 「なぜ?」) | 同上 | 同上 |

- **すべての課金が従量制 = 日割り計算なし**:
  - LLM per-call 課金は call 時点の `Tenant.plan` 単価で記録 → 月途中でプラン変更しても自動分離
  - DB 容量 / ファイルストレージ超過分は **月中 peak** 値で月初請求 (ADR-0020 / ADR-0021)
- **プラン変更は全て即時反映** (2026-05-14 改修): アップグレード・ダウングレード問わず変更後の操作から新単価。Beginner ダウングレードのみ禁止 (ADR-0013)
- **月途中解約時の請求漏れは構造的に発生しない** (= 退会フローで当月 peak を即時請求、§月途中解約の検知メカニズム 参照)
- 旧 `storage_addon_plan` (standard / plus / pro_storage / enterprise の固定額 add-on) は **撤去完了** (chore/storage-addon-backend-removal 2026-05-26、migration `20260531_remove_storage_addon`)。ストレージ課金は ADR-0020 (DB 容量) + ADR-0021 (ファイル添付) の従量課金に一本化。

## 支払い方法ごとの運用フロー分岐 (2026-05-14 / Stripe 連携 v1.x で導入予定)

`Tenant.paymentMethod` の値ごとに本ガイドの適用範囲が異なる:

| paymentMethod | 月次請求書作成 | 入金確認 | 滞納検知 | 担当 |
|---|---|---|---|---|
| `invoice` (= 銀行振込) | super_admin が CSV → PDF → メール送付 (本ガイドの「§ 毎月 1〜15日」セクション) | 銀行口座を手動確認 | 翌月26日朝に未入金リスト | super_admin |
| `credit_card` (v1.x で実装) | 不要 (Stripe が自動 Invoice 生成) | Stripe Webhook で自動消込 | Stripe Smart Retries + 自動 suspend | **完全自動** |

> 2026-05-15: 旧 `bank_transfer` 値は `invoice` に統合済 (UI ラベル「銀行振込」)。詳細 [ADR-0007](../../adr/0007-unify-invoice-and-bank-transfer.md)。

**新規テナントのデフォルト**: `invoice` (= 銀行振込)。顧客が `/settings/tenant` でクレジットカード払いに任意切替可能 ([詳細: STRIPE_BILLING.md](../../business/STRIPE_BILLING.md))。

以下の手順は **`invoice` テナント (= 銀行振込) のみ** を対象。credit_card テナントは Stripe 連携で完全自動化される。

## 標準オペレーションフロー (毎月)

### 毎月 1 日 00:00 UTC (JST 09:00) — 自動

外部 cron (cron-job.org) が `tenant-monthly-reset` ジョブを実行し、以下を自動処理する。

1. `saveMonthlyUsageSnapshots()` — リセット直前の各テナント使用量を `tenant_monthly_usage_history` に保存 (= 前月分の確定スナップショット)
2. `resetTenantMonthlyCounters()` — 各テナントの `currentMonthApiCallCount` / `currentMonthApiCostJpy` を 0 にリセット
3. `applyScheduledPlanChanges()` (legacy) — `scheduledPlanChangeAt <= now` のテナントにプラン変更を適用。2026-05-14 改修で **新規にこの予約をセットするコードパスは廃止** (全プラン変更が即時反映、Beginner ダウングレードは完全禁止)。旧コード期間に作られた DB レコード対策として残置中
4. `applyStorageAddon()` — Storage プラン変更予約があれば適用
5. `runMonthlyEmbeddingBackfill()` — `content_embedding=NULL` の行を 5 テーブル (`projects` / `knowledges` / `risks_issues` / `retrospectives` / `memos`) から最大 128 件ずつ拾い、当月の予算枠で一括補完。「公開範囲: 自分のみ」は対象外。`generateAndPersistBatchEmbeddings` で **1 業務操作 = 1 ApiCallLog** に集約 (2026-05-15 で `memos` 追加)
6. `purgeOldDeletedTenants()` — 論理削除から 90 日経過したテナントの業務データを物理削除

**注意**: cron は `deletedAt: null` フィルタを当てているため、解約済テナントは月初 cron の対象外。
月途中解約のテナントは `deleteTenant()` 内で `tenant_monthly_usage_history` に **即座に**
スナップショットされる仕組みになっている (2026-05-14 改修)。

### CSV 取得タイミングと挙動の比較 (月末DL vs 月初DL)

たとえば「5月分」を請求する場合、ダウンロードタイミングごとに以下のような違いがある。

| シナリオ | 5/31 (月末) に当月 CSV (現在値) DL | 6/1 cron 後に過去月 CSV (yearMonth=2026-05) DL |
|---|---|---|
| 5/20 に解約したテナント | 含まれる (解約日列=5/20、課金額=解約時点の値) → 請求 | 含まれる (解約日列=5/20、課金額=確定値) → 請求 |
| 4/15 に解約したテナント | **含まれる** (解約日列=4/15、課金額=**4月時点の値** ⚠️) → **数値を無視して請求対象外と判断** | **含まれない** (該当月行が存在しない) → 自動的に除外 ✅ |
| 5月中アクティブのテナント | 含まれる (解約日列=空欄、課金額=5月累積) → 請求 | 含まれる (解約日列=空欄、課金額=確定値) → 請求 |

**推奨**: 可能なら **6/1 以降に過去月 CSV を使う** (誤読リスクが小さい)。
月末締めで請求書を即日発行したい場合は当月 CSV を使うが、解約日列の確認を運用ルール化する。

### 毎月 1〜15日 (締日) — 手動 (super_admin)

#### Step 1. 解約済も含む CSV をダウンロード

1. `/admin/super/usage` を開く
2. 「CSV エクスポート (請求業務用)」セクションの **「🔍 解約済テナントも含む」** 領域から、対象月の CSV をダウンロード
   - **当月分**: `📥 当月分 (現在値、解約済込み)` ボタン (= 通常 6/1 cron 前に解約があった場合の救済)
   - **過去月分**: `📥 YYYY-MM (解約済込み)` ボタン (= 通常はこちらを使用)
3. ダウンロードファイル名: `tenant-usage-{yearMonth}-with-deleted.csv` (Excel で開ける UTF-8 BOM 付き CSV)

#### Step 2. CSV 内容の確認 (請求対象の判別)

CSV の「解約日」列を **最初に確認** し、以下のルールで請求書を作成する。

| 解約日列 | 意味 | 請求対象期間 |
|---|---|---|
| 空欄 | アクティブテナント | 当月フル (=月末まで使った前提で当月分を請求) |
| 当月の ISO 形式日時 (例: `2026-05-20T03:00:00.000Z`) | 当月途中で解約済 | 月初から解約日まで (LLM・DB 容量・ファイルストレージすべて従量課金。退会フローで peak 値が即時記録済み = 追加合意不要) |
| **前月以前の ISO 形式日時** (例: `2026-04-15T03:00:00.000Z`) | **既に前月以前に解約済** | **請求対象外** (既処理済) |

#### ⚠️ Step 2 の重大な注意: 当月 CSV (現在値) の数値誤読リスク

**「📥 当月分 (現在値、解約済込み)」をDLしたとき**、前月以前に解約されたテナントの行も含まれる場合があるが、
その行の **API課金額 / Storage月額 / 合計月額の数値は「解約時点の値」がそのまま残っている** ことに注意。

これは、月初リセット cron (`resetTenantMonthlyCounters`) が `deletedAt: null` フィルタで
解約済テナントを **意図的に除外** している (= 解約時点のスナップショット保護) ことに起因する。

**運用ルール (必須)**:
1. CSV を開いたら **まず「解約日」列でソートまたはフィルタする**
2. 解約日が **当月初日より前 (例: 5月分業務なら 5/1 より前)** のテナントは
   **その行の課金額数値を見ずに「請求対象外」として除外する**
3. 当月解約 (解約日が当月内) または空欄 (アクティブ) の行のみ請求書を発行する

**そもそも誤読を避けたい場合**: 月初 (= 6/1 以降) に「📥 2026-05 (解約済込み)」**過去月 CSV** を使うほうが安全。
過去月 CSV には該当月の確定値しか入らず、前月解約済テナントは自動的に除外される
(`tenant_monthly_usage_history` に該当月の行が無いため)。

#### Step 3. 請求書 PDF の手作成 + メール送付

1. CSV の「会社名_法人名」「請求担当者」「請求先メール」「住所」を参照
2. 各テナントの請求書 PDF を **Google Docs / Excel / 経理ソフト** で手作成
   - 会社名 / 担当者 / 住所 / メール / 電話番号
   - 当月利用料 = CSV の「API課金額(円)」+「Storage月額(円)」=「合計月額(円)」
   - 振込先 (運営側の銀行口座情報) と **支払期限 = 翌月25日** (= 締日後 25 日)
3. PDF を「請求先メール」に手動送付
4. **解約済テナントは「解約日まで」と明記** した補足を添える

### 毎月 16〜25日 — 入金確認期間 (super_admin)

1. 翌月16日以降、毎日 / 隔日で運営側の銀行口座 (法人) で振込を確認
   - (顧客は支払期限 25日に向けて任意のタイミングで振り込む)
2. 入金があれば運用シート (Google Sheets 等) に消込記録

### 毎月 26日朝 — 未入金リスト確認 (super_admin)

1. 前日 (25日) の支払期限を過ぎた未入金テナントを抽出
2. 滞納フローへ移行
   - 詳細: [PAYMENT_DELINQUENCY_SOP.md](./PAYMENT_DELINQUENCY_SOP.md)
   - フェーズ判定基準日 = **支払期限 (= 翌月25日)** 起算

## 月途中解約の検知メカニズム (2026-05-14 改修)

### 問題点 (改修前)

`saveMonthlyUsageSnapshots()` 月次 cron が `deletedAt: null` でフィルタするため、
月の途中で解約されたテナントの当月分が **永久に `tenant_monthly_usage_history` に
記録されない** 問題があった。結果、過去月 CSV エクスポートから漏れて
請求業務上の取りこぼしが発生する可能性があった。

### 改修内容

`deleteTenant()` のトランザクション内で、解約時点の `currentMonthApiCallCount` /
`currentMonthApiCostJpy` を **当月の yearMonth** で `tenantMonthlyUsageHistory.upsert`
する処理を追加した。

```typescript
// src/services/super-admin.service.ts (deleteTenant 内)
prisma.tenantMonthlyUsageHistory.upsert({
  where: { tenantId_yearMonth: { tenantId, yearMonth } },
  create: { /* 解約時点の使用量を保存 */ },
  update: { /* 既存行がある場合は最新値で上書き */ },
});
```

これにより、解約直後から過去月 CSV エクスポートで当該テナントの解約月分が取得可能になる。

### 検証フロー

```
1. 5/20 にユーザA (Expert プラン、5月内に¥800分利用) がセルフ解約
   → deleteTenant() が tenant_monthly_usage_history に
     (tenantId=A, yearMonth=2026-05, apiCostJpy=800) を upsert
   → tenant.deletedAt = 2026-05-20T03:00:00Z をセット

2. 6/1 00:00 UTC: saveMonthlyUsageSnapshots cron 実行
   → deletedAt!=null のためユーザAテナントはスキップ (= 二重保存防止)
   → 他のアクティブテナントの 5月分が新規 upsert される

3. 6/15: super_admin が /admin/super/usage で
   「📥 2026-05 (解約済込み)」ボタン押下
   → CSV に「5月途中解約」テナントの行が含まれる
   → 「解約日」列に "2026-05-20T03:00:00.000Z" が出力
   → super_admin は「解約日までの ¥800」を請求書として発行
```

## CSV 列仕様

### 当月分 CSV (`yearMonth` 未指定)

> **⚠️ PR-V8 (2026-05-19) ★請求重要★ 仕様変更**: 「API呼出回数」「API課金額」列は **ApiCallLog SUM (真値) を主軸** にしました。counter (リアルタイムカウンタ) が破損していた場合でも、CSV には ApiCallLog SUM が出力されます。counter 値は参考列として並記し、両者に差分がある場合は **drift警告** 列で明示します。

| 列名 | 説明 |
|---|---|
| テナント連番 | 顧客に表示する人間可読 ID |
| テナント名 | テナント表示名 |
| プラン | beginner / expert / pro |
| **API呼出回数(ApiCallLog SUM=真値)** | **★ ApiCallLog 集計値 (= 請求書根拠の主軸、PR-V8)** |
| **API課金額(ApiCallLog SUM=真値, 円)** | **★ ApiCallLog cost 合計 (= 請求書根拠の主軸、PR-V8)** |
| API呼出回数(counter=参考) | リアルタイムカウンタ値 (drift 検出用の参考、PR-V8) |
| API課金額(counter=参考, 円) | リアルタイムカウンタ値 (drift 検出用の参考、PR-V8) |
| **drift警告** | **counter と SUM の乖離が 5% 超のとき "⚠ drift N.N%" を表示 (PR-V8)** |
| drift呼出差分 | counter − SUM (件数、符号付き、PR-V8) |
| drift費用差分(円) | counter − SUM (円、符号付き、PR-V8) |
| アクティブユーザ数 | 当月時点でアクティブなユーザ数 |
| 月次予算上限(円) | テナント側設定の上限 (空欄=無制限) |
| Storageプラン | standard / plus / pro_storage |
| Storage使用量(バイト) | 当月時点の使用量 |
| Storage月額(円) | 該当プランの固定額 |
| 合計月額(円) | API課金額(SUM) + Storage月額 (PR-V8 で SUM ベースに変更) |
| **解約日** | **空欄=アクティブ / ISO 日時=解約済 (2026-05-14 追加)** |
| 請求先種別 | 個人 / 法人 |
| 会社名_法人名 | 法人の場合のみ |
| 請求担当者 | 個人の場合は本人氏名 |
| 請求先メール | 請求書送付先 |
| 電話番号 | 連絡先 |
| 支払い方法 | invoice (= 銀行振込) ※既存 DB の旧 bank_transfer は invoice 互換 |
| 郵便番号 / 都道府県 / 市区町村 / 番地町名 / 建物名_部屋番号 | 構造化住所 |
| 請求書送付先住所_legacy | 旧 単一テキスト形式の住所 (フォールバック表示用) |

### 過去月 CSV (`yearMonth=YYYY-MM` 指定)

過去月の請求書 PDF 再現用のため、請求先列は含まない (= 履歴値、最新の請求先は別途 Tenant 詳細画面から確認)。

| 列名 | 説明 |
|---|---|
| テナント連番 | スナップショット時点 |
| テナント名 | 当月末時点 |
| プラン | 当月末時点 |
| API呼出回数 | 当月の確定値 |
| API課金額(円) | 当月の確定値 |
| アクティブユーザ数 | スナップショット時点 |
| Storageプラン | スナップショット時点 |
| Storage使用量(バイト) | スナップショット時点 |
| Storage月額(円) | スナップショット時点 |
| 合計月額(円) | 当月の合算 |
| **解約日** | **親テナントの `deletedAt` (空欄=アクティブ、ISO 日時=解約済)。月途中解約の判別用 (2026-05-14 追加)** |

## トラブルシューティング

### Q. 過去月 CSV に当該テナントの行が無い

**ケース A**: 当該テナントが対象月にまだ作成されていなかった
→ `createdAt` を確認。新規作成月の前月以前を指定すると行は存在しない。

**ケース B**: テナントが対象月以前に解約済 (deletedAt < 対象月の月初)
→ `deletedAt` 値を SQL で確認:
```sql
SELECT id, name, deleted_at
FROM tenant
WHERE id = '<tenantId>';
```
解約月から先は使用が発生しないため、履歴に追加行は作られない (正常)。

**ケース C**: 2026-05-14 改修以前に解約されたテナント
→ 改修前は `tenant_monthly_usage_history` に行が作られなかった。
DB を直接参照して `ApiCallLog` から `yearMonth` 集計を行う:
```sql
SELECT
  DATE_TRUNC('month', created_at AT TIME ZONE 'Asia/Tokyo') AS year_month,
  COUNT(*) AS api_call_count,
  SUM(cost_jpy) AS api_cost_jpy
FROM api_call_logs
WHERE tenant_id = '<tenantId>'
  AND created_at >= '2026-05-01'
  AND created_at < '2026-06-01'
GROUP BY 1;
```

### Q. 同一 yearMonth で重複行が出る

`tenantMonthlyUsageHistory` には `(tenantId, yearMonth)` UNIQUE 制約があるため重複は発生しない。
重複が見える場合は CSV の列パース不正の可能性。Excel の自動型変換等を疑う (CSV を必ずテキストエディタで生確認すること)。

### Q. 月初 cron が解約直前テナントの値を上書きしてしまうか

`saveMonthlyUsageSnapshots()` は `deletedAt: null` フィルタで解約済を弾くため、
`deleteTenant()` が upsert した値が cron で上書きされることはない。

## 関連ドキュメント

- [TENANT_AND_BILLING.md](../../business/TENANT_AND_BILLING.md) — プランと課金体系の業務仕様
- [PAYMENT_TERMS.md](../../business/PAYMENT_TERMS.md) — 法的・税務的な保持要件
- [PAYMENT_DELINQUENCY_SOP.md](./PAYMENT_DELINQUENCY_SOP.md) — 滞納時の対応フロー
- [CRON.md](./CRON.md) — 月次 cron の起動・監視仕様

## 改修履歴

- **2026-05-19 (PR-V8)**: ★請求重要★ 当月 CSV を ApiCallLog SUM (真値) ベースに変更
  - counter (Tenant.currentMonthApiCallCount) が破損していた場合でも CSV には真値が出力される
  - counter は参考列として並記、drift 警告列を新設 (Beginner プラン cost=0 でも call drift を検知)
  - 過去月の `tenant_monthly_usage_history` も `regenerateMonthlyHistoryFromApiCallLog` で再生成可能 (super_admin の `/admin/super/tenants/[id]/diagnostics` から実行)
  - 診断ダッシュボード `/admin/super/diagnostics` で drift / cron 健全性 / 縮退モード / メール失敗 / alert 機構を一画面で俯瞰
  - 関連 service: src/services/api-usage-recalc.service.ts (driftRatio を call+cost max 化、月境界を テナント TZ に統一) / monthly-history-regenerate.service.ts (新設) / cron-health.service.ts (新設) / diagnostics.service.ts (新設)
- **2026-05-14 (3rd)**: 請求サイクルを「月末締め + 翌月15日請求書発行 + 翌月25日支払」に確定。
  上部に「請求サイクル」セクション追加、「Step 3 支払期限」を「翌月25日固定」に変更、
  「Step 4 入金確認」を「翌月16〜25日 入金確認 + 翌月26日朝 未入金リスト確認」に分割。
  PAYMENT_TERMS.md §1.1 / PAYMENT_DELINQUENCY_SOP.md §0 と整合化。
- **2026-05-14 (2nd)**: 「当月分 CSV (現在値) における前月解約テナントの数値誤読リスク」を明文化。
  解約日列のフィルタを必須運用に追加し、推奨パス (過去月 CSV) を明示。
- **2026-05-29 (ADR-0025)**: Beginner プラン overage 課金 skip
  - `billOneTenantDbCapacityOverage()` / `billOneTenantFileStorageOverage()` で `tenant.plan === 'beginner'` の場合は ApiCallLog INSERT / Stripe queue / counter update をすべて skip
  - skip 証跡として `auditLog` に `entityType='api_call_log_skip'` + `afterValue.adr='ADR-0025'` 記録 (= 後から請求漏れ疑義に対する反証)
  - 月初 cron + 退会精算 (`tenant-withdrawal-billing.service.ts`) の両経路で適用
  - **確認手順**: 月初 cron 実行後、Beginner テナントの `apiCallLog` で `featureUnit IN ('db-capacity-overage','storage-file-overage')` が 0 件であること + `auditLog` で `entityType='api_call_log_skip'` の対応行があること
- **2026-05-14 (1st)**: 月途中解約の請求漏れ防止改修
  - `deleteTenant()` に `tenantMonthlyUsageHistory.upsert` を追加 (解約時スナップショット)
  - `listAllTenants()` に `includeDeleted` オプション追加
  - `listMonthlyUsageHistory()` に `tenantDeletedAt` を join 取得
  - CSV エクスポート API (`/api/admin/super/usage/export`) に `includeDeleted=true` クエリ + 「解約日」列追加
  - UI (`/admin/super/usage`) に「解約済テナントも含む」DL ボタン群を追加
- **2026-05-11**: Default テナント (運営者自身) を顧客集計から除外 + 別セクション表示
- **2026-05-08**: 初版 (P-5b 月次履歴 + P-A テナント削除 API + P-G 請求先情報)
