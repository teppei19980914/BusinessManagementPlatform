'use client';

/**
 * MarkdownTextarea — 複数行テキスト入力 + プレビュー + 差分表示の共通コンポーネント
 * (feat/markdown-textarea)。
 *
 * 役割:
 *   - 入力欄: 既存 textarea と同じ振る舞い (value / onChange / rows / maxLength / required)
 *   - プレビュー (右、トグル可): Markdown 構文を含めば react-markdown で描画、含まなければ
 *     `whitespace-pre-wrap` でプレーンテキスト表示。「テキストはテキストのまま、Markdown は
 *     Markdown プレビュー」というユーザ要件を満たす。
 *   - 差分 (下、トグル可): previousValue と現在の value を語単位で diff し、
 *     左側に旧側・右側に新側を表示。追加=緑下線 / 削除=赤取消線でハイライト。
 *
 * レイアウト:
 *   - 入力欄とプレビュー: md 以上で grid-cols-2 (横並び)、それ未満は縦並び
 *   - 差分パネル: 入力欄+プレビューの下に幅 100% で表示 (旧側 / 新側で 2 カラム)
 *   - プレビューと差分は **既定 OFF**。トグルボタンで ON にするとパネルが現れる
 *
 * セキュリティ:
 *   - react-markdown は既定で raw HTML を許可しない (XSS 対策)
 *   - GitHub Flavored Markdown (テーブル / 取消線 / タスクリスト) は remark-gfm で対応
 *   - 改行は remark-breaks で「単一改行 → <br>」に変換 (Markdown 仕様の 2 改行ルールは
 *     ユーザの直感に反するため緩和)
 */

import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { Eye, GitCompareArrows } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  isMarkdown,
  computeWordDiff,
  extractBeforeChunks,
  extractAfterChunks,
} from '@/lib/markdown-utils';
import type { Change } from 'diff';

type MarkdownTextareaProps = {
  value: string;
  onChange: (v: string) => void;
  /** 編集 dialog 用: 編集前の値。差分パネルに渡される。create dialog では undefined。 */
  previousValue?: string;
  rows?: number;
  maxLength?: number;
  required?: boolean;
  placeholder?: string;
  disabled?: boolean;
  /** 入力欄の className を上書き (既存 textarea と同じスタイル維持に使用)。 */
  className?: string;
};

export function MarkdownTextarea({
  value,
  onChange,
  previousValue,
  rows = 4,
  maxLength,
  required,
  placeholder,
  disabled,
  className,
}: MarkdownTextareaProps) {
  const [showPreview, setShowPreview] = useState(false);
  // 差分は previousValue が与えられているときのみ意味があるので、無いときはトグル自体を非表示
  const hasPrevious = typeof previousValue === 'string';
  const [showDiff, setShowDiff] = useState(false);

  // 差分計算: previousValue と value が同じなら (= 編集が無いなら) 差分パネルは無意味
  const hasChanges = hasPrevious && (previousValue ?? '') !== value;
  const changes = showDiff && hasChanges ? computeWordDiff(previousValue ?? '', value) : null;

  const textareaClassName =
    className
    ?? 'flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono';

  return (
    <div className="space-y-2">
      {/* トグルボタン群 */}
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant={showPreview ? 'default' : 'outline'}
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={() => setShowPreview((v) => !v)}
          disabled={disabled}
        >
          <Eye className="size-3" />
          プレビュー
        </Button>
        {hasPrevious && (
          <Button
            type="button"
            variant={showDiff ? 'default' : 'outline'}
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => setShowDiff((v) => !v)}
            disabled={disabled || !hasChanges}
            title={hasChanges ? '既存内容との差分を表示' : '変更がありません'}
          >
            <GitCompareArrows className="size-3" />
            差分
            {hasChanges && <span className="ml-1 text-[10px] opacity-70">(変更あり)</span>}
          </Button>
        )}
      </div>

      {/* 入力欄 + プレビュー */}
      <div className={`grid gap-3 ${showPreview ? 'md:grid-cols-2' : 'grid-cols-1'}`}>
        <textarea
          className={textareaClassName}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={rows}
          maxLength={maxLength}
          required={required}
          placeholder={placeholder}
          disabled={disabled}
        />
        {showPreview && (
          <div
            className="rounded-md border border-input bg-muted/30 px-3 py-2 text-sm overflow-auto"
            style={{ minHeight: `${rows * 1.5}rem` }}
            aria-label="プレビュー"
          >
            <PreviewContent value={value} />
          </div>
        )}
      </div>

      {/* 差分パネル (previousValue があり、かつトグル ON のとき) */}
      {showDiff && changes && (
        <div className="rounded-md border border-input bg-muted/20 p-3 space-y-2">
          <div className="text-xs font-semibold text-muted-foreground">既存内容との差分</div>
          <div className="grid gap-3 md:grid-cols-2">
            <DiffPane
              label="既存内容 (削除箇所を取消線)"
              chunks={extractBeforeChunks(changes)}
              side="before"
            />
            <DiffPane
              label="変更後 (追加箇所を強調)"
              chunks={extractAfterChunks(changes)}
              side="after"
            />
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * プレビュー描画。Markdown 構文を含めば react-markdown、含まなければ
 * whitespace-pre-wrap でプレーン表示。
 */
function PreviewContent({ value }: { value: string }) {
  if (!value || value.trim().length === 0) {
    return <span className="text-xs text-muted-foreground italic">(プレビュー)</span>;
  }
  return <MarkdownDisplay value={value} />;
}

/**
 * 読み取り専用ビューで Markdown 形式のテキストを描画する。
 * 「テキストはテキストのまま、Markdown は Markdown プレビュー」のロジックを
 * read-only display にも揃えるために共有コンポーネントとして export。
 *
 * 使用箇所:
 *   - MarkdownTextarea のプレビューパネル (内部)
 *   - all-memos の詳細 dialog (read-only ビュー)
 */
export function MarkdownDisplay({ value, className }: { value: string; className?: string }) {
  if (isMarkdown(value)) {
    return (
      <div className={`prose prose-sm max-w-none dark:prose-invert ${className ?? ''}`}>
        <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
          {value}
        </ReactMarkdown>
      </div>
    );
  }
  return <p className={`whitespace-pre-wrap break-words ${className ?? ''}`}>{value}</p>;
}

/**
 * 差分の片側 (旧 or 新) を表示。語単位の chunks を span でレンダリングし、
 * 追加 (added) は緑背景、削除 (removed) は赤背景 + 取消線。
 */
function DiffPane({
  label,
  chunks,
  side,
}: {
  label: string;
  chunks: Change[];
  side: 'before' | 'after';
}) {
  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="rounded-md border border-input bg-background p-2 text-sm whitespace-pre-wrap break-words font-mono">
        {chunks.map((c, i) => {
          if (c.added && side === 'after') {
            return (
              <span
                key={i}
                className="bg-success/20 text-success-foreground"
              >
                {c.value}
              </span>
            );
          }
          if (c.removed && side === 'before') {
            return (
              <span
                key={i}
                className="bg-destructive/20 text-destructive line-through"
              >
                {c.value}
              </span>
            );
          }
          return <span key={i}>{c.value}</span>;
        })}
      </div>
    </div>
  );
}
