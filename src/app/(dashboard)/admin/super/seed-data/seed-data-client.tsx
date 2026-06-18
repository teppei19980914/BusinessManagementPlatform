'use client';

/**
 * SeedDataCurationClient (feat/starter-data-import / 2026-06-05)
 *
 * 管理テナントの Project / Knowledge を一覧し、isSampleData をトグルする client。
 * 切替は PATCH /api/admin/super/seed-data 経由。サーバ側で MANAGEMENT_TENANT_ID に限定済み。
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import type { SeedCandidate } from '@/services/sample-curation.service';

export function SeedDataCurationClient({
  initialCandidates,
}: {
  initialCandidates: SeedCandidate[];
}) {
  const t = useTranslations('superAdmin');
  const [candidates, setCandidates] = useState<SeedCandidate[]>(initialCandidates);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');

  async function toggle(c: SeedCandidate, next: boolean) {
    setBusyId(c.id);
    setError('');
    try {
      const res = await fetch('/api/admin/super/seed-data', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entityType: c.type, entityId: c.id, isSampleData: next }),
      });
      if (!res.ok) {
        setError(t('seedCurationToggleErrorDefault'));
        return;
      }
      setCandidates((prev) => prev.map((x) => (x.id === c.id ? { ...x, isSampleData: next } : x)));
    } catch {
      setError(t('seedCurationNetworkError'));
    } finally {
      setBusyId(null);
    }
  }

  const projects = candidates.filter((c) => c.type === 'project');
  const knowledge = candidates.filter((c) => c.type === 'knowledge');
  const sampleCount = candidates.filter((c) => c.isSampleData).length;

  return (
    <div className="space-y-5">
      {/* 警告: サンプル化は全テナントの取込対象になる */}
      <div
        className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm"
        data-testid="seed-curation-warning"
      >
        <p className="font-semibold">{t('seedCurationWarningTitle')}</p>
        <p className="mt-1 text-muted-foreground">
          {t.rich('seedCurationWarningBody', { strong: (chunks) => <strong>{chunks}</strong> })}
        </p>
      </div>

      {error && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
      )}

      <p className="text-sm text-muted-foreground">
        {t('seedCurationSampleCountPrefix')}
        {t.rich('seedCurationSampleCount', { count: sampleCount, strong: (chunks) => <strong>{chunks}</strong> })}
        {t('seedCurationSampleCountTotal', { total: candidates.length })}
      </p>

      <CandidateTable title={t('seedCurationSectionProjects')} items={projects} busyId={busyId} onToggle={toggle} />
      <CandidateTable title={t('seedCurationSectionKnowledge')} items={knowledge} busyId={busyId} onToggle={toggle} />
    </div>
  );
}

function CandidateTable({
  title,
  items,
  busyId,
  onToggle,
}: {
  title: string;
  items: SeedCandidate[];
  busyId: string | null;
  onToggle: (c: SeedCandidate, next: boolean) => void;
}) {
  const t = useTranslations('superAdmin');
  return (
    <section className="rounded border p-4">
      <h2 className="text-base font-semibold">
        {t('seedCurationSectionTitle', { title, count: items.length })}
      </h2>
      {items.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">{t('seedCurationEmpty')}</p>
      ) : (
        <ul className="mt-3 divide-y">
          {items.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span className="break-all">{c.title}</span>
              <label className="flex shrink-0 items-center gap-2">
                <input
                  type="checkbox"
                  checked={c.isSampleData}
                  disabled={busyId === c.id}
                  onChange={(e) => onToggle(c, e.target.checked)}
                  data-testid={`seed-toggle-${c.id}`}
                />
                {t('seedCurationToggleLabel')}
              </label>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
