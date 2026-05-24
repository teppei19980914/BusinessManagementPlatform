import type { NextConfig } from 'next';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import createNextIntlPlugin from 'next-intl/plugin';

// PR #77: next-intl のサーバ統合プラグイン。src/i18n/request.ts を介して
// 各リクエスト時に locale と messages を読み込む。
const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

// feat/app-version-changelog-footer (2026-05-23):
//   バージョン情報をクライアントから参照できるよう、build 時に package.json から
//   バージョンを読み出し NEXT_PUBLIC_APP_VERSION として注入する。
//   `process.env.npm_package_version` も同じ値を持つが、Netlify build やテスト環境で
//   未設定になるケースがあるため、ファイル直読みで決定的に取得する。
//   公開リリース日は RELEASE_DATE 環境変数で上書き可能 (将来のマイナーリリースで増加)、
//   未設定時は v1.0.0 リリース日 2026-06-01 を既定値とする。
const packageJson = JSON.parse(
  readFileSync(resolve(process.cwd(), 'package.json'), 'utf-8'),
) as { version: string };
const APP_VERSION = packageJson.version;
const RELEASE_DATE = process.env.NEXT_PUBLIC_RELEASE_DATE ?? '2026-06-01';

// 2026-05-13 (security/csp-nonce, L-5) — CSP nonce 化を取り下げ、static CSP に復帰:
//   middleware で nonce ベース CSP を試行したが、Next.js 16 の nonce 自動付与が
//   本サービス環境で inline RSC payload に nonce を付与できず、production CI で
//   hydration 全壊する重大不具合を起こした (画面が「確認中...」のまま停止)。
//   詳細: docs/knowledge/KDD_PATTERNS.md §5.X+43, §5.X+44
//
// 結果: pre-PR と同じ `script-src 'self' 'unsafe-inline'` の static CSP に戻す。
//   xss-reviewer 元評価では「XSS 一次防御 (危険 API 使用ゼロ、block-dangerous-edit
//   hook で予防) が強固なので CSP `unsafe-inline` は二次防御として実害なし」と明示済。
//   CSP nonce 化は post-MVP に回す (Next.js のバージョン更新で改善するか様子見)。

const isDev = process.env.NODE_ENV === 'development';

// 開発時は React の HMR が動的実行を要求するため `unsafe-` 系を追加で許可
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
  // feat/app-version-changelog-footer (2026-05-23): バージョン情報をクライアントに公開。
  // NEXT_PUBLIC_ プレフィックスにより client bundle に埋め込まれる (server / client 両方から参照可)。
  env: {
    NEXT_PUBLIC_APP_VERSION: APP_VERSION,
    NEXT_PUBLIC_RELEASE_DATE: RELEASE_DATE,
  },
  // PR #90: next-intl の messages JSON は `./messages/${locale}.json` の動的 import
  // (src/i18n/request.ts) のため、Next.js の静的トレースで発見されず standalone
  // 出力に含まれない → SSR 時 "Cannot find module" で全ページ 500 になっていた。
  // 明示的に include してトレース対象に含める (Next.js 公式手順)。
  // 参考: https://nextjs.org/docs/app/api-reference/next-config-js/output
  //
  // feat/app-version-changelog-footer (2026-05-23): 同じ罠を `fs.readFileSync` でも踏むため
  //   CHANGELOG.md と docs/public/announcements/**/* も明示包含する。
  //   - src/lib/changelog.ts → `resolve(process.cwd(), 'CHANGELOG.md')` で読み込み
  //   - src/lib/announcements.ts → `resolve(process.cwd(), 'docs/public/announcements')` を読み込み
  //   いずれも Server Component から request 時に呼ばれるため、standalone 出力に
  //   ファイルが無いと /changelog /announcements が 500 で全滅する。
  outputFileTracingIncludes: {
    '/**/*': [
      './src/i18n/messages/**/*',
      './CHANGELOG.md',
      './docs/public/announcements/**/*',
    ],
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
