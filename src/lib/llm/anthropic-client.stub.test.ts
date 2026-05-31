/**
 * E2E LLM スタブ provider の unit test (test/release-acceptance-e2e / 2026-06)。
 *
 * 検証:
 *   1. LLM_PROVIDER=stub (非 production) → 鍵なしでも擬似クライアントを返し、
 *      messages.create が help-chat 出力スキーマに合致する JSON (content[].text) + usage を返す
 *   2. ★本番事故防止★ NODE_ENV=production では env を無視し、鍵なしなら従来通り fail-closed
 */

import { describe, it, expect, afterEach } from 'vitest';

import {
  AnthropicConfigError,
  getAnthropicClient,
  isLlmStubEnabled,
  _setAnthropicClientForTest,
} from './anthropic-client';

const ORIGINAL_KEY = process.env.ANTHROPIC_API_KEY;
const ORIGINAL_PROVIDER = process.env.LLM_PROVIDER;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

function setNodeEnv(value: string): void {
  (process.env as Record<string, string>).NODE_ENV = value;
}

afterEach(() => {
  _setAnthropicClientForTest(null); // singleton キャッシュをリセット
  if (ORIGINAL_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = ORIGINAL_KEY;
  if (ORIGINAL_PROVIDER === undefined) delete process.env.LLM_PROVIDER;
  else process.env.LLM_PROVIDER = ORIGINAL_PROVIDER;
  setNodeEnv(ORIGINAL_NODE_ENV ?? 'test');
});

describe('LLM stub provider', () => {
  it('LLM_PROVIDER=stub (非 production) で鍵なしでも擬似クライアントが help-chat JSON を返す', async () => {
    _setAnthropicClientForTest(null);
    delete process.env.ANTHROPIC_API_KEY;
    process.env.LLM_PROVIDER = 'stub';
    setNodeEnv('test');

    expect(isLlmStubEnabled()).toBe(true);

    const client = getAnthropicClient();
    // 本物の SDK と同じ呼び出し形 (route が叩く形)
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'テスト質問' }],
    });

    expect(message.usage.input_tokens).toBeGreaterThanOrEqual(0);
    expect(message.usage.output_tokens).toBeGreaterThanOrEqual(0);
    const textBlock = message.content.find((b) => b.type === 'text');
    expect(textBlock).toBeDefined();
    const parsed = JSON.parse((textBlock as { text: string }).text);
    expect(parsed).toMatchObject({
      answerType: 'faq',
      sourceFaqIds: [],
      sourceGuideStepIds: [],
      suggestSemanticSearch: false,
    });
    expect(typeof parsed.answer).toBe('string');
    expect(parsed.answer.length).toBeGreaterThan(0);
  });

  it('★本番ガード★ NODE_ENV=production では stub を無視し、鍵なしは AnthropicConfigError', () => {
    _setAnthropicClientForTest(null);
    delete process.env.ANTHROPIC_API_KEY;
    process.env.LLM_PROVIDER = 'stub';
    setNodeEnv('production');

    expect(isLlmStubEnabled()).toBe(false);
    expect(() => getAnthropicClient()).toThrow(AnthropicConfigError);
  });
});
