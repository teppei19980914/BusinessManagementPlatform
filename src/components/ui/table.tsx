"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

function Table({ className, ...props }: React.ComponentProps<"table">) {
  // overflow-x-auto の役割（2026-04-17 再導入）:
  //   main は画面いっぱいまで広げているので通常は横スクロール不要だが、
  //   viewport が狭い場合や列数が多い場合にテーブル content が親を超えることがある。
  //   wrapper 側に overflow-x-auto を置くことで、テーブルのはみ出しは wrapper 内に
  //   閉じ込められ、page-level の横スクロールやヘッダずれを防ぐ。
  //   はみ出しが無い場合はスクロールバーも出ないので、通常閲覧時の UX は維持。
  return (
    <div data-slot="table-container" className="relative w-full overflow-x-auto">
      <table
        data-slot="table"
        className={cn("w-full caption-bottom text-xs md:text-sm", className)}
        {...props}
      />
    </div>
  )
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      // 2026-05-01 (PR feat/sticky-table-headers): Excel 風のヘッダー固定化。
      //   - `sticky top-0`: 縦スクロール時にヘッダー行を viewport 上端 (DashboardHeader が
      //     非 sticky なので、スクロールすると DashboardHeader が消えた後の上端) に固定。
      //   - `bg-card`: 下の行が透けないため必須 (sticky element に背景色がないと裏が透ける)。
      //   - `z-10`: dropdown (z-50) / Toast (z-50) / Dialog overlay (z-50) より下に固定。
      //     行内の元々ある要素 (リンク等) より上にする目的。
      //   - `[&>tr>th]:bg-card`: 一部ブラウザで thead 自体への bg-card が効かない場合の保険。
      //     th セルにも背景色を入れる二重指定。
      //   - 既存の `[&_tr]:border-b` は維持 (1px の区切り線)。
      className={cn(
        "sticky top-0 z-10 bg-card [&>tr>th]:bg-card [&_tr]:border-b",
        className,
      )}
      {...props}
    />
  )
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  )
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn(
        "border-t bg-muted/50 font-medium [&>tr]:last:border-b-0",
        className
      )}
      {...props}
    />
  )
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "border-b transition-colors hover:bg-muted/50 has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted",
        className
      )}
      {...props}
    />
  )
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      // 動的リサイズ: 小さい viewport では padding と高さを縮めて情報を詰め込む。
      // md (768px) 以上で通常サイズ。各ページで whitespace-nowrap 等は className 上書き可能。
      className={cn(
        "h-8 px-1.5 md:h-10 md:px-2 text-left align-middle font-medium text-foreground [&:has([role=checkbox])]:pr-0",
        className
      )}
      {...props}
    />
  )
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      // 本文セルも同様に compact→通常の段階を持つ。長文は自然に折返し、
      // ID・日付等は呼び出し側で whitespace-nowrap を指定する運用。
      className={cn(
        "p-1.5 md:p-2 align-middle break-words [&:has([role=checkbox])]:pr-0",
        className
      )}
      {...props}
    />
  )
}

function TableCaption({
  className,
  ...props
}: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("mt-4 text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
}
