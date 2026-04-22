/**
 * ルートパス定数 (PR #75 Phase 1):
 *
 *   認証・認可の判定ロジックで使うパスリスト、および NextAuth がリダイレクト先として
 *   使う正規ルートをここに集約する。
 *
 *   ページ間遷移の Link / push 先など「カスタム CSS / JSX 内の通常 href」は
 *   URL 文字列のリテラルが可読性に寄与するためそのまま維持する (§21.3 判断基準 2 に基づく)。
 *   本ファイルでは「ミドルウェア / 認可判定で参照する制御用パス」のみ集約する。
 */

/**
 * 未認証でもアクセス可能なパス。ログイン・パスワード再設定・ヘルスチェック等。
 * middleware の authorized コールバックで前方一致判定に使う。
 */
export const PUBLIC_PATHS = [
  '/login',
  '/reset-password',
  '/setup-password',
  '/api/auth',
  '/api/health', // 外部 cron から定期 ping されるため認証不要
  // PR #89: Vercel Cron から Authorization: Bearer <CRON_SECRET> で実行される。
  // middleware のセッション検査は通過させ、route.ts 側で CRON_SECRET 検証 + admin 認証を行う。
  '/api/admin/users/cleanup-inactive',
] as const;

/**
 * PR #67: MFA 検証フロー中だけアクセスを許可するパス。
 *   /login/mfa ページ本体と TOTP 検証 API を含む。
 *   セッションは必要だが mfaVerified=false でもアクセス可能。
 */
export const MFA_PENDING_PATHS = [
  '/login/mfa',
  '/api/auth/mfa/verify',
  '/api/auth/signout', // MFA 検証中にログアウトできるように
] as const;

/** 認証失敗時 / 未認証時のリダイレクト先。 */
export const LOGIN_PATH = '/login';

/** MFA 検証フロー誘導先。 */
export const MFA_LOGIN_PATH = '/login/mfa';
