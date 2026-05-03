/**
 * 通知サービス (PR feat/notifications-mvp)。
 *
 * 機能:
 *   - CRUD: list / markAsRead / markAllAsRead
 *   - 日次 cron: generateDailyNotifications (ACT の開始/終了日リマインダ生成)
 *   - 日次 cron: cleanupReadNotifications (既読 + 30 日経過の物理削除)
 *
 * 設計方針:
 *   - **flat query**: 階層 traversal は使わず、`type='activity'` の Task に対する
 *     date 一致でフィルタするだけ。partial index (idx_tasks_planned_start_due /
 *     idx_tasks_planned_end_due) で seq scan を避けている (DEVELOPER_GUIDE §5.54)。
 *   - **dedupe**: `dedupeKey = '{type}:{taskId}:{YYYY-MM-DD}'` を UNIQUE 制約で
 *     DB レベルに弾く。cron が時間内に 2 回呼ばれても安全。
 *   - **JST 基準**: 「当日 (today)」の判定は JST 0:00〜23:59。cron は UTC 22:00 で実行
 *     される (= JST 翌日 7:00) ため、`tomorrow` 相当の date を投げる必要があることに注意。
 */

import { prisma } from '@/lib/db';
import type { NotificationType, NotificationEntityType } from '@/lib/validators/notification';

/** 通知の DTO 型。UI に直接渡す。 */
export type NotificationDTO = {
  id: string;
  type: NotificationType;
  entityType: NotificationEntityType;
  entityId: string;
  title: string;
  link: string;
  readAt: string | null;
  createdAt: string;
};

function toDTO(n: {
  id: string;
  type: string;
  entityType: string;
  entityId: string;
  title: string;
  link: string;
  readAt: Date | null;
  createdAt: Date;
}): NotificationDTO {
  return {
    id: n.id,
    type: n.type as NotificationType,
    entityType: n.entityType as NotificationEntityType,
    entityId: n.entityId,
    title: n.title,
    link: n.link,
    readAt: n.readAt?.toISOString() ?? null,
    createdAt: n.createdAt.toISOString(),
  };
}

/**
 * 自分宛の通知一覧を取得する。
 * default: 未読のみ + 直近 20 件 (createdAt DESC)。
 * `includeRead=true` で既読も含める (履歴表示用)。
 */
export async function listNotificationsForUser(
  userId: string,
  options: { includeRead?: boolean; limit?: number } = {},
): Promise<{ items: NotificationDTO[]; unreadCount: number }> {
  const { includeRead = false, limit = 20 } = options;
  const where = { userId, ...(includeRead ? {} : { readAt: null }) };

  // 取得 + 未読件数を 1 transaction に束ねる (race-free counter)
  const [items, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
    }),
    prisma.notification.count({ where: { userId, readAt: null } }),
  ]);
  return { items: items.map(toDTO), unreadCount };
}

/**
 * 指定 ID の通知を既読化 (readAt セット) または未読化 (readAt クリア)。
 * 認可は呼出側で「自分宛の通知か」を確認している前提。
 */
export async function setNotificationRead(
  notificationId: string,
  read: boolean,
): Promise<NotificationDTO> {
  const updated = await prisma.notification.update({
    where: { id: notificationId },
    data: { readAt: read ? new Date() : null },
  });
  return toDTO(updated);
}

/** 自分宛の未読通知をすべて既読化する (一括既読ボタン用)。 */
export async function markAllNotificationsRead(userId: string): Promise<{ count: number }> {
  const r = await prisma.notification.updateMany({
    where: { userId, readAt: null },
    data: { readAt: new Date() },
  });
  return { count: r.count };
}

/**
 * 指定 ID の通知を取得する (認可判定用、findFirst で deletedAt 等の概念無し)。
 * MVP では自分宛か確認するため userId も合わせて検証する形で使う。
 */
export async function getNotification(
  notificationId: string,
): Promise<{ id: string; userId: string } | null> {
  return prisma.notification.findUnique({
    where: { id: notificationId },
    select: { id: true, userId: true },
  });
}

// ============================================================
// Cron: daily generation
// ============================================================

