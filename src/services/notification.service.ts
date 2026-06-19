/**
 * 通知サービス (PR feat/notifications-mvp)。
 *
 * 機能:
 *   - CRUD: list / markAsRead / markAllAsRead
 *   - 日次 cron: generateDailyNotifications (ACT の予定終了日リマインダ生成)
 *   - 日次 cron: cleanupReadNotifications (既読 + 30 日経過の物理削除)
 *
 * 設計方針:
 *   - **flat query**: 階層 traversal は使わず、`type='activity'` の Task に対する
 *     date 一致でフィルタするだけ。partial index (idx_tasks_planned_end_due) で
 *     seq scan を避けている (DEVELOPER_GUIDE §5.54)。
 *     ※ idx_tasks_planned_start_due は v1.3.0 で開始通知廃止に伴い不使用になったが、
 *       migration は不変のため DB 上にインデックスが残存する (害なし)。
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
  viewerTenantId: string,
  options: { includeRead?: boolean; limit?: number } = {},
): Promise<{ items: NotificationDTO[]; unreadCount: number }> {
  const { includeRead = false, limit = 20 } = options;
  // 2026-05-09 feedback Phase 2-7: 二重防御として tenantId フィルタ併記。
  //   userId は tenant 内で一意なので実質 no-op だが、テナント間 userId 衝突への保険。
  const where = { userId, tenantId: viewerTenantId, ...(includeRead ? {} : { readAt: null }) };

  // 取得 + 未読件数を 1 transaction に束ねる (race-free counter)
  const [items, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
    }),
    prisma.notification.count({ where: { userId, tenantId: viewerTenantId, readAt: null } }),
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
  viewerUserId: string,
  viewerTenantId: string,
): Promise<NotificationDTO> {
  // 2026-05-09 feedback Phase 2-7: 越境既読化を遮断するため findFirst で先に所有確認。
  //   旧仕様は id 単独 update で他テナント user の通知を勝手に既読化可能だった。
  const owned = await prisma.notification.findFirst({
    where: { id: notificationId, userId: viewerUserId, tenantId: viewerTenantId },
    select: { id: true },
  });
  if (!owned) throw new Error('NOT_FOUND');

  const updated = await prisma.notification.update({
    where: { id: notificationId },
    data: { readAt: read ? new Date() : null },
  });
  return toDTO(updated);
}

/** 自分宛の未読通知をすべて既読化する (一括既読ボタン用)。 */
export async function markAllNotificationsRead(
  userId: string,
  viewerTenantId: string,
): Promise<{ count: number }> {
  // 2026-05-09 feedback Phase 2-7: 二重防御として tenantId フィルタ併記。
  const r = await prisma.notification.updateMany({
    where: { userId, tenantId: viewerTenantId, readAt: null },
    data: { readAt: new Date() },
  });
  return { count: r.count };
}

/**
 * 指定 ID の通知を取得する (認可判定用、findFirst で deletedAt 等の概念無し)。
 * MVP では自分宛か確認するため userId も合わせて検証する形で使う。
 *
 * 2026-05-09 feedback Phase 2-7: 越境取得を遮断するため tenantId フィルタ必須化。
 */
