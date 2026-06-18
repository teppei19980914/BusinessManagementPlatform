import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { getAuthenticatedUser, requireStorageQuotaForWrite } from '@/lib/api-helpers';
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
  const memo = await getMemoForViewer(id, user.id, user.tenantId);
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

  // PR-5 (2026-05-15): ストレージ容量 Pre-check (write 前に拒否し、無駄な service 呼出を回避)
  const quotaErr = await requireStorageQuotaForWrite(
    user.tenantId,
    Buffer.byteLength(JSON.stringify(parsed.data), 'utf8'),
  );
  if (quotaErr) return quotaErr;

  let updated;
  try {
    updated = await updateMemo(id, parsed.data, user.id, user.tenantId);
  } catch (e) {
    // 2026-05-11 defense-in-depth: 「全メンバー」化を試みたが title が空 (input + DB 共に) のケース
    if (e instanceof Error && e.message === 'PUBLIC_REQUIRES_TITLE') {
      return NextResponse.json(
        {
          error: {
            code: 'PUBLIC_REQUIRES_TITLE',
            message: '「全メンバー」に公開する場合はタイトルを入力してください',
          },
        },
        { status: 400 },
      );
    }
    // v1.3.0 軽量入力 (2026-06-19): public 化を試みたが本文が空 (input + DB 共に) のケース
    if (e instanceof Error && e.message === 'PUBLIC_REQUIRES_FIELDS') {
      return NextResponse.json(
        {
          error: {
            code: 'PUBLIC_REQUIRES_FIELDS',
            message: '「全メンバー」に公開する場合は本文を入力してください',
          },
        },
        { status: 400 },
      );
    }
    // feat/asset-assignee-expansion (2026-05-26) severity-1:
    //   「自分のみ」(private) のメモに他人を担当者指定すると、担当者は memo 不可視のまま
    //   編集権限だけ持つ矛盾状態になる。UI は selector 非表示で防御するが、API 直叩きを
    //   service 層で reject、route で 400 にマップする。
    if (e instanceof Error && e.message === 'PRIVATE_MEMO_ASSIGNEE_FORBIDDEN') {
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
    if (e instanceof Error && e.message === 'ASSIGNEE_TENANT_MISMATCH') {
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
  if (!updated) {
    // 他人のメモ or 存在しない → 404 (情報漏洩防止のため 403 でなく 404)
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: t('notFoundTarget') } },
      { status: 404 },
    );
  }
  await recordAuditLog({
    tenantId: user.tenantId,
    userId: user.id,
    action: 'UPDATE',
    entityType: 'memo',
    entityId: id,
  });
  return NextResponse.json({ data: updated });
}

/**
 * DELETE /api/memos/:id —
 *   - 作成者本人: 自分のメモ (private/public 問わず) 論理削除可
 *   - admin: visibility='public' な他人メモのみ論理削除可 (feat/crud-permission-redesign, 2026-05-20)
 *   - admin であっても他人の private メモは削除不可 (プライバシー保護)
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { id } = await params;
  const t = await getTranslations('message');
  const ok = await deleteMemo(id, user.id, user.tenantId, user.systemRole);
  if (!ok) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: t('notFoundTarget') } },
      { status: 404 },
    );
  }
  await recordAuditLog({
    tenantId: user.tenantId,
    userId: user.id,
    action: 'DELETE',
    entityType: 'memo',
    entityId: id,
  });
  return NextResponse.json({ data: { success: true } });
}
