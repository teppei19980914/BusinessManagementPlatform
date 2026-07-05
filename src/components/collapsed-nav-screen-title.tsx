'use client';

/**
 * CollapsedNavScreenTitle (feat/collapsed-nav-screen-title, 2026-06-05):
 *
 * 役割:
 *   ヘッダのナビが常時グループ dropdown のため、現在どの画面を開いているかが
 *   ひと目で分かりにくい場合がある。そのため **画面上部に現在の画面名を常時表示する**。
 *
 * 表示条件:
 *   - pathname に対応する画面名が無い場合は何も描画しない。
 *   - v1.5.0 より全画面幅で常時表示。旧実装は xl: 未満のみ表示 (xl:hidden) だったが、
 *     ナビが常時 dropdown に統一されたため xl: 条件を撤廃した。
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
    <div className="mb-4" data-testid="collapsed-nav-screen-title">
      <h1 className="text-lg font-semibold text-foreground">{tNav(navKey)}</h1>
    </div>
  );
}
