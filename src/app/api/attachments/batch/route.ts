import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { prisma } from '@/lib/db';
import { ATTACHMENT_ENTITY_TYPES } from '@/lib/validators/attachment';
import type { AttachmentEntityType } from '@/lib/validators/attachment';
import type { AttachmentDTO } from '@/services/attachment.service';

/**
 * POST /api/attachments/batch
 *
 * 一覧画面で各行の添付リンクを列として表示するために使うバッチ取得 API (PR #67)。
 * 個別に `/api/attachments?entityType=&entityId=` を N 回叩くと N+1 になるため、
 * エンティティ ID の配列を受けて一括で取り出す。
 *
 * 認可方針 (PR #115 / 2026-04-24 改修):
 *   - 旧「Phase 1: ログインユーザなら全件返す」方針は、URL を推測すれば他プロジェクトの
 *     添付 URL 一覧を取得できる IDOR 経路になっていた。2 巡目監査 C-1 で検出。
 *   - 全 entityType について **アクセス権を個別確認** してから attachment を返す:
 *       - memo : 自分の memo or visibility='public'
 *       - 他 6 種 (project/task/estimate/risk/retrospective/knowledge):
 *           親エンティティの projectId を解決 → 自分がメンバーのプロジェクトのものだけ通す。
 *           admin は全プロジェクトを通過 (checkMembership と同じ短絡)。
 *
 * レスポンス: Map 形式 ({ [entityId]: AttachmentDTO[] }) で返し、UI 側の
 * lookup を O(1) にする。
 */

const bodySchema = z.object({
  entityType: z.enum(ATTACHMENT_ENTITY_TYPES),
  entityIds: z.array(z.string().uuid()).max(500), // 1 リクエストの上限
  slot: z.string().max(30).optional(),
});

