/**
 * GET  /api/projects/[projectId]/risks - リスク/課題一覧取得 (type=risk|issue)
 * POST /api/projects/[projectId]/risks - リスクまたは課題の新規起票
 *
 * 役割:
 *   プロジェクト詳細画面のリスク/課題タブのデータソース。type 列で risk と issue を統合管理。
 *
 * 認可: checkProjectPermission ('risk:read' / 'risk:create')
 * 監査: POST 時に audit_logs (action=CREATE, entityType=risk_issue) を記録。
 *
 * 関連: DESIGN.md §5 (テーブル定義: risks_issues) / §8 (権限制御)
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  getAuthenticatedUser,
  checkProjectPermission,
  requireActualProjectMember,
} from '@/lib/api-helpers';
import { createRiskSchema } from '@/lib/validators/risk';
import { listRisks, createRisk } from '@/services/risk.service';
import { recordAuditLog, sanitizeForAudit } from '@/services/audit.service';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId } = await params;
  const forbidden = await checkProjectPermission(user, projectId, 'risk:read');
  if (forbidden) return forbidden;

  const risks = await listRisks(projectId, user.id, user.systemRole);
  return NextResponse.json({ data: risks });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId } = await params;
  // 2026-04-24: 作成は実際の ProjectMember のみ許可 (admin 短絡は使わない)。
  //             同時にメンバーシップ経由のプロジェクト状態/ロールチェックも残す。
  const memberOnly = await requireActualProjectMember(user, projectId);
  if (memberOnly) return memberOnly;
  const forbidden = await checkProjectPermission(user, projectId, 'risk:create');
  if (forbidden) return forbidden;

  const body = await req.json();
  const parsed = createRiskSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }

  const risk = await createRisk(projectId, parsed.data, user.id, user.tenantId);

  await recordAuditLog({
    userId: user.id,
    action: 'CREATE',
    entityType: 'risk_issue',
    entityId: risk.id,
    afterValue: sanitizeForAudit(risk as unknown as Record<string, unknown>),
  });

  return NextResponse.json({ data: risk }, { status: 201 });
}
