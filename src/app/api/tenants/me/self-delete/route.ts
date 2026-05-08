/**
 * POST /api/tenants/me/self-delete (2026-05-08)
 *
 * テナント管理者 (admin) が自テナントを解約する。
 *
 * 動作:
 *   既存の super_admin 用 deleteTenant() (P-A / PR #264) を再利用し、
 *   テナント本体 + 配下 10 種の業務データを **論理削除** する。
 *   解約後、論理削除から 90 日経過した時点で月初 cron が業務データを **物理削除** する
 *   (= データ容量を解放、課金根拠データ + 監査ログは保護)。
 *
 * 認可:
 *   - admin role 必須 (general / super_admin はアクセス不可)
 *   - 自テナント (= user.tenantId) のみ解約可能
 *
 * 入力 (確認パターン):
 *   { tenantName: string }  // 確認用に自テナント名の入力を要求
 *   名称が一致しない場合は 422 で拒否 (誤操作防止)
 *
 * 副作用:
 *   - 解約後、admin user 自身も isActive=false になり、次回ログイン不可
 *   - 当該セッションは無効化されるが API 呼出側で signOut を併用する想定
 *
 * 関連:
 *   - super-admin.service.ts:deleteTenant (内部実装の本体)
 *   - PHASE2_THREAT_MODEL.md: テナント自己削除の悪用シナリオ (= 名称一致確認で軽減)
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { isTenantAdmin } from '@/lib/permissions';
import { deleteTenant } from '@/services/super-admin.service';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const bodySchema = z.object({
  tenantName: z.string().min(1).max(200),
});

export async function POST(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;
  if (!isTenantAdmin(user)) {
    return NextResponse.json({ error: { code: 'FORBIDDEN' } }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }

  // 確認: 入力された tenantName が自テナント名と一致するか (= 誤操作防止)
  const tenant = await prisma.tenant.findFirst({
    where: { id: user.tenantId, deletedAt: null },
    select: { id: true, name: true },
  });
  if (!tenant) {
    return NextResponse.json(
      { error: { code: 'TENANT_NOT_FOUND', message: 'テナントが見つかりません' } },
      { status: 404 },
    );
  }
  if (parsed.data.tenantName !== tenant.name) {
    return NextResponse.json(
      {
        error: {
          code: 'NAME_MISMATCH',
          message: '入力されたテナント名が現在のテナント名と一致しません。誤操作防止のため、表示されているテナント名を正確に入力してください。',
        },
      },
      { status: 422 },
    );
  }

  try {
    const result = await deleteTenant(user.tenantId, user.id);
    return NextResponse.json({
      data: {
        ok: true,
        tenantId: result.tenantId,
        deletedCounts: result.deletedCounts,
        message: 'テナントを解約しました。論理削除から 90 日経過後に業務データは物理削除されます。',
      },
    });
  } catch (e) {
    if (e instanceof Error) {
      if (e.message === 'MANAGEMENT_TENANT_FORBIDDEN') {
        return NextResponse.json(
          { error: { code: 'FORBIDDEN', message: '管理テナントは解約できません' } },
          { status: 403 },
        );
      }
      if (e.message === 'ALREADY_DELETED') {
        return NextResponse.json(
          { error: { code: 'ALREADY_DELETED', message: 'このテナントは既に解約済みです' } },
          { status: 410 },
        );
      }
    }
    throw e;
  }
}
