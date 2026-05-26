/**
 * ファイル添付ストレージ従量課金 — 単価・閾値・セキュリティ定数 (ADR-0021 / 2026-05-26)
 *
 * 役割:
 *   Supabase Storage に保存されたファイル本体の容量を月中 peak ベースで従量課金するための
 *   単価定数・閾値定義・セキュリティ規則・計算ヘルパを単一の真実源として提供する。
 *
 * 課金モデル (ADR-0021):
 *   - 無料枠: 100MB / tenant
 *   - 超過分: 1GB 単位で ¥10 (階段関数型、1MB 未満は繰上)
 *   - 単位は SI (1GB = 10^9 bytes, 1MB = 10^6 bytes) — DB 容量と整合
 *   - 計測時点: 月中 peak (= ADR-0020 と同設計)
 *   - ファイル上限: 50MB / 1 ファイル
 *
 * 4 層防御 (= ADR-0020 と同パターン):
 *   - L1 1GB: ユーザ通知
 *   - L2 10GB: super_admin 通知
 *   - L3 50GB: アップロード拒否 (ハードキャップ)
 *
 * セキュリティ (= ADR-0021 §10):
 *   - 危険拡張子 blacklist (.exe / .sh 等)
 *   - ファイル名 sanitize (path traversal 防止)
 *   - Pre-signed URL 有効期限 60 秒
 *   - per-tenant Pre-signed URL 発行レート制限 10/min
 *   - per-tenant delete API レート制限 100/min
 *
 * 関連:
 *   - ADR: docs/adr/0021-file-storage-usage-based-billing.md
 *   - 計測: src/services/file-storage-bucket-usage.service.ts
 *   - 月初集計: src/services/tenant-monthly-reset.service.ts
 *   - Stripe: src/services/stripe-usage-flush.service.ts (callType='storage_file_overage')
 *   - 同設計の DB 容量: src/config/db-capacity-pricing.ts
 */

// ============================================================
// 単位定数 (DB 容量と整合)
// ============================================================

/** 1MB = 10^6 bytes (SI) */
export const SI_MB_BYTES = 1_000_000;

/** 1GB = 10^9 bytes (SI) */
export const SI_GB_BYTES = 1_000_000_000;

// ============================================================
// 課金パラメータ (ADR-0021 §1.1)
// ============================================================

/** 無料枠 = 100MB SI = 100,000,000 bytes */
export const FILE_STORAGE_FREE_TIER_BYTES = 100 * SI_MB_BYTES;

/** 課金単価: 1 GB tier あたり ¥10 (税抜) */
export const FILE_STORAGE_PRICE_JPY_PER_GB_TIER = 10;

/** 1 ファイルあたりのアップロードサイズ上限 = 50MB SI = 50,000,000 bytes */
export const FILE_STORAGE_MAX_FILE_SIZE_BYTES = 50 * SI_MB_BYTES;

// ============================================================
// 4 層防御閾値 (ADR-0021 §5、DB 容量と同閾値)
// ============================================================

/** L1: ユーザ通知 (1GB) */
export const FILE_STORAGE_L1_USER_WARNING_BYTES = 1 * SI_GB_BYTES;

/** L2: super_admin 通知 (10GB) */
export const FILE_STORAGE_L2_ADMIN_ALERT_BYTES = 10 * SI_GB_BYTES;

/** L3: ハードキャップ (50GB、アップロード拒否) */
export const FILE_STORAGE_L3_HARD_CAP_BYTES = 50 * SI_GB_BYTES;

// ============================================================
// 異常使用検知 (ADR-0021 §10.2.4)
// ============================================================

/** 1 日で 5GB 以上増加で super_admin に anomaly alert */
export const FILE_STORAGE_ANOMALY_DAILY_INCREASE_BYTES = 5 * SI_GB_BYTES;

// ============================================================
// drift 検知 (= ADR-0020 と同閾値)
// ============================================================

export const FILE_STORAGE_DRIFT_WARNING_RATIO = 0.5;
export const FILE_STORAGE_DRIFT_CRITICAL_RATIO = 1.0;

