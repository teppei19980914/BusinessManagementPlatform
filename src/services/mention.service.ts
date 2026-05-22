/**
 * メンションサービス (PR feat/comment-mentions)。
 *
 * 責務:
 *   1. mention kind の妥当性検証 (entityType ごとの許可 kind と突合)
 *   2. kind → userId[] への展開 (グループメンション処理)
 *   3. Mention レコードの作成 / 削除 / 差分計算 (編集時)
 *   4. メンション → Notification 一括生成 (即時通知、cron 経由しない)
 *
 * 設計方針:
 *   - **配信は即時** (コメント投稿時に同 transaction または直後に呼ぶ)
 *   - **dedupe**: dedupeKey = `comment_mention:${commentId}:${userId}` で 2 重通知を弾く
 *   - **自分宛は除外** (Q5): 投稿者本人がメンションされても通知は飛ばさない
 *   - **編集時は追加分のみ通知** (Q2): 旧 mention との diff を取り added のみ Notification 生成
 */

import { prisma } from '@/lib/db';
import type { CommentEntityType } from '@/lib/validators/comment';
import type { MentionInput } from '@/lib/validators/mention';
import { getAllowedMentionKinds } from '@/lib/validators/mention';

/** バリデーション結果。OK ならメッセージなし、NG なら理由を持つ。 */
export type ValidationResult = { ok: true } | { ok: false; reason: string };

/**
 * mention 配列が当該 entityType で許容される kind だけで構成されているかを検証する (Q3 サーバ側 enforce)。
 * UI 側の tab 隠蔽を信用しない、二重防御。
 */
export function validateMentionsForEntity(
  entityType: CommentEntityType,
  mentions: MentionInput[],
): ValidationResult {
  const allowed = getAllowedMentionKinds(entityType);
  for (const m of mentions) {
    if (!allowed.has(m.kind)) {
      return {
        ok: false,
        reason: `メンション '${m.kind}' は ${entityType} では許可されていません`,
      };
    }
  }
  return { ok: true };
}

// ============================================================
// Entity → projectId / assigneeId 解決
// ============================================================

/**
 * メンション配信に必要な entity 情報 (projectId と assigneeId) を取得。
 *   - projectId: project_member / role_* kind の展開に必要
 *   - assigneeId: assignee kind の展開に必要 (entity 種別によっては null)
 *
 * 対象範囲:
 *   - task / stakeholder: projectId あり (DB 列)
 *   - risk / issue: projectId + reporterId or assigneeId (RiskIssue モデル)
 *   - retrospective / knowledge: projectId あり、assignee 概念なし → assigneeId=null
 *   - customer: projectId / assigneeId とも null (admin only entity)
 */
export type EntityContext = {
  projectId: string | null;
  assigneeId: string | null;
};

export async function getMentionContext(
  entityType: CommentEntityType,
  entityId: string,
  viewerTenantId: string,
): Promise<EntityContext | null> {
  // 2026-05-09 feedback Phase 2-7: 全 entity 検索に tenantId フィルタ必須化。
  //   越境 entity の context を取得すると mention 通知が他テナント user に飛ぶリスク。
  switch (entityType) {
    case 'task': {
      const t = await prisma.task.findFirst({
        where: { id: entityId, deletedAt: null, project: { tenantId: viewerTenantId } },
        select: { projectId: true, assigneeId: true },
      });
      return t ? { projectId: t.projectId, assigneeId: t.assigneeId } : null;
    }
    case 'issue':
    case 'risk': {
      const r = await prisma.riskIssue.findFirst({
        where: { id: entityId, deletedAt: null, tenantId: viewerTenantId },
        select: {
          projectId: true,
          assigneeId: true,
          riskIssueProjects: { select: { projectId: true }, take: 1 },
        },
      });
      if (!r) return null;
      const pid = r.projectId ?? r.riskIssueProjects[0]?.projectId ?? null;
      return { projectId: pid, assigneeId: r.assigneeId };
    }
    case 'retrospective': {
      const retro = await prisma.retrospective.findFirst({
        where: { id: entityId, deletedAt: null, tenantId: viewerTenantId },
        select: {
          projectId: true,
          retrospectiveProjects: { select: { projectId: true }, take: 1 },
        },
      });
      if (!retro) return null;
      const pid = retro.projectId ?? retro.retrospectiveProjects[0]?.projectId ?? null;
      return { projectId: pid, assigneeId: null };
    }
    case 'knowledge': {
      const k = await prisma.knowledge.findFirst({
        where: { id: entityId, deletedAt: null, tenantId: viewerTenantId },
        select: {
          knowledgeProjects: { select: { projectId: true }, take: 1 },
        },
      });
      if (!k) return null;
      const pid = k.knowledgeProjects[0]?.projectId ?? null;
      return { projectId: pid, assigneeId: null };
    }
    case 'stakeholder': {
      const s = await prisma.stakeholder.findFirst({
        where: { id: entityId, deletedAt: null, tenantId: viewerTenantId },
        select: { projectId: true, userId: true },
      });
      return s ? { projectId: s.projectId, assigneeId: s.userId } : null;
    }
    case 'customer': {
      const c = await prisma.customer.findFirst({
        where: { id: entityId, tenantId: viewerTenantId },
        select: { id: true },
      });
      return c ? { projectId: null, assigneeId: null } : null;
    }
    case 'memo': {
      const m = await prisma.memo.findFirst({
        where: { id: entityId, deletedAt: null, tenantId: viewerTenantId },
        select: { id: true },
      });
      return m ? { projectId: null, assigneeId: null } : null;
    }
  }
}

