import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import { linkKnowledgeToProject } from '@/services/suggestion.service';
import { linkRiskToProject } from '@/services/risk.service';
import { linkRetrospectiveToProject } from '@/services/retrospective.service';
import { recordAuditLog } from '@/services/audit.service';

/**
 * POST /api/projects/:projectId/suggestions/adopt
 *
 * 提案リストから項目を「このプロジェクトに採用」する。
 *
 * 採用 = **M:N 中間テーブルへの紐付け追加** (Phase 2 / PR feat/asset-multi-linking-ui):
 *   - kind='knowledge': KnowledgeProject に追加 (旧来通り)
 *   - kind='issue':     RiskIssueProject に追加 (旧来は雛形複製していたが、PR feat/asset-multi-project-linking
 *                       で M:N に統一したため複製ではなく紐付けに変更)
 *   - kind='risk':      同上 (新規対応)
 *   - kind='retrospective': RetrospectiveProject に追加 (新規対応)
 *
 * idempotent: 既に紐付け済の場合は 200 で何もしない (二重採用クリックや戻る/再採用に強い)。
 *
 * 認可:
 *   - 採用先 (= params.projectId) のメンバー (member/pm_tl/admin) であること。viewer 不可。
 *   - knowledge は project:update (PM/TL+) を維持 (旧仕様踏襲、ナレッジは公開判断を伴うため)。
 *   - risk/issue/retrospective は risk:update (member-level) で許可 (ユーザ要件: 「対象プロジェクト
 *     のメンバー全員」)。
 */
const adoptSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('knowledge'), id: z.string().uuid() }),
  z.object({ kind: z.literal('issue'), id: z.string().uuid() }),
  z.object({ kind: z.literal('risk'), id: z.string().uuid() }),
  z.object({ kind: z.literal('retrospective'), id: z.string().uuid() }),
]);

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId } = await params;

  const body = await req.json();
  const parsed = adoptSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }

  // kind に応じて要求権限を切り替え
  const requiredPermission =
    parsed.data.kind === 'knowledge' ? 'project:update' : 'risk:update';
  const forbidden = await checkProjectPermission(user, projectId, requiredPermission);
  if (forbidden) return forbidden;

  try {
    if (parsed.data.kind === 'knowledge') {
      await linkKnowledgeToProject(parsed.data.id, projectId, user.tenantId);
      await recordAuditLog({
        tenantId: user.tenantId,
        userId: user.id,
        action: 'CREATE',
        entityType: 'knowledge_project',
        entityId: parsed.data.id,
      });
      return NextResponse.json({ data: { success: true } }, { status: 201 });
    }

    if (parsed.data.kind === 'issue' || parsed.data.kind === 'risk') {
      const result = await linkRiskToProject(parsed.data.id, projectId);
      if (result.added) {
        await recordAuditLog({
          tenantId: user.tenantId,
          userId: user.id,
          action: 'CREATE',
          entityType: 'risk_issue_project',
          entityId: parsed.data.id,
          afterValue: { riskIssueId: parsed.data.id, projectId },
        });
      }
      return NextResponse.json({ data: result }, { status: result.added ? 201 : 200 });
    }

    // retrospective
    const result = await linkRetrospectiveToProject(parsed.data.id, projectId);
    if (result.added) {
      await recordAuditLog({
        tenantId: user.tenantId,
        userId: user.id,
        action: 'CREATE',
        entityType: 'retrospective_project',
        entityId: parsed.data.id,
        afterValue: { retrospectiveId: parsed.data.id, projectId },
      });
    }
    return NextResponse.json({ data: result }, { status: result.added ? 201 : 200 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'NOT_FOUND') {
      return NextResponse.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
    }
    if (msg === 'PROJECT_NOT_FOUND') {
      return NextResponse.json({ error: { code: 'PROJECT_NOT_FOUND' } }, { status: 404 });
    }
    if (msg === 'TENANT_MISMATCH') {
      return NextResponse.json({ error: { code: 'TENANT_MISMATCH' } }, { status: 403 });
    }
    throw e;
  }
}
