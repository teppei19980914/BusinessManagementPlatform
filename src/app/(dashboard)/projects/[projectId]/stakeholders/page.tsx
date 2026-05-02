import { redirect } from 'next/navigation';

type Props = {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ stakeholderId?: string }>;
};

/**
 * `/projects/[id]/stakeholders` の互換ルート (PR feat/notification-deep-link-completion / 2026-05-01)。
 *
 * 背景:
 *   - Stakeholder UI はプロジェクト詳細画面のタブ ([SPECIFICATION §7.9.1]) として実装されており、
 *     独立した URL を持たない。専用 page.tsx は意図的に作っていない。
 *   - PR #207 (mention 機能) の通知 link 生成 (`entity-link.ts`) で
 *     `/projects/[id]/stakeholders?stakeholderId=...` 形式を採用していたため、本ルートは
 *     ずっと 404 を返していた。
 *   - PR #212 で `/projects/[id]?tab=stakeholders&stakeholderId=...` 形式に修正済。
 *   - **PR #207 〜 PR #212 の間に発行された Notification.link は DB に旧 URL のまま残存**。
 *     本ルートはその旧 URL を新 URL にリダイレクトする互換レイヤー。
 *
 * 動作:
 *   /projects/<pid>/stakeholders?stakeholderId=<sid>  →  /projects/<pid>?tab=stakeholders&stakeholderId=<sid>
 *   /projects/<pid>/stakeholders                      →  /projects/<pid>?tab=stakeholders
 *
 *   project member 認可は redirect 後の project page 側で再判定される。
 *   (= ProjectMember 以外 + admin でない場合は project page で notFound)
 *
 * 後続対応: knowledge/page.tsx と同様、旧通知の一括期限切れ後に削除可能。
 */
export default async function ProjectStakeholdersLegacyRedirect({ params, searchParams }: Props) {
  const { projectId } = await params;
  const { stakeholderId } = await searchParams;
  if (stakeholderId) {
    redirect(`/projects/${projectId}?tab=stakeholders&stakeholderId=${stakeholderId}`);
  }
  redirect(`/projects/${projectId}?tab=stakeholders`);
}
