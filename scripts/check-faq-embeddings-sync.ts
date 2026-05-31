/**
 * scripts/check-faq-embeddings-sync.ts (ADR-0028 / 2026-05-30)
 *
 * ★ たすきば存続の生命線 ★
 *   `src/config/faq-content.ts` (FAQ_ENTRIES) / `src/config/guide-content.ts`
 *   (GUIDE_STEPS) の追加・更新・削除を deploy 後の DB embedding 再生成
 *   (scripts/generate-faq-embeddings.ts) で反映する仕組みが破綻していないかを
 *   CI で検証する。
 *
 * 検証モード (環境による自動切替):
 *
 *   1. **structure mode** (DATABASE_URL なし、= CI のデフォルト):
 *      - FAQ_ENTRIES / GUIDE_STEPS の構造健全性のみ検証 (DB アクセスなし)
 *      - id 重複 / 必須フィールド欠落 / visibleTo 不正値を fail させる
 *      - 本 mode が PASS することは、generate-faq-embeddings.ts が安全に走る
 *        前提条件
 *
 *   2. **drift mode** (DATABASE_URL あり、= 本番/staging ローカル検証用):
 *      - generate-faq-embeddings.ts --dry-run を内部で呼出
 *      - DB と config の hash 比較で 1 件でも diff があれば fail
 *      - deploy SOP 漏れの検出に使用 (developer-guide §7 / DEPLOYMENT.md SOP)
 *
 * CI 配置:
 *   .github/workflows/ci.yml の lint/tsc/test と並列ジョブとして実行する想定。
 *   structure mode は DB 不要 = 1 秒以内、fail 時は config の構造異常で
 *   generate スクリプト破壊リスクを未然防止する。
 *
 * 関連:
 *   - scripts/generate-faq-embeddings.ts (本 script の検証対象)
 *   - docs/adr/0028-help-chat-rag-migration.md
 *   - docs/operations/develop/DEPLOYMENT.md (本 script の deploy 時運用 SOP)
 *   - feedback_drift_detection_design.md (4 層防御の 1 つとして機能)
 */

import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import { FAQ_ENTRIES, type FaqVisibleTo } from '../src/config/faq-content';
import { GUIDE_STEPS } from '../src/config/guide-content';
import {
  composeFaqContentText,
  composeGuideContentText,
  computeContentHash,
} from '../src/services/help-search.service';
import { MAX_INPUT_CHARS } from '../src/services/embedding.service';

const VALID_VISIBLE_TO: ReadonlySet<FaqVisibleTo> = new Set([
  'all',
  'tenant_admin',
  'project_pm',
]);

const VALID_AUDIENCES = new Set(['all', 'admin', 'pm', 'member']);

interface CheckError {
  category: 'structure' | 'drift';
  entryId: string;
  message: string;
}

function checkFaqStructure(): CheckError[] {
  const errors: CheckError[] = [];
  const seenIds = new Set<string>();

  for (const entry of FAQ_ENTRIES) {
    if (!entry.id || typeof entry.id !== 'string') {
      errors.push({ category: 'structure', entryId: '(unknown)', message: 'FAQ entry に id が欠落' });
      continue;
    }
    if (seenIds.has(entry.id)) {
      errors.push({ category: 'structure', entryId: entry.id, message: 'FAQ id が重複しています' });
    }
    seenIds.add(entry.id);

    if (!/^[a-z0-9-]+$/.test(entry.id)) {
      errors.push({ category: 'structure', entryId: entry.id, message: 'FAQ id は kebab-case (a-z0-9-) のみ許可' });
    }
    if (entry.id.length > 150) {
      errors.push({ category: 'structure', entryId: entry.id, message: `FAQ id が長すぎます (${entry.id.length} > 150)` });
    }
    if (!entry.q || entry.q.trim().length === 0) {
      errors.push({ category: 'structure', entryId: entry.id, message: 'FAQ q (質問) が空です' });
    }
    if (!entry.a || entry.a.trim().length === 0) {
      errors.push({ category: 'structure', entryId: entry.id, message: 'FAQ a (回答) が空です' });
    }
    if (!VALID_VISIBLE_TO.has(entry.visibleTo)) {
      errors.push({ category: 'structure', entryId: entry.id, message: `FAQ visibleTo が不正: ${entry.visibleTo}` });
    }
    if (!entry.category || entry.category.trim().length === 0) {
      errors.push({ category: 'structure', entryId: entry.id, message: 'FAQ category が空です' });
    }
    if (entry.category && entry.category.length > 50) {
      errors.push({ category: 'structure', entryId: entry.id, message: `FAQ category が長すぎます (${entry.category.length} > 50)` });
    }

    const composed = composeFaqContentText(entry);
    if (composed.length > MAX_INPUT_CHARS) {
      errors.push({
        category: 'structure',
        entryId: entry.id,
        message: `FAQ 本文が Voyage MAX_INPUT_CHARS (${MAX_INPUT_CHARS}) を超過: ${composed.length} 文字`,
      });
    }

    // hash 計算の sanity check (環境差で異常な hash が出るのを早期検知)
    const hash = computeContentHash(composed);
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      errors.push({ category: 'structure', entryId: entry.id, message: `FAQ content_hash 形式異常: ${hash}` });
    }
  }

  return errors;
}

