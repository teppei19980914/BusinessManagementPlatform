'use client';

/**
 * Dashboard セグメント用 error boundary (PR #115 / 2026-04-24)
 *
 * 役割:
 *   ログイン後の (dashboard) 配下で発生した render error を捕捉し、
 *   詳細を DB (system_error_logs) に保存してから、ユーザには固定文言のみを表示する。
 *
 * ポリシー (DESIGN §9.8.5):
 *   - error.message / error.stack は **画面に出さない**。機密 (SQL 構造・env 値) を
 *     含み得るため。/api/client-errors 経由で DB に送信する。
 *   - dashboard layout の外 (ヘッダ等) は維持され、アプリ操作性を損なわない。
 */

import { useEffect } from 'react';
import { Button } from '@/components/ui/button';

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    void fetch('/api/client-errors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: error.message,
        stack: error.stack,
        digest: error.digest,
        source: 'dashboard-error',
        path: typeof window !== 'undefined' ? window.location.pathname : undefined,
      }),
    }).catch(() => {
      // silent
    });
  }, [error]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-6 text-center">
      <h2 className="text-xl font-semibold">内部エラーが発生しました</h2>
      <p className="max-w-md text-sm text-muted-foreground">
        ご迷惑をおかけしております。しばらく時間をおいて再度お試しください。
        解決しない場合はシステム管理者にお問い合わせください。
      </p>
      <Button type="button" variant="outline" onClick={reset}>
        再試行
      </Button>
    </div>
  );
}
