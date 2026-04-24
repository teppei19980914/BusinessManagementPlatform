'use client';

/**
 * Root-level error boundary (PR #115 / 2026-04-24)
 *
 * 役割:
 *   レイアウト自体が throw した際の最終的な受け皿。Next.js の仕様で、
 *   root layout を巻き戻す必要があるため <html> / <body> を自前で出す。
 *
 * ポリシー (DESIGN §9.8.5):
 *   - エラー詳細 (message / stack / digest) は /api/client-errors へ POST
 *     して system_error_logs に保存する。
 *   - 画面には機密を含み得る message を**絶対に出さず**、固定文言のみ表示する。
 *   - console.* は使わない (Next.js dev mode で自動出力される分は残るが、
 *     自分から追加で出さない)。
 */

import { useEffect } from 'react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // fire-and-forget で DB に記録 (失敗しても UI を止めない)
    void fetch('/api/client-errors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: error.message,
        stack: error.stack,
        digest: error.digest,
        source: 'global-error',
        path: typeof window !== 'undefined' ? window.location.pathname : undefined,
      }),
    }).catch(() => {
      // silent — エラー送信自体の失敗は userに影響させない
    });
  }, [error]);

  return (
    <html lang="ja">
      <body
        style={{
          display: 'flex',
          minHeight: '100vh',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'system-ui, sans-serif',
          padding: '1rem',
        }}
      >
        <div style={{ maxWidth: '32rem', textAlign: 'center' }}>
          <h1 style={{ fontSize: '1.5rem', marginBottom: '1rem' }}>
            内部エラーが発生しました
          </h1>
          <p style={{ color: '#666', marginBottom: '1.5rem' }}>
            ご迷惑をおかけしております。しばらく時間をおいて再度お試しください。
            解決しない場合はシステム管理者にお問い合わせください。
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              padding: '0.5rem 1rem',
              border: '1px solid #999',
              borderRadius: '0.25rem',
              cursor: 'pointer',
              background: '#fff',
            }}
          >
            再試行
          </button>
        </div>
      </body>
    </html>
  );
}
