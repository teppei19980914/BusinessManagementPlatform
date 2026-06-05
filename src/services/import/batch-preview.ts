/**
 * 外部移行インポート — プレビュー (依存解決 + 値解決 + バリデーション) (ADR-0034)
 *
 * NormalizedBatch を受け取り、たすきば内部値へ解決しつつ検証して ImportPreview を返す **純関数**。
 * DB 書き込みは行わない (2 段階フローの前段)。apply 側はこの ResolvedBatch を消費する。
 *
 * 検証方針 (ADR-0034 §3):
 *   - A群 (顧客・プロジェクト・WBS): 名称等はハード必須。空はエラー (ウィザードの既定値で埋める前提)。
 *   - B群 (リスク・課題・ナレッジ・振り返り): 公開範囲=下書きなら空でも可 (DB は '' で満たす)。
 *   - 選択値の不正・空は既定値 (公開範囲は draft)。日付は YYYY-MM-DD へ正規化、必須日付の変換不能はエラー。
 *   - プロジェクトの顧客は同バッチ内 customerRef で解決。見つからなければエラー (親なし=必須エラー)。
 *   - WBS のプロジェクトは所属プロジェクト内で解決 (自己完結バッチ)。
 */

import {
  resolveVisibility,
  resolveProjectStatus,
  resolveDevMethod,
  resolveContractType,
  resolveImpact,
  resolveLikelihood,
  resolveRiskNature,
  resolveKnowledgeType,
  isKnownDevMethod,
  isKnownContractType,
  isKnownProjectStatus,
  type Visibility,
  type ProjectStatus,
  type DevMethod,
  type ContractType,
  type ImpactLevel,
  type RiskNature,
  type KnowledgeType,
} from './value-mapping';
import { z } from 'zod/v4';
import { normalizeDate } from './date-normalize';
import { getImportFieldLabel } from './import-field-catalog';
import type { WbsRow } from './wbs-hierarchy';
import type {
  ImportEntityKind,
  NormalizedBatch,
  NormalizedProject,
  NormalizedRiskIssue,
  NormalizedKnowledge,
  NormalizedRetrospective,
  ExternalAsset,
  SourceOrigin,
} from './normalized-batch';

/** 新規作成/編集フォームと同じメール形式チェック (customer.ts と整合)。 */
const EMAIL_SCHEMA = z.string().email();

/** 既存データ照合用の名前正規化 (前後空白除去 + 小文字化)。サービス層と共有。 */
export function normalizeName(v: unknown): string {
  return String(v ?? '').trim().toLowerCase();
}

/**
 * プレビュー時に「既存テナントデータ」と名前照合するための索引 (サービス層が DB から構築)。
 * 親 (顧客/プロジェクト) は「同バッチ + 既存データ」の両方で解決する (ADR-0034 §2)。
 */
export interface ExistingDataIndex {
  /** 既存顧客: 正規化名 → 顧客ID */
  customers: Map<string, string>;
  /** 既存プロジェクト: 正規化名 → プロジェクトID */
  projects: Map<string, string>;
}

const EMPTY_EXISTING: ExistingDataIndex = { customers: new Map(), projects: new Map() };

/**
 * 顧客名を「同バッチの新規顧客 or 既存顧客」で解決する。未解決は null。
 * customerRef → customerRefDefault (既定値) の順で呼び出してフォールバックする。
 */
function resolveCustomerName(
  name: string | null | undefined,
  batchKeys: Set<string>,
  existing: ExistingDataIndex,
): { customerKey?: string; existingCustomerId?: string } | null {
  const n = String(name ?? '').trim();
  if (n === '') return null;
  if (batchKeys.has(n)) return { customerKey: n };
  const exId = existing.customers.get(normalizeName(n));
  return exId != null ? { existingCustomerId: exId } : null;
}

