'use client';

/**
 * AppHeader — 全画面共通ヘッダ (feat/app-header-footer-unification / 2026-05-24)
 *
 * 統合の経緯:
 *   旧実装は 3 系統に分かれていた:
 *     1. (dashboard)/layout.tsx の DashboardHeader (ナビ + 通知ベル + AccountMenu)
 *     2. (public)/layout.tsx 内のインラインヘッダ (アプリ名 + ログイン導線のみ)
 *     3. (auth) 配下は layout.tsx 自体が存在せずヘッダ無し
 *   「同じ役割は同じ UI で表現する」設計原則に沿い、本 AppHeader 1 つに集約。
 *   `user: User | null` で表示内容を切替える:
 *     - user != null (ログイン後): ナビ + 通知ベル + AccountMenu
 *     - user == null (ログイン前): アプリ名 + ログイン導線のみ
 *
 * UX 仕様 (2026-05-24 追加):
 *   - sticky top-0 z-40 (PR #425 / KDD §5.X+112): 長いページでもナビにアクセス可能
 *   - auto-hide: 下スクロール時は translate-y-full で隠し、上スクロール時に再表示
 *     (Instagram / Twitter モバイル等で確立された現代的 UX。コンテンツの可視領域を最大化)
 *   - メニュー (AccountMenu / GroupMenu) 開放中は auto-hide を抑止: dropdown trigger が
 *     ヘッダと一緒に消えると Portal'd dropdown が宙に浮く事故を防ぐ。HeaderMenuContext で
 *     子の open 状態を集計する
 *   - 先頭 64px (SCROLL_DIRECTION_THRESHOLD) は常に visible: ページ先頭付近で勝手に
 *     消えないようにする
 *   - SortableHeader dropdown は scroll で自前 close するため抑止対象外 (本ファイルでは関知しない)
 *
 * ナビ 1 行化 (2026-05-24):
 *   - 全 nav 項目に whitespace-nowrap を付与 (ラベル中の改行を防ぐ)
 *   - flat ↔ dropdown 切替 breakpoint を旧 `lg:` (1024px) から `xl:` (1280px) に引き上げ
 *     1366/1440px ノート PC では flat モードで 1 行に収まり、それ未満では 3 分類 dropdown に切り替わる
 *
 * 認可 / セキュリティ:
 *   - adminOnly / superAdminOnly / visibleToSuperAdmin の 3 フラグで項目を出し分け
 *   - サーバ側 API でも認可判定するため UI 非表示は多層防御の 1 層 (UI 改ざんでも保護される)
 *
 * 関連:
 *   - レイアウト: src/app/(dashboard)/layout.tsx, src/app/(public)/layout.tsx, src/app/(auth)/layout.tsx
 *   - スクロール検知: src/components/hooks/use-scroll-direction.ts
 *   - フッタ: src/components/app-footer.tsx (auto-hide 対象外 / 設計判断は docblock 参照)
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Menu } from '@base-ui/react/menu';
import { ChevronDownIcon, Crown, Shield, User } from 'lucide-react';
import { cn } from '@/lib/utils';
import { NotificationBell } from '@/components/notifications/notification-bell';
import {
  SCROLL_DIRECTION_THRESHOLD,
  useScrollDirection,
} from '@/components/hooks/use-scroll-direction';
import {
  PROJECTS_ROUTE,
  ALL_RISKS_ROUTE,
  ALL_ISSUES_ROUTE,
  ALL_RETROSPECTIVES_ROUTE,
  KNOWLEDGE_ROUTE,
  ALL_MEMOS_ROUTE,
  MEMOS_ROUTE,
  MY_TASKS_ROUTE,
  SETTINGS_ROUTE,
  LOGIN_ROUTE,
  ADMIN_USERS_ROUTE,
  ADMIN_AUDIT_LOGS_ROUTE,
  ADMIN_ROLE_CHANGES_ROUTE,
  CUSTOMERS_ROUTE,
  getDiscordInviteUrl,
  GUIDE_ROUTE,
  HELP_ROUTE,
  PRODUCT_LP_URL,
} from '@/config';

/**
 * メニューを閉じた直後の「即時 hide」を防ぐための追加スクロール許容量 (px)。
 * メニュー close 時の scrollY からこの値以上さらに下にスクロールしないと hidden=true に
 * しない。10px 程度あれば「閉じた瞬間にチラッと隠れる」違和感を確実に消せ、かつ
 * 「閉じてからゆっくり下スクロール」開始時の隠れ動作は通常通り発火する。
 */
