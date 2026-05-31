'use client';

/**
 * AttachmentsCell (PR #67): 一覧テーブルの 1 行に添付リンクを
 * chip 形式で並べて表示するセルコンポーネント。
 *
 * UX:
 *   - 各添付を小さな Badge (Link) として横並び
 *   - displayName を表示し、URL はホバーで title 属性で確認
 *   - 外部リンクのため target="_blank" rel="noopener noreferrer"
 *   - 添付なしは "-" を出してレイアウトを崩さない
 *
 * fix/attachment-download-404 (2026-05-31): ADR-0021 (本体アップロード) 対応漏れの修正。
 *   storageProvider==='supabase' (本体保存型) の `url` 列には Storage Object Key
 *   (例: `tenants/{tid}/risk/{rid}/{uuid}-name.csv`、先頭スラッシュ無し) が入っている。
 *   これをそのまま `<Link href>` に渡すと**相対パス解決**され
 *   `/tenants/.../risk/.../<key>` という存在しないアプリ内ルートに飛んで 404 になる。
 *   ダイアログ用 AttachmentList (attachment-list.tsx:250) と同じ分岐を入れ、
 *   supabase 型は署名 URL を 302 で返す `/api/attachments/{id}/download` に向ける。
 */

import Link from 'next/link';
import type { AttachmentDTO } from '@/services/attachment.service';
import { resolveAttachmentHref } from '@/lib/attachment-href';

export function AttachmentsCell({ items }: { items: AttachmentDTO[] }) {
  if (!items || items.length === 0) {
    return <span className="text-muted-foreground">-</span>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((a) => {
        // supabase 本体は download API で都度 Pre-signed URL を発行 (302 redirect)。
        //   url 型 (旧 URL 参照) はユーザ入力の完全 URL なのでそのまま遷移。
        const href = resolveAttachmentHref(a);
        return (
          <Link
            key={a.id}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            // 2026-05-09 (#1): chip 単体が長い displayName でセル幅を超える事象。
            //   max-w で上限を切り、`truncate` で ellipsis (...) を発火させる。
            //   ホバー時は title 属性で URL 表示。
            className="inline-flex max-w-[200px] items-center truncate rounded bg-info/10 px-1.5 py-0.5 text-xs text-info hover:bg-info/20"
            title={`${a.displayName}\n${a.url}`}
          >
            🔗 {a.displayName}
          </Link>
        );
      })}
    </div>
  );
}