export interface PreviewError {
  entity: ImportEntityKind;
  /** 行/エンティティの識別子 (名前 or sourceKey) */
  ref: string;
  field?: string;
  /** 取り込み元 CSV のファイル名 (分かる場合) */
  file?: string;
  /** データ行番号 (1 始まり、分かる場合) */
  row?: number;
  /** 日本語の列名 (= テンプレ列名。分かる場合) */
  column?: string;
  /** 何が問題で、どう直すか */
  reason: string;
}

/** ファイル名・行番号・日本語列名を添えた PreviewError を作る。 */
function makeError(
  entity: ImportEntityKind,
  ref: string,
  origin: SourceOrigin | undefined,
  field: string | undefined,
  reason: string,
): PreviewError {
  return {
    entity,
    ref,
    field,
    file: origin?.file,
    row: origin?.row,
    column: field ? getImportFieldLabel(entity, field) : undefined,
    reason,
  };
}

/**
 * 「プロジェクト未紐づけ + 公開範囲=下書き」= 取り込んでも表示されない不可視データのエラー。
 * 公開範囲列 (visibility) を指す (= プレビューに「公開範囲」列として出す)。
 */
function makeInvisibleDraftError(
  entity: ImportEntityKind,
  ref: string,
  origin: SourceOrigin | undefined,
  label: string,
): PreviewError {
  return makeError(
    entity,
    ref,
    origin,
    'visibility',
    `プロジェクトに紐づかない「下書き」の${label}は、取り込んでもどの一覧にも表示されません（参照できなくなります）。`
      + 'プロジェクト名を指定するか、公開範囲を「公開」にしてください。',
  );
}

export interface ResolvedCustomer {
  sourceKey: string;
  name: string;
  department: string | null;
  contactPerson: string | null;
  contactEmail: string | null;
  notes: string | null;
}

export interface ResolvedRiskIssue {
  type: 'risk' | 'issue';
  title: string;
  occurrence: string | null;
  content: string;
  cause: string | null;
  impact: ImpactLevel;
  likelihood: ImpactLevel | null;
  responsePolicy: string | null;
  deadline: string | null;
  riskNature: RiskNature | null;
  visibility: Visibility;
}

export interface ResolvedKnowledge {
  title: string;
  knowledgeType: KnowledgeType;
  background: string;
  content: string;
  result: string;
  visibility: Visibility;
}

export interface ResolvedRetrospective {
  conductedDate: string | null; // 空は apply 側で当日補完
  planSummary: string;
  actualSummary: string;
  goodPoints: string;
  problems: string;
  improvements: string;
  visibility: Visibility;
}

export interface ResolvedProject {
  sourceKey: string;
  /** 解決済みの顧客 sourceKey。同バッチ内に存在する場合のみ設定 */
  customerKey: string | null;
  /** 既存顧客に紐づく場合の顧客ID (同バッチに無く既存データで解決できたとき)。 */
  existingCustomerId: string | null;
  name: string;
  purpose: string;
  background: string;
  scope: string;
  devMethod: DevMethod;
  contractType: ContractType | null;
  status: ProjectStatus;
  plannedStartDate: string | null;
  plannedEndDate: string | null;
  wbs: WbsRow[]; // 日付正規化済み
  risks: ResolvedRiskIssue[];
  knowledge: ResolvedKnowledge[];
  retros: ResolvedRetrospective[];
}

/** 既存プロジェクトに紐づく WBS (apply 時に既存 projectId へ追加作成する)。 */
export interface ResolvedExternalWbs {
  projectId: string;
  projectName: string;
  rows: WbsRow[];
}

/** プロジェクト未所属 or 既存プロジェクト紐づけの資産 (projectId=null は standalone)。 */
export interface ResolvedExternalAsset<T> {
  projectId: string | null;
  data: T;
}

