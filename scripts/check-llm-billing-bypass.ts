/**
 * LLM 課金バイパス検出 CI ガード (ADR-0019 / 2026-05-24)
 *
 * 役割:
 *   `getAnthropicClient()` / `voyageEmbed()` を直接 import している箇所が
 *   allowlist 外に増えないように機械的に検出する。
 *
 *   背景:
 *     ADR-0019 で課金エンジン (`withMeteredLLM`) を経由する設計を再確認した。
 *     新規開発者が「ちょっとした embedding 試したいから」と Anthropic / Voyage を
 *     直接呼ぶと、ApiCallLog 記録 / Stripe queue / rate limit / fair use limit のすべてを
 *     バイパスしてしまう (= 事業継続性の根本的破綻 / 経済的攻撃の入り口)。
 *
 * 検出する禁止パターン:
 *   - `import { getAnthropicClient } from '@/lib/llm/anthropic-client'` を allowlist 外で使用
 *   - `import { voyageEmbed } from '@/lib/llm/voyage-client'` を allowlist 外で使用
 *   - `getAnthropicClient(` の関数呼び出しを allowlist 外で記述
 *   - `voyageEmbed(` の関数呼び出しを allowlist 外で記述
 *
 * Allowlist (本ファイル群でのみ getAnthropicClient / voyageEmbed の直叩きを許可):
 *   - src/lib/llm/anthropic-client.ts (= client 自身)
 *   - src/lib/llm/anthropic-client.test.ts
 *   - src/lib/llm/voyage-client.ts (= client 自身)
 *   - src/lib/llm/voyage-client.test.ts
 *   - src/services/auto-tag.service.ts (withMeteredLLM の callback 内で Anthropic を呼ぶ)
 *   - src/services/embedding.service.ts (withMeteredLLM の callback 内で Voyage を呼ぶ)
 *   - src/services/project.service.ts (project-upsert で Anthropic + Voyage を集約)
 *   - src/services/suggestion-explanation.service.ts (なぜ機能、Anthropic 呼出)
 *   - src/app/api/help/chat/route.ts (ADR-0027 / 2026-05-29、ADR-0028 / 2026-05-30 で RAG 化):
 *       LEARNING_FREE_FEATURE_UNITS (= help-chat, help-chat-embedding) は意図的に
 *       withMeteredLLM を経由しない独立経路として設計されている (cost=0 全プラン無料、
 *       Tenant.currentMonthHelpChatCount で月次回数を独自管理、IP rate limit + テナント
 *       月 100 回上限の二重ガード)。BILLABLE_FEATURE_UNITS union に含まれず、課金集計対象外。
 *       ADR-0028 移行後は route 内で直接 anthropic は呼ぶが、RAG 用 Voyage embedding は
 *       embedding.service.ts の generateBatchEmbeddings 経由なので Voyage 側は ALLOWLIST 不要。
 *       根拠: ADR-0028 §6 課金分類 / docs/developer-guide/FAQ_AND_OWL_CHAT_GUIDE.md §1.3
 *   - *.test.ts ファイル (vi.mock でモック化、実呼出なし)
 *
 * 例外的に許可が必要な場合は該当行末に `// llm-billing-allow: <理由>` を付与する。
 *
 * 検出時は exit 1 で CI を fail させる。
 *
 * 関連:
 *   - ADR-0019 §LLM 暴走防止 (本ガードの趣旨)
 *   - src/lib/llm/metered.ts (= withMeteredLLM、正規の課金ゲートウェイ)
 *   - src/config/billing-feature-units.ts (BILLABLE_FEATURE_UNITS)
 *   - 既存類似ガード: scripts/check-banned-auth-patterns.ts
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

type Finding = {
  file: string;
  line: number;
  pattern: string;
  message: string;
};

/**
 * 直接呼出を許可する allowlist。POSIX パス (= / 区切り) で比較する。
 * Glob ではなく完全一致 + .test.ts サフィックス許可で十分。
 */
const ALLOWLIST_EXACT = new Set<string>([
  'src/lib/llm/anthropic-client.ts',
  'src/lib/llm/voyage-client.ts',
  'src/services/auto-tag.service.ts',
  'src/services/embedding.service.ts',
  'src/services/project.service.ts',
  'src/services/suggestion-explanation.service.ts',
  // ADR-0027 (2026-05-29) / ADR-0028 (2026-05-30 RAG 化): たすきフクロウ AI ヘルプチャット
  //   は LEARNING_FREE 分類で意図的に withMeteredLLM を経由しない独立経路
  //   (cost=0 全プラン無料、Tenant.currentMonthHelpChatCount で月次回数を独自管理)。
  //   ADR-0028 後も anthropic 直叩きは本 route 内のみ。
  //   詳細は上部コメント参照。
  'src/app/api/help/chat/route.ts',
]);

