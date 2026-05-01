/**
 * コメントサービス (PR #199)。
 *
 * 設計方針:
 *   - ポリモーフィック関連 (entity_type + entity_id) で 7 種のエンティティ
 *     (issue/task/risk/retrospective/knowledge/customer/stakeholder) に紐づく。
 *   - 認可 (entity 別、2026-05-01 PR feat/notification-edit-dialog で細粒化):
 *     - issue / risk / retrospective / knowledge: 認証済ユーザ全員 (要件 Q4、cross-list で誰でも閲覧/投稿可)
 *     - task: ProjectMember (or admin) のみ
 *     - stakeholder: PM/TL (or admin) のみ — ステークホルダ管理は計画責任者の業務領域
 *     - customer: admin のみ — admin 専用エンティティ
 *     ※ 編集 / 削除: 投稿者本人のみ (admin 救済なし、要件 Q5)
 *   - 削除: soft-delete (deletedAt) — 監査要件 + 編集履歴保持
 *   - 並び順: 新しい順 (createdAt DESC) — 要件 Q6
 *
 * 関連:
 *   - DESIGN.md §22 (Attachment と同じ polymorphic パターン)
 *   - DEVELOPER_GUIDE §5.49 (本機能の実装ナレッジ)
 */

import { prisma } from '@/lib/db';
import type { CommentEntityType } from '@/lib/validators/comment';
import type { MentionInput } from '@/lib/validators/mention';
import {
  diffMentions,
  generateMentionNotifications,
} from './mention.service';

export type CommentDTO = {
  id: string;
  entityType: string;
  entityId: string;
  userId: string;
  userName: string | null;
  content: string;
  createdAt: string;
  updatedAt: string;
  /** 編集済か (createdAt と updatedAt が異なる) */
  edited: boolean;
};

function toDTO(c: {
  id: string;
  entityType: string;
  entityId: string;
  userId: string;
  content: string;
  createdAt: Date;
  updatedAt: Date;
  user?: { name: string } | null;
}): CommentDTO {
  return {
    id: c.id,
    entityType: c.entityType,
    entityId: c.entityId,
    userId: c.userId,
    userName: c.user?.name ?? null,
    content: c.content,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
    edited: c.createdAt.getTime() !== c.updatedAt.getTime(),
  };
}

/**
 * エンティティに紐づく有効なコメント一覧を取得する (論理削除済みは除外)。
 * 並び順: 新しい順 (createdAt DESC) — 要件 Q6。
 */
