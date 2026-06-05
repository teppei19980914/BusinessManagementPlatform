'use client';

/**
 * LinksCell (2026-06-02): 一覧テーブルの「リンク」列セル。
 *
 * 役割:
 *   添付のうち **URL 参照型 (storageProvider !== 'supabase')** のみを抽出し、
 *   各リンクを **1 行ずつ縦に並べて** 表示する。編集画面で複数リンクを登録すると、
 *   そのまま一覧に複数行で出る。
 *
 * AttachmentsCell との違い:
 *   - AttachmentsCell (添付列) = chip を横並び (flex-wrap)。本セルは縦積み (flex-col)。
 *   - 本セルは url 型のみ。ファイル本体 (supabase 型) は AttachmentsCell 側 (添付列) で表示。
 *   この分離により、リンクとファイルが別列に出て重複表示しない。
 *
 * href: url 型はユーザ入力の完全 URL をそのまま遷移先に使う (resolveAttachmentHref と同義)。
 */

import Link from 'next/link';
import type { AttachmentDTO } from '@/services/attachment.service';

export function LinksCell({ items }: { items: AttachmentDTO[] }) {
  // url 型 (= 外部リンク) のみ対象。ファイル本体 (supabase) は添付列で表示する。
  const links = (items ?? []).filter((a) => a.storageProvider !== 'supabase');
  if (links.length === 0) {
    return <span className="text-muted-foreground">-</span>;
  }
  return (
    <div className="flex flex-col gap-0.5">
      {links.map((a) => (
        <Link
          key={a.id}
          href={a.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="inline-flex max-w-[260px] items-center truncate text-xs text-info hover:underline"
          title={`${a.displayName}\n${a.url}`}
        >
          🔗 {a.displayName}
        </Link>
      ))}
    </div>
  );
}
