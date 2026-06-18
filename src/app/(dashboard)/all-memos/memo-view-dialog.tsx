'use client';

/**
 * 全メモ画面用の read-only 詳細ダイアログ。
 *
 * feat/all-list-section-unification (2026-05-24):
 *   従来 all-memos-client.tsx 内に `<Dialog>` 直書きされていたが、
 *   他 4 画面 (knowledge / risks / retrospectives) が専用 EditDialog を readOnly 再利用
 *   している規約に揃えるため、ここに抽出。
 *
 * なぜ KnowledgeEditDialog 等のように「Edit dialog を readOnly 切替」にしなかったか:
 *   /memos 画面の編集ダイアログ (MemoCreateDialog 等) は create/edit 両用の Form Dialog で、
 *   全メモから呼ぶ「参照専用 + 添付 + コメント」用途とは表示すべき要素が異なる
 *   (例: visibility selector や同期インポート系 UI は参照画面に不要)。
 *   そのため別 component として独立させる方が両者の責務が明確になる。
 */

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
import { useDialogFullscreen } from '@/components/ui/use-dialog-fullscreen';
import { MarkdownDisplay } from '@/components/ui/markdown-textarea';
import { AttachmentList } from '@/components/attachments/attachment-list';
// v1.3.0 資産導線機能: 手動リンクセクション
import { AssetLinkSection } from '@/components/common/asset-link-section';
import { CommentSection } from '@/components/comments/comment-section';
import { useFormatters } from '@/lib/use-formatters';
import type { MemoDTO } from '@/services/memo.service';

type Props = {
  memo: MemoDTO | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function MemoViewDialog({ memo, open, onOpenChange }: Props) {
  const tField = useTranslations('field');
  const tMemo = useTranslations('memo');
  // 作成日時/更新日時は監査列のため秒まで表示 (formatDateTimeSeconds = 全画面共通の設計)
  const { formatDateTimeSeconds } = useFormatters();
  const { fullscreenClassName, FullscreenToggle } = useDialogFullscreen();
  const VISIBILITY_LABELS: Record<string, string> = {
    private: tMemo('visibilityPrivate'),
    public: tMemo('visibilityPublic'),
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={`max-w-[min(90vw,36rem)] max-h-[85vh] overflow-y-auto ${fullscreenClassName}`}>
        <DialogHeader>
          <div className="flex items-center justify-between gap-2">
            <DialogTitle>{tMemo('detail')}</DialogTitle>
            <FullscreenToggle />
          </div>
          <DialogDescription>{tMemo('detailDescription')}</DialogDescription>
        </DialogHeader>
        {memo && (
          <div className="space-y-4">
            <fieldset disabled className="space-y-4 disabled:opacity-90">
              <div className="space-y-2">
                <Label>{tField('visibility')}</Label>
                <Input value={VISIBILITY_LABELS[memo.visibility] ?? memo.visibility} readOnly />
              </div>
              <div className="space-y-2">
                <Label>{tMemo('colAuthor')}</Label>
                <Input value={memo.authorName ?? '-'} readOnly />
              </div>
              <div className="space-y-2">
                <Label>{tField('title')}</Label>
                <Input value={memo.title} readOnly />
              </div>
              <div className="space-y-2">
                <Label>{tField('body')}</Label>
                <div className="rounded-md border border-input bg-background px-3 py-2 text-sm min-h-[12rem]">
                  <MarkdownDisplay value={memo.content} />
                </div>
              </div>
              <div className="space-y-2">
                <Label>{tMemo('colUpdatedAt')}</Label>
                <Input value={formatDateTimeSeconds(memo.updatedAt)} readOnly />
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="outline">{tMemo('createdAt', { date: formatDateTimeSeconds(memo.createdAt) })}</Badge>
                {memo.isMine && <Badge>{tMemo('mineBadge')}</Badge>}
              </div>
            </fieldset>
            <AttachmentList
              entityType="memo"
              entityId={memo.id}
              canEdit={false}
              label={tMemo('referenceUrl')}
            />
            {/* v1.3.0 資産導線機能: 手動リンク (リスク/課題/ナレッジ/振り返り/メモ 5 資産間) */}
            <AssetLinkSection entityType="memo" entityId={memo.id} isPublic={memo.visibility === 'public'} />
            {/* PR #213: コメント機能。CommentSection は fieldset 外に配置。
                認可は API 側で visibility-aware に判定される (public memo は誰でも投稿可、
                draft memo は作成者本人のみ)。 */}
            <CommentSection entityType="memo" entityId={memo.id} />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
