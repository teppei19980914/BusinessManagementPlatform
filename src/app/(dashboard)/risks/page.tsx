import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';

/**
 * 全プロジェクト横断のリスク/課題ビュー（準備中）
 *
 * Phase A: 導線のみ。タブから遷移できるが中身は未実装のプレースホルダ。
 * Phase B で以下を実装予定:
 *   - 全プロジェクトのリスク/課題を集約表示するサーバサービス
 *   - API エンドポイント
 *   - 検索・絞り込み・プロジェクト名表示
 *   - 認可: ログインユーザなら全プロジェクトのリスク/課題を閲覧可（編集はプロジェクトメンバーのみ）
 */
export default async function AllRisksPage() {
  const session = await auth();
  if (!session) redirect('/login');

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold">全リスク/課題</h2>
      <div className="rounded-lg border border-dashed p-12 text-center">
        <p className="text-gray-600">この画面は準備中です。</p>
        <p className="mt-2 text-sm text-gray-500">
          全プロジェクト横断でリスク・課題を確認できる一覧を実装予定です。
        </p>
      </div>
    </div>
  );
}
