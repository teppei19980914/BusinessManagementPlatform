import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { Geist, Geist_Mono } from 'next/font/google';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages, getTranslations } from 'next-intl/server';
import './globals.css';
import { AppFooter } from '@/components/app-footer';
import { AppSessionProvider } from '@/components/session-provider';
import { auth } from '@/lib/auth';
import { toSafeThemeId } from '@/types';
import { THEME_COOKIE_NAME } from '@/config/themes';
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

// PR #175 Phase C-final: locale 連動の metadata。`getTranslations()` は
// SSR 時に next-intl の locale (auth().user.locale or system default) を解決済。
//
// 2026-05-19 (docs/2026-05-19-roadmap-archive): OG metadata 追加。
//   SNS シェア時のプレビュー対応。og-image.png (1200x630) は public/ に配置
//   (現在はプレースホルダ、デザイン確定後に差し替え)。
//   詳細: docs/operations/PUBLIC_LAUNCH_CHECKLIST.md §2.2
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('app');
  const title = t('metaTitle');
  const description = t('metaDescription');
  // ★severity-low (SEO / SNS シェア)★ PR #471 (2026-05-30):
  //   metadataBase を明示しないと Next.js が relative URL (例: '/og-image.png') を
  //   解決する基準を `http://localhost:3000` でフォールバックし、本番で OG image /
  //   Twitter card のプレビュー画像 URL が壊れる。NEXTAUTH_URL を優先採用、
  //   未設定 (= dev preview 等) は production URL でフォールバック。
  //   build/runtime 両方で同じ logic、Server Component なので env は直接参照可。
  const baseUrl =
    process.env.NEXTAUTH_URL?.trim() || 'https://tasukiba.com';
  return {
    metadataBase: new URL(baseUrl),
    title,
    description,
    openGraph: {
      title,
      description,
      type: 'website',
      images: [
        {
          url: '/og-image.png',
          width: 1200,
          height: 630,
          alt: title,
        },
      ],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: ['/og-image.png'],
    },
  };
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // PR #72: セッション JWT からテーマ設定を取り出し <html data-theme="..."> に出力。
  // 未ログイン時やテーマ未設定時は 'light' に fallback する。サーバ側で確定するので
  // 初回レンダリング時の「フラッシュ (light → 選択テーマに切り替わる)」は発生しない。
  //
  // fix/theme-preference-cookie (2026-05-18):
  //   優先順位を cookie > JWT > 'light' fallback に変更。
  //   NextAuth v5 0-beta.31 + @netlify/plugin-nextjs では useSession().update() の
  //   Set-Cookie が反映されないため JWT 内 themePreference が古いまま固定化される。
  //   PATCH /api/settings/theme が直接 set した tasukiba-theme cookie を信頼する。
  //   詳細: src/app/api/settings/theme/route.ts の docblock。
  const session = await auth();
  const cookieStore = await cookies();
  const themeFromCookie = cookieStore.get(THEME_COOKIE_NAME)?.value;
  const theme = toSafeThemeId(
    themeFromCookie ?? session?.user?.themePreference,
  );

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
          {/*
            feat/app-version-changelog-footer (2026-05-23):
              全画面共通フッタ。バージョン・運営者・更新履歴 / お知らせ / 規約への
              導線を提供し、サービスが健全に運営されていることを常に可視化する。
              body の `flex min-h-full flex-col` と AppFooter の `mt-auto` で
              画面下に押し下げる (children に flex-1 を強制せず最小差分で実現)。
          */}
          <AppFooter />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
