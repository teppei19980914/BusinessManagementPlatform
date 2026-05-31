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
      // ADR-0028 PR #471 (2026-05-30): frame-src を 'self' + app.netlify.com に明示。
      //   未指定だと default-src 'self' に fallback し、Netlify deploy preview / branch
      //   deploy で Netlify が自動注入する **Netlify Drawer** (= deploy 情報を表示する
      //   小さな iframe、app.netlify.com を src とする) が CSP で block され Console に
      //   "Framing 'https://app.netlify.com/' violates CSP" エラーが出る。
      //   本番 (= 独自ドメイン tasukiba.com) では Netlify Drawer は注入されないため
      //   実害なし、開発体験 (preview での Console ノイズ) を優先して許可する。
      //   ★frame-ancestors 'none' は維持★ (= 本サイトが他サイトから iframe 化されるのは引き続き禁止)。
      //   詳細: KDD §5.X+195
      "frame-src 'self' https://app.netlify.com",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      // security/phase-1 (2026-05-31): Flash / 旧ブラウザ向け <object> / <embed> / <applet>
      //   を明示的に block。default-src 'self' でカバーされるが、CSP-3 で object-src の
      //   明示が強く推奨されているため、検証ツール (Mozilla Observatory 等) の指摘解消も兼ねる。
      "object-src 'none'",
      // security/phase-1 (2026-05-31): CSP 違反通知の収集先。
      //   browser が CSP block 発生時に自動 POST する。/api/csp-report で受信し
      //   system_error_logs に記録 (= 将来 nonce 化や CSP 強化判断のための観測点)。
      //   report-to (新仕様) は Reporting-Endpoints ヘッダ連携が必要で実装範囲が広いため、
      //   widely-supported な report-uri (CSP Level 2) を採用。
      'report-uri /api/csp-report',
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
  // security/phase-1 (2026-05-31): Cross-Origin Isolation 系ヘッダ。
  //   - COOP=same-origin: window.opener 経由のクロスオリジン読取・タイミング攻撃 (Spectre 系)
  //     を遮断。同一オリジンの window のみ参照可能になり、外部 page から本サービスを
  //     window.open() してもページ間通信できなくなる。
  //   - CORP=same-site: 本サービスのリソース (画像/スクリプト/JSON 等) を別 origin から
  //     img/script/fetch で読まれることを防ぐ。同一サイト (sub-domain 含む) からは可。
  // - COEP=require-corp は意図的に除外:
  //     Supabase Storage / 外部 OG 画像 / 添付ダウンロードが軒並み破綻するため、本 Phase
  //     ではコスト > 効果と判断。COEP は将来必要時に画像 proxy 経由など別途設計で導入する。
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Resource-Policy', value: 'same-site' },
];

const nextConfig: NextConfig = {
  output: 'standalone',
  // PR #114 (2026-04-24 セキュリティ監査): X-Powered-By: Next.js ヘッダを抑止。
  // フレームワーク情報を外部に漏らさない (既知脆弱性の絞り込みに悪用される経路を閉じる)。
  poweredByHeader: false,
  // perf/comprehensive-perf-2026-06-01 (B-5): 巨大な barrel export を tree-shake させ
  //   client bundle を縮小する。lucide-react / @base-ui/react は各々が数百個の export を
  //   持ち、現状は使用していないコンポーネントも初期 bundle に乗ってしまっている。
  //   Next.js 公式の optimizePackageImports は import 文を自動で個別パスに rewrite し
  //   未使用 export を完全に除外する。lighthouse Treemap で +30-50 KiB 削減見込み。
  experimental: {
    optimizePackageImports: ['lucide-react', '@base-ui/react'],
  },
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
