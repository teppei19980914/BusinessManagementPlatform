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
 * react-markdown の各要素に明示的な Tailwind クラスを当てるためのコンポーネント
 * オーバーライド (feat/markdown-textarea-fixes)。
 *
 * 経緯:
 *   `prose` クラス (Tailwind Typography プラグイン) は当プロジェクトで未導入のため、
 *   見出し / リスト / コードブロック等の視覚的差別化が効かなかった。プラグイン追加は
 *   依存・ビルドサイズ増のため、必要要素にだけ explicit class を当てる方針を採用。
 *
 *   全テーマで一貫した「見出しは大きく / コードは monospace + 灰背景 / 引用は左罫線」
 *   になるよう、テーマ非依存のテキストサイズ + テーマトークン色 (border, muted) を使う。
 */
const MARKDOWN_COMPONENTS = {
  h1: ({ children }: { children?: React.ReactNode }) => (
    <h1 className="mt-3 mb-2 text-xl font-bold border-b border-border pb-1">{children}</h1>
  ),
  h2: ({ children }: { children?: React.ReactNode }) => (
    <h2 className="mt-3 mb-2 text-lg font-bold border-b border-border pb-0.5">{children}</h2>
  ),
  h3: ({ children }: { children?: React.ReactNode }) => (
    <h3 className="mt-2 mb-1 text-base font-bold">{children}</h3>
  ),
  h4: ({ children }: { children?: React.ReactNode }) => (
    <h4 className="mt-2 mb-1 text-sm font-bold">{children}</h4>
  ),
  h5: ({ children }: { children?: React.ReactNode }) => (
    <h5 className="mt-2 mb-1 text-sm font-semibold">{children}</h5>
  ),
  h6: ({ children }: { children?: React.ReactNode }) => (
    <h6 className="mt-2 mb-1 text-xs font-semibold uppercase tracking-wide">{children}</h6>
  ),
  p: ({ children }: { children?: React.ReactNode }) => (
    <p className="my-1 leading-relaxed">{children}</p>
  ),
  ul: ({ children }: { children?: React.ReactNode }) => (
    <ul className="my-1 ml-5 list-disc space-y-0.5">{children}</ul>
  ),
  ol: ({ children }: { children?: React.ReactNode }) => (
    <ol className="my-1 ml-5 list-decimal space-y-0.5">{children}</ol>
  ),
  li: ({ children }: { children?: React.ReactNode }) => <li className="leading-snug">{children}</li>,
  blockquote: ({ children }: { children?: React.ReactNode }) => (
    <blockquote className="my-2 border-l-4 border-border pl-3 text-muted-foreground italic">
      {children}
    </blockquote>
  ),
  code: ({ inline, children }: { inline?: boolean; children?: React.ReactNode }) =>
    inline ? (
      <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]">{children}</code>
    ) : (
      <code className="block font-mono text-[0.9em]">{children}</code>
    ),
  pre: ({ children }: { children?: React.ReactNode }) => (
    <pre className="my-2 overflow-x-auto rounded-md bg-muted p-2 text-xs">{children}</pre>
  ),
  a: ({ children, href }: { children?: React.ReactNode; href?: string }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-info underline hover:no-underline"
    >
      {children}
    </a>
  ),
  hr: () => <hr className="my-3 border-border" />,
  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="my-2 overflow-x-auto">
      <table className="border-collapse border border-border text-xs">{children}</table>
    </div>
  ),
  th: ({ children }: { children?: React.ReactNode }) => (
    <th className="border border-border bg-muted px-2 py-1 text-left font-semibold">{children}</th>
  ),
  td: ({ children }: { children?: React.ReactNode }) => (
    <td className="border border-border px-2 py-1">{children}</td>
  ),
  strong: ({ children }: { children?: React.ReactNode }) => (
    <strong className="font-bold">{children}</strong>
  ),
  em: ({ children }: { children?: React.ReactNode }) => <em className="italic">{children}</em>,
};

/**
 * 読み取り専用ビューで Markdown 形式のテキストを描画する。
 * 「テキストはテキストのまま、Markdown は Markdown プレビュー」のロジックを
 * read-only display にも揃えるために共有コンポーネントとして export。
 *
 * 使用箇所:
 *   - MarkdownTextarea のプレビューパネル (内部)
 *   - all-memos の詳細 dialog (read-only ビュー)
 *   - project-detail の概要タブ (purpose / background / scope / outOfScope / notes)
 */
export function MarkdownDisplay({ value, className }: { value: string; className?: string }) {
  if (isMarkdown(value)) {
    return (
      <div className={`text-sm ${className ?? ''}`}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkBreaks]}
          components={MARKDOWN_COMPONENTS}
        >
          {value}
        </ReactMarkdown>
      </div>
    );
  }
  return <p className={`whitespace-pre-wrap break-words ${className ?? ''}`}>{value}</p>;
}

/**
 * 差分の片側 (旧 or 新) を表示。語単位の chunks を span でレンダリングし、
 * 追加 (added) / 削除 (removed) ともテーマ別に最適化された塗りつぶし色でハイライト。
 *
 * 色定義 (theme-definitions.ts):
 *   - light テーマ: 追加=緑塗りつぶし白文字、削除=赤塗りつぶし白文字
 *   - dark テーマ : 追加=黄塗りつぶし黒文字、削除=明るい赤塗りつぶし黒文字
 *   - その他テーマ: 既定 (light) の色を継承
 *
 * 「20% 透過」では暗い背景でコントラスト不足のため、塗りつぶし + 高コントラスト
 * 前景色を使う設計に統一 (feat/markdown-textarea-fixes、ユーザ指摘 2)。
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
                className="bg-diff-add-bg text-diff-add-fg rounded px-0.5"
              >
                {c.value}
              </span>
            );
          }
          if (c.removed && side === 'before') {
            return (
              <span
                key={i}
                className="bg-diff-remove-bg text-diff-remove-fg line-through rounded px-0.5"
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
