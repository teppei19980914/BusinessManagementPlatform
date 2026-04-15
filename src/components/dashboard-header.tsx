'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { signOut } from 'next-auth/react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type DashboardHeaderProps = {
  user: {
    name: string;
    email: string;
    systemRole: string;
  };
};

const navItems = [
  { href: '/projects', label: 'プロジェクト' },
  { href: '/knowledge', label: 'ナレッジ', disabled: true },
];

const adminNavItems = [{ href: '/admin/users', label: 'ユーザ管理' }];

export function DashboardHeader({ user }: DashboardHeaderProps) {
  const pathname = usePathname();

  return (
    <header className="border-b bg-white">
      <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        <div className="flex items-center gap-6">
          <Link href="/projects" className="text-lg font-semibold">
            たすきば
          </Link>
          <nav className="flex items-center gap-1">
            {navItems
              .filter((item) => !item.disabled)
              .map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    'rounded-md px-3 py-1.5 text-sm transition-colors hover:bg-gray-100',
                    pathname.startsWith(item.href) ? 'bg-gray-100 font-medium' : 'text-gray-600',
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
                    'rounded-md px-3 py-1.5 text-sm transition-colors hover:bg-gray-100',
                    pathname.startsWith(item.href) ? 'bg-gray-100 font-medium' : 'text-gray-600',
                  )}
                >
                  {item.label}
                </Link>
              ))}
          </nav>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm text-gray-600">
            {user.name}
            {user.systemRole === 'admin' && (
              <span className="ml-1 rounded bg-blue-100 px-1.5 py-0.5 text-xs text-blue-700">
                管理者
              </span>
            )}
          </span>
          <Button variant="outline" size="sm" onClick={() => signOut({ callbackUrl: '/login' })}>
            ログアウト
          </Button>
        </div>
      </div>
    </header>
  );
}
