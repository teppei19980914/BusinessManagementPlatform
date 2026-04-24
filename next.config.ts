import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

// PR #77: next-intl のサーバ統合プラグイン。src/i18n/request.ts を介して
// 各リクエスト時に locale と messages を読み込む。
const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const isDev = process.env.NODE_ENV === 'development';

// 開発時は React が必要とする unsafe-eval を script-src に追加
const scriptSrc = isDev
  ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
  : "script-src 'self' 'unsafe-inline'";

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      scriptSrc,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
  },
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
  { key: 'X-DNS-Prefetch-Control', value: 'off' },
  { key: 'X-Download-Options', value: 'noopen' },
  { key: 'X-Permitted-Cross-Domain-Policies', value: 'none' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=()',
  },
];

const nextConfig: NextConfig = {
  output: 'standalone',
  // PR #114 (2026-04-24 セキュリティ監査): X-Powered-By: Next.js ヘッダを抑止。
  // フレームワーク情報を外部に漏らさない (既知脆弱性の絞り込みに悪用される経路を閉じる)。
  poweredByHeader: false,
  // PR #90: next-intl の messages JSON は `./messages/${locale}.json` の動的 import
  // (src/i18n/request.ts) のため、Next.js の静的トレースで発見されず standalone
  // 出力に含まれない → SSR 時 "Cannot find module" で全ページ 500 になっていた。
  // 明示的に include してトレース対象に含める (Next.js 公式手順)。
  // 参考: https://nextjs.org/docs/app/api-reference/next-config-js/output
  outputFileTracingIncludes: {
    '/**/*': ['./src/i18n/messages/**/*'],
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: securityHeaders,
      },
    ];
  },
};

export default withNextIntl(nextConfig);
