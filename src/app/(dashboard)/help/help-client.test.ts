/**
 * HelpClient のソースパターン回帰テスト (feat/mascot-owl 2026-05-27)。
 *
 * vitest 設定 environment='node' のため、AppHeader と同じく source-pattern (ファイル内容を
 * 文字列として読み込んで matcher を当てる) でユーザに見せる要素の存在 invariant を担保する。
 * help-client.tsx は React レンダリングを伴うため、機能テストは Playwright (e2e) に委ねる。
 *
 * 担保対象:
 *   - 「サービスについて」FAQ カテゴリ存在
 *   - マスコット FAQ 質問文・たすきフクロウの紹介・public/mascot-owl.png の参照
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CLIENT_FILE = join(__dirname, 'help-client.tsx');
const source = readFileSync(CLIENT_FILE, 'utf8');

describe('HelpClient のマスコット FAQ invariant (feat/mascot-owl 2026-05-27)', () => {
  it('「サービスについて」カテゴリが存在する', () => {
    expect(source).toMatch(/<FaqCategory\s+title="サービスについて">/);
  });

  it('マスコットを問う質問 (フクロウ言及) を 1 件以上含む', () => {
    // ユーザがヘッダー / favicon の正体を調べたときに /help で確実に答えに辿り着けることを担保。
    expect(source).toMatch(/q="[^"]*フクロウ[^"]*"/);
  });

  it('回答内に "たすきフクロウ" の名前と 3 軸 (知恵 / 記憶 / 夜でも見守る) の象徴を含む', () => {
    expect(source).toMatch(/たすきフクロウ/);
    expect(source).toMatch(/知恵/);
    expect(source).toMatch(/記憶/);
    expect(source).toMatch(/夜でも見守る/);
  });

  it('next/image を import し /mascot-owl.png を表示する', () => {
    // モバイルでも視認できるよう Image コンポーネントで配信。
    expect(source).toMatch(/from\s+'next\/image'/);
    expect(source).toMatch(/src="\/mascot-owl\.png"/);
  });

  it('Image に unoptimized を付与しない (Optimizer 経由 / KDD §5.X+177 真原因 = middleware redirect)', () => {
    // KDD §5.X+177: 当初 `unoptimized` で回避したが、真原因は middleware redirect。
    //   middleware fix 後は Optimizer 経由で payload 最適化された配信を default とする。
    expect(source).not.toMatch(/unoptimized\b/);
  });
});

/**
 * PR1 (feat/faq-pr1-urgent-billing-fix 2026-05-29):
 *   緊急性の高い FAQ 13 件 (退会データ / 再加入 / 請求 5 件 / プラン変更 / DB 上限 3 件 / シードデータ修正)
 *   が help-client.tsx に存在し、かつ過去の実装乖離文言 (Grace 30 日 / Phase 2 テナント分離) が
 *   再混入していないことを担保する。
 *
 *   実装根拠:
 *     - account-setup-guide.md:380 (Beginner 180 日ルール)
 *     - beginner-expiry.service.ts:43-51 (Day 90/180 マイルストーン)
 *     - PAYMENT_TERMS.md §1.1 (25 日固定 / 銀行振込 + クレカ)
 *     - suggestion.service.ts:184-221 (seedDataEnabled フラグ)
 *     - src/config/db-capacity-pricing.ts (50 GB ハードキャップ)
 */
