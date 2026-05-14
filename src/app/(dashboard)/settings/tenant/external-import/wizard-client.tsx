'use client';

/**
 * 外部データ移行ウィザード (Phase 1 / 2026-05-08)
 *
 * 4 ステップ構成:
 *   1. ファイル選択 + 取込エンティティ選択 + (RiskIssue 用の) デフォルトプロジェクト
 *   2. カラムマッピング (CSV 列 → 本サービスフィールド)
 *   3. dry-run プレビュー (件数 + エラー + コスト見積) → 実行確認
 *   4. 結果表示
 *
 * 受付フォーマット: CSV のみ (UTF-8、BOM 自動除去)。
 *   Excel (.xlsx) は xlsx ライブラリの未パッチ脆弱性により Phase 1 では非対応。
 *   Excel ユーザは Excel の「名前を付けて保存」→「CSV (UTF-8)」で対応してもらう。
 *
 * Step 1 でブラウザ側で先頭行のみパースしてヘッダ列を取得 (= マッピング UI のため)。
 * Step 3 では preview API を呼び (Voyage 課金なし)、Step 4 で apply API を呼ぶ (= ここで初めて課金)。
 */

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/toast-provider';

type Project = { id: string; name: string };

type WizardStep = 1 | 2 | 3 | 4;

type Entity = 'knowledge' | 'risksIssues';

type FieldMapping = Record<string, string>; // CSV列名 → フィールド名 (or 'skip')

type EntityState = {
  enabled: boolean;
  headers: string[]; // 検出された CSV ヘッダ
  fieldMapping: FieldMapping;
  defaultProjectId: string; // RiskIssue のみ使用
};

type CostEstimate = {
  voyageCalls: number;
  plan: 'beginner' | 'expert' | 'pro';
  estimatedJpy: number;
  currentMonthJpy: number;
  projectedMonthJpy: number;
  budgetCapJpy: number | null;
  beginnerCallLimit: number | null;
  currentMonthCallCount: number;
  warningCode: string | null;
  warningMessage: string | null;
};

type PreviewError = { entity: Entity; row: number; field?: string; reason: string };

type PreviewResponse = {
  ok: true;
  previewId: string;
  summary: {
    knowledge: { totalRows: number; validRows: number; errorRows: number };
    risksIssues: { totalRows: number; validRows: number; errorRows: number };
  };
  errors: PreviewError[];
  costEstimate: CostEstimate;
  expiresAt: string;
};

const KNOWLEDGE_FIELDS: Array<{ value: string; label: string; required: boolean }> = [
  { value: 'title', label: 'title (タイトル)', required: true },
  { value: 'knowledgeType', label: 'knowledgeType (種別)', required: false },
  { value: 'background', label: 'background (背景)', required: true },
  { value: 'content', label: 'content (内容)', required: true },
  { value: 'result', label: 'result (結果)', required: true },
  { value: 'conclusion', label: 'conclusion (結論)', required: false },
  { value: 'recommendation', label: 'recommendation (推奨)', required: false },
  { value: 'reusability', label: 'reusability (再利用性 high/medium/low)', required: false },
  { value: 'techTags', label: 'techTags (技術タグ、カンマ区切り)', required: false },
  { value: 'devMethod', label: 'devMethod (waterfall/agile/hybrid)', required: false },
  { value: 'processTags', label: 'processTags (工程タグ、カンマ区切り)', required: false },
  { value: 'businessDomainTags', label: 'businessDomainTags (業務ドメイン、カンマ区切り)', required: false },
  { value: 'visibility', label: 'visibility (draft/project/company)', required: false },
];

const RISKS_ISSUES_FIELDS: Array<{ value: string; label: string; required: boolean }> = [
  { value: 'type', label: 'type (risk または issue) [必須]', required: true },
  { value: 'title', label: 'title (タイトル)', required: true },
  { value: 'content', label: 'content (内容)', required: true },
  { value: 'cause', label: 'cause (原因)', required: false },
  { value: 'impact', label: 'impact (low/medium/high)', required: true },
  { value: 'likelihood', label: 'likelihood (low/medium/high)', required: false },
  { value: 'priority', label: 'priority (low/medium/high)', required: true },
  { value: 'responsePolicy', label: 'responsePolicy (対応方針)', required: false },
  { value: 'responseDetail', label: 'responseDetail (対応詳細)', required: false },
  { value: 'deadline', label: 'deadline (YYYY-MM-DD)', required: false },
  { value: 'state', label: 'state (open/closed 等)', required: false },
  { value: 'lessonLearned', label: 'lessonLearned (教訓)', required: false },
  { value: 'visibility', label: 'visibility (draft/public)', required: false },
  { value: 'riskNature', label: 'riskNature (threat/opportunity, type=risk のみ)', required: false },
  { value: 'projectId', label: 'projectId (テナント内プロジェクト ID、空なら下のデフォルト適用)', required: false },
];

