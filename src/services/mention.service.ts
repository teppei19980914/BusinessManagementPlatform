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
): Promise<EntityContext | null> {
  switch (entityType) {
    case 'task': {
      const t = await prisma.task.findFirst({
        where: { id: entityId, deletedAt: null },
        select: { projectId: true, assigneeId: true },
      });
      return t ? { projectId: t.projectId, assigneeId: t.assigneeId } : null;
    }
    case 'issue':
    case 'risk': {
      const r = await prisma.riskIssue.findFirst({
        where: { id: entityId, deletedAt: null },
        select: { projectId: true, assigneeId: true },
      });
      return r ? { projectId: r.projectId, assigneeId: r.assigneeId } : null;
    }
    case 'retrospective': {
      const retro = await prisma.retrospective.findFirst({
        where: { id: entityId, deletedAt: null },
        select: { projectId: true },
      });
      return retro ? { projectId: retro.projectId, assigneeId: null } : null;
    }
    case 'knowledge': {
      // Knowledge は N:M で複数プロジェクトに紐付き得る。MVP では projectId は使わない
      // (role_* / project_member kind は許容しているが、knowledgeProjects から最初の 1 件で代用)
      const k = await prisma.knowledge.findFirst({
        where: { id: entityId, deletedAt: null },
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
        where: { id: entityId, deletedAt: null },
        select: { projectId: true, userId: true },
      });
      // stakeholder.userId を assignee 相当として扱う (内部メンバー紐付けの場合)
      return s ? { projectId: s.projectId, assigneeId: s.userId } : null;
    }
    case 'customer': {
      const c = await prisma.customer.findFirst({
        where: { id: entityId },
        select: { id: true },
      });
      return c ? { projectId: null, assigneeId: null } : null;
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
): Promise<string[]> {
  switch (mention.kind) {
    case 'user':
      // kind='user' は targetUserId が必須 (validator で保証)
      return mention.targetUserId ? [mention.targetUserId] : [];

    case 'all': {
      // 認証済全アクティブユーザ
      const users = await prisma.user.findMany({
        where: { isActive: true, deletedAt: null, permanentLock: false },
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
): Promise<Set<string>> {
  const recipients = new Set<string>();
  for (const m of mentions) {
    const ids = await expandMention(m, context);
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
}): Promise<{ created: number }> {
  const { commentId, comment, mentions, mentionerId, mentionerName, link } = params;
  if (mentions.length === 0) return { created: 0 };

  const ctx = await getMentionContext(comment.entityType, comment.entityId);
  if (!ctx) return { created: 0 }; // entity が見つからない (削除済等)

  const recipients = await expandMentionsToRecipients(mentions, ctx, mentionerId);
  if (recipients.size === 0) return { created: 0 };

  const senderLabel = mentionerName ?? '誰か';
  const data = Array.from(recipients).map((userId) => ({
    userId,
    type: 'comment_mention' as const,
    entityType: comment.entityType,
    entityId: comment.entityId,
    title: `${senderLabel}さんがコメントであなたをメンションしました`,
    link,
    dedupeKey: `comment_mention:${commentId}:${userId}`,
  }));
  const r = await prisma.notification.createMany({ data, skipDuplicates: true });
  return { created: r.count };
}
