import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  AnthropicConfigError,
  _setAnthropicClientForTest,
  getAnthropicClient,
} from './anthropic-client';

const ORIGINAL_KEY = process.env.ANTHROPIC_API_KEY;

beforeEach(() => {
  _setAnthropicClientForTest(null); // 遅延初期化に戻す
});

afterEach(() => {
  if (ORIGINAL_KEY === undefined) {
    delete process.env.ANTHROPIC_API_KEY;
  } else {
    process.env.ANTHROPIC_API_KEY = ORIGINAL_KEY;
  }
  _setAnthropicClientForTest(null);
});

describe('getAnthropicClient', () => {
  it('ANTHROPIC_API_KEY 設定時は Anthropic インスタンスを返す', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
    const client = getAnthropicClient();
    expect(client).toBeDefined();
    expect(typeof client.messages.create).toBe('function');
  });

  it('singleton: 連続呼び出しで同じインスタンスを返す', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
    const a = getAnthropicClient();
    const b = getAnthropicClient();
    expect(a).toBe(b);
  });

  it('ANTHROPIC_API_KEY 未設定時は AnthropicConfigError を投げる (fail-closed)', () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(() => getAnthropicClient()).toThrow(AnthropicConfigError);
  });

  it('ANTHROPIC_API_KEY 空文字でも AnthropicConfigError を投げる', () => {
    process.env.ANTHROPIC_API_KEY = '';
    expect(() => getAnthropicClient()).toThrow(AnthropicConfigError);
  });

  it('ANTHROPIC_API_KEY が空白のみでも AnthropicConfigError を投げる', () => {
    process.env.ANTHROPIC_API_KEY = '   ';
    expect(() => getAnthropicClient()).toThrow(AnthropicConfigError);
  });
});

describe('_setAnthropicClientForTest', () => {
  it('差し替えた client が getAnthropicClient で返る', () => {
    const fake = { messages: { create: () => null } } as never;
    _setAnthropicClientForTest(fake);
    expect(getAnthropicClient()).toBe(fake);
  });

  it('null セット後は再初期化される', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
    const fake = { messages: { create: () => null } } as never;
    _setAnthropicClientForTest(fake);
    _setAnthropicClientForTest(null);
    const real = getAnthropicClient();
    expect(real).not.toBe(fake);
  });
});

describe('AnthropicConfigError', () => {
  it('Error のサブクラス + name プロパティ', () => {
    const e = new AnthropicConfigError('test');
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(AnthropicConfigError);
    expect(e.name).toBe('AnthropicConfigError');
    expect(e.message).toBe('test');
  });
});
