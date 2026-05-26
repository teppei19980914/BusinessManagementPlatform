# ファイルストレージ従量課金 仕様書 (Business Logic + Operational Spec)

> **対象読者**: テナント管理者 / システム管理者 / 開発者 / 経理担当者
> **根拠 ADR**: [ADR-0021](../adr/0021-file-storage-usage-based-billing.md)
> **最終更新**: 2026-05-26

---

## 0. 1 ページサマリ (TL;DR)

| 項目 | 内容 |
|---|---|
| **何を課金するか** | Supabase Storage に保存されたファイル本体の合計サイズ (= プロジェクト・知見資産等への添付ファイル) |
| **無料枠** | **100MB / tenant** (SI 単位 = 100,000,000 bytes) |
| **超過単価** | **1GB tier ごとに ¥10** (1MB 未満は繰上、税抜) |
| **ハードキャップ** | **50GB / tenant** (技術安全・他テナント保護のため、超過時アップロード拒否) |
| **ファイルサイズ上限** | **50MB / 1 ファイル** (= 業務文書・画像をカバー、動画は不可) |
| **計測時点** | **月中 peak** (= 抜け道防止、ADR-0020 と同設計) |
| **embedding 生成** | text 系ファイル (PDF/Excel/CSV/text/docx) は **非同期で Voyage embedding 生成** (= 無料、提案エンジン + チャット検索の対象) |
| **チャット検索** | 「ファイル」「添付」「PDF」等のキーワード検出時、**attachment embedding のみ** スコープ |
| **Egress** | **当面無料** (Supabase Pro 250GB/月 含有で十分) |

---

## 1. 課金モデル

### 1.1 単価構造 (階段関数型、ADR-0020 と同パターン)

```
月中 peak                  課金額 (税抜)
─────────────────────────────────────
0 ~ 100MB (無料枠)         ¥0
101MB ~ 1,100MB            ¥10  (tier 1)
1,101MB ~ 2,100MB          ¥20  (tier 2)
2,101MB ~ 3,100MB          ¥30  (tier 3)
...
49,101MB ~ 50,000MB        ¥500 (tier 50 / ハードキャップ)
```

### 1.2 計算式

```ts
billable_mb = ceil(max(0, peak_bytes - 100MB) / 1MB)    // 1MB 切上
gb_tier     = ceil(billable_mb / 1000)                  // 1000MB tier 切上
cost_jpy    = gb_tier × ¥10                             // tier × ¥10
```

**実装**: [src/config/file-storage-pricing.ts](../../src/config/file-storage-pricing.ts) `calculateFileStorageOverageJpy(peakBytes)`

### 1.3 DB 容量との単価差の根拠

| 種別 | 単価 | 原価 | マージン |
|---|---|---|---|
| **DB 容量 (ADR-0020)** | ¥50/GB | ¥18.75 | +167% |
| **ファイルストレージ (ADR-0021)** | **¥10/GB** | ¥3.20 | +213% |

→ **ファイルストレージ原価が DB の 1/6 (Supabase Storage = $0.0213/GB vs DB Disk = $0.125/GB)** のため単価を下げ、ユーザ負担を軽減。

---

## 2. 計測 (What gets measured, When)

### 2.1 何が計測されるか

**Supabase Storage バケット内**、**当該テナント prefix 配下** の全オブジェクトサイズ合計。

```
attachments/
  └─ tenants/
      └─ {tenantId-UUID}/             ← この prefix 配下の全 object サイズ合計
          ├─ project/{entityId}/{file}
          ├─ knowledge/{entityId}/{file}
          ├─ task/{entityId}/{file}
          └─ ...
```

### 2.2 計測 SQL (Supabase 内部 `storage.objects`)

```sql
SELECT COALESCE(SUM((metadata->>'size')::bigint), 0)::bigint AS total_bytes
FROM storage.objects
WHERE bucket_id = 'attachments'
  AND name LIKE 'tenants/' || $1 || '/%';
```

