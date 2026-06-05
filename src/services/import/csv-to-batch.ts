/**
 * 外部移行インポート — 手動CSV → NormalizedBatch (ADR-0034)
 *
 * 手動CSV経路。エンティティごとの CSV (ヘッダ + 行) とマッピング (たすきばフィールド → CSV列 or 固定値)
 * を受け取り、共通中間形式 NormalizedBatch を組み立てる **純関数**。
 *
 *   - 親参照は「名前」で行う (自己完結バッチ): プロジェクトは customerName で顧客に、
 *     WBS/各資産は projectName でプロジェクトに紐づく。
 *   - WBS は「レベル列」方式 (各行に level)。level スタックで親子を復元し WP/ACT は構造判定。
 *   - 固定値 (fixed) はマッピングの「既定値」。列が空のときに採用 (ADR-0034 のマッピング3択)。
 */

import { convertToWbsRows, type SourceWbsNode } from './wbs-hierarchy';
import { normalizeDate } from './date-normalize';
import {
  isKnownDevMethod,
  isKnownContractType,
  isKnownProjectStatus,
  isKnownVisibility,
  isKnownImpact,
  isKnownRiskNature,
  isKnownRiskType,
  isKnownKnowledgeType,
  resolveRiskType,
} from './value-mapping';
import { getImportFieldLabel } from './import-field-catalog';
import {
  VISIBILITIES,
  IMPACT_LEVELS,
  RISK_NATURES,
  RISK_ISSUE_TYPES,
  KNOWLEDGE_TYPES,
} from '@/config/master-data';
import {
  emptyBatch,
  type NormalizedBatch,
  type NormalizedProject,
  type NormalizedRiskIssue,
  type NormalizedKnowledge,
  type NormalizedRetrospective,
  type ImportEntityKind,
  type ImportValueError,
  type SourceOrigin,
} from './normalized-batch';

export type CsvRow = Record<string, string>;

/** フィールド → CSV列名 (列割当)。空文字 or 未設定 = 割当なし。 */
export type ColumnMap = Record<string, string>;
/** フィールド → 固定値 (既定値)。列が空のとき採用。 */
export type FixedMap = Record<string, string>;

export interface CsvEntitySource {
  entity: ImportEntityKind;
  rows: CsvRow[];
  columnMap: ColumnMap;
  fixedMap?: FixedMap;
  /** 取り込み元 CSV のファイル名 (エラーメッセージ用)。 */
  fileName?: string;
}

function makeGetter(row: CsvRow, columnMap: ColumnMap, fixedMap: FixedMap) {
  return (field: string): string => {
    const col = columnMap[field];
    const raw = col ? (row[col] ?? '') : '';
    const v = String(raw).trim();
    if (v !== '') return v;
    const fixed = fixedMap[field];
    return fixed != null ? String(fixed).trim() : '';
  };
}

/**
 * 選択項目・日付など「妥当性のある項目」用のゲッター。
 * CSV列の値が **有効** ならそれを優先。空 or **無効** なら既定値を採用する
 * (= 列に誤った値が入っていても既定値が考慮される。既定値も無効/空なら列値のまま返し、preview でエラー化)。
 */
function makeValidatedGetter(row: CsvRow, columnMap: ColumnMap, fixedMap: FixedMap) {
  return (field: string, isValid: (v: string) => boolean): string => {
    const col = columnMap[field];
    const colVal = col ? String(row[col] ?? '').trim() : '';
    const fixedRaw = fixedMap[field];
    const fixedVal = fixedRaw != null ? String(fixedRaw).trim() : '';
    if (colVal !== '' && isValid(colVal)) return colVal; // 有効な列値を最優先
    if (fixedVal !== '') return fixedVal; // 空 or 無効なら既定値
    return colVal; // 列値が無効で既定値も無い → そのまま (preview でエラー)
  };
}

/**
 * 「日付として認識できる実在日か」。YYYY-MM-DD だけでなく YYYY/MM/DD (Excel 既定) や
 * 年先頭の一般的な書式も受理 (normalizeDate が YYYY-MM-DD へ正規化)。月日が先頭の曖昧な
 * 書式 (06/01/2026 等) と実在しない日付は false (= 既定値へフォールバック / preview でエラー)。
 */
const isParseableDate = (v: string): boolean => normalizeDate(v.trim()) != null;

const nz = (s: string): string | null => (s === '' ? null : s);

/**
 * 予定工数(人時) の許容書式: 0 以上・小数第一位までの半角数値のみ (例: 8 / 8.5 / 0)。
 * 小数第二位以降・負数・非数値・指数表記は不可 (手動入力フォームの「小数第一位まで」と整合)。
 */
const EFFORT_FORMAT = /^\d+(\.\d)?$/;

