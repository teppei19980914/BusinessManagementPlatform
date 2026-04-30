/**
 * コメントサービス (PR #199)。
 *
 * 設計方針:
 *   - ポリモーフィック関連 (entity_type + entity_id) で 7 種のエンティティ
 *     (issue/task/risk/retrospective/knowledge/customer/stakeholder) に紐づく。
 *   - 認可:
 *     - 投稿 / 閲覧: 認証済ユーザは誰でも (project member 非メンバーも可、要件 Q4)
 *       ただしエンティティ存在確認は行う (存在しない id への comment 防止)。
 *     - 編集 / 削除: 投稿者本人 OR システム管理者 (要件 Q5)
 *   - 削除: soft-delete (deletedAt) — 監査要件 + 編集履歴保持
 *   - 並び順: 新しい順 (createdAt DESC) — 要件 Q6
 *
 * 関連:
 *   - DESIGN.md §22 (Attachment と同じ polymorphic パターン)
 *   - DEVELOPER_GUIDE §5.49 (本機能の実装ナレッジ)
 */

import { prisma } from '@/lib/db';
import type { CommentEntityType } from '@/lib/validators/comment';

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
 */
export async function createComment(
  input: { entityType: CommentEntityType; entityId: string; content: string },
  userId: string,
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
 * コメント本文を更新する。認可は呼び出し側で投稿者本人 or admin を確認している前提。
 * updatedAt は @updatedAt で自動更新される。
 */
export async function updateComment(
  commentId: string,
  content: string,
): Promise<CommentDTO> {
  const updated = await prisma.comment.update({
    where: { id: commentId },
    data: { content },
    include: { user: { select: { name: true } } },
  });
  return toDTO(updated);
}

/**
 * コメントを論理削除する。認可は呼び出し側で投稿者本人 or admin を確認している前提。
 */
export async function deleteComment(commentId: string): Promise<void> {
  await prisma.comment.update({
    where: { id: commentId },
    data: { deletedAt: new Date() },
  });
}

/**
 * 親エンティティの存在を検証し、project スコープなら projectIds を返す。
 * - null: エンティティが存在しない (404)
 * - []: project に属さない (customer 等) — 全 auth user 可視のとき空配列
 * - [pid, ...]: 紐付くプロジェクト (member check 用)
 *
 * 'admin-only' を返すパスは Customer のみ。Customer はプロジェクトに属さず /customers
 * 画面が admin 専用のため、コメントも admin 限定にする。
 */
export type EntityResolveResult =
  | { kind: 'not-found' }
  | { kind: 'open' } // 認証済ユーザなら誰でも (issue/risk/retrospective/knowledge — 全○○ あり)
  | { kind: 'project-scoped'; projectIds: string[] } // project member 必須 (task/stakeholder)
  | { kind: 'admin-only' }; // customer

export async function resolveEntityForComment(
  entityType: CommentEntityType,
  entityId: string,
): Promise<EntityResolveResult> {
  switch (entityType) {
    case 'issue':
    case 'risk': {
      // issue / risk は同一 RiskIssue モデル (type discriminator で区別)
      const r = await prisma.riskIssue.findFirst({
        where: { id: entityId, deletedAt: null },
        select: { id: true },
      });
      return r ? { kind: 'open' } : { kind: 'not-found' };
    }
    case 'retrospective': {
      const retro = await prisma.retrospective.findFirst({
        where: { id: entityId, deletedAt: null },
        select: { id: true },
      });
      return retro ? { kind: 'open' } : { kind: 'not-found' };
    }
    case 'knowledge': {
      const k = await prisma.knowledge.findFirst({
        where: { id: entityId, deletedAt: null },
        select: { id: true },
      });
      return k ? { kind: 'open' } : { kind: 'not-found' };
    }
    case 'task': {
      // Task は project-scoped (top-level /tasks 画面なし、/my-tasks は filter のみ)
      const t = await prisma.task.findFirst({
        where: { id: entityId, deletedAt: null },
        select: { projectId: true },
      });
      return t
        ? { kind: 'project-scoped', projectIds: [t.projectId] }
        : { kind: 'not-found' };
    }
    case 'stakeholder': {
      // Stakeholder は project-scoped (top-level 画面なし)
      const s = await prisma.stakeholder.findFirst({
        where: { id: entityId, deletedAt: null },
        select: { projectId: true },
      });
      return s
        ? { kind: 'project-scoped', projectIds: [s.projectId] }
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
