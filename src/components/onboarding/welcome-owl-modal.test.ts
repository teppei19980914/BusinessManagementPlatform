/**
 * G2-e-3 / G2-e-4 (2026-05-31): オンボーディング (たすきフクロウ ウェルカム) の
 * source-pattern 回帰テスト。React 描画は Playwright (e2e) に委ね、ここではユーザに見せる
 * 要素・権限ガード・once ガードの存在 invariant を文字列マッチで担保する
 * (app-header.test.ts / help-client.test.ts と同じ手法)。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(
  join(__dirname, 'welcome-owl-modal.tsx'),
  'utf8',
);

describe('WelcomeOwlModal 導線ハブ invariant', () => {
  it('4 つの導線 CTA を備える (チャット / 使い方ガイド / FAQ / Discord)', () => {
    expect(source).toMatch(/たすきフクロウに聞いてみる/);
    expect(source).toMatch(/使い方ガイド/);
    expect(source).toMatch(/よくある質問/);
    expect(source).toMatch(/コミュニティ（Discord）をのぞいてみる/);
    expect(source).toMatch(/案内を閉じる/);
  });

  it('チャット CTA は FAB を開く (requestOpenHelpChat / 画面遷移しない)', () => {
    expect(source).toMatch(/requestOpenHelpChat/);
  });

  it('ガイド/FAQ は GUIDE_ROUTE / HELP_ROUTE、Discord は getDiscordInviteUrl を使う', () => {
    expect(source).toMatch(/GUIDE_ROUTE/);
    expect(source).toMatch(/HELP_ROUTE/);
    expect(source).toMatch(/getDiscordInviteUrl/);
  });

  it('再表示ボタンの案内文をモーダル本文に含む', () => {
    expect(source).toMatch(/はじめてのご案内をもう一度見る/);
  });
});

describe('WelcomeOwlAutoOpen 自動表示ガード invariant (★severity★ 最小権限・once)', () => {
  it('初回ログイン (isFirstTimeUser) のときのみ対象にする', () => {
    expect(source).toMatch(/isFirstTimeUser/);
  });

  it('運営者 (super_admin) は自動表示・再表示の対象外', () => {
    expect(source).toMatch(/super_admin/);
  });

  it('当セッション once ガード + ユーザ ID 分離の sessionStorage キーを持つ', () => {
    expect(source).toMatch(/tasukiba_onboarding_welcome_shown_v1/);
    // ユーザ ID と突合して再表示を抑止する (別ユーザログイン時のクロスオーバー防止)
    expect(source).toMatch(/shownFor === userId/);
  });

  it('once ガードは「開いた時」ではなく「閉じた時」に書く (transient 再マウントで一瞬出て消えるのを防ぐ)', () => {
    // dismiss 時 (onOpenChange(false)) にのみ setItem する handler を持つ。
    expect(source).toMatch(/handleOpenChange/);
    // setItem は「閉じる方向 (!next)」の分岐内にあること。
    expect(source).toMatch(/if \(!next && userId\)[\s\S]*?setItem\(SHOWN_STORAGE_KEY, userId\)/);
    // 自動表示の effect 内では setItem しない (= 開いた瞬間に guard を立てない)。
    const effectBody = source.slice(
      source.indexOf('useEffect(() => {'),
      source.indexOf('  }, [status, userId, systemRole, isFirstTimeUser]);'),
    );
    expect(effectBody).not.toMatch(/setItem/);
  });

  it('認証済 (status === "authenticated") を確認してから評価する', () => {
    expect(source).toMatch(/authenticated/);
  });
});
