'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { signOut } from 'next-auth/react';
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

const navItems = [
  { href: PROJECTS_ROUTE, label: 'プロジェクト' },
  // PR #69: マイタスクはナビから撤去し、アカウントメニュー配下に移動した
  // (ユーザ個人専用の画面なので、共有ナビではなくアカウント文脈に寄せる)
  // 全プロジェクト横断で閲覧できるナレッジ資産（リスク/課題・振り返り・ナレッジ）。
  // プロジェクト詳細タブの「○○一覧」はそのプロジェクトに紐づく一覧、最上部タブは
  // 全プロジェクトの集約ビュー。
  // PR #60 #1: 「全リスク」「全課題」を別タブに分離
  { href: ALL_RISKS_ROUTE, label: '全リスク' },
  { href: ALL_ISSUES_ROUTE, label: '全課題' },
  { href: ALL_RETROSPECTIVES_ROUTE, label: '全振り返り' },
  { href: KNOWLEDGE_ROUTE, label: '全ナレッジ' },
  // PR #71: 公開メモの横断ビュー (個人管理はアカウントメニューの「メモ」から)
  { href: ALL_MEMOS_ROUTE, label: '全メモ' },
];

const adminNavItems = [
  // PR #111: 顧客管理 (現状 admin のみ閲覧・CRUD 可能。
  // /admin 配下ではなくトップレベル /customers に配置して将来の閲覧権限拡張に備える)
  { href: CUSTOMERS_ROUTE, label: '顧客管理' },
  { href: ADMIN_USERS_ROUTE, label: 'ユーザ管理' },
  { href: ADMIN_AUDIT_LOGS_ROUTE, label: '監査ログ' },
  { href: ADMIN_ROLE_CHANGES_ROUTE, label: '権限変更' },
];

/**
 * アカウントメニュー (PR #59 Req 6):
 *   画面右上のアカウント名をクリックすると「設定」「ログアウト」が
 *   プルダウンで表示される。外部クリック / Escape で閉じる。
 */
function AccountMenu({ user }: { user: DashboardHeaderProps['user'] }) {
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
            管理者
          </span>
        )}
        <span className="text-xs text-muted-foreground">▾</span>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-1 min-w-[160px] rounded-md border bg-card shadow-md"
        >
          {/* PR #69 Task 3: マイタスクはナビから撤去してこのメニューに配置 (個人専用画面) */}
          <Link
            href={MY_TASKS_ROUTE}
            role="menuitem"
            className="block px-4 py-2 text-sm text-foreground hover:bg-accent"
            onClick={() => setOpen(false)}
          >
            マイタスク
          </Link>
          {/*
            PR #71: ドロップダウン配下は「メモ」(個人管理画面 /memos) に改称。
            横断の「全メモ」(/all-memos) は上部ナビに移動した。
            2026-04-24: 他の一覧系メニューと命名を揃えて「メモ一覧」に改称。
          */}
          <Link
            href={MEMOS_ROUTE}
            role="menuitem"
            className="block px-4 py-2 text-sm text-foreground hover:bg-accent"
            onClick={() => setOpen(false)}
          >
            メモ一覧
          </Link>
          <Link
            href={SETTINGS_ROUTE}
            role="menuitem"
            className="block px-4 py-2 text-sm text-foreground hover:bg-accent"
            onClick={() => setOpen(false)}
          >
            設定
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
            ログアウト
          </button>
        </div>
      )}
    </div>
  );
}

export function DashboardHeader({ user }: DashboardHeaderProps) {
  const pathname = usePathname();

  return (
    <header className="border-b bg-card">
      <div className="flex h-14 items-center justify-between px-4 sm:px-6 lg:px-8">
        <div className="flex items-center gap-6">
          <Link href={PROJECTS_ROUTE} className="text-lg font-semibold">
            たすきば
          </Link>
          <nav className="flex items-center gap-1">
            {navItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'rounded-md px-3 py-1.5 text-sm transition-colors hover:bg-accent',
                  pathname.startsWith(item.href) ? 'bg-accent font-medium' : 'text-muted-foreground',
                )}
              >
                {item.label}
              </Link>
            ))}
            {user.systemRole === 'admin' &&
              adminNavItems.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    'rounded-md px-3 py-1.5 text-sm transition-colors hover:bg-accent',
                    pathname.startsWith(item.href) ? 'bg-accent font-medium' : 'text-muted-foreground',
                  )}
                >
                  {item.label}
                </Link>
              ))}
          </nav>
        </div>
        <AccountMenu user={user} />
      </div>
    </header>
  );
}