// ============================================================
// kind → userId[] 展開
// ============================================================

/**
 * 単一 mention を userId 配列に展開する。
 * 投稿者本人 (excludeUserId) は呼出側で除外する想定 (この関数は raw リストを返す)。
 */
export async function expandMention(
  mention: MentionInput,
  context: EntityContext,
  viewerTenantId: string,
): Promise<string[]> {
  switch (mention.kind) {
    case 'user':
      // kind='user' は targetUserId が必須 (validator で保証)
      return mention.targetUserId ? [mention.targetUserId] : [];

    case 'all': {
      // 2026-05-09 feedback Phase 2-7: 「全アカウント」は自テナント内に限定。
      //   旧仕様は全テナントの全ユーザに通知が飛ぶ重大バグだった。
      const users = await prisma.user.findMany({
        where: {
          tenantId: viewerTenantId,
          isActive: true,
          deletedAt: null,
          permanentLock: false,
        },
        select: { id: true },
      });
      return users.map((u) => u.id);
    }

    case 'project_member': {
      if (!context.projectId) return [];
      const members = await prisma.projectMember.findMany({
        where: { projectId: context.projectId },
        select: { userId: true },
      });
      return members.map((m) => m.userId);
    }

    case 'role_pm_tl':
    case 'role_general':
    case 'role_viewer': {
      if (!context.projectId) return [];
      const roleMap: Record<string, string> = {
        role_pm_tl: 'pm_tl',
        role_general: 'member',
        role_viewer: 'viewer',
      };
      const projectRole = roleMap[mention.kind];
      const members = await prisma.projectMember.findMany({
        where: { projectId: context.projectId, projectRole },
        select: { userId: true },
      });
      return members.map((m) => m.userId);
    }

    case 'assignee':
      return context.assigneeId ? [context.assigneeId] : [];
  }
}

/**
 * mention 配列を **重複排除した受信者 userId set** に展開する (投稿者本人は除外)。
 */
export async function expandMentionsToRecipients(
  mentions: MentionInput[],
  context: EntityContext,
  excludeUserId: string,
  viewerTenantId: string,
): Promise<Set<string>> {
  const recipients = new Set<string>();
  for (const m of mentions) {
    const ids = await expandMention(m, context, viewerTenantId);
    for (const id of ids) recipients.add(id);
  }
  recipients.delete(excludeUserId); // Q5: 自分宛は通知しない
  return recipients;
}

// ============================================================
// DB 操作 (Mention CRUD + diff)
// ============================================================

/** mention の同一性キー: 同じ kind / targetUserId なら同じメンションと見なす (diff で使用) */
export function mentionKey(m: { kind: string; targetUserId: string | null }): string {
  return `${m.kind}:${m.targetUserId ?? ''}`;
}

/**
 * 旧 mention と新 mention 入力を diff し、追加分 / 削除分を返す。
 * Q2 採用: 編集時は追加分のみ通知、削除分は何もしない。
 */
export function diffMentions(
  oldMentions: { id: string; kind: string; targetUserId: string | null }[],
  newInputs: MentionInput[],
): {
  added: MentionInput[];
  removedIds: string[];
} {
  const oldKeys = new Set(oldMentions.map(mentionKey));
  const newKeys = new Set(newInputs.map((m) => mentionKey({ kind: m.kind, targetUserId: m.targetUserId ?? null })));
  const added = newInputs.filter((m) => !oldKeys.has(mentionKey({ kind: m.kind, targetUserId: m.targetUserId ?? null })));
  const removedIds = oldMentions.filter((m) => !newKeys.has(mentionKey(m))).map((m) => m.id);
  return { added, removedIds };
}

// ============================================================
// 通知生成
// ============================================================

/**
 * 指定コメントのメンション群から Notification を一括生成。
 * dedupeKey UNIQUE で 2 重生成を弾く (DB レベル)。
 *
 * 戻り値: 生成件数 (createMany.count)。
 */
