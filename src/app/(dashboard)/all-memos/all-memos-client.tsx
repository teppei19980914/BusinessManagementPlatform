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
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useListSearchParams } from '@/components/common/use-list-search-params';
import { matchesAnyKeyword } from '@/lib/text-search';
import { Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useLoading } from '@/components/loading-overlay';
import { useToast } from '@/components/toast-provider';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  TableBody, TableCell, TableHeader, TableRow,
} from '@/components/ui/table';
import { ResizableHead } from '@/components/ui/resizable-columns';
import { ResizableTableShell } from '@/components/common/resizable-table-shell';
import { SortableResizableHead } from '@/components/sort/sortable-resizable-head';
import { useMultiSort } from '@/components/sort/use-multi-sort';
import { multiSort } from '@/lib/multi-sort';
import { AttachmentList } from '@/components/attachments/attachment-list';
import { useBatchAttachments } from '@/components/attachments/use-batch-attachments';
import { AttachmentsCell } from '@/components/attachments/attachments-cell';
import { useFormatters } from '@/lib/use-formatters';
import { useDialogFullscreen } from '@/components/ui/use-dialog-fullscreen';
import { MarkdownDisplay } from '@/components/ui/markdown-textarea';
import type { MemoDTO } from '@/services/memo.service';
// Phase E 要件 1〜3 (2026-04-29): 共通行クリック部品
import { ClickableRow } from '@/components/common/clickable-row';
// PR #213 (2026-05-01): 全メモにもコメント機能 + 通知 deep link auto-open を追加
import { CommentSection } from '@/components/comments/comment-section';
import { useAutoOpenDialog } from '@/components/common/use-auto-open-dialog';

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
  const tAction = useTranslations('action');
  const VISIBILITY_LABELS: Record<string, string> = {
    private: tMemo('visibilityPrivate'),
    public: tMemo('visibilityPublic'),
  };
  const { formatDateTime } = useFormatters();
  const [viewing, setViewing] = useState<MemoDTO | null>(null);
  const { fullscreenClassName, FullscreenToggle } = useDialogFullscreen();
  // feat/crud-permission-redesign (2026-05-20): admin の public メモモデレーション削除
  const router = useRouter();
  const { withLoading } = useLoading();
  const { showSuccess, showError } = useToast();
  const isAdmin = currentSystemRole === 'admin';
  async function handleAdminDelete(memoId: string, title: string) {
    if (!confirm(tCommon('adminDeleteConfirm', { label: title }))) return;
    const res = await withLoading(() =>
      fetch(`/api/memos/${memoId}`, { method: 'DELETE' }),
    );
    if (!res.ok) {
      showError(tMemo('deleteFailed'));
      return;
    }
    showSuccess(tMemo('deleteSuccess'));
    router.refresh();
  }

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
      {/* Phase A 要件 6: h2 ページタイトル削除 (ナビタブ名と重複のため) */}
      <div className="flex items-center justify-between gap-4">
        {/* PR #425 (2026-05-22) KDD §5.X+102: 入力即フィルタ + URL ?keyword= 永続化 */}
        <Input
          placeholder={tMemo('searchPlaceholder')}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          className="max-w-md"
          data-testid="all-memos-search-input"
        />
        <span className="text-sm text-muted-foreground">{tMemo('count', { count: filteredMemos.length })}</span>
      </div>

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
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="text-destructive hover:text-destructive"
                        title={tCommon('adminDeleteTitle', { label: m.title })}
                        aria-label={tAction('delete')}
                        onClick={() => handleAdminDelete(m.id, m.title)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
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

      {/* 詳細ダイアログ (read-only) */}
      <Dialog open={viewing != null} onOpenChange={(o) => { if (!o) setViewing(null); }}>
        <DialogContent className={`max-w-[min(90vw,36rem)] max-h-[85vh] overflow-y-auto ${fullscreenClassName}`}>
          <DialogHeader>
            <div className="flex items-center justify-between gap-2">
              <DialogTitle>{tMemo('detail')}</DialogTitle>
              <FullscreenToggle />
            </div>
            <DialogDescription>
              {tMemo('detailDescription')}
            </DialogDescription>
          </DialogHeader>
          {viewing && (
            <div className="space-y-4">
              <fieldset disabled className="space-y-4 disabled:opacity-90">
                <div className="space-y-2">
                  <Label>{tField('visibility')}</Label>
                  <Input value={VISIBILITY_LABELS[viewing.visibility] ?? viewing.visibility} readOnly />
                </div>
                <div className="space-y-2">
                  <Label>{tMemo('colAuthor')}</Label>
                  <Input value={viewing.authorName ?? '-'} readOnly />
                </div>
                <div className="space-y-2">
                  <Label>{tField('title')}</Label>
                  <Input value={viewing.title} readOnly />
                </div>
                <div className="space-y-2">
                  <Label>{tField('body')}</Label>
                  <div className="rounded-md border border-input bg-background px-3 py-2 text-sm min-h-[12rem]">
                    <MarkdownDisplay value={viewing.content} />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>{tMemo('colUpdatedAt')}</Label>
                  <Input value={formatDateTime(viewing.updatedAt)} readOnly />
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{tMemo('createdAt', { date: formatDateTime(viewing.createdAt) })}</Badge>
                  {viewing.isMine && <Badge>{tMemo('mineBadge')}</Badge>}
                </div>
              </fieldset>
              <AttachmentList
                entityType="memo"
                entityId={viewing.id}
                canEdit={false}
                label={tMemo('referenceUrl')}
              />
              {/* PR #213: コメント機能を追加 (他「全○○」と同じ UX、CommentSection は fieldset 外に配置)。
                  認可は API 側で visibility-aware に判定される (public memo は誰でも投稿可、
                  draft memo は作成者本人のみ)。 */}
              <CommentSection
                entityType="memo"
                entityId={viewing.id}
              />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
