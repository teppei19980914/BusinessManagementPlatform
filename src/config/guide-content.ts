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

  // ============================================================================
  // PR9 (2026-05-29): テナント管理者の初回ログイン離脱防止のための詳細手順
  //   ユーザ指示: 「特にシステム管理者が初回ログインしたとき、データインポート手順は
  //   具体的にたすきフクロウが返答してあげると離脱防止になる」
  //   ground truth: docs/public/account-setup-guide.md / csv-import-guide.md
  // ============================================================================

  {
    id: 'tenant-admin-first-day',
    audience: 'admin',
    title: '★テナント管理者の初日★ 組織開設後にやるべき 4 つのステップ',
    body: '組織を作成した直後にこの順番で進めると、メンバーがすぐ業務に入れる状態を作れます。\n\nStep 1: 自分の MFA 有効化 (任意だが推奨)\n  画面右上のアカウントメニュー → 設定 →「セキュリティ」セクション →「二段階認証を有効化」\n  → 認証アプリで QR コード読取 → 6 桁コード入力 → 表示されたリカバリーコードを必ず保管\n\nStep 2: メンバーを招待する\n  画面右上のアカウントメニュー →「ユーザ管理」→「メンバーを招待」ボタン\n  → メールアドレスとロール (テナント管理者 / 一般メンバー) を入力 → 送信\n  招待メール (noreply@tasukiba.com) が届かなければ迷惑メール確認・再招待\n\nStep 3: 既存ナレッジ・課題を CSV で取込\n  社内 wiki / 旧 PM ツールに蓄積したデータがあれば、テナント設定 →「外部データ移行ウィザード」\n  から一括取込 (詳しい手順は別ガイドステップ「外部データ移行ウィザード 6 ステップ」参照)\n\nStep 4: 月次予算上限を設定 (Expert / Pro のみ)\n  テナント設定 →「課金・プラン」→「月次予算上限」に金額を入力 →「保存」\n  予期せぬ請求を防げます。¥0 を設定すれば AI 機能の追加課金は一切発生しません。',
    visibleTo: 'tenant_admin',
  },

  {
    id: 'external-import-wizard-full-walkthrough',
    audience: 'admin',
    title: '★詳細ガイド★ 外部データ移行ウィザード — CSV で既存ナレッジ・課題を一括取込',
    body: '社内 wiki / 旧 PM ツール / Excel に蓄積した既存データを、6 ステップで一括取込します。料金は全プラン無料 (embedding 生成費用も発生しません)。\n\n【事前準備】\n- Knowledge と RiskIssue のテンプレート CSV をウィザード上部からダウンロード\n- Excel で内容を編集 →「CSV UTF-8 (コンマ区切り)」で保存 (Shift_JIS は文字化けするので必ず UTF-8)\n- 1 ファイル 5,000 行 / 50 MB まで\n\n【ウィザード手順】\n\nStep 1: テナント管理者でログイン → 設定画面を開く\n  対象者: テナント管理者のみ。一般メンバーには「データインポート」セクションが見えません。\n\nStep 2: 外部データ移行ウィザードを開く\n  テナント設定 →「データインポート」セクション → 黄色い案内ボックスの「外部データ移行ウィザード」リンク\n\nStep 3: ファイル選択\n  ① 用意した CSV を「ファイルを選択」で指定\n  ② エンティティを「Knowledge」または「RiskIssue」から選択\n  ③ RiskIssue の場合は「全行を所属させるデフォルトプロジェクト」を選択 (projectId 列を CSV にマッピングしない場合の保険)\n  ④「次へ (マッピング設定) →」\n\nStep 4: カラムマッピング\n  CSV の各列を、サービス側のフィールドにプルダウンで対応付ける画面です。\n  必須フィールド (Knowledge: title / background / content / result / RiskIssue: type / title / content / impact / priority) を必ずマッピング\n  任意フィールド (visibility / knowledgeType / impact 等) もマッピング可能。空欄は既定値が入ります\n  →「プレビューを表示 →」\n\nStep 5: プレビュー (取込前確認)\n  取込予定の各行が表示されます。「エラー N 行」と表示されたら CSV を修正してください (大文字混在 / スラッシュ日付 / 改行セルのクォート抜け が代表例)。\n  「📥 取込実行」ボタンを押すまでデータは入りません。\n\nStep 6: 結果\n  取込件数と失敗件数が表示されます。失敗行があれば原因とともに表示されるので、CSV を修正して再取込してください。\n\n【公開範囲の指定】\n- Knowledge の visibility カラム: draft (自分のみ) / project (プロジェクト内) / company (全メンバー、既定)\n- RiskIssue の visibility カラム: draft (自分のみ、既定) / public (公開)\nCSV の visibility 列で行ごとに設定可能。取込後に各データの編集画面から個別に変更もできます。',
    visibleTo: 'tenant_admin',
  },

  {
    id: 'zip-tenant-import-walkthrough',
    audience: 'admin',
    title: 'データインポート (ZIP 一括取込) — バックアップ復元 / テナント移行用',
    body: '本サービスから出力した ZIP ファイルを使って、テナント全体のデータ (ユーザ・顧客・ステークホルダー・プロジェクト・WBS・ナレッジ・リスク・課題・振り返り・メモ・添付ファイル等) を横断的に一括復元する機能です。\n\n手順:\n1. 事前準備: ページ上部の「データエクスポート」セクション →「📦 全データを ZIP でダウンロード」で ZIP を取得\n2. 同じテナント設定画面の下部「データインポート」セクションへ\n3. 「ZIP ファイル」欄の「ファイルを選択」ボタン → 用意した ZIP を選択\n4. 「インポート実行」ボタン\n5. 結果画面で取り込み件数を確認\n\n注意:\n- 本サービスから出力した ZIP のみ受付。外部 Excel ファイル / 独自フォーマットの ZIP は拒否されます\n- 外部システムからの初回移行は「外部データ移行ウィザード」(CSV) をご利用ください\n- ZIP は別のテナント (組織) 間の移行にも使えるため、解約前のバックアップ → 別組織での復元という運用が可能',
    visibleTo: 'tenant_admin',
  },

  {
    id: 'mfa-setup-walkthrough',
    audience: 'all',
    title: 'MFA (二段階認証) を有効化する手順',
    body: 'セキュリティ向上のため、業務開始前の有効化を推奨します。テナント管理者・一般メンバーともに任意で有効化可能 (運営者のみ強制)。\n\n手順:\n1. ログイン後、画面右上のアカウントメニュー → 設定\n2. 「セキュリティ」セクション →「二段階認証 (MFA) を有効化」ボタン\n3. 画面に QR コードが表示される → Google Authenticator / Microsoft Authenticator / Authy などのアプリで読み取る\n4. アプリに表示される 6 桁コードを画面の入力欄に入力 → 有効化完了\n5. 表示された「リカバリーコード」を必ず保管 (紙またはパスワードマネージャ)\n  端末紛失・アプリ削除時の唯一の救済手段です。リカバリーコードを紛失すると、テナント管理者または運営によるリセットが必要になります。\n\n以降のログイン時には、メールアドレス + パスワードの後にアプリの 6 桁コード入力が求められます。',
    visibleTo: 'all',
  },

  {
    id: 'invite-member-walkthrough',
    audience: 'admin',
    title: 'メンバーを招待する手順',
    body: 'テナント管理者のみが実行可能です。\n\n手順:\n1. 画面右上のアカウントメニュー → 「ユーザ管理」\n2. 「メンバーを招待」ボタン\n3. 招待先のメールアドレスを入力\n4. ロールを選択\n   - テナント管理者: 課金・プラン管理・メンバー招待ができる (1 組織複数人 OK)\n   - 一般メンバー: プロジェクト・ナレッジ・課題の作成・編集のみ\n5. 「招待を送信」ボタン\n\n招待先には noreply@tasukiba.com からパスワード設定リンク付きメールが届きます (有効期限 24 時間)。\n届かない場合:\n- 迷惑メールフォルダを確認\n- 会社のメールフィルタで noreply@tasukiba.com を許可リストに追加\n- メールアドレスのスペルミス確認\n- 必要なら「メンバーを再招待」ボタンで再送 (60 秒クールダウン)',
    visibleTo: 'tenant_admin',
  },

  {
    id: 'plan-upgrade-walkthrough',
    audience: 'admin',
    title: 'Beginner から Expert / Pro にアップグレードする手順',
    body: '手順 (テナント管理者のみ):\n1. テナント設定画面を開く (画面右上アカウントメニュー → 設定 → テナント設定)\n2. 「プラン情報」セクションを開く\n3. 「Expert にアップグレード」または「Pro にアップグレード」ボタンを押す\n4. 確認ダイアログで内容を確認 (新単価が表示される) →「アップグレードする」\n5. その瞬間に新プランが反映されます (日割り計算なし)\n\n以降の操作は新単価で課金されます:\n- Expert: ¥10/回 (プロジェクト作成・更新)\n- Pro: ¥15/回 (プロジェクト作成・更新 +「なぜ参考になる?」機能)\n\n注意:\n- Beginner には戻せません (ADR-0013)。月額を抑えたい場合は「月次予算上限」を ¥0 に設定してください\n- Expert ↔ Pro は双方向に即時切替可能 (こちらも日割りなし)',
    visibleTo: 'tenant_admin',
  },

  {
    id: 'budget-cap-walkthrough',
    audience: 'admin',
    title: '月次予算上限を設定する手順 (Expert / Pro)',
    body: '予期せぬ請求を防ぐため、月の API 利用額に上限を設定できます。\n\n手順 (テナント管理者のみ、Expert / Pro プランで利用可能):\n1. テナント設定 → 「課金・プラン」セクション\n2. 「月次予算上限」入力欄に円単位で金額を設定 (例: 10000)\n3. 「保存」ボタン\n\n挙動:\n- 設定額に達した時点で「縮退モード」に切替 → プロジェクト作成・更新の AI 機能が一時停止\n- データの作成・編集は引き続き可能、ただし新規データが提案エンジンに反映されません\n- 検索精度がやや下がりますが、業務継続は可能\n- 翌月 1 日に自動でリセット → 通常運用に復帰\n- 即時復活したい場合は予算上限を引き上げてください\n\n¥0 に設定する運用も可能で、その場合は AI 機能の追加課金が一切発生しません (Beginner 相当の運用)。',
    visibleTo: 'tenant_admin',
  },

  {
    id: 'self-cancellation-walkthrough',
    audience: 'admin',
    title: 'テナント (組織) をセルフ解約する手順',
    body: 'テナント管理者本人がいつでも解約できます。\n\n手順:\n1. テナント設定画面を開く\n2. 画面下部の「セルフ解約」セクション (アコーディオン形式)\n3. 解約理由を選択 (任意、品質改善のため運営に共有されます)\n4. 「テナントを解約する」ボタン\n5. 確認ダイアログで「本当に解約する」をクリック\n\n解約後の挙動:\n- 即座に読み取り専用モードに移行 (ログイン・閲覧・エクスポートのみ可能)\n- 解約日から約 90 日後に業務データが物理削除されます (復元不可)\n- 必要なデータがあれば、削除前に必ずテナント設定の「データエクスポート」(ZIP) を実行してください\n- 請求書など法律で保管が必要な記録は別途 5 年間運営側で保管\n\n解約をやめたい場合は猶予期間中に「解約取消」ボタンで撤回できます。',
    visibleTo: 'tenant_admin',
  },

  {
    id: 'csv-edit-cheatsheet',
    audience: 'admin',
    title: '★Excel で CSV を編集するときの注意点★ — 文字化け / 改行 / 日付',
    body: 'CSV インポート (外部データ移行ウィザード / sync-import 共通) で失敗を防ぐための Excel 操作のコツです。\n\n1. 必ず UTF-8 で保存\n  「ファイル」→「名前を付けて保存」→ ファイル形式から「CSV UTF-8 (コンマ区切り) (*.csv)」を選択\n  既定の Shift_JIS では日本語が文字化けします。Windows / Mac とも同じ手順。\n\n2. 改行を含むセルの書き方\n  改行を入れたい位置で Alt + Enter (Mac は Option + 改行) を押す\n  Excel が自動的にセル全体をダブルクォート (") で囲んでくれるはずですが、念のため保存後にメモ帳で開いてクォートが入っているか確認してください。\n  ダブルクォートが抜けると、取込後に本文の 2 行目以降が消える事故が起こります。\n\n3. 日付は YYYY-MM-DD ハイフン区切り\n  Excel は日付セルを自動で「2026/12/31」表示にしてしまうため:\n  - 該当列を選択 →「セルの書式設定」→「分類: 文字列」に変更してから入力\n  - または保存後にメモ帳で確認・修正\n\n4. 選択肢の値は半角小文字\n  impact / priority / likelihood = low / medium / high\n  knowledgeType = failure / success / lesson / template / general\n  visibility = draft / project / company (Knowledge) or draft / public (RiskIssue)\n  type = risk / issue (RiskIssue のみ)\n  reusability = high / medium / low\n  devMethod = waterfall / agile / hybrid\n  riskNature = threat / opportunity (RiskIssue の type=risk のみ)\n  大文字混在 / 日本語 / 全角はエラーになります。\n\n5. 複数タグはカンマ区切り\n  techTags / processTags / businessDomainTags は 1 セル内で半角カンマ区切り (例: react,nextjs,prisma)\n  半角カンマを含むセルは自動的にダブルクォートで囲まれます',
    visibleTo: 'tenant_admin',
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
