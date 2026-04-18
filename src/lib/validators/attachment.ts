import { z } from 'zod/v4';

/**
 * 添付リンクの親エンティティ種別 (PR #64 Phase 1)。
 * DB 層では VARCHAR(30) だが、入力は enum で厳格に制限する。
 */
export const ATTACHMENT_ENTITY_TYPES = [
  'project',
  'task',
  'estimate',
  'risk',
  'retrospective',
  'knowledge',
] as const;

export type AttachmentEntityType = (typeof ATTACHMENT_ENTITY_TYPES)[number];

/**
 * 許容する URL スキーム。
 * - http(s) のみ許可 (javascript: / data: / file: を弾いて XSS / 情報漏洩を防ぐ)
 * - 先頭は正規表現で検査する (z.url() だけでは scheme 制限できないため)
 */
const SAFE_URL_SCHEME = /^https?:\/\//i;

/**
 * 添付リンク新規作成スキーマ。
 *
 * セキュリティ:
 *   - url は http(s) のみ。javascript: / data: / file: を明示的に拒否する。
 *   - 表示は <a href={url} target="_blank" rel="noopener noreferrer"> で行うこと。
 *
 * slot 運用:
 *   - 'general' は複数許容のデフォルト
 *   - 'primary' / 'source' 等の単数スロットは service 層で upsert 的に置換する
 */
export const createAttachmentSchema = z.object({
  entityType: z.enum(ATTACHMENT_ENTITY_TYPES),
  entityId: z.string().uuid(),
  slot: z.string().min(1).max(30).default('general'),
  displayName: z.string().min(1, '表示名を入力してください').max(200),
  url: z
    .string()
    .min(1, 'URL を入力してください')
    .max(2000)
    .refine((u) => SAFE_URL_SCHEME.test(u), {
      message: 'URL は http:// または https:// で始まる必要があります',
    }),
  mimeHint: z.string().max(50).optional(),
});

export const updateAttachmentSchema = z.object({
  displayName: z.string().min(1).max(200).optional(),
  url: z
    .string()
    .min(1)
    .max(2000)
    .refine((u) => SAFE_URL_SCHEME.test(u), {
      message: 'URL は http:// または https:// で始まる必要があります',
    })
    .optional(),
  mimeHint: z.string().max(50).optional(),
});

export type CreateAttachmentInput = z.infer<typeof createAttachmentSchema>;
export type UpdateAttachmentInput = z.infer<typeof updateAttachmentSchema>;
