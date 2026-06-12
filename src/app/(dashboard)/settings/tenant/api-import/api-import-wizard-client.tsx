'use client';

/**
 * 外部データ API 連携インポート ウィザード (クライアント) — ADR-0034 ② API 連携
 *
 * フロー:
 *   1. サービス選択 + 接続情報入力 → 「接続」(discover) で取得元一覧+項目を取得
 *   2. マッピング (取得元ごとに たすきばエンティティ + 項目を割り当て)
 *   3. プレビュー (トークン再入力 → connect/preview。サーバは認証情報を保存しない)
 *   4. 取り込み (apply。既存 migration-import/apply を流用)
 *
 * 認証情報 (トークン/APIキー) は state に保持し、discover / preview 各回でサーバに送信した直後に
 * クリアする (「毎回入力・都度即破棄」)。接続情報 (URL/ID 等の非機密) は保持して再入力を省く。
 *
 * 取り込み基盤・項目カタログは手動CSV経路と共有 (import-field-catalog)。Prisma を含むサービスは
 * import しない (型のみ) — client/service 境界 (feedback_client_service_boundary)。
 */

import { useState } from 'react';
import {
  IMPORT_FIELD_CATALOG,
  IMPORT_ENTITY_LABELS,
} from '@/services/import/import-field-catalog';
import type { ImportEntityKind } from '@/services/import/normalized-batch';

type ApiSource = 'notion' | 'backlog' | 'kintone' | 'pleasanter' | 'google_sheets';

interface DiscoveredField {
  key: string;
  label: string;
  type?: string;
}
interface DiscoveredSource {
  id: string;
  name: string;
  fields: DiscoveredField[];
  entityHint?: ImportEntityKind;
}
interface DiscoveredSchema {
  source: ApiSource;
  sources: DiscoveredSource[];
  warnings: string[];
}

interface PreviewSummary {
  customers: number;
  projects: number;
  wbs: number;
  risks: number;
  knowledge: number;
  retrospectives: number;
  errorCount: number;
}
interface PreviewError {
  entity: string;
  ref: string;
  field?: string;
  reason: string;
}
interface ImportPreview {
  summary: PreviewSummary;
  errors: PreviewError[];
  warnings: string[];
}

const SOURCES: { id: ApiSource; label: string; note: string }[] = [
  { id: 'google_sheets', label: 'Google スプレッドシート', note: 'タブ（シート）ごとに1エンティティ。ヘッダ行を列に使います。' },
  { id: 'backlog', label: 'Backlog', note: 'プロジェクトの課題を、課題種別で「タスク(WBS)」と「課題」に振り分けます。' },
  { id: 'notion', label: 'Notion', note: 'インテグレーションに共有したデータベースを取り込みます。' },
  { id: 'kintone', label: 'kintone', note: 'アプリ単位のAPIトークン（閲覧）。アプリIDを指定します。' },
  { id: 'pleasanter', label: 'Pleasanter', note: 'サイト(siteId)単位。Issues→WBS / Results→課題。' },
];

/** サービスごとの接続情報フィールド定義 (非機密。token は別管理)。 */
const CONN_FIELDS: Record<ApiSource, { tokenLabel: string; tokenHint: string; extra: { key: string; label: string; hint: string }[] }> = {
  notion: { tokenLabel: 'インテグレーショントークン', tokenHint: 'Notion の Integration（Read content 権限）のトークン', extra: [] },
  backlog: { tokenLabel: 'API キー', tokenHint: '個人設定で発行した API キー', extra: [{ key: 'baseUrl', label: 'ベースURL', hint: '例: https://xxxx.backlog.com（.jp / .backlogtool.com も可）' }] },
  kintone: { tokenLabel: 'API トークン', tokenHint: 'アプリの「閲覧」権限のAPIトークン', extra: [{ key: 'baseUrl', label: 'サブドメインURL', hint: '例: https://xxxx.kintone.com' }, { key: 'appIds', label: 'アプリID', hint: 'カンマ区切りで複数可（例: 12,15）' }] },
  pleasanter: { tokenLabel: 'ApiKey', tokenHint: '閲覧権限ユーザのApiKey', extra: [{ key: 'baseUrl', label: 'ベースURL', hint: 'オンプレ: https://host / クラウド: https://pleasanter.net/fs' }, { key: 'siteIds', label: 'サイトID', hint: 'カンマ区切りで複数可' }] },
  google_sheets: { tokenLabel: 'アクセストークン', tokenHint: 'OAuth (spreadsheets.readonly)。公開シートはAPIキーでも可', extra: [{ key: 'spreadsheetId', label: 'スプレッドシートID', hint: 'URL の /d/ と /edit の間の文字列' }, { key: 'apiKey', label: 'APIキー（公開シートのみ・任意）', hint: '公開シートを読む場合のみ。アクセストークンは空でOK' }] },
};

