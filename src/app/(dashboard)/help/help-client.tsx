'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  GUIDE_ROUTE,
  getFeatureRequestUrl,
} from '@/config';
import { createContext, useContext, useState, Children, isValidElement } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FilterBar } from '@/components/common/filter-bar';
import { WelcomeOwlReplayButton } from '@/components/onboarding/welcome-owl-modal';
import {
  FAQ_ENTRIES,
  canViewerSee,
  type ViewerRoles,
} from '@/config/faq-content';

type Props = {
  isTenantAdmin: boolean;
  viewer: ViewerRoles;
};

const FIRST_STEP_FAQ_IDS: readonly string[] = [
  'getting-started-what-to-do',
  'onboarding-welcome-replay',
  'semantic-search-vs-fulltext',
  'db-vs-file-storage-concept',
  'ai-training-usage',
  'member-first-step',
  'create-risk-issue-howto',
  'create-knowledge-howto',
  'update-task-progress-howto',
  'pm-first-step',
  'create-project-howto',
  'reference-tab-howto',
  'stakeholder-howto',
  'db-capacity-vs-file-storage',
  'admin-first-step',
];

const FaqQueryContext = createContext('');

function FaqSearchBox({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const t = useTranslations('help');
  return (
    <FilterBar>
      <Label htmlFor="faq-search-keyword" className="text-xs">
        {t('search.label')}
      </Label>
      <Input
        id="faq-search-keyword"
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t('search.placeholder')}
        data-testid="faq-search-keyword"
        autoComplete="off"
      />
    </FilterBar>
  );
}