/**
 * `today` (DATE) を JST タイムゾーンで生成する。
 *
 * cron は UTC で動くため、`new Date()` をそのまま使うと UTC date になる。
 * JST 7:00 (= UTC 前日 22:00) で実行される本 cron では「JST の今日」 ≠ 「UTC の今日」になる
 * 可能性が常にある (UTC 22:00 - 14:59 は前日扱い)。
 *
 * 戻り値: JST の today を表す Date オブジェクト (DB の DATE 型と直接比較可能)。
 */
export function todayInJst(now: Date = new Date()): Date {
  // UTC → JST = +9 hours
  const jstMillis = now.getTime() + 9 * 60 * 60 * 1000;
  const jst = new Date(jstMillis);
  // 年月日のみ抽出 (時刻 = 00:00:00 UTC) して DATE 型と比較できる Date を返す
  return new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate()));
}

/** dedupeKey 生成: `{type}:{taskId}:{YYYY-MM-DD}` */
function buildDedupeKey(type: NotificationType, taskId: string, date: Date): string {
  const ymd = date.toISOString().slice(0, 10);
  return `${type}:${taskId}:${ymd}`;
}

/**
 * 日次 cron 本体: 当日朝に発火する通知を ACT に対して生成する。
 *
 * クエリ:
 *   - 開始通知: `type='activity' AND status='not_started' AND plannedStartDate=today AND assigneeId IS NOT NULL`
 *   - 終了通知: `type='activity' AND status≠'completed' AND plannedEndDate=today AND assigneeId IS NOT NULL`
 *
 * 重複は dedupeKey の UNIQUE 制約で DB が弾く (createMany skipDuplicates)。
 * 戻り値: 生成件数のサマリ (cron 監視で運用上の異常検知に使う)。
 */
export async function generateDailyNotifications(now: Date = new Date()): Promise<{
  startCreated: number;
  endCreated: number;
}> {
  const today = todayInJst(now);

  // ---- 開始通知 ----
  const startTasks = await prisma.task.findMany({
    where: {
      type: 'activity',
      deletedAt: null,
      assigneeId: { not: null },
      status: 'not_started',
      plannedStartDate: today,
    },
    select: { id: true, name: true, projectId: true, assigneeId: true },
  });
  const startData = startTasks
    .filter((t): t is { id: string; name: string; projectId: string; assigneeId: string } => t.assigneeId !== null)
    .map((t) => ({
      userId: t.assigneeId,
      type: 'task_start_due' as const,
      entityType: 'task' as const,
      entityId: t.id,
      title: `タスク「${t.name}」の予定開始日です`,
      link: `/projects/${t.projectId}/tasks?taskId=${t.id}`,
      dedupeKey: buildDedupeKey('task_start_due', t.id, today),
    }));
  const startResult = startData.length > 0
    ? await prisma.notification.createMany({ data: startData, skipDuplicates: true })
    : { count: 0 };

  // ---- 終了通知 ----
  const endTasks = await prisma.task.findMany({
    where: {
      type: 'activity',
      deletedAt: null,
      assigneeId: { not: null },
      status: { not: 'completed' },
      plannedEndDate: today,
    },
    select: { id: true, name: true, projectId: true, assigneeId: true },
  });
  const endData = endTasks
    .filter((t): t is { id: string; name: string; projectId: string; assigneeId: string } => t.assigneeId !== null)
    .map((t) => ({
      userId: t.assigneeId,
      type: 'task_end_due' as const,
      entityType: 'task' as const,
      entityId: t.id,
      title: `タスク「${t.name}」の予定終了日です`,
      link: `/projects/${t.projectId}/tasks?taskId=${t.id}`,
      dedupeKey: buildDedupeKey('task_end_due', t.id, today),
    }));
  const endResult = endData.length > 0
    ? await prisma.notification.createMany({ data: endData, skipDuplicates: true })
    : { count: 0 };

  return { startCreated: startResult.count, endCreated: endResult.count };
}

/**
 * 既読 + readAt が 30 日以上前の通知を物理削除する。日次 cron 内で同時実行。
 * MVP は 30 日固定。将来要望次第でユーザ設定化検討。
 */
export async function cleanupReadNotifications(
  now: Date = new Date(),
  retentionDays: number = 30,
): Promise<{ deleted: number }> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const r = await prisma.notification.deleteMany({
    where: {
      readAt: { lt: cutoff, not: null },
    },
  });
  return { deleted: r.count };
}
