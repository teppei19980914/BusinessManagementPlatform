/**
 * チャット意味検索のアシスタント・ペルソナ定義。
 *
 * 役割:
 *   チャット FAB / チャットパネルで「ユーザは誰と会話しているのか」を提示するための
 *   ペルソナ情報 (表示名 + アバター画像 URL) を集約する。LINE / Teams 等の対話 UI で
 *   左寄せアバター + 吹き出しの形式を取るときに参照する。
 *
 * なぜ src/config に置くか:
 *   Client Component (chat-fab.tsx / chat-panel.tsx) から import するため、サーバ専用
 *   依存 (Prisma 等) を持たない純粋な定数モジュールとしている (KDD §5.X+103 と整合)。
 *
 * 関連:
 *   - public/mascot-owl-chat.png — avatarSrc が指す派生画像 (scripts/generate-mascot-derivatives.cjs が生成)
 *   - docs/design/MASCOT.md — マスコット全体の設計
 *   - docs/specification/CHAT_SEMANTIC_SEARCH.md — チャット UI 仕様
 */

export const CHAT_PERSONA = {
  /** チャット相手の表示名。ヘッダラベル + 吹き出し横の発話者ラベルで使用。 */
  name: 'たすきフクロウ',
  /** アバター画像のパス (public/ からの絶対パス)。 */
  avatarSrc: '/mascot-owl-chat.png',
  /** アバター画像の意味的 alt テキスト。装飾用途では空文字を別途指定すること。 */
  avatarAlt: 'たすきフクロウ',
} as const;

export type ChatPersona = typeof CHAT_PERSONA;