/** master-data の {内部キー: 表示ラベル} から「ラベル1／ラベル2…」の選択肢文字列を作る。 */
function allowedLabels(map: Record<string, string>): string {
  return Object.values(map).join('／');
}

/**
 * 行単位の検証コンテキスト。プルダウン選択肢外・日付書式不正を batch.valueErrors に集約する。
 * (空欄は許容 = マッピング画面の既定値で補完できるため。非空かつ不正のみエラー化。)
 */
interface ValueErrorCtx {
  entity: ImportEntityKind;
  ref: string;
  origin: SourceOrigin;
  valueErrors: ImportValueError[];
}

/** プルダウン項目: 非空かつ選択肢外ならエラーを push (空は既定値補完に委ねる)。 */
function validatePulldown(
  ctx: ValueErrorCtx,
  field: string,
  rawValue: string,
  isKnown: (v: string) => boolean,
  allowedMap: Record<string, string>,
): void {
  const v = rawValue.trim();
  if (v === '' || isKnown(v)) return;
  const label = getImportFieldLabel(ctx.entity, field);
  ctx.valueErrors.push({
    entity: ctx.entity,
    ref: ctx.ref,
    field,
    origin: ctx.origin,
    reason: `${label}「${v}」は選択肢にありません。${allowedLabels(allowedMap)} のいずれかを入力するか、空欄にしてください。`,
  });
}

/** 日付項目: 非空かつ日付として認識できる実在日でなければエラーを push (空は許容)。 */
function validateDate(ctx: ValueErrorCtx, field: string, rawValue: string): void {
  const v = rawValue.trim();
  if (v === '' || isParseableDate(v)) return;
  const label = getImportFieldLabel(ctx.entity, field);
  ctx.valueErrors.push({
    entity: ctx.entity,
    ref: ctx.ref,
    field,
    origin: ctx.origin,
    reason: `${label}「${v}」を日付として認識できません。YYYY-MM-DD または YYYY/MM/DD（年→月→日の順、例: 2026/06/01）で入力してください。`,
  });
}

/**
 * 複数エンティティの CSV ソースを 1 つの NormalizedBatch に組み立てる。
 */
