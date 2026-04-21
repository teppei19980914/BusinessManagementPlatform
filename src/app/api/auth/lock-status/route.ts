/**
 * POST /api/auth/lock-status - アカウントロック状態の参照 (PR #87)
 *
 * 役割:
 *   ログイン失敗 (signIn の result.error) が返ってきた際、理由が
 *   「パスワード誤り」なのか「アカウントロック」なのかをクライアント側で
 *   判別するために利用する。ロック中なら画面上で専用の説明を出し、
 *   ユーザが「何度試してもログインできない」状況を早期に気付けるようにする。
 *
 * セキュリティ上の考慮:
 *   - **enumeration 対策**: 存在しないメールアドレスでも "none" を返し、
 *     存在有無を漏らさない (ロック状態の有無のみ返す)。
 *   - ログインフロー自体の側面攻撃 (timing / error 差異) と比べ新規の
 *     情報漏洩面は追加しない (既に 5 回失敗でロックする挙動自体が観測可能)。
 *   - 認証不要エンドポイントだが、返却は lock 情報のみ・ユーザ名や権限等は
 *     一切含めない。
 *   - 監査ログは取らない (失敗時の補助情報取得なので過剰なログは避ける)。
 *
 * 入力: { email: string }
 * 出力: { status: 'permanent_lock' | 'temporary_lock' | 'none', unlockAt?: string (ISO) }
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { prisma } from '@/lib/db';

const requestSchema = z.object({
  email: z.string().email(),
});

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    // バリデーション失敗でも「none」相当の応答を返す (情報漏洩防止)
    return NextResponse.json({ status: 'none' });
  }

  const user = await prisma.user.findFirst({
    where: { email: parsed.data.email, deletedAt: null },
    select: { permanentLock: true, lockedUntil: true },
  });

  if (!user) {
    // 存在しないメールアドレスも "none" を返す (enumeration 対策)
    return NextResponse.json({ status: 'none' });
  }

  if (user.permanentLock) {
    return NextResponse.json({ status: 'permanent_lock' });
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    return NextResponse.json({
      status: 'temporary_lock',
      unlockAt: user.lockedUntil.toISOString(),
    });
  }

  return NextResponse.json({ status: 'none' });
}
