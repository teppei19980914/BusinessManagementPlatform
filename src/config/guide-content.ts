/**
 * 使い方ガイドコンテンツの構造化データ (たすきフクロウ AI チャット用)。
 *
 * 役割:
 *   `/api/help/chat` の system prompt に同梱されるガイド全文を、構造化された配列として保持する。
 *   FAQ (faq-content.ts) と並列で AI に渡され、「使い方を教えて」系の手順質問への回答精度を上げる。
 *
 * **権限分別**: ガイドコンテンツは基本的に「サービスの使い方」のため全員に開示するが、
 *   PM/PL 限定機能の手順 (visibleTo='project_pm') や管理者業務 (visibleTo='tenant_admin')
 *   が含まれる場合は FaqEntry と同じ visibleTo 制御を適用する。
 *
 * Phase:
 *   PR5 (2026-05-29) は主要 8 ステップを移植。残りは PR6 以降で追加。
 *
 * 関連:
 *   - guide-client.tsx (UI レンダリング)
 *   - faq-content.ts (権限フィルタの ViewerRoles を共有)
 *   - /api/help/chat route.ts (本データを system prompt に同梱)
 */

import type { FaqVisibleTo, ViewerRoles } from './faq-content';

export type GuideStep = {
  /** 出典 ID として AI 出力で sourceGuideStepIds[] に含まれる */
  id: string;
  /** 想定ロール (UI 表示用、AI prompt にも含める) */
  audience: 'all' | 'admin' | 'pm' | 'member';
  /** ステップタイトル */
  title: string;
  /** 手順本文 (plain text、改行は \n) */
  body: string;
  visibleTo: FaqVisibleTo;
};

/**
 * PR5 初期版 8 ステップ: 基本フロー (テナント作成 → プロジェクト → ナレッジ → 振り返り) + 主要機能。
 */
