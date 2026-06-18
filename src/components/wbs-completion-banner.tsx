'use client';

/**
 * WBS 完了バナー (v1.3.0 資産導線機能)。
 *
 * プロジェクト内の全 ACT (type='activity') が completed / on_hold のみになった際、
 * プロジェクト詳細ページのヘッダーに表示し、振り返り実施を促す。
 * 表示条件の判定はサーバ側 (getWbsCompletionBannerState) で行い、本コンポーネントは
 * 「表示すべきか」を props で受け取るだけ。実 ProjectMember ロールが pm_tl の場合のみ表示。
 *
 * ×破棄の挙動は [[system-banner-bar]] と同型 (ADR-0036 §5 と同方針):
 *   - ×で閉じると当該セッション内では再表示しない (userId + projectId スコープの sessionStorage)。
 *   - ログアウト遷移時に破棄状態を全 purge → 再ログインで再表示。
 *   - hydration 安全: 初回 render は必ず表示し、mount 後に破棄済み判定を反映する。
 */

import { useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';
import {
  isWbsCompletionBannerDismissed,
  dismissWbsCompletionBanner,
  purgeAllWbsCompletionBannerDismiss,
} from '@/lib/wbs-completion-banner-dismiss-storage';

export type WbsCompletionBannerProps = {
  projectId: string;
  shouldShow: boolean;
  isActualPmTl: boolean;
};

export function WbsCompletionBanner({ projectId, shouldShow, isActualPmTl }: WbsCompletionBannerProps) {
  const session = useSession();
  const viewerUserId = session.data?.user?.id;
  const isUnauthenticated = session.status === 'unauthenticated';
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (isUnauthenticated) purgeAllWbsCompletionBannerDismiss();
  }, [isUnauthenticated]);

  useEffect(() => {
    if (!viewerUserId) return;
    if (isWbsCompletionBannerDismissed(viewerUserId, projectId)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDismissed(true);
    }
  }, [projectId, viewerUserId]);

  if (!shouldShow || !isActualPmTl || dismissed) return null;

  const handleClose = () => {
    if (viewerUserId) dismissWbsCompletionBanner(viewerUserId, projectId);
    setDismissed(true);
  };

  return (
    <div
      role="alert"
      data-testid="wbs-completion-banner"
      className="rounded-md border border-info/30 bg-info/5 p-3 text-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="m-0">予定されているタスクがすべて完了しました。プロジェクトの振り返りは済んでいますか？</p>
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
