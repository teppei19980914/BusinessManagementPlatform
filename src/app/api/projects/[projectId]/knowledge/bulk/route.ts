import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import { bulkUpdateKnowledgeVisibilityFromList } from '@/services/knowledge.service';
import { bulkUpdateKnowledgeVisibilitySchema } from '@/lib/validators/cross-list-bulk-visibility';
import { recordAuditLog } from '@/services/audit.service';

/**
 * プロジェクト「ナレッジ一覧」からの一括 visibility 更新エンドポイント (PR #165 で
 * cross-list `/api/knowledge/bulk` から project-scoped に移し替え、元実装は PR #162)。
 *
 * 認可:
 *   - **`knowledge:update` 権限が必要** (= プロジェクトメンバーかつ管理者/PM/TL/メンバー)。
 *   - per-row 作成者一致判定はサービス層で実施 (admin であっても他人のナレッジは更新不可)。
 *   - Knowledge は多対多なのでサービス層 where に `knowledgeProjects: { some: { projectId } }`
 *     を加え、当該プロジェクトに紐付くナレッジのみを対象にする。
 *
 * 安全策 (Phase C 要件 18): フィルター必須は撤廃。ids 上限 500 + per-row 作成者判定で多層防御。
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId } = await params;

  const forbidden = await checkProjectPermission(user, projectId, 'knowledge:update');
  if (forbidden) return forbidden;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = bulkUpdateKnowledgeVisibilitySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'VALIDATION_ERROR', details: parsed.error.format() },
      { status: 400 },
    );
  }

  const result = await bulkUpdateKnowledgeVisibilityFromList(
    projectId,
    parsed.data.ids,
    parsed.data.visibility,
    user.id,
    user.tenantId,
  );

  // feat/crud-permission-redesign (2026-05-20, 2 巡目検証 S1-A1): ADR-0011 全 mutation 記録に従い、
  //   bulk visibility 更新も audit_logs に記録。旧実装は service 層で per-row 作成者判定 + silent skip
  //   していたが route 層から audit_logs を残さず、誰が何件公開化したかが追跡不能だった。
  if (result.updatedIds.length > 0) {
    await recordAuditLog({
      tenantId: user.tenantId,
      userId: user.id,
      action: 'BULK_UPDATE',
      entityType: 'knowledge',
      entityId: projectId,
      afterValue: {
        projectId,
        visibility: parsed.data.visibility,
        updatedIds: result.updatedIds,
        skippedNotOwned: result.skippedNotOwned,
        skippedNotFound: result.skippedNotFound,
      },
    });
  }

  return NextResponse.json({ data: result });
}
