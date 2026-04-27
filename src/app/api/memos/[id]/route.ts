import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { updateMemoSchema } from '@/lib/validators/memo';
import { deleteMemo, getMemoForViewer, updateMemo } from '@/services/memo.service';
import { recordAuditLog } from '@/services/audit.service';

/**
 * GET /api/memos/:id — 閲覧権限チェック付き。
 * 他人の private メモは「存在しない」扱いで 404 を返す (情報漏洩防止)。
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { id } = await params;
  const t = await getTranslations('message');
  const memo = await getMemoForViewer(id, user.id);
  if (!memo) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: t('notFoundTarget') } },
      { status: 404 },
    );
  }
  return NextResponse.json({ data: memo });
}

/**
 * PATCH /api/memos/:id — 作成者本人のみ更新可 (admin 特権なし)。
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { id } = await params;
  const t = await getTranslations('message');
  const body = await req.json().catch(() => ({}));
  const parsed = updateMemoSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }

  const updated = await updateMemo(id, parsed.data, user.id);
  if (!updated) {
    // 他人のメモ or 存在しない → 404 (情報漏洩防止のため 403 でなく 404)
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: t('notFoundTarget') } },
      { status: 404 },
    );
  }
  await recordAuditLog({
    userId: user.id,
    action: 'UPDATE',
    entityType: 'memo',
    entityId: id,
  });
  return NextResponse.json({ data: updated });
}

/**
 * DELETE /api/memos/:id — 作成者本人のみ論理削除可。
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { id } = await params;
  const t = await getTranslations('message');
  const ok = await deleteMemo(id, user.id);
  if (!ok) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: t('notFoundTarget') } },
      { status: 404 },
    );
  }
  await recordAuditLog({
    userId: user.id,
    action: 'DELETE',
    entityType: 'memo',
    entityId: id,
  });
  return NextResponse.json({ data: { success: true } });
}