export const GUIDE_STEPS: readonly GuideStep[] = [
  {
    id: 'getting-started',
    audience: 'all',
    title: 'たすきばの基本的な使い方',
    body: 'たすきばは「プロジェクト管理 + ナレッジ管理 + AI 提案エンジン」を組み合わせた業務プラットフォームです。基本フロー:\n1. プロジェクトを作成 (PM/PL ロール)\n2. リスク・課題を登録して進捗管理\n3. 振り返りで Keep/Problem/Try を整理\n4. 再利用できる工夫はナレッジに昇格\n5. 次のプロジェクトで提案エンジンが過去事例を自動表示',
    visibleTo: 'all',
  },
  {
    id: 'invite-members',
    audience: 'admin',
    title: 'メンバーを招待する',
    body: '画面右上のアカウントメニュー → ユーザ管理 →「メンバーを招待」ボタンから、メールアドレスとロール (テナント管理者 / 一般メンバー) を指定して招待します。招待メールは noreply@tasukiba.com から送信され、パスワード設定リンクは 24 時間で期限切れになります。届かない場合は迷惑メールフォルダを確認してください。',
    visibleTo: 'tenant_admin',
  },
  {
    id: 'create-project',
    audience: 'pm',
    title: 'プロジェクトを作成する',
    body: '画面左メニュー「プロジェクト一覧」→ 右上「新規作成」ボタン。必須項目: プロジェクト名 / 顧客名 / 開始予定日 / 終了予定日 / PM/TL。「目的・背景・スコープ」を充実させると AI による提案エンジンの精度が上がります。',
    visibleTo: 'all',
  },
  {
    id: 'add-knowledge',
    audience: 'all',
    title: 'ナレッジを登録する',
    body: '画面左メニュー「ナレッジ」→「新規作成」。タイトルと本文を入力し、公開範囲を選んで保存します。\n- 下書き (自分のみ): まだ整理中のメモ。提案エンジンには出ません\n- プロジェクト内: 関係メンバーのみに公開\n- 全メンバー: 全社に公開、他プロジェクトの提案エンジンの候補にも並ぶ\n公開範囲を「下書き → 全メンバー」に変更した瞬間に AI が検索用データを作成するため、提案エンジンに反映されるまで数秒〜のタイムラグがあります。',
    visibleTo: 'all',
  },
  {
    id: 'manage-risks-issues',
    audience: 'all',
    title: 'リスクと課題を管理する',
    body: 'プロジェクト詳細画面の「リスク」「課題」タブから登録します。リスクは「まだ起きていない、起きるかもしれない問題」、課題は「すでに起きていて対応が必要な問題」として使い分けてください。リスクが実際に起こったら、そのリスクは触らず別途「課題」として新規登録するのがおすすめです (リスク側に「警戒した結果」が記録として残るため)。',
    visibleTo: 'all',
  },
  {
    id: 'retrospective',
    audience: 'all',
    title: '振り返りを実施する',
    body: 'プロジェクト詳細画面の「振り返り」タブから登録します。Keep (続けたい) / Problem (困った) / Try (次は工夫する) の 3 視点で経験を整理します。Try で出た工夫のうち、他チームでも使えそうなものはナレッジに切り出すと、組織の財産が貯まります。',
    visibleTo: 'all',
  },
  {
    id: 'suggestion-engine',
    audience: 'pm',
    title: '提案エンジン (参考タブ) を使う',
    body: 'プロジェクト詳細画面の「参考」タブには、今のプロジェクトと内容が似ている過去のリスク・課題・ナレッジ・振り返りが AI によって自動表示されます。自社内のデータと、運営が用意した参考事例 (シードデータ) の両方を検索します。「強く関連」「中程度の関連」「弱い関連性」の 3 段階で並びます。Pro プランでは「なぜ参考になる?」ボタンで詳しい関連性の説明が出ます (同じ組み合わせで 2 回目以降は無料)。',
    visibleTo: 'project_pm',
  },
  {
    id: 'chat-semantic-search',
    audience: 'all',
    title: 'チャット意味検索 (画面右下のフクロウ)',
    body: '画面右下のフクロウアイコンをクリックすると、過去資産 (プロジェクト・ナレッジ・リスク・課題・振り返り・メモ) を意味検索できます。キーワード単体ではなく 50〜200 字程度の文章で、業務文脈や専門用語を含めるとヒットしやすくなります。例:「決済」だけより「クレジットカード決済の API 連携で発生したエラー対応」のように具体的に書くのがコツです。',
    visibleTo: 'all',
  },
] as const;

/**
 * ユーザロールに応じてフィルタしたガイドを返す (faq-content.ts と同じ ViewerRoles を共有)。
 */
export function getGuideStepsForRole(viewer: ViewerRoles): readonly GuideStep[] {
  return GUIDE_STEPS.filter((s) => {
    if (s.visibleTo === 'all') return true;
    if (s.visibleTo === 'tenant_admin') return viewer.isTenantAdmin;
    if (s.visibleTo === 'project_pm') return viewer.hasAnyProjectPmRole;
    return false; // fail-closed
  });
}

/**
 * id でガイドを引く (sourceGuideStepIds[] からの逆引き用)。
 * **権限フィルタなし**: 呼び出し側で必ず getGuideStepsForRole の結果と照合すること。
 */
export function getGuideStepById(id: string): GuideStep | undefined {
  return GUIDE_STEPS.find((s) => s.id === id);
}

/**
 * AI prompt に同梱するガイド全文の plain text 表現を生成。
 * 形式: 「[id] (対象ロール) タイトル: ... / 手順: ...」を改行で区切る。
 */
export function buildGuidePromptSection(viewer: ViewerRoles): string {
  const steps = getGuideStepsForRole(viewer);
  return steps
    .map(
      (s) =>
        `[${s.id}] (対象: ${s.audience})\nタイトル: ${s.title}\n手順: ${s.body}`,
    )
    .join('\n\n');
}
