import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import { bulkUpdateRisksVisibilityFromList } from '@/services/risk.service';
import { bulkUpdateRiskVisibilitySchema } from '@/lib/validators/cross-list-bulk-visibility';
import { recordAuditLog } from '@/services/audit.service';

/**
 * プロジェクト「リスク/課題一覧」からの **一括 visibility 更新** エンドポイント。
 *
 * 履歴:
 *   - PR #161 (cross-list bulk update / state+assigneeId+deadline 複合 patch)
 *   - PR #165 cross-list → project-scoped に移し替え
 *   - UI_PATTERNS §35 (feat/all-list-section-unification, 2026-05-24):
 *     5 一覧画面の一括編集を visibility-only に統一。旧複合 patch は撤廃し
 *     bulkUpdateRiskVisibilitySchema + bulkUpdateRisksVisibilityFromList に置換。
 *
 * 認可:
 *   - **`risk:update` 権限が必要** (= プロジェクトメンバーかつ管理者/PM/TL/メンバー)。
 *     `checkProjectPermission` で resourceOwnerId なし呼び出しによりロール判定のみ。
 *   - per-row の reporter 一致判定はサービス層 (`bulkUpdateRisksVisibilityFromList`) で実施し、
 *     他人作成のレコードは silently skip する (admin であっても他人のリスクは更新不可)。
 *
 * 安全策:
 *   1. **visibility enum**: validator schema 側で 'draft' / 'public' のみ受理
 *   2. **ids 上限 500**: 1 リクエストで暴走しないよう絞る
 *   3. **projectId scope**: where 句に projectId を含めるため、ids に他プロジェクトの
 *      レコードが混ざってもサービス層で skippedNotFound 扱い (= 触れない)
 *   4. **per-row authorization**: reporter 一致しない行はサービス層で silently skip
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId } = await params;

  // 'risk:update' で「自分が起票したリスクは編集可」を満たす最低限のロール (member 含む) を要求。
  // per-row 判定はサービス層で行うため、ここでは resourceOwnerId を渡さず member 全員に通す。
  const forbidden = await checkProjectPermission(user, projectId, 'risk:update');
  if (forbidden) return forbidden;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = bulkUpdateRiskVisibilitySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'VALIDATION_ERROR', details: parsed.error.format() },
      { status: 400 },
    );
  }

  const result = await bulkUpdateRisksVisibilityFromList(
    projectId,
    parsed.data.ids,
    parsed.data.visibility,
    user.id,
    user.tenantId,
  );

  // feat/crud-permission-redesign (2026-05-20, 2 巡目検証 S1-A1): ADR-0011 全 mutation 記録に従い、
  //   bulk visibility 更新も audit_logs に記録。誰が何件公開化したかが追跡可能。
  if (result.updatedIds.length > 0) {
    await recordAuditLog({
      tenantId: user.tenantId,
      userId: user.id,
      action: 'BULK_UPDATE',
      entityType: 'risk',
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