export interface ResolvedBatch {
  customers: ResolvedCustomer[];
  projects: ResolvedProject[];
  /** 既存プロジェクト配下に追加する WBS (新規作成のみ・既存タスクは保持) */
  externalWbs: ResolvedExternalWbs[];
  /** standalone or 既存プロジェクト紐づけのリスク・課題 */
  externalRisks: ResolvedExternalAsset<ResolvedRiskIssue>[];
  /** standalone or 既存プロジェクト紐づけのナレッジ */
  externalKnowledge: ResolvedExternalAsset<ResolvedKnowledge>[];
  /** standalone or 既存プロジェクト紐づけの振り返り */
  externalRetros: ResolvedExternalAsset<ResolvedRetrospective>[];
}

export interface ImportPreview {
  resolved: ResolvedBatch;
  errors: PreviewError[];
  warnings: string[];
  summary: {
    customers: number;
    projects: number;
    wbs: number;
    risks: number;
    knowledge: number;
    retrospectives: number;
    errorCount: number;
  };
}

const str = (v: unknown): string => String(v ?? '').trim();
const orNull = (v: unknown): string | null => {
  const s = str(v);
  return s === '' ? null : s;
};

export function buildImportPreview(
  batch: NormalizedBatch,
  existing: ExistingDataIndex = EMPTY_EXISTING,
): ImportPreview {
  const errors: PreviewError[] = [];
  const warnings: string[] = [...batch.warnings];

  // ---- 顧客 ----
  const resolvedCustomers: ResolvedCustomer[] = [];
  const customerKeys = new Set<string>();
  for (const c of batch.customers) {
    const name = str(c.name);
    if (name === '') {
      errors.push(makeError('customer', c.sourceKey, c.origin, 'name', '顧客名が空です。値を入力してください。'));
      continue;
    }
    // 新規作成/編集フォームと同じくメール形式を検証 (空は許容、非空は email 形式必須)
    const contactEmail = orNull(c.contactEmail);
    if (contactEmail != null && !EMAIL_SCHEMA.safeParse(contactEmail).success) {
      errors.push(
        makeError(
          'customer',
          c.sourceKey,
          c.origin,
          'contactEmail',
          `メールアドレスの形式が正しくありません: ${contactEmail}。正しい形式 (例: name@example.com) に直すか、空欄にしてください。`,
        ),
      );
    }
    customerKeys.add(c.sourceKey);
    resolvedCustomers.push({
      sourceKey: c.sourceKey,
      name,
      department: orNull(c.department),
      contactPerson: orNull(c.contactPerson),
      contactEmail,
      notes: orNull(c.notes),
    });
  }

  // ---- プロジェクト ----
  const resolvedProjects: ResolvedProject[] = [];
  let wbsCount = 0;
  let riskCount = 0;
  let knowledgeCount = 0;
  let retroCount = 0;

  for (const p of batch.projects) {
    const ref = p.sourceKey || p.name;
    const name = str(p.name);
    if (name === '') {
      errors.push(makeError('project', ref, p.origin, 'name', 'プロジェクト名が空です。値を入力してください。'));
    }
    // 顧客の依存解決 (同バッチ + 既存テナント。未解決なら既定値 customerRefDefault でフォールバック)
    let customerKey: string | null = null;
    let existingCustomerId: string | null = null;
    const cref = str(p.customerRef);
    const cdef = str(p.customerRefDefault);
    const resolvedCustomer =
      resolveCustomerName(p.customerRef, customerKeys, existing)
      ?? resolveCustomerName(p.customerRefDefault, customerKeys, existing);
    if (resolvedCustomer) {
      customerKey = resolvedCustomer.customerKey ?? null;
      existingCustomerId = resolvedCustomer.existingCustomerId ?? null;
    } else if (cref === '' && cdef === '') {
      errors.push(makeError('project', ref, p.origin, 'customerName',
        'プロジェクトには顧客が必須です。「顧客名」列に、既存の顧客名か一緒に取り込む顧客の名前を入れてください。'));
    } else {
      errors.push(makeError('project', ref, p.origin, 'customerName',
        `顧客「${cref !== '' ? cref : cdef}」が見つかりません。既存の顧客一覧にあるか、顧客 CSV に同じ名前の行を入れてください。`));
    }

    // 選択項目のバリデーション (非空かつ未知の値はエラー。空は既定値補完)
    if (!isKnownDevMethod(p.devMethod)) {
      errors.push(makeError('project', ref, p.origin, 'devMethod',
        `開発方式「${str(p.devMethod)}」は選択肢にありません。スクラッチ開発 / ローコード・ノーコード開発 / パッケージ開発 / そのほか のいずれかを入力するか、空欄にしてください。`));
    }
    if (!isKnownContractType(p.contractType)) {
      errors.push(makeError('project', ref, p.origin, 'contractType',
        `契約形態「${str(p.contractType)}」は選択肢にありません。準委任 / 請負 / SES / そのほか のいずれかを入力するか、空欄にしてください。`));
    }
    if (!isKnownProjectStatus(p.status)) {
      errors.push(makeError('project', ref, p.origin, 'status',
        `ステータス「${str(p.status)}」は選択肢にありません。企画中 / 見積中 / 計画中 / 実行中 / クローズ のいずれかを入力するか、空欄にしてください。`));
    }

    // A群ハード必須テキスト
    const purpose = str(p.purpose);
    const background = str(p.background);
    const scope = str(p.scope);
    for (const [field, val] of [['purpose', purpose], ['background', background], ['scope', scope]] as const) {
      if (val === '') {
        errors.push(makeError('project', ref, p.origin, field,
          `${getImportFieldLabel('project', field)}が空です。値を入力するか、マッピング画面で「既定値」を設定してください。`));
      }
    }

    // 必須日付の正規化
    const plannedStartDate = resolveRequiredDate(p.plannedStartDate, 'project', ref, p.origin, 'plannedStartDate', errors);
    const plannedEndDate = resolveRequiredDate(p.plannedEndDate, 'project', ref, p.origin, 'plannedEndDate', errors);

    const project = resolveProjectBody(p, name, customerKey, existingCustomerId, purpose, background, scope, plannedStartDate, plannedEndDate, errors, ref);
    wbsCount += project.wbs.length;
    riskCount += project.risks.length;
    knowledgeCount += project.knowledge.length;
    retroCount += project.retros.length;
    resolvedProjects.push(project);
  }

  // ---- バッチ外 WBS (既存プロジェクトに projectName で紐づく) ----
  const externalWbs: ResolvedExternalWbs[] = [];
  for (const g of batch.externalWbs) {
    const rows = resolveWbsRows(g.rows, g.projectName, g.origin, errors);
    const pdef = str(g.projectNameDefault);
    // projectName → 既定値 の順に既存プロジェクトで解決
    const projectId =
      existing.projects.get(normalizeName(g.projectName))
      ?? (pdef !== '' ? existing.projects.get(normalizeName(pdef)) : undefined);
    if (projectId == null) {
      const shown = g.projectName !== '' ? g.projectName : pdef;
      errors.push(makeError('wbs', shown, g.origin, 'projectName',
        `プロジェクト「${shown}」が見つかりません。既存のプロジェクト一覧にあるか、プロジェクト CSV に同じ名前の行を入れてください。`));
      continue;
    }
    externalWbs.push({ projectId, projectName: g.projectName, rows });
    wbsCount += rows.length;
  }

  // ---- WBS レベル不正 (CSV パースで確定済) を errors に合流 ----
  for (const le of batch.wbsLevelErrors ?? []) {
    errors.push(makeError('wbs', le.projectName, le.origin, 'level',
      `レベル「${le.rawLevel}」は数字ではありません。階層の深さを半角数字 (1=最上位、2=その子…) で入力してください。`));
  }

  // ---- WBS 予定工数(人時) 不正 (CSV パースで確定済) を errors に合流 ----
  for (const ee of batch.wbsEffortErrors ?? []) {
    errors.push(makeError('wbs', ee.projectName, ee.origin, 'plannedEffort',
      `予定工数(人時)「${ee.rawEffort}」は小数第一位までの数値ではありません。0 以上の半角数値で、小数は第一位まで (例: 8 または 8.5) で入力してください。`));
  }

  // ---- プルダウン選択肢外 / 日付書式不正 (CSV パースで確定済・reason 生成済) を errors に合流 ----
  for (const ve of batch.valueErrors ?? []) {
    errors.push(makeError(ve.entity, ve.ref, ve.origin, ve.field, ve.reason));
  }

  // ---- バッチ外の資産 (standalone or 既存プロジェクト紐づけ) ----
  // プロジェクト未紐づけ (projectId=null) かつ 公開範囲=下書き は、取り込み後どの一覧にも
  // 表示されない「不可視データ」になるためエラー化する (横断一覧は public のみ表示、
  // プロジェクト個別一覧は紐づけ必須。= 「取り込める=画面で見られる」を保証)。
  const externalRisks = (batch.externalRisks ?? []).map((a) => {
    const projectId = resolveAssetProjectId(a, existing, 'リスク・課題', warnings);
    const data = resolveRiskValue(a.data);
    if (projectId === null && data.visibility === 'draft') {
      errors.push(makeInvisibleDraftError('risk', str(a.data.title) || '(件名なし)', a.origin, 'リスク・課題'));
    }
    return { projectId, data };
  });
  const externalKnowledge = (batch.externalKnowledge ?? []).map((a) => {
    const projectId = resolveAssetProjectId(a, existing, 'ナレッジ', warnings);
    const data = resolveKnowledgeValue(a.data);
    if (projectId === null && data.visibility === 'draft') {
      errors.push(makeInvisibleDraftError('knowledge', str(a.data.title) || '(タイトルなし)', a.origin, 'ナレッジ'));
    }
    return { projectId, data };
  });
  const externalRetros = (batch.externalRetros ?? []).map((a) => {
    const projectId = resolveAssetProjectId(a, existing, '振り返り', warnings);
    const data = resolveRetroValue(a.data);
    if (projectId === null && data.visibility === 'draft') {
      errors.push(makeInvisibleDraftError('retrospective', str(a.data.conductedDate) || '振り返り', a.origin, '振り返り'));
    }
    return { projectId, data };
  });
  riskCount += externalRisks.length;
  knowledgeCount += externalKnowledge.length;
  retroCount += externalRetros.length;

  return {
    resolved: {
      customers: resolvedCustomers,
      projects: resolvedProjects,
      externalWbs,
      externalRisks,
      externalKnowledge,
      externalRetros,
    },
    errors,
    warnings,
    summary: {
      customers: resolvedCustomers.length,
      projects: resolvedProjects.length,
      wbs: wbsCount,
      risks: riskCount,
      knowledge: knowledgeCount,
      retrospectives: retroCount,
      errorCount: errors.length,
    },
  };
}

