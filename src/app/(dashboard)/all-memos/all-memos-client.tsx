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

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
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
  Table, TableBody, TableCell, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  ResizableColumnsProvider,
  ResizableHead,
  ResetColumnsButton,
} from '@/components/ui/resizable-columns';
import { AttachmentList } from '@/components/attachments/attachment-list';
import { useBatchAttachments } from '@/components/attachments/use-batch-attachments';
import { AttachmentsCell } from '@/components/attachments/attachments-cell';
import { useFormatters } from '@/lib/use-formatters';
import { useDialogFullscreen } from '@/components/ui/use-dialog-fullscreen';
import { MarkdownDisplay } from '@/components/ui/markdown-textarea';
import type { MemoDTO } from '@/services/memo.service';

export function AllMemosClient({ memos }: { memos: MemoDTO[] }) {
  const tField = useTranslations('field');
  const tMemo = useTranslations('memo');
  const VISIBILITY_LABELS: Record<string, string> = {
    private: tMemo('visibilityPrivate'),
    public: tMemo('visibilityPublic'),
  };
  const { formatDateTime } = useFormatters();
  const [viewing, setViewing] = useState<MemoDTO | null>(null);
  const { fullscreenClassName, FullscreenToggle } = useDialogFullscreen();

  const attachmentsByEntity = useBatchAttachments('memo', memos.map((m) => m.id));

  return (
    <div className="space-y-6">
      {/* Phase A 要件 6: h2 ページタイトル削除 (ナビタブ名と重複のため) */}
      <div className="flex justify-end">
        <span className="text-sm text-muted-foreground">{tMemo('count', { count: memos.length })}</span>
      </div>

      <ResizableColumnsProvider tableKey="all-memos-readonly">
        <div className="flex justify-end pb-2">
          <ResetColumnsButton />
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <ResizableHead columnKey="title" defaultWidth={220}>{tField('title')}</ResizableHead>
              <ResizableHead columnKey="content" defaultWidth={360}>{tField('body')}</ResizableHead>
              <ResizableHead columnKey="author" defaultWidth={140}>{tMemo('colAuthor')}</ResizableHead>
              <ResizableHead columnKey="updatedAt" defaultWidth={140}>{tMemo('colUpdatedAt')}</ResizableHead>
              <ResizableHead columnKey="attachments" defaultWidth={200}>{tMemo('colAttachments')}</ResizableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {memos.map((m) => (
              <TableRow
                key={m.id}
                className="cursor-pointer hover:bg-muted"
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
              </TableRow>
            ))}
            {memos.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                  {tMemo('emptyPublic')}
                  <span className="ml-1 text-xs">{tMemo('emptyPublicHint')}</span>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </ResizableColumnsProvider>

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
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
