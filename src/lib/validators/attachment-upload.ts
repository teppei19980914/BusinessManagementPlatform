/**
 * 添付ファイルアップロード用 validators (ADR-0021 / 2026-05-26)
 *
 * 2 段階フロー:
 *   1. POST /api/attachments/upload (Pre-signed URL 発行) — uploadRequestSchema
 *   2. POST /api/attachments/finalize (DB row + cache 更新) — finalizeRequestSchema
 */

import { z } from 'zod/v4';
import {
  DISPLAY_NAME_MAX_LENGTH,
  ATTACHMENT_SLOT_MAX_LENGTH,
  ATTACHMENT_MIME_HINT_MAX_LENGTH,
} from '@/config';
import {
  FILE_STORAGE_MAX_FILE_SIZE_BYTES,
  MAX_FILE_NAME_LENGTH,
} from '@/config/file-storage-pricing';

/**
 * ADR-0021 §10.3 のアップロード対応 entity 種別。
 * 2026-06-03: memo も他資産と同様にファイル本体アップロード対応 (旧 PR #70 の「URL 添付のみ」制限を解除)。
 *   書込認可は authorizeMemoAttachment (memo.userId === viewer) で本人のみ。
 */
export const UPLOAD_ATTACHMENT_ENTITY_TYPES = [
  'project',
  'task',
  'estimate',
  'risk',
  'retrospective',
  'knowledge',
  'memo',
] as const;

export type UploadAttachmentEntityType = (typeof UPLOAD_ATTACHMENT_ENTITY_TYPES)[number];

/**
 * Pre-signed Upload URL 発行リクエスト schema。
 * server 側で entity 認可 + storage-guard pre-check + 危険拡張子 + sanitize + rate limit を実施。
 */
export const uploadRequestSchema = z.object({
  entityType: z.enum(UPLOAD_ATTACHMENT_ENTITY_TYPES),
  entityId: z.string().uuid(),
  slot: z.string().min(1).max(ATTACHMENT_SLOT_MAX_LENGTH).default('general'),
  fileName: z.string().min(1).max(MAX_FILE_NAME_LENGTH),
  sizeBytes: z
    .number()
    .int()
    .positive()
    .max(FILE_STORAGE_MAX_FILE_SIZE_BYTES, `ファイル サイズが上限 50MB を超えています`),
  mimeType: z.string().max(ATTACHMENT_MIME_HINT_MAX_LENGTH).optional(),
});

export type UploadRequestInput = z.infer<typeof uploadRequestSchema>;

/**
 * Finalize リクエスト schema。
 * upload で発行された objectKey を受取り Attachment DB row を確定する。
 */
export const finalizeRequestSchema = z.object({
  entityType: z.enum(UPLOAD_ATTACHMENT_ENTITY_TYPES),
  entityId: z.string().uuid(),
  slot: z.string().min(1).max(ATTACHMENT_SLOT_MAX_LENGTH).default('general'),
  objectKey: z.string().min(1).max(500),
  fileName: z.string().min(1).max(MAX_FILE_NAME_LENGTH),
  displayName: z.string().min(1).max(DISPLAY_NAME_MAX_LENGTH),
  sizeBytes: z
    .number()
    .int()
    .positive()
    .max(FILE_STORAGE_MAX_FILE_SIZE_BYTES),
  mimeType: z.string().max(ATTACHMENT_MIME_HINT_MAX_LENGTH).optional(),
});

export type FinalizeRequestInput = z.infer<typeof finalizeRequestSchema>;