export function HelpClient({ isTenantAdmin, viewer }: Props) {
  const t = useTranslations('help');
  const tNav = useTranslations('nav');
  const featureRequest = getFeatureRequestUrl();
  const [faqQuery, setFaqQuery] = useState('');
  const r = t.rich.bind(t);

  return (
    <FaqQueryContext.Provider value={faqQuery.trim().toLowerCase()}>
    <div className="mx-auto max-w-4xl space-y-8 pb-12">
      {/* Header */}
      <header className="space-y-2">
        <h1 className="text-2xl font-bold">{t('header.title')}</h1>
        <p className="text-sm text-muted-foreground">
          {t('header.descPre')}{' '}
          <Link href={GUIDE_ROUTE} className="text-primary underline">
            {t('header.guideLinkText')}
          </Link>{' '}
          {t('header.descPost')}
        </p>
      </header>

      <div>
        <WelcomeOwlReplayButton />
      </div>

      <FaqSearchBox value={faqQuery} onChange={setFaqQuery} />

      <FirstStepFaqSection viewer={viewer} />

      {/* About the service */}
      <FaqCategory title={t('sections.aboutService')}>
        <FaqItem
          q={t('faq.owlMascot.q')}
          a={
            <div className="space-y-3">
              <div className="flex flex-col items-center gap-2 sm:flex-row sm:items-start sm:gap-4">
                <Image
                  src="/mascot-owl.png"
                  alt={t('faq.owlMascot.imgAlt')}
                  width={120}
                  height={120}
                  className="shrink-0 rounded-lg"
                />
                <div className="space-y-2 text-sm">
                  <p>
                    {r('faq.owlMascot.p1', { strong: (c) => <strong key="s">{c}</strong> })}
                  </p>
                  <p>{t('faq.owlMascot.p2')}</p>
                  <p className="text-muted-foreground">{t('faq.owlMascot.p3')}</p>
                </div>
              </div>
            </div>
          }
        />
        <FaqItem
          q={t('faq.browser.q')}
          a={
            <p>
              {r('faq.browser.a', { strong: (c) => <strong key="s">{c}</strong> })}
            </p>
          }
        />
      </FaqCategory>

      {/* Business usage */}
      <FaqCategory title={t('sections.businessUsage')}>
        <FaqItem
          q={t('faq.riskVsIssue.q')}
          a={
            <p>
              {r('faq.riskVsIssue.a', { strong: (c) => <strong key="s">{c}</strong> })}
            </p>
          }
        />
        <FaqItem
          q={t('faq.wpActivity.q')}
          a={
            <>
              <p>
                {r('faq.wpActivity.p1', { strong: (c) => <strong key="s">{c}</strong> })}
              </p>
              <p className="mt-2 text-muted-foreground">
                {r('faq.wpActivity.p2', { strong: (c) => <strong key="s">{c}</strong> })}
              </p>
            </>
          }
        />
        <FaqItem
          q={t('faq.knowledgeVsRetro.q')}
          a={
            <p>
              {r('faq.knowledgeVsRetro.a', { strong: (c) => <strong key="s">{c}</strong> })}
            </p>
          }
        />
        <FaqItem
          q={t('faq.suggestionEngine.q')}
          a={
            <>
              <p>
                {r('faq.suggestionEngine.p1', { strong: (c) => <strong key="s">{c}</strong> })}
              </p>
              <p className="mt-2">
                {r('faq.suggestionEngine.p2', { strong: (c) => <strong key="s">{c}</strong> })}
              </p>
              <p className="mt-2 text-muted-foreground">
                {r('faq.suggestionEngine.p3', { strong: (c) => <strong key="s">{c}</strong> })}
              </p>
            </>
          }
        />
        <FaqItem
          q={t('faq.mention.q')}
          a={
            <p>
              {r('faq.mention.a', {
                code: (c) => <code key="c">{c}</code>,
              })}
            </p>
          }
        />
        <FaqItem
          q={t('faq.knowledgeMissing.q')}
          a={
            <>
              <p>
                {r('faq.knowledgeMissing.p1', { strong: (c) => <strong key="s">{c}</strong> })}
              </p>
              <p className="mt-2">
                {r('faq.knowledgeMissing.p2', { strong: (c) => <strong key="s">{c}</strong> })}
              </p>
            </>
          }
        />
        <FaqItem
          q={t('faq.resolvedMissing.q')}
          a={
            <>
              <p>
                {r('faq.resolvedMissing.p1', { strong: (c) => <strong key="s">{c}</strong> })}
              </p>
              <ul className="mt-2 ml-4 list-disc space-y-1">
                <li>{r('faq.resolvedMissing.li1', { strong: (c) => <strong key="s">{c}</strong> })}</li>
                <li>{r('faq.resolvedMissing.li2', { strong: (c) => <strong key="s">{c}</strong> })}</li>
              </ul>
              <p className="mt-2">
                {r('faq.resolvedMissing.p2', { strong: (c) => <strong key="s">{c}</strong> })}
              </p>
            </>
          }
        />
        <FaqItem
          q={t('faq.editNoChange.q')}
          a={
            <>
              <p>
                {r('faq.editNoChange.p1', { strong: (c) => <strong key="s">{c}</strong> })}
              </p>
              <p className="mt-2 text-muted-foreground">{t('faq.editNoChange.p2')}</p>
            </>
          }
        />
        <FaqItem
          q={t('faq.projectDeleted.q')}
          a={
            <p>
              {r('faq.projectDeleted.a', { strong: (c) => <strong key="s">{c}</strong> })}
            </p>
          }
        />
        <FaqItem
          q={t('faq.closedProject.q')}
          a={
            <p>
              {r('faq.closedProject.a', { strong: (c) => <strong key="s">{c}</strong> })}
            </p>
          }
        />
        <FaqItem
          q={t('faq.template.q')}
          a={
            <p>
              {r('faq.template.a', { strong: (c) => <strong key="s">{c}</strong> })}
            </p>
          }
        />
        <FaqItem
          q={t('faq.chatZero.q')}
          a={
            <p>
              {r('faq.chatZero.a', { strong: (c) => <strong key="s">{c}</strong> })}
            </p>
          }
        />
        <FaqItem
          q={t('faq.draftData.q')}
          a={
            <p>
              {r('faq.draftData.a', { strong: (c) => <strong key="s">{c}</strong> })}
            </p>
          }
        />
        <FaqItem
          q={t('faq.whyBilling.q')}
          a={
            <p>
              {r('faq.whyBilling.a', { strong: (c) => <strong key="s">{c}</strong> })}
            </p>
          }
        />
      </FaqCategory>

      {/* Permissions */}
      <FaqCategory title={t('sections.permissions')}>
        <FaqItem
          q={t('faq.roleTable.q')}
          a={
            <div className="mt-2 overflow-x-auto rounded-md border">
              <table className="w-full border-collapse text-sm">
                <thead className="bg-muted/40">
                  <tr>
                    <th className="border-b p-2 text-left">{t('faq.roleTable.colOp')}</th>
                    <th className="border-b p-2 text-left">{t('faq.roleTable.colOperator')}</th>
                    <th className="border-b p-2 text-left">{t('faq.roleTable.colAdmin')}</th>
                    <th className="border-b p-2 text-left">{t('faq.roleTable.colMember')}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr><td className="border-b p-2">{t('faq.roleTable.row1Op')}</td><td className="border-b p-2">○</td><td className="border-b p-2">{t('faq.roleTable.row1Admin')}</td><td className="border-b p-2">−</td></tr>
                  <tr><td className="border-b p-2">{t('faq.roleTable.row2Op')}</td><td className="border-b p-2">−</td><td className="border-b p-2">○</td><td className="border-b p-2">−</td></tr>
                  <tr><td className="border-b p-2">{t('faq.roleTable.row3Op')}</td><td className="border-b p-2">−</td><td className="border-b p-2">○</td><td className="border-b p-2">○</td></tr>
                  <tr><td className="p-2">{t('faq.roleTable.row4Op')}</td><td className="p-2">{t('faq.roleTable.row4Operator')}</td><td className="p-2">−</td><td className="p-2">−</td></tr>
                </tbody>
              </table>
            </div>
          }
        />
        <FaqItem
          q={t('faq.roleCheck.q')}
          a={
            <p>
              {r('faq.roleCheck.a', { strong: (c) => <strong key="s">{c}</strong> })}
            </p>
          }
        />
        <FaqItem
          q={t('faq.handover.q')}
          a={
            <p>
              {r('faq.handover.a', { strong: (c) => <strong key="s">{c}</strong> })}
            </p>
          }
        />
      </FaqCategory>

      {/* Account & Login */}
      <FaqCategory title={t('sections.account')}>
        <FaqItem
          q={t('faq.orgIdForgot.q')}
          a={
            <p>
              {r('faq.orgIdForgot.a', { strong: (c) => <strong key="s">{c}</strong> })}
            </p>
          }
        />
        <FaqItem
          q={t('faq.passwordLink.q')}
          a={
            <p>
              {r('faq.passwordLink.a', { strong: (c) => <strong key="s">{c}</strong> })}
            </p>
          }
        />
        <FaqItem
          q={t('faq.inviteEmail.q')}
          a={
            <>
              <p>
                {t('faq.inviteEmail.introPre')}{' '}
                <strong><code>noreply@tasukiba.com</code></strong>{' '}
                {t('faq.inviteEmail.introPost')}
              </p>
              <ol className="mt-2 ml-4 list-decimal space-y-1">
                <li>{t('faq.inviteEmail.li1')}</li>
                <li>
                  {t('faq.inviteEmail.li2Pre')}{' '}
                  <code>noreply@tasukiba.com</code>{' '}
                  {t('faq.inviteEmail.li2Post')}
                </li>
                <li>{t('faq.inviteEmail.li3')}</li>
                <li>{t('faq.inviteEmail.li4')}</li>
              </ol>
            </>
          }
        />
        <FaqItem
          q={t('faq.notification.q')}
          a={
            <p>
              {r('faq.notification.a', {
                strong: (c) => <strong key="s">{c}</strong>,
                code: (c) => <code key="c">{c}</code>,
              })}
            </p>
          }
        />
        <FaqItem
          q={t('faq.emailNotify.q')}
          a={
            <p>
              {r('faq.emailNotify.a', { strong: (c) => <strong key="s">{c}</strong> })}
            </p>
          }
        />
      </FaqCategory>

      {/* Data & Privacy */}
      <FaqCategory title={t('sections.dataPrivacy')}>
        <FaqItem
          q={t('faq.otherTenant.q')}
          a={<p>{t('faq.otherTenant.a')}</p>}
        />
        <FaqItem
          q={t('faq.deactivation.q')}
          a={
            <>
              <p>{t('faq.deactivation.intro')}</p>
              <ul className="mt-2 ml-4 list-disc space-y-1">
                <li>
                  {r('faq.deactivation.li1', { strong: (c) => <strong key="s">{c}</strong> })}
                </li>
                <li>
                  {r('faq.deactivation.li2', { strong: (c) => <strong key="s">{c}</strong> })}
                </li>
              </ul>
              <p className="mt-2">{t('faq.deactivation.p2')}</p>
            </>
          }
        />
        <FaqItem
          q={t('faq.rejoin.q')}
          a={<p>{t('faq.rejoin.a')}</p>}
        />
        <FaqItem
          q={t('faq.aiData.q')}
          a={
            <>
              <p>{t('faq.aiData.intro')}</p>
              <ul className="mt-2 ml-4 list-disc space-y-1">
                <li>{t('faq.aiData.li1')}</li>
                <li>{t('faq.aiData.li2')}</li>
                <li>{t('faq.aiData.li3')}</li>
              </ul>
              <p className="mt-2">
                {r('faq.aiData.p2', { strong: (c) => <strong key="s">{c}</strong> })}
              </p>
            </>
          }
        />
        <FaqItem
          q={t('faq.backup.q')}
          a={
            <p>
              {t('faq.backup.aPre')}
              <Link href="/settings/tenant" className="text-primary underline">
                {t('faq.backup.linkText')}
              </Link>
              {t('faq.backup.aPost')}
            </p>
          }
        />
        <FaqItem
          q={t('faq.memoTypes.q')}
          a={
            <>
              <p>
                {r('faq.memoTypes.p1', { strong: (c) => <strong key="s">{c}</strong> })}
              </p>
              <p className="mt-2">
                {r('faq.memoTypes.p2', { strong: (c) => <strong key="s">{c}</strong> })}
              </p>
              <p className="mt-2 text-muted-foreground">{t('faq.memoTypes.p3')}</p>
            </>
          }
        />
        <FaqItem
          q={t('faq.visibilityScope.q')}
          a={
            <>
              <p>{t('faq.visibilityScope.intro')}</p>
              <ul className="mt-2 ml-4 list-disc space-y-1">
                <li>{r('faq.visibilityScope.li1', { strong: (c) => <strong key="s">{c}</strong> })}</li>
                <li>{r('faq.visibilityScope.li2', { strong: (c) => <strong key="s">{c}</strong> })}</li>
                <li>{r('faq.visibilityScope.li3', { strong: (c) => <strong key="s">{c}</strong> })}</li>
              </ul>
              <p className="mt-2">
                {r('faq.visibilityScope.p2', { strong: (c) => <strong key="s">{c}</strong> })}
              </p>
            </>
          }
        />
        <FaqItem
          q={t('faq.changeVisibility.q')}
          a={
            <p>
              {r('faq.changeVisibility.a', { strong: (c) => <strong key="s">{c}</strong> })}
            </p>
          }
        />
        <FaqItem
          q={t('faq.privateMemoMention.q')}
          a={
            <p>
              {r('faq.privateMemoMention.a', { strong: (c) => <strong key="s">{c}</strong> })}
            </p>
          }
        />
        <FaqItem
          q={t('faq.terms.q')}
          a={
            <p>
              {t('faq.terms.aPre')}{' '}
              <a
                href="https://teppei19980914.github.io/HomePage/ja/product/tasukiba-user/#terms"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline"
              >
                {t('faq.terms.linkText')}
              </a>
              {' '}{t('faq.terms.aPost')}
            </p>
          }
        />
      </FaqCategory>

      {/* Admin sections */}
      {isTenantAdmin && (
        <>
          <FaqCategory
            title={t('sections.csvImport')}
            tone="admin"
          >
            <FaqItem
              q={t('faq.csvMigrate.q')}
              a={
                <div className="space-y-2">
                  <p>
                    {r('faq.csvMigrate.intro', { strong: (c) => <strong key="s">{c}</strong> })}
                  </p>
                  <ol className="list-decimal space-y-1 pl-5">
                    <li>
                      {r('faq.csvMigrate.li1Pre', { strong: (c) => <strong key="s">{c}</strong> })}{' '}
                      <Link href="/settings/tenant" className="text-primary underline">
                        {t('faq.csvMigrate.li1LinkText')}
                      </Link>{' '}
                      {t('faq.csvMigrate.li1Post')}
                    </li>
                    <li>
                      {t('faq.csvMigrate.li2Pre')}{' '}
                      <Link href="/settings/tenant/migration-import" className="text-primary underline">
                        {t('faq.csvMigrate.li2LinkText')}
                      </Link>{' '}
                      {t('faq.csvMigrate.li2Post')}
                    </li>
                    <li>
                      {r('faq.csvMigrate.li3', { strong: (c) => <strong key="s">{c}</strong> })}
                    </li>
                    <li>{t('faq.csvMigrate.li4')}</li>
                  </ol>
                </div>
              }
            />
            <FaqItem
              q={t('faq.csvFormat.q')}
              a={
                <ul className="list-disc space-y-1 pl-5">
                  <li>{r('faq.csvFormat.li1', { strong: (c) => <strong key="s">{c}</strong> })}</li>
                  <li>{t('faq.csvFormat.li2')}</li>
                  <li>
                    {r('faq.csvFormat.li3', {
                      strong: (c) => <strong key="s">{c}</strong>,
                      code: (c) => <code key="c">{c}</code>,
                    })}
                  </li>
                  <li>
                    {r('faq.csvFormat.li4', {
                      strong: (c) => <strong key="s">{c}</strong>,
                      code: (c) => <code key="c">{c}</code>,
                    })}
                  </li>
                  <li>
                    {r('faq.csvFormat.li5', {
                      strong: (c) => <strong key="s">{c}</strong>,
                      code: (c) => <code key="c">{c}</code>,
                    })}
                  </li>
                  <li>
                    {r('faq.csvFormat.li6', { strong: (c) => <strong key="s">{c}</strong> })}
                  </li>
                </ul>
              }
            />
            <FaqItem
              q={t('faq.csvError.q')}
              a={
                <>
                  <p>{t('faq.csvError.intro')}</p>
                  <ul className="mt-2 list-disc space-y-1 pl-5">
                    <li>
                      {r('faq.csvError.li1Pre', {
                        strong: (c) => <strong key="s">{c}</strong>,
                        code: (c) => <code key="c">{c}</code>,
                      })}{' '}
                      {r('faq.csvError.li1Post', { code: (c) => <code key="c">{c}</code> })}
                    </li>
                    <li>
                      {r('faq.csvError.li2', { code: (c) => <code key="c">{c}</code> })}
                    </li>
                    <li>
                      {r('faq.csvError.li3', { code: (c) => <code key="c">{c}</code> })}
                    </li>
                    <li>
                      {r('faq.csvError.li4', { code: (c) => <code key="c">{c}</code> })}
                    </li>
                  </ul>
                  <p className="mt-3 text-muted-foreground">
                    {r('faq.csvError.excelNote', { strong: (c) => <strong key="s">{c}</strong> })}
                  </p>
                  <ul className="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
                    <li>
                      {r('faq.csvError.excelLi1', {
                        strong: (c) => <strong key="s">{c}</strong>,
                        code: (c) => <code key="c">{c}</code>,
                      })}
                    </li>
                    <li>
                      {r('faq.csvError.excelLi2', {
                        strong: (c) => <strong key="s">{c}</strong>,
                        code: (c) => <code key="c">{c}</code>,
                      })}
                    </li>
                  </ul>
                </>
              }
            />
            <FaqItem
              q={t('faq.csvItems.q')}
              a={
                <>
                  <p>
                    {r('faq.csvItems.p1', { strong: (c) => <strong key="s">{c}</strong> })}
                  </p>
                  <p className="mt-2">{t('faq.csvItems.p2')}</p>
                </>
              }
            />
            <FaqItem
              q={t('faq.csvPlan.q')}
              a={
                <>
                  <p>
                    {r('faq.csvPlan.intro', { strong: (c) => <strong key="s">{c}</strong> })}
                  </p>
                  <ul className="mt-2 list-disc space-y-1 pl-5">
                    <li>{r('faq.csvPlan.li1', { strong: (c) => <strong key="s">{c}</strong> })}</li>
                    <li>{r('faq.csvPlan.li2', { strong: (c) => <strong key="s">{c}</strong> })}</li>
                  </ul>
                  <p className="mt-2">
                    {r('faq.csvPlan.p2', { strong: (c) => <strong key="s">{c}</strong> })}
                  </p>
                  <div className="mt-2 overflow-x-auto rounded-md border">
                    <table className="w-full border-collapse text-xs">
                      <thead className="bg-muted/40">
                        <tr>
                          <th className="border-b p-2 text-left">{t('faq.csvPlan.tableColUsage')}</th>
                          <th className="border-b p-2 text-left">{t('faq.csvPlan.tableColBeginner')}</th>
                          <th className="border-b p-2 text-left">{t('faq.csvPlan.tableColExpertPro')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr>
                          <td className="border-b p-2">{t('faq.csvPlan.tableRow1Usage')}</td>
                          <td className="border-b p-2 text-emerald-700 dark:text-emerald-400">{t('faq.csvPlan.tableRow1Both')}</td>
                          <td className="border-b p-2 text-emerald-700 dark:text-emerald-400">{t('faq.csvPlan.tableRow1Both')}</td>
                        </tr>
                        <tr>
                          <td className="border-b p-2">{t('faq.csvPlan.tableRow2Usage')}</td>
                          <td className="border-b p-2 text-destructive">{t('faq.csvPlan.tableRow2Beginner')}</td>
                          <td className="border-b p-2">{t('faq.csvPlan.tableRow2ExpertPro')}</td>
                        </tr>
                        <tr>
                          <td className="border-b p-2">{t('faq.csvPlan.tableRow3Usage')}</td>
                          <td className="border-b p-2 text-destructive">{t('faq.csvPlan.tableRow3Beginner')}</td>
                          <td className="border-b p-2 text-amber-700 dark:text-amber-400">{t('faq.csvPlan.tableRow3ExpertPro')}</td>
                        </tr>
                        <tr>
                          <td className="border-b p-2">{t('faq.csvPlan.tableRow4Usage')}</td>
                          <td className="border-b p-2 text-destructive">{t('faq.csvPlan.tableRow4Beginner')}</td>
                          <td className="border-b p-2 text-amber-700 dark:text-amber-400">{t('faq.csvPlan.tableRow4ExpertPro')}</td>
                        </tr>
                        <tr>
                          <td className="p-2">{t('faq.csvPlan.tableRow5Usage')}</td>
                          <td className="p-2 text-destructive">{t('faq.csvPlan.tableRow5Beginner')}</td>
                          <td className="p-2 text-emerald-700 dark:text-emerald-400">{t('faq.csvPlan.tableRow5ExpertPro')}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                  <p className="mt-2 text-muted-foreground">
                    {r('faq.csvPlan.noteBeginnerPre', { strong: (c) => <strong key="s">{c}</strong> })}
                  </p>
                  <p className="mt-2 text-muted-foreground">
                    {r('faq.csvPlan.noteExpertProPre', { strong: (c) => <strong key="s">{c}</strong> })}{' '}
                    <Link href="/settings/tenant" className="text-primary underline">
                      {t('faq.csvPlan.noteExpertProLinkText')}
                    </Link>
                    {' '}{t('faq.csvPlan.noteExpertProPost')}
                  </p>
                </>
              }
            />
            <FaqItem
              q={t('faq.csvVisibility.q')}
              a={
                <ul className="list-disc space-y-1 pl-5">
                  <li>{r('faq.csvVisibility.li1', { strong: (c) => <strong key="s">{c}</strong> })}</li>
                  <li>{r('faq.csvVisibility.li2', { strong: (c) => <strong key="s">{c}</strong> })}</li>
                  <li>{r('faq.csvVisibility.li3', { strong: (c) => <strong key="s">{c}</strong> })}</li>
                  <li>
                    {r('faq.csvVisibility.li4', {
                      strong: (c) => <strong key="s">{c}</strong>,
                      code: (c) => <code key="c">{c}</code>,
                    })}
                  </li>
                </ul>
              }
            />
          </FaqCategory>

          <FaqCategory
            title={t('sections.billing')}
            tone="admin"
          >
            <FaqItem
              q={t('faq.billingWhen.q')}
              a={
                <p>
                  {r('faq.billingWhen.a', { strong: (c) => <strong key="s">{c}</strong> })}
                </p>
              }
            />
            <FaqItem
              q={t('faq.billingPlanChange.q')}
              a={
                <p>
                  {r('faq.billingPlanChange.a', { strong: (c) => <strong key="s">{c}</strong> })}
                </p>
              }
            />
            <FaqItem
              q={t('faq.billingPayment.q')}
              a={
                <p>
                  {r('faq.billingPayment.aPre', { strong: (c) => <strong key="s">{c}</strong> })}
                  {' '}
                  <Link href="/settings/tenant" className="text-primary underline">
                    {t('faq.billingPayment.linkText')}
                  </Link>
                  {t('faq.billingPayment.aPost')}
                </p>
              }
            />
            <FaqItem
              q={t('faq.billingInvoice.q')}
              a={
                <p>
                  {r('faq.billingInvoice.a', { strong: (c) => <strong key="s">{c}</strong> })}
                </p>
              }
            />
            <FaqItem
              q={t('faq.billingTax.q')}
              a={
                <p>
                  {r('faq.billingTax.a', { strong: (c) => <strong key="s">{c}</strong> })}
                </p>
              }
            />
            <FaqItem
              q={t('faq.billingBeginnerOverage.q')}
              a={
                <p>
                  {r('faq.billingBeginnerOverage.a', { strong: (c) => <strong key="s">{c}</strong> })}
                </p>
              }
            />
            <FaqItem
              q={t('faq.billingCapacity.q')}
              a={
                <p>
                  <Link href="/settings/tenant" className="text-primary underline">
                    {t('faq.billingCapacity.linkText')}
                  </Link>
                  {r('faq.billingCapacity.aPost', { strong: (c) => <strong key="s">{c}</strong> })}
                </p>
              }
            />
            <FaqItem
              q={t('faq.billingCapacityLimit.q')}
              a={
                <p>
                  {r('faq.billingCapacityLimit.a', { strong: (c) => <strong key="s">{c}</strong> })}
                </p>
              }
            />
          </FaqCategory>

          <FaqCategory
            title={t('sections.planSeat')}
            tone="admin"
          >
            <FaqItem
              q={t('faq.planDiff.q')}
              a={
                <>
                  <div className="mt-2 overflow-x-auto rounded-md border">
                    <table className="w-full border-collapse text-sm">
                      <thead className="bg-muted/40">
                        <tr>
                          <th className="border-b p-2 text-left">{t('faq.planDiff.colItem')}</th>
                          <th className="border-b p-2 text-left">{t('faq.planDiff.colBeginner')}</th>
                          <th className="border-b p-2 text-left">{t('faq.planDiff.colExpert')}</th>
                          <th className="border-b p-2 text-left">{t('faq.planDiff.colPro')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr>
                          <td className="border-b p-2">{t('faq.planDiff.rowSeat')}</td>
                          <td className="border-b p-2">{t('faq.planDiff.rowSeatBeginner')}</td>
                          <td className="border-b p-2">{t('faq.planDiff.rowSeatOther')}</td>
                          <td className="border-b p-2">{t('faq.planDiff.rowSeatOther')}</td>
                        </tr>
                        <tr>
                          <td className="border-b p-2">{t('faq.planDiff.rowProjectCreate')}</td>
                          <td className="border-b p-2">{t('faq.planDiff.rowProjectCreateBeginner')}</td>
                          <td className="border-b p-2">{t('faq.planDiff.rowProjectCreateExpert')}</td>
                          <td className="border-b p-2">{t('faq.planDiff.rowProjectCreatePro')}</td>
                        </tr>
                        <tr>
                          <td className="border-b p-2">{t('faq.planDiff.rowAssets')}</td>
                          <td className="border-b p-2" colSpan={3}>{t('faq.planDiff.rowAssetsAll')}</td>
                        </tr>
                        <tr>
                          <td className="border-b p-2">{t('faq.planDiff.rowAiModel')}</td>
                          <td className="border-b p-2">{t('faq.planDiff.rowAiModelBeginner')}</td>
                          <td className="border-b p-2">{t('faq.planDiff.rowAiModelExpert')}</td>
                          <td className="border-b p-2">{t('faq.planDiff.rowAiModelPro')}</td>
                        </tr>
                        <tr>
                          <td className="p-2">{t('faq.planDiff.rowWhy')}</td>
                          <td className="p-2 text-muted-foreground">{t('faq.planDiff.rowWhyNA')}</td>
                          <td className="p-2 text-muted-foreground">{t('faq.planDiff.rowWhyNA')}</td>
                          <td className="p-2">{t('faq.planDiff.rowWhyPro')}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                  <p className="mt-2 text-muted-foreground">
                    {t('faq.planDiff.notePreLink')}{' '}
                    <Link href="/settings/tenant" className="text-primary underline">
                      {t('faq.planDiff.noteLinkText')}
                    </Link>
                    {t('faq.planDiff.notePostLink')}
                  </p>
                </>
              }
            />
            <FaqItem
              q={t('faq.planSwitch.q')}
              a={
                <p>
                  {r('faq.planSwitch.a', { strong: (c) => <strong key="s">{c}</strong> })}
                </p>
              }
            />
            <FaqItem
              q={t('faq.planBudget.q')}
              a={
                <p>
                  {r('faq.planBudget.a', { strong: (c) => <strong key="s">{c}</strong> })}
                </p>
              }
            />
            <FaqItem
              q={t('faq.planSeed.q')}
              a={
                <p>
                  <Link href="/settings/tenant" className="text-primary underline">
                    {t('faq.planSeed.linkText')}
                  </Link>
                  {' '}{t('faq.planSeed.aPost')}
                </p>
              }
            />
            <FaqItem
              q={t('faq.planDowngrade.q')}
              a={
                <p>
                  {r('faq.planDowngrade.aPre', { strong: (c) => <strong key="s">{c}</strong> })}
                </p>
              }
            />
          </FaqCategory>

          {/* Admin AI explanation section */}
          <section className="rounded-lg border bg-card p-5">
            <h2 className="text-lg font-semibold">{t('adminAi.title')}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t('adminAi.intro')}</p>

            <div className="mt-5 space-y-6 text-sm">
              <div>
                <h3 className="font-medium">{t('adminAi.featuresTitle')}</h3>
                <ul className="mt-2 list-disc space-y-2 pl-5">
                  <li>
                    <strong>{t('adminAi.autoTagTitle')}</strong>:{' '}
                    {t('adminAi.autoTagBody')}
                  </li>
                  <li>
                    <strong>{t('adminAi.embeddingTitle')}</strong>:{' '}
                    {t('adminAi.embeddingBody')}
                  </li>
                  <li>
                    <strong>{t('adminAi.whyTitle')}</strong>:{' '}
                    {t('adminAi.whyBody')}
                  </li>
                  <li>
                    <strong>{t('adminAi.similarTitle')}</strong>:{' '}
                    {t('adminAi.similarBody')}
                  </li>
                </ul>
                <p className="mt-2 text-xs text-muted-foreground">
                  {t('adminAi.featuresNote')}
                </p>
              </div>

              <div>
                <h3 className="font-medium">{t('adminAi.billingTitle')}</h3>
                <div className="mt-2 overflow-x-auto rounded-md border">
                  <table className="w-full border-collapse text-sm">
                    <thead className="bg-muted/40">
                      <tr>
                        <th className="border-b p-2 text-left">{t('adminAi.billingColFeature')}</th>
                        <th className="border-b p-2 text-left">{t('adminAi.billingColStatus')}</th>
                        <th className="border-b p-2 text-left">{t('adminAi.billingColUnit')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td className="border-b p-2 align-top">{t('adminAi.billingRow1Feature')}</td>
                        <td className="border-b p-2 align-top text-amber-700 dark:text-amber-400">{t('adminAi.billingRow1Status')}</td>
                        <td className="border-b p-2 align-top">{t('adminAi.billingRow1Unit')}</td>
                      </tr>
                      <tr>
                        <td className="border-b p-2 align-top">{t('adminAi.billingRow2Feature')}</td>
                        <td className="border-b p-2 align-top text-amber-700 dark:text-amber-400">{t('adminAi.billingRow2Status')}</td>
                        <td className="border-b p-2 align-top">{t('adminAi.billingRow2Unit')}</td>
                      </tr>
                      <tr>
                        <td className="border-b p-2 align-top">{t('adminAi.billingRow3Feature')}</td>
                        <td className="border-b p-2 align-top text-amber-700 dark:text-amber-400">{t('adminAi.billingRow3Status')}</td>
                        <td className="border-b p-2 align-top">{t('adminAi.billingRow3Unit')}</td>
                      </tr>
                      <tr>
                        <td className="p-2 align-top">{t('adminAi.billingRow4Feature')}</td>
                        <td className="p-2 align-top text-emerald-700 dark:text-emerald-400">{t('adminAi.billingRow4Status')}</td>
                        <td className="p-2 align-top">{t('adminAi.billingRow4Unit')}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>

              <div>
                <h3 className="font-medium">{t('adminAi.planTitle')}</h3>
                <div className="mt-2 overflow-x-auto rounded-md border">
                  <table className="w-full border-collapse text-sm">
                    <thead className="bg-muted/40">
                      <tr>
                        <th className="border-b p-2 text-left">{t('adminAi.planColItem')}</th>
                        <th className="border-b p-2 text-left">{t('adminAi.planColBeginner')}</th>
                        <th className="border-b p-2 text-left">{t('adminAi.planColExpert')}</th>
                        <th className="border-b p-2 text-left">{t('adminAi.planColPro')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td className="border-b p-2 align-top">{t('adminAi.planRowSeat')}</td>
                        <td className="border-b p-2 align-top">{t('adminAi.planRowSeatBeginner')}</td>
                        <td className="border-b p-2 align-top">{t('adminAi.planRowSeatOther')}</td>
                        <td className="border-b p-2 align-top">{t('adminAi.planRowSeatOther')}</td>
                      </tr>
                      <tr>
                        <td className="border-b p-2 align-top">{t('adminAi.planRowLimit')}</td>
                        <td className="border-b p-2 align-top">{t('adminAi.planRowLimitBeginner')}</td>
                        <td className="border-b p-2 align-top">{t('adminAi.planRowLimitOther')}</td>
                        <td className="border-b p-2 align-top">{t('adminAi.planRowLimitOther')}</td>
                      </tr>
                      <tr>
                        <td className="border-b p-2 align-top">{t('adminAi.planRowAssets')}</td>
                        <td className="border-b p-2 align-top">{t('adminAi.planRowAssetsAll')}</td>
                        <td className="border-b p-2 align-top">{t('adminAi.planRowAssetsAll')}</td>
                        <td className="border-b p-2 align-top">{t('adminAi.planRowAssetsAll')}</td>
                      </tr>
                      <tr>
                        <td className="border-b p-2 align-top">{t('adminAi.planRowPrice')}</td>
                        <td className="border-b p-2 align-top">{t('adminAi.planRowPriceBeginner')}</td>
                        <td className="border-b p-2 align-top">{t('adminAi.planRowPriceExpert')}</td>
                        <td className="border-b p-2 align-top">{t('adminAi.planRowPricePro')}</td>
                      </tr>
                      <tr>
                        <td className="border-b p-2 align-top">{t('adminAi.planRowWhy')}</td>
                        <td className="border-b p-2 align-top">{t('adminAi.planRowWhyNA')}</td>
                        <td className="border-b p-2 align-top">{t('adminAi.planRowWhyNA')}</td>
                        <td className="border-b p-2 align-top">{t('adminAi.planRowWhyPro')}</td>
                      </tr>
                      <tr>
                        <td className="border-b p-2 align-top">{t('adminAi.planRowAutoTagModel')}</td>
                        <td className="border-b p-2 align-top">{t('adminAi.planRowAutoTagModelBeginnerExpert')}</td>
                        <td className="border-b p-2 align-top">{t('adminAi.planRowAutoTagModelBeginnerExpert')}</td>
                        <td className="border-b p-2 align-top">
                          {t('adminAi.planRowAutoTagModelPro')}
                          <span className="ml-1 text-xs text-muted-foreground">{t('adminAi.planRowAutoTagModelProNote')}</span>
                        </td>
                      </tr>
                      <tr>
                        <td className="border-b p-2 align-top">{t('adminAi.planRowEmbeddingModel')}</td>
                        <td className="border-b p-2 align-top" colSpan={3}>
                          {t('adminAi.planRowEmbeddingModelAll')}
                        </td>
                      </tr>
                      <tr>
                        <td className="border-b p-2 align-top">{t('adminAi.planRowWhyModel')}</td>
                        <td className="border-b p-2 align-top text-muted-foreground">{t('adminAi.planRowWhyModelNA')}</td>
                        <td className="border-b p-2 align-top text-muted-foreground">{t('adminAi.planRowWhyModelNA')}</td>
                        <td className="border-b p-2 align-top">
                          {t('adminAi.planRowWhyModelPro')}
                          <span className="ml-1 text-xs text-muted-foreground">{t('adminAi.planRowWhyModelProNote')}</span>
                        </td>
                      </tr>
                      <tr>
                        <td className="border-b p-2 align-top">{t('adminAi.planRowSimilarity')}</td>
                        <td className="border-b p-2 align-top">{t('adminAi.planRowSimilarityAll')}</td>
                        <td className="border-b p-2 align-top">{t('adminAi.planRowSimilarityAll')}</td>
                        <td className="border-b p-2 align-top">{t('adminAi.planRowSimilarityAll')}</td>
                      </tr>
                      <tr>
                        <td className="border-b p-2 align-top">{t('adminAi.planRowBudget')}</td>
                        <td className="border-b p-2 align-top text-muted-foreground">{t('adminAi.planRowBudgetBeginner')}</td>
                        <td className="border-b p-2 align-top">{t('adminAi.planRowBudgetOther')}</td>
                        <td className="border-b p-2 align-top">{t('adminAi.planRowBudgetOther')}</td>
                      </tr>
                      <tr>
                        <td className="border-b p-2 align-top">{t('adminAi.planRowLimit2')}</td>
                        <td className="border-b p-2 align-top" colSpan={3}>
                          {t('adminAi.planRowLimit2All')}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  {t('adminAi.planNote')}{' '}
                  <Link href="/settings/tenant" className="text-primary underline">
                    {t('adminAi.planNoteLinkText')}
                  </Link>
                  {t('adminAi.planNotePost')}
                </p>
              </div>

              <div>
                <h3 className="font-medium">{t('adminAi.usageTitle')}</h3>
                <p className="mt-1">{t('adminAi.usageBody')}</p>
              </div>
            </div>
          </section>
        </>
      )}

      {/* Still not resolved */}
      <section className="rounded-lg border bg-muted/40 p-5">
        <h2 className="text-base font-semibold">{t('notResolved.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('notResolved.descPre')}{' '}
          <strong>{t('notResolved.discord')}</strong>{' '}
          {t('notResolved.descPost')}
        </p>
        <ul className="mt-2 list-disc pl-5 text-sm text-muted-foreground">
          <li>{t('notResolved.li1')}</li>
          <li>{t('notResolved.li2')}</li>
          <li>{t('notResolved.li3')}</li>
        </ul>
        <p className="mt-3 text-sm text-muted-foreground">
          {t('notResolved.linksDesc')}
        </p>
        {featureRequest && (
          <div className="mt-3 flex flex-wrap gap-2">
            <a
              href={featureRequest}
              target="_blank"
              rel="noopener noreferrer"
              title={tNav('featureRequestTooltip')}
              className="inline-flex items-center gap-1.5 rounded-md bg-card px-3 py-1.5 text-sm hover:bg-accent"
            >
              ✨ {tNav('featureRequest')}
            </a>
          </div>
        )}
      </section>
    </div>
    </FaqQueryContext.Provider>
  );
}

function extractText(node: React.ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join(' ');
  if (isValidElement(node)) {
    const props = node.props as { children?: React.ReactNode };
    return extractText(props.children);
  }
  return '';
}

function faqItemHaystack(child: React.ReactNode): string | null {
  if (!isValidElement(child)) return null;
  const props = child.props as { q?: string; a?: React.ReactNode };
  if (typeof props.q !== 'string') return null;
  return `${props.q} ${extractText(props.a)}`.toLowerCase();
}

function FirstStepFaqSection({ viewer }: { viewer: ViewerRoles }) {
  const t = useTranslations('help');
  const entries = FAQ_ENTRIES.filter(
    (e) => FIRST_STEP_FAQ_IDS.includes(e.id) && canViewerSee(e.visibleTo, viewer),
  );
  if (entries.length === 0) return null;
  return (
    <FaqCategory title={t('sections.gettingStarted')}>
      {entries.map((e) => (
        <FaqItem
          key={e.id}
          q={e.q}
          a={<p className="whitespace-pre-line leading-relaxed">{e.a}</p>}
        />
      ))}
    </FaqCategory>
  );
}

function FaqCategory({
  title,
  tone,
  children,
}: {
  title: string;
  tone?: 'admin';
  children: React.ReactNode;
}) {
  const query = useContext(FaqQueryContext);
  const childArray = Children.toArray(children);
  const visible =
    query === ''
      ? childArray
      : childArray.filter((c) => {
          const hay = faqItemHaystack(c);
          return hay === null ? true : hay.includes(query);
        });
  if (query !== '' && visible.length === 0) return null;
  return (
    <section
      className={
        tone === 'admin'
          ? 'rounded-lg border border-info/30 bg-info/5 p-5'
          : 'rounded-lg border bg-card p-5'
      }
    >
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="mt-3 space-y-2">{visible}</div>
    </section>
  );
}

function FaqItem({ q, a }: { q: string; a: React.ReactNode }) {
  const query = useContext(FaqQueryContext);
  const matched =
    query !== '' && `${q} ${extractText(a)}`.toLowerCase().includes(query);
  return (
    <details
      open={matched || undefined}
      className="group rounded border bg-background p-3 [&[open]]:bg-accent/30"
    >
      <summary className="cursor-pointer list-none text-sm font-medium [&::-webkit-details-marker]:hidden">
        <span className="mr-2 text-muted-foreground group-open:hidden" aria-hidden>
          ▶
        </span>
        <span className="mr-2 text-muted-foreground hidden group-open:inline" aria-hidden>
          ▼
        </span>
        {q}
      </summary>
      <div className="mt-2 text-sm text-foreground/90">{a}</div>
    </details>
  );
}