/**
 * CSV選択段階の軽量リンクチェック。顧客/プロジェクトの未解決を「警告」で返す
 * (マッピング画面の「既定値」で補えるためエラーにしない)。プレビューでは同条件がエラーになる。
 */
export function checkLinkWarnings(batch: NormalizedBatch, existing: ExistingDataIndex): string[] {
  const result: string[] = [];
  const customerKeys = new Set(batch.customers.map((c) => c.sourceKey));
  for (const p of batch.projects) {
    const cref = str(p.customerRef);
    if (cref === '') continue; // 未指定はプレビューの必須エラーで扱う (ここでは警告しない)
    if (resolveCustomerName(p.customerRef, customerKeys, existing)) continue;
    if (resolveCustomerName(p.customerRefDefault, customerKeys, existing)) continue; // 既定値で解決
    result.push(`プロジェクト「${str(p.name)}」の顧客「${cref}」が、既存の顧客にも取り込む顧客CSVにも見つかりません。マッピング画面で「既定値」に既存の顧客名を設定するか、顧客CSVに追加してください。`);
  }
  for (const g of batch.externalWbs) {
    if (existing.projects.has(normalizeName(g.projectName))) continue;
    const pdef = str(g.projectNameDefault);
    if (pdef !== '' && existing.projects.has(normalizeName(pdef))) continue; // 既定値で解決
    result.push(`タスク（WBS）の所属プロジェクト「${g.projectName}」が、既存のプロジェクトにも取り込むプロジェクトCSVにも見つかりません。マッピング画面で「既定値」に既存のプロジェクト名を設定するか、プロジェクトCSVに追加してください。`);
  }
  return result;
}

