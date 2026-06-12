/**
 * コメントサービス (PR #199)。
 *
 * 設計方針:
 *   - ポリモーフィック関連 (entity_type + entity_id) で 7 種のエンティティ
 *     (issue/task/risk/retrospective/knowledge/customer/stakeholder) に紐づく。
 *   - 認可 (entity 別、2026-05-01 PR feat/notification-deep-link-completion で再々細粒化):
 *     - issue / risk / retrospective / knowledge: 認証済ユーザ全員 (Q4、cross-list で誰でも閲覧/投稿可)
 *     - task: コメント投稿は認証済全員可 / **mention 含む場合のみ ProjectMember (or admin)** (新要件)
 *       理由: WBS タスクは「自分のタスクではないがコメントだけ残したい」ニーズがある (例: PMO や
 *       他チームのレビュアー)。一方 mention はタスク責任者の関係者ネットワーク内で完結させたい。
 *     - stakeholder: PM/TL (or admin) のみ (mention の有無に関わらず) — 計画責任者の業務領域
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
// 2026-05-09 (PR H / #3): 通知 link に commentId を付与して該当コメントへ直接遷移させる
import { buildEntityCommentLink } from '@/lib/entity-link';

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
  viewerTenantId: string,
): Promise<CommentDTO[]> {
  // 2026-05-09 feedback Phase 2-5: 越境一覧を遮断するため tenantId 必須化。
  const rows = await prisma.comment.findMany({
    where: { entityType, entityId, deletedAt: null, tenantId: viewerTenantId },
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
  tenantId: string,
  mentions: MentionInput[] = [],
  mentionerName: string | null = null,
): Promise<CommentDTO> {
  // 2026-05-09 feedback Phase 2-5: data.tenantId を明示し schema DB DEFAULT 暗黙依存を解消。
  const created = await prisma.comment.create({
    data: {
      tenantId,
      entityType: input.entityType,
      entityId: input.entityId,
      userId,
      content: input.content,
    },
    include: { user: { select: { name: true } } },
  });

  if (mentions.length > 0) {
    // Mention レコード作成
    // 2026-05-09 feedback Phase 2-5: mention にも tenantId を明示
    await prisma.mention.createMany({
      data: mentions.map((m) => ({
        tenantId,
        commentId: created.id,
        kind: m.kind,
        targetUserId: m.targetUserId ?? null,
      })),
    });
    // 2026-05-09 (PR H / #3): 通知 link を「commentId 付き」で生成。
    //   通知をクリックしたユーザは該当コメントへ自動スクロールできる (CommentSection 側で実装)。
    //   旧仕様は taskId/riskId のみで dialog は開くがコメント末尾配置のため画面外。
    const linkWithComment = await buildEntityCommentLink(
      input.entityType,
      input.entityId,
      created.id,
    );
    // 通知一括生成 (Q5 自分宛除外、dedupe は DB UNIQUE で担保)
    await generateMentionNotifications({
      commentId: created.id,
      comment: { entityType: input.entityType, entityId: input.entityId },
      mentions,
      mentionerId: userId,
      mentionerName: mentionerName ?? created.user?.name ?? null,
      link: linkWithComment,
    });
  }

  return toDTO(created);
}

/**
 * 指定 ID のコメントを取得する (論理削除除外)。
 * 編集 / 削除前の認可判定で「投稿者本人か」を確認するため、まず取得して userId を返す。
 */
