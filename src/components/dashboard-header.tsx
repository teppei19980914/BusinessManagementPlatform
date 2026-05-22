'use client';

/**
 * ダッシュボード共通ヘッダ (PR #127 で 3 分類ハイブリッドナビに再構築)。
 *
 * 構成:
 *   - 広い画面 (lg:+ 1024px~): 全ナビ項目をフラット表示 (従来踏襲)
 *   - 狭い画面 (lg: 未満): 「プロジェクト」「資産」「システム管理者」の 3 分類プルダウン
 *
 * 分類 (PR #127):
 *   - プロジェクト: 全プロジェクト / 全顧客管理 (admin のみ)
 *     - 全見積もり / 全 WBS は未実装 (routes 不在)、実装時にここへ追加
 *   - 資産: 全リスク / 全課題 / 全振り返り / 全ナレッジ / 全メモ
 *   - システム管理者 (admin のみ): ユーザ管理 / 監査ログ / 権限変更
 *
 * アクティブ表示:
 *   - フラットモード: 現在のページを bg-accent + font-medium で強調 (従来)
 *   - プルダウンモード:
 *     - 親タブは配下のどれかが現在のページなら bg-accent
 *     - プルダウン内の子項目も現在のページなら bg-accent
 *
 * セキュリティ / 認可:
 *   - adminOnly: true の項目は session.user.systemRole === 'admin' のみレンダ
 *   - サーバ側 API でも認可判定されるため UI 側の非表示だけを前提にはしない (多層防御)
 *
 * 関連:
 *   - SPECIFICATION.md §11 (ナビゲーション)
 *   - DEVELOPER_GUIDE.md §5.x (UI 改修手順)
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Menu } from '@base-ui/react/menu';
import { ChevronDownIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
// PR feat/notifications-mvp: アカウント名の左に通知ベル UI を配置
import { NotificationBell } from '@/components/notifications/notification-bell';
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
  // 2026-05-09 (#16): Discord 招待リンク (環境変数 NEXT_PUBLIC_DISCORD_INVITE_URL で上書き可能)
  getDiscordInviteUrl,
  // 2026-05-09 (PR I): ヘルプ画面 / 使い方ガイド (機能要望リンクは /help 画面側で参照)
  GUIDE_ROUTE,
  HELP_ROUTE,
  // 2026-05-11: AccountMenu に LP 集約 (各ページ末尾の重複を削減)
  PRODUCT_LP_URL,
} from '@/config';

type DashboardHeaderProps = {
  user: {
    name: string;
    email: string;
    systemRole: string;
  };
};

type NavItem = {
  href: string;
  label: string;
  /** true なら systemRole='admin' のみに表示 (PR #127) */
  adminOnly?: boolean;
  /** PR-X3 (2026-05-07): true なら systemRole='super_admin' のみに表示 */
  superAdminOnly?: boolean;
  /**
   * 2026-05-14: adminOnly 項目を super_admin にも表示する。
   *   管理テナント (super_admin 所属) のシードデータ管理に既存 admin 画面を流用するため、
   *   nav 上は admin と super_admin の両方に項目を露出させる必要がある。
   *   サービス層は session.user.tenantId (= super_admin の場合 MANAGEMENT_TENANT_ID) で
   *   自動的に管理テナントスコープとなるため、画面・API ロジック自体は変更不要。
   */
  visibleToSuperAdmin?: boolean;
};

type NavGroup = {
  label: string;
  /** グループ全体を admin のみに表示 (例: テナント管理者タブ) */
  adminOnly?: boolean;
  /** PR-X3: グループ全体を super_admin のみに表示 (例: システム管理者タブ) */
  superAdminOnly?: boolean;
  items: NavItem[];
};

// PR #127: 3 分類ナビ構造 (Phase C-2 i18n: ラベルは t() で動的解決するため
// useMemo で component 内に移動。設定スキーマは config として残す)
//   TODO (DEVELOPER_GUIDE §11 に記載): 全見積もり / 全 WBS 横断画面を実装したら
//   プロジェクトタブ配下に追加する (routes 未定義のため現時点は該当項目を含めない)
type NavGroupConfig = {
  labelKey: string;
  adminOnly?: boolean;
  superAdminOnly?: boolean;
  items: {
    href: string;
    labelKey: string;
    adminOnly?: boolean;
    superAdminOnly?: boolean;
    /** 2026-05-14: adminOnly 項目を super_admin にも露出させるフラグ (NavItem 同義) */
    visibleToSuperAdmin?: boolean;
  }[];
};

