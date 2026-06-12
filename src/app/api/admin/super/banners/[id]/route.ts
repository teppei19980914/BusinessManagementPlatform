/**
 * /api/admin/super/banners/[id] (ADR-0036)
 *
 * システム周知バナーの編集・取り下げ/再開・物理削除 API。
 *
 * - PATCH : メッセージ/緊急度/期間/enabled を更新。{ enabled: false } だけ送れば取り下げ、
 *           { enabled: true } で再開。再有効化・期間変更時は重複 (1 本制約) を 409 で弾く
 * - DELETE: 誤作成バナーの物理削除 (履歴ごと消す)
 *
 * 認可: super_admin role 必須 (それ以外は 403)。
 *
 * エラー:
 *   - 400 VALIDATION_ERROR / INVALID_PERIOD (start >= end)
 *   - 401 未認証 / 403 super_admin 以外
 *   - 404 NOT_FOUND
 *   - 409 OVERLAP
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { isSuperAdmin } from '@/lib/permissions/role';
import { updateSystemBannerSchema } from '@/lib/validators/system-banner';
import {
  getBanner,
  updateBanner,
  deleteBanner,
  BANNER_OVERLAP_ERROR,
} from '@/services/system-banner.service';
import { recordAuditLog } from '@/services/audit.service';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;
  if (!isSuperAdmin(user)) {
    return NextResponse.json({ error: { code: 'FORBIDDEN' } }, { status: 403 });
  }

  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: 'リクエスト JSON が不正です' } },
      { status: 400 },
    );
  }

  const parsed = updateSystemBannerSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: parsed.error.issues[0]?.message ?? '入力内容に誤りがあります' } },
      { status: 400 },
    );
  }

  try {
    const banner = await updateBanner(id, parsed.data);
    await recordAuditLog({
      tenantId: user.tenantId,
      userId: user.id,
      action: 'UPDATE',
      entityType: 'system_banner',
      entityId: banner.id,
      afterValue: {
        message: banner.message,
        severity: banner.severity,
        startAt: banner.startAt,
        endAt: banner.endAt,
        enabled: banner.enabled,
      },
    });
    return NextResponse.json({ data: banner });
  } catch (e) {
    return mapMutationError(e);
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;
  if (!isSuperAdmin(user)) {
    return NextResponse.json({ error: { code: 'FORBIDDEN' } }, { status: 403 });
  }

  const { id } = await params;

  const existing = await getBanner(id);
  if (!existing) {
    return NextResponse.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
  }

  await deleteBanner(id);
  await recordAuditLog({
    tenantId: user.tenantId,
    userId: user.id,
    action: 'DELETE',
    entityType: 'system_banner',
    entityId: id,
    beforeValue: {
      message: existing.message,
      severity: existing.severity,
      startAt: existing.startAt,
      endAt: existing.endAt,
      enabled: existing.enabled,
    },
  });
  return NextResponse.json({ data: { id } });
}

function mapMutationError(e: unknown): NextResponse {
  if (e instanceof Error) {
    if (e.message === 'NOT_FOUND') {
      return NextResponse.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
    }
    if (e.message === 'INVALID_PERIOD') {
      return NextResponse.json(
        { error: { code: 'INVALID_PERIOD', message: '表示終了日時は開始日時より後にしてください' } },
        { status: 400 },
      );
    }
    if (e.message === BANNER_OVERLAP_ERROR) {
      return NextResponse.json(
        {
          error: {
            code: 'OVERLAP',
            message: '表示期間が他の有効なバナーと重複しています。期間をずらすか、重複するバナーを取り下げてください。',
          },
        },
        { status: 409 },
      );
    }
  }
  throw e;
}
