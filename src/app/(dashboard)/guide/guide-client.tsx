'use client';

/**
 * 使い方ガイド client (PR I / 2026-05-11 リファクタ)
 *
 * 構成 (上から順):
 *   1. ヘッダ (タイトル + 自分のロール表示) — LP/FAQ ボタンは削除 (AccountMenu に集約)
 *   2. サービスの全体像 — 4 ステップフロー (視覚的) + ロール×できること表
 *   3. あなたのやること — ユーザのロール (admin/pm/member/viewer) に応じたセクションのみ
 *   4. 用語集 — ロールに応じて必要な用語のみ (一般・閲覧者は AI ロジック関連を省略)
 *   5. 末尾 CTA — LP / FAQ / Discord (旧 PR では top + bottom の重複あり → bottom のみに)
 *
 * 設計判断:
 *   - **タブ廃止**: 「自分のロールを選ぶ」操作を撤廃。ユーザに不要な選択コストを掛けない。
 *     admin / super_admin にはテナント管理者の作業を表示 (= PM 作業は別途プロジェクト内 UI で学習)
 *   - **AI 詳細は admin/pm のみ**: 業務に直接関係しない「埋め込み」「Anthropic 単価」等は
 *     一般メンバー・閲覧者の用語集から除外
 *   - **視覚的全体像**: 横並びの 4 ステップフロー (矢印付き) + 表でロール × やることを併記
 */

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  PRODUCT_LP_URL,
  HELP_ROUTE,
  PROJECTS_ROUTE,
  MY_TASKS_ROUTE,
  KNOWLEDGE_ROUTE,
  ALL_RISKS_ROUTE,
  ALL_ISSUES_ROUTE,
  ALL_RETROSPECTIVES_ROUTE,
  getDiscordInviteUrl,
} from '@/config';
import type { GuideRole } from '@/services/guide-role.service';

type Props = {
  /** 解決済の表示ロール (= guide-role.service.ts で systemRole + projectRole から判定) */
  role: GuideRole;
  /** ロールラベル併記用 (admin と super_admin の区別) */
  systemRole: string;
  userName: string;
};