/** スキャン対象から除外するディレクトリ */
const SKIP_DIRS = new Set([
  'node_modules',
  '.next',
  'dist',
  'build',
  'coverage',
  '.git',
  'playwright-report',
  'test-results',
  '.storybook-static',
  '.netlify',
  'public',
  'docs',
  'scripts',
  // Prisma 生成コードはチェック対象外 (= 業務ロジックなし)
  path.join('src', 'generated'),
]);

/** スキャンする拡張子 */
const SCAN_EXTENSIONS = new Set(['.ts', '.tsx']);

const PATTERNS: Array<{
  regex: RegExp;
  name: string;
  message: string;
}> = [
  {
    regex: /\bgetAnthropicClient\s*\(/,
    name: 'getAnthropicClient()',
    message:
      'getAnthropicClient() を直接呼んでいます。withMeteredLLM の callback 内で呼ぶか、auto-tag.service.ts / suggestion-explanation.service.ts 経由で使ってください。',
  },
  {
    regex: /\bvoyageEmbed\s*\(/,
    name: 'voyageEmbed()',
    message:
      'voyageEmbed() を直接呼んでいます。withMeteredLLM の callback 内で呼ぶか、embedding.service.ts 経由で使ってください。',
  },
  {
    regex:
      /^\s*import\s+(?:\{[^}]*\bgetAnthropicClient\b[^}]*\}|[^;]*\bgetAnthropicClient\b[^;]*)\s+from\s+['"]@\/lib\/llm\/anthropic-client['"]/,
    name: "import { getAnthropicClient } from '@/lib/llm/anthropic-client'",
    message:
      'getAnthropicClient の直接 import は禁止です。withMeteredLLM 経由のラッパー (auto-tag.service / suggestion-explanation.service) を使ってください。',
  },
  {
    regex:
      /^\s*import\s+(?:\{[^}]*\bvoyageEmbed\b[^}]*\}|[^;]*\bvoyageEmbed\b[^;]*)\s+from\s+['"]@\/lib\/llm\/voyage-client['"]/,
    name: "import { voyageEmbed } from '@/lib/llm/voyage-client'",
    message:
      'voyageEmbed の直接 import は禁止です。embedding.service.ts 経由で使ってください。',
  },
];

function isAllowed(relPath: string): boolean {
  const posix = relPath.replace(/\\/g, '/');
  // テストファイルは vi.mock 前提で許可
  if (posix.endsWith('.test.ts') || posix.endsWith('.test.tsx')) return true;
  return ALLOWLIST_EXACT.has(posix);
}

function walk(dir: string, acc: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const rel = path.relative(ROOT, full).replace(/\\/g, '/');
    if (SKIP_DIRS.has(entry) || SKIP_DIRS.has(rel)) continue;
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full, acc);
    } else {
      const ext = path.extname(entry);
      if (SCAN_EXTENSIONS.has(ext)) acc.push(full);
    }
  }
}

function scanFile(absPath: string): Finding[] {
  const rel = path.relative(ROOT, absPath).replace(/\\/g, '/');
  if (isAllowed(rel)) return [];

  const findings: Finding[] = [];
  const content = readFileSync(absPath, 'utf-8');
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.includes('llm-billing-allow:')) continue;
    for (const p of PATTERNS) {
      if (p.regex.test(line)) {
        findings.push({
          file: rel,
          line: i + 1,
          pattern: p.name,
          message: p.message,
        });
      }
    }
  }
  return findings;
}

function main(): void {
  const files: string[] = [];
  walk(path.join(ROOT, 'src'), files);

  const allFindings: Finding[] = [];
  for (const f of files) {
    allFindings.push(...scanFile(f));
  }

  if (allFindings.length === 0) {
    console.log('[check-llm-billing-bypass] OK: 課金バイパス検出ゼロ');
    return;
  }

  console.error('[check-llm-billing-bypass] ❌ 課金バイパス検出');
  for (const f of allFindings) {
    console.error(`  ${f.file}:${f.line} — ${f.pattern}`);
    console.error(`    ${f.message}`);
  }
  console.error('');
  console.error(
    '対応: withMeteredLLM 経由のラッパー (embedding.service / auto-tag.service / suggestion-explanation.service / project.service) を使うか、',
  );
  console.error(
    '       業務上どうしても直叩きが必要なら scripts/check-llm-billing-bypass.ts の ALLOWLIST_EXACT に追記し、',
  );
  console.error(
    '       ADR-0019 §LLM 暴走防止の方針との整合をレビューで明示してください。',
  );
  process.exit(1);
}

main();
