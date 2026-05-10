import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { LOGIN_ROUTE } from '@/config';
import { GuideClient } from './guide-client';

/**
 * 使い方画面 (PR I / 2026-05-09 / #1).
 *
 * 目的:
 *   サインアップ直後のユーザが「全体像 + ロール別の使い方 + 用語」を 1 画面で把握できる
 *   ハブとして機能。離脱率の最大化要因「最初に何をすべきか分からない」を解消する。
 *
 * 設計判断:
 *   - server component で session から systemRole を取り出し、初期 tab を出し分ける
 *     (テナント管理者なら tab=admin、それ以外は tab=member、PM/PL の判別は project 単位なので
 *     UI 上 tab 切替で全ロールを閲覧可能にする)
 *   - 用語集は accordion ではなく定義リストで「Ctrl+F で検索したい」ニーズに応える
 *   - LP リンクは画面冒頭 + 末尾 CTA の 2 箇所 (初見ユーザは LP に戻りたいことが多く、
 *     一読後にアップセル CTA としても機能)
 */
export default async function GuidePage() {
  const session = await auth();
  if (!session) redirect(LOGIN_ROUTE);

  const systemRole = session.user.systemRole;
  const initialTab: 'admin' | 'pm' | 'member' | 'viewer' =
    systemRole === 'admin' || systemRole === 'super_admin' ? 'admin' : 'member';

  return <GuideClient initialTab={initialTab} userName={session.user.name ?? ''} />;
}