/**
 * 日付を YYYY-MM-DD へ正規化する。YYYY-MM-DD / YYYY/MM/DD (Excel 既定) や年先頭の一般的な
 * 書式を受理し YYYY-MM-DD を返す。月日が先頭の曖昧な書式・非実在日 (2026-02-30 等) は null。
 */
function parseImportDate(s: string): string | null {
  return normalizeDate(s.trim());
}

function resolveRequiredDate(
  raw: string | null | undefined,
  entity: ImportEntityKind,
  ref: string,
  origin: SourceOrigin | undefined,
  field: string,
  errors: PreviewError[],
): string | null {
  const label = getImportFieldLabel(entity, field);
  const s = str(raw);
  if (s === '') {
    errors.push(makeError(entity, ref, origin, field, `${label}が空です。必須項目です。YYYY-MM-DD または YYYY/MM/DD (例: 2026/06/01) で入力するか「既定値」を設定してください。`));
    return null;
  }
  const normalized = parseImportDate(s);
  if (normalized == null) {
    errors.push(makeError(entity, ref, origin, field, `${label}「${s}」を日付として認識できません。YYYY-MM-DD または YYYY/MM/DD（年→月→日の順、例: 2026/06/01）で入力してください。`));
    return null;
  }
  return normalized;
}

