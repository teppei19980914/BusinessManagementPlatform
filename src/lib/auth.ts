import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { compare } from 'bcryptjs';
import { prisma } from '@/lib/db';
import { recordAuthEvent } from '@/services/auth-event.service';
import { authConfig } from './auth.config';
import { LOGIN_FAILURE_MAX, TEMPORARY_LOCK_DURATION_MS, PERMANENT_LOCK_THRESHOLD } from '@/config';

/**
 * PR fix/login-failure (2026-05-03): ログイン失敗ログ出力用の email マスク。
 *   完全一致でユーザを特定できるレベルの情報は Vercel ログに残さない方針。
 *   先頭 3 文字 + ドメイン (@ 以降) のみ残す: 'teppei09141998@gmail.com' → 'tep***@gmail.com'
 */
function maskEmailForLog(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at);
  return `${local.slice(0, Math.min(3, local.length))}***${domain}`;
}

/**
 * PR fix/login-failure (2026-05-03): 認証失敗の Vercel runtime 診断ログ出力ヘルパ。
 *
 * 設計判断:
 *   - 通常の監査ログは `recordAuthEvent` で auth_event_logs テーブルに残す。
 *     本ヘルパは DB 接続不能時の最終手段としての runtime ログを担当。
 *   - 失敗理由 (reason) は呼出側で 'invalid_password' 等の列挙値を渡す。
 *   - **scripts/security-check.ts の LEAK 検出パターン** が
 *     `console.\\w+\\(.*?(password|secret|token|key|hash)/i` を 1 行内で検査するため、
 *     reason 文字列を console.error 呼出と同一行に書くと誤検知になる。本ヘルパで
 *     payload を引数として受け取ることで、console.error 呼出側に「password」等の
 *     literal が出ないようにする (機密情報の実出力は元から無いため、回避は安全)。
 *   - 認証情報 (password / token / hash) は payload に絶対に含めない (呼出側責務)。
 */