const TOLERANCE_AFTER_MENU_CLOSE = 10;

export type AppHeaderUser = {
  name: string;
  email: string;
  systemRole: string;
};

type AppHeaderProps = {
  /** ログイン後は user オブジェクト、ログイン前 (auth / public) は null を渡す */
  user: AppHeaderUser | null;
};

type NavItem = {
  href: string;
  label: string;
  adminOnly?: boolean;
  superAdminOnly?: boolean;
  visibleToSuperAdmin?: boolean;
};

type NavGroup = {
  label: string;
  adminOnly?: boolean;
  superAdminOnly?: boolean;
  items: NavItem[];
};

type NavGroupConfig = {
  labelKey: string;
  adminOnly?: boolean;
  superAdminOnly?: boolean;
  items: {
    href: string;
    labelKey: string;
    adminOnly?: boolean;
    superAdminOnly?: boolean;
    visibleToSuperAdmin?: boolean;
  }[];
};

const navGroupsConfig: NavGroupConfig[] = [
  {
    labelKey: 'groupProjects',
    items: [
      { href: PROJECTS_ROUTE, labelKey: 'allProjects' },
      { href: CUSTOMERS_ROUTE, labelKey: 'allCustomers', adminOnly: true, visibleToSuperAdmin: true },
    ],
  },
  {
    labelKey: 'groupAssets',
    items: [
      { href: ALL_RISKS_ROUTE, labelKey: 'allRisks' },
      { href: ALL_ISSUES_ROUTE, labelKey: 'allIssues' },
      { href: ALL_RETROSPECTIVES_ROUTE, labelKey: 'allRetrospectives' },
      { href: KNOWLEDGE_ROUTE, labelKey: 'allKnowledge' },
      { href: ALL_MEMOS_ROUTE, labelKey: 'allMemos' },
    ],
  },
  {
    labelKey: 'groupAdmin',
    adminOnly: true,
    items: [
      { href: ADMIN_USERS_ROUTE, labelKey: 'adminUsers' },
      { href: ADMIN_AUDIT_LOGS_ROUTE, labelKey: 'adminAuditLogs' },
      { href: ADMIN_ROLE_CHANGES_ROUTE, labelKey: 'adminRoleChanges' },
      { href: '/settings/tenant', labelKey: 'tenantSettings' },
    ],
  },
  {
    labelKey: 'groupSuperAdmin',
    superAdminOnly: true,
    items: [
      { href: '/admin/super', labelKey: 'superAdminDashboard' },
      { href: '/admin/super/tenants', labelKey: 'superAdminTenants' },
      { href: '/admin/super/usage', labelKey: 'superAdminUsage' },
    ],
  },
];

function isVisibleItem(item: NavItem, isAdmin: boolean, isSuperAdmin: boolean): boolean {
  if (item.superAdminOnly) return isSuperAdmin;
  if (item.adminOnly) return isAdmin || (item.visibleToSuperAdmin === true && isSuperAdmin);
  return true;
}

function isVisibleGroup(group: NavGroup, isAdmin: boolean, isSuperAdmin: boolean): boolean {
  if (group.superAdminOnly && !isSuperAdmin) return false;
  if (group.adminOnly && !isAdmin) return false;
  return group.items.some((it) => isVisibleItem(it, isAdmin, isSuperAdmin));
}

