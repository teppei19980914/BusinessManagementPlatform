import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
import { AppSessionProvider } from '@/components/session-provider';
import { auth } from '@/lib/auth';
import { toSafeThemeId } from '@/types';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'たすきば Knowledge Relay',
  description: '知見を残す。判断をつなぐ。プロジェクトを強くする。',
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // PR #72: セッション JWT からテーマ設定を取り出し <html data-theme="..."> に出力。
  // 未ログイン時やテーマ未設定時は 'light' に fallback する。サーバ側で確定するので
  // 初回レンダリング時の「フラッシュ (light → 選択テーマに切り替わる)」は発生しない。
  const session = await auth();
  const theme = toSafeThemeId(session?.user?.themePreference);

  return (
    <html
      lang="ja"
      data-theme={theme}
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        {/* PR #67: MFA 検証ページで useSession / update を使うため全ページで SessionProvider を有効化 */}
        <AppSessionProvider>{children}</AppSessionProvider>
      </body>
    </html>
  );
}
