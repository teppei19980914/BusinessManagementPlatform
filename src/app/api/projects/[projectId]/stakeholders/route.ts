/**
 * GET  /api/projects/[projectId]/stakeholders - ステークホルダー一覧取得
 * POST /api/projects/[projectId]/stakeholders - ステークホルダー新規登録
 *
 * 認可: stakeholder:read / stakeholder:create (admin / pm_tl のみ許可、§check-permission)
 *      個人情報・人物評を含むため member 以下には閲覧不可。
 * 監査: POST 時に audit_logs (entityType='stakeholder', action='CREATE')。
 *
 * 関連: DESIGN.md (テーブル定義: stakeholders / 認可)
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  getAuthenticatedUser,
  checkProjectPermission,
  requireActualProjectMember,
} from '@/lib/api-helpers';
import { createStakeholderSchema } from '@/lib/validators/stakeholder';
import { listStakeholders, createStakeholder } from '@/services/stakeholder.service';
import { recordAuditLog, sanitizeForAudit } from '@/services/audit.service';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId } = await params;
  const forbidden = await checkProjectPermission(user, projectId, 'stakeholder:read');
  if (forbidden) return forbidden;

  const stakeholders = await listStakeholders(projectId);
  return NextResponse.json({ data: stakeholders });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId } = await params;
  // 作成は実際の ProjectMember (PM/TL ロール) のみ許可。admin 短絡は使わない。
  // → admin がメンバーでないプロジェクトに勝手に登録できない設計に統一。
  const memberOnly = await requireActualProjectMember(user, projectId);
  // admin 例外: admin はそもそも全プロジェクトに対する管理権限を持つ前提で許可する。
  // requireActualProjectMember は admin でも非メンバーなら 403 を返すが、
  // ステークホルダー登録は admin にも認めたいので systemRole=='admin' は通過させる。
  if (memberOnly && user.systemRole !== 'admin') return memberOnly;

  const forbidden = await checkProjectPermission(user, projectId, 'stakeholder:create');
  if (forbidden) return forbidden;

  const body = await req.json();
  const parsed = createStakeholderSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }

  const stakeholder = await createStakeholder(projectId, parsed.data, user.id);

  await recordAuditLog({
    userId: user.id,
    action: 'CREATE',
    entityType: 'stakeholder',
    entityId: stakeholder.id,
    afterValue: sanitizeForAudit(stakeholder as unknown as Record<string, unknown>),
  });

  return NextResponse.json({ data: stakeholder }, { status: 201 });
}
