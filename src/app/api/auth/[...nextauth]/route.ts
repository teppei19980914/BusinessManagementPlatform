/**
 * /api/auth/[...nextauth] - NextAuth v5 標準エンドポイント
 *
 * 役割:
 *   NextAuth が内部で使う一連の動的エンドポイント (signin / callback / signout /
 *   session / csrf 等) をホストする。実装ロジックは src/lib/auth.ts の `handlers` に集約。
 *
 * 認可: 未認証アクセス可 (PUBLIC_PATHS の '/api/auth' で前方一致許可)
 *
 * 関連:
 *   - src/lib/auth.ts (NextAuth インスタンスと callbacks)
 *   - src/lib/auth.config.ts (Edge 互換設定 / authorized コールバック)
 */

import { handlers } from '@/lib/auth';

export const { GET, POST } = handlers;
