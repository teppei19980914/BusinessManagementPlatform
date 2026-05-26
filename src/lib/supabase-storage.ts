/**
 * Supabase Storage クライアント (ADR-0021 / 2026-05-26)
 *
 * 役割:
 *   Supabase Storage に対するファイル操作 (Pre-signed URL 発行 / オブジェクト情報取得 /
 *   削除 / ダウンロード) を `@supabase/supabase-js` の service_role クライアント経由で実施。
 *
 * セキュリティ:
 *   - service_role key は必ず server-side のみで使用 (Client Component への value import 禁止)
 *   - 全操作で bucket 名と objectKey は呼出側で固定検証 (= tenant prefix 強制は別レイヤ)
 *   - SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 未設定時はエラー throw (= fail-loud)
 *
 * 関連:
 *   - ADR: docs/adr/0021-file-storage-usage-based-billing.md
 *   - Bucket セットアップ: docs/operations/SUPABASE_STORAGE_SETUP.md (RLS Policy)
 *   - 使用箇所:
 *       - src/app/api/attachments/upload/route.ts (Pre-signed URL 発行)
 *       - src/app/api/attachments/finalize/route.ts (size 確認 + 5MB 超過時の即時削除)
 *       - src/services/attachment.service.ts (cascade delete)
 *       - src/services/attachment-embedding.service.ts (本文ダウンロード)
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env['NEXT_PUBLIC_SUPABASE_URL'] ?? '';
const SERVICE_ROLE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';

/** Storage bucket 名 (env 未設定時は default 'attachments') */
export const SUPABASE_BUCKET_NAME = process.env['SUPABASE_STORAGE_BUCKET'] ?? 'attachments';

let _client: SupabaseClient | null = null;

/**
 * service_role 権限の Supabase クライアントを取得 (lazy init)。
 * env 未設定時はエラー throw。RLS Policy は service_role で bypass されるが
 * RLS Policy 自体が tenant prefix を強制する設計 (= 多層防御)。
 */
function getServiceClient(): SupabaseClient {
  if (_client) return _client;
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    throw new SupabaseStorageError(
      'Supabase Storage env not configured (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)',
      'CONFIG_MISSING',
    );
  }
  _client = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _client;
}

/** Supabase Storage 操作の包括エラー */
export class SupabaseStorageError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'SupabaseStorageError';
    this.code = code;
  }
}

// ============================================================
// Pre-signed Upload URL (ADR-0021 §2.2)
// ============================================================

export interface SignedUploadUrl {
  /** ブラウザが PUT する完全 URL */
  signedUrl: string;
  /** ブラウザが PUT に付加すべきトークン (Supabase v2 API) */
  token: string;
  /** Object Key (= bucket 内パス) */
  path: string;
}

/**
 * Pre-signed Upload URL を発行する (TTL 60 秒、漏洩時の被害最小化)。
 *
 * 使用フロー:
 *   1. server: createSignedUploadUrl({tenantId,...}) → { signedUrl, token }
 *   2. browser: PUT to signedUrl with file body (Supabase Storage が token を検証)
 *   3. browser: POST /api/attachments/finalize で DB row + cache 確定
 *
 * @param objectKey tenant prefix 強制済の Object Key (例: 'tenants/{tid}/project/{eid}/{uuid}-name.pdf')
 */
export async function createSignedUploadUrl(objectKey: string): Promise<SignedUploadUrl> {
  const client = getServiceClient();
  const { data, error } = await client.storage
    .from(SUPABASE_BUCKET_NAME)
    .createSignedUploadUrl(objectKey);
  if (error || !data) {
    throw new SupabaseStorageError(
      `createSignedUploadUrl failed: ${error?.message ?? 'no data'}`,
      'SIGN_FAILED',
    );
  }
  return {
    signedUrl: data.signedUrl,
    token: data.token,
    path: data.path,
  };
}

// ============================================================
// Pre-signed Download URL
// ============================================================

/**
 * Pre-signed Download URL を発行する。
 * 添付ダウンロード UI / chat 検索結果からの open に使用。
 *
 * @param ttlSeconds 既定 60 秒 (短期、漏洩リスク低減)
 */