// ============================================================
// セキュリティ (ADR-0021 §10.3, §10.4)
// ============================================================

/**
 * 危険拡張子 blacklist (アップロード時に拒否)。
 * 実行可能ファイル + スクリプト + モバイルアプリ + 高圧縮形式。
 * 注: .zip は許容 (= 業務利用想定)、解凍はクライアント側で実施。
 */
export const DANGEROUS_FILE_EXTENSIONS: readonly string[] = [
  // Windows 実行
  '.exe', '.com', '.bat', '.cmd', '.scr', '.msi', '.dll',
  // Script
  '.ps1', '.vbs', '.js', '.jse', '.wsf', '.wsh',
  // Unix
  '.sh', '.bash', '.zsh', '.csh',
  // Mobile
  '.apk', '.ipa',
  // Archive (高圧縮形式は zip bomb リスク高)
  '.zipx', '.rar',
] as const;

/**
 * Embedding 対象ファイル拡張子 (ADR-0021 §3.1)。
 * これら以外は embeddingStatus='unsupported' で記録。
 */
export const EMBEDDING_SUPPORTED_EXTENSIONS: readonly string[] = [
  '.pdf',
  '.xlsx', '.xls',
  '.csv',
  '.txt', '.md', '.json',
  '.docx',
] as const;

// ============================================================
// Pre-signed URL / Rate Limit (ADR-0021 §10.2.1)
// ============================================================

/** Pre-signed URL の有効期限 (秒)。漏洩時の被害最小化のため短く設定。 */
export const PRESIGNED_URL_TTL_SECONDS = 60;

/** per-tenant Pre-signed URL 発行レート制限 (回/分) */
export const PRESIGNED_URL_RATE_LIMIT_PER_MIN = 10;

/** per-tenant delete API レート制限 (回/分) */
export const DELETE_API_RATE_LIMIT_PER_MIN = 100;

/** ファイル名長さ上限 (文字数) */
export const MAX_FILE_NAME_LENGTH = 200;

// ============================================================
// Embedding job throttling (ADR-0021 §10.2.3)
// ============================================================

/** per-tenant 同時 embedding job 上限 */
export const MAX_CONCURRENT_EMBEDDING_PER_TENANT = 5;

/** グローバル同時 embedding job 上限 (Voyage rate limit 抵触防止) */
export const MAX_GLOBAL_EMBEDDING_CONCURRENT = 50;

/** Embedding 生成リトライ回数 (3 回失敗で embeddingStatus='failed') */
export const EMBEDDING_MAX_RETRY = 3;

// ============================================================
// チャット検索 file scope 検出キーワード (ADR-0021 §9.5.3)
// ============================================================

export const FILE_SCOPE_KEYWORDS: readonly string[] = [
  'ファイル', 'file', 'files',
  '添付', '添付ファイル', 'attachment', 'attachments',
  'PDF', 'pdf',
  'Excel', 'excel', 'xlsx',
  'Word', 'word', 'docx',
  '資料', '文書', 'document', 'documents', 'docs',
] as const;

// ============================================================
// 計算ヘルパ
// ============================================================

/**
 * 課金対象バイト数を計算する (= 無料枠 100MB を差し引いた超過分)。
 */
export function calculateFileStorageBillableBytes(peakBytes: bigint): bigint {
  const free = BigInt(FILE_STORAGE_FREE_TIER_BYTES);
  return peakBytes > free ? peakBytes - free : BigInt(0);
}

/**
 * 月次請求額を計算する (階段関数型: 1GB tier × ¥10)。
 *
 * 仕様 (ADR-0021 §1.2):
 *   - 0 ~ 100MB: ¥0
 *   - 101MB ~ 1,100MB: ¥10 (1 tier)
 *   - 1,101MB ~ 2,100MB: ¥20 (2 tier)
 *   - 50GB (ハードキャップ): ¥500 (50 tier)
 *
 * @param peakBytes 月中 peak バイト数
 * @returns 円単位の請求額 (整数)
 */
