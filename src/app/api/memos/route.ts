import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { createMemoSchema } from '@/lib/validators/memo';
import { createMemo, listMemosForViewer } from '@/services/memo.service';
import { recordAuditLog } from '@/services/audit.service';

/**
 * GET /api/memos
 * 「全メモ」一覧: 自分の全メモ (private/public) + 他人の public メモを返す。
 */
export async function GET() {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const data = await listMemosForViewer(user.id);
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
