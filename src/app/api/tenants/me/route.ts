/**
 * /api/tenants/me - 自テナントのプラン / 予算上限変更 (PR-X4 / 2026-05-07)
 *
 * 認可: テナント管理者 (admin) のみ。
 *   super_admin は管理テナント所属のため、本 API では何もしない (super_admin は
 *   自テナント = 管理テナントのプラン変更を必要としないため)。
 *
 * GET    : 現在のテナント情報を取得 (UI の初期表示用)
 * PATCH  : プラン / 予算上限を更新 (2026-05-14 改修: Expert↔Pro 即時反映、Beginner ダウングレード完全禁止)
 * DELETE : ダウングレード予約のキャンセル (legacy DB レコード対策、新規予約は発生しない)
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
  // ADR-0030 (2026-05-30): Embedding 専用の月次予算上限。null = 無制限、undefined = 変更なし
  monthlyEmbeddingBudgetCapJpy: z.number().int().nonnegative().nullable().optional(),
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
    // PR-2 (2026-05-15): Beginner プランは月次予算上限を設定不可
    if (result.error === 'BEGINNER_BUDGET_NOT_ALLOWED') {
      return NextResponse.json(
        {
          error: {
            code: 'BEGINNER_BUDGET_NOT_ALLOWED',
            message:
              'Beginner プランは固定のプロジェクト作成/更新 月 50 回まで無料で運用されるため (ADR-0019)、月次予算上限は設定できません。Expert または Pro プランへのアップグレード後に設定してください。',
          },
        },
        { status: 400 },
      );
    }
    // ADR-0030 (2026-05-30): Beginner プランは Embedding 月次予算上限を設定不可 (固定 100 件試用上限)
    if (result.error === 'BEGINNER_EMBEDDING_BUDGET_NOT_ALLOWED') {
      return NextResponse.json(
        {
          error: {
            code: 'BEGINNER_EMBEDDING_BUDGET_NOT_ALLOWED',
            message:
              'Beginner プランは固定の Embedding 月 100 件まで無料で運用されるため (ADR-0030)、月次予算上限は設定できません。Expert または Pro プランへのアップグレード後に設定してください。',
          },
        },
        { status: 400 },
      );
    }
    // feat/billing-conditional-by-plan (2026-06-05): 有料プラン化時に請求先住所が未入力
    if (result.error === 'BILLING_INFO_INCOMPLETE') {
      return NextResponse.json(
        {
          error: {
            code: 'BILLING_INFO_INCOMPLETE',
            message:
              'Expert / Pro プランへの変更には請求先情報 (郵便番号・都道府県・市区町村・番地、法人の場合は会社名) が必要です。請求先セクションで入力・保存してから再度お試しください。',
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
