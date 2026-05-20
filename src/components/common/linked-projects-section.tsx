'use client';

/**
 * LinkedProjectsSection (PR feat/asset-multi-linking-ui Phase 2 / 2026-05-09):
 *
 *   M:N 化された資産 (リスク/課題/振り返り/ナレッジ) のダイアログ内で、
 *   「現在どのプロジェクトに紐付いているか」を chip 形式で表示する小コンポーネント。
 *
 * 使い方:
 *   <LinkedProjectsSection
 *     entityType="risk"
 *     entityId={risk.id}
 *     linkedProjects={risk.linkedProjects ?? []}
 *     currentProjectId={projectId}
 *     onChanged={onSaved}
 *   />
 *
 * 機能:
 *   - 各 chip にプロジェクト名 + 詳細リンク (削除済プロジェクトは灰色表示)
 *   - "解除" ボタン: 自プロジェクト (currentProjectId) からの紐付けのみ解除可能。
 *     他プロジェクトの紐付けは「そのプロジェクト側で解除する」運用 (認可境界の越境を避ける)。
 *   - 解除後は親 (onChanged) に通知し、リストの再フェッチを促す。
 *
 * 認可:
 *   解除 API (`DELETE /api/projects/:projectId/(risks|retrospectives)/:id/link`) は
 *   project member 以上を要求する (server 側で enforced)。UI 側は currentProjectId と
 *   一致する chip にのみ "解除" ボタンを表示することで、誤操作を最小化する。
 */

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useLoading } from '@/components/loading-overlay';
import { useToast } from '@/components/toast-provider';

type LinkedProject = {
  id: string;
  /** feat/crud-permission-redesign (2026-05-20): 「全○○」横断ビューで非 ProjectMember には null。
   *  null の場合 chip は「非公開のプロジェクト」プレースホルダ表示、詳細リンク・解除操作とも無効化。 */
  name: string | null;
  deleted: boolean;
};

type Props = {
  entityType: 'risk' | 'issue' | 'retrospective';
  entityId: string;
  linkedProjects: LinkedProject[];
  /** 現在開かれているダイアログのコンテキスト project (= 解除対象として許可される 1 件)。
   *  全リスク/全振り返り画面など project コンテキスト無しで開く場合は null。 */
  currentProjectId: string | null;
  /** 解除成功後のリロードコールバック */
  onChanged: () => void | Promise<void>;
};

export function LinkedProjectsSection({
  entityType,
  entityId,
  linkedProjects,
  currentProjectId,
  onChanged,
}: Props) {
  const t = useTranslations('linkedProjects');
  const { withLoading } = useLoading();
  const { showSuccess, showError } = useToast();

  // entityType を URL セグメントへ写像 (issue は riskIssue 経由なので /risks/ にぶら下がる)
  const apiSegment = entityType === 'retrospective' ? 'retrospectives' : 'risks';

  async function handleUnlink(projectId: string, projectName: string) {
    if (!confirm(t('unlinkConfirm', { name: projectName }))) return;
    const url = `/api/projects/${projectId}/${apiSegment}/${entityId}/link`;
    const res = await withLoading(() => fetch(url, { method: 'DELETE' }));
    if (!res.ok) {
      showError(t('unlinkFailed'));
      return;
    }
    showSuccess(t('unlinkSuccess', { name: projectName }));
    await onChanged();
  }

  // 紐付けが 1 件のみ + currentProjectId が一致する場合は「最後の紐付けを外すと孤児 (orphan) 化する」
  // 警告を出す。完全に禁止はしない (orphan は user 要件に明記された許容ケース)。
  const isLastLink = linkedProjects.length === 1;

  if (linkedProjects.length === 0) {
    return (
      <section className="rounded border border-dashed p-3 text-sm text-muted-foreground">
        <p>{t('noLinks')}</p>
      </section>
    );
  }

  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">
          {t('sectionTitle', { count: linkedProjects.length })}
        </h3>
        {isLastLink && (
          <span className="text-xs text-amber-600 dark:text-amber-400">
            {t('lastLinkWarning')}
          </span>
        )}
      </div>
      <ul className="flex flex-wrap gap-2">
        {linkedProjects.map((p) => {
          const isCurrent = p.id === currentProjectId;
          // feat/crud-permission-redesign (2026-05-20): name=null は「非公開のプロジェクト」表示。
          //   非 ProjectMember には紐付け先プロジェクト名を秘匿し、詳細リンクも無効化する。
          const isPrivate = p.name == null;
          const displayName = isPrivate ? t('privateProject') : p.name!;
          return (
            <li
              key={p.id}
              className={`flex max-w-full items-center gap-1.5 overflow-hidden rounded-full border px-2.5 py-1 text-xs ${
                p.deleted
                  ? 'bg-muted text-muted-foreground line-through'
                  : isPrivate
                    ? 'bg-muted text-muted-foreground italic'
                    : 'bg-card'
              }`}
              title={p.deleted ? t('deletedProjectTitle') : displayName}
            >
              {p.deleted || isPrivate ? (
                <span className="min-w-0 flex-1 truncate">{displayName}</span>
              ) : (
                <Link
                  href={`/projects/${p.id}`}
                  className="min-w-0 flex-1 truncate hover:underline"
                  onClick={(e) => e.stopPropagation()}
                  title={displayName}
                >
                  {displayName}
                </Link>
              )}
              {isCurrent && (
                <Badge variant="outline" className="ml-0.5 shrink-0 px-1 py-0 text-[10px]">
                  {t('currentBadge')}
                </Badge>
              )}
              {isCurrent && !p.deleted && !isPrivate && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="ml-0.5 h-4 w-4 shrink-0 text-muted-foreground hover:text-destructive"
                  onClick={() => handleUnlink(p.id, displayName)}
                  title={t('unlinkButtonTitle')}
                  aria-label={t('unlinkButtonTitle')}
                >
                  <span aria-hidden>×</span>
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-muted-foreground">{t('hint')}</p>
    </section>
  );
}
