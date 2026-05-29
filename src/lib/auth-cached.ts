/**
 * PR-7 perf (2026-05-29): NextAuth `auth()` を React.cache でラップし、同一 RSC リクエスト
 *   内で重複する JWT 復号 + session 取得を 1 回に集約する。
 *
 * 背景:
 *   `(dashboard)/layout.tsx` と child `page.tsx` の両方で `auth()` を呼び出すパターンが
 *   普及しており、1 ページ遷移ごとに JWT 復号 (HKDF + AES-GCM) が複数回実行される状態
 *   だった。React.cache は **同一 React render パス (= 同一 HTTP request)** 内で関数結果を
 *   メモ化するため、layout で取得した session を child page から透過的に再利用できる。
 *
 * 注意:
 *   - キャッシュ範囲は「同一 request の同一 render pass」に閉じる。リクエスト間でセッション
 *     が漏れることはない (React 公式仕様)。
 *   - API route (`route.ts` 経由) は React render パスを持たないので、本ヘルパーは効かない。
 *     API route は引き続き `import { auth } from '@/lib/auth'` を使う。
 *   - 失効検証 (`getAuthenticatedUser` の tokenVersion 比較) はそのまま機能する。
 *     ★severity-1 セキュリティ要件は変更なし (キャッシュは session 取得のみ、検証は別途実行)。
 */

import { cache } from 'react';
import { auth } from '@/lib/auth';

/**
 * `auth()` の React.cache ラップ版。Server Component (layout / page) 内で使用する。
 *
 * 使い方:
 *   ```ts
 *   // 旧:
 *   import { auth } from '@/lib/auth';
 *   const session = await auth();
 *
 *   // 新 (Server Component 内):
 *   import { getCachedAuth } from '@/lib/auth-cached';
 *   const session = await getCachedAuth();
 *   ```
 *
 *   同一 request 内で複数回呼んでも JWT 復号は 1 回しか走らない。
 */
export const getCachedAuth = cache(auth);