export async function listComments(
  entityType: CommentEntityType,
  entityId: string,
): Promise<CommentDTO[]> {
  const rows = await prisma.comment.findMany({
    where: { entityType, entityId, deletedAt: null },
    include: { user: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(toDTO);
}

/**
 * コメントを作成する。entity 存在確認は呼び出し側 (route layer) の認可ステップで実施済の前提。
 *
 * mentions は省略可。指定された場合:
 *   1. Mention レコードを一括作成
 *   2. メンション対象 user に Notification (type='comment_mention') を一括生成 (Q5: 自分宛は除外)
 *
 * mention の kind 妥当性 (entity 別の許容 kind) は呼出側で `validateMentionsForEntity` 済の前提。
 */
export async function createComment(
  input: { entityType: CommentEntityType; entityId: string; content: string },
  userId: string,
  mentions: MentionInput[] = [],
  mentionerName: string | null = null,
  link: string = '',
): Promise<CommentDTO> {
  const created = await prisma.comment.create({
    data: {
      entityType: input.entityType,
      entityId: input.entityId,
      userId,
      content: input.content,
    },
    include: { user: { select: { name: true } } },
  });

  if (mentions.length > 0) {
    // Mention レコード作成
    await prisma.mention.createMany({
      data: mentions.map((m) => ({
        commentId: created.id,
        kind: m.kind,
        targetUserId: m.targetUserId ?? null,
      })),
    });
    // 通知一括生成 (Q5 自分宛除外、dedupe は DB UNIQUE で担保)
    await generateMentionNotifications({
      commentId: created.id,
      comment: { entityType: input.entityType, entityId: input.entityId },
      mentions,
      mentionerId: userId,
      mentionerName: mentionerName ?? created.user?.name ?? null,
      link,
    });
  }

  return toDTO(created);
}

/**
 * 指定 ID のコメントを取得する (論理削除除外)。
 * 編集 / 削除前の認可判定で「投稿者本人か」を確認するため、まず取得して userId を返す。
 */
export async function getComment(commentId: string): Promise<CommentDTO | null> {
  const c = await prisma.comment.findFirst({
    where: { id: commentId, deletedAt: null },
    include: { user: { select: { name: true } } },
  });
  return c ? toDTO(c) : null;
}

/**
 * コメント本文を更新する。
 * 2026-05-01 仕様: 認可は呼び出し側で **投稿者本人のみ** を確認 (admin 不可)。
 * updatedAt は @updatedAt で自動更新される。
 *
 * mentions が undefined のときは mention は触らない (互換)。配列が渡された場合は:
 *   - 旧 mention との diff を計算 (Q2: 追加分のみ通知、削除分は何もしない)
 *   - 削除分の Mention レコードを deleteMany
 *   - 追加分の Mention レコードを createMany + Notification 生成
 */
export async function updateComment(
  commentId: string,
  content: string,
  mentions?: MentionInput[],
  mentionerName: string | null = null,
  link: string = '',
): Promise<CommentDTO> {
  const updated = await prisma.comment.update({
    where: { id: commentId },
    data: { content },
    include: { user: { select: { name: true } } },
  });

  if (mentions !== undefined) {
    // 旧 mentions 取得
    const old = await prisma.mention.findMany({
      where: { commentId },
      select: { id: true, kind: true, targetUserId: true },
    });
    const { added, removedIds } = diffMentions(old, mentions);

    if (removedIds.length > 0) {
      await prisma.mention.deleteMany({ where: { id: { in: removedIds } } });
    }
    if (added.length > 0) {
      await prisma.mention.createMany({
        data: added.map((m) => ({
          commentId,
          kind: m.kind,
          targetUserId: m.targetUserId ?? null,
        })),
      });
      // Q2 採用: 追加分のみ通知 (削除分は何もしない)
      await generateMentionNotifications({
        commentId,
        comment: { entityType: updated.entityType as CommentEntityType, entityId: updated.entityId },
        mentions: added,
        mentionerId: updated.userId,
        mentionerName: mentionerName ?? updated.user?.name ?? null,
        link,
      });
    }
  }

  return toDTO(updated);
}

/**
 * コメントを論理削除する。
 * 2026-05-01 仕様: 認可は呼び出し側で **投稿者本人のみ** を確認 (admin の救済は外した)。
 */
export async function deleteComment(commentId: string): Promise<void> {
  await prisma.comment.update({
    where: { id: commentId },
    data: { deletedAt: new Date() },
  });
}

/**
 * 親エンティティの存在を検証し、認可判定に必要な情報を返す。
 *
 * 2026-05-01 (PR fix/visibility-auth-matrix): visibility 連動の認可仕様に合わせて
 *   `kind: 'open'` を `kind: 'public-or-draft'` (visibility + creatorId 付き) に分割。
 *   route 層で mode=read/write を区別して、draft の場合は作成者本人のみ書き込み許可
 *   (admin は read のみ可) に絞る。
 *
 * - not-found: エンティティが存在しない (404)
 * - public-or-draft: visibility と creatorId を返し、route 層が認可判定する
 *   (issue / risk / retrospective / knowledge)
 * - project-scoped: project member 必須 (task / stakeholder)
 *   - requiredRole='pm_tl' 指定時は PM/TL ロールのみ許可 (stakeholder)
 *   - requiredRole='any' (or 未指定) は全 project member 許可 (task)
 * - admin-only: Customer (admin 専用エンティティ)
 */
export type EntityResolveResult =
  | { kind: 'not-found' }
  | { kind: 'public-or-draft'; visibility: 'public' | 'draft'; creatorId: string }
  | { kind: 'project-scoped'; projectIds: string[]; requiredRole: 'any' | 'pm_tl' }
  | { kind: 'admin-only' };

export async function resolveEntityForComment(
  entityType: CommentEntityType,
  entityId: string,
): Promise<EntityResolveResult> {
  switch (entityType) {
    case 'issue':
    case 'risk': {
      // issue / risk は同一 RiskIssue モデル (type discriminator で区別)
      // 作成者は reporterId
      const r = await prisma.riskIssue.findFirst({
        where: { id: entityId, deletedAt: null },
        select: { visibility: true, reporterId: true },
      });
      return r
        ? {
          kind: 'public-or-draft',
          visibility: r.visibility as 'public' | 'draft',
          creatorId: r.reporterId,
        }
        : { kind: 'not-found' };
    }
    case 'retrospective': {
      const retro = await prisma.retrospective.findFirst({
        where: { id: entityId, deletedAt: null },
        select: { visibility: true, createdBy: true },
      });
      return retro
        ? {
          kind: 'public-or-draft',
          visibility: retro.visibility as 'public' | 'draft',
          creatorId: retro.createdBy,
        }
        : { kind: 'not-found' };
    }
    case 'knowledge': {
      const k = await prisma.knowledge.findFirst({
        where: { id: entityId, deletedAt: null },
        select: { visibility: true, createdBy: true },
      });
      return k
        ? {
          kind: 'public-or-draft',
          visibility: k.visibility as 'public' | 'draft',
          creatorId: k.createdBy,
        }
        : { kind: 'not-found' };
    }
    case 'task': {
      // Task は project-scoped、ProjectMember 全員にメンション/コメント許可 (要件 2026-05-01)
      const t = await prisma.task.findFirst({
        where: { id: entityId, deletedAt: null },
        select: { projectId: true },
      });
      return t
        ? { kind: 'project-scoped', projectIds: [t.projectId], requiredRole: 'any' }
        : { kind: 'not-found' };
    }
    case 'stakeholder': {
      // Stakeholder は project-scoped、PM/TL のみメンション/コメント許可 (要件 2026-05-01)
      // ステークホルダ管理は計画責任者の業務領域のため、一般メンバーには書き込み権限を渡さない。
      const s = await prisma.stakeholder.findFirst({
        where: { id: entityId, deletedAt: null },
        select: { projectId: true },
      });
      return s
        ? { kind: 'project-scoped', projectIds: [s.projectId], requiredRole: 'pm_tl' }
        : { kind: 'not-found' };
    }
    case 'customer': {
      // Customer は admin only (物理削除方針なので deletedAt 列なし、id のみ確認)
      const c = await prisma.customer.findFirst({
        where: { id: entityId },
        select: { id: true },
      });
      return c ? { kind: 'admin-only' } : { kind: 'not-found' };
    }
  }
}

/**
 * 指定 entityType / entityId / userId に紐づく **同 entity の有効コメント** を一括 soft-delete する。
 * entity 削除時の cascade に呼ぶ (各 service 層の delete から呼び出し)。
 */
export async function softDeleteCommentsForEntity(
  entityType: CommentEntityType,
  entityId: string,
): Promise<void> {
  await prisma.comment.updateMany({
    where: { entityType, entityId, deletedAt: null },
    data: { deletedAt: new Date() },
  });
}
