'use client';

/**
 * SeedDataCurationClient (feat/starter-data-import / 2026-06-05)
 *
 * 管理テナントの Project / Knowledge を一覧し、isSampleData をトグルする client。
 * 切替は PATCH /api/admin/super/seed-data 経由。サーバ側で MANAGEMENT_TENANT_ID に限定済み。
 */

import { useState } from 'react';
import type { SeedCandidate } from '@/services/sample-curation.service';

export function SeedDataCurationClient({
  initialCandidates,
}: {
  initialCandidates: SeedCandidate[];
}) {
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
        setError('切替に失敗しました。時間をおいて再度お試しください。');
        return;
      }
      setCandidates((prev) => prev.map((x) => (x.id === c.id ? { ...x, isSampleData: next } : x)));
    } catch {
      setError('通信エラーが発生しました。');
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
        <p className="font-semibold">⚠ 注意</p>
        <p className="mt-1 text-muted-foreground">
          「サンプルにする」にした項目は、<strong>すべてのテナントのスターターデータ取込で複製されます</strong>。
          運営の実データや機密を含む項目をサンプルにしないでください。
        </p>
      </div>

      {error && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
      )}

      <p className="text-sm text-muted-foreground">
        現在サンプル指定: <strong>{sampleCount}</strong> 件 / 全 {candidates.length} 件
      </p>

      <CandidateTable title="プロジェクト" items={projects} busyId={busyId} onToggle={toggle} />
      <CandidateTable title="ナレッジ" items={knowledge} busyId={busyId} onToggle={toggle} />
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
  return (
    <section className="rounded border p-4">
      <h2 className="text-base font-semibold">
        {title} ({items.length})
      </h2>
      {items.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">対象がありません。</p>
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
                サンプルにする
              </label>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