export function buildBatchFromCsv(sources: CsvEntitySource[]): NormalizedBatch {
  const batch = emptyBatch('csv');

  // プロジェクト名 → NormalizedProject (WBS/資産の紐づけ先)
  const projectByName = new Map<string, NormalizedProject>();
  // プロジェクト名 → WBS の SourceWbsNode 蓄積 (後でまとめて階層変換)
  const wbsNodesByProject = new Map<string, SourceWbsNode[]>();

  const ensureProject = (name: string): NormalizedProject | null => {
    const key = name.trim();
    if (key === '') return null;
    return projectByName.get(key) ?? null;
  };

  // ---- 1) 顧客 ----
  for (const src of sources.filter((s) => s.entity === 'customer')) {
    const fixedMap = src.fixedMap ?? {};
    src.rows.forEach((row, i) => {
      const get = makeGetter(row, src.columnMap, fixedMap);
      const name = get('name');
      if (name === '') return; // 名前なしは無視 (preview で件数に出ないだけ)
      batch.customers.push({
        sourceKey: name,
        name,
        department: nz(get('department')),
        contactPerson: nz(get('contactPerson')),
        contactEmail: nz(get('contactEmail')),
        notes: nz(get('notes')),
        origin: { file: src.fileName, row: i + 1 },
      });
    });
  }

  // ---- 2) プロジェクト ----
  for (const src of sources.filter((s) => s.entity === 'project')) {
    const fixedMap = src.fixedMap ?? {};
    src.rows.forEach((row, i) => {
      const get = makeGetter(row, src.columnMap, fixedMap);
      const getValid = makeValidatedGetter(row, src.columnMap, fixedMap);
      const name = get('name');
      if (name === '') return;
      const project: NormalizedProject = {
        sourceKey: name,
        customerRef: nz(get('customerName')),
        customerRefDefault: nz(fixedMap['customerName'] != null ? String(fixedMap['customerName']).trim() : ''),
        name,
        purpose: get('purpose'),
        background: get('background'),
        scope: get('scope'),
        // 選択項目・日付は「列値が無効なら既定値」を考慮 (makeValidatedGetter)
        devMethod: getValid('devMethod', isKnownDevMethod),
        contractType: nz(getValid('contractType', isKnownContractType)),
        status: getValid('status', isKnownProjectStatus),
        plannedStartDate: nz(getValid('plannedStartDate', isParseableDate)),
        plannedEndDate: nz(getValid('plannedEndDate', isParseableDate)),
        wbs: [],
        risks: [],
        knowledge: [],
        retros: [],
        origin: { file: src.fileName, row: i + 1 },
      };
      projectByName.set(name, project);
      batch.projects.push(project);
    });
  }

  // ---- 3) WBS (レベル列 → 親子復元) ----
  // プロジェクト名 → 代表 origin (最初の行。バッチ外 WBS のエラー表示用)
  const wbsOriginByProject = new Map<string, { file?: string; row?: number }>();
  // WBS の「プロジェクト名」既定値 (未解決時のフォールバック。複数ソースなら先勝ち)
  let wbsProjectNameDefault: string | null = null;
  for (const src of sources.filter((s) => s.entity === 'wbs')) {
    const fixedMap = src.fixedMap ?? {};
    const pnDefault = fixedMap['projectName'] != null ? String(fixedMap['projectName']).trim() : '';
    if (pnDefault !== '' && wbsProjectNameDefault == null) wbsProjectNameDefault = pnDefault;
    // level スタックで synthetic な親子 ID を作る (プロジェクトごと)
    const stackByProject = new Map<string, string[]>();
    src.rows.forEach((row, i) => {
      const get = makeGetter(row, src.columnMap, fixedMap);
      const projectName = get('projectName');
      const name = get('name');
      if (projectName === '' || name === '') return;
      if (!wbsOriginByProject.has(projectName)) {
        wbsOriginByProject.set(projectName, { file: src.fileName, row: i + 1 });
      }
      // レベルは「半角数字 (1 以上)」必須。空・非数字は階層を組めないためエラー化してスキップ。
      const levelStr = get('level').trim();
      if (!/^\d+$/.test(levelStr) || parseInt(levelStr, 10) < 1) {
        batch.wbsLevelErrors.push({
          projectName,
          origin: { file: src.fileName, row: i + 1 },
          rawLevel: get('level'),
        });
        return;
      }
      const level = parseInt(levelStr, 10);

      const sourceId = `${projectName}#${i}`;
      const stack = stackByProject.get(projectName) ?? [];
      const parentSourceId = level > 1 ? (stack[level - 2] ?? null) : null;
      stack[level - 1] = sourceId;
      stack.length = level;
      stackByProject.set(projectName, stack);

      // 予定工数(人時): 非空かつ書式不正 (小数第二位以降・負数・非数値) はエラー化。
      // 行は階層維持のため残し、工数は null にする (プレビューで errors に合流 → 取り込み不可)。
      const effortStr = get('plannedEffort');
      let plannedEffort: number | null = null;
      if (effortStr !== '') {
        if (EFFORT_FORMAT.test(effortStr)) {
          plannedEffort = Number(effortStr);
        } else {
          batch.wbsEffortErrors.push({
            projectName,
            origin: { file: src.fileName, row: i + 1 },
            rawEffort: effortStr,
          });
        }
      }

      const nodes = wbsNodesByProject.get(projectName) ?? [];
      nodes.push({
        sourceId,
        parentSourceId,
        name,
        plannedStartDate: nz(get('plannedStartDate')),
        plannedEndDate: nz(get('plannedEndDate')),
        plannedEffort,
      });
      wbsNodesByProject.set(projectName, nodes);
    });
  }

  // WBS を階層変換。バッチ内プロジェクトには格納、無ければ externalWbs へ退避
  // (既存プロジェクトに紐づく可能性をプレビューで照合する)。
  for (const [projectName, nodes] of wbsNodesByProject) {
    const { rows, warnings } = convertToWbsRows(nodes);
    batch.warnings.push(...warnings);
    const project = ensureProject(projectName);
    if (project) {
      project.wbs.push(...rows);
    } else {
      batch.externalWbs.push({
        projectName,
        projectNameDefault: wbsProjectNameDefault,
        origin: wbsOriginByProject.get(projectName),
        rows,
      });
    }
  }

  // ---- 4) 各資産 ----
  // バッチ内プロジェクトに紐づくものは nested、無いものは external バケットへ
  // (空=standalone / 非空=既存プロジェクトに名前照合。プレビューで解決)。
  for (const src of sources) {
    if (src.entity === 'risk' || src.entity === 'knowledge' || src.entity === 'retrospective') {
      const fixedMap = src.fixedMap ?? {};
      const pnDefault = fixedMap['projectName'] != null ? String(fixedMap['projectName']).trim() : '';
      src.rows.forEach((row, i) => {
        const get = makeGetter(row, src.columnMap, fixedMap);
        const getValid = makeValidatedGetter(row, src.columnMap, fixedMap);
        const projectName = get('projectName');
        const origin = { file: src.fileName, row: i + 1 };
        const ref =
          src.entity === 'retrospective'
            ? (get('conductedDate') || '振り返り')
            : (get('title') || '(件名なし)');
        const ctx: ValueErrorCtx = { entity: src.entity, ref, origin, valueErrors: batch.valueErrors };
        const project = projectName !== '' ? ensureProject(projectName) : null;
        if (project) {
          // 同バッチのプロジェクトに紐づける
          if (src.entity === 'risk') project.risks.push({ ...buildRisk(get, getValid, ctx), origin });
          else if (src.entity === 'knowledge') project.knowledge.push({ ...buildKnowledge(get, getValid, ctx), origin });
          else project.retros.push({ ...buildRetro(get, getValid, ctx), origin });
        } else {
          // バッチに無い → external (空=standalone / 非空=既存照合)
          const common = { projectName, projectNameDefault: pnDefault || null, origin };
          if (src.entity === 'risk') batch.externalRisks.push({ ...common, data: buildRisk(get, getValid, ctx) });
          else if (src.entity === 'knowledge') batch.externalKnowledge.push({ ...common, data: buildKnowledge(get, getValid, ctx) });
          else batch.externalRetros.push({ ...common, data: buildRetro(get, getValid, ctx) });
        }
      });
    }
  }

  return batch;
}

