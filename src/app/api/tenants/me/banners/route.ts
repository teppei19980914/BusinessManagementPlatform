/**
 * /api/tenants/me/banners (ADR-0037)
 *
 * テナントバナーの一覧取得・新規作成 API。
 *
 * - GET : 自テナントの全バナーを履歴として取得 (表示期間の新しい順)
 * - POST: 自テナントに新規バナーを作成。enabled な場合は同テナント内の表示期間重複 (1 本制約) を 409 で弾く
 *
 * 認可: tenant_admin role (systemRole === 'admin') 必須。super_admin / general は 403。
 *   テナント識別は session.user.tenantId から取得し、URL パラメータは使わない (横断アクセス防止)。
 *
 * エラー:
 *   - 400 VALIDATION_ERROR
 *   - 401 未認証
 *   - 403 tenant_admin 以外
 *   - 409 OVERLAP (同テナント内で表示期間が重複)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { isTenantAdmin } from '@/lib/permissions';
import { createTenantBannerSchema } from '@/lib/validators/tenant-banner';
import {
  createTenantBanner,
  listTenantBanners,
  TENANT_BANNER_OVERLAP_ERROR,
} from '@/services/tenant-banner.service';
import { recordAuditLog } from '@/services/audit.service';

export async function GET() {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;
  if (!isTenantAdmin(user)) {
    return NextResponse.json({ error: { code: 'FORBIDDEN' } }, { status: 403 });
  }

  const banners = await listTenantBanners(user.tenantId);
  return NextResponse.json({ data: banners });
}

export async function POST(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;
  if (!isTenantAdmin(user)) {
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

  const parsed = createTenantBannerSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: parsed.error.issues[0]?.message ?? '入力内容に誤りがあります',
        },
      },
      { status: 400 },
    );
  }

  try {
    const banner = await createTenantBanner(parsed.data, user.tenantId, user.id);
    await recordAuditLog({
      tenantId: user.tenantId,
      userId: user.id,
      action: 'CREATE',
      entityType: 'tenant_banner',
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
    if (e instanceof Error && e.message === TENANT_BANNER_OVERLAP_ERROR) {
      return NextResponse.json(
        {
          error: {
            code: 'OVERLAP',
            message:
              '表示期間が他の有効なバナーと重複しています。期間をずらすか、重複するバナーを取り下げてください。',
          },
        },
        { status: 409 },
      );
    }
    throw e;
  }
}
