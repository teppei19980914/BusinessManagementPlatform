import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
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
    ? await listPublicMemos(user.id)
    : await listMyMemos(user.id);
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

  const created = await createMemo(parsed.data, user.id);
  await recordAuditLog({
    userId: user.id,
    action: 'CREATE',
    entityType: 'memo',
    entityId: created.id,
  });
  return NextResponse.json({ data: created }, { status: 201 });
}
