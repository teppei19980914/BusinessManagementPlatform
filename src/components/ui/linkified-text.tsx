'use client';

/**
 * プレーンテキスト中の http/https URL をハイパーリンク化して描画するヘルパ
 * (feat/url-autolink)。
 *
 * 用途:
 *   Markdown 描画 (react-markdown) を経由しない「素のテキスト表示」面で、URL を
 *   クリック可能なリンクにする。react-markdown chunk を読み込まない軽量な経路向け。
 *   - MarkdownDisplay のプレーン分岐 (Markdown 構文を含まないテキスト)
 *   - 顧客の備考、コメント本文、システムお知らせバナー 等の素テキスト表示
 *
 * 境界判定は src/lib/url-linkify.ts の splitByUrl() に委譲 (CJK 直後でも URL 部分
 * だけを正しく切り出す)。リンクは新規タブ + rel="noopener noreferrer" で安全に開く
 * (markdown-components.tsx の a と同じ方針 / クラス)。
 */

import { Fragment } from 'react';
import { splitByUrl } from '@/lib/url-linkify';

/** リンクと外部遷移の表示クラス。Markdown 描画側の a と統一。 */
const LINK_CLASS = 'text-info underline hover:no-underline';

/**
 * テキストを React ノード列へ変換する。URL セグメントは <a>、その他は素の文字列。
 * 既存の `<p>` 等の中にそのまま差し込めるよう、ラッパ要素は付けない。
 */
export function linkifyNodes(text: string | null | undefined): React.ReactNode[] {
  if (!text) return [];
  return splitByUrl(text).map((seg, i) => {
    if (seg.type === 'url') {
      return (
        <a
          key={i}
          href={seg.value}
          target="_blank"
          rel="noopener noreferrer"
          className={LINK_CLASS}
        >
          {seg.value}
        </a>
      );
    }
    return <Fragment key={i}>{seg.value}</Fragment>;
  });
}

/**
 * URL リンク化したテキストを `<p>` で表示する共有コンポーネント。
 * whitespace-pre-wrap / break-words で改行・長語を保持 (素テキスト表示の既定挙動)。
 */
export function LinkifiedText({
  value,
  className,
}: {
  value: string | null | undefined;
  className?: string;
}) {
  return (
    <p className={`whitespace-pre-wrap break-words ${className ?? ''}`}>
      {linkifyNodes(value)}
    </p>
  );
}
