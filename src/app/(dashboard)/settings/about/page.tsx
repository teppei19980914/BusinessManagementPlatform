/**
 * `/settings/about` — サービス情報 / 運営者 / バージョン (feat/app-version-changelog-footer / 2026-05-23)。
 *
 * 認証済ユーザ向けの「このサービスの素性」確認画面。
 *   - サービス名 / 概要 (next-intl の app メタから流用)
 *   - 現在のバージョン + リリース日 + 更新履歴への遷移リンク
 *   - 運営者情報 (個人事業) + 連絡先 (一般 / セキュリティ)
 *   - 利用規約 / プライバシーポリシーへの遷移リンク (LP)
 *
 * 認証必須 (= dashboard route group 配下なので middleware で自動的に判定済)。
 * 未認証ユーザ向けには別途 `/changelog` (公開) で同じ情報の一部を露出する。
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  CONTACT_FORM_URL,
  OPERATOR_NAME,
  SECURITY_ADVISORY_URL,
} from '@/config/operator';
import { PRIVACY_URL, TERMS_URL } from '@/config/legal-versions';
import { getAppVersion, getReleaseDate } from '@/lib/app-version';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('about');
  return {
    title: `${t('pageTitle')} | たすきば Knowledge Relay`,
    description: t('pageDescription'),
  };
}

export default async function AboutPage() {
  const t = await getTranslations('about');
  const tApp = await getTranslations('app');

  return (
    <div className="mx-auto max-w-[min(90vw,42rem)] space-y-6" data-testid="about-page">
      <header className="space-y-2">
        <h2 className="text-xl font-semibold">{t('pageTitle')}</h2>
        <p className="text-sm text-muted-foreground">{t('pageDescription')}</p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">{t('sectionService')}</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-[max-content_1fr]">
            <dt className="text-muted-foreground">{t('serviceName')}</dt>
            <dd className="font-semibold">{tApp('metaTitle')}</dd>
            <dt className="text-muted-foreground">{t('serviceDescription')}</dt>
            <dd>{tApp('metaDescription')}</dd>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">{t('sectionVersion')}</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-[max-content_1fr]">
            <dt className="text-muted-foreground">{t('currentVersion')}</dt>
            <dd className="font-mono" data-testid="about-version">
              v{getAppVersion()}
            </dd>
            <dt className="text-muted-foreground">{t('releaseDate')}</dt>
            <dd data-testid="about-release-date">{getReleaseDate()}</dd>
          </dl>
          <div className="mt-4">
            <Link
              href="/changelog"
              className="text-sm text-primary hover:underline"
              data-testid="about-changelog-link"
            >
              {t('viewChangelog')} →
            </Link>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">{t('sectionOperator')}</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-[max-content_1fr]">
            <dt className="text-muted-foreground">{t('operatorName')}</dt>
            <dd data-testid="about-operator-name">{OPERATOR_NAME}</dd>
            <dt className="text-muted-foreground">{t('operatorForm')}</dt>
            <dd>{t('operatorFormValue')}</dd>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">{t('sectionContact')}</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-[max-content_1fr]">
            <dt className="text-muted-foreground">{t('contactGeneral')}</dt>
            <dd>
              <a
                href={CONTACT_FORM_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                {t('contactGeneralLink')} ↗
              </a>
            </dd>
            <dt className="text-muted-foreground">{t('contactSecurity')}</dt>
            <dd>
              <a
                href={SECURITY_ADVISORY_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                {t('contactSecurityLink')} ↗
              </a>
            </dd>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">{t('sectionLegal')}</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2 text-sm">
            <li>
              <a
                href={TERMS_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                {t('termsLink')} ↗
              </a>
            </li>
            <li>
              <a
                href={PRIVACY_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                {t('privacyLink')} ↗
              </a>
            </li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