describe('HelpClient PR1 緊急 FAQ invariant (退会 / 請求 / 容量)', () => {
  it('退会 FAQ がプラン別の正確な期間を含む (Beginner 180 日 / Expert・Pro セルフ解約 + 90 日)', () => {
    // A-1-1: 旧「30 日 Grace」誤記の再混入防止と、新仕様 (Beginner Day 180 / Expert・Pro セルフ解約) の存在担保。
    expect(source).toMatch(/q="退会するとデータはどうなりますか？"/);
    expect(source).toMatch(/180 日/);
    expect(source).toMatch(/セルフ解約/);
    // 旧誤記 (30 日 Grace) が完全に消えていることを確認。
    expect(source).not.toMatch(/30 日間の Grace/);
  });

  it('再加入 FAQ が「同じ組織で復元できない」旨を明示', () => {
    expect(source).toMatch(/q="退会したあと、同じ組織で再加入できますか？"/);
    expect(source).toMatch(/組織 ID は再利用できません/);
  });

  it('「請求と支払いについて」FaqCategory に 8 件 (請求 5 + 容量 3) が含まれる', () => {
    // B-1-a-1〜5 + B-1-c-1〜3
    expect(source).toMatch(/<FaqCategory[^>]*title="請求と支払いについて[^"]*"/);
    expect(source).toMatch(/q="いつ請求されますか？"/);
    expect(source).toMatch(/q="月途中でプランを変えたら料金はどうなりますか？"/);
    expect(source).toMatch(/q="支払い方法はクレジットカード以外にありますか？"/);
    expect(source).toMatch(/q="請求書 PDF はどこからダウンロードできますか？"/);
    expect(source).toMatch(/q="消費税はどう計算されますか？"/);
    expect(source).toMatch(/q="Beginner プランで DB 容量 50 MB を超えるとどうなりますか？"/);
    expect(source).toMatch(/q="DB 容量・ファイル容量はどこで確認できますか？"/);
    expect(source).toMatch(/q="50 GB のハードキャップに達したら何が起こりますか？"/);
  });

  it('請求サイクル文言が「翌月 25 日固定」「土日祝に当たる場合は翌営業日」を含む', () => {
    // PAYMENT_TERMS.md §1.1 と同期。誤った日付 (毎月 1 日 / 月末払い等) が混入しないこと。
    expect(source).toMatch(/翌月 25 日/);
    expect(source).toMatch(/土日祝に当たる場合は翌営業日/);
  });

  it('Pro/Expert → Beginner 戻せない FAQ が存在し、月次予算上限 ¥0 運用を案内', () => {
    // B-1-b-1: ADR-0013 と beginnerEverUpgraded フラグの整合。
    expect(source).toMatch(/q="Expert \/ Pro から Beginner プランに戻せますか？"/);
    expect(source).toMatch(/月次予算上限」を ¥0/);
  });

  it('シードデータ参照 FAQ から旧「Phase 2」文言が削除されている', () => {
    // A-1-2: suggestion.service.ts では seedDataEnabled フラグで実装済。Phase 2 という社内用語は不要。
    expect(source).toMatch(/q="シードデータ \(運営が用意した参考事例\) を使いたくありません"/);
    expect(source).not.toMatch(/Phase 2 テナント分離適用後/);
  });
});

/**
 * PR2 (feat/faq-pr2-clarity-rewrite 2026-05-29):
 *   非エンジニア向け平易化 6 件 (WP/Activity / KPT / 提案エンジン / PR #470 追加 / 他テナント / 月次予算)
 *   + 新規 5 件 (アカウント・ログイン 3 件 / データ AI 送信 / バックアップ)。
 *   過去の専門用語 (集約タスク / KPT 形式 / 意味的類似度 / embedding / 特徴量 / 認可境界 / 縮退モード / HTTP 200) が
 *   完全に消えていることを担保する。
 */
describe('HelpClient PR2 専門用語書き直し invariant', () => {
  it('WP/Activity FAQ に実業務例 (営業企画) と「半日〜1 週間」表現を含む', () => {
    expect(source).toMatch(/営業企画プロジェクト/);
    expect(source).toMatch(/半日〜1 週間/);
    expect(source).not.toMatch(/集約タスク/);
    expect(source).not.toMatch(/0\.5〜5 人日/);
  });

  it('ナレッジ/振り返り FAQ で KPT を「Keep \\(続けたい\\) / Problem \\(困った\\) / Try \\(次は工夫する\\)」と展開', () => {
    expect(source).toMatch(/Keep \(続けたい\)/);
    expect(source).toMatch(/Problem \(困った\)/);
    expect(source).toMatch(/Try \(次は工夫する\)/);
    // 旧「KPT 形式」のみの記述が残っていないこと
    expect(source).not.toMatch(/KPT 形式/);
  });

  it('提案エンジン FAQ に「より高機能な AI」と ADR-0026 由来の「数秒〜のタイムラグ」言及を含む', () => {
    expect(source).toMatch(/より高機能な AI/);
    expect(source).toMatch(/数秒〜のタイムラグ/);
    // 旧専門用語の除去
    expect(source).not.toMatch(/意味的類似度ベース/);
    expect(source).not.toMatch(/Claude Sonnet 生成/);
  });

  it('PR #470 追加 3 件の「特徴量」「private」などの専門表現が消えている', () => {
    // A-2-3b: 「特徴量」→「検索用データ」、「private」→「自分のみ」へ平易化
    expect(source).not.toMatch(/意味検索用の特徴量/);
    expect(source).not.toMatch(/下書き \/ private/);
    expect(source).toMatch(/検索用データ/);
  });

  it('他テナント情報 FAQ から「最上位の認可境界」「super_admin」を排除', () => {
    expect(source).not.toMatch(/最上位の認可境界/);
    expect(source).not.toMatch(/super_admin/);
    expect(source).toMatch(/テナント \(= 会社\) ごとにデータは完全に分かれて/);
  });

  it('月次予算超過 FAQ から「縮退モード」「HTTP 200」「タグ：テキスト = 5：5」を排除', () => {
    expect(source).not.toMatch(/縮退モード/);
    expect(source).not.toMatch(/HTTP 200/);
    expect(source).not.toMatch(/タグ：テキスト = 5：5/);
    expect(source).toMatch(/AI 機能の一部が一時停止/);
  });
});

