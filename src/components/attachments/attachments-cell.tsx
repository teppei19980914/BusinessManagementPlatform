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
    return <span className="text-gray-400">-</span>;
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
          className="inline-flex items-center rounded bg-blue-50 px-1.5 py-0.5 text-xs text-blue-700 hover:bg-blue-100"
          title={a.url}
        >
          🔗 {a.displayName}
        </Link>
      ))}
    </div>
  );
}