export function calculateFileStorageOverageJpy(peakBytes: bigint): number {
  const billableBytes = calculateFileStorageBillableBytes(peakBytes);
  if (billableBytes === BigInt(0)) return 0;
  const billableMb = Number((billableBytes + BigInt(SI_MB_BYTES - 1)) / BigInt(SI_MB_BYTES));
  const gbTiers = Math.ceil(billableMb / 1000);
  return gbTiers * FILE_STORAGE_PRICE_JPY_PER_GB_TIER;
}

/**
 * Stripe Meter quantity (= R6 案 A: quantity=costJpy 整数)。
 */
export function calculateFileStorageStripeQuantity(costJpy: number): number {
  return Math.max(0, Math.floor(costJpy));
}

/**
 * 4 層防御の Level 判定。
 */
export type FileStorageWarningLevel = 'none' | 'l1' | 'l2' | 'l3';

export function classifyFileStorageLevel(peakBytes: bigint): FileStorageWarningLevel {
  if (peakBytes >= BigInt(FILE_STORAGE_L3_HARD_CAP_BYTES)) return 'l3';
  if (peakBytes >= BigInt(FILE_STORAGE_L2_ADMIN_ALERT_BYTES)) return 'l2';
  if (peakBytes >= BigInt(FILE_STORAGE_L1_USER_WARNING_BYTES)) return 'l1';
  return 'none';
}

/**
 * ファイル名 sanitize (ADR-0021 §10.4)。
 * OS 禁止文字・path traversal・隠しファイル偽装を除去 + 長さ制限。
 */
export function sanitizeFileName(name: string): string {
  return name
    .replace(/[\/\\:*?"<>|\x00-\x1f]/g, '_')  // OS 禁止文字
    .replace(/\.\./g, '_')                     // path traversal
    .replace(/^\.+/, '_')                       // 隠しファイル偽装
    .slice(0, MAX_FILE_NAME_LENGTH);            // 長さ制限
}

/**
 * 拡張子取得 (小文字、ドット付き)。例: 'document.PDF' → '.pdf'
 */
export function getFileExtension(fileName: string): string {
  const lastDot = fileName.lastIndexOf('.');
  if (lastDot < 0 || lastDot === fileName.length - 1) return '';
  return fileName.slice(lastDot).toLowerCase();
}

/**
 * 危険拡張子チェック (ADR-0021 §10.3)。
 * アップロード前 + finalize 後の 2 段階で呼出 (defense-in-depth)。
 */
export function isDangerousExtension(fileName: string): boolean {
  const ext = getFileExtension(fileName);
  return DANGEROUS_FILE_EXTENSIONS.includes(ext);
}

/**
 * Embedding 対象判定。PDF/Excel/CSV/text/docx は対象、それ以外は 'unsupported'。
 */
export function isEmbeddingSupported(fileName: string): boolean {
  const ext = getFileExtension(fileName);
  return EMBEDDING_SUPPORTED_EXTENSIONS.includes(ext);
}

/**
 * チャットクエリに「ファイル/添付」キーワードが含まれるか判定 (ADR-0021 §9.5.3)。
 * 含まれる場合は attachment embedding のみをスコープに絞る。
 */
export function detectFileScopeQuery(query: string): boolean {
  const lower = query.toLowerCase();
  return FILE_SCOPE_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()));
}

/**
 * Storage Object Key を生成 (ADR-0021 §10.5)。
 * 全テナント越境を物理的に不可能化する固定 schema:
 *   tenants/{tenantId}/{entityType}/{entityId}/{uuid}-{sanitized-fileName}
 */
export function buildStorageObjectKey(args: {
  tenantId: string;
  entityType: string;
  entityId: string;
  uuid: string;
  fileName: string;
}): string {
  const safeName = sanitizeFileName(args.fileName);
  return `tenants/${args.tenantId}/${args.entityType}/${args.entityId}/${args.uuid}-${safeName}`;
}
