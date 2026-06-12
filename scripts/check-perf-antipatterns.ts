/**
 * scripts/check-perf-antipatterns.ts (2026-06-09)
 *
 * 静的パフォーマンス・アンチパターン検査ツール。
 * feedback_perf_antipatterns memory / docs/knowledge の 5 観点を機械検査する。
 *
 * 設計方針:
 *   - grep ベースのヒューリスティック検査。完全な AST 解析ではないため
 *     「確実に怪しい箇所」を WARN として列挙し、人間/Claude の目視判断を促す。
 *   - 誤検知 (false positive) は許容する設計 (見逃しより指摘漏れを嫌う)。
 *     抑制したい箇所には行末に `// perf-ok: <理由>` を付けるとスキップする。
 *   - デフォルトは exit 0 (警告のみ)。`--strict` 指定時のみ WARN ありで exit 1。
 *     当面は CI を落とさず可視化に使い、運用が固まったら strict 化する想定。
 *
 * 検査する 5 観点 (grep で機械化できる範囲):
 *   1. 同一テーブルへの重複 findMany     — 同一ファイル内で同じ prisma.X.findMany が複数回
 *   2. 表示件数とクエリ limit の乖離       — take/limit と slice(0, N) の数値不一致 (同一ファイル)
 *   3. 再帰/大量リスト UI の memo 未適用    — 自己再帰 .map レンダリングで React.memo 不使用の疑い
 *   4. O(N×M) グリッドの背景 DOM          — ネストした .map 内での背景セル生成の疑い
 *   5. タブ/モーダル配下の eager fetch     — (AST 必須のため観点リマインドのみ出力)
 *
 * 使い方:
 *   pnpm tsx scripts/check-perf-antipatterns.ts            # 全 src を検査 (警告のみ)
 *   pnpm tsx scripts/check-perf-antipatterns.ts --strict   # WARN ありで exit 1
 *   pnpm tsx scripts/check-perf-antipatterns.ts <path...>   # 対象を限定 (差分ファイル検査向け)
 *
 * 関連:
 *   - feedback_perf_antipatterns (5 観点の出典)
 *   - docs/knowledge/KNW-002_performance-optimization-patterns.md
 *   - quality-check skill (本ツールを完了時チェックに統合)
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

type Finding = {
  file: string;
  line: number;
  rule: string;
  message: string;
};

const ROOT = process.cwd();
const SUPPRESS_MARKER = 'perf-ok:';

const args = process.argv.slice(2);
const strict = args.includes('--strict');
const explicitPaths = args.filter((a) => !a.startsWith('--'));

/** 検査対象の拡張子 */
const TARGET_EXT = /\.(ts|tsx)$/;
/** 除外パス (テスト・生成物・型定義) */
const EXCLUDE = /(\.test\.|\.spec\.|\/__tests__\/|\/generated\/|\.d\.ts$)/;

function collectFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === '.git') continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...collectFiles(full));
    } else if (TARGET_EXT.test(full) && !EXCLUDE.test(full.replace(/\\/g, '/'))) {
      out.push(full);
    }
  }
  return out;
}

function resolveTargets(): string[] {
  if (explicitPaths.length > 0) {
    return explicitPaths
      .map((p) => join(ROOT, p))
      .filter((p) => {
        try {
          return statSync(p).isFile() && TARGET_EXT.test(p) && !EXCLUDE.test(p.replace(/\\/g, '/'));
        } catch {
          return false;
        }
      });
  }
  return collectFiles(join(ROOT, 'src'));
}

function isSuppressed(line: string): boolean {
  return line.includes(SUPPRESS_MARKER);
}

/**
 * 観点 1: 同一 Promise.all ブロック内で同じテーブルへ findMany が複数回。
 * ファイル全体での出現回数だと別用途のクエリを誤検知するため、
 * 「Promise.all([ ... ]) の括弧内」に閉じた範囲でのみ重複を見る (実測の劣化原因がこの形)。
 */
