'use client';

import { signOut } from 'next-auth/react';
import { Button } from '@/components/ui/button';

type DashboardHeaderProps = {
  user: {
    name: string;
    email: string;
    systemRole: string;
  };
};

export function DashboardHeader({ user }: DashboardHeaderProps) {
  return (
    <header className="border-b bg-white">
      <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        <div className="flex items-center gap-4">
          <h1 className="text-lg font-semibold">たすきば</h1>
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
