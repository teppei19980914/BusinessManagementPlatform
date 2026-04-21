/**
 * GET  /api/projects/[projectId]/estimates - 見積もり明細一覧取得
 * POST /api/projects/[projectId]/estimates - 見積もり明細追加
 *
 * 役割:
 *   プロジェクト見積もりタブのデータソース。1 行 = 1 作業項目で複数行の合計が
 *   プロジェクト全体の見積工数になる構造。
 *
 * 認可: checkProjectPermission ('estimate:read' / 'estimate:create')
 * 監査: POST 時に audit_logs (action=CREATE, entityType=estimate) を記録。
 *
 * 関連: DESIGN.md §5 (テーブル定義: estimates) / §8 (権限制御)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import { createEstimateSchema } from '@/lib/validators/estimate';
import { listEstimates, createEstimate } from '@/services/estimate.service';
import { recordAuditLog, sanitizeForAudit } from '@/services/audit.service';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId } = await params;
  const forbidden = await checkProjectPermission(user, projectId, 'project:read');
  if (forbidden) return forbidden;

  const estimates = await listEstimates(projectId);
  return NextResponse.json({ data: estimates });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId } = await params;
  const forbidden = await checkProjectPermission(user, projectId, 'project:update');
  if (forbidden) return forbidden;

  const body = await req.json();
  const parsed = createEstimateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }

  const estimate = await createEstimate(projectId, parsed.data, user.id);

  await recordAuditLog({
    userId: user.id,
    action: 'CREATE',
    entityType: 'estimate',
    entityId: estimate.id,
    afterValue: sanitizeForAudit(estimate as unknown as Record<string, unknown>),
  });

  return NextResponse.json({ data: estimate }, { status: 201 });
}