実装: [src/services/file-storage-bucket-usage.service.ts](../../src/services/file-storage-bucket-usage.service.ts)

### 2.3 計測タイミング (3 経路、ADR-0020 と同パターン)

```
┌──────────────────────────────────────────────────────────────────────┐
│ 経路 A: アップロード時 post-check (即時)                              │
│   POST /api/attachments/finalize                                      │
│     → 実サイズ確認 → ハードキャップ post-check → peak MAX 更新        │
└──────────────────────────────────────────────────────────────────────┘
                              ↓ 補完
┌──────────────────────────────────────────────────────────────────────┐
│ 経路 B: daily cron (= 1 日 1 回再同期)                                │
│   updateAllFileStorageBytesUsed() で全テナント storage.objects 集計   │
│   → storage_file_bytes_used 更新 + peak MAX 同期                      │
└──────────────────────────────────────────────────────────────────────┘
                              ↓ 補完
┌──────────────────────────────────────────────────────────────────────┐
│ 経路 C: 月初 cron (= 前月 peak を確定して請求)                        │
│   processTenantFileStorageOverage() で ApiCallLog INSERT (前月)       │
│   → Stripe Queue enqueue → peak リセット                              │
└──────────────────────────────────────────────────────────────────────┘
```

### 2.4 月中 peak (= 抜け道防止、ADR-0020 と同設計)

```
時系列    Day 1     Day 15     Day 25   Day 30
使用量:   100MB  →  10GB    →  500MB  →  500MB
peak:     100MB  →  10GB    →  10GB   →  10GB  ← 月末請求対象
                            ↑ 削除しても peak は維持
```

---

## 3. ファイル添付 embedding (提案エンジン + チャット検索)

### 3.1 embedding 対象ファイルタイプ

| 拡張子 | text 抽出 | embeddingStatus |
|---|---|---|
| `.pdf` | `pdf-parse` でテキスト抽出 | 成功 → `'generated'` |
| `.xlsx` / `.xls` | `exceljs` でセル text 連結 (xlsx@sheetjs から swap、CVE 対応、KDD §5.X+141) | 成功 → `'generated'` |
| `.csv` | UTF-8 読込 + 行連結 | 成功 → `'generated'` |
| `.txt` / `.md` / `.json` | UTF-8 読込 | 成功 → `'generated'` |
| `.docx` | `mammoth` でテキスト抽出 | 成功 → `'generated'` |
| 画像 (JPG/PNG) | OCR 未対応 | `'unsupported'` |
| 動画 / ZIP / バイナリ | 抽出不可 | `'unsupported'` |

### 3.2 embedding 生成フロー (非同期)

```
[Browser] アップロード完了 (PUT to Supabase via Pre-signed URL)
            │
[Browser] POST /api/attachments/finalize ─→ [Server]
            │                                    │
            │                                    ├─ attachment row 作成 (embeddingStatus='pending')
            │                                    ├─ post-check (実サイズ / ハードキャップ)
            │                                    └─ embedding job キュー投入
            │
[Browser] ← Response { id, status: 'pending' }
            │
            │ (UI: 「検索インデックス作成中」表示、~12 秒で完成)
            │
[Background Job] (= 専用 cron / serverless function)
            ├─ Supabase Storage からファイル取得
            ├─ extension に応じて text 抽出
            ├─ Voyage embedding 生成 (featureUnit='attachment-embedding')
            └─ attachments.embedding / embeddingGeneratedAt / status='generated' 更新
```

### 3.3 課金扱い

`attachment-embedding` featureUnit は **無料** カテゴリ (= `BILLABLE_FEATURE_UNITS` に含めない、ADR-0019 と整合):

- ApiCallLog には記録 (= 監査・分析・将来の課金復活時の根拠)
- `costJpy = 0` で記録、counter 不変、Stripe queue 投入なし
- Voyage 200M tokens/月 無料枠 (= 全テナント共有) 内に十分収まる

