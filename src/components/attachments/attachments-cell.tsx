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
 */

import Link from 'next/link';
import type { AttachmentDTO } from '@/services/attachment.service';

export function AttachmentsCell({ items }: { items: AttachmentDTO[] }) {
  if (!items || items.length === 0) {
    return <span className="text-muted-foreground">-</span>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((a) => (
        <Link
          key={a.id}
          href={a.url}
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
      ))}
    </div>
  );
}