/** WBS の任意日付 (ACT のみ)。空は null、非空は日付として正規化 (YYYY/MM/DD 等も受理)。 */
function resolveWbsDate(
  raw: string | null | undefined,
  refPrefix: string,
  sourceId: string,
  origin: SourceOrigin | undefined,
  field: string,
  errors: PreviewError[],
): string | null {
  const s = str(raw);
  if (s === '') return null;
  const d = parseImportDate(s);
  if (d == null) {
    errors.push(makeError('wbs', `${refPrefix}/${sourceId}`, origin, field,
      `${getImportFieldLabel('wbs', field)}「${s}」を日付として認識できません。YYYY-MM-DD または YYYY/MM/DD（例: 2026/06/01）で入力してください。`));
    return null;
  }
  return d;
}

/** WBS 行の検証 (名称必須) + 日付正規化。バッチ内 WBS / バッチ外 WBS で共通。 */
function resolveWbsRows(
  rows: WbsRow[],
  refPrefix: string,
  origin: SourceOrigin | undefined,
  errors: PreviewError[],
): WbsRow[] {
  return rows.map((row) => {
    if (str(row.name) === '') {
      errors.push(makeError('wbs', `${refPrefix}/${row.sourceId}`, origin, 'name', 'タスク名が空です。値を入力してください。'));
    }
    return {
      ...row,
      name: str(row.name),
      plannedStartDate: resolveWbsDate(row.plannedStartDate, refPrefix, row.sourceId, origin, 'plannedStartDate', errors),
      plannedEndDate: resolveWbsDate(row.plannedEndDate, refPrefix, row.sourceId, origin, 'plannedEndDate', errors),
    };
  });
}