### 3.4 チャット検索のスコープ拡張

#### 通常検索 (キーワードなし)

既存挙動を維持:
- Knowledge / RiskIssue / Retrospective / Memo embedding を検索対象
- attachment embedding は **含めない**

#### ファイル/添付限定検索 (キーワード検出時)

ユーザクエリに以下のキーワードが含まれる場合、**attachment embedding のみ** に絞り込む:

```ts
const FILE_SCOPE_KEYWORDS = [
  'ファイル', 'file', 'files',
  '添付', '添付ファイル', 'attachment', 'attachments',
  'PDF', 'Excel', 'xlsx', '資料', '文書', 'document',
];
```

### 3.5 提案エンジンへの組込

[src/services/suggestion.service.ts](../../src/services/suggestion.service.ts) は attachment embedding も提案候補に含める。UI で 📎 アイコン表示で Knowledge 等と区別。

---

## 4. 請求タイミングとフロー (= ADR-0020 と同パターン)

### 4.1 月初の請求確定

```
2026-06-30                                                       (= 6 月の最終秒)
─────────────────────────────────────────────────────────────────
2026-07-01 09:00 JST ★ 月初 cron 起動
  │
  ├─ Step 1: processTenantFileStorageOverage() ★ ADR-0021 新規
  │    └─ ApiCallLog INSERT (featureUnit='storage-file-overage', createdAt=前月末)
  │       + Tenant.currentMonthApiCostJpy increment
  │       + StripeUsageRecordQueue enqueue (callType='storage_file_overage')
  │       + AuditLog INSERT
  │
  ├─ Step 2: processTenantDbCapacityOverage() (= 既存 ADR-0020 経路)
  ├─ Step 3: saveMonthlyUsageSnapshots() (= 両方の cost を ApiCallLog SUM で snapshot)
  └─ Step 4-: 既存ステップ

2026-07-01 14:00 JST ★ Stripe usage flush cron
  └─ Stripe Meter Event 送信 (tasukiba_storage_file_overage_jpy + tasukiba_db_capacity_overage_jpy)
```

### 4.2 月途中退会時

[tenant-withdrawal-billing.service.ts](../../src/services/tenant-withdrawal-billing.service.ts) を拡張、退会時に **DB 容量 + ファイルストレージ両方** を即時請求 + Supabase Storage バケット内 tenant prefix を一括削除。

### 4.3 Stripe 請求書生成

```
6 月分の Meter Event:
  - tasukiba_haiku_api_call             : N1 (Expert)
  - tasukiba_sonnet_api_call            : N2 (Pro)
  - tasukiba_db_capacity_overage_jpy    : N3 (DB 容量)
  - tasukiba_storage_file_overage_jpy   : N4 (ファイルストレージ)  ★ ADR-0021 新規

Stripe Subscription Items でそれぞれの Price で計算 → 単一請求書に統合
```

---

## 5. 4 層防御 (Level システム)

| Level | 閾値 | アクション | 想定月額 |
|---|---|---|---|
| **none** | 0 ~ 1GB | 通常運用 | ¥0 ~ ¥10 |
| **L1** | 1GB ~ 10GB | テナント設定画面に警告表示 | ¥10 ~ ¥100 |
| **L2** | 10GB ~ 50GB | super_admin に recordError warn | ¥100 ~ ¥500 |
| **L3** | 50GB ハードキャップ | **アップロード拒否** (= read/download 継続可) | ¥500 |

---

## 6. セキュリティ・他テナント保護 (ADR-0021 §10)

### 6.1 攻撃ベクトルと対策

