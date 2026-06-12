'use client';

/**
 * PR-2 perf (2026-05-29): react-markdown + remark-gfm + remark-breaks の重い依存
 *   (~150KB gzip ~35KB) を **専用 chunk に分離** するための内部コンポーネント。
 *
 * 使い方:
 *   markdown-textarea.tsx の `MarkdownDisplay` が `next/dynamic` で本ファイルを読込み、
 *   isMarkdown() で true のときだけ本コンポーネントを描画する。
 *   `ssr: true` を維持しているため SSR は引き続き機能する (project-detail 概要タブ等で
 *   サーバ描画される文章は初期 HTML に含まれる)。client-side では markdown を含む
 *   ページに到達するまで chunk がロードされない = 初期 JS bundle が軽量化。
 *
 * 非依存:
 *   - 親 (MarkdownTextarea / MarkdownDisplay) と独立しているため、循環参照は発生しない。
 *   - `MARKDOWN_COMPONENTS` は親側から props として受け取らず、ここで定義 + 再利用する。
 */

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import remarkLinkifyUrls from '@/lib/remark-linkify-urls';
import { MARKDOWN_COMPONENTS } from './markdown-components';

export default function MarkdownRenderInner({
  value,
  className,
}: {
  value: string;
  className?: string;
}) {
  return (
    <div className={`text-sm ${className ?? ''}`}>
      <ReactMarkdown
        // remarkGfm の後に linkify を置き、gfm autolink が CJK を巻き込んだ URL を補正する
        remarkPlugins={[remarkGfm, remarkBreaks, remarkLinkifyUrls]}
        components={MARKDOWN_COMPONENTS}
      >
        {value}
      </ReactMarkdown>
    </div>
  );
}
