import 'next-auth';

declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
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
    };
  }
}
