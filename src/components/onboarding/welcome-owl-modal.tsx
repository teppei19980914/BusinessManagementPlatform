'use client';

/**
 * G2-e-3 / G2-e-4 (2026-05-31): 初回ログインユーザ向けオンボーディング (たすきフクロウ)。
 *
 * 構成:
 *   - WelcomeOwlModal: 表示専用のウェルカムモーダル (ヘルプ導線ハブ)。チャット FAB / 使い方ガイド /
 *     よくある質問 / Discord への 4 導線 + 「案内を閉じる」。チャットは FAB に一本化しているため
 *     主 CTA は requestOpenHelpChat() で画面右下の FAB を「ヘルプ・ガイド」タブで開く。
 *   - WelcomeOwlAutoOpen: 初回ログイン (isFirstTimeUser) 時に /projects 等の着地で 1 回だけ自動表示する
 *     コントローラ。super_admin (運営者) は対象外。当セッション表示済は sessionStorage で抑止し、
 *     ユーザ ID 分離 (別ユーザログイン時は再評価) する。DashboardLayout に常駐させる。
 *   - WelcomeOwlReplayButton: /help に置く「もう一度見る」ボタン。表示と検知を疎結合にし、
 *     認証状態を触らず何度でもモーダルを再現できる (デモ・回帰テスト・閉じたユーザの再閲覧)。
 *
 * 世界観: オンボーディングはたすきフクロウの世界観を前面に出してよい面
 *   ([[feedback_worldview_scope_onboarding_chat_only]])。
 */

import { useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { GUIDE_ROUTE, HELP_ROUTE, getDiscordInviteUrl } from '@/config';
import { requestOpenHelpChat } from '@/lib/open-help-chat';

/** 当セッションでウェルカムモーダルを表示済のユーザ ID を保持する (once ガード + ユーザ分離)。 */
const SHOWN_STORAGE_KEY = 'tasukiba_onboarding_welcome_shown_v1';

const LINK_BUTTON_CLASS =
  'inline-flex w-full items-center justify-center gap-1.5 rounded-md border bg-card px-3 py-2 text-sm font-medium hover:bg-accent';

/**
 * 表示専用のウェルカムモーダル (ロール非依存のヘルプ導線ハブ)。
 */
export function WelcomeOwlModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const discord = getDiscordInviteUrl();
  const close = () => onOpenChange(false);
  const handleAskOwl = () => {
    // チャットは FAB に一本化。画面遷移せず右下の FAB を「ヘルプ・ガイド」タブで開く。
    requestOpenHelpChat();
    close();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="welcome-owl-modal"
        className="sm:max-w-[min(92vw,30rem)]"
      >
        <DialogHeader className="items-center text-center">
          <Image
            src="/mascot-owl.png"
            alt="たすきフクロウ"
            width={72}
            height={72}
            className="mx-auto rounded-lg object-cover"
          />
          <DialogTitle className="text-base leading-relaxed">
            たすきばへようこそ！私、たすきフクロウがご案内します 🦉
          </DialogTitle>
          <DialogDescription className="leading-relaxed">
            使い方に迷ったら、画面右下の私 (🦉 アイコン) にいつでも話しかけてくださいね。
            下のいずれからでもお調べいただけます。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          <Button
            type="button"
            onClick={handleAskOwl}
            data-testid="welcome-owl-cta-chat"
            className="w-full"
          >
            🦉 たすきフクロウに聞いてみる
          </Button>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Link
              href={GUIDE_ROUTE}
              onClick={close}
              data-testid="welcome-owl-cta-guide"
              className={LINK_BUTTON_CLASS}
            >
              📘 使い方ガイド
            </Link>
            <Link
              href={HELP_ROUTE}
              onClick={close}
              data-testid="welcome-owl-cta-help"
              className={LINK_BUTTON_CLASS}
            >
              ❓ よくある質問
            </Link>
          </div>
          {discord && (
            <a
              href={discord}
              target="_blank"
              rel="noopener noreferrer"
              onClick={close}
              data-testid="welcome-owl-cta-discord"
              className={LINK_BUTTON_CLASS}
            >
              💬 コミュニティ（Discord）をのぞいてみる
            </a>
          )}
        </div>

        <p className="text-xs text-muted-foreground">
          この案内は「よくある質問」ページの「🦉 はじめてのご案内をもう一度見る」ボタンから、いつでも開けます。
        </p>

        <div className="flex justify-center">
          <Button
            type="button"
            variant="ghost"
            onClick={close}
            data-testid="welcome-owl-close"
          >
            案内を閉じる
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 初回ログイン時に 1 回だけウェルカムモーダルを自動表示するコントローラ。
 * DashboardLayout に常駐させ、認証済 + isFirstTimeUser + 非 super_admin + 当セッション未表示の
 * ときだけ open する。
 */
export function WelcomeOwlAutoOpen() {
  const session = useSession();
  const [open, setOpen] = useState(false);
  const evaluatedRef = useRef(false);

  const status = session.status;
  const user = session.data?.user;
  const userId = user?.id;
  const systemRole = user?.systemRole;
  const isFirstTimeUser = user?.isFirstTimeUser;

  useEffect(() => {
    if (status !== 'authenticated' || !userId) return;
    if (evaluatedRef.current) return;

    // 運営者 (super_admin) は対象外 / 初回ログインでなければ表示しない。
    if (systemRole === 'super_admin') return;
    if (!isFirstTimeUser) return;

    // 当セッションで既に「閉じた」ユーザなら再表示しない (= 同じユーザ ID)。
    let shownFor: string | null = null;
    try {
      shownFor = window.sessionStorage.getItem(SHOWN_STORAGE_KEY);
    } catch {
      // private browsing 等は素通り (= 表示する)
    }
    if (shownFor === userId) return;

    evaluatedRef.current = true;
    // 認証ライフサイクルと React state の一回限りの橋渡し。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOpen(true);
  }, [status, userId, systemRole, isFirstTimeUser]);

  // once ガードは「開いた時」ではなく「閉じた時」に書く。ログイン直後は
  //   (auth)→(dashboard) のレイアウト切替で本コンポーネントが transient に
  //   マウント→アンマウント→再マウントし得る。開いた時に書くと、最初のマウントで
  //   モーダルが一瞬出た直後に再マウントで open state が失われ、再評価では
  //   shownFor===userId に阻まれて二度と開かず「一瞬出て消える」事故になる
  //   (#476 e2e の transient レンダー観測と同根)。dismiss 時に書けば、過渡的な
  //   再マウントでは guard 未設定のまま開き直され、ユーザが実際に閉じて初めて抑止される。
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next && userId) {
      try {
        window.sessionStorage.setItem(SHOWN_STORAGE_KEY, userId);
      } catch {
        // noop
      }
    }
  };

  return <WelcomeOwlModal open={open} onOpenChange={handleOpenChange} />;
}

/**
 * /help に置く「はじめてのご案内をもう一度見る」ボタン。手動でモーダルを開く。
 * super_admin には表示しない (auto-open と同方針)。
 */
export function WelcomeOwlReplayButton() {
  const session = useSession();
  const [open, setOpen] = useState(false);

  if (session.data?.user?.systemRole === 'super_admin') return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="welcome-owl-replay"
        className="inline-flex items-center gap-1.5 rounded-md border bg-card px-3 py-1.5 text-sm hover:bg-accent"
      >
        🦉 はじめてのご案内をもう一度見る
      </button>
      <WelcomeOwlModal open={open} onOpenChange={setOpen} />
    </>
  );
}
