'use client';

/**
 * useFormatters — ログイン中ユーザの TZ / locale を反映した日時フォーマッタを返す React フック (PR #119)。
 *
 * 仕組み:
 *   - `useSession()` から session.user.timezone / session.user.locale を読む
 *   - 両方 null なら format.ts 側で DEFAULT_TIMEZONE / DEFAULT_LOCALE にフォールバック (config/i18n.ts)
 *   - (timezone, locale) の組が変わらない限り返り値は同一参照 (useMemo で安定化) — 下流 memo の再計算抑制
 *
 * ハイドレーション安全性:
 *   - root layout で `<SessionProvider session={session}>` に初期 session を注入 (PR #119)
 *   - これにより第 1 クライアントレンダリングで useSession() が SSR と同じ値を返す
 *   - サーバ側 (getServerFormatters) と同じ timezone/locale を使う限り出力文字列も一致する
 *
 * 使い方:
 *   const { formatDate, formatDateTime, formatDateTimeFull } = useFormatters();
 *   return <span>{formatDate(iso)}</span>;
 */

import { useMemo } from 'react';
import { useSession } from 'next-auth/react';
import {
  formatDate as formatDateCore,
  formatDateTime as formatDateTimeCore,
  formatDateTimeFull as formatDateTimeFullCore,
  formatDateOnly as formatDateOnlyCore,
} from '@/lib/format';

export type Formatters = {
  formatDate: (iso: string) => string;
  formatDateTime: (iso: string) => string;
  formatDateTimeFull: (iso: string) => string;
  /**
   * 'YYYY-MM-DD' 形式の date-only 値を locale 表記に整形する (TZ シフトなし)。
   * 「実施日」「期限」など datetime ではなく calendar day を表す値に使用する。
   */
  formatDateOnly: (ymd: string) => string;
};

export function useFormatters(): Formatters {
  const { data: session } = useSession();
  const timeZone = session?.user?.timezone ?? null;
  const locale = session?.user?.locale ?? null;

  return useMemo<Formatters>(
    () => ({
      formatDate: (iso) => formatDateCore(iso, { timeZone, locale }),
      formatDateTime: (iso) => formatDateTimeCore(iso, { timeZone, locale }),
      formatDateTimeFull: (iso) => formatDateTimeFullCore(iso, { timeZone, locale }),
      formatDateOnly: (ymd) => formatDateOnlyCore(ymd, { locale }),
    }),
    [timeZone, locale],
  );
}
