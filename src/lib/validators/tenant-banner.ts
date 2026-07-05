import { z } from 'zod/v4';
import { BANNER_SEVERITIES } from './system-banner';

/**
 * テナントバナー (ADR-0037) の validator。
 *
 * 緊急度の値集合・型・ラベル・色は system-banner.ts の BANNER_SEVERITIES / BannerSeverity /
 * BANNER_SEVERITY_LABELS / BANNER_SEVERITY_CLASSES を共用する (単一ソース原則)。
 * テナントバナー固有のスキーマ (POST / PATCH ボディ) のみここで定義する。
 */

const messageSchema = z
  .string()
  .trim()
  .min(1, 'メッセージを入力してください')
  .max(500, 'メッセージは 500 文字以内で入力してください');

/** POST /api/tenants/me/banners のボディ。 */
export const createTenantBannerSchema = z
  .object({
    message: messageSchema,
    severity: z.enum(BANNER_SEVERITIES),
    startAt: z.coerce.date(),
    endAt: z.coerce.date(),
    enabled: z.boolean().optional().default(true),
  })
  .refine((v) => v.startAt < v.endAt, {
    message: '表示終了日時は開始日時より後にしてください',
    path: ['endAt'],
  });

export type CreateTenantBannerInput = z.infer<typeof createTenantBannerSchema>;

/**
 * PATCH /api/tenants/me/banners/[id] のボディ。
 * すべて任意 (取り下げ/再開だけなら { enabled } のみ送る)。
 * startAt < endAt の相関チェックは「既存値とマージ後」に service 層で行う。
 */
export const updateTenantBannerSchema = z.object({
  message: messageSchema.optional(),
  severity: z.enum(BANNER_SEVERITIES).optional(),
  startAt: z.coerce.date().optional(),
  endAt: z.coerce.date().optional(),
  enabled: z.boolean().optional(),
});

export type UpdateTenantBannerInput = z.infer<typeof updateTenantBannerSchema>;
