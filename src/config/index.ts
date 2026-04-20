/**
 * 設定ディレクトリの公開エントリ (PR #75 Phase 1)。
 *
 * 使い方:
 *   import { TASK_STATUSES, BCRYPT_COST, PUBLIC_PATHS } from '@/config';
 *
 * なぜ集約されているか:
 *   ゼロハードコーディング原則 (DESIGN.md §21.4) に基づき、業務的意味を持つ値は
 *   全てこの配下に置き、各コード層は参照するのみとする。
 *
 * ファイル分割方針:
 *   - master-data.ts       : 業務概念の列挙 (ステータス / 優先度 等)
 *   - themes.ts            : テーマカタログ (画面上の表示名 + ID)
 *   - theme-definitions.ts : テーマの CSS 色トークン値
 *   - security.ts          : 認証・ロック・トークン期限等
 *   - routes.ts            : 認可判定に使うパス集合
 *   - suggestion.ts        : 提案型サービスの重み・閾値
 */

export * from './master-data';
export * from './themes';
export * from './theme-definitions';
export * from './security';
export * from './routes';
export * from './suggestion';