function checkDuplicateFindMany(file: string, content: string, findings: Finding[]): void {
  // Promise.all( の出現位置から対応する括弧の終わりまでを 1 ブロックとして走査
  const re = /Promise\.all\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    // 括弧の対応を数えてブロック終端を求める
    let depth = 0;
    let i = m.index + m[0].length - 1; // '(' の位置
    const start = i;
    for (; i < content.length; i++) {
      if (content[i] === '(') depth++;
      else if (content[i] === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    const block = content.slice(start, i + 1);
    if (isSuppressed(block.split('\n')[0])) continue;
    const models = new Map<string, number>();
    for (const hit of block.matchAll(/(?:prisma|tx|db)\.(\w+)\.findMany/g)) {
      const model = hit[1];
      models.set(model, (models.get(model) ?? 0) + 1);
    }
    for (const [model, count] of models) {
      if (count >= 2) {
        const lineNo = content.slice(0, start).split(/\r?\n/).length;
        findings.push({
          file,
          line: lineNo,
          rule: '1:duplicate-findMany-in-promiseall',
          message: `Promise.all 内で同一テーブル '${model}' への findMany が ${count} 回。1 クエリに統合できないか確認 (例: listTasksWithTree)`,
        });
      }
    }
  }
}

/** 観点 2: take/limit 値と slice(0, N) 値の不一致 (同一ファイル内) */
function checkLimitSliceMismatch(file: string, lines: string[], findings: Finding[]): void {
  const takes: { line: number; n: number }[] = [];
  const slices: { line: number; n: number }[] = [];
  lines.forEach((line, idx) => {
    if (isSuppressed(line)) return;
    const t = line.match(/\b(?:take|limit)\s*[:=]\s*(\d+)/);
    if (t) takes.push({ line: idx + 1, n: Number(t[1]) });
    const s = line.match(/\.slice\(\s*0\s*,\s*(\d+)\s*\)/);
    if (s) slices.push({ line: idx + 1, n: Number(s[1]) });
  });
  // take と slice が両方存在し、値集合が一致しない場合のみ WARN
  if (takes.length > 0 && slices.length > 0) {
    const takeVals = new Set(takes.map((t) => t.n));
    for (const s of slices) {
      if (!takeVals.has(s.n)) {
        findings.push({
          file,
          line: s.line,
          rule: '2:limit-slice-mismatch',
          message: `slice(0, ${s.n}) が take/limit 値 {${[...takeVals].join(', ')}} と不一致。過剰取得の疑い`,
        });
      }
    }
  }
}

/**
 * 観点 3: 真の自己再帰コンポーネント (定義本体の内側で自分自身を JSX 呼出) が
 * React.memo 未適用の疑い。
 * 定義の開き波括弧〜対応する閉じ波括弧の範囲に限定して自己呼出を判定し、
 * 「同名がファイル内のどこかに出る」式の誤検知を排除する。
 */
function checkRecursiveMemo(file: string, content: string, findings: Finding[]): void {
  if (!file.endsWith('.tsx')) return;
  const hasMemoWrap = /(?:React\.)?memo\s*\(/.test(content);
  // function Comp(...) { ... } 形式の定義を対象 (アロー const は範囲特定が難しいため除外)
  const defRe = /function\s+([A-Z]\w+)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = defRe.exec(content)) !== null) {
    const comp = m[1];
    // 関数本体の波括弧範囲を求める
    let i = content.indexOf('{', m.index);
    if (i < 0) continue;
    let depth = 0;
    const bodyStart = i;
    for (; i < content.length; i++) {
      if (content[i] === '{') depth++;
      else if (content[i] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    const body = content.slice(bodyStart, i + 1);
    // 本体内で自分自身を JSX 要素として呼び出している (= 再帰描画)
    const selfJsx = new RegExp(`<${comp}[\\s/>]`).test(body);
    if (selfJsx && !hasMemoWrap) {
      const lineNo = content.slice(0, m.index).split(/\r?\n/).length;
      findings.push({
        file,
        line: lineNo,
        rule: '3:recursive-memo',
        message: `自己再帰コンポーネント '${comp}' が React.memo 未適用の疑い。props は参照安定にして memo 化 (例: TaskTreeNode)`,
      });
    }
  }
}

/** 観点 4: ネストした .map 内で背景/セル生成の疑い (O(N×M) DOM) */
function checkNestedMapBackground(file: string, lines: string[], findings: Finding[]): void {
  if (!file.endsWith('.tsx')) return;
  // 単純なヒューリスティック: 近接行 (10 行以内) に .map が 2 つネストし、内側付近に bg-/background/cell の語
  lines.forEach((line, idx) => {
    if (isSuppressed(line)) return;
    if (!/\.map\(/.test(line)) return;
    const window = lines.slice(idx + 1, idx + 12).join('\n');
    const innerMap = /\.map\(/.test(window);
    const bgHint = /(bg-|background|className=.*cell|weekend|holiday)/i.test(window);
    if (innerMap && bgHint) {
      findings.push({
        file,
        line: idx + 1,
        rule: '4:nested-map-background',
        message: `ネストした .map 内で背景/セル生成の疑い (O(N×M) DOM)。共通背景は行ループ外のオーバーレイに集約 (例: gantt-client)`,
      });
    }
  });
}

const targets = resolveTargets();
const findings: Finding[] = [];

for (const file of targets) {
  let content: string;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  const lines = content.split(/\r?\n/);
  checkDuplicateFindMany(file, content, findings);
  checkLimitSliceMismatch(file, lines, findings);
  checkRecursiveMemo(file, content, findings);
  checkNestedMapBackground(file, lines, findings);
}

// ---- 出力 ----
console.log('=== 静的パフォーマンス・アンチパターン検査 ===');
console.log(`対象ファイル: ${targets.length} 件\n`);

if (findings.length === 0) {
  console.log('[OK] grep 検査では疑わしい箇所は見つかりませんでした。');
} else {
  // ルール別にグループ化して出力
  const byRule = new Map<string, Finding[]>();
  for (const f of findings) {
    const arr = byRule.get(f.rule) ?? [];
    arr.push(f);
    byRule.set(f.rule, arr);
  }
  for (const [rule, list] of [...byRule.entries()].sort()) {
    console.log(`[WARN] ${rule} (${list.length} 件)`);
    for (const f of list) {
      console.log(`  ${relative(ROOT, f.file).replace(/\\/g, '/')}:${f.line}  ${f.message}`);
    }
    console.log('');
  }
  console.log(`合計 ${findings.length} 件の要確認箇所。誤検知は行末に "// ${SUPPRESS_MARKER} 理由" で抑制可。`);
}

// 観点 5 は AST 必須のため、リマインドとして常に表示
console.log('');
console.log('--- 観点 5 (grep 不可・要目視) ---');
console.log('  タブ/モーダル配下の eager fetch: 初回ロードで「切替後に表示する UI のデータ」まで');
console.log('  取得していないか。タブ/Dialog を追加・変更した際は必ず確認すること。');

if (strict && findings.length > 0) {
  console.log(`\n[strict] WARN が ${findings.length} 件あるため exit 1`);
  process.exit(1);
}
process.exit(0);