describe('HelpClient PR2 新規 FAQ 5 件 invariant', () => {
  it('「アカウント・ログインについて」FaqCategory が新設され 3 件の Q を含む', () => {
    expect(source).toMatch(/<FaqCategory title="アカウント・ログインについて">/);
    expect(source).toMatch(/q="組織 ID を忘れました"/);
    expect(source).toMatch(/q="パスワード設定リンクの有効期限はどれくらいですか？"/);
    expect(source).toMatch(/q="招待メールが届きません"/);
    // 重要数値: 90 日 (履歴) / 24 時間 (リンク期限)
    expect(source).toMatch(/最大 5 件・90 日間/);
    expect(source).toMatch(/24 時間で期限切れ/);
    // 送信元アドレス明示
    expect(source).toMatch(/noreply@tasukiba\.com/);
  });

  it('「AI に送られるデータ」FAQ が送信対象/非送信対象を両方明示', () => {
    expect(source).toMatch(/q="AI に送られるデータは何ですか？"/);
    expect(source).toMatch(/Anthropic \(Claude\) と Voyage AI/);
    // 非送信対象の明示 (信頼確保)
    expect(source).toMatch(/パスワードなどの認証情報/);
    expect(source).toMatch(/添付ファイルの中身/);
    expect(source).toMatch(/コメント本文/);
  });

  it('「バックアップ・エクスポート」FAQ がテナント設定 ZIP + 個別 CSV 経路を明示', () => {
    expect(source).toMatch(/q="データのバックアップ・エクスポートはできますか？"/);
    expect(source).toMatch(/ZIP 形式で一括エクスポート/);
    expect(source).toMatch(/個別の CSV ダウンロード/);
  });
});

/**
 * PR3 (feat/faq-pr3-medium-priority 2026-05-29):
 *   中優先度 16 件: 書き直し 4 件 (リスク/課題 / プラン表形式 / CSV Excel 補足 / Expert↔Pro 切替)
 *   + 新規 12 件 (権限ロール 3 / プロジェクト運用 3 / 検索提案 3 / visibility 3)。
 *   ADR-0013 ダウングレード禁止と整合した文言で「ダウングレード (Pro → Beginner)」記述を排除。
 */
describe('HelpClient PR3 書き直し 4 件 invariant', () => {
  it('リスクと課題 FAQ から「顕在化」「ブロッカー」が消え平易表現になっている', () => {
    expect(source).not.toMatch(/顕在化/);
    expect(source).not.toMatch(/ブロッカー/);
    expect(source).toMatch(/まだ起きていない、起きるかもしれない問題/);
    expect(source).toMatch(/警戒した結果/);
  });

  it('プラン違い FAQ が表形式化され「基本 AI」「高機能 AI」表現を使用', () => {
    expect(source).toMatch(/q="プラン \(Beginner \/ Expert \/ Pro\) の違いは？"/);
    expect(source).toMatch(/基本 AI \(Claude Haiku\)/);
    expect(source).toMatch(/高機能 AI \(Claude Sonnet\)/);
    // 旧箇条書きの記述は撤去
    expect(source).not.toMatch(/プロジェクト作成\/更新が 50 回到達すると当該機能のみ縮退/);
  });

  it('CSV エラー対処 FAQ に Excel 補足 (CSV UTF-8 保存 / Alt + Enter) を含む', () => {
    expect(source).toMatch(/CSV UTF-8 \(コンマ区切り\) \(\*.csv\)/);
    expect(source).toMatch(/Alt \+ Enter/);
    expect(source).toMatch(/Option \+ 改行/);
  });

  it('「ダウングレード (Pro → Beginner)」FAQ を撤去し「Expert と Pro の切替」に置換', () => {
    expect(source).not.toMatch(/q="ダウングレード \(Pro → Beginner\) は即時反映されますか？"/);
    expect(source).toMatch(/q="Expert と Pro の切替はいつ反映されますか？"/);
    expect(source).toMatch(/切替ボタンを押した瞬間に即時反映/);
  });
});