export async function generateMentionNotifications(params: {
  commentId: string;
  comment: { entityType: CommentEntityType; entityId: string };
  mentions: MentionInput[];
  mentionerId: string;
  mentionerName: string | null;
  /** Notification.link に使う URL (UI で深いリンクを開く想定) */
  link: string;
  /**
   * 2026-05-09 feedback Phase 2-7: 通知が飛ぶ tenant スコープ (送信者の tenantId)。
   *   省略時は entity から逆引きする (旧シグネチャ互換、PR #302 マージ後に必須化予定)。
   */
  tenantId?: string;
}): Promise<{ created: number }> {
  const { commentId, comment, mentions, mentionerId, mentionerName, link, tenantId } = params;
  if (mentions.length === 0) return { created: 0 };

  // 2026-05-09 feedback Phase 2-7: tenantId 未指定時は entity から逆引き (旧呼び出し元互換)。
  let resolvedTenantId = tenantId;
  if (!resolvedTenantId) {
    const fallbackTenant = await resolveEntityTenantId(comment.entityType, comment.entityId);
    if (!fallbackTenant) return { created: 0 };
    resolvedTenantId = fallbackTenant;
  }

  const ctx = await getMentionContext(comment.entityType, comment.entityId, resolvedTenantId);
  if (!ctx) return { created: 0 }; // entity が見つからない (削除済等)

  const recipients = await expandMentionsToRecipients(mentions, ctx, mentionerId, resolvedTenantId);
  if (recipients.size === 0) return { created: 0 };

  const senderLabel = mentionerName ?? '誰か';

  // PR #425 (2026-05-22): 通知文言から「どこで誰がメンションしたか」が分かるよう entity 情報を含める。
  //   旧文言: 「○○さんがコメントであなたをメンションしました」 (= どの comment か不明)
  //   新文言: 「[プロジェクト名] タスク「親WP / ACT名」で ○○さんがコメントでメンションしました」
  //   entity 削除済 等で取得失敗時は旧文言にフォールバック (= 通知生成自体は止めない)。
  //   ★severity-1★ tenantId を渡してテナント越境防止 (= 他テナントの entity 名を漏洩させない)
  const entityCtx = await resolveEntityLabelForMention(
    comment.entityType,
    comment.entityId,
    resolvedTenantId,
  );

  // 2026-05-09 feedback Phase 2-7: notification.createMany の data に tenantId を明示。
  const data = Array.from(recipients).map((userId) => ({
    tenantId: resolvedTenantId!,
    userId,
    type: 'comment_mention' as const,
    entityType: comment.entityType,
    entityId: comment.entityId,
    title: buildMentionNotificationTitle({
      senderLabel,
      entityLabel: entityCtx?.entityLabel ?? null,
      projectName: entityCtx?.projectName ?? null,
    }),
    link,
    dedupeKey: `comment_mention:${commentId}:${userId}`,
  }));
  const r = await prisma.notification.createMany({ data, skipDuplicates: true });
  return { created: r.count };
}

/**
 * PR #425 (2026-05-22): メンション通知文言を「[プロジェクト名] entityLabel で {sender}さんがコメントでメンションしました」
 * 形式で生成する純関数。
 *
 * - projectName が null/空 の場合は接頭辞を省略 (= テナント直下の entity)
 * - entityLabel が null の場合 (= entity 削除済等) は旧形式にフォールバック
 * - Notification.title VARCHAR(200) を超える場合は末尾を切り詰める
 */
export function buildMentionNotificationTitle(input: {
  senderLabel: string;
  entityLabel: string | null;
  projectName: string | null;
}): string {
  if (!input.entityLabel) {
    // entity 取得失敗時のフォールバック (旧文言)
    return `${input.senderLabel}さんがコメントであなたをメンションしました`;
  }
  const projectPrefix = input.projectName && input.projectName.trim().length > 0
    ? `[${input.projectName}] `
    : '';
  const raw = `${projectPrefix}${input.entityLabel}で ${input.senderLabel}さんがコメントでメンションしました`;
  if (raw.length <= 200) return raw;
  return `${raw.slice(0, 199)}…`;
}

/**
 * PR #425 (2026-05-22): entity から表示用ラベル (entityLabel + projectName) を取得する内部ヘルパー。
 *   メンション通知文言の組立に使用。entity 種別ごとに「name」「title」フィールドが異なるため
 *   ここで吸収する。entity が見つからない (削除済等) なら null。
 *
 * Schema 出典:
 *   - Task:           name + parentTask.name + project.name
 *   - RiskIssue:      title + project.name (project は nullable)
 *   - Retrospective:  title + project.name (project は nullable)
 *   - Knowledge:      title のみ (projectId 列なし、M:N の KnowledgeProject 経由)
 *   - Stakeholder:    name + project.name
 *   - Customer:       name のみ (projectId 列なし)
 *   - Memo:           title のみ (projectId 列なし)
 */