export async function getComment(
  commentId: string,
  viewerTenantId: string,
): Promise<CommentDTO | null> {
  // 2026-05-09 feedback Phase 2-5: 越境取得を遮断するため tenantId 必須化。
  const c = await prisma.comment.findFirst({
    where: { id: commentId, deletedAt: null, tenantId: viewerTenantId },
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
  viewerTenantId: string,
  mentions?: MentionInput[],
  mentionerName: string | null = null,
): Promise<CommentDTO> {
  // 2026-05-09 feedback Phase 2-5: 越境編集を遮断するため findFirst で先に所有確認。
  const owned = await prisma.comment.findFirst({
    where: { id: commentId, tenantId: viewerTenantId },
    select: { id: true },
  });
  if (!owned) throw new Error('NOT_FOUND');

  const updated = await prisma.comment.update({
    where: { id: commentId },
    data: { content },
    include: { user: { select: { name: true } } },
  });

  if (mentions !== undefined) {
    // 旧 mentions 取得
    // 2026-05-12 severity-1 防御: tenantId 明示 (comment は親で tenant 検証済みだが mention にも併記)
    const old = await prisma.mention.findMany({
      where: { commentId, tenantId: viewerTenantId },
      select: { id: true, kind: true, targetUserId: true },
    });
    const { added, removedIds } = diffMentions(old, mentions);

    if (removedIds.length > 0) {
      await prisma.mention.deleteMany({
        where: { id: { in: removedIds }, tenantId: viewerTenantId, commentId },
      });
    }
    if (added.length > 0) {
      await prisma.mention.createMany({
        data: added.map((m) => ({
          tenantId: viewerTenantId,
          commentId,
          kind: m.kind,
          targetUserId: m.targetUserId ?? null,
        })),
      });
      // 2026-05-09 (PR H / #3): commentId 付き link で通知を生成
      const linkWithComment = await buildEntityCommentLink(
        updated.entityType as CommentEntityType,
        updated.entityId,
        commentId,
      );
      // Q2 採用: 追加分のみ通知 (削除分は何もしない)
      await generateMentionNotifications({
        commentId,
        comment: { entityType: updated.entityType as CommentEntityType, entityId: updated.entityId },
        mentions: added,
        mentionerId: updated.userId,
        mentionerName: mentionerName ?? updated.user?.name ?? null,
        link: linkWithComment,
      });
    }
  }

  return toDTO(updated);
}

/**
 * コメントを論理削除する。
 * 2026-05-01 仕様: 認可は呼び出し側で **投稿者本人のみ** を確認 (admin の救済は外した)。
 */
export async function deleteComment(
  commentId: string,
  viewerTenantId: string,
): Promise<void> {
  // 2026-05-09 feedback Phase 2-5: 越境削除を遮断するため updateMany で tenantId 検証。
  //   id 単独 update は越境で誤削除する経路、updateMany で where に tenantId 併記して防御。
  await prisma.comment.updateMany({
    where: { id: commentId, tenantId: viewerTenantId },
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
 * - project-scoped: project member 関連の認可
 *   - mentionRequiredRole: mention 含むコメント投稿時の必須 project ロール
 *     - 'any' = 全 project member (or admin) 許可 (task の mention)
 *     - 'pm_tl' = PM/TL (or admin) のみ許可 (stakeholder の mention)
 *   - plainCommentScope: mention なしコメント投稿時のスコープ
 *     - 'public' = 認証済ユーザ全員可 (task の plain コメント)
 *     - 'project-member' = mentionRequiredRole と同じ制限を適用 (stakeholder)
 * - admin-only: Customer (admin 専用エンティティ)
 */
export type EntityResolveResult =
  | { kind: 'not-found' }
  | { kind: 'public-or-draft'; visibility: 'public' | 'draft'; creatorId: string }
  | {
    kind: 'project-scoped';
    projectIds: string[];
    mentionRequiredRole: 'any' | 'pm_tl';
    plainCommentScope: 'public' | 'project-member';
  }
  | { kind: 'admin-only' };

export async function resolveEntityForComment(
  entityType: CommentEntityType,
  entityId: string,
  viewerTenantId: string,
): Promise<EntityResolveResult> {
  // 2026-05-09 feedback Phase 2-5: 全 entity 検索に tenantId フィルタ必須化。
  //   越境 entity の存在で内部状態が漏れる経路を遮断。
  //   Task / Memo は schema 上 tenantId 列を持つので直接フィルタ。
  //   その他 (riskIssue / retrospective / knowledge / stakeholder / customer) も tenantId 列保有。
  switch (entityType) {
    case 'issue':
    case 'risk': {
      const r = await prisma.riskIssue.findFirst({
        where: { id: entityId, deletedAt: null, tenantId: viewerTenantId },
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
        where: { id: entityId, deletedAt: null, tenantId: viewerTenantId },
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
        where: { id: entityId, deletedAt: null, tenantId: viewerTenantId },
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
      // Task は tenantId 列を持たないため project 経由でフィルタ
      const t = await prisma.task.findFirst({
        where: { id: entityId, deletedAt: null, project: { tenantId: viewerTenantId } },
        select: { projectId: true },
      });
      return t
        ? {
          kind: 'project-scoped',
          projectIds: [t.projectId],
          mentionRequiredRole: 'any',
          plainCommentScope: 'public',
        }
        : { kind: 'not-found' };
    }
    case 'stakeholder': {
      const s = await prisma.stakeholder.findFirst({
        where: { id: entityId, deletedAt: null, tenantId: viewerTenantId },
        select: { projectId: true },
      });
      return s
        ? {
          kind: 'project-scoped',
          projectIds: [s.projectId],
          mentionRequiredRole: 'pm_tl',
          plainCommentScope: 'project-member',
        }
        : { kind: 'not-found' };
    }
    case 'customer': {
      const c = await prisma.customer.findFirst({
        where: { id: entityId, tenantId: viewerTenantId },
        select: { id: true },
      });
      return c ? { kind: 'admin-only' } : { kind: 'not-found' };
    }
    case 'memo': {
      const m = await prisma.memo.findFirst({
        where: { id: entityId, deletedAt: null, tenantId: viewerTenantId },
        select: { visibility: true, userId: true },
      });
      return m
        ? {
          kind: 'public-or-draft',
          visibility: m.visibility as 'public' | 'draft',
          creatorId: m.userId,
        }
        : { kind: 'not-found' };
    }
  }
}

/**
 * 2026-06-12: コメント write (投稿) のクローズ済みプロジェクトガード判定。
 *
 * エンティティが「1 つ以上のプロジェクトに紐付き、かつ紐付く稼働中(非削除)プロジェクトが
 * **すべてクローズ済み (status='closed')**」のとき true を返す
 * (= そのエンティティはどの稼働中PJからも編集されない archived 状態 → コメントも不可)。
 *
 * 設計:
 *   - 多対多エンティティ (knowledge / risk / issue / retrospective) が「開いたPJ」と「閉じたPJ」の
 *     両方に紐付く場合は false (稼働中PJで生きているためコメント可)。これは
 *     comment-section の「cross-list の readOnly でもコメント可 (要件 Q4)」方針とも整合する
 *     (cross-list の readOnly は非メンバー閲覧であり、PJ ライフサイクルの closed とは別軸)。
 *   - project に紐付かない customer / memo、および紐付け 0 件 (orphan) は常に false
 *     (= ブロックしない。存在チェックは呼出側に委ねる)。
 *
 * @returns 紐付く全プロジェクトがクローズ済みなら true (= write ブロック対象)
 */
export async function isCommentTargetFullyClosed(
  entityType: CommentEntityType,
  entityId: string,
  viewerTenantId: string,
): Promise<boolean> {
  let statuses: string[] = [];
  switch (entityType) {
    case 'task': {
      const t = await prisma.task.findFirst({
        where: { id: entityId, deletedAt: null, project: { tenantId: viewerTenantId } },
        select: { project: { select: { status: true } } },
      });
      statuses = t?.project ? [t.project.status] : [];
      break;
    }
    case 'stakeholder': {
      const s = await prisma.stakeholder.findFirst({
        where: { id: entityId, deletedAt: null, tenantId: viewerTenantId },
        select: { project: { select: { status: true } } },
      });
      statuses = s?.project ? [s.project.status] : [];
      break;
    }
    case 'knowledge': {
      const rows = await prisma.knowledgeProject.findMany({
        where: { knowledgeId: entityId, project: { tenantId: viewerTenantId, deletedAt: null } },
        select: { project: { select: { status: true } } },
      });
      statuses = rows.map((r) => r.project.status);
      break;
    }
    case 'risk':
    case 'issue': {
      const rows = await prisma.riskIssueProject.findMany({
        where: { riskIssueId: entityId, project: { tenantId: viewerTenantId, deletedAt: null } },
        select: { project: { select: { status: true } } },
      });
      statuses = rows.map((r) => r.project.status);
      break;
    }
    case 'retrospective': {
      const rows = await prisma.retrospectiveProject.findMany({
        where: { retrospectiveId: entityId, project: { tenantId: viewerTenantId, deletedAt: null } },
        select: { project: { select: { status: true } } },
      });
      statuses = rows.map((r) => r.project.status);
      break;
    }
    default:
      // customer / memo: プロジェクトに紐付かないためクローズ概念の対象外
      return false;
  }
  if (statuses.length === 0) return false; // orphan / 未存在 はブロックしない
  return statuses.every((s) => s === 'closed');
}

/**
 * 指定 entityType / entityId / userId に紐づく **同 entity の有効コメント** を一括 soft-delete する。
 * entity 削除時の cascade に呼ぶ (各 service 層の delete から呼び出し)。
 */
export async function softDeleteCommentsForEntity(
  entityType: CommentEntityType,
  entityId: string,
  viewerTenantId: string,
): Promise<void> {
  // 2026-05-09 feedback Phase 2-5: 越境 cascade 削除を遮断するため tenantId 必須化。
  await prisma.comment.updateMany({
    where: { entityType, entityId, deletedAt: null, tenantId: viewerTenantId },
    data: { deletedAt: new Date() },
  });
}