const navGroupsConfig: NavGroupConfig[] = [
  {
    labelKey: 'groupProjects',
    items: [
      { href: PROJECTS_ROUTE, labelKey: 'allProjects' },
      // 2026-05-14: super_admin にも露出。管理テナントの Customer シードを本画面で CRUD する。
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
      // PR-X3 (2026-05-07): テナント管理者がプラン・予算上限を変更できる画面 (PR-X4)
      { href: '/settings/tenant', labelKey: 'tenantSettings' },
    ],
  },
  // PR-X3 (2026-05-07): super_admin (システム管理者) 専用ナビゲーション
  {
    labelKey: 'groupSuperAdmin',
    superAdminOnly: true,
    items: [
      { href: '/admin/super', labelKey: 'superAdminDashboard' },
      { href: '/admin/super/tenants', labelKey: 'superAdminTenants' },
      { href: '/admin/super/usage', labelKey: 'superAdminUsage' },
    ],
  },
  // PR I hotfix (2026-05-09 / E2E §4.44): ヘルプグループはヘッダから外し、AccountMenu に移動。
  // 経緯: 当初は groupHelp として top-nav に配置していたが、chromium-mobile (iPhone 13 / 390px)
  //   で既存 admin 4 グループ + 1 = 5 グループとなり、モバイル時の横方向 overflow が +6px 拡大
  //   (主要ダッシュボード snapshot の `fullPage: true` 幅が 402→408px、高さも 685→695px)。
  //   横スクロール痕跡を増やすことになるため取り消し、設定/マイタスクと同じ AccountMenu 内に格納。
  //   こうすることでヘッダ幅は変化なく、新規ユーザは右上 (アカウント名) → ドロップダウンから到達可能。
  // 詳細: docs/test/E2E_LESSONS_LEARNED.md §4.44
];

/** 指定 item がユーザに表示可能か (adminOnly / superAdminOnly を考慮、PR-X3 拡張) */
function isVisibleItem(item: NavItem, isAdmin: boolean, isSuperAdmin: boolean): boolean {
  if (item.superAdminOnly) return isSuperAdmin;
  // 2026-05-14: visibleToSuperAdmin が true なら adminOnly でも super_admin に表示する。
  //   管理テナントのシードデータ管理 (Customer 等) で既存 admin 画面を流用するため。
  if (item.adminOnly) return isAdmin || (item.visibleToSuperAdmin === true && isSuperAdmin);
  return true;
}

/** 指定グループがユーザに表示可能か */
function isVisibleGroup(group: NavGroup, isAdmin: boolean, isSuperAdmin: boolean): boolean {
  if (group.superAdminOnly && !isSuperAdmin) return false;
  if (group.adminOnly && !isAdmin) return false;
  return group.items.some((it) => isVisibleItem(it, isAdmin, isSuperAdmin));
}

