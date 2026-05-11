/**
 * PATCH /api/tenants/me/i18n (PR-1 / 2026-05-15):
 *   テナント単位の i18n 設定 (timezone / locale) を更新する。
 *
 * 認可: テナント管理者 (admin) のみ。
 *   super_admin / general は 403 (テナント設定はテナント管理者の責務)。
 *
 * 入力バリデーション:
 *   - timezone: IANA タイムゾーン名のみ受理 (Intl.DateTimeFormat 互換)
 *   - locale: SELECTABLE_LOCALES=true のキーのみ受理
 *   - 両キーとも optional (片方のみの部分更新可)
 *   - null は受理しない (テナントは default 'Asia/Tokyo' / 'ja-JP' を NOT NULL で持つ)
 *
 * 旧 PATCH /api/settings/i18n (= ユーザ単位) は廃止。テナント管理者画面に集約。
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { isTenantAdmin } from '@/lib/permissions';
import { isValidTimezone, isSelectableLocale } from '@/config/i18n';
import { updateTenantI18n } from '@/services/tenant-self.service';

const updateBodySchema = z.object({
  timezone: z
    .string()
    .refine(isValidTimezone, { message: '未対応のタイムゾーンです' })
    .optional(),
  locale: z
    .string()
    .refine(isSelectableLocale, {
      message: '未対応のロケールです (現時点で選択可能なロケールではありません)',
    })
    .optional(),
});

export async function PATCH(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  if (!isTenantAdmin(user)) {
    return NextResponse.json(
      { error: { code: 'FORBIDDEN', message: 'テナント管理者のみ更新可能です' } },
      { status: 403 },
    );
  }

  const body = await req.json().catch(() => null);
  const parsed = updateBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }

  const result = await updateTenantI18n(user.tenantId, parsed.data);
  return NextResponse.json({ data: result });
}
