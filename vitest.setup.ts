/**
 * Vitest 共通セットアップ (T-17 Group 2 で追加)。
 *
 * 役割:
 *   API route が `next-intl/server` の `getTranslations` を使用するようになったため、
 *   全テストでデフォルトでモックして「key 名をそのまま返す」スタブに置き換える。
 *   これにより `'next-intl' is not supported in Client Components` エラーを回避し、
 *   テスト側で個別 mock を書かなくても route のロジック検証が可能になる。
 *
 * 個別テストで具体メッセージを検証したい場合は、各テストで `vi.mock` を上書き可能。
 */

import { vi } from 'vitest';

// 2026-05-13 (security/auth-secret-hardening, B-1): mfa.service の NEXTAUTH_SECRET
//   fail-closed 化に伴い、テスト環境では決定論的なテスト用 secret をセットする。
//   本番環境のように未設定で fail させる挙動 (= encryption/decryption をテスト)
//   は、必要であれば個別テスト内で `delete process.env.NEXTAUTH_SECRET` で再現できる。
//   secret 値は 32 文字以上のテスト固定値 (= 本番値とは異なるため漏洩リスク無し)。
if (!process.env.NEXTAUTH_SECRET) {
  process.env.NEXTAUTH_SECRET = 'test-secret-for-vitest-only-32chars-long-aaaa';
}

vi.mock('next-intl/server', () => ({
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getTranslations: async (_namespace?: string) => {
    return (key: string) => key;
  },
}));
