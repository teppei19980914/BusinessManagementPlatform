/**
 * chat-panel.tsx の source-pattern 回帰テスト。
 *
 * 担保対象 (feat/chat-icon-mascot-owl 2026-05-27):
 *   - ヘッダにアバター + ペルソナ名 (たすきフクロウ) を表示
 *   - UserBubble (右寄せ) / AssistantBubble (左寄せ + アバター) のヘルパーを定義
 *   - 結果カード群はアシスタント吹き出し内にネストして表示
 *   - 旧実装の「💬 過去資産を意味検索」ヘッダ文言、「あなた:」ラベル は撤去
 *   - 縮退モードバナーはアシスタント吹き出し内に移設
 *   - 結果カードは ChatSearchResultCard コンポーネントを使用
 *
 * 担保対象 (feat/chat-history-and-accordion 2026-05-28):
 *   - 会話履歴の配列構造 (ChatTurn / turns state)
 *   - sessionStorage 永続化 (loadHistory / saveHistory / clearHistory + storage key)
 *   - ログアウト時の sessionStorage クリア (useSession status 監視)
 *   - strong tier の初期 5 件 + 6 件目以降アコーディオン化
 *   - medium tier をデフォルト折りたたみへ変更 + 文言「中程度の関連」
 *   - フクロウの会話文言を人間味のある表現に調整
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CLIENT_FILE = join(__dirname, 'chat-panel.tsx');
const source = readFileSync(CLIENT_FILE, 'utf8');

const JA_MESSAGES_FILE = join(__dirname, '../../i18n/messages/ja.json');
const chatPanelJa = (JSON.parse(readFileSync(JA_MESSAGES_FILE, 'utf8')) as Record<string, Record<string, string>>).chatPanel;

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
    expect(source).toMatch(/<AssistantBubble>[\s\S]*?<ChatResults[\s\S]*?<\/AssistantBubble>/);
  });

  it('旧実装の文言「💬 過去資産を意味検索」「あなた:」ラベルが撤去されている', () => {
    expect(source).not.toMatch(/💬\s*過去資産を意味検索/);
    expect(source).not.toMatch(/あなた:/);
  });

  it('縮退モードのバナーはアシスタント吹き出し内 (AssistantBubble) に内包する', () => {
    const assistantBlockMatch = source.match(/<AssistantBubble>[\s\S]*?<\/AssistantBubble>/g) ?? [];
    const hasDegradedInsideAssistantBubble = assistantBlockMatch.some((block) =>
      /degradeReason/.test(block),
    );
    expect(hasDegradedInsideAssistantBubble).toBe(true);
  });

  it('結果カードは ChatSearchResultCard (result-card.tsx) 経由で描画する', () => {
    expect(source).toMatch(/import\s*\{\s*ChatSearchResultCard\s*\}\s*from\s*'\.\/result-card'/);
  });

  it('ヘッダ avatar に priority は付与しない (KDD §5.X+166)', () => {
    const imageBlock = source.match(/<Image[\s\S]{0,400}?chat-panel-persona-avatar/);
    expect(imageBlock).not.toBeNull();
    expect(imageBlock![0]).not.toMatch(/priority/);
  });

  it('AssistantBubble の装飾 avatar は alt="" のみ (aria-hidden 冗長指定なし)', () => {
    const assistantBubbleSource = source.match(/function AssistantBubble[\s\S]*?^}/m);
    expect(assistantBubbleSource).not.toBeNull();
    const block = assistantBubbleSource![0];
    expect(block).toMatch(/alt=""/);
    expect(block).not.toMatch(/aria-hidden="true"/);
  });

  it('全アバターが object-cover で確実にトリミングされる (KDD §5.X+165 横展開)', () => {
    const matches = source.match(/object-cover/g);
    expect(matches?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('全アバターに unoptimized を付与しない (Optimizer 経由 / KDD §5.X+177 真原因 = middleware redirect)', () => {
    // KDD §5.X+177: 当初 `unoptimized` で broken-image 事象を回避したが、真原因は
    //   middleware が /mascot-owl-chat.png を /login に 302 redirect していたこと。
    //   middleware matcher を修正したため Optimizer は復帰可能。
    expect(source).not.toMatch(/unoptimized\b/);
  });
});

describe('ChatPanel 会話履歴の永続化 + ★severity-1 ユーザ越境防御★ invariant', () => {
  it('ChatTurn 型を定義しており userQuery / result / error フィールドを持つ', () => {
    expect(source).toMatch(/type\s+ChatTurn\s*=\s*\{/);
    expect(source).toMatch(/userQuery:\s*string/);
    expect(source).toMatch(/result\?:\s*ChatSearchResult/);
    expect(source).toMatch(/error\?:\s*string/);
  });

  it('turns state を配列で保持し、map で時系列描画する', () => {
    expect(source).toMatch(/useState<ChatTurn\[\]>/);
    expect(source).toMatch(/turns\.map\(/);
  });

  it('★越境防御★ 履歴は共有 chat-history-storage の user-scoped ヘルパで永続化する', () => {
    expect(source).toMatch(/from\s*'@\/lib\/chat-history-storage'/);
    expect(source).toMatch(/loadScopedHistory/);
    expect(source).toMatch(/saveScopedHistory/);
    expect(source).toMatch(/purgeOtherUsersHistory/);
    expect(source).toMatch(/CHAT_SEARCH_HISTORY_BASE_KEY/);
    // 固定キーをコンポーネントに直書きしない (= スコープ化されたキーのみ使う)
    expect(source).not.toMatch(/['"]tasukiba_chat_history_v1['"]/);
  });

  it('★越境防御★ 固定キーの lazy init を廃止し、viewerUserId 確定後に purge + scoped load する', () => {
    // 旧: useState(() => loadHistory()) は固定キーから即時復元するため A の履歴が B に漏れる
    expect(source).not.toMatch(/useState<ChatTurn\[\]>\(\(\)\s*=>\s*loadHistory\(\)\)/);
    expect(source).toMatch(/useState<ChatTurn\[\]>\(\[\]\)/);
    // viewerUserId を依存にした load effect で「他ユーザ purge → 現ユーザ scoped load」を行う
    expect(source).toMatch(
      /if\s*\(!viewerUserId\)\s*return;[\s\S]{0,260}?purgeOtherUsersHistory\(CHAT_SEARCH_HISTORY_BASE_KEY,\s*viewerUserId\)[\s\S]{0,260}?loadScopedHistory\(CHAT_SEARCH_HISTORY_BASE_KEY/,
    );
  });

  it('★越境防御★ hydrated ゲートで復元前の空配列 clobber を防いでから save する', () => {
    expect(source).toMatch(/const\s+\[hydrated,\s*setHydrated\]\s*=\s*useState\(false\)/);
    expect(source).toMatch(
      /if\s*\(!hydrated\s*\|\|\s*!viewerUserId\s*\|\|\s*isUnauthenticated\)\s*return;[\s\S]{0,140}?saveScopedHistory/,
    );
  });

  it('ログアウト (unauthenticated) 検知で全ユーザ分を purgeAllHistory する (多層防御)', () => {
    expect(source).toMatch(/isUnauthenticated/);
    expect(source).toMatch(/session\.status\s*===\s*['"]unauthenticated['"]/);
    expect(source).toMatch(
      /if\s*\(!isUnauthenticated\)\s*return;[\s\S]{0,200}?purgeAllHistory\(CHAT_SEARCH_HISTORY_BASE_KEY\)/,
    );
  });

  it('履歴クリアボタン (chat-panel-clear-history) をヘッダに配置している', () => {
    expect(source).toMatch(/data-testid="chat-panel-clear-history"/);
  });

  it('履歴件数上限 MAX_HISTORY_TURNS を定義し load/save ヘルパに渡す', () => {
    expect(source).toMatch(/MAX_HISTORY_TURNS\s*=\s*\d+/);
    expect(source).toMatch(/loadScopedHistory\([\s\S]{0,90}?MAX_HISTORY_TURNS\)/);
    expect(source).toMatch(/saveScopedHistory\([\s\S]{0,90}?MAX_HISTORY_TURNS\)/);
  });

  it('手動クリアも user-scoped (clearScopedHistory + viewerUserId) で行う', () => {
    expect(source).toMatch(/clearScopedHistory\(CHAT_SEARCH_HISTORY_BASE_KEY,\s*viewerUserId\)/);
  });
});

describe('ChatPanel 結果表示のアコーディオン invariant (H-3 / H-4)', () => {
  it('strong tier の初期表示件数は config の SUGGESTION_TIER_STRONG_INITIAL_VISIBLE を参照する (2026-05-29 DRY 化: suggestions-panel と共有)', () => {
    // 旧: chat-panel.tsx 内に local const STRONG_INITIAL_VISIBLE = 5 を保持。
    // 新: @/config/suggestion から共有定数を import (suggestions-panel と DRY)。
    expect(source).toMatch(/import\s*\{[\s\S]*?SUGGESTION_TIER_STRONG_INITIAL_VISIBLE[\s\S]*?\}\s*from\s*'@\/config\/suggestion'/);
    expect(source).toMatch(/strong\.slice\(0,\s*SUGGESTION_TIER_STRONG_INITIAL_VISIBLE\)/);
    // local const は撤去されている。
    expect(source).not.toMatch(/const\s+STRONG_INITIAL_VISIBLE\s*=/);
  });

  it('strong tier の 6 件目以降はアコーディオン (strongExpanded) で展開する', () => {
    expect(source).toMatch(/strongExpanded/);
    expect(source).toMatch(/data-testid="chat-toggle-strong-rest"/);
  });

  it('medium tier をデフォルト折りたたみ (useState(false)) に変更している', () => {
    // mediumExpanded state を導入し、初期値 false (= 折りたたみ)。
    expect(source).toMatch(/const\s+\[mediumExpanded,\s*setMediumExpanded\]\s*=\s*useState\(false\)/);
    expect(source).toMatch(/data-testid="chat-toggle-medium"/);
  });

  it('weak tier は既存通りデフォルト折りたたみを維持', () => {
    expect(source).toMatch(/const\s+\[weakExpanded,\s*setWeakExpanded\]\s*=\s*useState\(false\)/);
    expect(source).toMatch(/data-testid="chat-toggle-weak"/);
  });

  it('medium セクション label は「中程度の関連」に変更されている (「関連の可能性」は表示文字列から撤去)', () => {
    // コメント (改名理由を残すため意図的に旧名を引用) を除外した上で「関連の可能性」が
    // 表示文字列として残っていないことを確認する。
    const codeOnly = source
      .replace(/\/\*[\s\S]*?\*\//g, '') // ブロックコメント (JSDoc 含む) 除去
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '') // JSX 内の {/* */} 除去
      .replace(/\/\/.*$/gm, ''); // 行コメント除去
    // 表示文字列は i18n キー経由で出力 (直書き文字列ではなく t() 呼出を確認)
    expect(codeOnly).toMatch(/t\('mediumCollapsed'/);
    expect(chatPanelJa.mediumCollapsed).toMatch(/中程度の関連/);
    expect(chatPanelJa.mediumExpandedLabel).toMatch(/中程度の関連/);
    expect(codeOnly).not.toMatch(/関連の可能性/);
  });

  it('strong / weak のセクション label は既存文言を維持', () => {
    // 表示文字列は i18n キー経由 (ja.json で確認)
    expect(chatPanelJa.strongSectionTitle).toMatch(/強く関連/);
    expect(chatPanelJa.weakCollapsed).toMatch(/弱い関連性/);
  });
});

