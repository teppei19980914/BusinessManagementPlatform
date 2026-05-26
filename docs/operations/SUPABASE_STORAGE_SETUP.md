# Supabase Storage セットアップ手順 (ADR-0021)

> **対象**: 運営者 (super_admin) / インフラ担当者
> **目的**: ファイル添付ストレージ従量課金 (ADR-0021) で使用する Supabase Storage Bucket の作成・RLS Policy 設定手順を一元管理する。
> **作成日**: 2026-05-26 (ADR-0021 受入時)

---

## 1. 全体像

ADR-0021 で導入する添付ファイル本体保存は以下の構造で動作する:

```
Browser
  │
  │  ① POST /api/attachments/upload (server)
  │     → 危険拡張子チェック / tenant cap 検証 / Pre-signed URL 発行 (TTL 60s)
  │  ↓
  │  ② PUT Pre-signed URL (browser → Supabase Storage 直接、server bypass)
  │     → server を経由しないため大容量ファイルでもアプリ層が落ちない
  │  ↓
  │  ③ POST /api/attachments/finalize (server)
  │     → Attachment row 作成 (storageProvider='supabase')
  │     → file-text-extraction → embedding 生成 を背景 enqueue
```

Bucket は **single bucket + tenant prefix** 方式 (per-tenant bucket は採用せず、Bucket 作成のコスト/管理負担を回避)。
テナント越境防止は **アプリ層の object key prefix 強制** と **RLS Policy** の二重防御で実現する。

---

## 2. Bucket 作成手順

### 2.1 Supabase Dashboard 操作

1. Supabase Dashboard → Storage → New bucket
2. 入力:
   - Name: `attachments` (= `SUPABASE_STORAGE_BUCKET` env と一致)
   - Public bucket: **OFF** (= privates 専用、Pre-signed URL でのみアクセス)
   - File size limit: 不要 (アプリ層で `FILE_STORAGE_MAX_FILE_SIZE_BYTES = 50MB` を enforce)
   - Allowed MIME types: 空欄 (= 全 MIME 許可、アプリ層で `DANGEROUS_FILE_EXTENSIONS` を blacklist 判定)
3. Create

### 2.2 環境別 Bucket

| 環境 | Project | Bucket Name |
|---|---|---|
| Local | local Supabase | `attachments` |
| Staging | (廃止予定) | `attachments` |
| Production | tasukiba-prod | `attachments` |

---

## 3. RLS Policy 設定 (重要 — テナント越境防止の最終ガード)

`storage.objects` テーブルに以下の Policy を適用する。アプリ層の key prefix 強制と合わせて 2 重防御を構成。

```sql
-- ============================================================
-- Storage Bucket 'attachments' の RLS Policy (ADR-0021)
--
-- 設計方針:
--   - service_role (= server) は全アクセス可 (cron / 集計 / Pre-signed URL 発行で必須)
--   - anon / authenticated (= browser) は直接アクセス不可 (Pre-signed URL 経由のみ)
--   - object key prefix が tenants/{tenantId}/... 形式であることを enforcement
-- ============================================================

-- 1. service_role は全アクセス可 (cron / 集計 / Pre-signed URL 発行)
CREATE POLICY "service_role_full_access_attachments"
  ON storage.objects
  FOR ALL
  TO service_role
  USING (bucket_id = 'attachments')
  WITH CHECK (bucket_id = 'attachments');

-- 2. anon / authenticated からの直接 SELECT を禁止 (= Pre-signed URL を強制)
CREATE POLICY "deny_direct_select_attachments"
  ON storage.objects
  FOR SELECT
  TO anon, authenticated
  USING (FALSE);

-- 3. anon / authenticated からの直接 INSERT を禁止 (= Pre-signed URL upload のみ許可)
CREATE POLICY "deny_direct_insert_attachments"
  ON storage.objects
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (FALSE);

-- 4. anon / authenticated からの直接 UPDATE/DELETE も禁止 (= service_role 経由のみ)
CREATE POLICY "deny_direct_update_attachments"
  ON storage.objects
  FOR UPDATE
  TO anon, authenticated
  USING (FALSE);

CREATE POLICY "deny_direct_delete_attachments"
  ON storage.objects
  FOR DELETE
  TO anon, authenticated
  USING (FALSE);

-- 5. key prefix の物理強制 (= 'tenants/' で始まらない object は INSERT を block)
--    アプリ層の buildStorageObjectKey() で常に 'tenants/{tenantId}/...' を付けるが、
--    万一のバグで prefix が抜けても DB で拒否する 2 重防御
CREATE POLICY "enforce_tenant_prefix_attachments"
  ON storage.objects
  FOR INSERT
  TO service_role
  WITH CHECK (
    bucket_id = 'attachments'
    AND name LIKE 'tenants/%'
  );
```

