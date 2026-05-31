/**
 * 添付ファイルの「クリック時の遷移先 href」を一元解決するヘルパ。
 *
 * fix/attachment-download-404 (2026-05-31):
 *   添付には 2 つの保存形態がある (ADR-0021, 2026-05-26)。
 *     - storageProvider === 'url'      : 旧 URL 参照型。`url` 列にユーザ入力の完全 URL。
 *     - storageProvider === 'supabase' : 本体アップロード型。`url` 列には Supabase Storage の
 *       Object Key (例: `tenants/{tid}/risk/{rid}/{uuid}-name.csv`、**先頭スラッシュ無しの相対形式**)
 *       が入っている。これをそのまま `<a href>` / `<Link href>` に渡すと現在ページ基準で
 *       相対パス解決され `/tenants/.../risk/.../<key>` という存在しないルートに飛び 404 になる。
 *
 *   supabase 型は `/api/attachments/{id}/download` に遷移させ、サーバ側で都度
 *   Pre-signed Download URL を発行して 302 redirect で受ける (= 表示時に都度発行)。
 *
 *   ダイアログ用 (AttachmentList) では既に正しく分岐していたが、一覧セル (AttachmentsCell)
 *   等に横展開されておらず 404 が発生していた。リンク生成箇所が複数に分散すると同種の
 *   横展開漏れが再発するため、本ヘルパに一本化して全箇所から利用する。
 */

/** href 解決に必要な添付の最小フィールド (AttachmentDTO のサブセット)。 */
export type AttachmentHrefInput = {
  id: string;
  url: string;
  storageProvider: string;
};

/**
 * 添付の遷移先 href を返す。
 *   - supabase 本体型 → `/api/attachments/{id}/download` (署名 URL を 302 で返す)
 *   - それ以外 (url 型) → 入力された完全 URL をそのまま使用
 */
export function resolveAttachmentHref(attachment: AttachmentHrefInput): string {
  return attachment.storageProvider === 'supabase'
    ? `/api/attachments/${attachment.id}/download`
    : attachment.url;
}