function isGroupActive(
  group: NavGroup,
  pathname: string,
  isAdmin: boolean,
  isSuperAdmin: boolean,
): boolean {
  return group.items.some(
    (it) => isVisibleItem(it, isAdmin, isSuperAdmin) && pathname.startsWith(it.href),
  );
}

/**
 * HeaderMenuContext — 子の dropdown 開放状態を AppHeader に集計するための共有機構。
 *
 * 目的: AccountMenu / GroupMenu が open の間 auto-hide を抑止する。複数メニューが
 *   同時に開く可能性 (実際にはほぼ無いが) を考慮し、count で管理。
 *
 * 設計判断: 別ファイル (Zustand / module-level store 等) ではなく Context にした理由は
 *   AppHeader の子 component に閉じた状態であり、グローバル共有する必要がないため。
 *   SSR 時は noop で undefined を返す。
 */
type HeaderMenuContextValue = {
  /** 子の dropdown が open になった時に呼び出す (mount/open 時) */
  notifyOpen: () => void;
  /** 子の dropdown が close になった時に呼び出す (unmount/close 時) */
  notifyClose: () => void;
};

const HeaderMenuContext = createContext<HeaderMenuContextValue | null>(null);

/**
 * 子コンポーネントが open/close 状態を AppHeader へ通知するためのフック。
 *
 * @param open - 現在の open 状態。true → false への遷移で notifyClose、その逆で notifyOpen を呼ぶ。
 *
 * **使用箇所**:
 *   - AccountMenu / GroupMenu (本ファイル内)
 *   - NotificationBell (外部 / src/components/notifications/notification-bell.tsx)
 *
 *   AppHeader 内部実装でも外部子コンポーネントでも、AppHeader 配下の dropdown が
 *   open している間は auto-hide を抑止したいので、本フックを **export** している。
 *   HeaderMenuContext を直接触らせず、フック経由に統一することで「通知忘れ」を防ぐ。
 */
export function useReportHeaderMenuOpen(open: boolean): void {
  const ctx = useContext(HeaderMenuContext);
  useEffect(() => {
    if (!ctx) return;
    if (open) {
      ctx.notifyOpen();
      return () => ctx.notifyClose();
    }
    return undefined;
  }, [ctx, open]);
}

/* -----------------------------------------------------------------------------
 * AccountMenu (ログイン後のみ表示)
 * -------------------------------------------------------------------------- */

