/**
 * POST /api/auth/mfa/enable - MFA 有効化確定
 *
 * 役割:
 *   /api/auth/mfa/setup でセットアップ中のユーザが認証アプリで生成した 6 桁 TOTP
 *   コードを送信し、検証成功時に mfaEnabled=true へ確定する第 2 段階。
 *
 * 認可: getAuthenticatedUser (ログイン中ユーザ本人)
 * 監査: enableMfa サービス内で auth_event_logs (eventType=mfa_enabled) を記録。
 *
 * 関連:
 *   - DESIGN.md §9.5 (MFA 設計)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { enableMfa } from '@/services/mfa.service';
import { z } from 'zod/v4';

const schema = z.object({ code: z.string().length(6) });

export async function POST(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const body = await req.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: '6桁のコードを入力してください' } },
      { status: 400 },
    );
  }

  const result = await enableMfa(user.id, parsed.data.code);
  if (!result.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: result.error } },
      { status: 400 },
    );
  }

  return NextResponse.json({ data: { success: true } });
}
