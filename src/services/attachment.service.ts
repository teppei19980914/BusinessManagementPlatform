/**
 * 添付リンクサービス (PR #64 Phase 1)。
 *
 * 設計方針:
 *   - ファイル実体は持たず、外部ストレージの URL のみを扱う (DESIGN.md §21.3)
 *   - 6 種のエンティティと同一テーブルで紐づく (DRY 原則)
 *   - 単数スロット (primary / source 等) は「既存を deletedAt セットして新規作成」で
 *     upsert 的に扱う — 履歴を残したい場合に備えて論理削除で統一
 *   - 認可は親エンティティ → Project の導出を通じ、既存 checkProjectPermission を再利用
 */

import { prisma } from '@/lib/db';
import type {
  AttachmentEntityType,
  CreateAttachmentInput,
  UpdateAttachmentInput,
} from '@/lib/validators/attachment';

export type AttachmentDTO = {
  id: string;
  entityType: string;
  entityId: string;
  slot: string;
  displayName: string;
  url: string;
  mimeHint: string | null;
  addedBy: string;
  addedByName: string | null;
  createdAt: string;
  updatedAt: string;
};

function toDTO(a: {
  id: string;
  entityType: string;
  entityId: string;
  slot: string;
  displayName: string;
  url: string;
  mimeHint: string | null;
  addedBy: string;
  addedByUser?: { name: string } | null;
  createdAt: Date;
  updatedAt: Date;
}): AttachmentDTO {
  return {
    id: a.id,
    entityType: a.entityType,
    entityId: a.entityId,
    slot: a.slot,
    displayName: a.displayName,
    url: a.url,
    mimeHint: a.mimeHint,
    addedBy: a.addedBy,
    addedByName: a.addedByUser?.name ?? null,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

/**
 * エンティティに紐づく有効な添付の一覧を取得する (論理削除済みは除外)。
 * slot を指定した場合はそのスロットのみ返す (単数スロット検証などに使う)。
 */
export async function listAttachments(
  entityType: AttachmentEntityType,
  entityId: string,
  slot?: string,
): Promise<AttachmentDTO[]> {
  const rows = await prisma.attachment.findMany({
    where: {
      entityType,
      entityId,
      slot: slot ?? undefined,
      deletedAt: null,
    },
    include: { addedByUser: { select: { name: true } } },
    orderBy: [{ slot: 'asc' }, { createdAt: 'asc' }],
  });
  return rows.map(toDTO);
}

export async function getAttachment(id: string): Promise<AttachmentDTO | null> {
  const a = await prisma.attachment.findFirst({
    where: { id, deletedAt: null },
    include: { addedByUser: { select: { name: true } } },
  });
  return a ? toDTO(a) : null;
}

/**
 * 添付を作成する。
 * slot が単数スロット (SINGLE_SLOTS) に含まれる場合、同一 entity+slot の既存行を
 * 論理削除した上で新規作成し「常に 1 件」の制約を満たす。
 */
const SINGLE_SLOTS = new Set(['primary', 'source']);

export async function createAttachment(
  input: CreateAttachmentInput,
  userId: string,
): Promise<AttachmentDTO> {
  const slot = input.slot ?? 'general';

  // 単数スロットは既存行を論理削除してから新規作成 (履歴保持のため UPDATE ではなく置換)
  if (SINGLE_SLOTS.has(slot)) {
    await prisma.attachment.updateMany({
      where: {
        entityType: input.entityType,
        entityId: input.entityId,
        slot,
        deletedAt: null,
      },
      data: { deletedAt: new Date() },
    });
  }

  const created = await prisma.attachment.create({
    data: {
      entityType: input.entityType,
      entityId: input.entityId,
      slot,
      displayName: input.displayName,
      url: input.url,
      mimeHint: input.mimeHint,
      addedBy: userId,
    },
    include: { addedByUser: { select: { name: true } } },
  });
  return toDTO(created);
}

export async function updateAttachment(
  id: string,
  input: UpdateAttachmentInput,
): Promise<AttachmentDTO> {
  const updated = await prisma.attachment.update({
    where: { id },
    data: {
      displayName: input.displayName,
      url: input.url,
      mimeHint: input.mimeHint,
    },
    include: { addedByUser: { select: { name: true } } },
  });
  return toDTO(updated);
}

/** 論理削除 (restore 余地を残す) */
export async function deleteAttachment(id: string): Promise<void> {
  await prisma.attachment.update({
    where: { id },
    data: { deletedAt: new Date() },
  });
}

/**
 * 親エンティティの visibility と作成者を取得する (PR #213 / 2026-05-01)。
 *
 * `/api/attachments` の `authorize()` で「全○○」(cross-list) からの readOnly dialog
 * からのリクエストを救うために使う。`visibility='public'` の risk/retrospective/knowledge は
 * 非メンバーでも添付閲覧可とする (batch route の fix/cross-list-non-member-columns
 * 2026-04-27 と整合)。
 *
 * 戻り値:
 *   - `null`: visibility 概念のない entity (project / task / estimate / memo / customer)
 *   - `{ visibility, creatorId }`: visibility を持つ entity (risk / retrospective / knowledge)
 *   - `'not-found'`: entity が削除済 / 不在
 */
export async function getEntityVisibility(
  entityType: AttachmentEntityType,
  entityId: string,
): Promise<{ visibility: 'public' | 'draft'; creatorId: string } | null | 'not-found'> {
  switch (entityType) {
    case 'risk': {
      const r = await prisma.riskIssue.findFirst({
        where: { id: entityId, deletedAt: null },
        select: { visibility: true, reporterId: true },
      });
      if (!r) return 'not-found';
      return { visibility: r.visibility as 'public' | 'draft', creatorId: r.reporterId };
    }
    case 'retrospective': {
      const retro = await prisma.retrospective.findFirst({
        where: { id: entityId, deletedAt: null },
        select: { visibility: true, createdBy: true },
      });
      if (!retro) return 'not-found';
      return { visibility: retro.visibility as 'public' | 'draft', creatorId: retro.createdBy };
    }
    case 'knowledge': {
      const k = await prisma.knowledge.findFirst({
        where: { id: entityId, deletedAt: null },
        select: { visibility: true, createdBy: true },
      });
      if (!k) return 'not-found';
      return { visibility: k.visibility as 'public' | 'draft', creatorId: k.createdBy };
    }
    default:
      return null; // visibility 概念なし: project / task / estimate / memo / customer
  }
}

/**
 * 親エンティティから Project ID を解決する (認可導出用)。
 * 見つからない場合は null を返す (呼び出し側で 404 を返すこと)。
 *
 * knowledge は複数プロジェクトに紐づきうるため、紐付け先プロジェクトの配列を返す。
 * 呼び出し側はいずれか 1 つでも権限があれば許可、という判定を行う。
 */
export async function resolveProjectIds(
  entityType: AttachmentEntityType,
  entityId: string,
): Promise<string[] | null> {
  switch (entityType) {
    case 'project': {
      const p = await prisma.project.findFirst({
        where: { id: entityId, deletedAt: null },
        select: { id: true },
      });
      return p ? [p.id] : null;
    }
    case 'task': {
      const t = await prisma.task.findFirst({
        where: { id: entityId, deletedAt: null },
        select: { projectId: true },
      });
      return t ? [t.projectId] : null;
    }
    case 'estimate': {
      const e = await prisma.estimate.findFirst({
        where: { id: entityId, deletedAt: null },
        select: { projectId: true },
      });
      return e ? [e.projectId] : null;
    }
    case 'risk': {
      const r = await prisma.riskIssue.findFirst({
        where: { id: entityId, deletedAt: null },
        select: { projectId: true },
      });
      return r ? [r.projectId] : null;
    }
    case 'retrospective': {
      const retro = await prisma.retrospective.findFirst({
        where: { id: entityId, deletedAt: null },
        select: { projectId: true },
      });
      return retro ? [retro.projectId] : null;
    }
    case 'knowledge': {
      const k = await prisma.knowledge.findFirst({
        where: { id: entityId, deletedAt: null },
        select: {
          id: true,
          knowledgeProjects: { select: { projectId: true } },
        },
      });
      if (!k) return null;
      // 紐付けプロジェクトがゼロの孤児ナレッジも許容 (admin のみ操作可能)
      return k.knowledgeProjects.map((kp) => kp.projectId);
    }
    case 'memo': {
      // PR #70: memo はプロジェクトに紐付かない個人エンティティなので projectIds は空。
      // 呼び出し側は authorizeMemoAttachment で userId+visibility を別途検証する必要がある。
      // null ではなく [] を返すのは「エンティティは存在する、が project 権限では判定不能」
      // であることを示すため。
      const m = await prisma.memo.findFirst({
        where: { id: entityId, deletedAt: null },
        select: { id: true },
      });
      return m ? [] : null;
    }
    default:
      return null;
  }
}

/**
 * Memo 添付の認可判定 (PR #70)。
 * project スコープではないため resolveProjectIds + checkMembership の共通経路に乗らない。
 *
 *   - read : 作成者 OR visibility='public'
 *   - write: 作成者のみ (admin 特権なし、要件どおり)
 */
export async function authorizeMemoAttachment(
  memoId: string,
  viewerUserId: string,
  mode: 'read' | 'write',
): Promise<{ ok: boolean; notFound: boolean }> {
  const memo = await prisma.memo.findFirst({
    where: { id: memoId, deletedAt: null },
    select: { userId: true, visibility: true },
  });
  if (!memo) return { ok: false, notFound: true };
  if (mode === 'write') {
    return { ok: memo.userId === viewerUserId, notFound: false };
  }
  return { ok: memo.userId === viewerUserId || memo.visibility === 'public', notFound: false };
}
