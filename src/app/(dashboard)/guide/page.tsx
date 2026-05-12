import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { LOGIN_ROUTE } from '@/config';
import { resolveGuideRole } from '@/services/guide-role.service';
import { GuideClient } from './guide-client';

/**
 * 使い方画面 (PR I / 2026-05-09 / #1, リファクタ 2026-05-11).
 *
 * 目的:
 *   サインアップ直後のユーザが「全体像 + 自分のロールでやること + 用語」を 1 画面で把握できる
 *   ハブとして機能。離脱率の最大化要因「最初に何をすべきか分からない」を解消する。
 *
 * 2026-05-11 リファクタ:
 *   - ロール別タブ廃止: systemRole + ProjectMember.projectRole からユーザに合うセクションのみ表示
 *     (4 ロールのタブを並べると、自分が何者か考えるコストが発生 + 関係ない情報が視界に入る)
 *   - 全体像を視覚的なフロー図 + ロール × できること表で表現
 *   - 一般メンバー / 閲覧者には生成 AI ロジック詳細を出さない (= 業務に不要な認知負荷を減らす)
 *   - LP / FAQ ボタンはヘッダから削除、末尾 CTA のみに集約 (= AccountMenu でも到達可能)
 */
export default async function GuidePage() {
  const session = await auth();
  if (!session) redirect(LOGIN_ROUTE);

  const role = await resolveGuideRole(session.user.id, session.user.systemRole);

  return (
    <GuideClient
      role={role}
      systemRole={session.user.systemRole}
      userName={session.user.name ?? ''}
    />
  );
}
