import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { prisma } from '@/lib/db';
import { ATTACHMENT_ENTITY_TYPES } from '@/lib/validators/attachment';
import type { AttachmentEntityType } from '@/lib/validators/attachment';
import type { AttachmentDTO } from '@/services/attachment.service';
import { recordError } from '@/services/error-log.service';

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
 * 緩和ルール (2026-05-01 fix/attachments-batch-400):
 *   旧版では entityIds に **1 つでも非 UUID** が混じると `400 VALIDATION_ERROR` で
 *   バッチ全体を破棄していた。一覧画面では添付列が表示できないだけでなく、
 *   ユーザに具体的な原因が見えない 400 エラーが Vercel log に出続ける状態になっていた。
 *   バッチ取得は「ベストエフォート」セマンティクスが妥当なため、無効 ID は静かに
 *   フィルタして有効 ID のみ処理 + 200 返却する設計に変更。validation 失敗時は
 *   **`recordError(system_error_logs)` で実フィールドを記録** (no-console ルール準拠)
 *   して将来のデバッグを容易にする。
 *
 * レスポンス: Map 形式 ({ [entityId]: AttachmentDTO[] }) で返し、UI 側の
 * lookup を O(1) にする。無効 ID 分のキーは含まれない (空 Map と同じ扱い)。
 */

// entityType / slot は厳格に validate (これらは UI 側で固定値、ミスマッチは即時エラーで OK)。
// entityIds は緩和扱い: 配列以外なら空配列扱い、配列内の非 UUID は filter で除外。
const headerSchema = z.object({
  entityType: z.enum(ATTACHMENT_ENTITY_TYPES),
  slot: z.string().max(30).optional(),
});

// UUID v1-v8 の RFC 4122 準拠正規表現 (zod v4 z.string().uuid() と同等)。
//   8-4-4-4-12 hex、3rd group の先頭 1 桁が version (1-8)、4th group の先頭 1 桁が variant (8/9/a/b)
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

export async function POST(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const body = await req.json().catch(() => ({}));
  const headerParsed = headerSchema.safeParse(body);
  if (!headerParsed.success) {
    // entityType / slot のような UI 固定フィールドが想定外 = 開発側のバグ。
    // 詳細を system_error_logs に記録 (entityIds 配列の中身は伏せる、容量肥大化防止)。
    void recordError({
      severity: 'warn',
      source: 'server',
      message: '[attachments/batch] header validation failed',
      userId: user.id,
      context: {
        entityType: typeof body.entityType === 'string' ? body.entityType : `(${typeof body.entityType})`,
        slot: typeof body.slot === 'string' ? body.slot : '(absent)',
        entityIdsCount: Array.isArray(body.entityIds) ? body.entityIds.length : 0,
        issues: headerParsed.error.issues,
      },
    });
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: headerParsed.error.issues } },
      { status: 400 },
    );
  }
  const { entityType, slot } = headerParsed.data;

  // entityIds: lenient — 配列以外 → 空、UUID でない要素 → filter (黙って除外)
  const rawIds = Array.isArray(body.entityIds) ? (body.entityIds as unknown[]) : [];
  const entityIds = rawIds
    .filter((id): id is string => typeof id === 'string' && UUID_RE.test(id))
    .slice(0, 500);
  if (rawIds.length !== entityIds.length) {
    // フィルタが発動した = 呼出側が想定外の ID を含めて送ってきたシグナル。
    // info レベルで system_error_logs に記録 (頻発する場合は呼出側を修正する)。
    void recordError({
      severity: 'info',
      source: 'server',
      message: `[attachments/batch] filtered ${rawIds.length - entityIds.length}/${rawIds.length} invalid entityIds`,
      userId: user.id,
      context: { entityType, validCount: entityIds.length, rejectedCount: rawIds.length - entityIds.length },
    });
  }
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
