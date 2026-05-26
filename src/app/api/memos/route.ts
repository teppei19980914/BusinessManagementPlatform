import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, requireStorageQuotaForWrite } from '@/lib/api-helpers';
import { createMemoSchema } from '@/lib/validators/memo';
import { createMemo, listMyMemos, listPublicMemos } from '@/services/memo.service';
import { recordAuditLog } from '@/services/audit.service';

/**
 * GET /api/memos?scope=mine|public (PR #71 で分割)
 *   - scope=mine (既定): 自分のメモのみ (private/public 両方)
 *   - scope=public      : 全公開メモ (自分の公開メモ含む、他人のメモは public のみ)
 */
export async function GET(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const scope = new URL(req.url).searchParams.get('scope') === 'public' ? 'public' : 'mine';
  const data = scope === 'public'
    ? await listPublicMemos(user.id, user.tenantId)
    : await listMyMemos(user.id, user.tenantId);
  return NextResponse.json({ data });
}

/**
 * POST /api/memos
 * 自分のメモを新規作成。
 */
export async function POST(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const body = await req.json().catch(() => ({}));
  const parsed = createMemoSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }

  // PR-5 (2026-05-15): ストレージ容量 Pre-check
  const quotaErr = await requireStorageQuotaForWrite(
    user.tenantId,
    JSON.stringify(parsed.data).length,
  );
  if (quotaErr) return quotaErr;

  let created;
  try {
    created = await createMemo(parsed.data, user.id, user.tenantId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // feat/asset-assignee-expansion (2026-05-26) severity-1:
    //   private memo に他人 assignee 指定の拒否。UI は selector 非表示で防御するが、
    //   API 直叩きを service 層で reject し、route で 400 にマップする。
    if (msg === 'PRIVATE_MEMO_ASSIGNEE_FORBIDDEN') {
      return NextResponse.json(
        {
          error: {
            code: 'PRIVATE_MEMO_ASSIGNEE_FORBIDDEN',
            message: '「自分のみ」のメモには他人を担当者に指定できません',
          },
        },
        { status: 400 },
      );
    }
    // feat/asset-assignee-expansion (2026-05-26) severity-1 越境防御
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
    entityType: 'memo',
    entityId: created.id,
  });
  return NextResponse.json({ data: created }, { status: 201 });
}
