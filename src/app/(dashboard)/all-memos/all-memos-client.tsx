'use client';

/**
 * 全メモ画面クライアント (PR #71)。
 *
 * 振る舞い:
 *   - visibility='public' のメモを全件表示 (自分 + 他人の公開メモ)
 *   - 行クリックで詳細ダイアログを開くが **read-only**
 *   - 編集/削除は行わない (個別の /memos 画面で CRUD)
 *   - URL 添付 (AttachmentList) も読み取り専用 (canEdit=false)
 *
 * なぜ `/memos` と別クライアントにしたか:
 *   - /memos は CRUD 可能な個人管理画面 (作成ダイアログ、編集、削除)
 *   - /all-memos は read-only、公開範囲変更や削除権は不要なためコンポーネントを分けて
 *     責務を明確にする (PR #71 のユーザ要件どおり)
 */

import { useState } from 'react';
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
// PR #119: session 連携フォーマッタ
import { useFormatters } from '@/lib/use-formatters';
// feat/dialog-fullscreen-toggle: 文字量が多い dialog 向けの全画面トグル
import { useDialogFullscreen } from '@/components/ui/use-dialog-fullscreen';
// feat/markdown-textarea: 読み取り専用ビューでも Markdown 形式を解釈して表示
import { MarkdownDisplay } from '@/components/ui/markdown-textarea';
import type { MemoDTO } from '@/services/memo.service';

// /memos と同じラベルを使う (DRY)
const VISIBILITY_LABELS: Record<string, string> = {
  private: '自分のみ',
  public: '全メモに公開',
};

export function AllMemosClient({ memos }: { memos: MemoDTO[] }) {
  // PR #119: session 連携フォーマッタ
  const { formatDateTime } = useFormatters();
  const [viewing, setViewing] = useState<MemoDTO | null>(null);
  // feat/dialog-fullscreen-toggle: 詳細 dialog の全画面トグル (read-only でも文字量多い場合あり)
  const { fullscreenClassName, FullscreenToggle } = useDialogFullscreen();

  // 添付列用バッチ取得 (PR #67)
  const attachmentsByEntity = useBatchAttachments('memo', memos.map((m) => m.id));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">全メモ</h2>
        <span className="text-sm text-muted-foreground">{memos.length} 件</span>
      </div>

      <ResizableColumnsProvider tableKey="all-memos-readonly">
        <div className="flex justify-end pb-2">
          <ResetColumnsButton />
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <ResizableHead columnKey="title" defaultWidth={220}>タイトル</ResizableHead>
              <ResizableHead columnKey="content" defaultWidth={360}>本文</ResizableHead>
              <ResizableHead columnKey="author" defaultWidth={140}>作成者</ResizableHead>
              <ResizableHead columnKey="updatedAt" defaultWidth={140}>更新日時</ResizableHead>
              <ResizableHead columnKey="attachments" defaultWidth={200}>添付</ResizableHead>
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
                  {m.isMine && <span className="ml-1 text-xs text-info">(自分)</span>}
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
                  公開メモがありません。
                  <span className="ml-1 text-xs">(「メモ」画面で公開範囲を「全メモに公開」にすると、このページに表示されます)</span>
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
              <DialogTitle>メモ詳細</DialogTitle>
              <FullscreenToggle />
            </div>
            <DialogDescription>
              参照専用です。編集は作成者のメモ画面でのみ可能です。
            </DialogDescription>
          </DialogHeader>
          {viewing && (
            <div className="space-y-4">
              {/* fieldset disabled で全入力を読み取り専用化 (他エンティティの readOnly ダイアログと同パターン) */}
              <fieldset disabled className="space-y-4 disabled:opacity-90">
                <div className="space-y-2">
                  <Label>公開範囲</Label>
                  <Input value={VISIBILITY_LABELS[viewing.visibility] ?? viewing.visibility} readOnly />
                </div>
                <div className="space-y-2">
                  <Label>作成者</Label>
                  <Input value={viewing.authorName ?? '-'} readOnly />
                </div>
                <div className="space-y-2">
                  <Label>タイトル</Label>
                  <Input value={viewing.title} readOnly />
                </div>
                <div className="space-y-2">
                  <Label>本文</Label>
                  <div className="rounded-md border border-input bg-background px-3 py-2 text-sm min-h-[12rem]">
                    <MarkdownDisplay value={viewing.content} />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>更新日時</Label>
                  <Input value={formatDateTime(viewing.updatedAt)} readOnly />
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline">作成: {formatDateTime(viewing.createdAt)}</Badge>
                  {viewing.isMine && <Badge>自分のメモ</Badge>}
                </div>
              </fieldset>
              {/* URL 添付 (read-only) */}
              <AttachmentList
                entityType="memo"
                entityId={viewing.id}
                canEdit={false}
                label="参考 URL"
              />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