type Getter = (f: string) => string;
type ValidatedGetter = (f: string, isValid: (v: string) => boolean) => string;

function buildRisk(get: Getter, getValid: ValidatedGetter, ctx: ValueErrorCtx): NormalizedRiskIssue {
  // 種別を先に解決して使う列を決める (リスク=影響度/発生可能性, 課題=重要度/緊急度。DB 列は同一)。
  const typeRaw = getValid('type', isKnownRiskType);
  const type = resolveRiskType(typeRaw); // 'risk' | 'issue'
  const impactField = type === 'risk' ? 'impact' : 'importance';
  const likelihoodField = type === 'risk' ? 'likelihood' : 'urgency';
  const impactRaw = getValid(impactField, isKnownImpact);
  const likelihoodRaw = getValid(likelihoodField, isKnownImpact);
  const riskNatureRaw = getValid('riskNature', isKnownRiskNature);
  const visibility = getValid('visibility', isKnownVisibility);
  const deadlineRaw = getValid('deadline', isParseableDate);

  // 検証 (非空かつ不正のみエラー化。空はプレビューで既定値補完)
  validatePulldown(ctx, 'type', typeRaw, isKnownRiskType, RISK_ISSUE_TYPES);
  validatePulldown(ctx, impactField, impactRaw, isKnownImpact, IMPACT_LEVELS);
  validatePulldown(ctx, likelihoodField, likelihoodRaw, isKnownImpact, IMPACT_LEVELS);
  validatePulldown(ctx, 'visibility', visibility, isKnownVisibility, VISIBILITIES);
  if (type === 'risk') validatePulldown(ctx, 'riskNature', riskNatureRaw, isKnownRiskNature, RISK_NATURES);
  validateDate(ctx, 'deadline', deadlineRaw);

  return {
    type,
    title: get('title'),
    occurrence: nz(get('occurrence')),
    content: nz(get('content')),
    cause: nz(get('cause')),
    impact: impactRaw,
    likelihood: nz(likelihoodRaw),
    responsePolicy: nz(get('responsePolicy')),
    deadline: nz(deadlineRaw),
    riskNature: nz(riskNatureRaw),
    visibility,
  };
}

function buildKnowledge(get: Getter, getValid: ValidatedGetter, ctx: ValueErrorCtx): NormalizedKnowledge {
  const knowledgeType = getValid('knowledgeType', isKnownKnowledgeType);
  const visibility = getValid('visibility', isKnownVisibility);
  validatePulldown(ctx, 'knowledgeType', knowledgeType, isKnownKnowledgeType, KNOWLEDGE_TYPES);
  validatePulldown(ctx, 'visibility', visibility, isKnownVisibility, VISIBILITIES);
  return {
    title: get('title'),
    knowledgeType,
    background: nz(get('background')),
    content: nz(get('content')),
    result: nz(get('result')),
    visibility,
  };
}

function buildRetro(get: Getter, getValid: ValidatedGetter, ctx: ValueErrorCtx): NormalizedRetrospective {
  const visibility = getValid('visibility', isKnownVisibility);
  const conductedDateRaw = getValid('conductedDate', isParseableDate);
  validatePulldown(ctx, 'visibility', visibility, isKnownVisibility, VISIBILITIES);
  validateDate(ctx, 'conductedDate', conductedDateRaw);
  return {
    conductedDate: nz(conductedDateRaw),
    planSummary: nz(get('planSummary')),
    actualSummary: nz(get('actualSummary')),
    goodPoints: nz(get('goodPoints')),
    problems: nz(get('problems')),
    improvements: nz(get('improvements')),
    visibility,
  };
}
