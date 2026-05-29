'use client';

/**
 * PR-2 perf (2026-05-29): MARKDOWN_COMPONENTS を独立ファイルに切り出し、
 *   markdown-render-inner.tsx 専用 chunk 内で参照させる。
 *
 * 経緯:
 *   `prose` クラス (Tailwind Typography プラグイン) は当プロジェクトで未導入のため、
 *   見出し / リスト / コードブロック等の視覚的差別化が効かなかった。プラグイン追加は
 *   依存・ビルドサイズ増のため、必要要素にだけ explicit class を当てる方針を採用。
 *
 *   全テーマで一貫した「見出しは大きく / コードは monospace + 灰背景 / 引用は左罫線」
 *   になるよう、テーマ非依存のテキストサイズ + テーマトークン色 (border, muted) を使う。
 */

import type React from 'react';

export const MARKDOWN_COMPONENTS = {
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