async function resolveEntityLabelForMention(
  entityType: CommentEntityType,
  entityId: string,
  tenantId: string,
): Promise<{ entityLabel: string; projectName: string | null } | null> {
  // ★severity-1★ 全 findFirst に tenantId フィルタを必須 (テナント越境防止 invariant)
  switch (entityType) {
    case 'task': {
      // Task は tenantId 列を持たないため project.tenantId で絞る
      const t = await prisma.task.findFirst({
        where: { id: entityId, deletedAt: null, project: { tenantId } },
        select: {
          name: true,
          parentTask: { select: { name: true } },
          project: { select: { name: true } },
        },
      });
      if (!t) return null;
      const parentPart = t.parentTask?.name ? `${t.parentTask.name} / ` : '';
      return {
        entityLabel: `タスク「${parentPart}${t.name}」`,
        projectName: t.project?.name ?? null,
      };
    }
    case 'issue':
    case 'risk': {
      const r = await prisma.riskIssue.findFirst({
        where: { id: entityId, deletedAt: null, tenantId },
        select: {
          title: true,
          project: { select: { name: true } },
        },
      });
      if (!r) return null;
      const kindLabel = entityType === 'risk' ? 'リスク' : '課題';
      return {
        entityLabel: `${kindLabel}「${r.title}」`,
        projectName: r.project?.name ?? null,
      };
    }
    case 'retrospective': {
      const retro = await prisma.retrospective.findFirst({
        where: { id: entityId, deletedAt: null, tenantId },
        select: { title: true, project: { select: { name: true } } },
      });
      if (!retro) return null;
      return {
        entityLabel: `振り返り「${retro.title}」`,
        projectName: retro.project?.name ?? null,
      };
    }
    case 'knowledge': {
      const k = await prisma.knowledge.findFirst({
        where: { id: entityId, deletedAt: null, tenantId },
        select: { title: true },
      });
      if (!k) return null;
      return {
        entityLabel: `ナレッジ「${k.title}」`,
        projectName: null, // Knowledge は tenant-wide (M:N で project を持つ)
      };
    }
    case 'stakeholder': {
      const s = await prisma.stakeholder.findFirst({
        where: { id: entityId, deletedAt: null, tenantId },
        select: { name: true, project: { select: { name: true } } },
      });
      if (!s) return null;
      return {
        entityLabel: `ステークホルダー「${s.name}」`,
        projectName: s.project?.name ?? null,
      };
    }
    case 'customer': {
      const c = await prisma.customer.findFirst({
        where: { id: entityId, tenantId },
        select: { name: true },
      });
      if (!c) return null;
      return {
        entityLabel: `顧客「${c.name}」`,
        projectName: null,
      };
    }
    case 'memo': {
      const m = await prisma.memo.findFirst({
        where: { id: entityId, deletedAt: null, tenantId },
        select: { title: true },
      });
      if (!m) return null;
      return {
        entityLabel: `メモ「${m.title}」`,
        projectName: null,
      };
    }
  }
}

/**
 * 2026-05-09 feedback Phase 2-7: entity から tenantId を逆引きする内部ヘルパー。
 *   `generateMentionNotifications` の tenantId 引数省略時 (旧シグネチャ互換) のフォールバック用。
 */
async function resolveEntityTenantId(
  entityType: CommentEntityType,
  entityId: string,
): Promise<string | null> {
  switch (entityType) {
    case 'task': {
      const t = await prisma.task.findFirst({
        where: { id: entityId, deletedAt: null },
        select: { project: { select: { tenantId: true } } },
      });
      return t?.project?.tenantId ?? null;
    }
    case 'issue':
    case 'risk': {
      const r = await prisma.riskIssue.findFirst({
        where: { id: entityId, deletedAt: null },
        select: { tenantId: true },
      });
      return r?.tenantId ?? null;
    }
    case 'retrospective': {
      const retro = await prisma.retrospective.findFirst({
        where: { id: entityId, deletedAt: null },
        select: { tenantId: true },
      });
      return retro?.tenantId ?? null;
    }
    case 'knowledge': {
      const k = await prisma.knowledge.findFirst({
        where: { id: entityId, deletedAt: null },
        select: { tenantId: true },
      });
      return k?.tenantId ?? null;
    }
    case 'stakeholder': {
      const s = await prisma.stakeholder.findFirst({
        where: { id: entityId, deletedAt: null },
        select: { tenantId: true },
      });
      return s?.tenantId ?? null;
    }
    case 'customer': {
      const c = await prisma.customer.findFirst({
        where: { id: entityId },
        select: { tenantId: true },
      });
      return c?.tenantId ?? null;
    }
    case 'memo': {
      const m = await prisma.memo.findFirst({
        where: { id: entityId, deletedAt: null },
        select: { tenantId: true },
      });
      return m?.tenantId ?? null;
    }
  }
}
