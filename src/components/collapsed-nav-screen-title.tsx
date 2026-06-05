'use client';

/**
 * CollapsedNavScreenTitle (feat/collapsed-nav-screen-title, 2026-06-05):
 *
 * 役割:
 *   ヘッダのナビが折りたたみ (xl: 未満 = 3 分類 dropdown) の幅では、現在どの画面を
 *   開いているかが分かりにくい (active な nav 項目がラベルとして見えない) ため、
 *   **画面上部に現在の画面名を表示する**。
 *
 * 表示条件:
 *   - `xl:hidden` で **xl: 未満 (= ナビが dropdown に折りたたまれる幅) のときだけ表示**。
 *     xl: 以上 (flat ナビで active 項目が直接見える) では非表示。
 *     app-header.tsx の `groupedBreakpointClass = 'flex xl:hidden'` と breakpoint を一致させている。
 *   - pathname に対応する画面名が無い場合は何も描画しない。
 *
 * 配置: dashboard layout の `<main>` 先頭に置き、全画面で同じ位置に出す (UI 配置の統一)。
 * ラベル: `nav` namespace を再利用 (src/config/screen-title.ts、新規 i18n キーなし)。
 */

import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { getScreenTitleNavKey } from '@/config/screen-title';

export function CollapsedNavScreenTitle() {
  const pathname = usePathname();
  const tNav = useTranslations('nav');
  const navKey = getScreenTitleNavKey(pathname);
  if (!navKey) return null;

  return (
    <div className="mb-4 xl:hidden" data-testid="collapsed-nav-screen-title">
      <h1 className="text-lg font-semibold text-foreground">{tNav(navKey)}</h1>
    </div>
  );
}
