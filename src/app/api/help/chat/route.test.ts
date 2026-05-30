/**
 * /api/help/chat route.ts の source-pattern invariant テスト。
 *
 * 担保対象 (ADR-0028 / 2026-05-30 PR #471 フルスキャン検証で追加):
 *   - ★severity-medium★ counter increment は conditional updateMany (race condition guard)
 *   - WHERE 句に `currentMonthHelpChatCount: { lt: HELP_CHAT_MONTHLY_LIMIT_PER_TENANT }`
 *   - updated.count === 0 で warn ログ経路あり
 *   - LLM 結果は overshoot 時も返す (UX 優先設計)
 *   - runtime='nodejs' 明示 (KDD §5.X+190)
 *   - 必ず認証 + IP rate limit + tenant status + 月次上限 の 4 段ガードが残っている
 *   - RAG (searchHelpContent) を LLM 呼出前に実行
 *   - sourceFaqIds / sourceGuideStepIds に対する権限 defense-in-depth (3 層目)
 *
 * 全機能 test は依存 mock が多すぎる (auth + prisma + anthropic + rate-limit + searchHelpContent +
 * recordError) ため、本 test は source-pattern で構造的不変を保護する。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROUTE_FILE = join(__dirname, 'route.ts');
const source = readFileSync(ROUTE_FILE, 'utf8');

describe('POST /api/help/chat — runtime 設定', () => {
  it("runtime = 'nodejs' を明示している (KDD §5.X+190)", () => {
    expect(source).toMatch(/export const runtime = 'nodejs'/);
  });
});

describe('POST /api/help/chat — 暴走防止 hard cap 4 段ガード', () => {
  it('認証必須: getAuthenticatedUser が最初に呼ばれる', () => {
    expect(source).toMatch(/const authResult = await getAuthenticatedUser\(\)/);
    expect(source).toMatch(/if \(authResult instanceof NextResponse\) return authResult/);
  });

  it('IP/user rate limit: applyRateLimit (1 分 10 回)', () => {
    expect(source).toMatch(
      /applyRateLimit\(req,\s*\{\s*key:\s*'help-chat',\s*max:\s*10,\s*windowMs:\s*60_000\s*\}\)/,
    );
  });

  it('テナント inactive check: deletedAt / suspendedAt で判定し 403 (KDD §5.X+200 fix)', () => {
    // 旧: `tenant.status !== 'active'` ─ Tenant に status field が存在せず Prisma runtime
    //   で throw する罠だった (KDD §5.X+200)。
    // 新: 既存パターン (billing-aggregation / stripe-webhook-handlers) に合わせて
    //   deletedAt / suspendedAt で判定。
    expect(source).toMatch(
      /tenant\.deletedAt !== null \|\| tenant\.suspendedAt !== null/,
    );
    expect(source).toMatch(/code:\s*'TENANT_INACTIVE'/);
    // 旧 status 参照が再混入しないことを保証
    expect(source).not.toMatch(/tenant\.status !== 'active'/);
    expect(source).not.toMatch(/select:[\s\S]{0,100}?status:\s*true/);
  });

  it('テナント月 100 回上限 (HELP_CHAT_MONTHLY_LIMIT_PER_TENANT) pre-check', () => {
    expect(source).toMatch(
      /tenant\.currentMonthHelpChatCount >= HELP_CHAT_MONTHLY_LIMIT_PER_TENANT/,
    );
    expect(source).toMatch(/code:\s*'HELP_CHAT_LIMIT_EXCEEDED'/);
    expect(source).toMatch(/fallbackToAccordion:\s*true/);
  });
});

describe('POST /api/help/chat — race condition guard (ADR-0028 PR #471)', () => {
  it('counter increment は updateMany (= conditional)、update ではない', () => {
    // tenant.update を使うと WHERE 条件付きにできず race condition 防止できないため、
    // updateMany に統一する必要がある
    expect(source).toMatch(/prisma\.tenant\.updateMany\(/);
  });

  it('WHERE 句に currentMonthHelpChatCount < HELP_CHAT_MONTHLY_LIMIT_PER_TENANT を含む', () => {
    expect(source).toMatch(
      /currentMonthHelpChatCount:\s*\{\s*lt:\s*HELP_CHAT_MONTHLY_LIMIT_PER_TENANT\s*\}/,
    );
  });

  it('updateMany.count === 0 で race condition 検知し warn ログ', () => {
    expect(source).toMatch(/updated\.count === 0/);
    expect(source).toMatch(/help_chat_counter_race_skip/);
  });

  it('race condition 検知時も LLM response は返す (UX 優先)', () => {
    // updated.count === 0 のブロック内で early return していない (= response は後段で返される)
    // ★この test の目的は「overshoot 時に response が返らない実装ミス」の再混入を防ぐこと
    const raceBlock = source.match(/if \(updated\.count === 0\)\s*\{[\s\S]*?\}/);
    expect(raceBlock).not.toBeNull();
    expect(raceBlock![0]).not.toMatch(/return\s+NextResponse/);
  });
});

describe('POST /api/help/chat — RAG 経路 (ADR-0028)', () => {
  it('searchHelpContent を help-search.service.ts から import', () => {
    expect(source).toMatch(
      /import\s*\{[\s\S]*?searchHelpContent[\s\S]*?\}\s*from\s*'@\/services\/help-search\.service'/,
    );
  });

  it('searchHelpContent が LLM 呼出前に呼ばれる', () => {
    const searchIdx = source.indexOf('await searchHelpContent(');
    const llmIdx = source.indexOf('client.messages.create(');
    expect(searchIdx).toBeGreaterThan(0);
    expect(llmIdx).toBeGreaterThan(searchIdx);
  });

  it('RAG 結果 (buildRagPromptSection) を messages の user content に注入', () => {
    expect(source).toMatch(/ragPromptSection/);
    expect(source).toMatch(/buildRagPromptSection\(ragResult\.hits\)/);
  });

  it('embedding 縮退時 (ragResult.degraded) は warn ログ + LLM 続行', () => {
    expect(source).toMatch(/ragResult\.degraded/);
    expect(source).toMatch(/help_chat_rag_degraded/);
  });
});

describe('POST /api/help/chat — 権限 defense-in-depth Layer 3 (LLM hallucination 防御)', () => {
  it('sourceFaqIds を allowedFaqIds.has(id) で再フィルタ', () => {
    expect(source).toMatch(/allowedFaqIds\.has\(id\)/);
  });

  it('sourceGuideStepIds を allowedGuideStepIds.has(id) で再フィルタ', () => {
    expect(source).toMatch(/allowedGuideStepIds\.has\(id\)/);
  });

  it('allowedFaqIds は getFaqEntriesForRole(viewer) から構築', () => {
    expect(source).toMatch(/getFaqEntriesForRole\(viewer\)/);
  });

  it('allowedGuideStepIds は getGuideStepsForRole(viewer) から構築', () => {
    expect(source).toMatch(/getGuideStepsForRole\(viewer\)/);
  });
});

describe('POST /api/help/chat — Anthropic Prompt Caching (KDD §5.X+191)', () => {
  it('system プロンプトに cache_control: { type: ephemeral } 付与', () => {
    expect(source).toMatch(
      /cache_control:\s*\{\s*type:\s*'ephemeral'[\s\S]*?\}/,
    );
  });

  it('MAX_OUTPUT_TOKENS は 1024 で出力サイズを hard cap', () => {
    expect(source).toMatch(/MAX_OUTPUT_TOKENS\s*=\s*1024/);
  });

  it('MODEL_NAME は claude-haiku-4-5-20251001', () => {
    expect(source).toMatch(/MODEL_NAME\s*=\s*'claude-haiku-4-5-20251001'/);
  });
});

describe('POST /api/help/chat — 入力 validation', () => {
  it("query は z.string().min(1).max(2000)", () => {
    expect(source).toMatch(/query:\s*z\.string\(\)\.min\(1\)\.max\(2000\)/);
  });
});
