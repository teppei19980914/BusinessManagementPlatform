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
       * 2026-05-14 (PR #372): super_admin による read-only 強制移行フラグ ISO 文字列。
       * null = 通常運用、文字列 = read-only モード (= middleware が write 系 HTTP method を 403 遮断)。
       * suspend 時に対象テナントの全ユーザ tokenVersion が increment されるため、既存セッションは
       * 次リクエストで 401 SESSION_INVALIDATED となり再ログイン後にこの claim が反映される。
       */
      tenantSuspendedAt: string | null;
      /**
       * 2026-05-13 (security/jwt-invalidation, L-1): JWT 失効カウンタ。
       * admin が increment した瞬間に既存 JWT は API route 入口で 401 になる。
       */
      tokenVersion: number;
      /**
       * G2-e-1/2 (2026-05-31): 初回ログイン (たすきば未利用) フラグ。
       * authorize が email 単位の過去 login_success 0 件で true を返す。初回セッションの間だけ
       * true (次回ログインで false)。オンボーディングモーダルの自動表示判定に使う
       * (admin/general のみ対象、super_admin は UI 側で除外)。
       */
      isFirstTimeUser: boolean;
    };
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    /** P-B (2026-05-08): Beginner プラン期限判定用 claim */
    tenantPlan?: string;
    tenantCreatedAt?: string;
    tenantBeginnerEverUpgraded?: boolean;
    /** 2026-05-14 (PR #372): read-only 強制移行フラグ ISO (通常運用は null) */
    tenantSuspendedAt?: string | null;
    /** 2026-05-13 (security/jwt-invalidation, L-1): JWT 失効カウンタ */
    tokenVersion?: number;
    /** G2-e-1/2 (2026-05-31): 初回ログイン (たすきば未利用) フラグ */
    isFirstTimeUser?: boolean;
  }
}
