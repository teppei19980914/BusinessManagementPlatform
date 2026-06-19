/**
 * POST /api/promotions/risk-to-issue - リスク → 課題 昇華 (v1.3.0 資産導線機能)
 *
 * 役割:
 *   公開済みリスクが顕在化したとき、その内容を転記して新規課題を作成し、
 *   risk_issue_promotions に昇華記録を追加する。新規課題の作成先プロジェクト
 *   (projectId) は呼出元 (リスク詳細ダイアログ) が指定する。
 *
 * 認可: createRisk と同じ「実プロジェクトメンバー + risk:create」を要求する
 *   (昇華先課題の作成は通常の課題起票と同じ権限境界)。
 * 監査: audit_logs (action=CREATE, entityType=risk_issue) を記録 (通常作成と同形)。
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  getAuthenticatedUser,
  checkProjectPermission,
  requireActualProjectMember,
  requireStorageQuotaForWrite,
} from '@/lib/api-helpers';
import { promoteRiskToIssueSchema } from '@/lib/validators/promotion';
import { promoteRiskToIssue } from '@/services/promotion.service';
import { recordAuditLog, sanitizeForAudit } from '@/services/audit.service';

export async function POST(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const body = await req.json();
  const parsed = promoteRiskToIssueSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }
  const { riskId, projectId, input } = parsed.data;

  const memberOnly = await requireActualProjectMember(user, projectId);
  if (memberOnly) return memberOnly;
  const forbidden = await checkProjectPermission(user, projectId, 'risk:create');
  if (forbidden) return forbidden;

  const quotaErr = await requireStorageQuotaForWrite(
    user.tenantId,
    Buffer.byteLength(JSON.stringify(input), 'utf8'),
  );
  if (quotaErr) return quotaErr;

  let issue;
  try {
    issue = await promoteRiskToIssue(riskId, projectId, input, user.id, user.tenantId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'NOT_FOUND') {
      return NextResponse.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
    }
    if (msg === 'INVALID_SOURCE_TYPE') {
      return NextResponse.json(
        { error: { code: 'INVALID_SOURCE_TYPE', message: '指定された資産はリスクではありません' } },
        { status: 400 },
      );
    }
    if (msg === 'SOURCE_NOT_PUBLIC') {
      return NextResponse.json(
        {
          error: {
            code: 'SOURCE_NOT_PUBLIC',
            message: '公開済みのリスクのみ課題として昇華できます',
          },
        },
        { status: 400 },
      );
    }
    if (msg === 'ASSIGNEE_TENANT_MISMATCH') {
      return NextResponse.json(
        {
          error: {
            code: 'ASSIGNEE_TENANT_MISMATCH',
            message: '指定された担当者は同じテナントのメンバーではありません',
          },
        },
        { status: 400 },
      );
    }
    throw e;
  }

  await recordAuditLog({
    tenantId: user.tenantId,
    userId: user.id,
    action: 'CREATE',
    entityType: 'risk_issue',
    entityId: issue.id,
    afterValue: sanitizeForAudit(issue as unknown as Record<string, unknown>),
  });

  return NextResponse.json({ data: issue }, { status: 201 });
}