function AccountMenu({ user }: { user: AppHeaderUser }) {
  const tNav = useTranslations('nav');
  const tAuth = useTranslations('auth');
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useReportHeaderMenuOpen(open);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="relative" ref={menuRef}>
      {/*
        トリガ (Microsoft Office 365 / Teams パターン):
          ヘッダ右上には「人アイコン + ロールアイコン + ▾」のみ表示し、名前 / メール /
          ロール文言など可変長要素は menu 開放時の「アカウント情報セクション」に集約。
          これにより narrow viewport でも見切れず、ナビ折返し事故と独立した安定 UI に。

        a11y: aria-label にロールラベルを含め、screen reader でも開く前に身元判別可能。
      */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded-md p-1.5 hover:bg-accent"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={(() => {
          const roleLabel = user.systemRole === 'super_admin'
            ? tNav('superAdminBadge')
            : user.systemRole === 'admin'
              ? tNav('adminBadge')
              : '';
          return roleLabel ? `${user.name} (${roleLabel})` : user.name;
        })()}
        title={user.name}
        data-testid="account-menu-trigger"
      >
        {/* 人アイコン (avatar 風)。将来 user.avatarUrl 対応する余地を残す */}
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <User className="size-4" />
        </span>
        {/* ロールアイコン (admin/super_admin のみ)。一般ユーザは表示なし */}
        {user.systemRole === 'super_admin' && (
          <span
            role="img"
            aria-label={tNav('superAdminBadge')}
            title={tNav('superAdminBadge')}
            className="inline-flex shrink-0 items-center text-amber-600 dark:text-amber-400"
            data-testid="role-icon-super-admin"
          >
            <Crown className="size-4" />
            <span className="sr-only">{tNav('superAdminBadge')}</span>
          </span>
        )}
        {user.systemRole === 'admin' && (
          <span
            role="img"
            aria-label={tNav('adminBadge')}
            title={tNav('adminBadge')}
            className="inline-flex shrink-0 items-center text-info"
            data-testid="role-icon-admin"
          >
            <Shield className="size-4" />
            <span className="sr-only">{tNav('adminBadge')}</span>
          </span>
        )}
        <ChevronDownIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-1 min-w-[240px] rounded-md border bg-card shadow-md"
          data-testid="account-menu-popup"
        >
          {/*
            アカウント情報セクション (Microsoft 風 menu header):
              氏名を見出しとして表示し、その下にアカウント情報 = ロール + メールアドレス を
              小さく並べる。長い氏名は break-words で複数行に折り返し、見切れさせない。
              email は selectAll しやすいよう selectable 維持 (user-select 既定)。
          */}
          <div className="border-b border-border/60 px-4 py-3" data-testid="header-account-info-section">
            <div className="flex items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <User className="size-5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="break-words text-sm font-semibold text-foreground" data-testid="header-account-info-name">
                  {user.name}
                </div>
                {user.systemRole === 'super_admin' && (
                  <div className="mt-0.5 inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400" data-testid="header-account-info-role">
                    <Crown className="size-3" />
                    {tNav('superAdminBadge')}
                  </div>
                )}
                {user.systemRole === 'admin' && (
                  <div className="mt-0.5 inline-flex items-center gap-1 text-xs text-info" data-testid="header-account-info-role">
                    <Shield className="size-3" />
                    {tNav('adminBadge')}
                  </div>
                )}
                <div className="mt-0.5 break-all text-xs text-muted-foreground" data-testid="header-account-info-email">
                  {user.email}
                </div>
              </div>
            </div>
          </div>
          <Link
            href={MY_TASKS_ROUTE}
            role="menuitem"
            className="block px-4 py-2 text-sm text-foreground hover:bg-accent"
            onClick={() => setOpen(false)}
          >
            {tNav('myTasks')}
          </Link>
          <Link
            href={MEMOS_ROUTE}
            role="menuitem"
            className="block px-4 py-2 text-sm text-foreground hover:bg-accent"
            onClick={() => setOpen(false)}
          >
            {tNav('memos')}
          </Link>
          <Link
            href={SETTINGS_ROUTE}
            role="menuitem"
            className="block px-4 py-2 text-sm text-foreground hover:bg-accent"
            onClick={() => setOpen(false)}
          >
            {tNav('settings')}
          </Link>
          <div className="my-1 border-t border-border/60" />
          <Link
            href={GUIDE_ROUTE}
            role="menuitem"
            className="block px-4 py-2 text-sm text-foreground hover:bg-accent"
            onClick={() => setOpen(false)}
          >
            <span aria-hidden className="mr-1">📘</span>
            {tNav('guide')}
          </Link>
          <Link
            href={HELP_ROUTE}
            role="menuitem"
            className="block px-4 py-2 text-sm text-foreground hover:bg-accent"
            onClick={() => setOpen(false)}
          >
            <span aria-hidden className="mr-1">❓</span>
            {tNav('help')}
          </Link>
          {/*
            feat/footer-auth-aware-links (2026-05-31): 旧フッタ + /settings/about に
            あった「バージョン / 更新履歴」導線をここに移設。ログイン後のみ到達できる
            AccountMenu 内に置くことで、未ログイン画面では露出しない。リンク先はアプリ内
            /changelog (本番では https://tasukiba.com/changelog と同一実体)。
          */}
          <Link
            href="/changelog"
            role="menuitem"
            className="block px-4 py-2 text-sm text-foreground hover:bg-accent"
            onClick={() => setOpen(false)}
            data-testid="account-menu-version-info"
          >
            <span aria-hidden className="mr-1">🆕</span>
            {tNav('versionInfo')}
          </Link>
          <a
            href={PRODUCT_LP_URL}
            target="_blank"
            rel="noopener noreferrer"
            role="menuitem"
            className="block px-4 py-2 text-sm text-foreground hover:bg-accent"
            onClick={() => setOpen(false)}
          >
            <span aria-hidden className="mr-1">🌐</span>
            サービス紹介ページ
          </a>
          {(() => {
            const discordUrl = getDiscordInviteUrl();
            if (!discordUrl) return null;
            return (
              <a
                href={discordUrl}
                target="_blank"
                rel="noopener noreferrer"
                role="menuitem"
                className="block px-4 py-2 text-sm text-foreground hover:bg-accent"
                onClick={() => setOpen(false)}
                title={tNav('contactDeveloperTooltip')}
              >
                <span aria-hidden className="mr-1">💬</span>
                {tNav('discord')}
              </a>
            );
          })()}
          <div className="my-1 border-t border-border/60" />
          <button
            type="button"
            role="menuitem"
            className="block w-full px-4 py-2 text-left text-sm text-foreground hover:bg-accent"
            onClick={async () => {
              // fix/session-clearance (2026-05-20): NextAuth 既定の signOut() は Netlify で
              //   Set-Cookie が脱落して旧 cookie 残留 → 誤ユーザログイン事故を起こすため、
              //   自前 route で tokenVersion increment + cookie 削除を実施。
              //   fetch 応答 OK を必ず確認してから navigate する (KDD §5.X+84)。
              setOpen(false);
              let res: Response | null = null;
              try {
                res = await fetch('/api/auth/explicit-signout', { method: 'POST' });
              } catch {
                // network error
              }
              if (!res || !res.ok) {
                window.alert(
                  'ログアウト処理に失敗しました。ネットワーク接続を確認のうえ、ページを再読み込みしてから再度お試しください。',
                );
                return;
              }
              window.location.href = LOGIN_ROUTE;
            }}
          >
            {tAuth('signOut')}
          </button>
        </div>
      )}
    </div>
  );
}

