# ADR-0021: ファイル添付ストレージ従量課金 — Supabase Storage 連携 (2026-05-26)

- **Status**: Accepted (2026-05-26)
- **Date**: 2026-05-26
- **Deciders**: teppei
- **Based on**: [ADR-0020](./0020-db-capacity-usage-based-billing.md) (DB 容量従量課金) の設計パターンを流用

---

## Context

### 現状 (v1 = 2026-06-01 launch 時点)

[Attachment model](../../prisma/schema.prisma) は **URL 参照型 (= 外部リンク metadata のみ保有)** で、ファイルバイナリ本体は Supabase Storage 等の外部ストレージに保存されていない。

| 項目 | 現状 |
|---|---|
| `attachments` テーブル | ✅ 実装済 (7 種 polymorphic: project/task/estimate/risk/retrospective/knowledge/memo) |
| 保存内容 | URL + 表示名 + MIME ヒント + 追加者 (~400 bytes/行) |
| ファイル本体 | ❌ **未保存** (URL リンクのみ) |
| アップロード API | ❌ **未実装** |
| Supabase Storage 連携 | ❌ **未実装** |

[docs/business/DB_CAPACITY_BILLING.md §11 FAQ Q2](../business/DB_CAPACITY_BILLING.md) で「Supabase Storage 連携は v1.x 以降の拡張で別途設計」と明記済。本 ADR がその設計。

### 設計の前提

- **基盤**: [ADR-0020](./0020-db-capacity-usage-based-billing.md) のパターンを忠実に踏襲 (= 「月中 peak / 階段関数型 / 退会時即時請求 / drift 検知 / circuit breaker / billing invariant」を流用)
- **経済性**: Supabase Storage は DB Disk と別 SKU で **約 1/6 の原価** ($0.0213/GB-月 vs $0.125/GB-月)
- **業界水準**: AWS S3 $0.023 / GCS $0.020 / Cloudflare R2 $0.015 と比較し、Supabase Storage は競争力あり

### Supabase Storage 公式単価 (一次ソース)

