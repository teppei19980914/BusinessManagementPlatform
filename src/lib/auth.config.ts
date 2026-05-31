/**
 * NextAuth v5 の Edge 互換設定（middleware 用）
 * Prisma などの Node.js 依存を含まない。
 * middleware.ts からインポートして使用する。
 */

import type { NextAuthConfig } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import {
  PUBLIC_PATHS,
  MFA_PENDING_PATHS,
  LOGIN_PATH,
  MFA_LOGIN_PATH,
  SESSION_JWT_MAX_AGE_SEC,
} from '@/config';

export const authConfig: NextAuthConfig = {
  providers: [
    // Credentials provider の定義（authorize は auth.ts で上書き）
    Credentials({
      credentials: {
        email: {},
        password: {},
      },
    }),
  ],
  secret: process.env.NEXTAUTH_SECRET || process.env.AUTH_SECRET,
  trustHost: true,
  session: {
    strategy: 'jwt',
    // JWT 自体の有効期限 (安全網)。ただしタブ / ブラウザを閉じた時点で
    // セッション cookie が失われるので実質はそれまで。
    maxAge: SESSION_JWT_MAX_AGE_SEC,
  },
  /**
   * セッション cookie 化 (PR #59 Req 4):
   *   既定では NextAuth は maxAge を cookie の expires にも反映し、永続 cookie に
   *   するためブラウザを閉じてもログイン状態が残る。ここで明示的に maxAge を
   *   省いた cookie options を与えることで「ブラウザ/タブを閉じると破棄される」
   *   セッション cookie に切り替える。
   *
   *   name は NextAuth v5 の規約: 本番 (https) では "__Secure-" プレフィックス、
   *   開発 (http) では通常名を使う。
   */
  cookies: {
    sessionToken: {
      name:
        process.env.NODE_ENV === 'production'
          ? '__Secure-authjs.session-token'
          : 'authjs.session-token',
      options: {
        httpOnly: true,
        // PR #198 (2026-04-30): 'lax' → 'strict' に強化 (CWE-1275 対策)。
        // PR #425 (2026-05-22) ★severity-1★: 'strict' → 'lax' に戻す。
        //   理由: Stripe Checkout を新規導入したため、外部 origin (checkout.stripe.com) から
        //         自 origin への top-level GET redirect (= success_url) で sameSite='strict' は
        //         cookie を送らない → /api/tenants/me/billing/stripe/setup/complete handler が
        //         未認証扱い → /login に強制遷移 → カード登録完了したのに UI 上は失敗扱い
        //         → ユーザは「もう一度カード登録?」と混乱 + DB は paymentMethod='credit_card'
        //         + stripeSubscriptionId=null の「カード未登録 credit_card」状態に陥り請求漏れ。
        //   PR #198 当時の前提「外部 origin からのコールバックは無い」が崩れたための再緩和。
        //   GET 経由の CSRF 対策は不要 (= 副作用なし)。POST には CSRF token + CORS で別途防御。
        sameSite: 'lax',
        path: '/',
        secure: process.env.NODE_ENV === 'production',
        // maxAge を指定しない → セッション cookie (タブ/ブラウザ閉じで失効)
      },
    },
  },
  pages: {
    signIn: LOGIN_PATH,
  },
  callbacks: {
    authorized({ auth, request }) {
      const { nextUrl } = request;
      // feat/app-version-changelog-footer (2026-05-23): prefix match を厳密化。
      //   旧: `startsWith('/login')` は `/loginAdmin` /loginAdmin-bypass のような
      //   将来追加パスも意図せず公開扱いにする (現存しないが将来の足元事故予防)。
      //   新: 完全一致 OR `/` 直下のサブパスのみ public。
      //   例: `/login` は `/login` `/login/mfa` を許容、`/loginAdmin` は拒否。
      const isPublicPath = PUBLIC_PATHS.some((path) => {
        const pathname = nextUrl.pathname;
        return pathname === path || pathname.startsWith(path + '/');
      });

      if (isPublicPath) return true;

      const isLoggedIn = !!auth?.user;
      if (!isLoggedIn) {
        return Response.redirect(new URL(LOGIN_PATH, nextUrl));
      }

      // PR #67: MFA 有効ユーザが TOTP 未検証で保護領域にアクセスしようとしたら
      // /login/mfa に誘導する。検証フロー中だけ許容するパス群 (MFA_PENDING_PATHS) は
      // 通過させ、MFA 画面自体や verify API を呼べるようにする。
      const mfaPending
        = auth.user.mfaEnabled === true && auth.user.mfaVerified !== true;
      if (mfaPending) {
        const isMfaAllowed = MFA_PENDING_PATHS.some((p) =>
          nextUrl.pathname.startsWith(p),
        );
        if (!isMfaAllowed) {
          return Response.redirect(new URL(MFA_LOGIN_PATH, nextUrl));
        }
      }

      // P-B (2026-05-08): Beginner プラン期限切れテナントの read-only モード。
      //   write 系 HTTP method (POST/PATCH/PUT/DELETE) のみ弾き、GET/HEAD/OPTIONS は通す。
      //   middleware は Edge runtime で DB を引けないので、JWT claim の
      //   tenantPlan / tenantCreatedAt / tenantBeginnerEverUpgraded / timezone から純関数で判定。
      //   アップグレードしたら次回の jwt callback で claim が更新される (新しい authorize() 結果が反映)。
      //
      // 2026-05-11 改修: 「プラン変更」「セルフ削除」だけは read-only モード中でも許可する。
      //   - PATCH /api/tenants/me: Beginner → Expert/Pro アップグレード経路 (これを弾くと
      //     "アップグレードしてください" と案内しつつ自己矛盾的にブロックする状態だった)
      //   - POST /api/tenants/me/self-delete: テナント解約経路 (これも write なので弾かれていた)
      //   - DELETE /api/tenants/me: プラン変更予約のキャンセル (= アップグレード操作に付随)
      //   middleware (Edge) は body を読めないため path 完全一致で判定する。
      //   PATCH /api/tenants/me は plan 以外 (budget / seedDataEnabled) も含むが、
      //   サービス層側で Beginner 期間中の不正設定はそれぞれ別エラーで弾かれるため害なし。
      //
      // PR-4 (2026-05-15): 90 日判定をテナント TZ カレンダー日ベースに変更。
      //   旧仕様 (絶対経過時間 ÷ 24h) は「JST 14:00 作成 → 90 日後 09:00 JST」で 89.98 日扱いだった。
      //   新仕様は「TZ ローカル YYYY-MM-DD 差」なので JST 0:00 でデクリメントする要件と一致。
      const writeMethods = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
      const READ_ONLY_BYPASS_PATHS = new Set([
        '/api/tenants/me',
        '/api/tenants/me/self-delete',
      ]);
      const isReadOnlyBypass = READ_ONLY_BYPASS_PATHS.has(nextUrl.pathname);
      if (writeMethods.has(request.method) && !isReadOnlyBypass) {
        // 2026-05-14 (PR #372): super_admin による read-only 強制移行。
        //   Beginner 期限切れ / Storage Grace 期限切れと並ぶ独立した遮断条件。
        //   suspendedAt が null でない間は無条件で write 系を 403 で弾く (経過日数判定なし、
        //   解除されるまで継続)。例外パスは Beginner と同じ READ_ONLY_BYPASS_PATHS (= 顧客は
        //   支払い後の解除待ち中でもプラン変更 / セルフ解約は可能、要は顧客側からの脱出経路を確保)。
        const suspendedAtIso = auth.user.tenantSuspendedAt;
        if (typeof suspendedAtIso === 'string' && suspendedAtIso.length > 0) {
          return new Response(
            JSON.stringify({
              error: {
                code: 'TENANT_SUSPENDED',
                message:
                  'お支払いまたは利用規約の確認のため、現在テナントを閲覧専用 (read-only) モードにしています。' +
                  '詳細はサポートまでお問い合わせください。',
              },
            }),
            {
              status: 403,
              headers: { 'content-type': 'application/json' },
            },
          );
        }

        const plan = auth.user.tenantPlan;
        const createdAtIso = auth.user.tenantCreatedAt;
        const everUpgraded = auth.user.tenantBeginnerEverUpgraded;
        const tenantTimezone = auth.user.timezone || 'Asia/Tokyo';
        if (
          plan === 'beginner' &&
          everUpgraded === false &&
          typeof createdAtIso === 'string'
        ) {
          const createdAt = new Date(createdAtIso);
          if (!Number.isNaN(createdAt.getTime())) {
            // PR-4: tenant TZ カレンダー日ベース。Edge runtime で外部 import を避けるため inline 実装。
            const daysElapsed = tenantCalendarDayDiffEdge(
              createdAt,
              new Date(),
              tenantTimezone,
            );
            if (daysElapsed >= 90) {
              // ログアウト系 (= 別 method なので通る) と認証 API は PUBLIC_PATHS で通過済。
              // 業務 API のみここで弾く。プラン変更とセルフ削除は READ_ONLY_BYPASS_PATHS で通過済。
              return new Response(
                JSON.stringify({
                  error: {
                    code: 'BEGINNER_EXPIRED_READ_ONLY',
                    message:
                      'Beginner プランの試用期間 (90 日) が経過したため、書き込み操作は停止しています。' +
                      'Expert または Pro プランへのアップグレードをお願いします。',
                  },
                }),
                {
                  status: 403,
                  headers: { 'content-type': 'application/json' },
                },
              );
            }
          }
        }

        // chore/storage-addon-backend-removal (2026-05-26):
        //   旧 Storage add-on 4 段階プラン (Standard/Plus/Pro/Enterprise) の Grace period 7 日経過判定は撤去。
        //   ADR-0020 で DB 容量は従量課金化、さらに 2026-05-31 (ADR-0030) で累積ハードキャップも撤去され、
        //   middleware で write を塞ぐのではなく従量課金 + 運用 (Compute 増強) で対応する設計に変わったため。
      }

      return true;
    },
    jwt({ token, user, trigger, session }) {
      if (user) {
        token.id = user.id;
        // G2-e-2 (2026-05-31): 初回ログイン (たすきば未利用) フラグ。authorize が算出し、
        //   session.user.isFirstTimeUser に伝播してオンボーディングモーダル表示判定に使う。
        //   初回セッションの間だけ true (次回ログイン時は新しい authorize 結果で false になる)。
        token.isFirstTimeUser =
          (user as unknown as { isFirstTimeUser?: boolean }).isFirstTimeUser ?? false;
        // PR #2-b (T-03): tenantId を JWT に格納し、session callback で session.user に
        //   伝播する。テナント境界チェック (requireSameTenant) の起点。
        token.tenantId = (user as unknown as { tenantId: string }).tenantId;
        // 2026-05-13 (security/jwt-invalidation, L-1): JWT 失効カウンタ。
        //   API route 入口の getAuthenticatedUser で DB 最新値と比較される。
        //   admin が increment した瞬間に既存 JWT は全部 401 になる (= 強制ログアウト)。
        token.tokenVersion = (user as unknown as { tokenVersion: number }).tokenVersion;
        // P-B (2026-05-08): Beginner プラン期限判定用の claim。
        //   middleware の authorized callback で Date.now() と比較して read-only 判定。
        token.tenantPlan = (user as unknown as { tenantPlan: string }).tenantPlan;
        token.tenantCreatedAt = (user as unknown as { tenantCreatedAt: string }).tenantCreatedAt;
        token.tenantBeginnerEverUpgraded = (
          user as unknown as { tenantBeginnerEverUpgraded: boolean }
        ).tenantBeginnerEverUpgraded;
        // chore/storage-addon-backend-removal (2026-05-26): tenantStorageGracePeriodStartedAt claim は撤去
        // 2026-05-14 (PR #372): read-only 強制移行フラグの ISO 文字列。
        token.tenantSuspendedAt = (
          user as unknown as { tenantSuspendedAt: string | null }
        ).tenantSuspendedAt ?? null;
        token.systemRole = (user as unknown as { systemRole: string }).systemRole;
        token.forcePasswordChange = (user as unknown as { forcePasswordChange: boolean })
          .forcePasswordChange;
        // PR #67: パスワード認証直後は mfaVerified を常に false にリセット。
        // 以前のセッションで検証済みでも、新規ログインでは必ず再検証を要求する。
        token.mfaEnabled = (user as unknown as { mfaEnabled: boolean }).mfaEnabled;
        token.mfaVerified = false;
        // PR #72: テーマ設定も JWT に入れて layout.tsx から参照できるようにする。
        token.themePreference = (user as unknown as { themePreference?: string }).themePreference ?? 'light';
        // PR #118: i18n 設定も JWT に入れて SSR/CSR 共通で TZ/locale 解決できるようにする。
        //   null は「システムデフォルト使用」の意味。描画側で resolveTimezone/resolveLocale を通す。
        token.timezone = (user as unknown as { timezone?: string | null }).timezone ?? null;
        token.locale = (user as unknown as { locale?: string | null }).locale ?? null;
      }
      // PR #67: /login/mfa で useSession().update({ mfaVerified: true }) を
      // 呼ぶと trigger='update' の session 渡しで TOTP 検証済を token に反映する。
      // PR #72: 設定画面でテーマ変更時も同経路で { themePreference: '...' } を反映する。
      // PR-1 (2026-05-15): テナント設定画面で TZ / locale を変更時も同じ経路で反映。
      //   テナント単位に集約済みのため null には戻せない (NOT NULL 制約)。
      if (trigger === 'update' && session && typeof session === 'object') {
        const patch = session as {
          mfaVerified?: boolean;
          themePreference?: string;
          timezone?: string;
          locale?: string;
        };
        if (patch.mfaVerified === true) token.mfaVerified = true;
        if (typeof patch.themePreference === 'string') {
          token.themePreference = patch.themePreference;
        }
        if (typeof patch.timezone === 'string' && patch.timezone.length > 0) {
          token.timezone = patch.timezone;
        }
        if (typeof patch.locale === 'string' && patch.locale.length > 0) {
          token.locale = patch.locale;
        }
      }
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
        // G2-e-2: 初回ログイン (たすきば未利用) フラグを session.user に公開。
        session.user.isFirstTimeUser =
          (token.isFirstTimeUser as boolean | undefined) ?? false;
        // PR #2-b (T-03): JWT に格納された tenantId を session.user に公開。
        //   これ以降のサーバ側コードは session.user.tenantId を信頼源として参照する。
        session.user.tenantId = token.tenantId as string;
        // 2026-05-13 (security/jwt-invalidation, L-1): tokenVersion を伝播。
        //   getAuthenticatedUser が DB の最新値と比較する際の起点。
        session.user.tokenVersion = (token.tokenVersion as number | undefined) ?? 0;
        session.user.systemRole = token.systemRole as string;
        session.user.forcePasswordChange = token.forcePasswordChange as boolean;
        session.user.mfaEnabled = (token.mfaEnabled as boolean | undefined) ?? false;
        session.user.mfaVerified = (token.mfaVerified as boolean | undefined) ?? false;
        session.user.themePreference = (token.themePreference as string | undefined) ?? 'light';
        // PR-1 (2026-05-15): timezone / locale はテナント単位 (NOT NULL) になったため
        //   non-nullable で公開する。token が万が一 undefined なら DEFAULT に fallback。
        session.user.timezone = (token.timezone as string | undefined) ?? 'Asia/Tokyo';
        session.user.locale = (token.locale as string | undefined) ?? 'ja-JP';
        // P-B (2026-05-08): Beginner プラン期限 claim を session に伝播 (UI 側でバナー表示等に使用)
        session.user.tenantPlan = (token.tenantPlan as string | undefined) ?? 'beginner';
        session.user.tenantCreatedAt = (token.tenantCreatedAt as string | undefined) ?? new Date().toISOString();
        session.user.tenantBeginnerEverUpgraded =
          (token.tenantBeginnerEverUpgraded as boolean | undefined) ?? false;
        // chore/storage-addon-backend-removal (2026-05-26): tenantStorageGracePeriodStartedAt 伝播は撤去
        // 2026-05-14 (PR #372): read-only 強制移行フラグを session に伝播
        session.user.tenantSuspendedAt =
          (token.tenantSuspendedAt as string | null | undefined) ?? null;
      }
      return session;
    },
  },
};

/**
 * PR-4 (2026-05-15): Edge runtime 互換のテナント TZ カレンダー日差ヘルパ。
 *
 * `src/lib/tenant-time.ts` の `tenantCalendarDayDiff` と同等の実装だが、
 * Edge runtime は Node 固有 module を import しない事を保証するため inline で実装する。
 * 依存は Intl.DateTimeFormat (Web 標準) のみ。
 */
function tenantCalendarDayDiffEdge(
  earlier: Date,
  later: Date,
  timeZone: string,
): number {
  const fmt = (d: Date) => {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(d);
    const get = (t: 'year' | 'month' | 'day') =>
      parts.find((p) => p.type === t)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  };
  const eMs = Date.parse(`${fmt(earlier)}T00:00:00Z`);
  const lMs = Date.parse(`${fmt(later)}T00:00:00Z`);
  return Math.floor((lMs - eMs) / (24 * 60 * 60 * 1000));
}
