import { z } from 'zod/v4';

/**
 * 通知 type の列挙 (PR feat/notifications-mvp)。
 *
 * MVP は ACT の予定日リマインダ 2 種のみ。将来コメント @mention 等が増える想定で
 * `as const` で型安全に拡張。
 */
export const NOTIFICATION_TYPES = [
  'task_start_due', // ACT の予定開始日当日 (status='not_started')
  'task_end_due', // ACT の予定終了日当日 (status≠'completed')
  // 'comment_mention' (将来)
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const NOTIFICATION_ENTITY_TYPES = [
  'task', // MVP は task のみ。将来 issue/risk/retrospective/knowledge 等に展開予定
] as const;

export type NotificationEntityType = (typeof NOTIFICATION_ENTITY_TYPES)[number];

/** GET /api/notifications のクエリパラメータ。 */
export const listNotificationsQuerySchema = z.object({
  /** 既読も含めるか (default: false = 未読のみ)。 */
  includeRead: z.preprocess((v) => v === 'true' || v === true, z.boolean()).optional(),
  /** 取得件数上限 (default: 20、max: 100)。 */
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/** PATCH /api/notifications/[id] のボディ。current MVP では readAt セットのみサポート。 */
export const updateNotificationSchema = z.object({
  read: z.boolean(), // true = 既読化、false = 未読戻し
});

export type UpdateNotificationInput = z.infer<typeof updateNotificationSchema>;