[supabase.com/pricing](https://supabase.com/pricing) (2026-05 確認):

| 項目 | Free | **Pro (本サービス使用)** |
|---|---|---|
| Storage 含有 | 1 GB | **100 GB** |
| 超過単価 | — | **$0.0213 / GB / 月** |
| ファイルアップロード上限 | 50 MB | **500 MB** |
| Cached Egress 含有 | 5 GB | **250 GB/月** |
| Cached Egress 超過 | — | **$0.03/GB** |

円換算 (¥160/USD = 円安バッファ):
- **Storage 原価: 約 ¥3.41 / GB / 月** (¥150 換算なら ¥3.20)

---

## Decision

### 1. 課金パラメータ (本 ADR で確定)

| 項目 | 値 | 根拠 |
|---|---|---|
| **無料枠** | **100MB / tenant** | 画像 1-5MB / PDF 10MB を 50-100 件無料、中規模チーム想定 |
| **超過単価** | **¥10 / GB tier (階段関数型)** | Supabase 原価 ¥3.20-3.41/GB の +193% マージン、業界水準 (S3/R2 の 3-4 倍) と整合 |
| **端数処理** | 1MB 切上 → 1GB tier 切上 | DB 容量と同方式 |
| **単位** | **SI 単位** (1MB=10⁶ bytes, 1GB=10⁹ bytes) | DB 容量と整合、LP 表記と整合 |
| **計測時点** | **月中 peak** (= max bytes during month) | 月末削除→月初再投入の抜け道防止 (= ADR-0020 と同設計) |
| **ハードキャップ** | **50GB / tenant** | DB 容量と同閾値、ユーザ最大月額 ¥500 / 説明性 |
| **ファイル上限** | **50MB / 1 ファイル** | Supabase Free 同等、業務文書 (PDF/Excel/画像) は十分カバー |
| **Egress** | **当面無料** | Supabase Pro 250GB/月 含有で十分、業務ツール用途で超過想定なし |

### 2. 4 つの設計判断 (ユーザ確認済)

#### 2.1 バケット構造: **単一バケット + tenant prefix**

```
Supabase Storage Bucket: 'attachments'
  └─ tenants/
      ├─ {tenantId-A}/
      │   ├─ project/
      │   │   └─ {entityId}/{fileName}
      │   ├─ knowledge/
      │   │   └─ {entityId}/{fileName}
      │   └─ ...
      ├─ {tenantId-B}/
      │   └─ ...
```

- **理由**: Supabase バケット数上限抵触リスク回避、業界標準、計測も prefix グループで容易
- **代替案 (テナントごとバケット)** は数千テナントで上限到達リスク + 認可複雑化で却下
- **越境防止**: RLS policy で `auth.jwt() ->> 'tenant_id'` を照合、ファイル名にも tenant prefix 必須

#### 2.2 アップロード方式: **Pre-signed URL** (ブラウザ → Supabase 直接)

```
[Browser] ─ POST /api/attachments/upload ─→ [Server]
                                            │
[Server] ─ Pre-signed URL 発行 ─→ [Browser]
                                            │
[Browser] ─ PUT {file} ───→ [Supabase Storage] (= サーバ経由しない)
                                            │
[Browser] ─ POST /api/attachments/finalize ─→ [Server]
                                            │
                                            └─ DB に attachment row 作成
                                                + storage-guard post-check
```

- **理由**: Vercel/Netlify Function timeout 回避、サーバ負荷最小、業界標準
- **代替案 (サーバ経由)** は 50MB ファイルで function timeout リスク
- **計測**: アップロード完了後の `/api/attachments/finalize` で post-check 実施、または daily cron で `storage.objects` 集計

#### 2.3 ファイルタイプ: **初期は全タイプ許容**

- **理由**: 業務利用での予期せぬ拒否を回避、規約で不適切コンテンツ禁止を謳う、Supabase スキャン信頼
- **将来**: 不適切利用が検知された場合に MIME allowlist 追加 (= 段階的厳格化)

#### 2.4 削除時の Storage 取扱: **論理削除と同時に Storage オブジェクトも即時削除**

- **理由**: ストレージコスト即時削減、業界標準、シンプル
- **代替案 (30 日 grace 保持)** は cost 高 + UX 複雑度増で却下
- **暗黙のリスク**: 誤削除時の復旧不可 → UI で削除前確認 dialog 必須

### 3. 課金計算式

```ts
billable_mb = ceil(max(0, peak_bytes - 100MB) / 1MB)     // 1MB 切上
gb_tier     = ceil(billable_mb / 1000)                   // 1000MB tier 切上
cost_jpy    = gb_tier × ¥10                              // tier × ¥10
```

### 4. 計算例

| 月中 peak | 課金対象 (-100MB) | GB tier | 請求額 (税抜) |
|---|---|---|---|
| 80MB | 0 | 0 | **¥0** (無料枠内) |
| 100MB ちょうど | 0 | 0 | **¥0** |
| 101MB | 1MB | 1 | **¥10** |
| 1.1GB (= 1,100MB) | 1,000MB | 1 | **¥10** |
| 1,101MB | 1,001MB | 2 | **¥20** |
| 5GB | 4,900MB | 5 | **¥50** |
| 10GB | 9,900MB | 10 | **¥100** |
| 50GB (ハードキャップ) | 49,900MB | 50 | **¥500** |

### 5. 4 層防御 (= ADR-0020 と同パターン)

| Level | 閾値 | アクション | 想定月額 |
|---|---|---|---|
| **none** | 0 ~ 1GB | 通常運用 | ¥0 ~ ¥10 |
| **L1** | 1GB ~ 10GB | テナント設定画面に警告表示 | ¥10 ~ ¥100 |
| **L2** | 10GB ~ 50GB | super_admin に recordError warn | ¥100 ~ ¥500 |
| **L3** | 50GB ハードキャップ | **アップロード拒否** (= read/download 継続可) | ¥500 |

### 6. 横断対応 (= ADR-0020 から流用)

#### 6.1 ApiCallLog 真値経路

`featureUnit='storage-file-overage'` で識別。`BILLABLE_FEATURE_UNITS` に追加。

#### 6.2 Stripe Meter

| 項目 | 値 |
|---|---|
| Event Name | `tasukiba_storage_file_overage_jpy` |
| quantity | `costJpy` 整数 (R6 案 A、円単位送信で完全一致保証) |
| Price | ¥1 / unit |

#### 6.3 退会時即時請求

[tenant-withdrawal-billing.service.ts](../../src/services/tenant-withdrawal-billing.service.ts) を拡張し、DB 容量 + ファイルストレージ両方を同 transaction で即時請求。

#### 6.4 drift 検知

全テナント peak SUM (= 計測値) vs Supabase Storage バケット実サイズ (= 真値) を日次比較。乖離率 50%/100% で recordError warn/error。

### 7. 計測戦略

#### 7.1 主たる計測: `storage.objects` テーブル集計

Supabase は内部的に PostgreSQL の `storage.objects` テーブルでオブジェクトメタデータを管理。各行に `metadata.size` (bytes) を含む。テナント prefix でフィルタして SUM 集計が可能。

```sql
SELECT COALESCE(SUM((metadata->>'size')::bigint), 0)::bigint AS total_bytes
FROM storage.objects
WHERE bucket_id = 'attachments'
  AND name LIKE 'tenants/' || $1 || '/%';
```

#### 7.2 補助: write 時の post-check

アップロード完了 webhook (= `/api/attachments/finalize`) で個別計測 + peak MAX 更新。daily cron で再同期。

### 8. データモデル拡張

#### 8.1 Tenant 新規カラム

```prisma
storageFileBytesUsed              BigInt    @default(0)  // 現在値
storageFileBytesPeakThisMonth     BigInt    @default(0)  // 月中 peak
storageFileBytesPeakAt            DateTime?              // peak 到達時刻
fileStorageWarningLevel           String    @default("none") @db.VarChar(8)  // none/l1/l2/l3
```

#### 8.2 Attachment 新規カラム

```prisma
storageObjectKey  String?                       // S3 オブジェクトキー (= tenants/{tid}/{entityType}/...)
sizeBytes         BigInt?                       // ファイル本体サイズ (= 計測 + 表示用)
storageProvider   String   @default("url") @db.VarChar(20)  // 'url' | 'supabase'
// === ファイル本体 embedding (= 提案エンジン + チャット検索の対象、追加要件) ===
embedding         Unsupported("vector(1024)")?  // Voyage embedding (= file 本体テキストから生成)
embeddingStatus   String   @default("pending") @db.VarChar(20)  // 'pending' | 'generated' | 'unsupported' | 'failed'
extractedTextHash String?  @db.VarChar(64)      // text 抽出結果の SHA-256 (= 内容変更検知)
embeddingGeneratedAt DateTime?
```

**既存データ migration**: `storageProvider='url'` で backfill (= 旧 URL 参照型は **課金対象外**、後方互換)。新規 Pre-signed URL 経由アップロードは `'supabase'` で課金対象。

---

## 9. ファイル添付 embedding (= 提案エンジン + チャット検索スコープ拡張、ユーザ追加要件)

### 9.1 目的

添付ファイルを「**提案エンジンが意味検索可能な資産**」として扱う。具体的には:

- ファイルをアップロード → 自動で text 抽出 → Voyage embedding 生成
- 提案エンジンの類似度検索対象に追加 (= Knowledge / RiskIssue 等と並列)
- チャット意味検索で「ファイル」「添付」キーワード時に **ファイル embedding のみ** をスコープに絞り込む

### 9.2 対象ファイルタイプと text 抽出

| 拡張子 | text 抽出方法 | embeddingStatus |
|---|---|---|
| `.pdf` | `pdf-parse` ライブラリでテキスト抽出 | 成功 → `'generated'` / 失敗 → `'failed'` |
| `.xlsx` / `.xls` | `exceljs` ライブラリでセル text 連結 (※元は `xlsx@sheetjs` 採用予定だったが fix なし High CVE 2 件 = GHSA-4r6h-8v6p-xvw6 / GHSA-5pgg-2g8v-p4x9 のため swap、KDD §5.X+141) | 成功 → `'generated'` |
| `.csv` | UTF-8 で読込、行単位連結 | 成功 → `'generated'` |
| `.txt` / `.md` / `.json` | UTF-8 で読込 | 成功 → `'generated'` |
| `.docx` | `mammoth` ライブラリでテキスト抽出 | 成功 → `'generated'` |
| **画像 (JPG/PNG/etc)** | **OCR 未対応** (= 将来拡張) | `'unsupported'` |
| **動画 / ZIP / バイナリ** | 抽出不可 | `'unsupported'` |

### 9.3 生成タイミング: **非同期 background job**

```
[Browser] PUT to Supabase (Pre-signed URL)
            │
[Browser] POST /api/attachments/finalize ─→ [Server]
            │                                    │
            │                                    ├─ attachment DB row 作成 (embeddingStatus='pending')
            │                                    ├─ storage-guard post-check
            │                                    └─ embedding job をキューに投入 (= 別 cron / serverless function で処理)
            │
[Browser] ← Response: { attachment_id, status: 'pending' }
            │
            │ (UI に「検索インデックス作成中」表示、最大 12 秒以内に embedding 生成)
            │
[Background Job]
            ├─ Supabase Storage から file 取得
            ├─ extension に応じて text 抽出
            ├─ Voyage embedding 生成 (featureUnit='attachment-embedding')
            └─ attachments.embedding + embeddingGeneratedAt 更新 (status='generated')
```

### 9.4 課金扱い

`attachment-embedding` featureUnit を **無料** カテゴリで定義 (= BILLABLE_FEATURE_UNITS には含めない)。

- 根拠: ADR-0019 で確立した「Embedding-only は全プラン無料」原則と整合
- 実コスト: Voyage voyage-4-lite (12K tokens/file × $0.02/1M tokens ≒ ¥0.036/file) で極小
- 200M tokens/月 無料枠 (Voyage アカウント単位) 内に十分収まる

ApiCallLog には記録 (= 監査・将来の課金復活時の根拠データ)、`costJpy=0`、Stripe queue 投入なし。

### 9.5 チャット意味検索のスコープ拡張

#### 9.5.1 通常検索 (ファイル / 添付 キーワードなし)

既存挙動を維持:
- Knowledge / RiskIssue / Retrospective / Memo embedding を検索対象
- attachment embedding は **含まない** (= ファイルは別途エンティティとして扱うため)

#### 9.5.2 ファイル/添付限定検索 (キーワード検出時)

ユーザクエリに「ファイル」「添付」「PDF」「Excel」「資料」等のキーワードが含まれる場合:
- **attachment embedding のみ** を検索対象 (= 他の embedding は除外)
- 検索結果は「添付ファイル一覧」UI として表示

#### 9.5.3 キーワード検出ロジック

```ts
// src/services/chat-semantic-search.service.ts
const FILE_SCOPE_KEYWORDS = [
  'ファイル', 'file', 'files',
  '添付', '添付ファイル', 'attachment', 'attachments',
  'PDF', 'pdf',
  'Excel', 'excel', 'xlsx',
  '資料', '文書', 'document', 'docs',
];

function detectFileScopeQuery(query: string): boolean {
  const lower = query.toLowerCase();
  return FILE_SCOPE_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()));
}
```

初期は literal match で開始、将来は LLM ベースの intent classification に拡張可能。

### 9.6 提案エンジン (suggestion engine) への組込

[src/services/suggestion.service.ts](../../src/services/suggestion.service.ts) (= 提案エンジン) は現状 Knowledge を主対象としている。本 ADR で:

- attachment embedding も提案候補に含める
- 表示時に「📎 ファイル添付」アイコンで Knowledge / RiskIssue 等と区別
- 提案候補スコアリングは embedding similarity ベース (= 既存ロジック流用)

### 9.7 削除時の embedding 扱い

attachments 論理削除 (= storageProvider='supabase' で Storage オブジェクトも即時削除) と同時に embedding 行も削除。`deletedAt` 付与で検索結果から除外。

---

## 10. セキュリティ・ハードキャップ・他テナント保護 (ユーザ追加要件)

**根本原則**: **単一テナントの不正利用が他テナント・サーバ全体に波及してはならない**。
ADR-0020 R3 「他テナントへの影響は絶対不許容」を全攻撃ベクトルで担保する。

### 10.1 想定する攻撃シナリオと対策

| 攻撃ベクトル | リスク | 対策層 |
|---|---|---|
| **大容量ファイル DoS** | サーバ memory/disk 圧迫、Function timeout | (1) Pre-signed URL 直接アップロード (= サーバ通さない) / (2) 50MB/ファイル サーバ側検証 / (3) Supabase 側 500MB 上限 |
| **大量ファイルアップロード DoS** | テナント全体で 50GB 超 / 他テナント cache 圧迫 | (1) 50GB ハードキャップ即時拒否 / (2) Pre-signed URL 発行レート制限 (= 10 req/min/tenant) |
| **悪意ある MIME (実行ファイル)** | サーバ・他ユーザへのマルウェア配布 | 危険拡張子 blacklist (.exe / .bat / .sh / .cmd / .com / .scr / .ps1 / .vbs) で拒否 |
| **path traversal** | バケット越境、他テナントオブジェクト読取 | ファイル名 sanitize + バケット path に tenant prefix 強制 |
| **Storage 計測失敗** | drift で課金漏れ + 暴走検知不能 | circuit breaker (= 3 回失敗で write 拒否)、drift 検知 daily cron |
| **embedding job 暴走** | Voyage API rate limit 抵触、200M 無料枠食い潰し | per-tenant job 並列上限 (= 5 件まで)、Voyage 月次 token 消費 watchdog |
| **Pre-signed URL 漏洩** | 第三者が tenant データ書込 / 越境 | URL 有効期限 60 秒 + tenant_id 検証 + ファイル名予約 (= ハッシュ含む) |
| **delete API 連打** | Supabase API rate limit、storage_objects ロック | per-tenant rate limit (= 100/min)、batch delete API 推奨 |

### 10.2 多層防御の実装

#### 10.2.1 Pre-signed URL 発行時の検証 (Layer 1)

[POST /api/attachments/upload](#) で以下を全部チェック後に URL 発行:

```ts
1. 認証: session.user 必須、role 確認
2. テナント越境: entityId が user.tenantId 配下か確認
3. ハードキャップ: precheckFileStorageLimit() で 50GB 残量チェック
4. ファイルサイズ: requested filesize <= 50MB (= サーバ側強制)
5. 危険 MIME: ext が DANGEROUS_EXTENSIONS にないこと
6. ファイル名: sanitize (path traversal 文字除去、長さ制限 200 文字)
7. レート制限: per-tenant Pre-signed URL 発行 10 req/min
8. URL 有効期限: 60 秒に短縮 (= 漏洩時の被害最小化)
```

#### 10.2.2 アップロード後の検証 (Layer 2)

`POST /api/attachments/finalize` で実物のサイズを Supabase API で確認:

```ts
1. Storage オブジェクト存在確認 (= Pre-signed URL は使ったが実際アップ完了か)
2. 実サイズが requested 内 (= 50MB 超なら即時削除 + reject)
3. ハードキャップ post-check (= 50GB 超えていたら即時削除 + 403)
4. RLS 検証 (= ownership 再確認)
5. attachments DB row 作成 + embedding job キュー投入
```

#### 10.2.3 Background job の throttling (Layer 3)

```ts
// src/services/attachment-embedding.service.ts
const MAX_CONCURRENT_EMBEDDING_PER_TENANT = 5;
const MAX_GLOBAL_EMBEDDING_CONCURRENT = 50;

// Voyage 200M 無料枠監視 (= 既存 usage-monitoring.service と統合)
// 160M 警告 / 180M 全テナント縮退モード (ADR-0019 と同パターン)
```

#### 10.2.4 異常使用検知 (Layer 4)

`detectFileStorageDrift` を拡張し、**急激な容量増加を異常として通知**:

```ts
// 1 日で 5GB 以上増加したテナント → super_admin に anomaly alert
// = ADR-0020 の drift 検知 (集計漏れ検知) とは別の「使用パターン異常」検知
```

#### 10.2.5 Storage 操作 circuit breaker (Layer 5)

`storage-bucket-usage.service` の Supabase API 呼出が連続失敗した場合 (= ADR-0020 ハードキャップ判定不能時と同様)、circuit を open し write 全拒否 + super_admin alert。

### 10.3 危険拡張子 blacklist

```ts
const DANGEROUS_EXTENSIONS = [
  // Windows 実行
  '.exe', '.com', '.bat', '.cmd', '.scr', '.msi', '.dll',
  // Script
  '.ps1', '.vbs', '.js', '.jse', '.wsf', '.wsh',
  // Unix
  '.sh', '.bash', '.zsh', '.csh',
  // Mobile
  '.apk', '.ipa',
  // Archive (= ZIP bomb 防止のため拡張子レベルで拒否)
  '.zipx', '.rar',  // .zip は許容、ただしサイズで防御
] as const;
```

`'.zip'` は許容 (= 業務利用想定) だが、解凍は **クライアント側で実施** (サーバ側は zip bomb 被害なし)。

### 10.4 ファイル名 sanitize

```ts
function sanitizeFileName(name: string): string {
  return name
    .replace(/[\/\\:*?"<>|\x00-\x1f]/g, '_')  // OS 禁止文字
    .replace(/\.\./g, '_')                     // path traversal
    .replace(/^\.+/, '_')                       // 隠しファイル偽装
    .slice(0, 200);                             // 長さ制限
}
```

### 10.5 Storage Object Key の構成

bucket 内パスは以下の **固定 schema** で全テナント越境を物理的に不可能化:

```
tenants/{tenantId-UUID}/{entityType}/{entityId-UUID}/{uuid-v4}-{sanitized-filename}
```

- `tenantId-UUID`: API 側で session から取得、URL からの受取拒否
- `entityType`: validators で allowlist (= 'project'|'task'|'estimate'|...)
- `uuid-v4`: 衝突防止 + 同名ファイル重複可

### 10.6 RLS Policy

Supabase Storage の RLS で **bucket 内のパス prefix と JWT claim を照合**:

```sql
CREATE POLICY "tenant_isolation" ON storage.objects
FOR ALL
USING (
  bucket_id = 'attachments'
  AND (storage.foldername(name))[1] = 'tenants'
  AND (storage.foldername(name))[2] = (auth.jwt() ->> 'tenant_id')
);
```

これで仮に Pre-signed URL や ANON KEY が漏洩しても、テナント越境は **データベースレベルで拒否** される。

### 10.7 ハードキャップ到達時の挙動

```
50GB 到達テナントの状態:
  ├─ 新規 Pre-signed URL 発行 → 403 'STORAGE_FILE_HARD_CAP_EXCEEDED'
  ├─ 既存ファイルの read / download → 継続可
  ├─ 既存ファイルの delete → 継続可 (= 削減手段の提供)
  └─ 他テナント → 完全に独立して動作 (= 他テナント影響ゼロ)
```

### 10.8 サーバ全体停止防止

`Pre-signed URL` 方式により **アップロード本体はサーバを経由しない**。サーバ負荷は:
- URL 発行 API (= 軽量、~10ms)
- finalize API (= Supabase API 呼出 ~100ms)
- embedding background job (= per-tenant 5 並列上限、テナント間で公平な queue)

100 テナントが同時に 50MB アップロードしても、サーバ memory/CPU は ~数 MB 程度の負荷で済む (= Pre-signed URL アーキテクチャの根本利点)。

---

## Consequences

### Positive

- **大幅な値下げ感**: 旧 4 段階 Storage Plan (Plus ¥500 / Pro ¥1,500 / Enterprise ¥5,000) と比べ、ヘビーユーザでも月 ¥100 程度
- **ADR-0020 と統一感**: 開発者・運用者・利用者にとって学習コスト最小
- **採用ハードル削減**: 100MB 無料枠で典型ユーザはほぼ無料
- **本格利用にも対応**: 50GB 上限で実質無制限、上限到達は月 ¥500 のみ
- **計測 invariant 保証**: ApiCallLog SUM = Stripe Meter quantity の完全一致 (= R6 案 A)
- **業界水準価格**: Cloudflare R2 / S3 の 3-4 倍 = 一般的な SaaS 上乗せ率

### Negative / Trade-off

- **月中 peak ベース** のため、一時的大量アップロード → 削除 で実コスト以上に請求される可能性 ([ADR-0020 §6.3 と同型問題](./0020-db-capacity-usage-based-billing.md))
- **ハードキャップ 50GB** はメディア配信サービスとしての利用を阻害 (= 想定外の用途)
- **削除即時 Storage 削除** は誤操作リスク → UI で削除前確認必須

### Risk / 留意事項

- **Supabase Storage 障害時**: 添付機能停止 → エラーハンドリングと fail-soft UX 設計必須
- **Egress 単価変動リスク**: 当面無料だが、Supabase 値上げで本サービスも有料化検討の可能性
- **既存 URL 参照型との混在**: 1 つの entity に `url` と `supabase` の両方の attachment が紐づくケース → UI で区別表示

---

## Alternatives Considered

### Alt-1: テナントごと独立バケット
- **却下理由**: 数千テナントで Supabase バケット数上限抵触、認可ロジック複雑化、計測コスト増

### Alt-2: サーバ経由アップロード
- **却下理由**: Vercel/Netlify Function timeout (50MB ファイル × 中速回線 = 10 秒以上)、コスト増、業界標準でない

### Alt-3: ¥50/GB (DB 容量と同価格)
- **却下理由**: Storage 原価 ¥3.20 に対し +1463% マージンは過大、ユーザ説明力低下

### Alt-4: 月末 snapshot ベース (peak 不採用)
- **却下理由**: 月末削除 → 月初再投入の抜け道、ADR-0020 と同設計判断

---

## 単価変更ルール (= ADR-0020 と同)

> 効力発生日の **30 日以上前** から ユーザ規約ページに掲示し、かつ **ご登録メールアドレスへ通知** する。
> 値下げの場合は即時適用可。過去使用分には旧単価適用 (= 遡及課金禁止)。

---

## Related

- [ADR-0020](./0020-db-capacity-usage-based-billing.md): DB 容量従量課金 (本 ADR のパターン元)
- [ADR-0019](./0019-billable-feature-units-and-free-tier-expansion.md): 課金 featureUnit の中央定義原則
- 詳細仕様: [docs/business/FILE_STORAGE_BILLING.md](../business/FILE_STORAGE_BILLING.md)
- 利用者ガイド: [docs/public/file-storage-billing-guide.md](../public/file-storage-billing-guide.md)
- 関連 memory: [feedback_billing_invariant.md](../../memory/), [feedback_drift_detection_design.md](../../memory/), [feedback_3layer_sync_filter.md](../../memory/)
- 公式: [Supabase Pricing](https://supabase.com/pricing), [Supabase Storage Size docs](https://supabase.com/docs/guides/platform/manage-your-usage/storage-size)