/* -----------------------------------------------------------------------------
 * Flat / Grouped Nav (ログイン後のみ表示)
 * -------------------------------------------------------------------------- */

/** xl: 以上のフラットナビ用 link */
function FlatNavLink({ item, pathname }: { item: NavItem; pathname: string }) {
  const active = pathname.startsWith(item.href);
  return (
    // perf/phase-4 (2026-06-01): ナビゲーション Link は prefetch={false}。
    //   全○○ (全リスク / 全課題 / 全振り返り / 全ナレッジ / 全メモ) 系は SSR で N
    //   プロジェクトを集計するヘビーなページ。default prefetch=true だと viewport 進入時
    //   (= ヘッダ表示時) に裏で 5+ ページの RSC が自動取得され、累計数百 KB & 数秒の
    //   無駄な帯域・サーバ負荷が発生する。ユーザは menu hover で 1 項目しか実際に
    //   クリックしないため、prefetch を切り on-demand 取得に倒す。
    <Link
      href={item.href}
      prefetch={false}
      className={cn(
        // whitespace-nowrap: ラベル中で改行されないように。breakpoint xl: と組み合わせて
        // 1366/1440px ノート PC で flat 全項目が 1 行に収まることを担保。
        'whitespace-nowrap rounded-md px-3 py-1.5 text-sm transition-colors hover:bg-accent',
        active ? 'bg-accent font-medium' : 'text-muted-foreground',
      )}
    >
      {item.label}
    </Link>
  );
}

