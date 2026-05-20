/**
 * POST /api/client-errors - クライアント側エラーの DB 記録 (PR #115 / 2026-04-24)
 *
 * 役割:
 *   ブラウザで発生した JS エラー (React render error / unhandled rejection 等) を
 *   global-error.tsx / error.tsx から受け取り、system_error_logs に保存する。
 *   ユーザの画面には呼び出し側で固定文言が表示されるため、本エンドポイントは
 *   受け皿のみ (204 / 200 を返すだけ)。
 *
 * 認可 (feat/crud-permission-redesign, 2026-05-20, 2 巡目検証 S2-H1 で改修):
 *   - 認証任意 (未ログインでもエラーは発生し得る、ログを取り損ねない)。
 *   - 認証済みなら getAuthenticatedUser で tokenVersion 検証して userId を記録 (旧仕様は auth() の
 *     JWT 信頼のみで、ログアウト後の旧 cookie で userId 汚染が発生していた)。検証失敗時は
 *     userId 未記録 (= 匿名扱い) で続行する。
 *   - rate-limit: IP 単位 30 req/min (DoS 対策、旧仕様は無制限で system_error_logs 汚染リスク)。
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
import { prisma } from '@/lib/db';
import { auth } from '@/lib/auth';
import { applyRateLimit } from '@/lib/rate-limit';
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
    // feat/crud-permission-redesign (2026-05-20, 2 巡目検証 S2-H1): IP 単位 rate-limit (30 req/min)
    //   匿名でも投げられる経路のため、DoS 対策として必須。
    const rateLimitErr = applyRateLimit(req, {
      key: 'client-errors',
      windowMs: 60_000,
      max: 30,
    });
    if (rateLimitErr) return NextResponse.json({ ok: true }, { status: 200 });

    // feat/crud-permission-redesign (2026-05-20, 2 巡目検証 S2-H1): tokenVersion 検証。
    //   旧実装は auth() の JWT 信頼のみで、ログアウト済セッションの userId が記録される問題があった。
    //   tokenVersion / isActive / deletedAt を DB 照合し、不一致なら userId 未記録 (匿名) で続行。
    const session = await auth();
    let userId: string | undefined;
    if (session?.user?.id) {
      const dbUser = await prisma.user.findUnique({
        where: { id: session.user.id },
        select: { tokenVersion: true, isActive: true, deletedAt: true },
      });
      const jwtTokenVersion = session.user.tokenVersion ?? 0;
      if (
        dbUser
        && dbUser.deletedAt === null
        && dbUser.isActive
        && dbUser.tokenVersion === jwtTokenVersion
      ) {
        userId = session.user.id;
      }
      // 不一致 / DB 障害時は userId 未記録 (匿名ログ) で続行
    }

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
