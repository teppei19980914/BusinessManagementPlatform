'use client';

/**
 * 外部データ移行ウィザード (ADR-0034) — 手動CSV経路 v1
 *
 * 4 ステップ: ①CSVアップロード(エンティティ別) → ②マッピング → ③プレビュー → ④結果。
 * 「初回移行専用・新規作成のみ」。重複確認は行わない。更新は各「○○一覧」から。
 *
 * 設計メモ:
 *   - 値の正規化・公開範囲フォールバック・依存解決はサーバ側 (batch-preview) が担う。
 *     本UIは「列割当 / 既定値 / 取り込まない」の収集に専念する (ADR-0034 のマッピング3択)。
 *   - 二度押し防止: 送信中はボタン無効化 + サーバ側 preview 即削除の冪等で全件二重作成を防ぐ。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/toast-provider';
import {
  IMPORT_FIELD_CATALOG,
  IMPORT_ENTITY_LABELS,
  IMPORT_ENTITY_ORDER,
} from '@/services/import/import-field-catalog';
import type { ImportEntityKind } from '@/services/import/normalized-batch';

type Step = 1 | 2 | 3 | 4;

type EntityState = {
  enabled: boolean;
  fileName: string;
  csvText: string;
  headers: string[];
  columnMap: Record<string, string>; // field -> CSV列名
  fixedMap: Record<string, string>; // field -> 既定値
};

type PreviewError = {
  entity: string;
  ref: string;
  field?: string;
  file?: string;
  row?: number;
  column?: string;
  reason: string;
};
type PreviewSummary = {
  customers: number;
  projects: number;
  wbs: number;
  risks: number;
  knowledge: number;
  retrospectives: number;
  errorCount: number;
};
type PreviewData = { errors: PreviewError[]; warnings: string[]; summary: PreviewSummary };
type ApplyResult = {
  customersCreated: number;
  projectsCreated: number;
  wbsCreated: number;
  risksCreated: number;
  knowledgeCreated: number;
  retrospectivesCreated: number;
  errors: { entity: string; ref: string; reason: string }[];
};

function emptyEntityState(): EntityState {
  return { enabled: false, fileName: '', csvText: '', headers: [], columnMap: {}, fixedMap: {} };
}

/** CSV 先頭行を列名配列にパース (クォート対応の簡易版) */
function parseHeaderLine(text: string): string[] {
  const firstLine = text.replace(/^﻿/, '').split(/\r?\n/, 1)[0] ?? '';
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < firstLine.length; i++) {
    const c = firstLine[i];
    if (inQ) {
      if (c === '"') {
        if (firstLine[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') {
      out.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

/** 指定エンティティの「埋めれば取り込めるテンプレCSV」(日本語ヘッダ1行) をダウンロードする。 */
function downloadTemplate(entity: ImportEntityKind, suffix: string) {
  const labels = IMPORT_FIELD_CATALOG[entity].map((d) => d.label);
  const csv = '﻿' + labels.join(',') + '\r\n'; // UTF-8 BOM + ヘッダ行のみ
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${IMPORT_ENTITY_LABELS[entity]}${suffix}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function MigrationWizardClient() {
  const { showError } = useToast();
  const t = useTranslations('migrationWizard');
  const [step, setStep] = useState<Step>(1);
  const [states, setStates] = useState<Record<ImportEntityKind, EntityState>>(() => {
    const init = {} as Record<ImportEntityKind, EntityState>;
    for (const e of IMPORT_ENTITY_ORDER) init[e] = emptyEntityState();
    return init;
  });
  const [loading, setLoading] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [applyResult, setApplyResult] = useState<ApplyResult | null>(null);
  /** CSV選択段階の事前リンクチェック警告 (顧客/プロジェクトの未解決)。 */
  const [selectWarnings, setSelectWarnings] = useState<string[]>([]);

  const enabledEntities = useMemo(
    () => IMPORT_ENTITY_ORDER.filter((e) => states[e].enabled && states[e].csvText !== ''),
    [states],
  );

  // CSV選択中、プロジェクト/WBS があれば「顧客・プロジェクトが見つからない」事前警告を取得する。
  // (マッピング画面の既定値で補えるためエラーではなく警告。プレビューでは同条件がエラー)
  const linkCheckSeq = useRef(0);
  useEffect(() => {
    const relevant = enabledEntities.filter((e) => e === 'project' || e === 'wbs');
    const sources = enabledEntities.map((entity) => ({
      entity,
      csvText: states[entity].csvText,
      columnMap: states[entity].columnMap,
      fixedMap: states[entity].fixedMap,
      fileName: states[entity].fileName,
    }));
    const seq = ++linkCheckSeq.current;
    // クリア/取得とも非同期処理内で setState する (effect 同期実行中の setState は連鎖再描画を招くため)
    void (async () => {
      if (relevant.length === 0) {
        if (seq === linkCheckSeq.current) setSelectWarnings([]);
        return;
      }
      try {
        const res = await fetch('/api/tenants/me/migration-import/link-check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sources }),
        });
        const json = await res.json();
        if (seq !== linkCheckSeq.current) return; // 古い応答は破棄
        setSelectWarnings(res.ok && json.ok ? (json.warnings ?? []) : []);
      } catch {
        if (seq === linkCheckSeq.current) setSelectWarnings([]);
      }
    })();
  }, [states, enabledEntities]);

  const update = (entity: ImportEntityKind, patch: Partial<EntityState>) => {
    setStates((prev) => ({ ...prev, [entity]: { ...prev[entity], ...patch } }));
  };

  const onFile = async (entity: ImportEntityKind, file: File | null) => {
    if (!file) {
      update(entity, emptyEntityState());
      return;
    }
    const text = await file.text();
    const headers = parseHeaderLine(text);
    // 利便のため、ヘッダ名がラベルと完全一致する列だけ初期割当 (推定はしない)
    const columnMap: Record<string, string> = {};
    for (const def of IMPORT_FIELD_CATALOG[entity]) {
      const hit = headers.find((h) => h === def.label || h === def.field);
      if (hit) columnMap[def.field] = hit;
    }
    update(entity, { enabled: true, fileName: file.name, csvText: text, headers, columnMap, fixedMap: {} });
  };

  const callPreview = async () => {
    setLoading(true);
    try {
      const sources = enabledEntities.map((entity) => ({
        entity,
        csvText: states[entity].csvText,
        columnMap: states[entity].columnMap,
        fixedMap: states[entity].fixedMap,
        fileName: states[entity].fileName,
      }));
      const res = await fetch('/api/tenants/me/migration-import/csv-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sources }),
      });
      const json = await res.json().catch(() => null);
      // 通信/認可エラー (4xx/5xx) はトーストのまま。業務エラー (HTTP 200 + ok:false) は
      // プレビュー画面へ進めて、そこで理由を表示する (ユーザが原因を把握できるようにする)。
      if (!res.ok || !json) {
        showError(t('errorPreviewFailed'));
        return;
      }
      if (!json.ok) {
        const message = json?.error?.message ?? t('errorPreviewCreateFailed');
        setPreviewId(null);
        setPreview({
          errors: [{ entity: '', ref: '', reason: message }],
          warnings: [],
          summary: { customers: 0, projects: 0, wbs: 0, risks: 0, knowledge: 0, retrospectives: 0, errorCount: 1 },
        });
        setStep(3);
        return;
      }
      setPreviewId(json.previewId);
      setPreview(json.preview);
      setStep(3);
    } catch {
      showError(t('errorNetworkError'));
    } finally {
      setLoading(false);
    }
  };

  const callApply = async () => {
    if (!previewId) return;
    setLoading(true);
    try {
      const res = await fetch('/api/tenants/me/migration-import/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ previewId }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        showError(json?.error?.message ?? t('errorApplyFailed'));
        return;
      }
      setApplyResult(json.result);
      setStep(4);
    } catch {
      showError(t('errorNetworkError'));
    } finally {
      setLoading(false);
    }
  };

  const hasErrors = (preview?.errors.length ?? 0) > 0;

  return (
    <div className="space-y-6">
      <ol className="flex gap-2 text-sm">
        {[t('step1Label'), t('step2Label'), t('step3Label'), t('step4Label')].map((label, i) => (
          <li
            key={i}
            className={`rounded px-2 py-1 ${step === i + 1 ? 'bg-black text-white' : 'bg-gray-100 text-gray-500'}`}
          >
            {i + 1}. {label}
          </li>
        ))}
      </ol>

      <details className="rounded border bg-gray-50 p-3 text-xs text-gray-600">
        <summary className="cursor-pointer font-medium">{t('rulesSummary')}</summary>
        <div className="mt-2 space-y-1">
          <p className="font-bold text-amber-700">{t('rulesNoticeTitle')}</p>
          <p className="text-amber-700">{t('rulesNotice1')}</p>
          <p className="text-amber-700">{t('rulesNotice2')}</p>
          <p className="text-amber-700">{t('rulesNotice3')}</p>
          <p className="text-amber-700">{t('rulesNotice4')}</p>

          <p className="font-bold">{t('rulesCustomerTitle')}</p>
          <p className="pl-4">{t('rulesCustomerEmail')}</p>

          <p className="font-bold">{t('rulesProjectTitle')}</p>
          <p className="pl-4">{t('rulesProjectCustomer')}</p>
          <p className="pl-4">{t('rulesProjectStatus')}</p>
          <p className="pl-4">{t('rulesProjectDevMethod')}</p>
          <p className="pl-4">{t('rulesProjectContractType')}</p>
          <p className="pl-4">{t('rulesDates')}</p>

          <p className="font-bold">{t('rulesWbsTitle')}</p>
          <p className="pl-4">{t('rulesWbsProject')}</p>
          <p className="pl-4">{t('rulesWbsLevel')}</p>
          <p className="pl-4">{t('rulesWbsHours')}</p>
          <p className="pl-4">{t('rulesDates')}</p>

          <p className="font-bold">{t('rulesRiskTitle')}</p>
          <p className="pl-4 text-gray-500">{t('rulesRiskNote')}</p>
          <p className="pl-4">{t('rulesRiskKind')}</p>
          <p className="pl-4">{t('rulesRiskSeverity')}</p>
          <p className="pl-4">{t('rulesRiskProbability')}</p>
          <p className="pl-4">{t('rulesRiskNegativePositive')}</p>
          <p className="pl-4">{t('rulesDeadline')}</p>
          <p className="pl-4">{t('rulesVisibility')}</p>

          <p className="font-bold">{t('rulesIssueTitle')}</p>
          <p className="pl-4 text-gray-500">{t('rulesIssueNote')}</p>
          <p className="pl-4">{t('rulesIssueKind')}</p>
          <p className="pl-4">{t('rulesIssueSeverity')}</p>
          <p className="pl-4">{t('rulesIssueUrgency')}</p>
          <p className="pl-4">{t('rulesDeadline')}</p>
          <p className="pl-4">{t('rulesVisibility')}</p>

          <p className="font-bold">{t('rulesKnowledgeTitle')}</p>
          <p className="pl-4">{t('rulesKnowledgeKind')}</p>
          <p className="pl-4">{t('rulesVisibility')}</p>

          <p className="font-bold">{t('rulesRetroTitle')}</p>
          <p className="pl-4">{t('rulesRetroDate')}</p>
          <p className="pl-4">{t('rulesVisibility')}</p>
        </div>
      </details>

      {step === 1 && (
        <section className="space-y-4">
          <div className="rounded border bg-gray-50 p-3 text-xs">
            <p className="mb-2 font-medium">
              {t('step1TemplateDownloadTitle')}
            </p>
            <div className="flex flex-wrap gap-2">
              {IMPORT_ENTITY_ORDER.map((entity) => (
                <button
                  key={entity}
                  type="button"
                  className="rounded border bg-white px-2 py-1 hover:bg-gray-100"
                  onClick={() => downloadTemplate(entity, t('downloadTemplateSuffix'))}
                >
                  {IMPORT_ENTITY_LABELS[entity]} ⬇
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-3">
            {IMPORT_ENTITY_ORDER.map((entity) => (
              <div key={entity} className="flex items-center gap-3 rounded border p-3">
                <span className="w-40 font-medium">{IMPORT_ENTITY_LABELS[entity]}</span>
                <input
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(e) => void onFile(entity, e.target.files?.[0] ?? null)}
                />
                {states[entity].fileName && (
                  <span className="text-xs text-gray-500">
                    {states[entity].fileName}{t('step1ColumnCount', { count: states[entity].headers.length })}
                  </span>
                )}
              </div>
            ))}
          </div>
          {selectWarnings.length > 0 && (
            <div className="rounded border border-amber-300 bg-amber-50 p-3">
              <div className="mb-1 font-medium text-amber-700">
                {t('step1SelectWarningTitle', { count: selectWarnings.length })}
              </div>
              <ul className="max-h-40 list-disc space-y-1 overflow-auto pl-5 text-sm text-amber-700">
                {selectWarnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex justify-end">
            <Button disabled={enabledEntities.length === 0} onClick={() => setStep(2)}>
              {t('step1NextButton')}
            </Button>
          </div>
        </section>
      )}

      {step === 2 && (
        <section className="space-y-6">
          <p className="text-sm text-gray-600">
            {t('step2Description')}
          </p>
          {enabledEntities.map((entity) => (
            <div key={entity} className="rounded border">
              <div className="border-b bg-gray-50 px-3 py-2 font-medium">
                {IMPORT_ENTITY_LABELS[entity]}（{states[entity].fileName}）
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500">
                    <th className="px-3 py-1">{t('step2TableHeaderField')}</th>
                    <th className="px-3 py-1">{t('step2TableHeaderColumn')}</th>
                    <th className="px-3 py-1">{t('step2TableHeaderDefault')}</th>
                  </tr>
                </thead>
                <tbody>
                  {IMPORT_FIELD_CATALOG[entity].map((def) => (
                    <tr key={def.field} className="border-t">
                      <td className="px-3 py-1">
                        {def.label}
                        {def.required && <span className="ml-1 text-red-500">*</span>}
                        {def.hint && <div className="text-xs text-gray-400">{def.hint}</div>}
                      </td>
                      <td className="px-3 py-1">
                        <select
                          className="rounded border px-2 py-1"
                          value={states[entity].columnMap[def.field] ?? ''}
                          onChange={(e) =>
                            update(entity, {
                              columnMap: { ...states[entity].columnMap, [def.field]: e.target.value },
                            })
                          }
                        >
                          <option value="">{t('step2ColumnNoMap')}</option>
                          {states[entity].headers.map((h) => (
                            <option key={h} value={h}>
                              {h}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-3 py-1">
                        <input
                          className="rounded border px-2 py-1"
                          placeholder={t('step2DefaultPlaceholder')}
                          value={states[entity].fixedMap[def.field] ?? ''}
                          onChange={(e) =>
                            update(entity, {
                              fixedMap: { ...states[entity].fixedMap, [def.field]: e.target.value },
                            })
                          }
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
          <div className="flex justify-between">
            <Button variant="outline" onClick={() => setStep(1)}>
              {t('backButton')}
            </Button>
            <Button disabled={loading} onClick={() => void callPreview()}>
              {loading ? t('step2PreviewLoadingButton') : t('step2NextButton')}
            </Button>
          </div>
        </section>
      )}

      {step === 3 && preview && (
        <section className="space-y-4">
          <div className="rounded border p-3">
            <div className="mb-2 font-medium">{t('step3SummaryTitle')}</div>
            <ul className="grid grid-cols-3 gap-2 text-sm">
              <li>{t('summaryCustomers', { count: preview.summary.customers })}</li>
              <li>{t('summaryProjects', { count: preview.summary.projects })}</li>
              <li>WBS: {preview.summary.wbs}</li>
              <li>{t('summaryRisks', { count: preview.summary.risks })}</li>
              <li>{t('summaryKnowledge', { count: preview.summary.knowledge })}</li>
              <li>{t('summaryRetros', { count: preview.summary.retrospectives })}</li>
            </ul>
          </div>

          {hasErrors && (
            <div className="rounded border border-red-300 bg-red-50 p-3">
              <div className="mb-1 font-medium text-red-700">
                {t('step3ErrorTitle', { count: preview.errors.length })}
              </div>
              <ul className="max-h-48 list-disc space-y-1 overflow-auto pl-5 text-sm text-red-700">
                {preview.errors.map((e, i) => (
                  <li key={i}>
                    {e.file ? <span className="font-medium">{e.file}：</span> : null}
                    {e.row != null ? t('step3ErrorRowNumber', { row: e.row }) : null}
                    {e.column ? t('step3ErrorColumnLabel', { column: e.column }) : null}
                    {e.file || e.row != null || e.column ? ' — ' : null}
                    {e.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {preview.warnings.length > 0 && (
            <div className="rounded border border-amber-300 bg-amber-50 p-3">
              <div className="mb-1 font-medium text-amber-700">{t('step3WarningTitle', { count: preview.warnings.length })}</div>
              <ul className="max-h-40 list-disc space-y-1 overflow-auto pl-5 text-sm text-amber-700">
                {preview.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          <p className="text-xs text-gray-500">
            {t('step3Note')}
          </p>

          <div className="flex justify-between">
            <Button variant="outline" onClick={() => setStep(2)}>
              {t('backButton')}
            </Button>
            <Button disabled={loading || hasErrors} onClick={() => void callApply()}>
              {loading ? t('step3ApplyLoadingButton') : t('step3ApplyButton')}
            </Button>
          </div>
        </section>
      )}

      {step === 4 && applyResult && (
        <section className="space-y-4">
          <div className="rounded border border-green-300 bg-green-50 p-3">
            <div className="mb-2 font-medium text-green-700">{t('step4SuccessTitle')}</div>
            <ul className="grid grid-cols-3 gap-2 text-sm">
              <li>{t('summaryCustomers', { count: applyResult.customersCreated })}</li>
              <li>{t('summaryProjects', { count: applyResult.projectsCreated })}</li>
              <li>WBS: {applyResult.wbsCreated}</li>
              <li>{t('summaryRisks', { count: applyResult.risksCreated })}</li>
              <li>{t('summaryKnowledge', { count: applyResult.knowledgeCreated })}</li>
              <li>{t('summaryRetros', { count: applyResult.retrospectivesCreated })}</li>
            </ul>
          </div>
          {applyResult.errors.length > 0 && (
            <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700">
              <div className="mb-1 font-medium">{t('step4ErrorsTitle', { count: applyResult.errors.length })}</div>
              <ul className="list-disc space-y-1 pl-5">
                {applyResult.errors.map((e, i) => (
                  <li key={i}>
                    [{e.entity}] {e.ref}: {e.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="text-sm text-gray-600">{t('step4FinishNote')}</p>
        </section>
      )}
    </div>
  );
}