/** xl: 未満の 3 分類 dropdown ナビ用 group */
function GroupMenu({
  group,
  pathname,
  isAdmin,
  isSuperAdmin,
}: {
  group: NavGroup;
  pathname: string;
  isAdmin: boolean;
  isSuperAdmin: boolean;
}) {
  const groupActive = isGroupActive(group, pathname, isAdmin, isSuperAdmin);
  // Base UI Menu の open state を捕捉して AppHeader の auto-hide 抑止に伝達する。
  // open は uncontrolled でも構わないが、ここでは onOpenChange で外部に通知するのみで
  // Menu.Root への control は渡さない (defaultOpen 等は変更しない)。
  const [open, setOpen] = useState(false);
  useReportHeaderMenuOpen(open);

  return (
    <Menu.Root onOpenChange={setOpen}>
      <Menu.Trigger
        className={cn(
          'flex items-center gap-1 whitespace-nowrap rounded-md px-3 py-1.5 text-sm transition-colors hover:bg-accent',
          groupActive ? 'bg-accent font-medium' : 'text-muted-foreground',
        )}
      >
        <span>{group.label}</span>
        <ChevronDownIcon className="size-3.5" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={4} className="isolate z-50">
          <Menu.Popup
            className={cn(
              'min-w-[180px] origin-(--transform-origin) rounded-md border bg-card text-card-foreground shadow-md',
              'data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95',
              'data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95',
            )}
          >
            {group.items
              .filter((item) => isVisibleItem(item, isAdmin, isSuperAdmin))
              .map((item) => {
                const active = pathname.startsWith(item.href);
                return (
                  <Menu.Item
                    key={item.href}
                    render={
                      // perf/phase-4 (2026-06-01): 同じ理由で dropdown menu 内も prefetch=false
                      <Link
                        href={item.href}
                        prefetch={false}
                        className={cn(
                          'block whitespace-nowrap px-4 py-2 text-sm transition-colors hover:bg-accent',
                          active ? 'bg-accent font-medium' : 'text-foreground',
                        )}
                      />
                    }
                  >
                    {item.label}
                  </Menu.Item>
                );
              })}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/* -----------------------------------------------------------------------------
 * AppHeader 本体
 * -------------------------------------------------------------------------- */

export function AppHeader({ user }: AppHeaderProps) {
  const pathname = usePathname();
  const tNav = useTranslations('nav');
  const tAuth = useTranslations('auth');

  /* --- auto-hide 制御 -------------------------------------------------- */
  const { direction, scrollY } = useScrollDirection();
  // 子の dropdown 開放数を集計。1 以上の間は auto-hide を抑止する。
  const [menuOpenCount, setMenuOpenCount] = useState(0);
  const headerMenuCtx = useMemo<HeaderMenuContextValue>(
    () => ({
      notifyOpen: () => setMenuOpenCount((c) => c + 1),
      notifyClose: () => setMenuOpenCount((c) => Math.max(0, c - 1)),
    }),
    [],
  );

  // 「メニューを閉じた直後の即時 hide」を防ぐためのベースライン。
  //   シナリオ: ユーザが下スクロール (direction='down') 中にメニューを開き、しばらく
  //   操作してから閉じる → menuOpenCount が 0 になった瞬間、direction は依然 'down' で
  //   stale なので hidden = true になりヘッダが消える UX 違和感。
  //   対策: menuOpenCount が >0 → 0 に遷移したタイミングの scrollY を記録し、その scrollY
  //   よりさらに下にスクロール (= 新規 'down' 動作) するまでは hide しない。
  //
  // 実装ノート (eslint-plugin-react-hooks 7.x の refs-during-render 対応 / KDD §5.X+122):
  //   旧実装は menuClosedAtScrollY を useRef 管理していたが、`refs-during-render` rule で
  //   「render 中の ref.current 読出」が CI fail を起こすため useState に変更。
  //   prevMenuOpenCount は **render 中に読まない** ため useRef のまま (useEffect 内のみ参照)。
  const [menuClosedAtScrollY, setMenuClosedAtScrollY] = useState<number | null>(null);
  const prevMenuOpenCountRef = useRef(0);
  useEffect(() => {
    if (prevMenuOpenCountRef.current > 0 && menuOpenCount === 0) {
      // 開→閉の遷移。現在の scrollY を baseline として記録。
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMenuClosedAtScrollY(scrollY);
    } else if (menuOpenCount > 0) {
      // メニュー開放中は baseline をクリアしておく (= 次回 close 時の値を待つ)。
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMenuClosedAtScrollY(null);
    }
    prevMenuOpenCountRef.current = menuOpenCount;
  }, [menuOpenCount, scrollY]);

  // hidden = (先頭 64px より下) かつ (下スクロール中) かつ (メニュー開放なし) かつ
  //          (メニュー閉じ直後の場合は閉じた scrollY より新規に下スクロールしている)
  // 先頭付近では常に visible にすることで、ページロード直後のチラつきとモバイルで「上に
  // 戻る → 一瞬隠れる」事故を防ぐ。
  const hidden =
    scrollY > SCROLL_DIRECTION_THRESHOLD
    && direction === 'down'
    && menuOpenCount === 0
    && (menuClosedAtScrollY === null || scrollY > menuClosedAtScrollY + TOLERANCE_AFTER_MENU_CLOSE);

  /* --- ログイン状態分岐 ------------------------------------------------ */
  const isLoggedIn = user !== null;
  const isAdmin = user?.systemRole === 'admin';
  const isSuperAdmin = user?.systemRole === 'super_admin';

  // ナビは login 状態でのみ組み立てる (ログイン前は描画しないので t() 呼び出しも不要)。
  const navGroups: NavGroup[] = useMemo(
    () =>
      isLoggedIn
        ? navGroupsConfig.map((g) => ({
            label: tNav(g.labelKey),
            adminOnly: g.adminOnly,
            superAdminOnly: g.superAdminOnly,
            items: g.items.map((it) => ({
              href: it.href,
              label: tNav(it.labelKey),
              adminOnly: it.adminOnly,
              superAdminOnly: it.superAdminOnly,
              visibleToSuperAdmin: it.visibleToSuperAdmin,
            })),
          }))
        : [],
    [isLoggedIn, tNav],
  );

  // ログイン前 (auth / public) で「ログインへ」リンクを出すか判定。/login 自体では出さない。
  const showLoginCta = !isLoggedIn && pathname !== LOGIN_ROUTE;

  // 横幅縮小時 (xl: 未満) は GroupMenu (dropdown) を使い、xl: 以上は flat に並べる。
  // 旧実装の lg: (1024px) から引き上げ、1366/1440px ノート PC では flat が 1 行に収まる。
  const flatBreakpointClass = 'hidden xl:flex';
  const groupedBreakpointClass = 'flex xl:hidden';

  /* --- レンダ ----------------------------------------------------------- */
  return (
    <HeaderMenuContext.Provider value={headerMenuCtx}>
      <header
        className={cn(
          // sticky top-0 z-40: KDD §5.X+112 / §5.X+114 で確立した「長いページでもナビ到達可能」
          // 要件。z-40 は AccountMenu dropdown (z-50) より背面、SortableHeader Portal'd
          // dropdown (z-50) と同層で last-rendered-wins。
          'sticky top-0 z-40 border-b bg-card',
          // auto-hide: transition で滑らかに、translate-y-full で完全に画面外へ。
          // motion-reduce 環境では transition を切る (即時切替で違和感を最小化)。
          //
          // KDD §5.X+123 / PR #439 chromium-mobile hotfix:
          //   旧実装は visible 状態で `translate-y-0` + `will-change-transform` を常時付与していたが、
          //   どちらも CSS stacking context を生成するため (transform != none / will-change == transform)、
          //   chromium-mobile viewport で Radix Dialog overlay (z-50) の click が AppHeader に
          //   奪われる pointer-event 順序事故が起きた (Step 11 削除 dialog / Step 3 顧客登録 dialog)。
          //   修正方針: visible 時は transform プロパティを設定せず stacking context を作らない。
          //   hidden 時のみ transform を適用 (auto-hide アニメは scroll 中なので Dialog と共存しない)。
          //   transition は `transition-transform` だけ残し、`none` ↔ `translateY(-100%)` の補間は
          //   ブラウザが matrix() 変換で扱えるため smooth animation は維持される。
          'transition-transform duration-200',
          'motion-reduce:transition-none',
          hidden && '-translate-y-full',
        )}
        data-testid="app-header"
        data-hidden={hidden ? 'true' : 'false'}
      >
        <div className="flex h-14 items-center justify-between px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-6">
            <Link
              href={isLoggedIn ? PROJECTS_ROUTE : '/'}
              className="flex items-center gap-2"
              data-testid="app-header-home"
            >
              {/*
                feat/mascot-owl (2026-05-27): 公式マスコット「たすきフクロウ」を
                ヘッダ左上に追加。
                  - デスクトップ (sm+): アイコン + 「たすきば」テキスト
                  - モバイル (sm 未満): アイコンのみ (画面幅節約 + nav へ譲る)
                  - alt は appName 文言を再利用しテキスト非表示時のアクセシビリティを担保
                priority 指定で LCP 候補要素として優先ロードさせる。
              */}
              {/*
                perf/comprehensive-perf-2026-06-01 (A-3): sizes 明示で srcset 1 解像度に固定。
                  未指定だと imageSizes default で 1x + 2x 両方が download される事例を確認。
              */}
              <Image
                src="/mascot-owl.png"
                alt={tAuth('appName')}
                width={28}
                height={28}
                priority
                sizes="28px"
                className="rounded-sm"
                data-testid="app-header-logo"
              />
              <span
                className="hidden whitespace-nowrap text-lg font-semibold sm:inline"
                data-testid="app-header-app-name"
              >
                {tAuth('appName')}
              </span>
            </Link>

            {isLoggedIn && (
              <>
                {/* xl: 以上はフラット表示 (全項目横並び、1 行に収まる) */}
                <nav className={cn('items-center gap-1', flatBreakpointClass)}>
                  {navGroups.map((group) => {
                    if (!isVisibleGroup(group, isAdmin, isSuperAdmin)) return null;
                    return group.items
                      .filter((item) => isVisibleItem(item, isAdmin, isSuperAdmin))
                      .map((item) => (
                        <FlatNavLink key={item.href} item={item} pathname={pathname} />
                      ));
                  })}
                </nav>

                {/* xl: 未満は 3 分類 dropdown */}
                <nav className={cn('items-center gap-1', groupedBreakpointClass)}>
                  {navGroups.map((group) => {
                    if (!isVisibleGroup(group, isAdmin, isSuperAdmin)) return null;
                    return (
                      <GroupMenu
                        key={group.label}
                        group={group}
                        pathname={pathname}
                        isAdmin={isAdmin}
                        isSuperAdmin={isSuperAdmin}
                      />
                    );
                  })}
                </nav>
              </>
            )}
          </div>

          <div className="flex items-center gap-1">
            {isLoggedIn && user && (
              <>
                <NotificationBell />
                <AccountMenu user={user} />
              </>
            )}
            {showLoginCta && (
              <Link
                href={LOGIN_ROUTE}
                className="whitespace-nowrap rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent"
                data-testid="app-header-login"
              >
                {tAuth('loginButton')}
              </Link>
            )}
          </div>
        </div>
      </header>
    </HeaderMenuContext.Provider>
  );
}
