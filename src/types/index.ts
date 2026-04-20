/**
 * マスタデータ定数・テーマカタログ (後方互換用 re-export)
 *
 * PR #75 Phase 1 で実体は `src/config/` 配下に移動した。
 * 既存の `import { X } from '@/types'` を一気に書き換えるとレビュー差分が爆発的に
 * 増えるため、本ファイルを経由した透過的参照を当面維持する。
 *
 * 新規コードは `import { X } from '@/config'` を推奨。
 * 設計書: DESIGN.md §21.4 (ゼロハードコーディング原則)
 */

export * from '@/config/master-data';
export * from '@/config/themes';