### 3.1 適用方法

Supabase Dashboard → Database → Policies → `storage.objects` テーブルを選択 → New Policy で 1 つずつ追加。
または SQL Editor から上記 SQL を一括実行。

### 3.2 検証

```sql
-- 適用後の Policy 一覧確認
SELECT policyname, cmd, roles
  FROM pg_policies
 WHERE schemaname = 'storage' AND tablename = 'objects'
   AND policyname LIKE '%attachments%';
```

期待: 5 件 (service_role full / anon deny × 4)

---

## 4. CORS 設定

Browser から直接 Supabase Storage に PUT/GET するため CORS が必要。

Supabase Dashboard → Storage → Settings → CORS configuration:

```json
[
  {
    "allowedOrigins": ["https://tasukiba.app", "http://localhost:3000"],
    "allowedMethods": ["GET", "PUT", "POST", "DELETE", "HEAD"],
    "allowedHeaders": ["*"],
    "exposedHeaders": ["x-upload-content-length"],
    "maxAgeSeconds": 3600
  }
]
```

> **重要**: 本番 origin は必ず `https://` 固定。`*` は禁止 (= Pre-signed URL が漏洩した場合の被害拡大)。

---

## 5. 容量監視

ADR-0021 §6 の drift 検知に必要な情報源。

### 5.1 Supabase Dashboard
- Storage → Usage で bucket 別の総容量を確認可能。
- 月初 / 月末で値を記録し、ApiCallLog の peak SUM と乖離が無いか目視確認。

### 5.2 アプリ層自動集計 (実装側)
- `src/services/file-storage-bucket-usage.service.ts` が `storage.objects` を集計し、
  `Tenant.storageBucketBytesPeakThisMonth` (drift 検知用) を日次更新。
- 乖離 50% 超で super_admin に warning、100% 超で critical alert (= `feedback_drift_detection_design.md`)。

---

## 6. 環境変数チェックリスト

本セットアップ完了時、以下の env が全環境で設定されていること:

- [ ] `SUPABASE_STORAGE_BUCKET=attachments`
- [ ] `SUPABASE_SERVICE_ROLE_KEY=...` (= Project Settings → API → service_role)
- [ ] `NEXT_PUBLIC_SUPABASE_URL=...` (既存)
- [ ] `NEXT_PUBLIC_SUPABASE_ANON_KEY=...` (既存)

---

## 7. 障害時 SOP (簡易)

| 現象 | 原因候補 | 対処 |
|---|---|---|
| アップロード 403 | Pre-signed URL TTL (60s) 超過 | UI で再発行をユーザに促す。頻発時は `PRESIGNED_URL_TTL_SECONDS` を見直し |
| アップロード 413 | アプリ層 50MB 上限超過 | 仕様通り、ユーザに分割を促す |
| アップロード 429 | per-tenant rate limit (10/min) | 仕様通り、待機を促す |
| RLS 違反で INSERT 失敗 | key prefix が tenants/ で始まっていない | `buildStorageObjectKey()` 呼出漏れ、`src/config/file-storage-pricing.ts` ヘルパを必ず経由する |
| drift critical alert | bucket 実容量 vs peak SUM 乖離 | super_admin 画面 → file-storage-drift カードで詳細確認、必要なら手動再集計 |

---

## 関連ドキュメント

- ADR: [docs/adr/0021-file-storage-usage-based-billing.md](../adr/0021-file-storage-usage-based-billing.md)
- 仕様: [docs/business/FILE_STORAGE_BILLING.md](../business/FILE_STORAGE_BILLING.md)
- ユーザ向け: [docs/public/file-storage-billing-guide.md](../public/file-storage-billing-guide.md)
- 環境変数全般: [docs/operations/ENV_VARS.md](./ENV_VARS.md)
- Stripe 設定: [docs/operations/STRIPE_SETUP.md](./STRIPE_SETUP.md)
