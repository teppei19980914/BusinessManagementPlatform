/**
 * 提案型サービス (PR #65 核心機能) のための類似度計算ユーティリティ。
 *
 * 本モジュールはドメイン依存のない純粋関数だけを置き、テストしやすくする。
 * pg_trgm によるテキスト類似度は DB 側で計算するため、ここには含まない。
 */

/**
 * タグセット同士の Jaccard 係数 (0〜1) を返す。
 *
 * - 2 つのタグ配列を set に変換し、共通数 / 和集合数 で算出する。
 * - 大文字小文字は区別しない (ユーザが "React" と "react" を書き分けても同義とみなす)。
 * - 両方が空なら 0 を返す (未入力プロジェクトは推薦対象から外すため)。
 *
 * @example jaccard(['a','b'], ['b','c']) === 1/3
 */
export function jaccard(a: readonly string[], b: readonly string[]): number {
  const setA = new Set(a.map((t) => t.trim().toLowerCase()).filter(Boolean));
  const setB = new Set(b.map((t) => t.trim().toLowerCase()).filter(Boolean));
  if (setA.size === 0 && setB.size === 0) return 0;

  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Project の全タグ (businessDomain + techStack + process) を 1 つの配列に統合する。
 * 提案の際は業務/技術/工程を区別せず 1 つの意味空間として扱う。
 */
export function unifyProjectTags(project: {
  businessDomainTags: readonly string[];
  techStackTags: readonly string[];
  processTags: readonly string[];
}): string[] {
  return [
    ...project.businessDomainTags,
    ...project.techStackTags,
    ...project.processTags,
  ];
}

/**
 * Knowledge の全タグ (tech + process + businessDomain) を 1 つの配列に統合する。
 * PR #65 Phase 2 (b): businessDomainTags を Knowledge 側にも追加し Project と対称化。
 */
export function unifyKnowledgeTags(knowledge: {
  techTags: readonly string[];
  processTags: readonly string[];
  businessDomainTags: readonly string[];
}): string[] {
  return [
    ...knowledge.techTags,
    ...knowledge.processTags,
    ...knowledge.businessDomainTags,
  ];
}

/**
 * 複数の類似度スコアを重み付き平均で 1 つの総合スコアに統合する。
 *
 * 重みは呼び出し側で調整できるようにし、
 * 「タグ重視」「テキスト重視」の運用ポリシー変更に対応する。
 *
 * @example combineScores([{ score: 0.8, weight: 0.5 }, { score: 0.4, weight: 0.5 }]) === 0.6
 */
export function combineScores(
  parts: readonly { score: number; weight: number }[],
): number {
  let sumW = 0;
  let sumSW = 0;
  for (const p of parts) {
    if (p.weight <= 0) continue;
    sumW += p.weight;
    sumSW += p.score * p.weight;
  }
  return sumW === 0 ? 0 : sumSW / sumW;
}