export function GuideClient({ role, systemRole, userName }: Props) {
  const t = useTranslations('guide');
  const tNav = useTranslations('nav');
  const r = t.rich.bind(t);
  const discord = getDiscordInviteUrl();
  // admin/pm 向けには AI ロジックや課金関連の用語まで含める。member/viewer には含めない。
  const showAdvancedTerms = role === 'admin' || role === 'pm';
  const displayRoleLabel =
    systemRole === 'super_admin'
      ? t('roleLabelSuperAdmin')
      : t(`roleLabel.${role}` as `roleLabel.${GuideRole}`);

  return (
    <div className="mx-auto max-w-5xl space-y-10 pb-12">
      {/* ヘッダ */}
      <header className="space-y-2">
        <h1 className="text-2xl font-bold">{t('header.title')}</h1>
        <p className="text-sm text-muted-foreground">
          {userName && t('header.greetingUser', { userName })}
          {r('header.description', { strong: (c) => <strong key="s">{c}</strong> })}
        </p>
        <p className="inline-flex items-center gap-2 rounded-md border bg-info/5 px-3 py-1 text-xs">
          <span className="text-muted-foreground">{t('header.yourRole')}</span>
          <strong>{displayRoleLabel}</strong>
        </p>
      </header>

      {/* G2-f (2026-05-31): 埋め込みチャットを撤去。チャットは画面右下の FAB に一本化
          ([[feedback_worldview_scope_onboarding_chat_only]])。/guide は静的ガイド本文に専念し、
          検索ボックスも設けない (キーワード探索は用語集の Ctrl+F 案内で代替)。 */}

      {/* 1. サービスの全体像 (視覚化) */}
      <section id="overview" className="space-y-4">
        <h2 className="text-xl font-semibold">{t('overview.title')}</h2>
        <p className="text-sm">
          {r('overview.description', { strong: (c) => <strong key={String(c).slice(0, 4)}>{c}</strong> })}
        </p>

        {/* フロー図: 4 ステップ (横並び、矢印付き) */}
        <FlowDiagram />

        {/* ロール × やること マトリクス表 */}
        <RoleMatrix activeRole={role} />
      </section>

      {/* 2. あなたのやること (ユーザのロール用セクションのみ表示) */}
      <section id="your-work" className="space-y-3">
        <h2 className="text-xl font-semibold">{t('yourWork.title')}</h2>
        {role === 'admin' && <AdminActions systemRole={systemRole} />}
        {role === 'pm' && <PmActions />}
        {role === 'member' && <MemberActions />}
        {role === 'viewer' && <ViewerActions />}
      </section>

      {/* 3. 用語集 (ロールに応じて項目数を絞る) */}
      <section id="glossary" className="space-y-3">
        <h2 className="text-xl font-semibold">{t('glossary.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('glossary.searchHint')}</p>
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {/* 全ロール共通の基本用語 */}
          <GlossaryItem term={t('glossary.termProject')}>
            {t('glossary.defProject')}
          </GlossaryItem>
          <GlossaryItem term={t('glossary.termWbs')}>
            {r('glossary.defWbs', { strong: (c) => <strong key={String(c).slice(0, 3)}>{c}</strong> })}
          </GlossaryItem>
          <GlossaryItem term={t('glossary.termGantt')}>
            {t('glossary.defGantt')}
          </GlossaryItem>
          <GlossaryItem term={t('glossary.termRiskIssue')}>
            {t('glossary.defRiskIssue')}
          </GlossaryItem>
          <GlossaryItem term={t('glossary.termRetroKnowledge')}>
            {t('glossary.defRetroKnowledge')}
          </GlossaryItem>
          <GlossaryItem term={t('glossary.termMention')}>
            {r('glossary.defMention', { code: (c) => <code key="c">{c}</code> })}
          </GlossaryItem>
          <GlossaryItem term={t('glossary.termOwl')}>
            {r('glossary.defOwl', { strong: (c) => <strong key="s">{c}</strong> })}
          </GlossaryItem>

          {/* admin/pm のみに表示する高度な用語 */}
          {showAdvancedTerms && (
            <>
              <GlossaryItem term={t('glossary.termSuggestion')}>
                {r('glossary.defSuggestion', { strong: (c) => <strong key="s">{c}</strong> })}
              </GlossaryItem>
              <GlossaryItem term={t('glossary.termTenant')}>
                {r('glossary.defTenant', { strong: (c) => <strong key="s">{c}</strong> })}
              </GlossaryItem>
              <GlossaryItem term={t('glossary.termPlan')}>
                {r('glossary.defPlan', { strong: (c) => <strong key={String(c).slice(0, 3)}>{c}</strong> })}
              </GlossaryItem>
            </>
          )}
        </dl>
      </section>

      {/* 4. 末尾 CTA: LP / FAQ / Discord (旧 PR I では top にもあった重複を解消) */}
      {/* 2026-05-13 docs/discord-community-positioning: Discord は「開発者へのサポート窓口」ではなく
          開発者・ユーザが集まる「コミュニティ」と位置付ける。ユーザ同士の利用事例共有も発生する場であり、
          単方向のサポートチャネルと誤認されないよう文言を統一する (横展開対象)。 */}
      <section className="rounded-lg border bg-muted/40 p-5">
        <h2 className="text-base font-semibold">{t('cta.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {r('cta.description', { strong: (c) => <strong key="s">{c}</strong> })}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <a
            href={PRODUCT_LP_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md bg-card px-3 py-1.5 text-sm hover:bg-accent"
          >
            {t('cta.lpButton')}
          </a>
          <Link
            href={HELP_ROUTE}
            className="inline-flex items-center gap-1.5 rounded-md bg-card px-3 py-1.5 text-sm hover:bg-accent"
          >
            {t('cta.faqButton')}
          </Link>
          {discord && (
            <a
              href={discord}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md bg-card px-3 py-1.5 text-sm hover:bg-accent"
            >
              💬 {tNav('contactDeveloper')}
            </a>
          )}
        </div>
      </section>
    </div>
  );
}

// ================================================================
// 全体像: 視覚的なフロー図 + ロール × やること表
// ================================================================

/**
 * 4 ステップフロー図 (横並び、矢印付き)。
 * SVG ではなく Tailwind の grid + 矢印を CSS で実現 (依存追加なし)。
 */
function FlowDiagram() {
  const t = useTranslations('guide');
  const steps = [
    { n: 1, titleKey: 'flow.step1Title' as const, bodyKey: 'flow.step1Body' as const },
    { n: 2, titleKey: 'flow.step2Title' as const, bodyKey: 'flow.step2Body' as const },
    { n: 3, titleKey: 'flow.step3Title' as const, bodyKey: 'flow.step3Body' as const },
    { n: 4, titleKey: 'flow.step4Title' as const, bodyKey: 'flow.step4Body' as const },
  ];
  return (
    <div
      className="rounded-lg border bg-card p-4"
      aria-label={t('overview.flowAriaLabel')}
    >
      <ol className="grid grid-cols-1 gap-3 md:grid-cols-4">
        {steps.map((s, idx) => (
          <li
            key={s.n}
            className="relative flex flex-col rounded-md border bg-background p-3 md:pr-5"
          >
            <div className="mb-2 flex items-center gap-2">
              <span className="flex size-7 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
                {s.n}
              </span>
              <strong className="text-sm">{t(s.titleKey)}</strong>
            </div>
            <p className="text-xs text-muted-foreground">{t(s.bodyKey)}</p>
            {/* 矢印 (md 以上で右側に表示、最終ステップは非表示) */}
            {idx < steps.length - 1 && (
              <span
                aria-hidden
                className="absolute -right-3 top-1/2 hidden -translate-y-1/2 text-lg text-muted-foreground md:block"
              >
                →
              </span>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * ロール × できること マトリクス表。
 * 自分のロール行を背景色で強調し、「自分は何ができるか」を一目で把握できる。
 */
function RoleMatrix({ activeRole }: { activeRole: GuideRole }) {
  const t = useTranslations('guide');
  const rows: Array<{
    role: GuideRole;
    labelKey: string;
    items: Array<'create' | 'edit' | 'view' | 'admin'>;
  }> = [
    // 2026-05-13 docs/guide-role-actions: 実装真実 (check-permission.ts) と一致させる修正。
    //   旧マトリクスは admin が 'create' / 'edit' 非可能と表示していたが、これは誤り。
    //   `admin` ロールは check-permission.ts:58 で全アクション (project:create / update / delete /
    //   change_status / task:* / knowledge:* / risk:* / member:manage / admin:users 等) を許可済み。
    //   ガイドが実装と乖離するとユーザが「admin はプロジェクトを作れない」と誤認するため修正。
    { role: 'admin', labelKey: 'roleMatrix.rowAdmin', items: ['create', 'edit', 'view', 'admin'] },
    { role: 'pm', labelKey: 'roleMatrix.rowPm', items: ['create', 'edit', 'view'] },
    { role: 'member', labelKey: 'roleMatrix.rowMember', items: ['edit', 'view'] },
    { role: 'viewer', labelKey: 'roleMatrix.rowViewer', items: ['view'] },
  ];
  const cols: Array<{ key: 'admin' | 'create' | 'edit' | 'view'; labelKey: string }> = [
    { key: 'create', labelKey: 'roleMatrix.colCreate' },
    { key: 'edit', labelKey: 'roleMatrix.colEdit' },
    { key: 'view', labelKey: 'roleMatrix.colView' },
    { key: 'admin', labelKey: 'roleMatrix.colAdmin' },
  ];
  return (
    <div className="overflow-x-auto rounded-lg border bg-card">
      <table className="w-full border-collapse text-sm">
        <thead className="bg-muted/40">
          <tr>
            <th className="border-b p-2 text-left">{t('roleMatrix.headerRole')}</th>
            {cols.map((c) => (
              <th key={c.key} className="border-b p-2 text-left text-xs font-medium">
                {t(c.labelKey as Parameters<typeof t>[0])}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const isMe = r.role === activeRole;
            const label = t(r.labelKey as Parameters<typeof t>[0]);
            return (
              <tr
                key={r.role}
                className={isMe ? 'bg-info/10 font-medium' : ''}
                aria-label={isMe ? t('roleMatrix.ariaYouRole', { label }) : undefined}
              >
                <td className="border-b p-2">
                  {label}
                  {isMe && (
                    <span className="ml-2 rounded bg-info/30 px-1.5 py-0.5 text-xs">
                      {t('roleMatrix.youBadge')}
                    </span>
                  )}
                </td>
                {cols.map((c) => (
                  <td key={c.key} className="border-b p-2 text-center">
                    {r.items.includes(c.key) ? (
                      <span aria-label={t('roleMatrix.abilityYes')} className="text-emerald-600 dark:text-emerald-400">
                        ✓
                      </span>
                    ) : (
                      <span aria-label={t('roleMatrix.abilityNo')} className="text-muted-foreground/40">
                        −
                      </span>
                    )}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ================================================================
// ロール別アクション (ユーザのロールに応じて 1 つだけレンダされる)
// ================================================================

function AdminActions({ systemRole }: { systemRole: string }) {
  const t = useTranslations('guide');
  return (
    <div className="space-y-3 rounded-md border bg-card p-4">
      <p className="text-sm text-muted-foreground">{t('adminActions.description')}</p>
      <ol className="list-decimal space-y-1.5 pl-6 text-sm">
        <li>
          <Link className="text-primary underline" href="/admin/users">
            {t('adminActions.step1LinkText')}
          </Link>{' '}
          {t('adminActions.step1Post')}
        </li>
        {/* 2026-05-13 docs/guide-role-actions: プロジェクト新規作成は admin の主要業務として明示。
            実装真実 (check-permission.ts) では admin / pm_tl の両方が project:create 可能だが、
            運用フロー上 admin がプロジェクトを立ち上げて PM/PL にメンバー権限を割り当てるのが
            標準的。pm_tl も自身で作成可だが、組織管理の文脈では admin の役割が中心。 */}
        <li>
          <Link className="text-primary underline" href={PROJECTS_ROUTE}>
            {t('adminActions.step2LinkText')}
          </Link>{' '}
          {t('adminActions.step2Post')}
        </li>
        <li>
          <Link className="text-primary underline" href="/settings/tenant">
            {t('adminActions.step3LinkText')}
          </Link>{' '}
          {t('adminActions.step3Post')}
        </li>
        <li>
          <Link className="text-primary underline" href="/admin/audit-logs">
            {t('adminActions.step4Link1Text')}
          </Link>{' '}
          /{' '}
          <Link className="text-primary underline" href="/admin/role-changes">
            {t('adminActions.step4Link2Text')}
          </Link>{' '}
          {t('adminActions.step4Post')}
        </li>
        <li>
          {t('adminActions.step5Pre')}{' '}
          <Link className="text-primary underline" href="/settings/tenant">
            {t('adminActions.step5LinkText')}
          </Link>{' '}
          {t('adminActions.step5Post')}
        </li>
        {systemRole === 'super_admin' && (
          <li>
            <strong>{t('adminActions.superAdminStepLabel')}</strong>{' '}
            <Link className="text-primary underline" href="/admin/super">
              {t('adminActions.superAdminStepLinkText')}
            </Link>{' '}
            {t('adminActions.superAdminStepPost')}
          </li>
        )}
      </ol>
    </div>
  );
}

function PmActions() {
  const t = useTranslations('guide');
  const r = t.rich.bind(t);
  return (
    <div className="space-y-3 rounded-md border bg-card p-4">
      <p className="text-sm text-muted-foreground">{t('pmActions.description')}</p>
      <ol className="list-decimal space-y-1.5 pl-6 text-sm">
        {/* 2026-05-13 docs/guide-role-actions: 運用フローを反映。テナント管理者がプロジェクトを
            立ち上げて PM/PL に権限割当するのが標準。pm_tl 自身もプロジェクト作成可だが (実装真実)、
            ガイドとしては「割り当てられた直後の動き」を主軸に説明する方がユーザに伝わりやすい。 */}
        <li>
          {t('pmActions.step1Pre')}{' '}
          <Link className="text-primary underline" href={PROJECTS_ROUTE}>
            {t('pmActions.step1LinkText')}
          </Link>{' '}
          {t('pmActions.step1Post')}
        </li>
        <li>
          {r('pmActions.step2', { strong: (c) => <strong key="s">{c}</strong> })}
        </li>
        <li>
          {r('pmActions.step3', { strong: (c) => <strong key="s">{c}</strong> })}
        </li>
        <li>{t('pmActions.step4')}</li>
        <li>
          {t('pmActions.step5Pre')}{' '}
          <Link className="text-primary underline" href={ALL_RISKS_ROUTE}>
            {t('pmActions.step5Link1Text')}
          </Link>
          {t('pmActions.step5Middle')}{' '}
          <Link className="text-primary underline" href={ALL_ISSUES_ROUTE}>
            {t('pmActions.step5Link2Text')}
          </Link>{' '}
          {t('pmActions.step5Post')}
        </li>
        <li>
          {t('pmActions.step6Pre')}{' '}
          <Link className="text-primary underline" href={ALL_RETROSPECTIVES_ROUTE}>
            {t('pmActions.step6LinkText')}
          </Link>{' '}
          {t('pmActions.step6Post')}
        </li>
        <li>
          {t('pmActions.step7Pre')}{' '}
          <Link className="text-primary underline" href={KNOWLEDGE_ROUTE}>
            {t('pmActions.step7LinkText')}
          </Link>{' '}
          {t('pmActions.step7Post')}
        </li>
      </ol>
    </div>
  );
}

function MemberActions() {
  const t = useTranslations('guide');
  const r = t.rich.bind(t);
  return (
    <div className="space-y-3 rounded-md border bg-card p-4">
      <p className="text-sm text-muted-foreground">{t('memberActions.description')}</p>
      <ol className="list-decimal space-y-1.5 pl-6 text-sm">
        <li>
          {t('memberActions.step1Pre')}{' '}
          <Link className="text-primary underline" href={MY_TASKS_ROUTE}>
            {t('memberActions.step1LinkText')}
          </Link>{' '}
          {t('memberActions.step1Post')}
        </li>
        <li>{t('memberActions.step2')}</li>
        <li>
          {t('memberActions.step3Pre')}{' '}
          <Link className="text-primary underline" href={ALL_RISKS_ROUTE}>
            {t('memberActions.step3Link1Text')}
          </Link>
          {t('memberActions.step3Middle')}{' '}
          <Link className="text-primary underline" href={ALL_ISSUES_ROUTE}>
            {t('memberActions.step3Link2Text')}
          </Link>
          {t('memberActions.step3Post')}
        </li>
        <li>
          {r('memberActions.step4', { code: (c) => <code key="c">{c}</code> })}
        </li>
        <li>
          {t('memberActions.step5Pre')}{' '}
          <Link className="text-primary underline" href={KNOWLEDGE_ROUTE}>
            {t('memberActions.step5LinkText')}
          </Link>{' '}
          {t('memberActions.step5Post')}
        </li>
      </ol>
    </div>
  );
}

function ViewerActions() {
  const t = useTranslations('guide');
  const r = t.rich.bind(t);
  return (
    <div className="space-y-3 rounded-md border bg-card p-4">
      <p className="text-sm text-muted-foreground">{t('viewerActions.description')}</p>
      <ol className="list-decimal space-y-1.5 pl-6 text-sm">
        <li>{r('viewerActions.step1', { strong: (c) => <strong key="s">{c}</strong> })}</li>
        <li>{t('viewerActions.step2')}</li>
        <li>{t('viewerActions.step3')}</li>
        <li>{t('viewerActions.step4')}</li>
      </ol>
    </div>
  );
}

function GlossaryItem({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="rounded border bg-card p-3">
      <dt className="font-medium">{term}</dt>
      <dd className="mt-1 text-sm text-muted-foreground">{children}</dd>
    </div>
  );
}
