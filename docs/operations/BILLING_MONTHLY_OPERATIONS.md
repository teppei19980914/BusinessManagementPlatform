# 月次請求業務運用ガイド (super_admin 向け)

最終更新: 2026-05-14

## 概要

本ドキュメントは、たすきば Knowledge Relay のシステム管理者 (super_admin) が、
顧客テナントに対して月次の請求業務を行うためのオペレーション手順をまとめたものである。

**重要前提**: v1 (2026-06-01 リリース) は **Stripe 等の決済プロバイダ自動連携を実装していない**。
請求書の発行・送付・入金確認はすべて super_admin による手動オペレーションで行う。

## 対象システム範囲

- システム管理者ダッシュボード: `/admin/super`
- 使用量サマリ + CSV エクスポート画面: `/admin/super/usage`
- 関連 API: `GET /api/admin/super/usage/export`
- 関連サービス: `src/services/super-admin.service.ts`
  - `listAllTenants(options)` — 当月分の請求対象テナント一覧
  - `listMonthlyUsageHistory(months)` — 過去月の使用量履歴
  - `deleteTenant(tenantId, performerId)` — テナント削除 (セルフ解約 / super_admin 削除 共通)

## プラン別の課金モデル

| プラン | 月額 (基本) | 月額 (LLM) | Storage 月額 |
|---|---|---|---|
| Beginner | 無料 | 月間 100 回上限のため LLM 課金は発生しない | standard (0円) のみ |
| Expert | なし | ¥10/call の従量課金 | standard / plus (¥500) / pro_storage (¥1,500) |
| Pro | なし | ¥30/call の従量課金 | standard / plus / pro_storage |

- LLM 課金は **日割り計算なし** (= 月途中で解約しても従量課金のため過払い・未払いなし)
- Storage 月額は固定額。月途中で解約したら **その月の Storage 課金分は別途検討する必要あり**
  (現状の v1 仕様では月途中解約の Storage 課金は full 課金扱い、要顧客合意)

## 標準オペレーションフロー (毎月)

### 毎月 1 日 00:00 UTC (JST 09:00) — 自動

Vercel Cron が `tenant-monthly-reset` ジョブを実行し、以下を自動処理する。

1. `saveMonthlyUsageSnapshots()` — リセット直前の各テナント使用量を `tenant_monthly_usage_history` に保存 (= 前月分の確定スナップショット)
2. `resetTenantMonthlyCounters()` — 各テナントの `currentMonthApiCallCount` / `currentMonthApiCostJpy` を 0 にリセット
3. `applyScheduledPlanChanges()` — `scheduledPlanChangeAt <= now` のテナントにプラン変更を適用
4. `purgeOldDeletedTenants()` — 論理削除から 90 日経過したテナントの業務データを物理削除
5. その他 (embedding バックフィル等)

**注意**: cron は `deletedAt: null` フィルタを当てているため、解約済テナントは月初 cron の対象外。
月途中解約のテナントは `deleteTenant()` 内で `tenant_monthly_usage_history` に **即座に**
スナップショットされる仕組みになっている (2026-05-14 改修)。

### 毎月 1〜5 営業日以内 — 手動 (super_admin)

#### Step 1. 解約済も含む CSV をダウンロード

1. `/admin/super/usage` を開く
2. 「CSV エクスポート (請求業務用)」セクションの **「🔍 解約済テナントも含む」** 領域から、対象月の CSV をダウンロード
   - **当月分**: `📥 当月分 (現在値、解約済込み)` ボタン (= 通常 6/1 cron 前に解約があった場合の救済)
   - **過去月分**: `📥 YYYY-MM (解約済込み)` ボタン (= 通常はこちらを使用)
3. ダウンロードファイル名: `tenant-usage-{yearMonth}-with-deleted.csv` (Excel で開ける UTF-8 BOM 付き CSV)

#### Step 2. CSV 内容の確認 (請求対象の判別)

CSV の「解約日」列を確認し、以下のルールで請求書を作成する。

