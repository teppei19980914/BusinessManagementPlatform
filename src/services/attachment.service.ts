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
import { checkMembership, isAdminOrAbove } from '@/lib/permissions';
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
  // ADR-0021 (2026-05-26): Supabase 本体保存型を識別するフィールド
  /** 'url' (= 旧 URL 参照型) / 'supabase' (= 本体保存) */
  storageProvider: string;
  /** ファイル本体サイズ (bytes)、url 型は null */
  sizeBytes: number | null;
  /** embedding 状態 ('pending' / 'completed' / 'unsupported' / 'failed')、url 型は null */
  embeddingStatus: string | null;
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
  storageProvider?: string;
  sizeBytes?: bigint | null;
  embeddingStatus?: string | null;
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
    storageProvider: a.storageProvider ?? 'url',
    sizeBytes: a.sizeBytes != null ? Number(a.sizeBytes) : null,
    embeddingStatus: a.embeddingStatus ?? null,
  };
}

/**
 * エンティティに紐づく有効な添付の一覧を取得する (論理削除済みは除外)。
 * slot を指定した場合はそのスロットのみ返す (単数スロット検証などに使う)。
 */
export async function listAttachments(
  entityType: AttachmentEntityType,
  entityId: string,
  viewerTenantId: string,
  slot?: string,
): Promise<AttachmentDTO[]> {
  // 2026-05-09 feedback Phase 2-5: 越境一覧を遮断するため tenantId 必須化。
  const rows = await prisma.attachment.findMany({
    where: {
      entityType,
      entityId,
      slot: slot ?? undefined,
      deletedAt: null,
      tenantId: viewerTenantId,
    },
    include: { addedByUser: { select: { name: true } } },
    orderBy: [{ slot: 'asc' }, { createdAt: 'asc' }],
  });
  return rows.map(toDTO);
}

