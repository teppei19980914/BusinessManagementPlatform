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

describe('ChatPanel 会話履歴の永続化 invariant (H-1 / H-2)', () => {
  it('ChatTurn 型を定義しており userQuery / result / error フィールドを持つ', () => {
    expect(source).toMatch(/type\s+ChatTurn\s*=\s*\{/);
    expect(source).toMatch(/userQuery:\s*string/);
    expect(source).toMatch(/result\?:\s*ChatSearchResult/);
    expect(source).toMatch(/error\?:\s*string/);
  });

  it('turns state を配列で保持し、ユーザ発言と応答を時系列順で描画する', () => {
    // useState<ChatTurn[]> または useState の lazy init で turns を持つ。
    expect(source).toMatch(/useState<ChatTurn\[\]>/);
    // map で描画している (= 全ターンを連続レンダリング)。
    expect(source).toMatch(/turns\.map\(/);
  });

  it('sessionStorage 永続化ヘルパ (loadHistory / saveHistory / clearHistory) を定義している', () => {
    expect(source).toMatch(/function\s+loadHistory\s*\(/);
    expect(source).toMatch(/function\s+saveHistory\s*\(/);
    expect(source).toMatch(/function\s+clearHistory\s*\(/);
  });

  it('sessionStorage の key は version 付き (tasukiba_chat_history_v1)', () => {
    // schema 変更時に key を bump する運用のため、v1 サフィックスを明示する。
    expect(source).toMatch(/tasukiba_chat_history_v1/);
  });

  it('sessionStorage のアクセスは window 経由 (localStorage を使わない)', () => {
    // タブを閉じたら自動消去される sessionStorage を採用 (DB 容量を消費しない設計)。
    expect(source).toMatch(/window\.sessionStorage/);
    expect(source).not.toMatch(/window\.localStorage/);
  });

  it('SSR safe: window 未定義時のガードを行う', () => {
    expect(source).toMatch(/typeof\s+window\s*===\s*['"]undefined['"]/);
  });

  it('parse / quota 失敗を try-catch で graceful degradation する', () => {
    // loadHistory / saveHistory / clearHistory のいずれも try-catch で囲まれている。
    const storageBlocks = source.match(/function\s+(loadHistory|saveHistory|clearHistory)[\s\S]*?\n}/g) ?? [];
    expect(storageBlocks.length).toBeGreaterThanOrEqual(3);
    for (const block of storageBlocks) {
      expect(block).toMatch(/try\s*\{/);
      expect(block).toMatch(/catch/);
    }
  });

  it('useSession().status === "unauthenticated" でログアウトを検知し clearHistory を呼ぶ', () => {
    expect(source).toMatch(/isUnauthenticated/);
    expect(source).toMatch(/session\.status\s*===\s*['"]unauthenticated['"]/);
    // ログアウト useEffect 内で clearHistory + setTurns([]) を呼ぶ (コメント込みで本体が長いため上限緩め)。
    const logoutEffect = source.match(
      /useEffect\(\(\)\s*=>\s*\{[\s\S]{0,400}?isUnauthenticated[\s\S]{0,400}?clearHistory\(\)[\s\S]{0,500}?setTurns\(\[\]\)/,
    );
    expect(logoutEffect).not.toBeNull();
  });

  it('履歴クリアボタン (chat-panel-clear-history) をヘッダに配置している', () => {
    expect(source).toMatch(/data-testid="chat-panel-clear-history"/);
  });

  it('履歴件数上限 MAX_HISTORY_TURNS が定義され、load/save で trim される (DevTools 大量挿入 + sessionStorage 5MB 上限の二重防御)', () => {
    expect(source).toMatch(/MAX_HISTORY_TURNS\s*=\s*\d+/);
    // loadHistory / saveHistory のいずれも MAX_HISTORY_TURNS で trim する。
    const loadFn = source.match(/function\s+loadHistory[\s\S]*?\n}/);
    expect(loadFn).not.toBeNull();
    expect(loadFn![0]).toMatch(/MAX_HISTORY_TURNS/);
    expect(loadFn![0]).toMatch(/slice\(-MAX_HISTORY_TURNS\)/);
    const saveFn = source.match(/function\s+saveHistory[\s\S]*?\n}/);
    expect(saveFn).not.toBeNull();
    expect(saveFn![0]).toMatch(/MAX_HISTORY_TURNS/);
    expect(saveFn![0]).toMatch(/slice\(-MAX_HISTORY_TURNS\)/);
  });

  it('H-5: viewerUserId の変化 (= ユーザ越境) を検知して clearHistory + setTurns([]) を呼ぶ', () => {
    // 同一タブで A → B のユーザ切替シナリオの defense-in-depth。
    expect(source).toMatch(/prevUserIdRef/);
    // viewerUserId の遷移を依存にした useEffect が存在する。
    expect(source).toMatch(
      /useEffect\(\(\)\s*=>\s*\{[\s\S]{0,800}?prev\s*!==\s*viewerUserId[\s\S]{0,400}?clearHistory\(\)/,
    );
    // viewerUserId 依存配列を持つ。
    expect(source).toMatch(/\},\s*\[viewerUserId\]\)/);
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
    expect(codeOnly).toMatch(/中程度の関連/);
    expect(codeOnly).not.toMatch(/関連の可能性/);
  });

  it('strong / weak のセクション label は既存文言を維持', () => {
    expect(source).toMatch(/強く関連/);
    expect(source).toMatch(/弱い関連性/);
  });
});

describe('ChatPanel フクロウの会話文言 invariant (人間味調整)', () => {
  it('初回挨拶は「気になることや知りたいことをチャットしてください」を含む', () => {
    expect(source).toMatch(/気になることや知りたいことをチャットしてください/);
  });

  it('初回挨拶は turns の有無に依存せず常時描画される (turns.length === 0 ガードが撤去されている)', () => {
    // 旧挙動: 質問送信後に挨拶が消える → 新挙動: 挨拶は会話履歴の最上部に固定
    // 🗑️ クリアで turns=[] に戻ったとき、挨拶のみが残る初期状態を再現できる。
    expect(source).toMatch(/data-testid="chat-initial-greeting"/);
    // turns.length === 0 で挨拶を出し分ける条件式が存在しないことを確認。
    expect(source).not.toMatch(/turns\.length\s*===\s*0\s*&&\s*\(\s*<AssistantBubble>/);
  });

  it('検索中の表示は「ちょっと待ってくださいね、過去資産から探しています」', () => {
    expect(source).toMatch(/ちょっと待ってくださいね/);
  });

  it('結果サマリは「N件…見つけました。関連が強い順にご紹介しますね」の文体', () => {
    expect(source).toMatch(/見つけました/);
    expect(source).toMatch(/関連が強い順にご紹介/);
  });

  it('0 件時は「うーん、関連する資産は見つかりませんでした…」の文体', () => {
    expect(source).toMatch(/うーん、関連する資産は見つかりませんでした/);
  });

  it('縮退モード時の文言は「ごめんなさい、AI 機能が一時的に使えないようです」', () => {
    expect(source).toMatch(/ごめんなさい、AI 機能が一時的に使えないようです/);
  });

  it('短いクエリ警告は「もう少し詳しく書いていただけると」の柔らかい表現', () => {
    expect(source).toMatch(/もう少し詳しく書いていただける/);
    // 旧実装の機械的な「クエリが短いと検索精度が下がる可能性があります」は撤去
    expect(source).not.toMatch(/クエリが短いと検索精度が下がる可能性があります/);
  });

  it('プライバシー告知バナーは厳密さを保つため文体維持 (Voyage AI / 機微情報を明示)', () => {
    expect(source).toMatch(/外部 AI サービス \(Voyage AI\)/);
    expect(source).toMatch(/機微情報の入力はお控えください/);
  });
});
