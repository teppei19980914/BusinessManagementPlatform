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
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import { Eye, GitCompareArrows } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  isMarkdown,
  computeWordDiff,
  extractBeforeChunks,
  extractAfterChunks,
} from '@/lib/markdown-utils';
import type { Change } from 'diff';

/**
 * PR-2 perf (2026-05-29): react-markdown + remark-gfm + remark-breaks (~150KB / gzip 35KB)
 *   を `next/dynamic` で別 chunk に分離。`ssr: true` を維持しているため、
 *   project-detail 概要タブ等のサーバ描画は引き続き機能する (初期 HTML に含まれる)。
 *   クライアント側では markdown を含むページに到達するまで chunk がロードされず、
 *   初期 JS bundle が軽量化される (全 dashboard 画面の LCP 改善見込み)。
 */
const MarkdownRenderInner = dynamic(() => import('./markdown-render-inner'), {
  ssr: true,
  loading: () => null,
});

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
  const t = useTranslations('common');
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
          {t('preview')}
        </Button>
        {hasPrevious && (
          <Button
            type="button"
            variant={showDiff ? 'default' : 'outline'}
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => setShowDiff((v) => !v)}
            disabled={disabled || !hasChanges}
            title={hasChanges ? t('diffShowTooltip') : t('diffNoChangeTooltip')}
          >
            <GitCompareArrows className="size-3" />
            {t('diff')}
            {hasChanges && <span className="ml-1 text-[10px] opacity-70">{t('diffChangedSuffix')}</span>}
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
            aria-label={t('preview')}
          >
            <PreviewContent value={value} />
          </div>
        )}
      </div>

      {/* 差分パネル (previousValue があり、かつトグル ON のとき) */}
      {showDiff && changes && (
        <div className="rounded-md border border-input bg-muted/20 p-3 space-y-2">
          <div className="text-xs font-semibold text-muted-foreground">{t('diffSectionTitle')}</div>
          <div className="grid gap-3 md:grid-cols-2">
            <DiffPane
              label={t('diffPaneBeforeLabel')}
              chunks={extractBeforeChunks(changes)}
              side="before"
            />
            <DiffPane
              label={t('diffPaneAfterLabel')}
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
  const t = useTranslations('common');
  if (!value || value.trim().length === 0) {
    return <span className="text-xs text-muted-foreground italic">{t('previewParenthesized')}</span>;
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
 *   - project-detail の概要タブ (purpose / background / scope / outOfScope / notes)
 */
export function MarkdownDisplay({ value, className }: { value: string; className?: string }) {
  // PR-2 perf (2026-05-29): isMarkdown 判定は本ファイル内 (= 主 bundle) で実行し、Markdown
  //   構文を含まないテキストでは react-markdown chunk のロードを発生させない (= 大半の
  //   プレーンテキスト表示で chunk 不要)。Markdown のときだけ dynamic chunk を fetch。
  if (isMarkdown(value)) {
    return <MarkdownRenderInner value={value} className={className} />;
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
