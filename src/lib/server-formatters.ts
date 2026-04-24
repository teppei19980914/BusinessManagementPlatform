/**
 * Server Component 向けの日時フォーマッタ提供ヘルパ (PR #119)。
 *
 * クライアントは `useFormatters()` フック、サーバは本関数 `getServerFormatters()` を使う。
 * 両者とも session.user.timezone / session.user.locale を読み、同じ結果を返す設計。
 *
 * ハイドレーション安全:
 *   Server Component でこの関数で整形した文字列を Props として Client Component に渡す場合も、
 *   Client 側で `useFormatters()` が同じ session を元に再計算するため文字列は一致する。
 *   (ただし同一の iso を渡すこと。)
 *
 * 使い方:
 *   export default async function Page() {
 *     const { formatDateTimeFull } = await getServerFormatters();
 *     return <td>{formatDateTimeFull(log.createdAt.toISOString())}</td>;
 *   }
 */

import { auth } from '@/lib/auth';
import {
  formatDate as formatDateCore,
  formatDateTime as formatDateTimeCore,
  formatDateTimeFull as formatDateTimeFullCore,
} from '@/lib/format';
import type { Formatters } from './use-formatters';

export async function getServerFormatters(): Promise<Formatters> {
  const session = await auth();
  const timeZone = session?.user?.timezone ?? null;
  const locale = session?.user?.locale ?? null;

  return {
    formatDate: (iso) => formatDateCore(iso, { timeZone, locale }),
    formatDateTime: (iso) => formatDateTimeCore(iso, { timeZone, locale }),
    formatDateTimeFull: (iso) => formatDateTimeFullCore(iso, { timeZone, locale }),
  };
}
