'use client';

/**
 * 全メモ画面クライアント (PR #71、PR #165 で read-only 確定)。
 *
 * 振る舞い:
 *   - visibility='public' のメモを全件表示 (自分 + 他人の公開メモ)
 *   - 行クリックで詳細ダイアログを開くが **read-only**
 *   - 編集/削除/一括変更は行わない (個別の /memos 画面で CRUD + 一括変更)
 *   - URL 添付 (AttachmentList) も読み取り専用 (canEdit=false)
 *
 * 設計ルール (PR #165 で再確定):
 *   - **「全○○」 = 参照のみ** (本画面)
 *   - **「○○一覧」 = CRUD + 一括編集** (個人ノートは /memos personal page)
 *   PR #162 で誤って本画面に bulk UI を入れていたが、PR #165 で原状回復。
 *
 * なぜ `/memos` と別クライアントにしたか:
 *   - /memos は CRUD 可能な個人管理画面 (作成ダイアログ、編集、削除、一括変更)
 *   - /all-memos は read-only、責務を明確にする
 */

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useListSearchParams } from '@/components/common/use-list-search-params';
import { matchesAnyKeyword } from '@/lib/text-search';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  TableBody, TableCell, TableHeader, TableRow,
} from '@/components/ui/table';
import { ResizableHead } from '@/components/ui/resizable-columns';
import { ResizableTableShell } from '@/components/common/resizable-table-shell';
import { SortableResizableHead } from '@/components/sort/sortable-resizable-head';
import { useMultiSort } from '@/components/sort/use-multi-sort';
import { multiSort } from '@/lib/multi-sort';
import { useBatchAttachments } from '@/components/attachments/use-batch-attachments';
import { AttachmentsCell } from '@/components/attachments/attachments-cell';
import { useFormatters } from '@/lib/use-formatters';
import type { MemoDTO } from '@/services/memo.service';
// Phase E 要件 1〜3 (2026-04-29): 共通行クリック + フィルタバー部品
import { ClickableRow } from '@/components/common/clickable-row';
import { FilterBar } from '@/components/common/filter-bar';
import { useAutoOpenDialog } from '@/components/common/use-auto-open-dialog';
// feat/all-list-section-unification (2026-05-24): 他 4 画面の規約に合わせて
//   詳細ダイアログ / admin 削除ボタンを専用 component に抽出。
import { MemoViewDialog } from './memo-view-dialog';
import { AdminMemoDeleteButton } from './admin-delete-button';

function getMemoSortValue(m: MemoDTO, columnKey: string): unknown {
  switch (columnKey) {
    case 'title': return m.title;
    case 'content': return m.content;
    case 'author': return m.authorName ?? '';
    case 'updatedAt': return m.updatedAt;
    default: return null;
  }
}

