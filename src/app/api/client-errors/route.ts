/**
 * POST /api/client-errors - クライアント側エラーの DB 記録 (PR #115 / 2026-04-24)
 *
 * 役割:
 *   ブラウザで発生した JS エラー (React render error / unhandled rejection 等) を
 *   global-error.tsx / error.tsx から受け取り、system_error_logs に保存する。
 *   ユーザの画面には呼び出し側で固定文言が表示されるため、本エンドポイントは
 *   受け皿のみ (204 / 200 を返すだけ)。
 *
 * 認可:
 *   - 認証任意 (未ログインでもエラーは発生し得る、ログを取り損ねない)。
 *     ただし認証済みなら userId を記録。
 *   - body サイズは max 16 KB (大きすぎる巨大スタックは切り詰める)。
 *
 * セキュリティ:
 *   - レスポンスには何も詳細を返さない (200 のみ)。
 *   - 受け取ったフィールドはそのまま DB に入るので、クライアント悪意のペイロードで
 *     DB を汚染する余地がある。message / stack 双方に 4KB の上限を設け、
 *     zod で型 validate する。
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { auth } from '@/lib/auth';
import { recordError } from '@/services/error-log.service';

const clientErrorSchema = z.object({
  message: z.string().max(4096),
  stack: z.string().max(16384).optional(),
  source: z.string().max(100).optional(),
  digest: z.string().max(200).optional(),
  path: z.string().max(2048).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    const userId = session?.user?.id;

    const body = await req.json().catch(() => null);
    const parsed = clientErrorSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ ok: true }, { status: 200 });
    }

    const { message, stack, source, digest, path } = parsed.data;
    await recordError({
      severity: 'error',
      source: 'client',
      message: message.slice(0, 4096),
      stack: stack?.slice(0, 16384),
      userId,
      context: { clientSource: source, digest, path },
    });

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch {
    // エラーログ受信エンドポイント自体の失敗はユーザに影響させない
    return NextResponse.json({ ok: true }, { status: 200 });
  }
}