/** 指定 pathname が group 内のどれかの item にマッチするか (親タブのアクティブ判定用) */
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
 * アカウントメニュー (PR #59 Req 6):
 *   画面右上のアカウント名をクリックすると「設定」「ログアウト」が
 *   プルダウンで表示される。外部クリック / Escape で閉じる。
 *
 *   PR #127 では既存実装を踏襲 (ナビ再構築スコープ外)。
 */
function AccountMenu({ user }: { user: DashboardHeaderProps['user'] }) {
  const tNav = useTranslations('nav');
  const tAuth = useTranslations('auth');
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

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
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-accent"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span>{user.name}</span>
        {/* PR-X3 (2026-05-07): super_admin / admin で異なる Badge を表示 */}
        {user.systemRole === 'super_admin' && (
          <span className="rounded bg-amber-200/70 px-1.5 py-0.5 text-xs text-amber-900 dark:bg-amber-900/40 dark:text-amber-200">
            {tNav('superAdminBadge')}
          </span>
        )}
        {user.systemRole === 'admin' && (
          <span className="rounded bg-info/20 px-1.5 py-0.5 text-xs text-info">
            {tNav('adminBadge')}
          </span>
        )}
        <span className="text-xs text-muted-foreground">▾</span>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-1 min-w-[160px] rounded-md border bg-card shadow-md"
        >
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
          {/* 2026-05-11: ヘルプ系 + 外部リンク (LP/FAQ/Discord) を AccountMenu に一元集約。
              旧仕様では各ページ末尾 (/guide, /help) + ヘッダ右 (DiscordLinkButton) に重複配置されていたが、
              「ユーザの手が届きやすい固定位置 (右上)」に集約することで重複を削減した。 */}
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
          {/* 2026-05-11: サービス紹介ページ (LP)。旧仕様では /guide ヘッダ + /guide 末尾 + /help 末尾 の 3 箇所に重複していた。 */}
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
          {/* 2026-05-11: Discord をヘッダ右の DiscordLinkButton (sm:以上のみ表示) から AccountMenu に一元化。
              これにより mobile 含む全ビューポートで右上から 1 タップで到達可能、かつヘッダ overflow 懸念も解消。 */}
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
              //   自前 route で tokenVersion increment + cookie 削除 (auth 4 + theme 1) を実施。
              //
              // 2026-05-20 follow-up (フルスキャン Severity-1): fetch 応答 OK を**必ず確認**してから navigate する。
              //   応答失敗 (DB 一時障害で tokenVersion increment 失敗等) で 500 が返った場合に
              //   そのまま navigate すると「ユーザは log out したつもりだが server 側は無効化されていない」
              //   状態に陥り、本 PR の P0 目標 (誤ユーザ login 防止) を達成できないため。
              //   詳細: KDD §5.X+84
              setOpen(false);
              let res: Response | null = null;
              try {
                res = await fetch('/api/auth/explicit-signout', { method: 'POST' });
              } catch {
                // network error
              }
              if (!res || !res.ok) {
                // alert で UX 上明示。ユーザが再試行できるよう navigate しない
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

/** lg: 以上のフラットナビ用の個別リンク */
function FlatNavLink({ item, pathname }: { item: NavItem; pathname: string }) {
  const active = pathname.startsWith(item.href);
  return (
    <Link
      href={item.href}
      className={cn(
        'rounded-md px-3 py-1.5 text-sm transition-colors hover:bg-accent',
        active ? 'bg-accent font-medium' : 'text-muted-foreground',
      )}
    >
      {item.label}
    </Link>
  );
}

/** lg: 未満の 3 分類プルダウンナビ用のグループ */
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
  return (
    <Menu.Root>
      <Menu.Trigger
        className={cn(
          'flex items-center gap-1 rounded-md px-3 py-1.5 text-sm transition-colors hover:bg-accent',
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
                      <Link
                        href={item.href}
                        className={cn(
                          'block px-4 py-2 text-sm transition-colors hover:bg-accent',
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

// 2026-05-11: DiscordLinkButton (旧 #16, sm:以上のみ表示) を削除。
//   AccountMenu に一元集約したため、ヘッダ右側の重複配置を解消。
//   mobile (< 640px) でも右上アカウントメニューから 1 タップで到達可能になり、
//   従来の「モバイルでヘッダから Discord に行けない」問題も同時に解消した。

export function DashboardHeader({ user }: DashboardHeaderProps) {
  const pathname = usePathname();
  const tNav = useTranslations('nav');
  const tAuth = useTranslations('auth');
  // PR-X3 (2026-05-07): 「テナント管理者」(= admin) と「システム管理者」(= super_admin) を別判定。
  // 既存の `=== 'admin'` 比較は「テナント管理者」のみを意味するよう厳密化 (super_admin は別系統)。
  const isAdmin = user.systemRole === 'admin';
  const isSuperAdmin = user.systemRole === 'super_admin';

  // Phase C-2: ラベルキーを t() で解決して NavGroup[] を組み立てる。
  // sub-component (FlatNavLink / GroupMenu) は localized 済の `label` を受け取るだけ。
  const navGroups: NavGroup[] = useMemo(
    () =>
      navGroupsConfig.map((g) => ({
        label: tNav(g.labelKey),
        adminOnly: g.adminOnly,
        superAdminOnly: g.superAdminOnly,
        items: g.items.map((it) => ({
          href: it.href,
          label: tNav(it.labelKey),
          adminOnly: it.adminOnly,
          superAdminOnly: it.superAdminOnly,
          // 2026-05-14: 管理テナントのシード CRUD で super_admin にも露出させるフラグを伝搬
          visibleToSuperAdmin: it.visibleToSuperAdmin,
        })),
      })),
    [tNav],
  );

  return (
    // PR #425 (2026-05-22) KDD §5.X+112: 長いページでもヘッダ (全ナレッジ/全メモ等) に
    //   常にアクセスできるよう sticky top-0 + z-40 で固定。
    //   - z-40: AccountMenu 内 dropdown (z-50) 配下、SortableHeader dropdown (z-30) より前面。
    //   - 親 (DashboardLayout) は overflow を設定していないので sticky が効く。
    <header className="sticky top-0 z-40 border-b bg-card">
      <div className="flex h-14 items-center justify-between px-4 sm:px-6 lg:px-8">
        <div className="flex items-center gap-6">
          <Link href={PROJECTS_ROUTE} className="text-lg font-semibold">
            {tAuth('appName')}
          </Link>

          {/* PR #127: lg: 以上はフラット表示 (全項目横並び、従来挙動) */}
          <nav className="hidden items-center gap-1 lg:flex">
            {navGroups.map((group) => {
              if (!isVisibleGroup(group, isAdmin, isSuperAdmin)) return null;
              return group.items
                .filter((item) => isVisibleItem(item, isAdmin, isSuperAdmin))
                .map((item) => (
                  <FlatNavLink key={item.href} item={item} pathname={pathname} />
                ));
            })}
          </nav>

          {/* PR #127: lg: 未満は 3 分類プルダウン */}
          <nav className="flex items-center gap-1 lg:hidden">
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
        </div>
        <div className="flex items-center gap-1">
          {/* 2026-05-11: Discord 等の外部リンクは AccountMenu に集約 (重複削減 + mobile 対応)。
              ヘッダ右は通知ベル + アカウントメニューのみのシンプル構成に。 */}
          {/* PR feat/notifications-mvp: アカウント名の左に通知ベルを配置 */}
          <NotificationBell />
          <AccountMenu user={user} />
        </div>
      </div>
    </header>
  );
}