| 攻撃 | 対策 |
|---|---|
| **大容量ファイル DoS** (= サーバ memory/disk 圧迫) | Pre-signed URL 直接アップロード (= サーバ経由しない) + 50MB/file 上限 |
| **大量ファイル DoS** (= 50GB 超で他テナント影響) | 50GB ハードキャップ + Pre-signed URL 発行レート 10/min/tenant |
| **悪意ある MIME** (実行ファイル) | 拡張子 blacklist (`.exe` / `.bat` / `.sh` / `.ps1` 等) で拒否 |
| **path traversal** | ファイル名 sanitize + バケットパスに tenant prefix 強制 + RLS Policy |
| **Pre-signed URL 漏洩** | 有効期限 60 秒 + tenant_id 検証 + UUID 含むファイル名 |
| **embedding job 暴走** | per-tenant 5 並列上限 + Voyage 200M tokens watchdog |
| **delete API 連打** | per-tenant 100/min rate limit |
| **Storage 計測失敗** | circuit breaker (= 3 回失敗で write 拒否) |

### 6.2 RLS Policy (= テナント越境 DB レベル防止)

```sql
CREATE POLICY "tenant_isolation" ON storage.objects
FOR ALL
USING (
  bucket_id = 'attachments'
  AND (storage.foldername(name))[1] = 'tenants'
  AND (storage.foldername(name))[2] = (auth.jwt() ->> 'tenant_id')
);
```

### 6.3 危険拡張子 blacklist

```ts
const DANGEROUS_EXTENSIONS = [
  '.exe', '.com', '.bat', '.cmd', '.scr', '.msi', '.dll',
  '.ps1', '.vbs', '.js', '.jse', '.wsf', '.wsh',
  '.sh', '.bash', '.zsh', '.csh',
  '.apk', '.ipa',
  '.zipx', '.rar',  // .zip は許容
];
```

### 6.4 ファイル名 sanitize

```ts
function sanitizeFileName(name: string): string {
  return name
    .replace(/[\/\\:*?"<>|\x00-\x1f]/g, '_')
    .replace(/\.\./g, '_')
    .replace(/^\.+/, '_')
    .slice(0, 200);
}
```

### 6.5 異常使用検知 (= anomaly detection)

**1 日で 5GB 以上増加したテナント** → super_admin に anomaly alert (= drift 検知とは別の早期警告)

### 6.6 サーバ全体停止防止

Pre-signed URL アーキテクチャにより、**アップロード本体は Vercel/Netlify Function を一切通らない**。100 テナント同時 50MB アップロードでもサーバ負荷は数 MB 程度。

---

## 7. UI 動作

### 7.1 テナント管理者画面 (`/settings/tenant`)

[src/app/(dashboard)/settings/tenant/file-storage-section.tsx](../../src/app/(dashboard)/settings/tenant/file-storage-section.tsx):

- 現在の使用量 / 月中 peak / 想定請求額
- Level バッジ + 進捗バー (0-50GB)
- 料金体系の説明

### 7.2 super_admin 画面 (`/admin/super`)

[src/app/(dashboard)/admin/super/file-storage-alerts-card.tsx](../../src/app/(dashboard)/admin/super/file-storage-alerts-card.tsx):

- L1-L3 テナント一覧
- drift 検知 (peak SUM vs 実バケットサイズ)
- 異常使用検知 (1 日 5GB+ 増加)
- circuit breaker open テナント

### 7.3 ファイルアップロード UI

既存 attachment UI を拡張:
- ファイル選択 + 進捗バー
- 上限超過時にエラー表示
- embedding 生成状態 (`pending` / `generated` / `unsupported`) を表示
- 危険拡張子拒否時の即時フィードバック

---

## 8. 安全性・整合性保証 (= ADR-0020 と同パターン)

### 8.1 Billing Invariant

**`ApiCallLog SUM (featureUnit='storage-file-overage') = 画面 = Stripe Meter quantity = 請求書`**

### 8.2 二重課金防止

`requestId = storage-file-overage-{tenantId}-{yearMonth}-{billingScope}` で composite key 一意性。

### 8.3 fail-close + circuit breaker

