'use client';

/**
 * useScrollDirection (feat/app-header-footer-unification / 2026-05-24)
 *
 * 縦スクロール方向 ('up' | 'down') と現在の scrollY を返す client-side hook。
 * AppHeader の auto-hide (下スクロール時に隠す / 上スクロール時に出す) で利用する。
 *
 * 設計判断:
 *   - `passive: true` の scroll listener + requestAnimationFrame で間引き、UI スレッドを
 *     圧迫しない (一覧画面の縦スクロール中に jank が発生しないことが要件)
 *   - 微小な scroll (< TOLERANCE) は無視。OS のスクロール慣性で 1px だけ反対方向に動く
 *     瞬間に direction が flip して header がチラつく事故を防ぐ
 *   - SSR-safe: window 不在環境では `scrollY=0 / direction='up'` の初期値を返し、副作用は
 *     mount 後の useEffect で開始する (Next.js App Router の client component 規約)
 *
 * 関連:
 *   - 適用先: src/components/app-header.tsx (auto-hide の信号源)
 *   - 閾値定数 SCROLL_DIRECTION_THRESHOLD は consumer 側で参照可能 (AppHeader が
 *     「先頭 64px は常に visible」判定に用いる)
 */

import { useEffect, useState } from 'react';

export type ScrollDirection = 'up' | 'down';

/**
 * scrollY がこの値以下の領域では「常に header を visible にする」と consumer 側で
 * 解釈する閾値 (px)。本 hook 自体は direction しか返さないが、AppHeader が
 * 「ページ先頭付近では direction='down' でも隠さない」判定に使う共通値。
 */
export const SCROLL_DIRECTION_THRESHOLD = 64;

/**
 * 微小スクロール無視幅 (px)。これ未満の delta では direction を更新しない。
 * OS の慣性スクロールやトラックパッドの逆方向 1px 揺れによる direction flip を防ぐ。
 */
const TOLERANCE = 4;

export function useScrollDirection(): { direction: ScrollDirection; scrollY: number } {
  const [direction, setDirection] = useState<ScrollDirection>('up');
  const [scrollY, setScrollY] = useState(0);

  useEffect(() => {
    let lastY = window.scrollY;
    let ticking = false;
    // 最後に enqueue した rAF handle。unmount 時に cancel して「unmount 後に
    // update() が呼ばれて setState される」warning + 軽微メモリ保持を防ぐ。
    let rafId = 0;

    const update = () => {
      const y = window.scrollY;
      const delta = y - lastY;
      if (Math.abs(delta) > TOLERANCE) {
        setDirection(delta > 0 ? 'down' : 'up');
        setScrollY(y);
        lastY = y;
      } else if (y !== lastY) {
        // direction は据え置きで scrollY のみ更新 (= 先頭付近の判定を正確にするため)
        setScrollY(y);
        lastY = y;
      }
      ticking = false;
    };

    const onScroll = () => {
      if (!ticking) {
        rafId = window.requestAnimationFrame(update);
        ticking = true;
      }
    };

    // 初期同期: ページ途中に navigate 戻った場合等で scrollY > 0 の状態から始まるケースを
    // 反映する。1 回限りの mount-time 同期で cascading render は発生しない (依存値も無し)。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setScrollY(window.scrollY);

    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      // pending な rAF コールバックを破棄。残しておくと unmount 後の setState で
      // React の warning が出る (本来は無害だが将来 strict mode で問題化し得る)。
      if (rafId !== 0) window.cancelAnimationFrame(rafId);
    };
  }, []);

  return { direction, scrollY };
}
