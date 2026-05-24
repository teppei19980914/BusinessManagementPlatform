import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import { bulkUpdateRetrospectivesVisibilityFromList } from '@/services/retrospective.service';
import { bulkUpdateRetrospectiveVisibilitySchema } from '@/lib/validators/cross-list-bulk-visibility';
import { recordAuditLog } from '@/services/audit.service';

/**
 * プロジェクト「振り返り一覧」からの一括 visibility 更新エンドポイント (PR #165 で
 * cross-list `/api/retrospectives/bulk` から project-scoped に移し替え、元実装は PR #162)。
 *
 * 認可:
 *   - **`retrospective:update` 権限が必要** (= プロジェクトメンバーかつ管理者/PM/TL/メンバー)。
 *   - per-row 作成者一致判定はサービス層で実施 (admin であっても他人の振り返りは更新不可)。
 *
 * 安全策 (Phase C 要件 18): フィルター必須は撤廃。ids 上限 500 + per-row 作成者判定 +
 * projectId scope (他プロジェクト行は skippedNotFound) で多層防御。
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId } = await params;

  // Retrospective は専用の retrospective:update Action が無く、project:update を流用 (PATCH/POST 既存方針と同じ)
  const forbidden = await checkProjectPermission(user, projectId, 'project:update');
  if (forbidden) return forbidden;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = bulkUpdateRetrospectiveVisibilitySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'VALIDATION_ERROR', details: parsed.error.format() },
      { status: 400 },
    );
  }

  const result = await bulkUpdateRetrospectivesVisibilityFromList(
    projectId,
    parsed.data.ids,
    parsed.data.visibility,
    user.id,
    user.tenantId,
  );

  // feat/crud-permission-redesign (2026-05-20, 2 巡目検証 S1-A1): ADR-0011 全 mutation 記録に従う。
  if (result.updatedIds.length > 0) {
    await recordAuditLog({
      tenantId: user.tenantId,
      userId: user.id,
      action: 'BULK_UPDATE',
      entityType: 'retrospective',
      entityId: projectId,
      afterValue: {
        projectId,
        visibility: parsed.data.visibility,
        updatedIds: result.updatedIds,
        skippedNotOwned: result.skippedNotOwned,
        skippedNotFound: result.skippedNotFound,
        // UI_PATTERNS §35.4.1 (2026-05-24): draft→public 遷移行を batch 集約で embedding 生成した件数。
        //   Voyage API cost center のアトリビューション + 月次請求額追跡のため audit に残す。
        embeddingsGenerated: result.embeddingsGenerated,
      },
    });
  }

  return NextResponse.json({ data: result });
}
