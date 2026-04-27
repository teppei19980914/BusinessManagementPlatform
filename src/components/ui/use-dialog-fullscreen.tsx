'use client';

/**
 * useDialogFullscreen — ダイアログの「全画面トグル」UI を提供する再利用 hook (PR feat/dialog-fullscreen-toggle)。
 *
 * 背景:
 *   リスク/課題/振り返り/ナレッジ/メモの編集・作成 dialog は文字量が多くなる
 *   ケースが多く、既定の `max-w-[min(90vw,36rem)]` (PC で 576px 上限) では狭く
 *   感じる声が上がった。dialog 上部に「全画面」トグルボタンを置き、ON のとき
 *   90vw × 90vh (どの画面でも 90%) に拡大する設計に統一する。
 *
 * 使い方:
 *   const { fullscreenClassName, FullscreenToggle } = useDialogFullscreen();
 *
 *   <DialogContent className={`max-w-[min(90vw,36rem)] max-h-[80vh] overflow-y-auto ${fullscreenClassName}`}>
 *     <DialogHeader>
 *       <div className="flex items-center justify-between gap-2">
 *         <DialogTitle>...</DialogTitle>
 *         <FullscreenToggle />
 *       </div>
 *     </DialogHeader>
 *     ...
 *
 * 設計判断:
 *   - state は dialog ごとにローカル (sessionStorage 永続化なし、開き直すと既定に戻る)
 *   - `!important` (`!`) 修飾子で base / caller の max-w/max-h を上書き
 *   - mobile / PC 区別なし「どの画面でも 90%」を貫く (要求仕様より)
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from './button';

export type UseDialogFullscreenResult = {
  isFullscreen: boolean;
  /** DialogContent に追加で渡す className。トグル ON のとき 90vw × 90vh を強制。 */
  fullscreenClassName: string;
  /** dialog ヘッダ右側に置くトグルボタン。ON/OFF 切り替えで状態が反転。 */
  FullscreenToggle: React.FC;
};

export function useDialogFullscreen(): UseDialogFullscreenResult {
  const t = useTranslations('common');
  const [isFullscreen, setIsFullscreen] = useState(false);

  // `!` (Tailwind important 修飾子) で base / caller 側の max-w-[min(...)] や max-h を上書き。
  // w/h を 90vw/90vh に固定し、max-w/max-h は同値にして上限を取り払う。
  const fullscreenClassName = isFullscreen
    ? '!w-[90vw] !max-w-[90vw] !h-[90vh] !max-h-[90vh]'
    : '';

  const FullscreenToggle: React.FC = () => (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-7 shrink-0 px-2 text-xs"
      onClick={() => setIsFullscreen((v) => !v)}
      aria-label={isFullscreen ? t('normalViewAria') : t('fullscreenAria')}
    >
      {isFullscreen ? t('normalView') : t('fullscreen')}
    </Button>
  );

  return { isFullscreen, fullscreenClassName, FullscreenToggle };
}
