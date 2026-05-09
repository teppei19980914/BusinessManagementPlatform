/**
 * /api/tenants/me - 自テナントのプラン / 予算上限変更 (PR-X4 / 2026-05-07)
 *
 * 認可: テナント管理者 (admin) のみ。
 *   super_admin は管理テナント所属のため、本 API では何もしない (super_admin は
 *   自テナント = 管理テナントのプラン変更を必要としないため)。
 *
 * GET    : 現在のテナント情報を取得 (UI の初期表示用)
 * PATCH  : プラン / 予算上限を更新
 * DELETE : ダウングレード予約のキャンセル
 *
 * 関連:
 *   - 計画: docs/roadmap/V1_FINAL_TASKS.md PR-X4
 *   - サービス: src/services/tenant-self.service.ts
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { isTenantAdmin } from '@/lib/permissions';
import {
  getTenantSelfInfo,
  updateTenantSelf,
  cancelScheduledPlanChange,
} from '@/services/tenant-self.service';

const updateBodySchema = z.object({
  plan: z.enum(['beginner', 'expert', 'pro']).optional(),
  monthlyBudgetCapJpy: z.number().int().nonnegative().nullable().optional(),
  // 2026-05-09 (PR G / #24): シードデータ参照 toggle
  seedDataEnabled: z.boolean().optional(),
});

export async function GET() {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  if (!isTenantAdmin(user)) {
    return NextResponse.json(
      { error: { code: 'FORBIDDEN', message: 'テナント管理者のみアクセス可能です' } },
      { status: 403 },
    );
  }

  const data = await getTenantSelfInfo(user.tenantId);
  if (!data) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: 'テナントが見つかりません' } },
      { status: 404 },
    );
  }

  return NextResponse.json({ data });
}

export async function PATCH(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  if (!isTenantAdmin(user)) {
    return NextResponse.json(
      { error: { code: 'FORBIDDEN', message: 'テナント管理者のみアクセス可能です' } },
      { status: 403 },
    );
  }

  const body = await req.json();
  const parsed = updateBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }

  const result = await updateTenantSelf(user.tenantId, parsed.data);
  if (!result.ok) {
    if (result.error === 'BEGINNER_REQUIRES_FEWER_SEATS') {
      return NextResponse.json(
        {
          error: {
            code: 'BEGINNER_REQUIRES_FEWER_SEATS',
            message: 'Beginner プランは最大 5 席までです。先に席数を 5 以下に減らしてください。',
          },
        },
        { status: 400 },
      );
    }
    return NextResponse.json(
      { error: { code: result.error, message: '入力が不正です' } },
      { status: 400 },
    );
  }

  return NextResponse.json({
    data: {
      appliedImmediately: result.appliedImmediately,
      scheduledFor: result.scheduledFor,
    },
  });
}

export async function DELETE() {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  if (!isTenantAdmin(user)) {
    return NextResponse.json(
      { error: { code: 'FORBIDDEN', message: 'テナント管理者のみアクセス可能です' } },
      { status: 403 },
    );
  }

  await cancelScheduledPlanChange(user.tenantId);
  return NextResponse.json({ data: { ok: true } });
}