describe('HelpClient PR3 新規 12 件 invariant', () => {
  it('「権限とロールについて」FaqCategory が新設され 3 件の Q を含む (表形式の比較)', () => {
    expect(source).toMatch(/<FaqCategory title="権限とロールについて">/);
    expect(source).toMatch(/q="運営者 \/ テナント管理者 \/ 一般メンバーの違いは？"/);
    expect(source).toMatch(/q="自分のロールはどこで確認できますか？"/);
    expect(source).toMatch(/q="退職者が担当していたナレッジ・課題はどう引き継ぎますか？"/);
    expect(source).toMatch(/担当者 \(assignee\) を別のメンバーに付け替える/);
  });

  it('業務利用カテゴリにプロジェクト運用 3 件 (誤削除 / closed / テンプレ複製) が追加', () => {
    expect(source).toMatch(/q="プロジェクトを誤って削除しました、復元できますか？"/);
    expect(source).toMatch(/q="終了 \(closed\) したプロジェクトは編集できますか？"/);
    expect(source).toMatch(/q="プロジェクトをテンプレートから複製できますか？"/);
    expect(source).toMatch(/削除後 <strong>30 日以内/);
  });

  it('業務利用カテゴリに検索/提案 3 件 (ヒット 0 / draft / なぜ機能キャッシュ) が追加', () => {
    expect(source).toMatch(/q="チャット検索で結果が 0 件になります"/);
    expect(source).toMatch(/q="「下書き \/ 自分のみ」のデータも提案に出てきますか？"/);
    expect(source).toMatch(/q="「なぜ参考になる\?」ボタンは押すたびに ¥15 課金されますか？"/);
    expect(source).toMatch(/50〜200 字程度の文章で、業務文脈や専門用語を含める/);
    expect(source).toMatch(/2 回目以降はキャッシュから表示され、追加課金は発生しません/);
  });

  it('データとプライバシーカテゴリに visibility 3 件 (使い分け / 後から変更 / @メンション個人メモ) が追加', () => {
    expect(source).toMatch(/q="ナレッジの公開範囲 \(下書き \/ プロジェクト内 \/ 全メンバー\) はどう使い分けますか？"/);
    expect(source).toMatch(/q="公開範囲を後から変更できますか？"/);
    expect(source).toMatch(/q="@メンションした個人メモは相手から見えますか？"/);
    // visibility=draft が提案対象外であることを明示
    expect(source).toMatch(/提案エンジン対象外/);
  });
});

/**
 * PR4 (feat/faq-pr4-low-priority-and-docs 2026-05-29):
 *   低優先 4 件 (通知 / メール通知範囲 / 推奨ブラウザ / 利用規約) + docs 同期 (account-setup-guide / E2E_COVERAGE / KDD §5.X+187)。
 *   通知 ON/OFF 設定は未実装、メール通知は招待 + Beginner 期限警告のみ等、未実装の事実を正確に明示。
 */
describe('HelpClient PR4 低優先 4 件 invariant', () => {
  it('「通知が来ません」FAQ が @メンション通知のみと未実装の事実を明示', () => {
    expect(source).toMatch(/q="通知が来ません"/);
    expect(source).toMatch(/@メンションされた時のみ/);
    expect(source).toMatch(/通知の ON\/OFF 設定機能は現時点でありません/);
  });

  it('「メール通知はありますか？」FAQ が招待 + Beginner 期限警告のみと明示', () => {
    expect(source).toMatch(/q="メール通知はありますか？"/);
    expect(source).toMatch(/招待メールと Beginner プラン期限警告/);
    // 全 5 マイルストーン (60/75/90/150/170) を含む
    expect(source).toMatch(/60 日 \/ 75 日 \/ 90 日 \/ 150 日 \/ 170 日/);
  });

  it('「推奨ブラウザ / スマホ」FAQ が主要 4 ブラウザ + レスポンシブ対応を明示', () => {
    expect(source).toMatch(/q="推奨ブラウザは何ですか？スマートフォンでも使えますか？"/);
    expect(source).toMatch(/Chrome \/ Edge \/ Safari \/ Firefox/);
    expect(source).toMatch(/レスポンシブ対応/);
  });

  it('「利用規約・プライバシーポリシー」FAQ が LP 公式 URL を明示', () => {
    expect(source).toMatch(/q="利用規約・プライバシーポリシーはどこにありますか？"/);
    expect(source).toMatch(/teppei19980914\.github\.io\/HomePage\/ja\/product\/tasukiba-user\/#terms/);
  });
});
