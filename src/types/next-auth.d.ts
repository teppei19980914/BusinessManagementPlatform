import 'next-auth';

declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      /**
       * PR #2-b (T-03): ユーザの所属テナント ID。
       * 認可境界 (cross-tenant attack 防止) のため、すべての API ルート / サービス層で
       * リクエストユーザの tenantId と操作対象データの tenantId が一致することを
       * `requireSameTenant()` (src/lib/permissions/tenant.ts) で検証する。
       *
       * v1 (2026-06-01) では全ユーザが default-tenant 配属のため値は固定だが、
       * v1.x マルチテナント UI 提供時に複数テナントに広がる前提で配置済み。
       */
      tenantId: string;
      name: string;
      email: string;
      systemRole: string;
      forcePasswordChange: boolean;
      /**
       * PR #67: MFA 有効ユーザを検出するフラグ。
       * ログイン直後は true でも mfaVerified が false (TOTP 未入力)。
       */
      mfaEnabled: boolean;
      /**
       * PR #67: 毎回ログイン時に TOTP 検証を通過したかを示すフラグ。
       * パスワード認証直後は false、/login/mfa で検証成功すると true に更新される。
       */
      mfaVerified: boolean;
      /**
       * PR #72: 画面テーマ (THEMES のキー)。layout.tsx の <html data-theme=...> と
       * 設定画面の初期選択で参照する。既定 'light'。
       */
      themePreference: string;
      /**
       * PR #118: 個別タイムゾーン (IANA 名、例 'Asia/Tokyo')。
       * null はシステムデフォルト (config/i18n.ts) を使う意味。
       * 描画時は `resolveTimezone(session.user.timezone)` で解決する。
       */
      timezone: string | null;
      /**
       * PR #118: 個別ロケール (BCP 47、例 'ja-JP')。
       * null はシステムデフォルトを使う意味。
       * 描画時は `resolveLocale(session.user.locale)` で解決する。
       */
      locale: string | null;
    };
  }
}
