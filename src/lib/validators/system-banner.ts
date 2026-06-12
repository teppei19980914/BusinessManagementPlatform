import { z } from 'zod/v4';

/**
 * システム周知バナー (画面上部の帯メッセージ) の validator (ADR-0036)。
 *
 * ★単一ソース★ 緊急度の全値をこの 1 箇所 (BANNER_SEVERITIES) から導出する。
 *   型 (BannerSeverity)・zod 許可リスト・UI ラベル・色マップのすべてをここに集約し、
 *   段を増やすときはここだけ更新すれば一貫する ([[feedback_union_value_runtime_validator_drift]]:
 *   union に値を足したのにランタイム検証側の更新を漏らして CI fail した反省の再発防止)。
 */
export const BANNER_SEVERITIES = ['high', 'medium', 'low'] as const;

export type BannerSeverity = (typeof BANNER_SEVERITIES)[number];

/** 緊急度の日本語ラベル (管理画面・ガイドで使用)。高 / 中 / 低。 */
export const BANNER_SEVERITY_LABELS: Record<BannerSeverity, string> = {
  high: '高',
  medium: '中',
  low: '低',
};

/**
 * 緊急度 → 帯の Tailwind クラス (ADR-0036: 高=赤 / 中=黄 / 低=青)。
 * 中 (黄) のみ可読性のため濃色文字。DegradedModeBanner (amber 帯) と同系の border-b スタイル。
 */
export const BANNER_SEVERITY_CLASSES: Record<BannerSeverity, string> = {
  high: 'border-red-700 bg-red-600 text-white',
  medium: 'border-yellow-400 bg-yellow-300 text-yellow-950',
  low: 'border-blue-700 bg-blue-600 text-white',
};

const messageSchema = z
  .string()
  .trim()
  .min(1, 'メッセージを入力してください')
  .max(500, 'メッセージは 500 文字以内で入力してください');

/** POST /api/admin/super/banners のボディ。 */
export const createSystemBannerSchema = z
  .object({
    message: messageSchema,
    severity: z.enum(BANNER_SEVERITIES),
    /** ISO 8601 文字列または Date。datetime-local をクライアントで toISOString して送る想定。 */
    startAt: z.coerce.date(),
    endAt: z.coerce.date(),
    /** 既定は表示有効。即時取り下げで作成したい場合のみ false。 */
    enabled: z.boolean().optional().default(true),
  })
  .refine((v) => v.startAt < v.endAt, {
    message: '表示終了日時は開始日時より後にしてください',
    path: ['endAt'],
  });

export type CreateSystemBannerInput = z.infer<typeof createSystemBannerSchema>;

/**
 * PATCH /api/admin/super/banners/[id] のボディ。
 * すべて任意 (取り下げ/再開だけなら { enabled } のみ送る)。
 * startAt < endAt の相関チェックは「既存値とマージ後」に service 層で行う
 * (片方だけ更新するケースがあるため zod の refine では完結できない)。
 */
export const updateSystemBannerSchema = z.object({
  message: messageSchema.optional(),
  severity: z.enum(BANNER_SEVERITIES).optional(),
  startAt: z.coerce.date().optional(),
  endAt: z.coerce.date().optional(),
  enabled: z.boolean().optional(),
});

export type UpdateSystemBannerInput = z.infer<typeof updateSystemBannerSchema>;