export async function POST(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const body = await req.json().catch(() => ({}));
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }
  const { entityType, entityIds, slot } = parsed.data;
  if (entityIds.length === 0) {
    return NextResponse.json({ data: {} });
  }

  // PR #115 (2026-04-24 2 巡目監査 C-1): 全 entityType について閲覧可能性を確認してから
  // attachment を返す。旧実装では memo 以外「一覧クエリで除外済み前提」としていたが、
  // 攻撃者が UUID を推測して他プロジェクトの添付 URL を取得できる IDOR 経路だった。
  const isAdmin = user.systemRole === 'admin';
  let filteredIds: string[];

  if (entityType === 'memo') {
    const accessibleMemos = await prisma.memo.findMany({
      where: {
        id: { in: entityIds },
        deletedAt: null,
        OR: [{ userId: user.id }, { visibility: 'public' }],
      },
      select: { id: true },
    });
    filteredIds = accessibleMemos.map((m) => m.id);
  } else if (isAdmin) {
    // admin は全プロジェクトにアクセス可能なので絞り込み不要
    filteredIds = entityIds;
  } else {
    // 自分がメンバーのプロジェクト ID 集合を先に取得
    const memberships = await prisma.projectMember.findMany({
      where: { userId: user.id },
      select: { projectId: true },
    });
    const memberProjectIds = new Set(memberships.map((m) => m.projectId));

    // entityType ごとに親 projectId を引き、member のものだけ通す
    let rows: Array<{ id: string; projectId: string }> = [];
    if (entityType === 'project') {
      // project の添付は project 自体が親なので entityId === projectId
      rows = entityIds.map((id) => ({ id, projectId: id }));
    } else if (entityType === 'task') {
      rows = await prisma.task.findMany({
        where: { id: { in: entityIds } },
        select: { id: true, projectId: true },
      });
    } else if (entityType === 'estimate') {
      rows = await prisma.estimate.findMany({
        where: { id: { in: entityIds } },
        select: { id: true, projectId: true },
      });
    } else if (entityType === 'risk') {
      // fix/cross-list-non-member-columns (2026-04-27): visibility='public' のリスク/課題は
      // 横断「全リスク/全課題」で公開されているため、非メンバーでも添付閲覧を許可する
      // (添付は entity の付随情報であり、行が公開なら添付も公開する設計)。
      const all = await prisma.riskIssue.findMany({
        where: { id: { in: entityIds } },
        select: { id: true, projectId: true, visibility: true },
      });
      rows = all
        .filter((x) => x.visibility === 'public' || memberProjectIds.has(x.projectId))
        // 後段の memberProjectIds.has(...) フィルタを通すため、public なものは
        // 「常に通す」projectId に置き換え (下のフィルタで通過するように)
        .map((x) => ({
          id: x.id,
          // public なら「メンバーである」ことに見せかけて通過させる (ダミー値で OK、
          // 後段は projectId から二重チェックしない)
          projectId: x.visibility === 'public' ? '__public__' : x.projectId,
        }));
      // public ダミー projectId を memberProjectIds 集合に追加 (一度限り)
      memberProjectIds.add('__public__');
    } else if (entityType === 'retrospective') {
      const all = await prisma.retrospective.findMany({
        where: { id: { in: entityIds } },
        select: { id: true, projectId: true, visibility: true },
      });
      rows = all
        .filter((x) => x.visibility === 'public' || memberProjectIds.has(x.projectId))
        .map((x) => ({
          id: x.id,
          projectId: x.visibility === 'public' ? '__public__' : x.projectId,
        }));
      memberProjectIds.add('__public__');
    } else if (entityType === 'knowledge') {
      // knowledge は N:M なので、いずれか 1 つでもメンバーのプロジェクトに紐付いていれば OK
      const links = await prisma.knowledgeProject.findMany({
        where: { knowledgeId: { in: entityIds } },
        select: { knowledgeId: true, projectId: true },
      });
      const accessibleKnowledgeIds = new Set<string>();
      for (const link of links) {
        if (memberProjectIds.has(link.projectId)) {
          accessibleKnowledgeIds.add(link.knowledgeId);
        }
      }
      // さらに「プロジェクト紐付けゼロで visibility=public」なナレッジは全ログインユーザが見える
      const publicOrphanKnowledges = await prisma.knowledge.findMany({
        where: {
          id: { in: entityIds },
          visibility: 'public',
          knowledgeProjects: { none: {} },
        },
        select: { id: true },
      });
      for (const k of publicOrphanKnowledges) accessibleKnowledgeIds.add(k.id);
      filteredIds = Array.from(accessibleKnowledgeIds);
      // skip 下の rows-based フィルタ
      if (filteredIds.length === 0) {
        return NextResponse.json({ data: {} });
      }
      // knowledge は早期 return で返す
      const rowsK = await prisma.attachment.findMany({
        where: {
          entityType,
          entityId: { in: filteredIds },
          slot: slot ?? undefined,
          deletedAt: null,
        },
        include: { addedByUser: { select: { name: true } } },
        orderBy: [{ slot: 'asc' }, { createdAt: 'asc' }],
      });
      const byEntityK: Record<string, AttachmentDTO[]> = {};
      for (const r of rowsK) {
        const dto: AttachmentDTO = {
          id: r.id,
          entityType: r.entityType,
          entityId: r.entityId,
          slot: r.slot,
          displayName: r.displayName,
          url: r.url,
          mimeHint: r.mimeHint,
          addedBy: r.addedBy,
          addedByName: r.addedByUser?.name ?? null,
          createdAt: r.createdAt.toISOString(),
          updatedAt: r.updatedAt.toISOString(),
        };
        if (!byEntityK[r.entityId]) byEntityK[r.entityId] = [];
        byEntityK[r.entityId].push(dto);
      }
      return NextResponse.json({ data: byEntityK });
    } else {
      // 未知の entityType (Zod で弾かれる想定だが保険)
      filteredIds = [];
      return NextResponse.json({ data: {} });
    }

    filteredIds = rows
      .filter((r) => memberProjectIds.has(r.projectId))
      .map((r) => r.id);
  }

  if (filteredIds.length === 0) {
    return NextResponse.json({ data: {} });
  }

  const rows = await prisma.attachment.findMany({
    where: {
      entityType,
      entityId: { in: filteredIds },
      slot: slot ?? undefined,
      deletedAt: null,
    },
    include: { addedByUser: { select: { name: true } } },
    orderBy: [{ slot: 'asc' }, { createdAt: 'asc' }],
  });

  // Entity ID をキーにグルーピング (O(1) lookup のため)
  const byEntity: Record<string, AttachmentDTO[]> = {};
  for (const r of rows) {
    const dto: AttachmentDTO = {
      id: r.id,
      entityType: r.entityType,
      entityId: r.entityId,
      slot: r.slot,
      displayName: r.displayName,
      url: r.url,
      mimeHint: r.mimeHint,
      addedBy: r.addedBy,
      addedByName: r.addedByUser?.name ?? null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
    if (!byEntity[r.entityId]) byEntity[r.entityId] = [];
    byEntity[r.entityId].push(dto);
  }

  // 変数名で lint エラーにならないよう entityType を使用
  void (entityType satisfies AttachmentEntityType);
  return NextResponse.json({ data: byEntity });
}