export async function getNotification(
  notificationId: string,
  viewerTenantId: string,
): Promise<{ id: string; userId: string } | null> {
  return prisma.notification.findFirst({
    where: { id: notificationId, tenantId: viewerTenantId },
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
 * PR #425 (2026-05-22): タスク日付通知の文言を「[プロジェクト名] 親WP名 / タスク名 {接尾辞}」形式で生成する純関数。
 *
 * 旧文言「タスク『${name}』の予定終了日です」では「どの WP の ACT か」「どのプロジェクトか」が伝わらず、
 * 通知一覧から該当タスクを特定できないユーザフィードバックを受けて改修。
 *
 * 例:
 *   - 親 WP あり:   「[Project A] WP1 / ACT2 の予定終了日です」
 *   - 親 WP なし:   「[Project A] ACT2 の予定終了日です」 (= WP 直下 ACT が無いツリー構造)
 *   - project 名空: 「ACT2 の予定終了日です」 (= 防御的、空白なら省略)
 *
 * Notification.title の DB 制限 (200 字、prisma schema 参照) を超えそうな場合は末尾を切り詰める。
 */
export function buildTaskNotificationTitle(input: {
  projectName: string;
  parentTaskName: string | null;
  taskName: string;
  suffix: string;
}): string {
  const projectPrefix = input.projectName.trim().length > 0 ? `[${input.projectName}] ` : '';
  const parentPart = input.parentTaskName && input.parentTaskName.trim().length > 0
    ? `${input.parentTaskName} / `
    : '';
  const raw = `${projectPrefix}${parentPart}${input.taskName} ${input.suffix}`;
  // Notification.title VARCHAR(200) を超えそうなら末尾の suffix を保持しつつ中央を切り詰める
  if (raw.length <= 200) return raw;
  const reserveSuffix = ` ${input.suffix}`;
  const head = raw.slice(0, 200 - reserveSuffix.length - 1); // - 1 で省略記号分
  return `${head}…${reserveSuffix}`;
}

/**
 * 日次 cron 本体: 当日朝に発火する通知を ACT に対して生成する。
 *
 * クエリ:
 *   - 終了通知: `type='activity' AND status≠'completed' AND plannedEndDate=today AND assigneeId IS NOT NULL`
 *
 * 重複は dedupeKey の UNIQUE 制約で DB が弾く (createMany skipDuplicates)。
 * 戻り値: 生成件数のサマリ (cron 監視で運用上の異常検知に使う)。
 */
export async function generateDailyNotifications(now: Date = new Date()): Promise<{
  endCreated: number;
}> {
  const today = todayInJst(now);

  // 2026-05-13 (fix/notification-tenant-isolation):
  //   cron 経路で task を全テナント横断取得した上で Notification を createMany する際、
  //   Notification.tenantId を明示せず schema の DB DEFAULT (default-tenant) に落ちていた。
  //   結果として 「テナント A の task に対する通知が default-tenant に書き込まれ、
  //   listNotificationsForUser の where.tenantId フィルタにより本人に届かない」 機能不全。
  //   親 task の project.tenantId を select で同時取得し、createMany.data に明示する。
  // PR #425 (2026-05-22): 通知文言「タスク『ACT名』」だけでは「どの WP / どのプロジェクトの ACT か」
  //   がユーザに伝わらない問題があったため、project.name と parentTask.name も同時取得し
  //   buildTaskNotificationTitle() で「[プロジェクト名] WP名 / ACT名 」形式に整形する。
  type TaskRow = {
    id: string;
    name: string;
    projectId: string;
    assigneeId: string;
    project: { tenantId: string; name: string };
    parentTask: { name: string } | null;
  };

  // ---- 終了通知 ----
  const endTasks = await prisma.task.findMany({
    where: {
      type: 'activity',
      deletedAt: null,
      assigneeId: { not: null },
      status: { not: 'completed' },
      plannedEndDate: today,
    },
    select: {
      id: true,
      name: true,
      projectId: true,
      assigneeId: true,
      project: { select: { tenantId: true, name: true } },
      parentTask: { select: { name: true } },
    },
  });
  const endData = endTasks
    .filter((t): t is TaskRow => t.assigneeId !== null)
    .map((t) => ({
      tenantId: t.project.tenantId,
      userId: t.assigneeId,
      type: 'task_end_due' as const,
      entityType: 'task' as const,
      entityId: t.id,
      title: buildTaskNotificationTitle({
        projectName: t.project.name,
        parentTaskName: t.parentTask?.name ?? null,
        taskName: t.name,
        suffix: 'の予定終了日です',
      }),
      link: `/projects/${t.projectId}/tasks?taskId=${t.id}`,
      dedupeKey: buildDedupeKey('task_end_due', t.id, today),
    }));
  const endResult = endData.length > 0
    ? await prisma.notification.createMany({ data: endData, skipDuplicates: true })
    : { count: 0 };

  return { endCreated: endResult.count };
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
  // 2026-05-12: 意図的に全テナント横断 (cron で system-wide な古い既読通知のクリーンアップ)。
  //   tenantId フィルタなしは仕様。本コメントが tenant-isolation-invariants test の
  //   allowlist マーカーになる (cross-tenant 明示)。
  const r = await prisma.notification.deleteMany({
    where: {
      readAt: { lt: cutoff, not: null },
    },
  });
  return { deleted: r.count };
}
