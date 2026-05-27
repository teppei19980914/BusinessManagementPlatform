/**
 * chat-panel.tsx の source-pattern 回帰テスト (feat/chat-icon-mascot-owl 2026-05-27)。
 *
 * 担保対象 (feat/chat-icon-mascot-owl):
 *   - ヘッダにアバター + ペルソナ名 (たすきフクロウ) を表示
 *   - UserBubble (右寄せ) / AssistantBubble (左寄せ + アバター) のヘルパーを定義
 *   - 結果カード群はアシスタント吹き出し内にネストして表示
 *   - 旧実装の「💬 過去資産を意味検索」ヘッダ文言、「あなた:」ラベル は撤去
 *   - 縮退モードバナーはアシスタント吹き出し内に移設 (システム全体バナーから対話文脈へ)
 *   - 結果カードは ChatSearchResultCard コンポーネントを使用
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CLIENT_FILE = join(__dirname, 'chat-panel.tsx');
const source = readFileSync(CLIENT_FILE, 'utf8');

describe('ChatPanel のマスコット統合 invariant', () => {
  it('next/image を import している', () => {
    expect(source).toMatch(/import\s+Image\s+from\s+'next\/image'/);
  });

  it('CHAT_PERSONA を @/config から import している', () => {
    expect(source).toMatch(/import\s*\{\s*CHAT_PERSONA\s*\}\s*from\s*'@\/config'/);
  });

  it('ヘッダにアバター + ペルソナ名のラベルを描画 (testid 経由で参照可能)', () => {
    expect(source).toMatch(/data-testid="chat-panel-persona-avatar"/);
    expect(source).toMatch(/data-testid="chat-panel-persona-name"/);
    expect(source).toMatch(/\{CHAT_PERSONA\.name\}/);
  });

  it('UserBubble ヘルパーが定義されており data-testid="chat-user-bubble" を持つ', () => {
    expect(source).toMatch(/function UserBubble\(/);
    expect(source).toMatch(/data-testid="chat-user-bubble"/);
  });

  it('AssistantBubble ヘルパーが定義されており data-testid="chat-assistant-bubble" を持つ', () => {
    expect(source).toMatch(/function AssistantBubble\(/);
    expect(source).toMatch(/data-testid="chat-assistant-bubble"/);
  });

  it('ChatResults はアシスタント吹き出し (AssistantBubble) 内にネストして描画する', () => {
    // 結果表示は <AssistantBubble>...<ChatResults ... /></AssistantBubble> の構造を取る。
    // 改行 + インデントを許容する正規表現で構造を検査する。
    expect(source).toMatch(/<AssistantBubble>[\s\S]*?<ChatResults[\s\S]*?<\/AssistantBubble>/);
  });

  it('旧実装の文言「💬 過去資産を意味検索」「あなた:」ラベルが撤去されている', () => {
    expect(source).not.toMatch(/💬\s*過去資産を意味検索/);
    expect(source).not.toMatch(/あなた:/);
  });

  it('縮退モードのバナーはアシスタント吹き出し内 (AssistantBubble) に内包する', () => {
    // 旧実装は messages コンテナ直下に独立配置していた。新実装ではアシスタント発言の
    // 一部として位置付ける (= 縮退理由が「フクロウからの説明」として読める)。
    const assistantBlockMatch = source.match(/<AssistantBubble>[\s\S]*?<\/AssistantBubble>/g) ?? [];
    const hasDegradedInsideAssistantBubble = assistantBlockMatch.some((block) =>
      /degradeReason/.test(block),
    );
    expect(hasDegradedInsideAssistantBubble).toBe(true);
  });

  it('結果カードは ChatSearchResultCard (result-card.tsx) 経由で描画する', () => {
    expect(source).toMatch(/import\s*\{\s*ChatSearchResultCard\s*\}\s*from\s*'\.\/result-card'/);
  });
});
