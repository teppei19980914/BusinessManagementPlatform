import { redirect } from 'next/navigation';

type Props = {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ knowledgeId?: string }>;
};

/**
 * `/projects/[id]/knowledge` の互換ルート (PR feat/notification-deep-link-completion / 2026-05-01)。
 *
 * 背景:
 *   - knowledge は N:M で複数 project に紐付く設計のため、専用 UI は存在せず
 *     /knowledge (cross-list) で一括管理する設計。
 *   - PR #207 (mention 機能) の通知 link 生成 (`entity-link.ts`) で誤って
 *     `/projects/[id]/knowledge?knowledgeId=...` 形式を採用していたため、本ルートは
 *     ずっと 404 を返していた (page.tsx 不在)。実害は通知 deep link クリック時のみだが、
 *     PR #211 で /knowledge?knowledgeId=... 形式に修正済。
 *   - **しかし、PR #207 〜 PR #211 の間に発行された Notification.link は DB に旧 URL のまま
 *     残存** している。本ルートはその旧 URL を新 URL にリダイレクトする互換レイヤー。
 *
 * 動作:
 *   /projects/<pid>/knowledge?knowledgeId=<kid>  →  /knowledge?knowledgeId=<kid>
 *   /projects/<pid>/knowledge                    →  /knowledge
 *
 *   project member 認可は不要 (cross-list 側で visibility=public のみ閲覧可)。
 *
 * 後続対応:
 *   旧通知が一定期間で全て期限切れ (=既読 + 自動削除) になった後、本ファイルを削除可能。
 *   現状 Notification の自動削除バッチは未整備 (T-X14 等)。
 */
export default async function ProjectKnowledgeLegacyRedirect({ searchParams }: Props) {
  const { knowledgeId } = await searchParams;
  if (knowledgeId) {
    redirect(`/knowledge?knowledgeId=${knowledgeId}`);
  }
  redirect('/knowledge');
}
