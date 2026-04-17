import { Skeleton } from '@/components/ui/skeleton';

/**
 * プロジェクト詳細画面の読み込み中 UI。
 *
 * サーバ側で auth + membership + project 取得を実施している間に、
 * タブ構造を含む骨格を即座に描画し、ユーザに「ページが開き始めた」という
 * 即時フィードバックを与える。
 *
 * 内容表示後もタブ切替時の個別フェッチは ProjectDetailClient 内の
 * LazyTabContent に委譲される（二段構え）。
 */
export default function ProjectDetailLoading() {
  return (
    <div className="space-y-6">
      {/* ヘッダー: タイトル + ステータスバッジ + アクションボタン */}
      <div className="flex items-start justify-between">
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-6 w-20 rounded-full" />
          </div>
          <Skeleton className="h-5 w-40" />
        </div>
        <div className="flex items-center gap-2">
          <Skeleton className="h-9 w-24" />
          <Skeleton className="h-9 w-16" />
          <Skeleton className="h-9 w-24" />
        </div>
      </div>

      {/* タブリスト骨格 */}
      <div className="flex flex-wrap gap-2">
        {['概要', '見積もり', 'WBS管理', 'ガント', 'リスク/課題', '振り返り', 'ナレッジ', 'メンバー'].map((label) => (
          <div
            key={label}
            className="rounded-md border border-gray-200 px-3 py-1.5 text-sm text-gray-300"
          >
            {label}
          </div>
        ))}
      </div>

      {/* 概要タブの骨格 */}
      <div className="mt-4 space-y-6">
        <div className="grid gap-6 md:grid-cols-2">
          <Skeleton className="h-40 rounded-lg" />
          <Skeleton className="h-40 rounded-lg" />
          <Skeleton className="h-40 rounded-lg" />
          <Skeleton className="h-40 rounded-lg" />
        </div>
      </div>
    </div>
  );
}
