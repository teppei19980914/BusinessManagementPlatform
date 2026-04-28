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

vi.mock('next-intl/server', () => ({
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getTranslations: async (_namespace?: string) => {
    return (key: string) => key;
  },
}));
