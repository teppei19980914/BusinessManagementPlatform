/**
 * /api/admin/super/banners (ADR-0036)
 *
 * システム周知バナー (画面上部の帯メッセージ) の一覧取得・新規作成 API。
 *
 * - GET : 全バナーを履歴として取得 (表示期間の新しい順)
 * - POST: 新規バナーを作成。enabled な場合は表示期間の重複 (1 本制約) を 409 で弾く
 *
 * 認可: super_admin role 必須 (それ以外は 403)。/admin/super/* 配下の UI は親 layout でも
 *   ガード済だが、API は独立に認可する (二段構え)。
 *
 * エラー:
 *   - 400 VALIDATION_ERROR
 *   - 401 未認証
 *   - 403 super_admin 以外
 *   - 409 OVERLAP (表示期間が既存の有効バナーと重複)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { isSuperAdmin } from '@/lib/permissions/role';
import { createSystemBannerSchema } from '@/lib/validators/system-banner';
import { createBanner, listBanners, BANNER_OVERLAP_ERROR } from '@/services/system-banner.service';
import { recordAuditLog } from '@/services/audit.service';

export async function GET() {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;
  if (!isSuperAdmin(user)) {
    return NextResponse.json({ error: { code: 'FORBIDDEN' } }, { status: 403 });
  }

  const banners = await listBanners();
  return NextResponse.json({ data: banners });
}

export async function POST(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;
  if (!isSuperAdmin(user)) {
    return NextResponse.json({ error: { code: 'FORBIDDEN' } }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: 'リクエスト JSON が不正です' } },
      { status: 400 },
    );
  }

  const parsed = createSystemBannerSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: parsed.error.issues[0]?.message ?? '入力内容に誤りがあります' } },
      { status: 400 },
    );
  }

  try {
    const banner = await createBanner(parsed.data, user.id);
    // 監査ログ: グローバル操作だが entity_id/tenant_id は UUID 必須のため
    //   tenant_id = super_admin 所属の管理テナント、entity_id = banner.id を使う ([[feedback_auditlog_uuid_strict_type]])。
    await recordAuditLog({
      tenantId: user.tenantId,
      userId: user.id,
      action: 'CREATE',
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
    return NextResponse.json({ data: banner }, { status: 201 });
  } catch (e) {
    if (e instanceof Error && e.message === BANNER_OVERLAP_ERROR) {
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
    throw e;
  }
}
