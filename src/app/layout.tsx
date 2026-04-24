import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import './globals.css';
import { AppSessionProvider } from '@/components/session-provider';
import { auth } from '@/lib/auth';
import { toSafeThemeId } from '@/types';
import { generateThemeCss } from '@/lib/themes';

// PR #73: テーマ CSS は TS 定義 (src/lib/themes/definitions.ts) から生成し、
// HTML 組立時に <style> タグで head に注入する。モジュール読み込み時に一度だけ
// 文字列化してキャッシュし、リクエストごとの再計算を避ける。
const THEME_CSS = generateThemeCss();

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

  // PR #77: next-intl 統合。現状 locale='ja' 固定だが将来の多言語化に備えて
  // getLocale() / getMessages() を経由してサーバ側で解決する。
  const locale = await getLocale();
  const messages = await getMessages();

  return (
    <html
      lang={locale}
      data-theme={theme}
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        {/*
          PR #73: テーマ定義ファイル (src/lib/themes/definitions.ts) から生成した
          CSS を head にインライン注入する。SSR 時点で配信 HTML に含まれるため
          FOUC は発生しない。id 指定は DevTools で識別しやすくするため。

          入力は静的な色値 (oklch(...)) のみでユーザ入力を含まないが、React は
          <style> 子要素として渡した文字列を自動でテキストノード化する
          (ChildText 扱い)。CSS 値には HTML 予約文字 (<, >, &) が含まれないため
          エスケープの影響も受けない。
        */}
        <style id="tasukiba-themes">{THEME_CSS}</style>
      </head>
      <body className="flex min-h-full flex-col">
        {/*
          PR #77: next-intl の Provider。クライアントコンポーネントから
          useTranslations() を呼べるよう、サーバ側で解決した messages を注入する。
          サーバコンポーネントは getTranslations() を直接使うため Provider は不要だが、
          Provider があっても干渉しない。
        */}
        <NextIntlClientProvider locale={locale} messages={messages}>
          {/*
            PR #67: MFA 検証ページで useSession / update を使うため全ページで SessionProvider を有効化
            PR #119: session を初期値として渡す。`useFormatters()` 等が第 1 レンダリングで
            確定値を参照できるようにする (ハイドレーション安全)。
          */}
          <AppSessionProvider session={session}>{children}</AppSessionProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