interface SourceMapState {
  entity: ImportEntityKind | 'none';
  columnMap: Record<string, string>;
  fixedMap: Record<string, string>;
  parentKey: string;
}

const STEP_LABELS = ['サービス選択', 'マッピング', 'プレビュー', '完了'] as const;

export function ApiImportWizard() {
  const [step, setStep] = useState(1);
  const [source, setSource] = useState<ApiSource | null>(null);
  const [token, setToken] = useState('');
  const [conn, setConn] = useState<Record<string, string>>({});
  const [schema, setSchema] = useState<DiscoveredSchema | null>(null);
  const [maps, setMaps] = useState<Record<string, SourceMapState>>({});
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [applied, setApplied] = useState<{ created: PreviewSummary } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connFields = source ? CONN_FIELDS[source] : null;

  function buildAuth() {
    const extra: Record<string, string> = {};
    let baseUrl: string | undefined;
    for (const f of connFields?.extra ?? []) {
      const v = (conn[f.key] ?? '').trim();
      if (!v) continue;
      if (f.key === 'baseUrl') baseUrl = v;
      else extra[f.key] = v;
    }
    return { token: token.trim(), baseUrl, extra };
  }

  async function handleDiscover() {
    if (!source) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/tenants/me/migration-import/connect/discover', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source, auth: buildAuth() }),
      });
      const json = await res.json();
      setToken(''); // 送信後すぐ破棄
      if (!json.ok) {
        setError(json.error?.message ?? '接続に失敗しました');
        return;
      }
      const sc = json.schema as DiscoveredSchema;
      setSchema(sc);
      // 初期マッピング: entityHint があれば採用
      const init: Record<string, SourceMapState> = {};
      for (const s of sc.sources) {
        init[s.id] = { entity: s.entityHint ?? 'none', columnMap: {}, fixedMap: {}, parentKey: '' };
      }
      setMaps(init);
      setStep(2);
    } finally {
      setBusy(false);
    }
  }

  function buildMappings() {
    if (!schema) return [];
    return schema.sources
      .filter((s) => maps[s.id]?.entity && maps[s.id].entity !== 'none')
      .map((s) => {
        const m = maps[s.id];
        const mapping: Record<string, unknown> = {
          sourceId: s.id,
          entity: m.entity,
          columnMap: m.columnMap,
          fixedMap: m.fixedMap,
        };
        if (m.parentKey) mapping.parentKey = m.parentKey;
        // Backlog: 課題種別フィールド (issueType:<id>) を WBS 振り分けに使う
        if (schema.source === 'backlog') {
          const ids = Object.values(m.columnMap)
            .filter((v) => v.startsWith('issueType:'))
            .map((v) => Number(v.split(':')[1]))
            .filter((n) => Number.isFinite(n));
          mapping.options = { wbsIssueTypeIds: ids };
        }
        return mapping;
      });
  }

  async function handlePreview() {
    if (!source) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/tenants/me/migration-import/connect/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source, auth: buildAuth(), mapping: { mappings: buildMappings() } }),
      });
      const json = await res.json();
      setToken('');
      if (!json.ok) {
        setError(json.error?.message ?? 'プレビューに失敗しました');
        return;
      }
      setPreview(json.preview as ImportPreview);
      setPreviewId(json.previewId as string);
      setStep(3);
    } finally {
      setBusy(false);
    }
  }

  async function handleApply() {
    if (!previewId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/tenants/me/migration-import/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ previewId }),
      });
      const json = await res.json();
      if (!json.ok) {
        setError(json.error?.message ?? '取り込みに失敗しました');
        return;
      }
      setApplied({ created: json.result?.created ?? json.result });
      setStep(4);
    } finally {
      setBusy(false);
    }
  }

  const canPreview = buildMappings().length > 0 && token.trim() !== '';

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4">
      <header>
        <h1 className="text-xl font-bold">外部データ API 連携インポート（ベータ）</h1>
        <p className="text-sm text-muted-foreground">
          Notion / Backlog / kintone / Pleasanter / Google スプレッドシート から直接つないでデータを取り込みます。
          認証情報はサーバに保存されません（送信のたびに破棄されます）。
        </p>
      </header>

      <ol className="flex flex-wrap gap-2 text-sm">
        {STEP_LABELS.map((label, i) => (
          <li
            key={label}
            className={`rounded px-2 py-1 ${step === i + 1 ? 'bg-black text-white' : 'bg-gray-100 text-gray-600'}`}
          >
            {i + 1}. {label}
          </li>
        ))}
      </ol>

      {error && (
        <div className="rounded border-l-4 border-red-500 bg-red-50 p-3 text-sm text-red-800" role="alert">
          {error}
        </div>
      )}

      {/* Step 1: サービス選択 + 接続 */}
      {step === 1 && (
        <section className="space-y-4">
          <div className="grid gap-2 sm:grid-cols-2">
            {SOURCES.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => { setSource(s.id); setSchema(null); }}
                className={`rounded border p-3 text-left ${source === s.id ? 'border-black ring-1 ring-black' : 'border-gray-300'}`}
              >
                <div className="font-semibold">{s.label}</div>
                <div className="text-xs text-muted-foreground">{s.note}</div>
              </button>
            ))}
          </div>

          {connFields && (
            <div className="space-y-3 rounded border p-3">
              {connFields.extra.map((f) => (
                <div key={f.key}>
                  <label className="text-sm font-medium">{f.label}</label>
                  <input
                    className="mt-1 block w-full rounded border px-2 py-1 text-sm"
                    value={conn[f.key] ?? ''}
                    onChange={(e) => setConn((c) => ({ ...c, [f.key]: e.target.value }))}
                    placeholder={f.hint}
                  />
                  <p className="text-xs text-muted-foreground">{f.hint}</p>
                </div>
              ))}
              <div>
                <label className="text-sm font-medium">{connFields.tokenLabel}</label>
                <input
                  type="password"
                  className="mt-1 block w-full rounded border px-2 py-1 text-sm"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder={connFields.tokenHint}
                  autoComplete="off"
                />
                <p className="text-xs text-muted-foreground">{connFields.tokenHint}（保存されません）</p>
              </div>
              <button
                type="button"
                disabled={busy || token.trim() === ''}
                onClick={handleDiscover}
                className="rounded bg-black px-3 py-1.5 text-sm text-white disabled:opacity-50"
              >
                {busy ? '接続中…' : '接続して取得元を読み込む'}
              </button>
            </div>
          )}
        </section>
      )}

      {/* Step 2: マッピング */}
      {step === 2 && schema && (
        <section className="space-y-4">
          {schema.warnings.map((w, i) => (
            <p key={i} className="rounded bg-amber-50 p-2 text-xs text-amber-800">{w}</p>
          ))}
          {schema.sources.length === 0 && (
            <p className="text-sm text-muted-foreground">取得できる対象がありませんでした。共有設定・ID をご確認ください。</p>
          )}
          {schema.sources.map((s) => {
            const m = maps[s.id];
            return (
              <div key={s.id} className="space-y-2 rounded border p-3">
                <div className="flex items-center justify-between">
                  <div className="font-semibold">{s.name}</div>
                  <select
                    className="rounded border px-2 py-1 text-sm"
                    value={m.entity}
                    onChange={(e) => setMaps((mm) => ({ ...mm, [s.id]: { ...m, entity: e.target.value as ImportEntityKind | 'none' } }))}
                  >
                    <option value="none">取り込まない</option>
                    {Object.entries(IMPORT_ENTITY_LABELS).map(([k, label]) => (
                      <option key={k} value={k}>{label}</option>
                    ))}
                  </select>
                </div>

                {m.entity !== 'none' && (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-muted-foreground">
                        <th className="py-1">たすきば項目</th>
                        <th className="py-1">連携元の項目</th>
                        <th className="py-1">既定値</th>
                      </tr>
                    </thead>
                    <tbody>
                      {IMPORT_FIELD_CATALOG[m.entity].map((def) => (
                        <tr key={def.field} className="border-t">
                          <td className="py-1 pr-2">
                            {def.label}
                            {def.required && <span className="text-red-500">*</span>}
                          </td>
                          <td className="py-1 pr-2">
                            <select
                              className="w-full rounded border px-1 py-0.5"
                              value={m.columnMap[def.field] ?? ''}
                              onChange={(e) =>
                                setMaps((mm) => ({ ...mm, [s.id]: { ...m, columnMap: { ...m.columnMap, [def.field]: e.target.value } } }))
                              }
                            >
                              <option value="">（割り当てない）</option>
                              {s.fields.map((f) => (
                                <option key={f.key} value={f.key}>{f.label}</option>
                              ))}
                            </select>
                          </td>
                          <td className="py-1">
                            <input
                              className="w-full rounded border px-1 py-0.5"
                              value={m.fixedMap[def.field] ?? ''}
                              onChange={(e) =>
                                setMaps((mm) => ({ ...mm, [s.id]: { ...m, fixedMap: { ...m.fixedMap, [def.field]: e.target.value } } }))
                              }
                              placeholder="（任意）"
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                {m.entity === 'wbs' && (
                  <div>
                    <label className="text-xs font-medium">親を指す項目（階層をつくる場合）</label>
                    <select
                      className="mt-1 block w-full rounded border px-1 py-0.5 text-sm"
                      value={m.parentKey}
                      onChange={(e) => setMaps((mm) => ({ ...mm, [s.id]: { ...m, parentKey: e.target.value } }))}
                    >
                      <option value="">（指定しない＝すべて最上位）</option>
                      {s.fields.map((f) => (
                        <option key={f.key} value={f.key}>{f.label}</option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            );
          })}

          <div className="flex gap-2">
            <button type="button" onClick={() => setStep(1)} className="rounded border px-3 py-1.5 text-sm">戻る</button>
            <button
              type="button"
              disabled={buildMappings().length === 0}
              onClick={() => setStep(3)}
              className="rounded bg-black px-3 py-1.5 text-sm text-white disabled:opacity-50"
            >
              次へ（プレビュー）
            </button>
          </div>
        </section>
      )}

      {/* Step 3: プレビュー (トークン再入力) */}
      {step === 3 && (
        <section className="space-y-4">
          {!preview && (
            <div className="space-y-3 rounded border p-3">
              <p className="text-sm">取り込み内容を確認するため、もう一度{connFields?.tokenLabel}を入力してください（取得のたびに破棄されます）。</p>
              <input
                type="password"
                className="block w-full rounded border px-2 py-1 text-sm"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={connFields?.tokenLabel}
                autoComplete="off"
              />
              <div className="flex gap-2">
                <button type="button" onClick={() => setStep(2)} className="rounded border px-3 py-1.5 text-sm">戻る</button>
                <button
                  type="button"
                  disabled={busy || !canPreview}
                  onClick={handlePreview}
                  className="rounded bg-black px-3 py-1.5 text-sm text-white disabled:opacity-50"
                >
                  {busy ? '取得中…' : '取得してプレビュー'}
                </button>
              </div>
            </div>
          )}

          {preview && (
            <div className="space-y-3">
              <div className="rounded border p-3 text-sm">
                <div className="font-semibold">取り込み件数</div>
                <ul className="mt-1 grid grid-cols-2 gap-1 sm:grid-cols-3">
                  <li>顧客: {preview.summary.customers}</li>
                  <li>プロジェクト: {preview.summary.projects}</li>
                  <li>WBS: {preview.summary.wbs}</li>
                  <li>リスク・課題: {preview.summary.risks}</li>
                  <li>ナレッジ: {preview.summary.knowledge}</li>
                  <li>振り返り: {preview.summary.retrospectives}</li>
                </ul>
              </div>

              {preview.warnings.length > 0 && (
                <div className="rounded bg-amber-50 p-3 text-xs text-amber-800">
                  {preview.warnings.map((w, i) => <p key={i}>{w}</p>)}
                </div>
              )}

              {preview.errors.length > 0 ? (
                <div className="rounded border-l-4 border-red-500 bg-red-50 p-3 text-xs text-red-800">
                  <p className="font-semibold">エラー（{preview.errors.length} 件）— 修正してから取り込めます</p>
                  <ul className="mt-1 list-disc pl-4">
                    {preview.errors.slice(0, 50).map((e, i) => (
                      <li key={i}>{IMPORT_ENTITY_LABELS[e.entity as ImportEntityKind] ?? e.entity}「{e.ref}」: {e.reason}</li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="text-sm text-emerald-700">エラーはありません。取り込めます。</p>
              )}

              <div className="flex gap-2">
                <button type="button" onClick={() => { setPreview(null); setStep(2); }} className="rounded border px-3 py-1.5 text-sm">マッピングに戻る</button>
                <button
                  type="button"
                  disabled={busy || preview.errors.length > 0}
                  onClick={handleApply}
                  className="rounded bg-black px-3 py-1.5 text-sm text-white disabled:opacity-50"
                >
                  {busy ? '取り込み中…' : 'この内容で取り込む'}
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {/* Step 4: 完了 */}
      {step === 4 && applied && (
        <section className="space-y-3">
          <div className="rounded border-l-4 border-emerald-500 bg-emerald-50 p-3 text-sm">
            <p className="font-semibold">取り込みが完了しました。</p>
            <ul className="mt-1 grid grid-cols-2 gap-1 sm:grid-cols-3">
              <li>顧客: {applied.created.customers}</li>
              <li>プロジェクト: {applied.created.projects}</li>
              <li>WBS: {applied.created.wbs}</li>
              <li>リスク・課題: {applied.created.risks}</li>
              <li>ナレッジ: {applied.created.knowledge}</li>
              <li>振り返り: {applied.created.retrospectives}</li>
            </ul>
          </div>
          <a href="/settings/tenant" className="text-info underline">設定に戻る</a>
        </section>
      )}
    </div>
  );
}