storage-guard の Supabase API 呼出失敗時、3 回連続失敗で write 拒否 + super_admin 通知。

### 8.4 並列性制御

`SELECT FOR UPDATE` + Advisory Lock で月初 cron と write を直列化。

---

## 9. 単価変更ルール (= ADR-0020 と同)

> 効力発生日の **30 日以上前** にユーザ規約ページに掲示 + 登録メールアドレスへ通知。
> 値下げは即時可、過去使用分には旧単価適用 (遡及禁止)。

---

## 10. 関連ドキュメント

- **ADR-0021**: [docs/adr/0021-file-storage-usage-based-billing.md](../adr/0021-file-storage-usage-based-billing.md) — 設計判断の why
- **ADR-0020**: [docs/adr/0020-db-capacity-usage-based-billing.md](../adr/0020-db-capacity-usage-based-billing.md) — DB 容量課金 (本 ADR の設計パターン元)
- **ADR-0019**: [docs/adr/0019-billable-feature-units-and-free-tier-expansion.md](../adr/0019-billable-feature-units-and-free-tier-expansion.md) — Embedding 無料化原則
- **DB_CAPACITY_BILLING.md**: [docs/business/DB_CAPACITY_BILLING.md](./DB_CAPACITY_BILLING.md) — DB 容量仕様
- **TENANT_AND_BILLING.md**: [docs/business/TENANT_AND_BILLING.md](./TENANT_AND_BILLING.md) — 全体課金モデル
- **STRIPE_SETUP.md**: [docs/operations/STRIPE_SETUP.md](../operations/STRIPE_SETUP.md) — Stripe Meter 登録手順
- **利用者ガイド**: [docs/public/file-storage-billing-guide.md](../public/file-storage-billing-guide.md)

---

## 11. FAQ

### Q1. PDF / Excel をアップロードすると embedding 生成されますか?
A. はい、非同期で生成されます。アップロード後 12 秒以内に提案エンジン + チャット検索の対象になります。

### Q2. 画像 (JPG/PNG) は embedding 生成されますか?
A. 初期は対象外 (= `embeddingStatus='unsupported'`)。ファイル名・説明は検索対象になります。OCR 対応は将来検討。

### Q3. チャットで「PDF」と打つとどうなりますか?
A. 「ファイル」「添付」「PDF」等のキーワードが含まれると、**attachment embedding のみ** をスコープに検索します。Knowledge / RiskIssue 等は除外されます。

### Q4. ファイル削除すると Storage コストはすぐ削減されますか?
A. はい、論理削除と同時に Supabase Storage オブジェクトも削除されます。当月の peak は維持されますが、翌月以降は影響なし。

### Q5. 50GB ハードキャップに達したら他テナントに影響しますか?
A. 影響しません。Pre-signed URL アーキテクチャで本体は Supabase へ直接アップロードされ、サーバ全体は停止しません。当該テナントのみアップロード拒否、読み取り・ダウンロードは継続可能。

### Q6. 危険なファイル (.exe など) はアップロードできますか?
A. 拡張子 blacklist で拒否されます (`.exe` / `.bat` / `.sh` / `.ps1` 等)。`.zip` は許容 (= 業務利用想定)。

### Q7. Pre-signed URL が漏洩したら他人が書き込めますか?
A. 有効期限 60 秒 + ファイル名に UUID 含む + RLS Policy でテナント越境を DB レベルで拒否。漏洩時の被害は最小化されます。

### Q8. DB 容量と何が違いますか?
A. DB 容量はテキスト・JSON データ (¥50/GB)、ファイルストレージはバイナリファイル本体 (¥10/GB)。原価が異なるため別単価。請求書では別 SKU として表示。

---

## 12. 実装根拠 (検証履歴)

PR で 4-6 回連続フルスキャン検証を予定 ([ADR-0020](../adr/0020-db-capacity-usage-based-billing.md) と同パターン)。詳細は実装完了後に KDD §5.X+138 以降に記録。