export function AllMemosClient({
  memos,
  currentSystemRole,
  initialKeyword = '',
}: {
  memos: MemoDTO[];
  currentSystemRole: string;
  /** PR #425 (2026-05-22) KDD §5.X+102: URL ?keyword= 復元用 */
  initialKeyword?: string;
}) {
  const tField = useTranslations('field');
  const tMemo = useTranslations('memo');
  const tCommon = useTranslations('common');
  const { formatDateTime } = useFormatters();
  const [viewing, setViewing] = useState<MemoDTO | null>(null);
  const isAdmin = currentSystemRole === 'admin';

  // PR #425 (2026-05-22) KDD §5.X+102: 入力即フィルタ + URL ?keyword= 永続化
  const { keyword, setKeyword } = useListSearchParams({ initialKeyword });
  const filteredMemos = useMemo(() => {
    if (!keyword.trim()) return memos;
    return memos.filter((m) =>
      matchesAnyKeyword(keyword, [m.title, m.content, m.authorName]),
    );
  }, [memos, keyword]);

  // PR feat/sortable-columns (2026-05-01): カラムソート (sessionStorage 永続化、複数列対応)
  const { sortState, setSortColumn } = useMultiSort('sort:all-memos');
  const sortedMemos = multiSort(filteredMemos, sortState, getMemoSortValue);

  const attachmentsByEntity = useBatchAttachments('memo', sortedMemos.map((m) => m.id));

  // PR #213: mention 通知 link `?memoId=...` から auto-open。
  useAutoOpenDialog<MemoDTO>({
    queryKey: 'memoId',
    items: memos,
    onOpen: (m) => setViewing(m),
  });

  return (
    <div className="space-y-6">
      {/* feat/all-list-section-unification (2026-05-24): 全○○ 5 画面共通レイアウト規約
          1. 件数行 (justify-end / フィルタ後件数 / common.itemCount)
          2. FilterBar (検索・フィルタ、軸数は画面固有)
          3. ResizableTableShell (テーブル本体)
          4. 詳細ダイアログ (read-only) */}
      <div className="flex justify-end">
        <span className="text-sm text-muted-foreground">{tCommon('itemCount', { count: filteredMemos.length })}</span>
      </div>

      <FilterBar>
        <div>
          <Label htmlFor="all-memos-filter-keyword" className="text-xs">{tMemo('keyword')}</Label>
          {/* PR #425 (2026-05-22) KDD §5.X+102: 入力即フィルタ + URL ?keyword= 永続化 */}
          <Input
            id="all-memos-filter-keyword"
            placeholder={tMemo('searchPlaceholder')}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            data-testid="all-memos-search-input"
          />
        </div>
      </FilterBar>

      <ResizableTableShell tableKey="all-memos-readonly">
          <TableHeader>
            <TableRow>
              <SortableResizableHead columnKey="title" defaultWidth={220} label={tField('title')} sortState={sortState} onSortChange={setSortColumn} />
              <SortableResizableHead columnKey="content" defaultWidth={360} label={tField('body')} sortState={sortState} onSortChange={setSortColumn} />
              <SortableResizableHead columnKey="author" defaultWidth={140} label={tMemo('colAuthor')} sortState={sortState} onSortChange={setSortColumn} />
              <SortableResizableHead columnKey="updatedAt" defaultWidth={140} label={tMemo('colUpdatedAt')} sortState={sortState} onSortChange={setSortColumn} />
              <ResizableHead columnKey="attachments" defaultWidth={200}>{tMemo('colAttachments')}</ResizableHead>
              {isAdmin && (
                <ResizableHead columnKey="adminActions" defaultWidth={80}>{tMemo('colActions')}</ResizableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedMemos.map((m) => (
              <ClickableRow
                key={m.id}
                onClick={() => setViewing(m)}
              >
                <TableCell className="font-medium">{m.title}</TableCell>
                <TableCell className="max-w-[min(90vw,28rem)] truncate text-sm text-foreground" title={m.content}>
                  {m.content.slice(0, 120)}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {m.authorName ?? '-'}
                  {m.isMine && <span className="ml-1 text-xs text-info">{tMemo('mineSuffix')}</span>}
                </TableCell>
                <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                  {formatDateTime(m.updatedAt)}
                </TableCell>
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <AttachmentsCell items={attachmentsByEntity[m.id] ?? []} />
                </TableCell>
                {isAdmin && (
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    {/* admin は他人の public メモのモデレーション削除可。自分のメモは /memos で削除する想定 */}
                    {!m.isMine && (
                      <AdminMemoDeleteButton memoId={m.id} label={m.title} />
                    )}
                  </TableCell>
                )}
              </ClickableRow>
            ))}
            {sortedMemos.length === 0 && (
              <TableRow>
                <TableCell colSpan={isAdmin ? 6 : 5} className="py-8 text-center text-muted-foreground">
                  {tMemo('emptyPublic')}
                  <span className="ml-1 text-xs">{tMemo('emptyPublicHint')}</span>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
      </ResizableTableShell>

      <MemoViewDialog
        memo={viewing}
        open={viewing != null}
        onOpenChange={(o) => { if (!o) setViewing(null); }}
      />
    </div>
  );
}