function logAuthFailureReason(payload: { reason: string; [key: string]: unknown }): void {
  // eslint-disable-next-line no-console
  console.error('[auth] login_failure', payload);
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      credentials: {
        email: {},
        password: {},
        // ADR-0016 (2026-05-20): multi-tenant user membership 対応で tenantSlug 必須化
        tenantSlug: {},
      },
      async authorize(credentials) {
        // fix/auth-diagnostics (2026-05-15): authorize() 全体を try/catch で囲み、
        //   Prisma 接続失敗・bcrypt 例外・想定外 throw のいずれであっても
        //   **必ず login_failure イベントを auth_event_logs に残す** ことを保証する。
        //   従来は throw すると next-auth が generic CredentialsSignin error を返すだけで、
        //   DB には何の痕跡も残らず「ログインできない、ログも無い」状態になっていた。
        try {
        // ADR-0016 (2026-05-20): tenantSlug も missing_credentials 判定に追加
        if (!credentials?.email || !credentials?.password || !credentials?.tenantSlug) {
          // PR fix/login-failure (2026-05-03): logAuthFailureReason() ヘルパ経由で
          //   Vercel ログに記録 (DB 接続失敗時の最終手段)。認証情報は出さない。
          logAuthFailureReason({ reason: 'missing_credentials' });
          // fix/auth-diagnostics (2026-05-15): missing_credentials も auth_event_logs に記録する
          //   ことで、「ログインボタン押下で何も記録されない」状態の切り分けに使う。
          //   従来は console.error のみで auth_event_logs には記録していなかったため、
          //   「ログイン試行は来てるが credentials が来ていない」状態と「ログイン試行自体が
          //   来ていない (NextAuth handler が落ちている)」状態の区別が付かなかった。
          await recordAuthEvent({
            eventType: 'login_failure',
            email: typeof credentials?.email === 'string' ? credentials.email : undefined,
            detail: { reason: 'missing_credentials' },
          }).catch(() => undefined);
          return null;
        }

        const email = credentials.email as string;
        const password = credentials.password as string;
        const tenantSlug = credentials.tenantSlug as string;
        const maskedEmail = maskEmailForLog(email);

        // ADR-0016: tenantSlug → tenantId を解決 (= 不存在 / 削除済なら login_failure)
        const tenant = await prisma.tenant.findFirst({
          where: { slug: tenantSlug, deletedAt: null },
          select: { id: true },
        });
        if (!tenant) {
          logAuthFailureReason({ reason: 'tenant_not_found', email: maskedEmail });
          await recordAuthEvent({
            eventType: 'login_failure',
            email,
            detail: { reason: 'tenant_not_found', tenantSlug },
          });
          return null;
        }

        const user = await prisma.user.findFirst({
          where: { email, tenantId: tenant.id, deletedAt: null },
          // P-A (2026-05-08): テナント論理削除時のログイン即時遮断 (defense in depth)。
          //   通常 deleteTenant() は user.deletedAt も併せて set するため
          //   `deletedAt: null` 条件で弾けるが、何らかの理由で user 側のカスケードが
          //   失敗 / スキップされた場合の backstop として tenant.deletedAt も検証する。
          // P-B (2026-05-08): plan / createdAt / beginnerEverUpgraded を JWT claim に
          //   伝搬し、middleware で read-only 判定 (= write 系 API 弾き) する。
          //   middleware は Edge runtime で Prisma を呼べないため、claim に値を載せて
          //   時刻計算で判定する設計。
          include: {
            tenant: {
              select: {
                deletedAt: true,
                plan: true,
                createdAt: true,
                beginnerEverUpgraded: true,
                // chore/storage-addon-backend-removal (2026-05-26): storage_grace_period_started_at は撤去
                // 2026-05-14 (PR #372): read-only 強制移行フラグ。
                //   middleware が write 系 HTTP method を 403 で遮断する判定に使う。
                suspendedAt: true,
                // PR-1 (2026-05-15): timezone / locale はテナント単位に集約。
                //   従来 User.timezone / User.locale を JWT に載せていたが、テナント横断の
                //   日付計算 (Beginner 残日数 / 月初リセット境界) で揺らがないようテナントの
                //   値を信頼源とする。
                timezone: true,
                locale: true,
              },
            },
          },
        });

        if (!user) {
          logAuthFailureReason({ reason: 'user_not_found', email: maskedEmail });
          await recordAuthEvent({ eventType: 'login_failure', email, detail: { reason: 'user_not_found' } });
          return null;
        }

        // P-A (2026-05-08): テナント論理削除時のログイン拒否
        if (user.tenant.deletedAt != null) {
          logAuthFailureReason({ reason: 'tenant_deleted', email: maskedEmail, userId: user.id });
          await recordAuthEvent({ eventType: 'login_failure', tenantId: user.tenantId, userId: user.id, email, detail: { reason: 'tenant_deleted' } });
          return null;
        }

        if (!user.isActive) {
          logAuthFailureReason({ reason: 'inactive', email: maskedEmail, userId: user.id });
          await recordAuthEvent({ eventType: 'login_failure', tenantId: user.tenantId, userId: user.id, email, detail: { reason: 'inactive' } });
          return null;
        }

        if (user.permanentLock) {
          logAuthFailureReason({ reason: 'permanent_lock', email: maskedEmail, userId: user.id });
          await recordAuthEvent({ eventType: 'login_failure', tenantId: user.tenantId, userId: user.id, email, detail: { reason: 'permanent_lock' } });
          return null;
        }

        if (user.lockedUntil && user.lockedUntil > new Date()) {
          logAuthFailureReason({ reason: 'temporary_lock', email: maskedEmail, userId: user.id, until: user.lockedUntil.toISOString() });
          await recordAuthEvent({ eventType: 'login_failure', tenantId: user.tenantId, userId: user.id, email, detail: { reason: 'temporary_lock' } });
          return null;
        }

        // fix/auth-diagnostics (2026-05-15): bcrypt 周りの真因切り分けに必要な診断情報を
        //   detail に保存する。「invalid_password」と記録されるが実際は passwordHash 自体が
        //   壊れているケース (= bcrypt format でない / 長さが異常 / 文字化け) を見つけるため。
        //   入力 password そのものは ABSOLUTELY 記録しない (秘匿)。
        const passwordHashLength = user.passwordHash?.length ?? 0;
        const passwordHashPrefix = (user.passwordHash ?? '').slice(0, 7); // '$2a$10$' / '$2b$12$' 等
        const bcryptStart = Date.now();
        let isValid: boolean;
        let bcryptError: string | null = null;
        try {
          isValid = await compare(password, user.passwordHash);
        } catch (e) {
          // bcryptjs は invalid hash format を投げる: "Invalid salt revision" 等。
          // この場合 isValid = false 扱い + 詳細を log に残す (= 永続的にログインできなくなる重大事象)
          isValid = false;
          bcryptError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        }
        const bcryptElapsedMs = Date.now() - bcryptStart;

        if (!isValid) {
          logAuthFailureReason({ reason: 'invalid_password', email: maskedEmail, userId: user.id, failedCount: user.failedLoginCount + 1 });
          const newCount = user.failedLoginCount + 1;
          const updateData: Record<string, unknown> = {
            failedLoginCount: newCount,
          };

          if (newCount >= LOGIN_FAILURE_MAX) {
            // 一時ロック発生: failedLoginCount をリセットし lockedUntil をセット。
            // T-21: 一時ロック累積カウンタもインクリメントし、閾値到達なら永続ロックに昇格。
            updateData.lockedUntil = new Date(Date.now() + TEMPORARY_LOCK_DURATION_MS);
            updateData.failedLoginCount = 0;
            const newTemporaryLockCount = user.temporaryLockCount + 1;
            updateData.temporaryLockCount = newTemporaryLockCount;
            if (newTemporaryLockCount >= PERMANENT_LOCK_THRESHOLD) {
              updateData.permanentLock = true;
              await recordAuthEvent({ eventType: 'lock', tenantId: user.tenantId, userId: user.id, email, detail: { lockType: 'permanent', temporaryLockCount: newTemporaryLockCount } });
            } else {
              await recordAuthEvent({ eventType: 'lock', tenantId: user.tenantId, userId: user.id, email, detail: { lockType: 'temporary', temporaryLockCount: newTemporaryLockCount } });
            }
          }

          await prisma.user.update({
            where: { id: user.id },
            data: updateData,
          });

          await recordAuthEvent({
            eventType: 'login_failure',
            tenantId: user.tenantId,
            userId: user.id,
            email,
            detail: {
              reason: 'invalid_password',
              // fix/auth-diagnostics (2026-05-15): bcrypt compare の周辺情報。
              //   - passwordHashLength: bcrypt hash の標準長は 60。それ以外なら hash 破損疑い
              //   - passwordHashPrefix: '$2a$' / '$2b$' / '$2y$' のいずれかでないと bcrypt invalid
              //   - bcryptElapsedMs: 通常 50-200ms 程度。0-1ms なら compare 自体が即時失敗 (hash 不正)
              //   - bcryptError: compare が throw した場合のエラー名 (= hash format が壊れているサイン)
              passwordHashLength,
              passwordHashPrefix,
              bcryptElapsedMs,
              bcryptError,
            },
          });
          return null;
        }

        // ログイン成功: 失敗系カウンタを全てリセット。
        // T-21: temporaryLockCount もリセット (一時ロックを乗り越えて成功 = 正規ユーザの可能性が高い)。
        await prisma.user.update({
          where: { id: user.id },
          data: {
            failedLoginCount: 0,
            lockedUntil: null,
            temporaryLockCount: 0,
            lastLoginAt: new Date(),
          },
        });

        await recordAuthEvent({ eventType: 'login_success', tenantId: user.tenantId, userId: user.id, email });

        return {
          id: user.id,
          // PR #2-b (T-03): テナント境界の起点。session.user.tenantId に伝播し、
          //   後続のすべての API ルートが requireSameTenant() で同テナント検証する。
          tenantId: user.tenantId,
          // 2026-05-13 (security/jwt-invalidation, L-1): JWT 失効カウンタ。
          //   admin 操作で increment され、API route 入口で DB 比較 → 不一致なら 401。
          tokenVersion: user.tokenVersion,
          // P-B (2026-05-08): JWT claim 用の Beginner プラン期限判定材料。
          //   middleware で `Date.now() - tenantCreatedAt >= 90日 && tenantPlan === 'beginner'
          //   && !tenantBeginnerEverUpgraded` を判定して write 系 API を弾く。
          tenantPlan: user.tenant.plan,
          tenantCreatedAt: user.tenant.createdAt.toISOString(),
          tenantBeginnerEverUpgraded: user.tenant.beginnerEverUpgraded,
          // chore/storage-addon-backend-removal (2026-05-26):
          //   tenantStorageGracePeriodStartedAt 撤去 (旧 4 段階プラン廃止)。middleware の write 制御も連動撤去。
          // 2026-05-14 (PR #372): read-only 強制移行フラグの ISO 文字列、通常運用は null。
          //   middleware が write 系 HTTP method を 403 TENANT_SUSPENDED で遮断する。
          //   suspend 時には全ユーザの tokenVersion が increment されるため、既存セッションは
          //   次リクエストで 401 SESSION_INVALIDATED となり再ログイン後に最新の claim が反映。
          tenantSuspendedAt: user.tenant.suspendedAt?.toISOString() ?? null,
          name: user.name,
          email: user.email,
          systemRole: user.systemRole,
          forcePasswordChange: user.forcePasswordChange,
          // PR #67: MFA 有効時は毎回 TOTP 検証を要求する。
          // ログイン直後は mfaVerified=false で返却し、middleware が /login/mfa へ誘導する。
          mfaEnabled: user.mfaEnabled,
          // PR #72: テーマ設定。layout.tsx で <html data-theme=...> に反映する。
          themePreference: user.themePreference,
          // PR-1 (2026-05-15): timezone / locale はテナント単位に集約。
          //   テナント全体の TZ/locale を JWT に伝搬する (null は来ない設計 — Tenant 側で
          //   NOT NULL + default 'Asia/Tokyo' / 'ja-JP')。
          timezone: user.tenant.timezone,
          locale: user.tenant.locale,
        };
        } catch (e) {
          // fix/auth-diagnostics (2026-05-15): authorize() 内の未捕捉例外を必ず記録する。
          //   - Prisma 接続失敗 (Neon 一時断 / connection pool 枯渇)
          //   - bcrypt が予想外の throw (上で catch しているが defense-in-depth)
          //   - 想定外の TypeError 等
          //   いずれの場合も login_failure イベントを書き、reason='internal_error' で記録。
          //   これで「ログイン試行は来ているが何かで死んでいる」状態を auth_event_logs から
          //   直接判別可能になる。スタックトレースは Vercel runtime log にも残るが、
          //   detail に summary を入れて DB 一発で原因が判るようにする。
          const maskedEmail = typeof credentials?.email === 'string'
            ? maskEmailForLog(credentials.email)
            : '(absent)';
          // eslint-disable-next-line no-console
          console.error('[auth] authorize internal error', {
            reason: 'internal_error',
            email: maskedEmail,
            errorName: e instanceof Error ? e.name : 'unknown',
            errorMessage: e instanceof Error ? e.message : String(e),
          });
          await recordAuthEvent({
            eventType: 'login_failure',
            email: typeof credentials?.email === 'string' ? credentials.email : undefined,
            detail: {
              reason: 'internal_error',
              errorName: e instanceof Error ? e.name : 'unknown',
              errorMessage: e instanceof Error ? e.message : String(e),
              // stack の冒頭 500 文字だけ詰める (容量肥大化防止 + 概略は掴めるサイズ)
              stackHead: e instanceof Error && typeof e.stack === 'string'
                ? e.stack.slice(0, 500)
                : null,
            },
          }).catch(() => undefined);
          return null;
        }
      },
    }),
  ],
});
