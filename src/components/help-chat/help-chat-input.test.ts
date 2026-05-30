/**
 * HelpChatInput の source-pattern invariant テスト。
 *
 * 担保対象 (ADR-0028 PR #471 / 2026-05-30 UI 完全一致対応):
 *   - variant='panel' のとき自前ヘッダ (hideHeader) を suppress
 *   - panel/page でメッセージ領域・footer の className を切替 (ChatPanel と完全一致)
 *   - onTurnsCountChange callback で turns 数を親 (ChatPanel) に通知
 *   - sessionStorage key 'tasukiba_help_chat_history_v1' で永続化 (ChatPanel と共有)
 *   - severity-1 ユーザ切替防御 (H-2 / H-5、chat-panel と整合)
 *
 * ★severity-high★ UI 完全一致原則 ([[feedback_sibling_ui_pattern_horizontal_rollout]]):
 *   ChatPanel タブ内に埋め込まれた HelpChatInput は、ヘッダ・メッセージ領域・footer 全て
 *   ChatPanel の SearchModeBody と視覚的に区別できないこと。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE_FILE = join(__dirname, 'help-chat-input.tsx');
const source = readFileSync(SOURCE_FILE, 'utf8');

describe('HelpChatInput Props (ADR-0028 UI 完全一致対応)', () => {
  it('hideHeader prop が定義されている', () => {
    expect(source).toMatch(/hideHeader\?:\s*boolean/);
  });

  it('onTurnsCountChange prop が定義されている', () => {
    expect(source).toMatch(/onTurnsCountChange\?:\s*\(count:\s*number\)\s*=>\s*void/);
  });

  it('variant は page | panel', () => {
    expect(source).toMatch(/variant\?:\s*'page'\s*\|\s*'panel'/);
  });
});

describe('HelpChatInput variant=panel: ChatPanel と UI 完全一致', () => {
  it('panel variant のとき自前 header を hide (二重ヘッダ撤廃)', () => {
    expect(source).toMatch(/\{!hideHeader && \(/);
  });

  it('panel: メッセージ領域は ChatPanel と同じ flex-1 min-h-0 overflow-y-auto p-4', () => {
    // panel mode の messagesClass を確認: ChatPanel の chat-panel-messages と一致
    expect(source).toMatch(/'flex-1 min-h-0 overflow-y-auto p-4 text-sm'/);
  });

  it('panel: メッセージ領域は枠なし (max-h-96 や rounded-md border は page のみ)', () => {
    // isPanel === true のとき max-h-96 / border を付けないこと (= page 専用)
    const messagesClassBlock = source.match(/const messagesClass = isPanel[\s\S]{0,300}?;/);
    expect(messagesClassBlock).not.toBeNull();
    expect(messagesClassBlock![0]).toContain('flex-1 min-h-0 overflow-y-auto p-4');
    expect(messagesClassBlock![0]).toContain('max-h-96'); // page 側に残っている
  });

  it('panel: footer は border-t border-border p-3 (ChatPanel と一致)', () => {
    expect(source).toMatch(/const footerClass = isPanel \? 'border-t border-border p-3' : 'mt-3'/);
  });

  it('panel container は flex h-full min-h-0 flex-col bg-background', () => {
    expect(source).toMatch(/'flex h-full min-h-0 flex-col bg-background'/);
  });
});

describe('HelpChatInput variant=page: 既存挙動を維持', () => {
  it('page variant のとき自前 header (アバター + persona + クリアボタン) を表示', () => {
    // !hideHeader 条件分岐の中に persona / data-testid="help-chat-clear-history" が含まれる
    const headerBlock = source.match(/\{!hideHeader && \([\s\S]+?\)\}/);
    expect(headerBlock).not.toBeNull();
    expect(headerBlock![0]).toMatch(/CHAT_PERSONA\.name/);
    expect(headerBlock![0]).toMatch(/data-testid="help-chat-clear-history"/);
  });

  it('page container は rounded-lg border bg-card p-4', () => {
    expect(source).toMatch(/'rounded-lg border bg-card p-4'/);
  });
});

describe('HelpChatInput state 同期 (★severity-1★)', () => {
  it('turns 数変化を onTurnsCountChange callback で親に通知', () => {
    expect(source).toMatch(/onTurnsCountChange\?\.\(turns\.length\)/);
  });

  it('sessionStorage key は tasukiba_help_chat_history_v1 で固定 (ChatPanel と共有)', () => {
    expect(source).toMatch(/['"]tasukiba_help_chat_history_v1['"]/);
  });

  it('ログアウト時 (unauthenticated) に sessionStorage を clear (H-2)', () => {
    expect(source).toMatch(/isUnauthenticated[\s\S]{0,200}?clearHistory\(\)/);
  });

  it('ユーザ ID 変化時に sessionStorage を clear (H-5、severity-1)', () => {
    expect(source).toMatch(/prevUserIdRef[\s\S]{0,200}?prev !== viewerUserId[\s\S]{0,100}?clearHistory\(\)/);
  });
});