export async function createSignedDownloadUrl(
  objectKey: string,
  ttlSeconds: number = 60,
): Promise<string> {
  const client = getServiceClient();
  const { data, error } = await client.storage
    .from(SUPABASE_BUCKET_NAME)
    .createSignedUrl(objectKey, ttlSeconds);
  if (error || !data) {
    throw new SupabaseStorageError(
      `createSignedUrl failed: ${error?.message ?? 'no data'}`,
      'SIGN_FAILED',
    );
  }
  return data.signedUrl;
}

// ============================================================
// オブジェクト情報取得 (finalize で実サイズ確認)
// ============================================================

export interface ObjectInfo {
  /** ファイルサイズ (bytes)。Supabase metadata->size から取得。 */
  size: number;
  /** content-type (mime)、判定不能時 null */
  contentType: string | null;
  /** lastModified (ISO) */
  lastModified: string | null;
}

/**
 * Supabase Storage 上のオブジェクト情報を取得する。
 *
 *   - finalize で「Pre-signed URL は発行したが実際アップ完了したか」を確認
 *   - 実サイズが申告サイズ超 (= 50MB 超) なら即時削除 + reject
 *
 * @returns 存在しなければ null
 */
export async function getObjectInfo(objectKey: string): Promise<ObjectInfo | null> {
  const client = getServiceClient();
  // list: 親 prefix で objectKey と一致する 1 件を引く方が API として軽量
  const lastSlash = objectKey.lastIndexOf('/');
  const folder = lastSlash >= 0 ? objectKey.slice(0, lastSlash) : '';
  const fileName = lastSlash >= 0 ? objectKey.slice(lastSlash + 1) : objectKey;
  const { data, error } = await client.storage.from(SUPABASE_BUCKET_NAME).list(folder, {
    search: fileName,
    limit: 1,
  });
  if (error) {
    throw new SupabaseStorageError(
      `list object failed: ${error.message}`,
      'LIST_FAILED',
    );
  }
  const obj = data?.find((o) => o.name === fileName);
  if (!obj) return null;
  const meta = (obj.metadata ?? {}) as { size?: number; mimetype?: string; lastModified?: string };
  return {
    size: typeof meta.size === 'number' ? meta.size : 0,
    contentType: meta.mimetype ?? null,
    lastModified: meta.lastModified ?? obj.updated_at ?? null,
  };
}

// ============================================================
// 削除 (cascade delete + 50MB 超過時の post-check 削除)
// ============================================================

/**
 * Supabase Storage 上のオブジェクトを削除する。
 * 単一削除 (= soft delete 連動の cascade) + 50MB 超過時の post-check 削除で使用。
 */
export async function deleteObject(objectKey: string): Promise<void> {
  const client = getServiceClient();
  const { error } = await client.storage.from(SUPABASE_BUCKET_NAME).remove([objectKey]);
  if (error) {
    throw new SupabaseStorageError(
      `remove object failed: ${error.message}`,
      'DELETE_FAILED',
    );
  }
}

/**
 * 複数オブジェクトを一括削除する (batch cascade delete / 全件削除等)。
 * 失敗した object は throw、成功は no-op。
 */
export async function deleteObjects(objectKeys: string[]): Promise<void> {
  if (objectKeys.length === 0) return;
  const client = getServiceClient();
  const { error } = await client.storage.from(SUPABASE_BUCKET_NAME).remove(objectKeys);
  if (error) {
    throw new SupabaseStorageError(
      `batch remove failed: ${error.message}`,
      'DELETE_FAILED',
    );
  }
}

// ============================================================
// オブジェクトダウンロード (= file-text-extraction 用)
// ============================================================

/**
 * オブジェクト本体を Buffer で取得する。
 * embedding cron が file-text-extraction に渡すため呼出。
 */
export async function downloadObject(objectKey: string): Promise<Buffer> {
  const client = getServiceClient();
  const { data, error } = await client.storage.from(SUPABASE_BUCKET_NAME).download(objectKey);
  if (error || !data) {
    throw new SupabaseStorageError(
      `download object failed: ${error?.message ?? 'no data'}`,
      'DOWNLOAD_FAILED',
    );
  }
  const arrayBuffer = await data.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// ============================================================
// テスト用フック
// ============================================================

/** 単体テストから client を差し替えるためのフック (production では呼ばない) */
export function _setSupabaseClientForTest(client: SupabaseClient | null): void {
  _client = client;
}