| 解約日列 | 意味 | 請求対象期間 |
|---|---|---|
| 空欄 | アクティブテナント | 当月フル (=月末まで使った前提で当月分を請求) |
| ISO 形式日時 (例: `2026-05-20T03:00:00.000Z`) | 月途中で解約済 | 月初から解約日まで (LLM は従量課金のためそのまま、Storage は別途合意) |

#### Step 3. 請求書 PDF の手作成 + メール送付

1. CSV の「会社名_法人名」「請求担当者」「請求先メール」「住所」を参照
2. 各テナントの請求書 PDF を **Google Docs / Excel / 経理ソフト** で手作成
   - 会社名 / 担当者 / 住所 / メール / 電話番号
   - 当月利用料 = CSV の「API課金額(円)」+「Storage月額(円)」=「合計月額(円)」
   - 振込先 (運営側の銀行口座情報) と支払期限 (請求日 + 30 日が標準)
3. PDF を「請求先メール」に手動送付
4. **解約済テナントは「解約日まで」と明記** した補足を添える

#### Step 4. 入金確認 (毎週月曜 10:00 JST 推奨)

1. 運営側の銀行口座 (法人) で前週分の入金を確認
2. 入金があれば運用シート (Google Sheets 等) に消込記録
3. 入金期日 (請求日 + 30 日) を過ぎても未入金のテナントは滞納対応へ
   - 詳細: [PAYMENT_DELINQUENCY_SOP.md](./PAYMENT_DELINQUENCY_SOP.md)

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

| 列名 | 説明 |
|---|---|
| テナント連番 | 顧客に表示する人間可読 ID |
| テナント名 | テナント表示名 |
| プラン | beginner / expert / pro |
| API呼出回数 | 月初リセット以降の合計コール数 |
| API課金額(円) | LLM 従量課金の合計 |
| アクティブユーザ数 | 当月時点でアクティブなユーザ数 |
| 月次予算上限(円) | テナント側設定の上限 (空欄=無制限) |
| Storageプラン | standard / plus / pro_storage |
| Storage使用量(バイト) | 当月時点の使用量 |
| Storage月額(円) | 該当プランの固定額 |
| 合計月額(円) | API課金額 + Storage月額 |
| **解約日** | **空欄=アクティブ / ISO 日時=解約済 (2026-05-14 追加)** |
| 請求先種別 | 個人 / 法人 |
| 会社名_法人名 | 法人の場合のみ |
| 請求担当者 | 個人の場合は本人氏名 |
| 請求先メール | 請求書送付先 |
| 電話番号 | 連絡先 |
| 支払い方法 | invoice / bank_transfer |
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

- [TENANT_AND_BILLING.md](../business/TENANT_AND_BILLING.md) — プランと課金体系の業務仕様
- [PAYMENT_TERMS.md](../business/PAYMENT_TERMS.md) — 法的・税務的な保持要件
- [PAYMENT_DELINQUENCY_SOP.md](./PAYMENT_DELINQUENCY_SOP.md) — 滞納時の対応フロー
- [CRON.md](./CRON.md) — 月次 cron の起動・監視仕様

## 改修履歴

- **2026-05-14**: 月途中解約の請求漏れ防止改修
  - `deleteTenant()` に `tenantMonthlyUsageHistory.upsert` を追加 (解約時スナップショット)
  - `listAllTenants()` に `includeDeleted` オプション追加
  - `listMonthlyUsageHistory()` に `tenantDeletedAt` を join 取得
  - CSV エクスポート API (`/api/admin/super/usage/export`) に `includeDeleted=true` クエリ + 「解約日」列追加
  - UI (`/admin/super/usage`) に「解約済テナントも含む」DL ボタン群を追加
- **2026-05-11**: Default テナント (運営者自身) を顧客集計から除外 + 別セクション表示
- **2026-05-08**: 初版 (P-5b 月次履歴 + P-A テナント削除 API + P-G 請求先情報)
