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
