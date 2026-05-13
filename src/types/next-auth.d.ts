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
       * PR-1 (2026-05-15): テナント単位の IANA タイムゾーン名 (例 'Asia/Tokyo')。
       * Tenant.timezone を JWT 経由で session に伝搬。NOT NULL (default 'Asia/Tokyo')。
       * 描画時はそのまま `Intl.DateTimeFormat` の timeZone に渡せる。
       */
      timezone: string;
      /**
       * PR-1 (2026-05-15): テナント単位の BCP 47 ロケール (例 'ja-JP')。
       * Tenant.locale を JWT 経由で session に伝搬。NOT NULL (default 'ja-JP')。
       */
      locale: string;
      /**
       * P-B (2026-05-08): Beginner プラン期限判定用の JWT claim。
       * middleware (Edge runtime) で DB を引かずに read-only 判定するために
       * テナントの plan / createdAt / beginnerEverUpgraded を session に持つ。
       */
      tenantPlan: string;
      tenantCreatedAt: string; // ISO 8601 文字列 (Edge で Date を再構築しやすいよう)
      tenantBeginnerEverUpgraded: boolean;
      /**
       * Storage add-on (Phase 2 / 2026-05-08): Storage Grace period 開始日時 ISO。
       * middleware (Edge runtime) で `NOW() - parse() >= 7 日` 判定で write 系 API を弾く。
       * Grace 未開始は null。
       */
      tenantStorageGracePeriodStartedAt: string | null;
      /**
       * 2026-05-13 (security/jwt-invalidation, L-1): JWT 失効カウンタ。
       * admin が increment した瞬間に既存 JWT は API route 入口で 401 になる。
       */
      tokenVersion: number;
    };
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    /** P-B (2026-05-08): Beginner プラン期限判定用 claim */
    tenantPlan?: string;
    tenantCreatedAt?: string;
    tenantBeginnerEverUpgraded?: boolean;
    /** Storage add-on (Phase 2 / 2026-05-08): Grace period 開始日時 ISO (未開始は null) */
    tenantStorageGracePeriodStartedAt?: string | null;
    /** 2026-05-13 (security/jwt-invalidation, L-1): JWT 失効カウンタ */
    tokenVersion?: number;
  }
}
