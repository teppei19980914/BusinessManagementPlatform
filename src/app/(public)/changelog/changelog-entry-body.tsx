'use client';

/**
 * Changelog エントリ本文の Markdown 描画 (feat/app-version-changelog-footer / 2026-05-23)。
 *
 * 親 page.tsx (Server Component) から受け取った markdown 文字列を react-markdown で描画。
 * `markdown-textarea.tsx` と同じ remark-gfm + remark-breaks プラグイン構成で
 * 表示一貫性を担保する。raw HTML 不許可 (react-markdown 既定)。
 *
 * Tailwind の prose クラスは導入していないため、最小限の見出し / 段落 / リスト
 * スタイルを components prop で明示的に与える。
 */

import ReactMarkdown from 'react-markdown';
import rehypeSlug from 'rehype-slug';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

interface ChangelogEntryBodyProps {
  body: string;
}

export function ChangelogEntryBody({ body }: ChangelogEntryBodyProps) {
  return (
    <div className="text-sm leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        rehypePlugins={[rehypeSlug]}
        components={{
          h3: ({ children, ...props }) => (
            <h3 className="mt-4 text-base font-semibold" {...props}>
              {children}
            </h3>
          ),
          h4: ({ children, ...props }) => (
            <h4 className="mt-3 text-sm font-semibold" {...props}>
              {children}
            </h4>
          ),
          p: ({ children, ...props }) => (
            <p className="my-2" {...props}>
              {children}
            </p>
          ),
          ul: ({ children, ...props }) => (
            <ul className="my-2 list-disc space-y-1 pl-5" {...props}>
              {children}
            </ul>
          ),
          ol: ({ children, ...props }) => (
            <ol className="my-2 list-decimal space-y-1 pl-5" {...props}>
              {children}
            </ol>
          ),
          a: ({ children, href, ...props }) => {
            const isSamePageAnchor = href?.startsWith('#') ?? false;
            return (
              <a
                href={href}
                {...(!isSamePageAnchor && { target: '_blank', rel: 'noopener noreferrer' })}
                className="text-blue-600 hover:underline dark:text-blue-400"
                {...props}
              >
                {children}
              </a>
            );
          },
          code: ({ children, ...props }) => (
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs" {...props}>
              {children}
            </code>
          ),
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}
