/**
 * POST /api/promotions/issue-to-knowledge - 課題 → ナレッジ 昇華 (v1.3.0 資産導線機能)
 *
 * 役割:
 *   公開済み課題が解消したとき、その内容を転記して新規ナレッジを作成し、
 *   issue_knowledge_promotions に昇華記録を追加する。
 *
 * 認可: createKnowledge (POST /api/knowledge) と同じ規約。
 *   ナレッジ作成自体はプロジェクト不問で認証済みユーザなら可能、
 *   input.projectIds で紐付け先を指定した場合のみ各プロジェクトの実メンバーであることを要求する。
 * 監査: audit_logs (action=CREATE, entityType=knowledge) を記録 (通常作成と同形)。
 */

import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { getAuthenticatedUser, requireStorageQuotaForWrite } from '@/lib/api-helpers';
import { prisma } from '@/lib/db';
import { promoteIssueToKnowledgeSchema } from '@/lib/validators/promotion';
import { promoteIssueToKnowledge } from '@/services/promotion.service';
import { recordAuditLog, sanitizeForAudit } from '@/services/audit.service';

export async function POST(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const body = await req.json();
  const parsed = promoteIssueToKnowledgeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }
  const { issueId, input } = parsed.data;

  const projectIds = input.projectIds ?? [];
  if (projectIds.length > 0) {
    const memberships = await prisma.projectMember.findMany({
      where: {
        userId: user.id,
        projectId: { in: projectIds },
        project: { tenantId: user.tenantId },
      },
      select: { projectId: true },
    });
    const memberSet = new Set(memberships.map((m) => m.projectId));
    const nonMemberIds = projectIds.filter((pid) => !memberSet.has(pid));
    if (nonMemberIds.length > 0) {
      const t = await getTranslations('message');
      return NextResponse.json(
        { error: { code: 'FORBIDDEN', message: t('notProjectMemberKnowledge') } },
        { status: 403 },
      );
    }
  }

  const quotaErr = await requireStorageQuotaForWrite(
    user.tenantId,
    Buffer.byteLength(JSON.stringify(input), 'utf8'),
  );
  if (quotaErr) return quotaErr;

  let knowledge;
  try {
    knowledge = await promoteIssueToKnowledge(issueId, input, user.id, user.tenantId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'NOT_FOUND') {
      return NextResponse.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
    }
    if (msg === 'INVALID_SOURCE_TYPE') {
      return NextResponse.json(
        { error: { code: 'INVALID_SOURCE_TYPE', message: '指定された資産は課題ではありません' } },
        { status: 400 },
      );
    }
    if (msg === 'SOURCE_NOT_PUBLIC') {
      return NextResponse.json(
        {
          error: {
            code: 'SOURCE_NOT_PUBLIC',
            message: '公開済みの課題のみナレッジとして昇華できます',
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
    entityType: 'knowledge',
    entityId: knowledge.id,
    afterValue: sanitizeForAudit(knowledge as unknown as Record<string, unknown>),
  });

  return NextResponse.json({ data: knowledge }, { status: 201 });
}
