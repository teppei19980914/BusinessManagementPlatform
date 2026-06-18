'use client';

/**
 * システム周知バナー 表示帯 (ADR-0036)。
 *
 * dashboard layout の上部 (DegradedModeBanner 直下) に描画する。サーバ側で取得した
 * 「今表示すべきバナー」を props で受け取り、緊急度に応じた色 (高=赤 / 中=黄 / 低=青) で表示する。
 *
 * ×破棄の挙動 (ADR-0036 §5):
 *   - ×で閉じると当該セッション内では再表示しない (userId スコープの sessionStorage)。
 *   - ログアウト (status='unauthenticated') 遷移時に破棄状態を全 purge → 再ログインで再表示。
 *   - **hydration 安全**: 初回 render は必ず表示し、mount 後に破棄済み判定を反映する
 *     (SSR と最初の client render を一致させ React 19 のミスマッチを避ける)。
 */

import { useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';
import { BANNER_SEVERITY_CLASSES, type BannerSeverity } from '@/lib/validators/system-banner';
import {
  isBannerDismissed,
  dismissBanner,
  purgeAllBannerDismiss,
} from '@/lib/banner-dismiss-storage';
import { linkifyNodes } from '@/components/ui/linkified-text';

export type SystemBannerBarProps = {
  banner: { id: string; message: string; severity: BannerSeverity } | null;
};

export function SystemBannerBar({ banner }: SystemBannerBarProps) {
  const session = useSession();
  const viewerUserId = session.data?.user?.id;
  const isUnauthenticated = session.status === 'unauthenticated';
  const [dismissed, setDismissed] = useState(false);

  // ログアウト遷移時に破棄状態を全 purge する (再ログイン後に期間内なら再表示させるため)。
  useEffect(() => {
    if (isUnauthenticated) purgeAllBannerDismiss();
  }, [isUnauthenticated]);

  // mount 後 (userId 確定後) に「このバナーを既に×で閉じたか」を反映する。
  useEffect(() => {
    if (!banner || !viewerUserId) return;
    if (isBannerDismissed(viewerUserId, banner.id)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDismissed(true);
    }
  }, [banner, viewerUserId]);

  if (!banner || dismissed) return null;

  const handleClose = () => {
    if (viewerUserId) dismissBanner(viewerUserId, banner.id);
    setDismissed(true);
  };

  return (
    <div
      role="alert"
      data-testid="system-banner"
      data-severity={banner.severity}
      className={`border-b px-4 py-2 text-sm ${BANNER_SEVERITY_CLASSES[banner.severity]}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="whitespace-pre-wrap break-words [&_a]:text-current [&_a]:font-semibold">
          {linkifyNodes(banner.message)}
        </p>
        <button
          type="button"
          onClick={handleClose}
          aria-label="このお知らせを閉じる"
          className="shrink-0 rounded p-1 leading-none opacity-80 hover:bg-black/10 hover:opacity-100"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