function checkGuideStructure(): CheckError[] {
  const errors: CheckError[] = [];
  const seenIds = new Set<string>();

  for (const step of GUIDE_STEPS) {
    if (!step.id || typeof step.id !== 'string') {
      errors.push({ category: 'structure', entryId: '(unknown)', message: 'GuideStep に id が欠落' });
      continue;
    }
    if (seenIds.has(step.id)) {
      errors.push({ category: 'structure', entryId: step.id, message: 'GuideStep id が重複しています' });
    }
    seenIds.add(step.id);

    if (!/^[a-z0-9-]+$/.test(step.id)) {
      errors.push({ category: 'structure', entryId: step.id, message: 'GuideStep id は kebab-case (a-z0-9-) のみ許可' });
    }
    if (step.id.length > 150) {
      errors.push({ category: 'structure', entryId: step.id, message: `GuideStep id が長すぎます (${step.id.length} > 150)` });
    }
    if (!step.title || step.title.trim().length === 0) {
      errors.push({ category: 'structure', entryId: step.id, message: 'GuideStep title が空です' });
    }
    if (!step.body || step.body.trim().length === 0) {
      errors.push({ category: 'structure', entryId: step.id, message: 'GuideStep body が空です' });
    }
    if (!VALID_VISIBLE_TO.has(step.visibleTo)) {
      errors.push({ category: 'structure', entryId: step.id, message: `GuideStep visibleTo が不正: ${step.visibleTo}` });
    }
    if (!VALID_AUDIENCES.has(step.audience)) {
      errors.push({ category: 'structure', entryId: step.id, message: `GuideStep audience が不正: ${step.audience}` });
    }

    const composed = composeGuideContentText(step);
    if (composed.length > MAX_INPUT_CHARS) {
      errors.push({
        category: 'structure',
        entryId: step.id,
        message: `GuideStep 本文が Voyage MAX_INPUT_CHARS (${MAX_INPUT_CHARS}) を超過: ${composed.length} 文字`,
      });
    }
  }

  return errors;
}

function runDriftCheck(): CheckError[] {
  const generateScript = resolve(__dirname, 'generate-faq-embeddings.ts');
  console.log('🔍 drift mode: generate-faq-embeddings.ts --dry-run を実行');

  const result = spawnSync('npx', ['tsx', generateScript, '--dry-run'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });

  if (result.error) {
    return [
      {
        category: 'drift',
        entryId: '(spawn)',
        message: `generate-faq-embeddings.ts 実行失敗: ${result.error.message}`,
      },
    ];
  }
  if (result.status !== 0) {
    return [
      {
        category: 'drift',
        entryId: '(exit)',
        message: `generate-faq-embeddings.ts が exit code ${result.status} で失敗。出力:\n${result.stdout}\n${result.stderr}`,
      },
    ];
  }

  // dry-run 出力に "+N 追加 / ~N 更新 / -N 削除" の数値を抽出し、
  // いずれかが 0 でなければ drift ありと判定
  const stdout = result.stdout;
  const counts = stdout.match(/\+(\d+) 追加 \/ ~(\d+) 更新 \/ =\d+ 不変 \/ -(\d+) 削除/g) ?? [];
  let pending = 0;
  for (const m of counts) {
    const parsed = m.match(/\+(\d+) 追加 \/ ~(\d+) 更新 \/ =\d+ 不変 \/ -(\d+) 削除/);
    if (parsed) {
      pending += Number(parsed[1]) + Number(parsed[2]) + Number(parsed[3]);
    }
  }

  if (pending > 0) {
    console.log(stdout);
    return [
      {
        category: 'drift',
        entryId: '(diff)',
        message:
          `config と DB embedding に ${pending} 件の diff があります。deploy 後に ` +
          `\`pnpm generate:faq-embeddings\` を実行してください (developer-guide §7 / DEPLOYMENT.md SOP)。`,
      },
    ];
  }

  console.log('✨ DB embedding は config と完全同期しています');
  return [];
}

function main(): void {
  console.log('🦉 check-faq-embeddings-sync');
  console.log('');

  const errors: CheckError[] = [];

  // 1. 構造チェック (常に実行)
  console.log('▶ structure mode (DB アクセス不要)');
  const structureErrors = [...checkFaqStructure(), ...checkGuideStructure()];
  if (structureErrors.length === 0) {
    console.log(`   ✅ FAQ ${FAQ_ENTRIES.length} 件 + Guide ${GUIDE_STEPS.length} 件、構造健全`);
  }
  errors.push(...structureErrors);
  console.log('');

  // 2. drift チェック (DATABASE_URL がある時のみ)
  if (process.env.DATABASE_URL && process.env.DATABASE_URL.trim() !== '') {
    console.log('▶ drift mode (DATABASE_URL あり、DB 突合実行)');
    errors.push(...runDriftCheck());
  } else {
    console.log('▶ drift mode: skip (DATABASE_URL 未設定)');
    console.log('   ℹ 本番 / staging で diff 検証するには DATABASE_URL を設定して再実行してください');
  }
  console.log('');

  if (errors.length === 0) {
    console.log('✅ 同期チェック PASS');
    process.exit(0);
  }

  console.error(`❌ 同期チェック FAIL: ${errors.length} 件のエラー`);
  for (const e of errors) {
    console.error(`   [${e.category}] ${e.entryId}: ${e.message}`);
  }
  console.error('');
  console.error('🛠 修正手順:');
  console.error('   - structure エラー: src/config/faq-content.ts / guide-content.ts を修正');
  console.error('   - drift エラー: ローカルで `pnpm generate:faq-embeddings` を実行 (本番 DATABASE_URL 設定)');
  console.error('   - 詳細 SOP: docs/operations/develop/DEPLOYMENT.md / docs/operations/develop/FAQ_AND_OWL_CHAT_GUIDE.md §7');
  process.exit(1);
}

if (require.main === module) {
  main();
}

export const __testing = {
  checkFaqStructure,
  checkGuideStructure,
};