describe('ChatPanel フクロウの会話文言 invariant (人間味調整)', () => {
  it('初回挨拶は「気になることや知りたいことをチャットしてください」を含む', () => {
    // 表示文字列は i18n キー経由
    expect(source).toMatch(/t\('greetingBody'\)/);
    expect(chatPanelJa.greetingBody).toMatch(/気になることや知りたいことをチャットしてください/);
  });

  it('初回挨拶は turns の有無に依存せず常時描画される (turns.length === 0 ガードが撤去されている)', () => {
    // 旧挙動: 質問送信後に挨拶が消える → 新挙動: 挨拶は会話履歴の最上部に固定
    // 🗑️ クリアで turns=[] に戻ったとき、挨拶のみが残る初期状態を再現できる。
    expect(source).toMatch(/data-testid="chat-initial-greeting"/);
    // turns.length === 0 で挨拶を出し分ける条件式が存在しないことを確認。
    expect(source).not.toMatch(/turns\.length\s*===\s*0\s*&&\s*\(\s*<AssistantBubble>/);
  });

  it('検索中の表示は「ちょっと待ってくださいね、過去資産から探しています」', () => {
    expect(source).toMatch(/t\('pendingMessage'\)/);
    expect(chatPanelJa.pendingMessage).toMatch(/ちょっと待ってくださいね/);
  });

  it('結果サマリは「N件…見つけました。関連が強い順にご紹介しますね」の文体', () => {
    expect(source).toMatch(/t\('foundCount'/);
    expect(chatPanelJa.foundCount).toMatch(/見つけました/);
    expect(chatPanelJa.foundCount).toMatch(/関連が強い順にご紹介/);
  });

  it('0 件時は「うーん、関連する資産は見つかりませんでした…」の文体', () => {
    expect(source).toMatch(/t\('noResults'\)/);
    expect(chatPanelJa.noResults).toMatch(/うーん、関連する資産は見つかりませんでした/);
  });

  it('縮退モード時の文言は「ごめんなさい、AI 機能が一時的に使えないようです」', () => {
    expect(source).toMatch(/t\('degradedNotice'/);
    expect(chatPanelJa.degradedNotice).toMatch(/ごめんなさい、AI 機能が一時的に使えないようです/);
  });

  it('短いクエリ警告は「もう少し詳しく書いていただけると」の柔らかい表現', () => {
    expect(source).toMatch(/t\('warningShortQuery'\)/);
    expect(chatPanelJa.warningShortQuery).toMatch(/もう少し詳しく書いていただける/);
    // 旧実装の機械的な「クエリが短いと検索精度が下がる可能性があります」は撤去
    expect(source).not.toMatch(/クエリが短いと検索精度が下がる可能性があります/);
  });

  it('プライバシー告知バナーは厳密さを保つため文体維持 (Voyage AI / 機微情報を明示)', () => {
    // 文言は i18n キー経由 (ja.json で確認)
    expect(source).toMatch(/t\('voyageNotice'\)/);
    expect(chatPanelJa.voyageNotice).toMatch(/外部 AI サービス \(Voyage AI\)/);
    expect(chatPanelJa.voyageNotice).toMatch(/機微情報の入力はお控えください/);
  });
});

/**
 * ADR-0028 (2026-05-30): mode タブ (search / help) 統合
 *
 * 担保対象:
 *   - PanelMode 型 + sessionStorage 永続化 helpers
 *   - WAI-ARIA tab pattern (role="tablist" / role="tab" / aria-selected /
 *     aria-controls / role="tabpanel" / aria-labelledby)
 *   - HelpChatInput を panel variant で組み込み
 *   - mode='search' default、誤った保存値は 'search' に fail-safe
 *   - mode='help' 時は ChatPanel のクリアボタンは隠す (HelpChatInput が独自に持つ)
 */
describe('ChatPanel mode タブ統合 (ADR-0028)', () => {
  it('HelpChatInput を @/components/help-chat/help-chat-input から import している', () => {
    expect(source).toMatch(
      /import\s*\{\s*HelpChatInput\s*\}\s*from\s*'@\/components\/help-chat\/help-chat-input'/,
    );
  });

  it('PanelMode 型を search | help で定義している', () => {
    expect(source).toMatch(/type\s+PanelMode\s*=\s*'search'\s*\|\s*'help'/);
  });

  it('sessionStorage 用 key を tasukiba_chat_panel_mode_v1 として定義', () => {
    expect(source).toMatch(/PANEL_MODE_STORAGE_KEY\s*=\s*'tasukiba_chat_panel_mode_v1'/);
  });

  it('loadPanelMode / savePanelMode helper が定義されている', () => {
    expect(source).toMatch(/function loadPanelMode\(/);
    expect(source).toMatch(/function savePanelMode\(/);
  });

  it("loadPanelMode は不正値 / 未設定時に 'search' へ fail-safe", () => {
    // 'help' | 'search' のいずれでもなければ 'search' に倒す実装になっている
    expect(source).toMatch(
      /raw === 'help' \|\| raw === 'search'[\s\S]{0,30}?return raw[\s\S]{0,30}?return 'search'/,
    );
  });

  it('WAI-ARIA tablist + tab + tabpanel を備える', () => {
    expect(source).toMatch(/role="tablist"/);
    expect(source).toMatch(/role="tab"/);
    expect(source).toMatch(/role="tabpanel"/);
    expect(source).toMatch(/aria-selected=\{mode === 'search'\}/);
    expect(source).toMatch(/aria-selected=\{mode === 'help'\}/);
    expect(source).toMatch(/aria-controls="chat-panel-panel-search"/);
    expect(source).toMatch(/aria-controls="chat-panel-panel-help"/);
    expect(source).toMatch(/aria-labelledby="chat-panel-tab-search"/);
    expect(source).toMatch(/aria-labelledby="chat-panel-tab-help"/);
  });

  it('タブボタンに data-testid を付与してテストから参照可能', () => {
    expect(source).toMatch(/data-testid="chat-panel-tab-search"/);
    expect(source).toMatch(/data-testid="chat-panel-tab-help"/);
  });

  it('mode==="help" 時は HelpChatInput を variant="panel" + hideHeader + onTurnsCountChange + key で描画 (★UI 完全一致★)', () => {
    // ★severity-high★ UI 一致原則 (feedback_sibling_ui_pattern_horizontal_rollout):
    //   - hideHeader: ChatPanel ヘッダで一元化 (二重ヘッダ撤廃)
    //   - onTurnsCountChange: ChatPanel 側でクリアボタン disabled 判定
    //   - key={helpResetKey}: クリア時の再 mount で内部 state 破棄
    expect(source).toMatch(/<HelpChatInput[\s\S]*?variant="panel"[\s\S]*?\/>/);
    expect(source).toMatch(/<HelpChatInput[\s\S]*?hideHeader[\s\S]*?\/>/);
    expect(source).toMatch(/<HelpChatInput[\s\S]*?onTurnsCountChange=\{setHelpTurnsCount\}[\s\S]*?\/>/);
    expect(source).toMatch(/<HelpChatInput[\s\S]*?key=\{helpResetKey\}[\s\S]*?\/>/);
  });

  it('クリアボタンは mode 共通で常に表示 (★UI 完全一致★ ゴミ箱位置も統一)', () => {
    // クリアボタンは header 内に 1 つだけ存在し、mode='search' 条件分岐で隠されない
    expect(source).toMatch(/data-testid="chat-panel-clear-history"/);
    // 旧仕様 {mode === 'search' && (...クリアボタン...)} は撤去
    expect(source).not.toMatch(
      /\{mode === 'search' &&[\s\S]{0,400}?data-testid="chat-panel-clear-history"/,
    );
  });

  it('クリアボタン disabled は現 mode の turns 数で判定 (search:turns / help:helpTurnsCount)', () => {
    expect(source).toMatch(
      /disabled=\{mode === 'search' \? turns\.length === 0 : helpTurnsCount === 0\}/,
    );
  });

  it('help mode のクリアは user-scoped 削除 (HELP_CHAT_HISTORY_BASE_KEY) + helpResetKey で remount', () => {
    expect(source).toMatch(/clearScopedHistory\(HELP_CHAT_HISTORY_BASE_KEY,\s*viewerUserId\)/);
    expect(source).toMatch(/setHelpResetKey\(\(k\) => k \+ 1\)/);
  });

  it('help mode の tabpanel は search mode と同じ flex flex-col className (★UI 完全一致★)', () => {
    // 旧 `flex-1 min-h-0 overflow-hidden p-2` を撤去 (search と異なる padding/overflow)
    // 2 巡目検証 (2026-05-30): hidden パターンに移行したため className は条件式
    //   `className={mode === 'help' ? 'flex flex-1 min-h-0 flex-col' : ''}` の形式
    const helpPanelMatch = source.match(
      /<div\s+role="tabpanel"\s+id="chat-panel-panel-help"[\s\S]{0,400}?className=\{mode === 'help' \? '([^']+)' : ''\}/,
    );
    expect(helpPanelMatch).not.toBeNull();
    expect(helpPanelMatch![1]).toContain('flex');
    expect(helpPanelMatch![1]).toContain('flex-col');
    expect(helpPanelMatch![1]).not.toContain('p-2');
    expect(helpPanelMatch![1]).not.toContain('overflow-hidden');
  });

  it('サブタイトルは mode に応じて切替 (検索 / ヘルプ・ガイド)', () => {
    expect(source).toMatch(/mode === 'search' \? t\('subtitleSearch'\) : t\('subtitleHelp'\)/);
    expect(chatPanelJa.subtitleSearch).toBe('過去資産を意味検索');
    expect(chatPanelJa.subtitleHelp).toBe('FAQ・使い方ガイド');
  });

  it('tabIndex は roving tab index pattern (active=0、inactive=-1)', () => {
    expect(source).toMatch(/tabIndex=\{mode === 'search' \? 0 : -1\}/);
    expect(source).toMatch(/tabIndex=\{mode === 'help' \? 0 : -1\}/);
  });
});

/**
 * ADR-0028 PR #471 2 巡目検証 (2026-05-30) 追加担保:
 *   - タブ切替で state 消失を防ぐため両 tabpanel を常時 mount + hidden 属性で表示制御
 *   - クリアボタン aria-label / title を mode 別に動的化 (a11y)
 */
describe('ChatPanel 2 巡目検証 (state 保持 + a11y 強化)', () => {
  it('両 tabpanel を常時 mount し hidden 属性で表示制御 (WAI-ARIA tab pattern 標準)', () => {
    expect(source).toMatch(/hidden=\{mode !== 'search'\}/);
    expect(source).toMatch(/hidden=\{mode !== 'help'\}/);
    // 旧: `{mode === 'help' ? (... HelpChatInput ...) : (... SearchModeBody ...)}` の三項排他レンダリングを撤去
    expect(source).not.toMatch(/\{mode === 'help' \?[\s\S]{0,300}?<HelpChatInput/);
  });

  it('HelpChatInput は条件付き mount ではなく常時 mount (タブ切替で state 保持)', () => {
    const helpPanelBlock = source.match(
      /<div\s+role="tabpanel"\s+id="chat-panel-panel-help"[\s\S]+?<HelpChatInput[\s\S]+?\/>/,
    );
    expect(helpPanelBlock).not.toBeNull();
    // {mode === 'help' && <HelpChatInput ...>} 形式 (= 条件 mount) ではないこと
    expect(helpPanelBlock![0]).not.toMatch(/\{mode === 'help' && <HelpChatInput/);
  });

  it("SearchModeBody は mode==='search' 時のみ描画 (search タブ非表示時は無駄な useEffect 抑制)", () => {
    expect(source).toMatch(/\{mode === 'search' && \(\s*<SearchModeBody/);
  });

  it('クリアボタン aria-label を mode 別動的化 (a11y screen reader 区別)', () => {
    // 文言は i18n キー経由 (ja.json で確認)
    expect(source).toMatch(
      /aria-label=\{[\s\S]{0,30}?mode === 'search'[\s\S]{0,200}?t\('ariaLabelClearSearch'\)[\s\S]{0,200}?t\('ariaLabelClearHelp'\)/,
    );
    expect(chatPanelJa.ariaLabelClearSearch).toBe('過去資産検索の会話履歴をクリア');
    expect(chatPanelJa.ariaLabelClearHelp).toBe('ヘルプ・ガイドの会話履歴をクリア');
  });

  it('クリアボタン title (tooltip) も mode 別動的化 (aria-label と同文言)', () => {
    expect(source).toMatch(
      /title=\{[\s\S]{0,30}?mode === 'search'[\s\S]{0,200}?t\('ariaLabelClearSearch'\)/,
    );
  });
});