const initialEntityState = (): EntityState => ({
  enabled: false,
  headers: [],
  fieldMapping: {},
  defaultProjectId: '',
});

/**
 * CSV 先頭行 (= ヘッダ行) を簡易パースしてカラム名配列を返す。
 *   - UTF-8 BOM (﻿) を除去
 *   - 改行 (CRLF / LF) で分割し最初の行を取得
 *   - 単純なカンマ分割 (本サービスのテンプレートにはカンマを含む列名がない前提)
 *   - 引用符付き列名 ("a,b") は本機能の用途では発生しない想定
 */
function getCsvHeaders(text: string): string[] {
  const cleaned = text.replace(/^﻿/, '');
  const firstLine = cleaned.split(/\r?\n/, 1)[0] ?? '';
  return firstLine
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h.length > 0);
}

export function ExternalImportWizard({ projects }: { projects: Project[] }) {
  const { showSuccess, showError } = useToast();
  const [step, setStep] = useState<WizardStep>(1);
  const [file, setFile] = useState<File | null>(null);
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [knowledgeState, setKnowledgeState] = useState<EntityState>(initialEntityState);
  const [risksIssuesState, setRisksIssuesState] = useState<EntityState>(initialEntityState);
  const [previewResult, setPreviewResult] = useState<PreviewResponse | null>(null);
  const [applyResult, setApplyResult] = useState<{
    knowledgeCreated: number;
    risksIssuesCreated: number;
    embeddingGenerated: number;
    embeddingFailed: number;
    // PR #358 (2026-05-14): visibility='draft' (公開範囲: 自分のみ) で課金対象外とした件数
    embeddingSkippedDraft: number;
    totalCostJpy: number;
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // ============ Step 1: ファイル選択時の処理 ============
  async function handleFileSelected(f: File): Promise<void> {
    setFile(f);
    setCsvHeaders([]);
    setKnowledgeState(initialEntityState());
    setRisksIssuesState(initialEntityState());
    try {
      // CSV はテキストとして読込、先頭行のみパースしてヘッダ列を抽出
      const text = await f.text();
      const headers = getCsvHeaders(text);
      if (headers.length === 0) {
        showError('CSV のヘッダ行を検出できませんでした');
        return;
      }
      setCsvHeaders(headers);
    } catch {
      showError('ファイルを CSV として読み込めませんでした');
    }
  }

  // ============ Step 1 → Step 2 ============
  function goToMappingStep(): void {
    if (!file || csvHeaders.length === 0) {
      showError('まずファイルを選択してください');
      return;
    }
    if (!knowledgeState.enabled && !risksIssuesState.enabled) {
      showError('Knowledge または RiskIssue のいずれかを選択してください');
      return;
    }
    // ヘッダを各 entity state に転写 + 同名フィールドの自動マッピング
    if (knowledgeState.enabled) {
      setKnowledgeState((s) => ({
        ...s,
        headers: csvHeaders,
        fieldMapping: autoMap(csvHeaders, KNOWLEDGE_FIELDS.map((f) => f.value)),
      }));
    }
    if (risksIssuesState.enabled) {
      setRisksIssuesState((s) => ({
        ...s,
        headers: csvHeaders,
        fieldMapping: autoMap(csvHeaders, RISKS_ISSUES_FIELDS.map((f) => f.value)),
      }));
    }
    setStep(2);
  }

  // ============ Step 2 → Step 3: Preview API 呼出 ============
  async function callPreview(): Promise<void> {
    if (!file) return;
    if (!validateMappingsBeforePreview()) return;
    setSubmitting(true);
    try {
      const mappings: Array<{
        entity: Entity;
        fieldMapping: FieldMapping;
        defaultProjectId?: string;
      }> = [];
      if (knowledgeState.enabled) {
        mappings.push({
          entity: 'knowledge',
          fieldMapping: knowledgeState.fieldMapping,
        });
      }
      if (risksIssuesState.enabled) {
        mappings.push({
          entity: 'risksIssues',
          fieldMapping: risksIssuesState.fieldMapping,
          defaultProjectId: risksIssuesState.defaultProjectId || undefined,
        });
      }
      const formData = new FormData();
      formData.append('file', file);
      formData.append('mappings', JSON.stringify(mappings));

      const res = await fetch('/api/tenants/me/external-import/preview', {
        method: 'POST',
        body: formData,
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        showError(json?.error?.message ?? 'プレビューに失敗しました');
        return;
      }
      setPreviewResult(json as PreviewResponse);
      setStep(3);
    } finally {
      setSubmitting(false);
    }
  }

  function validateMappingsBeforePreview(): boolean {
    if (knowledgeState.enabled) {
      const ok = validateRequiredFields(knowledgeState.fieldMapping, KNOWLEDGE_FIELDS, 'Knowledge');
      if (!ok) return false;
    }
    if (risksIssuesState.enabled) {
      const ok = validateRequiredFields(risksIssuesState.fieldMapping, RISKS_ISSUES_FIELDS, 'RiskIssue');
      if (!ok) return false;
      // RiskIssue: projectId 列マッピング無し かつ defaultProjectId 未選択 → エラー
      const hasProjectIdColumn = Object.values(risksIssuesState.fieldMapping).includes('projectId');
      if (!hasProjectIdColumn && !risksIssuesState.defaultProjectId) {
        showError(
          'RiskIssue の projectId 列マッピングがない場合、デフォルトプロジェクトを選択してください',
        );
        return false;
      }
    }
    return true;
  }

  function validateRequiredFields(
    mapping: FieldMapping,
    fields: Array<{ value: string; label: string; required: boolean }>,
    label: string,
  ): boolean {
    const mapped = new Set(Object.values(mapping));
    for (const f of fields) {
      if (f.required && !mapped.has(f.value)) {
        showError(`${label} の ${f.label} が未マッピングです`);
        return false;
      }
    }
    return true;
  }

  // ============ Step 3 → Step 4: Apply API 呼出 ============
  async function callApply(): Promise<void> {
    if (!previewResult) return;
    if (previewResult.costEstimate.warningCode) {
      showError('現在の状態では取込できません。エラー内容を確認してください');
      return;
    }
    const ok = confirm(
      previewResult.costEstimate.estimatedJpy > 0
        ? `この取込で ¥${previewResult.costEstimate.estimatedJpy.toLocaleString()} の生成 AI 利用料が発生します。実行しますか?`
        : '取込を実行しますか?',
    );
    if (!ok) return;
    setSubmitting(true);
    try {
      const res = await fetch('/api/tenants/me/external-import/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ previewId: previewResult.previewId }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        showError(json?.error?.message ?? '取込に失敗しました');
        return;
      }
      setApplyResult(json.summary);
      setStep(4);
      showSuccess('データを取り込みました');
    } finally {
      setSubmitting(false);
    }
  }

  // ============ レンダリング ============
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">外部データ移行 (Phase 1)</h1>
      <p className="text-sm text-muted-foreground">
        外部システム (社内 wiki / Excel / 旧 PM ツール等) から **CSV** で
        Knowledge と RiskIssue を一括取り込みします。
        Excel をお使いの場合は「名前を付けて保存」→「CSV (UTF-8)」で変換してください。
      </p>

      <StepIndicator current={step} />

      {step === 1 && (
        <Step1FileSelect
          file={file}
          csvHeaders={csvHeaders}
          projects={projects}
          knowledgeState={knowledgeState}
          risksIssuesState={risksIssuesState}
          onFileChange={handleFileSelected}
          onKnowledgeChange={setKnowledgeState}
          onRisksIssuesChange={setRisksIssuesState}
          onNext={goToMappingStep}
        />
      )}

      {step === 2 && (
        <Step2Mapping
          knowledgeState={knowledgeState}
          risksIssuesState={risksIssuesState}
          projects={projects}
          onKnowledgeChange={setKnowledgeState}
          onRisksIssuesChange={setRisksIssuesState}
          onBack={() => setStep(1)}
          onNext={callPreview}
          submitting={submitting}
        />
      )}

      {step === 3 && previewResult && (
        <Step3Preview
          preview={previewResult}
          onBack={() => setStep(2)}
          onApply={callApply}
          submitting={submitting}
        />
      )}

      {step === 4 && applyResult && <Step4Result summary={applyResult} />}
    </div>
  );
}

// ================================================================
// Step インジケータ
// ================================================================

function StepIndicator({ current }: { current: WizardStep }) {
  const labels = ['1. ファイル選択', '2. マッピング', '3. プレビュー', '4. 結果'];
  return (
    <div className="flex items-center gap-2 text-sm">
      {labels.map((label, idx) => {
        const stepNum = idx + 1;
        const isActive = stepNum === current;
        const isDone = stepNum < current;
        return (
          <div
            key={label}
            className={`rounded px-3 py-1 ${
              isActive
                ? 'bg-primary text-primary-foreground font-semibold'
                : isDone
                  ? 'bg-info/30'
                  : 'bg-muted/50 text-muted-foreground'
            }`}
          >
            {label}
          </div>
        );
      })}
    </div>
  );
}

// ================================================================
// Step 1: ファイル選択
// ================================================================

function Step1FileSelect(props: {
  file: File | null;
  csvHeaders: string[];
  projects: Project[];
  knowledgeState: EntityState;
  risksIssuesState: EntityState;
  onFileChange: (f: File) => void;
  onKnowledgeChange: (s: EntityState) => void;
  onRisksIssuesChange: (s: EntityState) => void;
  onNext: () => void;
}) {
  return (
    <div className="space-y-4">
      <section className="rounded border p-4">
        <h2 className="font-semibold">Step 1. ファイルとエンティティを選択</h2>

        <div className="mt-3 space-y-2">
          <label className="block text-sm font-medium">CSV ファイル (UTF-8)</label>
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) props.onFileChange(f);
            }}
            className="block w-full text-sm"
          />
          {props.file && (
            <p className="text-xs text-muted-foreground">
              {props.file.name} ({(props.file.size / 1024).toFixed(1)} KB)
              {props.csvHeaders.length > 0 && (
                <> · 検出列数: {props.csvHeaders.length}</>
              )}
            </p>
          )}
          <div className="flex gap-2 text-xs">
            <a
              href="/api/tenants/me/external-import/template?entity=knowledge"
              className="text-info underline"
              download
            >
              Knowledge テンプレート CSV
            </a>
            <span className="text-muted-foreground">|</span>
            <a
              href="/api/tenants/me/external-import/template?entity=risksIssues"
              className="text-info underline"
              download
            >
              RiskIssue テンプレート CSV
            </a>
          </div>
        </div>

        <div className="mt-4 space-y-3">
          {/* Knowledge */}
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={props.knowledgeState.enabled}
              onChange={(e) =>
                props.onKnowledgeChange({ ...props.knowledgeState, enabled: e.target.checked })
              }
              className="mt-1"
            />
            <div className="flex-1">
              <div className="font-medium">Knowledge を取り込む</div>
              <p className="text-xs text-muted-foreground">
                ナレッジ (社内 wiki / 過去資料 / 教訓) を取り込みます。
              </p>
            </div>
          </label>

          {/* RiskIssue */}
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={props.risksIssuesState.enabled}
              onChange={(e) =>
                props.onRisksIssuesChange({ ...props.risksIssuesState, enabled: e.target.checked })
              }
              className="mt-1"
            />
            <div className="flex-1">
              <div className="font-medium">RiskIssue を取り込む (リスク + 過去課題)</div>
              <p className="text-xs text-muted-foreground">
                各行に projectId 列が無い場合、すべての行を 1 つのプロジェクトに所属させます。
              </p>
              {props.risksIssuesState.enabled && (
                <div className="mt-2">
                  <select
                    value={props.risksIssuesState.defaultProjectId}
                    onChange={(e) =>
                      props.onRisksIssuesChange({
                        ...props.risksIssuesState,
                        defaultProjectId: e.target.value,
                      })
                    }
                    className="block w-full rounded border bg-background p-1 text-xs"
                  >
                    <option value="">デフォルトプロジェクト未選択 (= projectId 列で指定)</option>
                    {props.projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        全行を {p.name} に所属させる
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          </label>
        </div>
      </section>

      <Button onClick={props.onNext} disabled={!props.file || props.csvHeaders.length === 0}>
        次へ (マッピング設定) →
      </Button>
    </div>
  );
}

// ================================================================
// Step 2: カラムマッピング
// ================================================================

function Step2Mapping(props: {
  knowledgeState: EntityState;
  risksIssuesState: EntityState;
  projects: Project[];
  onKnowledgeChange: (s: EntityState) => void;
  onRisksIssuesChange: (s: EntityState) => void;
  onBack: () => void;
  onNext: () => void;
  submitting: boolean;
}) {
  return (
    <div className="space-y-4">
      <section className="rounded border p-4">
        <h2 className="font-semibold">Step 2. カラムマッピング</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          CSV/Excel の列名を本サービスのフィールドに対応付けします。必須列は赤色で示されます。
        </p>

        {props.knowledgeState.enabled && (
          <MappingTable
            title="Knowledge"
            state={props.knowledgeState}
            fields={KNOWLEDGE_FIELDS}
            onChange={props.onKnowledgeChange}
          />
        )}

        {props.risksIssuesState.enabled && (
          <MappingTable
            title="RiskIssue (リスク + 過去課題)"
            state={props.risksIssuesState}
            fields={RISKS_ISSUES_FIELDS}
            onChange={props.onRisksIssuesChange}
          />
        )}
      </section>

      <div className="flex gap-2">
        <Button variant="outline" onClick={props.onBack} disabled={props.submitting}>
          ← 戻る
        </Button>
        <Button onClick={props.onNext} disabled={props.submitting}>
          {props.submitting ? '検証中...' : 'プレビューを表示 →'}
        </Button>
      </div>
    </div>
  );
}

function MappingTable(props: {
  title: string;
  state: EntityState;
  fields: Array<{ value: string; label: string; required: boolean }>;
  onChange: (s: EntityState) => void;
}) {
  return (
    <div className="mt-4 space-y-2">
      <h3 className="text-sm font-semibold">{props.title}</h3>
      <table className="w-full text-xs">
        <thead className="bg-muted/40">
          <tr>
            <th className="p-2 text-left">CSV/Excel の列名</th>
            <th className="p-2 text-left">→ 本サービスのフィールド</th>
          </tr>
        </thead>
        <tbody>
          {props.state.headers.map((csvCol) => (
            <tr key={csvCol} className="border-b">
              <td className="p-2 font-mono">{csvCol}</td>
              <td className="p-2">
                <select
                  value={props.state.fieldMapping[csvCol] ?? 'skip'}
                  onChange={(e) =>
                    props.onChange({
                      ...props.state,
                      fieldMapping: { ...props.state.fieldMapping, [csvCol]: e.target.value },
                    })
                  }
                  className="rounded border bg-background p-1 text-xs"
                >
                  <option value="skip">(取込まない)</option>
                  {props.fields.map((f) => (
                    <option key={f.value} value={f.value}>
                      {f.required ? '⚠ ' : ''}
                      {f.label}
                    </option>
                  ))}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ================================================================
// Step 3: プレビュー
// ================================================================

function Step3Preview(props: {
  preview: PreviewResponse;
  onBack: () => void;
  onApply: () => void;
  submitting: boolean;
}) {
  const { summary, costEstimate, errors } = props.preview;
  const hasError = errors.length > 0;

  return (
    <div className="space-y-4">
      <section className="rounded border p-4">
        <h2 className="font-semibold">Step 3. プレビュー (まだ取込はされていません)</h2>

        <div className="mt-3 grid grid-cols-2 gap-4 text-sm">
          <div className="rounded bg-muted/30 p-3">
            <p className="font-semibold">Knowledge</p>
            <p>合計 {summary.knowledge.totalRows} 行</p>
            <p className="text-info">取込可能 {summary.knowledge.validRows} 行</p>
            {summary.knowledge.errorRows > 0 && (
              <p className="text-destructive">エラー {summary.knowledge.errorRows} 行</p>
            )}
          </div>
          <div className="rounded bg-muted/30 p-3">
            <p className="font-semibold">RiskIssue</p>
            <p>合計 {summary.risksIssues.totalRows} 行</p>
            <p className="text-info">取込可能 {summary.risksIssues.validRows} 行</p>
            {summary.risksIssues.errorRows > 0 && (
              <p className="text-destructive">エラー {summary.risksIssues.errorRows} 行</p>
            )}
          </div>
        </div>

        {/* コスト見積 */}
        <div className="mt-4 rounded border border-amber-300 bg-amber-50 p-3 text-sm dark:bg-amber-900/30">
          <p className="font-semibold">⚠ 生成 AI 利用課金の見積</p>
          <p>
            embedding 生成: <strong>{costEstimate.voyageCalls} 回</strong>
          </p>
          {costEstimate.plan === 'beginner' ? (
            <p>
              プラン: Beginner (¥0/call、ただし月間 {costEstimate.beginnerCallLimit} 回上限あり)
              <br />
              当月既呼出: {costEstimate.currentMonthCallCount} 回 / インポート後予測:{' '}
              {costEstimate.currentMonthCallCount + costEstimate.voyageCalls} 回
            </p>
          ) : (
            <>
              <p>
                プラン: {costEstimate.plan === 'pro' ? 'Pro (¥30/call)' : 'Expert (¥10/call)'}
                <br />
                <strong>本インポート見積: ¥{costEstimate.estimatedJpy.toLocaleString()}</strong>
              </p>
              <p className="mt-1">
                当月既消費: ¥{costEstimate.currentMonthJpy.toLocaleString()} → 取込後予測 ¥
                {costEstimate.projectedMonthJpy.toLocaleString()}
                {costEstimate.budgetCapJpy != null && (
                  <> / 月次予算上限 ¥{costEstimate.budgetCapJpy.toLocaleString()}</>
                )}
              </p>
            </>
          )}

          {costEstimate.warningCode && (
            <pre className="mt-2 whitespace-pre-wrap rounded bg-destructive/10 p-2 text-xs text-destructive">
              {costEstimate.warningMessage}
            </pre>
          )}
        </div>

        {/* エラー一覧 */}
        {hasError && (
          <div className="mt-4">
            <p className="font-semibold text-destructive">エラー詳細 ({errors.length} 件)</p>
            <div className="mt-2 max-h-60 overflow-auto rounded border bg-muted/20 p-2 text-xs">
              {errors.slice(0, 50).map((e, i) => (
                <div key={i} className="border-b py-1">
                  [{e.entity}] 行 {e.row}
                  {e.field && ` / ${e.field}`}: {e.reason}
                </div>
              ))}
              {errors.length > 50 && (
                <p className="mt-2 text-muted-foreground">
                  ...残り {errors.length - 50} 件 (取込実行時に修正してから再アップロードしてください)
                </p>
              )}
            </div>
          </div>
        )}
      </section>

      <div className="flex gap-2">
        <Button variant="outline" onClick={props.onBack} disabled={props.submitting}>
          ← マッピングを修正
        </Button>
        <Button
          onClick={props.onApply}
          disabled={
            props.submitting ||
            costEstimate.warningCode != null ||
            summary.knowledge.validRows + summary.risksIssues.validRows === 0
          }
        >
          {props.submitting
            ? '取込中...'
            : `📥 取込実行 (${summary.knowledge.validRows + summary.risksIssues.validRows} 件)`}
        </Button>
      </div>
    </div>
  );
}

// ================================================================
// Step 4: 結果
// ================================================================

function Step4Result(props: {
  summary: {
    knowledgeCreated: number;
    risksIssuesCreated: number;
    embeddingGenerated: number;
    embeddingFailed: number;
    embeddingSkippedDraft: number;
    totalCostJpy: number;
  };
}) {
  const s = props.summary;
  return (
    <div className="space-y-4">
      <section className="rounded border border-info bg-info/10 p-4">
        <h2 className="font-semibold">取込完了</h2>
        <ul className="mt-2 ml-4 list-disc text-sm">
          <li>Knowledge を {s.knowledgeCreated} 件 作成</li>
          <li>RiskIssue を {s.risksIssuesCreated} 件 作成</li>
          <li>
            embedding 生成: {s.embeddingGenerated} 件 成功 / {s.embeddingFailed} 件 失敗
            {s.embeddingFailed > 0 && (
              <span className="text-xs text-muted-foreground">
                {' '}
                (失敗分は提案エンジンで使われませんが、データ自体は正常に作成されています)
              </span>
            )}
          </li>
          {/* PR #358 (2026-05-14): 課金透明性 — 下書きで課金されなかった件数を明示 */}
          {s.embeddingSkippedDraft > 0 && (
            <li className="text-muted-foreground">
              うち下書き ({s.embeddingSkippedDraft} 件) は「公開範囲: 自分のみ」のため embedding 生成・課金対象外
            </li>
          )}
          <li>当インポート分の生成 AI 課金: ¥{s.totalCostJpy.toLocaleString()}</li>
        </ul>
      </section>

      <a
        href="/knowledge"
        className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90"
      >
        取り込んだナレッジを確認 →
      </a>
    </div>
  );
}

// ================================================================
// 内部: ヘッダ名から自動マッピング (= 同名ヒューリスティック)
// ================================================================

function autoMap(headers: string[], validFields: string[]): FieldMapping {
  const result: FieldMapping = {};
  for (const h of headers) {
    const lower = h.toLowerCase().trim();
    const match = validFields.find((f) => f.toLowerCase() === lower);
    result[h] = match ?? 'skip';
  }
  return result;
}