function resolveProjectBody(
  p: NormalizedProject,
  name: string,
  customerKey: string | null,
  existingCustomerId: string | null,
  purpose: string,
  background: string,
  scope: string,
  plannedStartDate: string | null,
  plannedEndDate: string | null,
  errors: PreviewError[],
  ref: string,
): ResolvedProject {
  // WBS: 名称必須 + 日付正規化 (バッチ内 WBS は origin 不明のため undefined)
  const wbs: WbsRow[] = resolveWbsRows(p.wbs, ref, undefined, errors);

  // リスク・課題 / ナレッジ / 振り返り (B群: 下書きなら空OK)。値解決は共通ヘルパへ集約。
  const risks = p.risks.map(resolveRiskValue);
  const knowledge = p.knowledge.map(resolveKnowledgeValue);
  const retros = p.retros.map(resolveRetroValue);

  return {
    sourceKey: p.sourceKey,
    customerKey,
    existingCustomerId,
    name,
    purpose,
    background,
    scope,
    devMethod: resolveDevMethod(p.devMethod),
    contractType: resolveContractType(p.contractType),
    status: resolveProjectStatus(p.status),
    plannedStartDate,
    plannedEndDate,
    wbs,
    risks,
    knowledge,
    retros,
  };
}

/** リスク・課題の値解決 (nested / external 共通)。 */
function resolveRiskValue(r: NormalizedRiskIssue): ResolvedRiskIssue {
  return {
    type: r.type === 'risk' ? 'risk' : 'issue',
    title: str(r.title),
    occurrence: orNull(r.occurrence),
    content: str(r.content),
    cause: orNull(r.cause),
    impact: resolveImpact(r.impact),
    likelihood: resolveLikelihood(r.likelihood),
    responsePolicy: orNull(r.responsePolicy),
    deadline: r.deadline ? normalizeDate(r.deadline) : null,
    riskNature: r.type === 'risk' ? resolveRiskNature(r.riskNature) : null,
    visibility: resolveVisibility(r.visibility),
  };
}

/** ナレッジの値解決。 */
function resolveKnowledgeValue(k: NormalizedKnowledge): ResolvedKnowledge {
  return {
    title: str(k.title),
    knowledgeType: resolveKnowledgeType(k.knowledgeType),
    background: str(k.background),
    content: str(k.content),
    result: str(k.result),
    visibility: resolveVisibility(k.visibility),
  };
}

/** 振り返りの値解決。実施日は空なら apply 側で当日補完するため null 許容。 */
function resolveRetroValue(rt: NormalizedRetrospective): ResolvedRetrospective {
  return {
    conductedDate: rt.conductedDate ? normalizeDate(rt.conductedDate) : null,
    planSummary: str(rt.planSummary),
    actualSummary: str(rt.actualSummary),
    goodPoints: str(rt.goodPoints),
    problems: str(rt.problems),
    improvements: str(rt.improvements),
    visibility: resolveVisibility(rt.visibility),
  };
}

/**
 * external 資産 (バッチにプロジェクトが無いリスク・課題/ナレッジ/振り返り) の所属プロジェクトを解決する。
 *   - projectName 空 → standalone (projectId=null)。
 *   - 非空 → 既存プロジェクト → 既定値の順で照合。見つからなければ standalone + 警告 (B群は止めない)。
 */
function resolveAssetProjectId(
  asset: ExternalAsset<unknown>,
  existing: ExistingDataIndex,
  label: string,
  warnings: string[],
): string | null {
  const pn = str(asset.projectName);
  if (pn === '') return null; // standalone
  const pid =
    existing.projects.get(normalizeName(pn))
    ?? (str(asset.projectNameDefault) !== '' ? existing.projects.get(normalizeName(str(asset.projectNameDefault))) : undefined);
  if (pid != null) return pid;
  warnings.push(`${label}の所属プロジェクト「${pn}」が見つからないため、プロジェクトに紐づけずに取り込みます。`);
  return null;
}
