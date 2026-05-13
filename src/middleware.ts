/**
 * NextAuth v5 公式パターン: Edge 互換 middleware
 * auth.config.ts の authorized コールバックで認証チェックを行う。
 * Prisma などの Node.js 依存を含まないため、Edge Runtime で動作する。
 *
 * 2026-05-13 (security/auth-secret-hardening, B-2): Credential stuffing 対策。
 *   NextAuth の Credentials provider POST に IP 単位の rate limit を入れる。
 *   アカウントロック (5 回失敗 → 30 分) は被害者単位の防御で、攻撃者がメールリストを
 *   ばらして低試行回数で広域に試す手口を防げない (1 アカウント 4 回 × 100 万件 = 400 万試行)。
 *   本 IP 単位 rate limit と組み合わせる事で、攻撃者の試行コストを大幅に引き上げる。
 *
 *   Edge runtime + serverless instance 分散により完全な制限ではないが (rate-limit.ts §13-21
 *   設計判断)、攻撃のコストを上げる多層防御の 1 層として機能する。
 */

import NextAuth from 'next-auth';
import { authConfig } from '@/lib/auth.config';
import { applyRateLimit } from '@/lib/rate-limit';

const { auth } = NextAuth(authConfig);

export default auth((req) => {
  // login POST に対する IP 単位レート制限 (B-2)
  if (
    req.nextUrl.pathname === '/api/auth/callback/credentials'
    && req.method === 'POST'
  ) {
    // max=20 / window=5 分: 通常利用 (1 ユーザが間違って 2-3 回試行 + 同一 NAT 内
    // 数ユーザ) を吸収しつつ、credential stuffing は確実に弾く水準。
    const limited = applyRateLimit(req, { key: 'login', max: 20, windowMs: 5 * 60 * 1000 });
    if (limited) return limited;
  }
  // pass-through: NextAuth の authorized callback に委譲。
});

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