export async function getAttachment(
  id: string,
  viewerTenantId: string,
): Promise<AttachmentDTO | null> {
  // 2026-05-09 feedback Phase 2-5: 越境取得を遮断するため tenantId 必須化。
  //   添付 URL は機密情報直結 (個人情報含むファイルへのアクセス権限) のため最重要。
  const a = await prisma.attachment.findFirst({
    where: { id, deletedAt: null, tenantId: viewerTenantId },
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
  tenantId: string,
): Promise<AttachmentDTO> {
  const slot = input.slot ?? 'general';

  // 2026-05-09 feedback Phase 2-5: data.tenantId 明示 + updateMany にも tenantId 併記。
  if (SINGLE_SLOTS.has(slot)) {
    await prisma.attachment.updateMany({
      where: {
        entityType: input.entityType,
        entityId: input.entityId,
        slot,
        deletedAt: null,
        tenantId,
      },
      data: { deletedAt: new Date() },
    });
  }

  const created = await prisma.attachment.create({
    data: {
      tenantId,
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
  viewerTenantId: string,
): Promise<AttachmentDTO> {
  // 2026-05-09 feedback Phase 2-5: 越境編集を遮断するため findFirst で先に所有確認。
  const owned = await prisma.attachment.findFirst({
    where: { id, deletedAt: null, tenantId: viewerTenantId },
    select: { id: true },
  });
  if (!owned) throw new Error('NOT_FOUND');

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
export async function deleteAttachment(
  id: string,
  viewerTenantId: string,
): Promise<void> {
  // 2026-05-09 feedback Phase 2-5: 越境削除を遮断するため updateMany で tenantId 検証。
  // ADR-0021 (2026-05-26): storageProvider='supabase' の場合は Supabase Storage 上の
  //   オブジェクトも cascade 削除 + storageFileBytesUsed を atomic に減算する。
  const existing = await prisma.attachment.findFirst({
    where: { id, deletedAt: null, tenantId: viewerTenantId },
    select: { id: true, storageProvider: true, storageObjectKey: true, sizeBytes: true },
  });
  if (!existing) {
    // 越境 / 既削除 → no-op (= updateMany 0 件と同等)
    return;
  }

  // Supabase Storage 上のオブジェクトを先に削除 (DB rollback でも残らないよう順序固定)
  // 失敗時は recordError で記録し DB 側 soft delete は継続 (= cron で daily 集計が補正)
  if (existing.storageProvider === 'supabase' && existing.storageObjectKey) {
    try {
      const { deleteObject } = await import('@/lib/supabase-storage');
      await deleteObject(existing.storageObjectKey);
    } catch (e) {
      try {
        const { recordError } = await import('@/services/error-log.service');
        await recordError({
          severity: 'warn',
          source: 'server',
          message: '[attachment.delete] Supabase Storage cascade delete 失敗、daily cron で補正',
          stack: e instanceof Error ? e.stack : undefined,
          context: {
            kind: 'attachment_cascade_delete_failed',
            attachmentId: id,
            tenantId: viewerTenantId,
            storageObjectKey: existing.storageObjectKey,
            error: e instanceof Error ? e.message : String(e),
          },
        });
      } catch {
        // ignore
      }
    }
  }

  // DB: soft delete + storageFileBytesUsed の atomic 減算
  await prisma.$transaction(async (tx) => {
    await tx.attachment.updateMany({
      where: { id, tenantId: viewerTenantId, deletedAt: null },
      data: { deletedAt: new Date() },
    });

    if (existing.storageProvider === 'supabase' && existing.sizeBytes) {
      const { assertFileStorageLimitInTx } = await import('@/services/storage-guard.service');
      // 負値で減算 (使用量を下げる方向)、peak は MAX で巻戻らない設計
      await assertFileStorageLimitInTx(tx, viewerTenantId, -Number(existing.sizeBytes));
    }
  });

  // ADR-0025 (2026-05-29): Beginner プラン超過状態からの DELETE で容量キャッシュを即時更新。
  //   attachment は File Storage の主たる消費源 (画像 / PDF 等)。transaction 後に呼ぶ。
  const { maybeRecalcAfterBeginnerDelete } = await import('@/services/tenant-storage.service');
  await maybeRecalcAfterBeginnerDelete(viewerTenantId);
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
  viewerTenantId: string,
): Promise<{ visibility: 'public' | 'draft'; creatorId: string } | null | 'not-found'> {
  // 2026-05-09 feedback Phase 2-5: 全 entity 検索に tenantId フィルタ必須化。
  switch (entityType) {
    case 'risk': {
      const r = await prisma.riskIssue.findFirst({
        where: { id: entityId, deletedAt: null, tenantId: viewerTenantId },
        select: { visibility: true, reporterId: true },
      });
      if (!r) return 'not-found';
      return { visibility: r.visibility as 'public' | 'draft', creatorId: r.reporterId };
    }
    case 'retrospective': {
      const retro = await prisma.retrospective.findFirst({
        where: { id: entityId, deletedAt: null, tenantId: viewerTenantId },
        select: { visibility: true, createdBy: true },
      });
      if (!retro) return 'not-found';
      return { visibility: retro.visibility as 'public' | 'draft', creatorId: retro.createdBy };
    }
    case 'knowledge': {
      const k = await prisma.knowledge.findFirst({
        where: { id: entityId, deletedAt: null, tenantId: viewerTenantId },
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
  viewerTenantId: string,
): Promise<string[] | null> {
  // 2026-05-09 feedback Phase 2-5: 全 entity 検索に tenantId フィルタ必須化。
  switch (entityType) {
    case 'project': {
      const p = await prisma.project.findFirst({
        where: { id: entityId, deletedAt: null, tenantId: viewerTenantId },
        select: { id: true },
      });
      return p ? [p.id] : null;
    }
    case 'task': {
      // task は tenantId 列なし、project 経由でフィルタ
      const t = await prisma.task.findFirst({
        where: { id: entityId, deletedAt: null, project: { tenantId: viewerTenantId } },
        select: { projectId: true },
      });
      return t ? [t.projectId] : null;
    }
    case 'estimate': {
      // estimate は tenantId 列なし、project 経由でフィルタ
      const e = await prisma.estimate.findFirst({
        where: { id: entityId, deletedAt: null, project: { tenantId: viewerTenantId } },
        select: { projectId: true },
      });
      return e ? [e.projectId] : null;
    }
    case 'risk': {
      const r = await prisma.riskIssue.findFirst({
        where: { id: entityId, deletedAt: null, tenantId: viewerTenantId },
        select: { id: true, riskIssueProjects: { select: { projectId: true } } },
      });
      if (!r) return null;
      return r.riskIssueProjects.map((rp) => rp.projectId);
    }
    case 'retrospective': {
      const retro = await prisma.retrospective.findFirst({
        where: { id: entityId, deletedAt: null, tenantId: viewerTenantId },
        select: { id: true, retrospectiveProjects: { select: { projectId: true } } },
      });
      if (!retro) return null;
      return retro.retrospectiveProjects.map((rp) => rp.projectId);
    }
    case 'knowledge': {
      const k = await prisma.knowledge.findFirst({
        where: { id: entityId, deletedAt: null, tenantId: viewerTenantId },
        select: {
          id: true,
          knowledgeProjects: { select: { projectId: true } },
        },
      });
      if (!k) return null;
      return k.knowledgeProjects.map((kp) => kp.projectId);
    }
    case 'memo': {
      const m = await prisma.memo.findFirst({
        where: { id: entityId, deletedAt: null, tenantId: viewerTenantId },
        select: { id: true },
      });
      return m ? [] : null;
    }
    default:
      return null;
  }
}

/**
 * 添付の作成/読取認可を統合判定する (ADR-0021 / 2026-05-26)。
 *
 *   - project / task / estimate: project member 必須 (admin 短絡)
 *   - risk / retrospective / knowledge:
 *       read on visibility='public' は認証済全員可、それ以外は project member
 *   - memo: 作成者本人のみ (admin 特権なし)
 *
 * 既存の /api/attachments/route.ts に inline されていた authorize() を再利用可能に抽出。
 * 戻り値は { ok, status, code } の素朴な構造体 (NextResponse は呼出側で組み立て)。
 */
export async function authorizeForAttachmentEntity(args: {
  user: { id: string; systemRole: string; tenantId: string };
  entityType: AttachmentEntityType;
  entityId: string;
  mode: 'read' | 'write';
}): Promise<
  | { ok: true }
  | { ok: false; status: 403 | 404; code: 'FORBIDDEN' | 'NOT_FOUND' }
> {
  const { user, entityType, entityId, mode } = args;

  if (entityType === 'memo') {
    const r = await authorizeMemoAttachment(entityId, user.id, mode, user.tenantId);
    if (r.notFound) return { ok: false, status: 404, code: 'NOT_FOUND' };
    if (!r.ok) return { ok: false, status: 403, code: 'FORBIDDEN' };
    return { ok: true };
  }

  if (isAdminOrAbove(user)) return { ok: true };

  if (mode === 'read') {
    const visInfo = await getEntityVisibility(entityType, entityId, user.tenantId);
    if (visInfo === 'not-found') return { ok: false, status: 404, code: 'NOT_FOUND' };
    if (visInfo !== null) {
      if (visInfo.visibility === 'public') return { ok: true };
      if (visInfo.creatorId === user.id) return { ok: true };
      return { ok: false, status: 403, code: 'FORBIDDEN' };
    }
  }

  const projectIds = await resolveProjectIds(entityType, entityId, user.tenantId);
  if (projectIds === null) return { ok: false, status: 404, code: 'NOT_FOUND' };
  if (projectIds.length === 0) return { ok: false, status: 403, code: 'FORBIDDEN' };

  for (const pid of projectIds) {
    const membership = await checkMembership(pid, user.id, user.systemRole, user.tenantId);
    if (membership.isMember) return { ok: true };
  }
  return { ok: false, status: 403, code: 'FORBIDDEN' };
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
  viewerTenantId: string,
): Promise<{ ok: boolean; notFound: boolean }> {
  // 2026-05-09 feedback Phase 2-5: 越境取得を遮断するため tenantId 必須化。
  const memo = await prisma.memo.findFirst({
    where: { id: memoId, deletedAt: null, tenantId: viewerTenantId },
    select: { userId: true, visibility: true },
  });
  if (!memo) return { ok: false, notFound: true };
  if (mode === 'write') {
    return { ok: memo.userId === viewerUserId, notFound: false };
  }
  return { ok: memo.userId === viewerUserId || memo.visibility === 'public', notFound: false };
}
