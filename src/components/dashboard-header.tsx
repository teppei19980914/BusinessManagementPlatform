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
import { signOut } from 'next-auth/react';
import { useTranslations } from 'next-intl';
import { Menu } from '@base-ui/react/menu';
import { ChevronDownIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
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
};

type NavGroup = {
  label: string;
  /** グループ全体を admin のみに表示 (例: システム管理者タブ) */
  adminOnly?: boolean;
  items: NavItem[];
};

// PR #127: 3 分類ナビ構造 (Phase C-2 i18n: ラベルは t() で動的解決するため
// useMemo で component 内に移動。設定スキーマは config として残す)
//   TODO (DEVELOPER_GUIDE §11 に記載): 全見積もり / 全 WBS 横断画面を実装したら
//   プロジェクトタブ配下に追加する (routes 未定義のため現時点は該当項目を含めない)
type NavGroupConfig = {
  labelKey: string;
  adminOnly?: boolean;
  items: { href: string; labelKey: string; adminOnly?: boolean }[];
};

const navGroupsConfig: NavGroupConfig[] = [
  {
    labelKey: 'groupProjects',
    items: [
      { href: PROJECTS_ROUTE, labelKey: 'allProjects' },
      { href: CUSTOMERS_ROUTE, labelKey: 'allCustomers', adminOnly: true },
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
    ],
  },
];

/** 指定 item がユーザに表示可能か (adminOnly を考慮) */
function isVisibleItem(item: NavItem, isAdmin: boolean): boolean {
  return !item.adminOnly || isAdmin;
}

/** 指定グループがユーザに表示可能か (adminOnly または表示可能 item が 0 件なら非表示) */
function isVisibleGroup(group: NavGroup, isAdmin: boolean): boolean {
  if (group.adminOnly && !isAdmin) return false;
  return group.items.some((it) => isVisibleItem(it, isAdmin));
}

/** 指定 pathname が group 内のどれかの item にマッチするか (親タブのアクティブ判定用) */
function isGroupActive(group: NavGroup, pathname: string, isAdmin: boolean): boolean {
  return group.items.some(
    (it) => isVisibleItem(it, isAdmin) && pathname.startsWith(it.href),
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
          <button
            type="button"
            role="menuitem"
            className="block w-full px-4 py-2 text-left text-sm text-foreground hover:bg-accent"
            onClick={() => {
              setOpen(false);
              signOut({ callbackUrl: LOGIN_ROUTE });
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
}: {
  group: NavGroup;
  pathname: string;
  isAdmin: boolean;
}) {
  const groupActive = isGroupActive(group, pathname, isAdmin);
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
              .filter((item) => isVisibleItem(item, isAdmin))
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

export function DashboardHeader({ user }: DashboardHeaderProps) {
  const pathname = usePathname();
  const tNav = useTranslations('nav');
  const tAuth = useTranslations('auth');
  const isAdmin = user.systemRole === 'admin';

  // Phase C-2: ラベルキーを t() で解決して NavGroup[] を組み立てる。
  // sub-component (FlatNavLink / GroupMenu) は localized 済の `label` を受け取るだけ。
  const navGroups: NavGroup[] = useMemo(
    () =>
      navGroupsConfig.map((g) => ({
        label: tNav(g.labelKey),
        adminOnly: g.adminOnly,
        items: g.items.map((it) => ({
          href: it.href,
          label: tNav(it.labelKey),
          adminOnly: it.adminOnly,
        })),
      })),
    [tNav],
  );

  return (
    <header className="border-b bg-card">
      <div className="flex h-14 items-center justify-between px-4 sm:px-6 lg:px-8">
        <div className="flex items-center gap-6">
          <Link href={PROJECTS_ROUTE} className="text-lg font-semibold">
            {tAuth('appName')}
          </Link>

          {/* PR #127: lg: 以上はフラット表示 (全項目横並び、従来挙動) */}
          <nav className="hidden items-center gap-1 lg:flex">
            {navGroups.map((group) => {
              if (!isVisibleGroup(group, isAdmin)) return null;
              return group.items
                .filter((item) => isVisibleItem(item, isAdmin))
                .map((item) => (
                  <FlatNavLink key={item.href} item={item} pathname={pathname} />
                ));
            })}
          </nav>

          {/* PR #127: lg: 未満は 3 分類プルダウン */}
          <nav className="flex items-center gap-1 lg:hidden">
            {navGroups.map((group) => {
              if (!isVisibleGroup(group, isAdmin)) return null;
              return (
                <GroupMenu
                  key={group.label}
                  group={group}
                  pathname={pathname}
                  isAdmin={isAdmin}
                />
              );
            })}
          </nav>
        </div>
        <AccountMenu user={user} />
      </div>
    </header>
  );
}
