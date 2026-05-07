/**
 * scripts/check-seed-length.ts (PR-X5)
 *
 * SEED_KNOWLEDGE / SAMPLE_ISSUES / SAMPLE_RETROSPECTIVES / SAMPLE_PROJECTS の
 * 各 entry の文字数を集計し、拡充状況を可視化する。
 *
 * 目標: 各 entry 1000-2000 字 (embedding 軸の意味類似度向上のため)
 *
 * 使い方:
 *   pnpm tsx scripts/check-seed-length.ts
 */

import {
  SEED_KNOWLEDGE,
  SAMPLE_PROJECTS,
  SAMPLE_ISSUES,
  SAMPLE_RETROSPECTIVES,
} from '../prisma/seed-suggestion';

function knowledgeLength(k: (typeof SEED_KNOWLEDGE)[number]): number {
  return (
    k.title.length +
    k.background.length +
    k.content.length +
    k.result.length +
    (k.conclusion?.length ?? 0) +
    (k.recommendation?.length ?? 0)
  );
}

function projectLength(p: (typeof SAMPLE_PROJECTS)[number]): number {
  return (
    p.name.length +
    p.purpose.length +
    p.background.length +
    p.scope.length +
    (p.outOfScope?.length ?? 0)
  );
}

function issueLength(i: (typeof SAMPLE_ISSUES)[number]): number {
  return (
    i.title.length +
    i.content.length +
    (i.cause?.length ?? 0) +
    (i.responsePolicy?.length ?? 0) +
    (i.responseDetail?.length ?? 0) +
    (i.result?.length ?? 0) +
    (i.lessonLearned?.length ?? 0)
  );
}

function retroLength(r: (typeof SAMPLE_RETROSPECTIVES)[number]): number {
  return (
    r.planSummary.length +
    r.actualSummary.length +
    r.goodPoints.length +
    r.problems.length +
    r.improvements.length +
    (r.knowledgeToShare?.length ?? 0)
  );
}

function categorize(len: number): string {
  if (len >= 1500) return '✅ 1500+';
  if (len >= 1000) return '○ 1000-1499';
  if (len >= 500) return '△ 500-999';
  return '✗ <500';
}

function summarize(name: string, lengths: number[]): void {
  const total = lengths.reduce((a, b) => a + b, 0);
  const avg = Math.round(total / lengths.length);
  const min = Math.min(...lengths);
  const max = Math.max(...lengths);
  const c1500 = lengths.filter((l) => l >= 1500).length;
  const c1000 = lengths.filter((l) => l >= 1000 && l < 1500).length;
  const c500 = lengths.filter((l) => l >= 500 && l < 1000).length;
  const cLow = lengths.filter((l) => l < 500).length;

  console.log(`\n=== ${name} (${lengths.length} 件) ===`);
  console.log(`  平均: ${avg} 字 / 最小: ${min} 字 / 最大: ${max} 字`);
  console.log(`  ✅ 1500+   : ${c1500} 件`);
  console.log(`  ○ 1000-1499: ${c1000} 件`);
  console.log(`  △ 500-999  : ${c500} 件`);
  console.log(`  ✗ <500     : ${cLow} 件`);
}

function listShortEntries(name: string, entries: { title: string; length: number }[]): void {
  const short = entries.filter((e) => e.length < 1000).sort((a, b) => a.length - b.length);
  if (short.length === 0) return;
  console.log(`\n=== ${name} 内の 1000 字未満 entries (${short.length} 件) ===`);
  for (const e of short) {
    console.log(`  ${categorize(e.length)} ${e.length} 字: ${e.title.slice(0, 50)}`);
  }
}

const knowledgeLengths = SEED_KNOWLEDGE.map((k) => ({ title: k.title, length: knowledgeLength(k) }));
const projectLengths = SAMPLE_PROJECTS.map((p) => ({ title: p.name, length: projectLength(p) }));
const issueLengths = SAMPLE_ISSUES.map((i) => ({ title: i.title, length: issueLength(i) }));
const retroLengths = SAMPLE_RETROSPECTIVES.map((r) => ({
  title: `${r.parentProjectName} (${r.conductedDate})`,
  length: retroLength(r),
}));

console.log('========================================');
console.log('  シードデータ 文字数チェック (PR-X5)');
console.log('========================================');

summarize('SEED_KNOWLEDGE', knowledgeLengths.map((e) => e.length));
summarize('SAMPLE_PROJECTS', projectLengths.map((e) => e.length));
summarize('SAMPLE_ISSUES', issueLengths.map((e) => e.length));
summarize('SAMPLE_RETROSPECTIVES', retroLengths.map((e) => e.length));

listShortEntries('SEED_KNOWLEDGE', knowledgeLengths);
listShortEntries('SAMPLE_PROJECTS', projectLengths);
listShortEntries('SAMPLE_ISSUES', issueLengths);
listShortEntries('SAMPLE_RETROSPECTIVES', retroLengths);
