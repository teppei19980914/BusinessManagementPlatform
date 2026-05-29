/**
 * FAQ コンテンツの構造化データ (たすきフクロウ AI チャット用)。
 *
 * 役割:
 *   `/api/help/chat` の system prompt に同梱される FAQ 全文を、構造化された配列として保持する。
 *   FAQ 画面 (help-client.tsx) と AI prompt の **単一信頼ソース** となる設計
 *   ([[project_faq_drives_ai_accuracy]] / docs/developer-guide/FAQ_AND_OWL_CHAT_GUIDE.md)。
 *
 * **★severity-1★ 権限分別の原則 (たすきばのコンセプトの中核)**:
 *   たすきフクロウは「情報流出を防ぐ鍵」のキャラクタ。フクロウ自身は全 FAQ を知っているが、
 *   ユーザのロールに応じて開示してよい情報・してはいけない情報を厳密に分別する。
 *   - 料金体系・課金詳細 → tenant_admin のみ
 *   - プロジェクト参考タブ等の PM/PL 限定機能 → project_pm 以上のみ
 *   - 公開情報 (使い方・データ取扱い等) → 全員
 *   各 FaqEntry の visibleTo で開示範囲を定義し、API レイヤで必ずフィルタした上で AI に渡す。
 *   AI には system prompt で「下記の許可された FAQ 以外の情報源には触れないこと」を強制する。
 *
 * Phase:
 *   PR5 (2026-05-29) では「初期 20 件」を移植。残りの FAQ は後続 PR で追加し、最終的に
 *   help-client.tsx 側を本配列から render するリファクタを PR6 で実施する。
 *   `'project_pm'` 判定 (ProjectMembership からの動的解決) は Phase 2 (PR6) で対応。
 *
 * 文言ルール (詳細は docs/developer-guide/FAQ_AND_OWL_CHAT_GUIDE.md §2):
 *   - 実装一致 (数値・期間・上限は src/config と完全一致)
 *   - 専門用語回避 (embedding / draft / super_admin 等を平易語に)
 *   - 矛盾回避 (既存 FAQ と整合)
 *   - 出典 ID (id) を AI 出力で sourceFaqIds[] として返す
 *
 * 関連:
 *   - help-client.tsx (UI レンダリング)
 *   - help-client.test.ts (drift 検知 invariant)
 *   - /api/help/chat route.ts (本データをロール filter 後に system prompt に同梱)
 *   - KDD §5.X+187 (FAQ drift 検知パターン)
 *   - [[project_mascot_owl]] (フクロウ = 知恵/記憶/守護のキャラクタ)
 */

export type FaqCategory =
  | 'service' // サービスについて
  | 'business' // 業務利用について
  | 'account' // アカウント・ログインについて
  | 'role' // 権限とロールについて
  | 'data' // データとプライバシー
  | 'billing' // 請求と支払いについて (テナント管理者のみ)
  | 'admin' // テナント管理者向け (課金・プラン・席数)
  | 'import'; // 外部データ取込・移行について (テナント管理者のみ)

/**
 * 開示権限のスコープ。**フクロウが情報流出を防ぐ鍵として機能する核**。
 *
 * - `all`: 全員に開示可。使い方・データ取扱い・コンセプト系
 * - `tenant_admin`: テナント管理者 (admin / super_admin 含む) のみ開示可。
 *   料金体系・課金詳細・テナント運営 (席数管理・プラン変更等)
 * - `project_pm`: 少なくとも 1 プロジェクトで PM/PL ロールを持つユーザのみ開示可。
 *   提案エンジン (参考タブ) の動作詳細・プロジェクト編集権限の挙動など。
 *   ※ Phase 2 (PR6 以降): ProjectMembership から動的解決。PR5 では型のみ定義、未使用。
 */
export type FaqVisibleTo = 'all' | 'tenant_admin' | 'project_pm';

export type FaqEntry = {
  /** 出典 ID として AI 出力で sourceFaqIds[] に含まれる。kebab-case で全 FAQ ユニーク */
  id: string;
  category: FaqCategory;
  q: string;
  /** plain text 形式。AI が読みやすいよう改行は \n で表現、HTML タグは含めない */
  a: string;
  visibleTo: FaqVisibleTo;
};

/**
 * ユーザのロール集約 (権限フィルタの入力)。
 * `/api/help/chat` route が auth + DB から構築し、本モジュールの getFaqEntriesForRole に渡す。
 */
export type ViewerRoles = {
  /** tenant_admin / admin / super_admin のいずれか */
  isTenantAdmin: boolean;
  /**
   * 少なくとも 1 プロジェクトで PM/PL ロールを持つか (= project_pm 開示判定)。
   * Phase 2 (PR6) で ProjectMembership から動的解決予定。PR5 では常に false 想定。
   */
  hasAnyProjectPmRole: boolean;
};

/**
 * PR5 初期版: 20 件 (請求 8 + 退会 2 + アカウント 3 + データ 2 + 業務 3 + ロール 1 + 検索 1)。
 * 後続 PR で help-client.tsx の残り FAQ を順次移植する。
 */
export const FAQ_ENTRIES: readonly FaqEntry[] = [
  // ===== billing (PR1 / B-1-a, B-1-b, B-1-c) =====
  {
    id: 'billing-cycle',
    category: 'billing',
    q: 'いつ請求されますか？',
    a: '月末締め → 翌月 25 日 (固定) がお支払い期限です (土日祝に当たる場合は翌営業日)。請求書 PDF は締日の翌月 15 日までにご請求先メールアドレスへ送付されます。',
    visibleTo: 'tenant_admin',
  },
  {
    id: 'mid-month-plan-change',
    category: 'billing',
    q: '月途中でプランを変えたら料金はどうなりますか？',
    a: 'たすきばは「使ったぶんだけ」の従量課金 (1 回ごと) のため、切替前の利用分は切替前の単価、切替後は切替後の単価で計算されます (日割り計算はありません)。Beginner → Expert / Pro と Expert ↔ Pro は切替ボタンを押した瞬間に反映されます。',
    visibleTo: 'tenant_admin',
  },
  {
    id: 'payment-methods',
    category: 'billing',
    q: '支払い方法はクレジットカード以外にありますか？',
    a: '銀行振込 (請求書 PDF 受領) とクレジットカード (Stripe 自動引き落とし) の 2 種類です。新規組織の初期設定は銀行振込で、テナント設定からクレジットカードに変更できます (運営の事情でクレジットカード払いが一時的に選択できない場合があります)。',
    visibleTo: 'tenant_admin',
  },
  {
    id: 'invoice-pdf-download',
    category: 'billing',
    q: '請求書 PDF はどこからダウンロードできますか？',
    a: '銀行振込の場合は毎月 15 日までにご請求先メールアドレス宛に PDF が直接送付されます (ダッシュボード内にダウンロード画面はありません)。クレジットカードの場合は Stripe の請求書 URL がメールに含まれ、そこからダウンロードできます。',
    visibleTo: 'tenant_admin',
  },
  {
    id: 'tax-calculation',
    category: 'billing',
    q: '消費税はどう計算されますか？',
    a: '10% を四捨五入で計算します。請求書には税抜・税込の両方を明記します。',
    visibleTo: 'tenant_admin',
  },
  {
    id: 'beginner-50mb-overage',
    category: 'billing',
    q: 'Beginner プランで DB 容量 50 MB を超えるとどうなりますか？',
    a: '新しいデータの保存・編集ができなくなります (Beginner は無料プランのため、超過しても課金は発生しません)。不要なデータを削除すると 30 秒ほどで空き容量が自動再集計され、書き込みが再開されます。継続的に多く保存したい場合は Expert / Pro へアップグレードしてください。',
    visibleTo: 'tenant_admin',
  },
  {
    id: 'storage-usage-location',
    category: 'billing',
    q: 'DB 容量・ファイル容量はどこで確認できますか？',
    a: 'テナント設定の「使用量」タブで確認できます。ページを開いた瞬間に再集計されるため、削除直後でも実際の容量が反映されます。',
    visibleTo: 'tenant_admin',
  },
  {
    id: 'hard-cap-50gb',
    category: 'billing',
    q: '50 GB のハードキャップに達したら何が起こりますか？',
    a: '全プラン共通で新規データの保存・編集が止まります (エクスポート・既存データ閲覧・削除は引き続き可能)。サービス全体の安定性を守るための上限値で、継続利用には不要データの削除をお願いします。',
    visibleTo: 'tenant_admin',
  },

  // ===== admin (PR1 / B-1-b-1: ダウングレード不可) =====
  {
    id: 'downgrade-prohibition',
    category: 'admin',
    q: 'Expert / Pro から Beginner プランに戻せますか？',
    a: '戻せません。Beginner は試用期間 (90 日) 用のプランで、一度上位プランに上げると同じ組織では使えなくなります。月額の利用をゼロに抑えたい場合は、Expert / Pro のままテナント設定 →「月次予算上限」を ¥0 に設定してください (AI 機能が一時停止し、追加課金が発生しません)。',
    visibleTo: 'tenant_admin',
  },

  // ===== data (PR1 / A-1-1, B-1-b-3, PR2 / B-1-e-1, B-1-e-2) =====
  {
    id: 'tenant-deletion',
    category: 'data',
    q: '退会するとデータはどうなりますか？',
    a: 'プランによって異なります。\n- Beginner: 組織作成から 90 日で読み取り専用、合計 180 日で業務データが自動的に削除されます (削除前に事前メール通知あり)。\n- Expert / Pro: テナント設定の「セルフ解約」を実行すると、解約から約 90 日後に業務データが削除されます。\n削除前にデータが必要な場合は、テナント設定 →「エクスポート」から CSV を取得してください。請求書など法律で保管が必要な記録は別途 5 年間運営側で保管します。',
    visibleTo: 'all',
  },
  {
    id: 'rejoin-after-deletion',
    category: 'data',
    q: '退会したあと、同じ組織で再加入できますか？',
    a: '削除後は新しい組織として作り直す必要があります (組織 ID は再利用できません)。以前の業務データは復元できないため、必要な情報は必ず削除前にエクスポートしてください。',
    visibleTo: 'all',
  },
  {
    id: 'ai-data-sent',
    category: 'data',
    q: 'AI に送られるデータは何ですか？',
    a: '提案エンジンおよびチャット検索のために、次のデータが Anthropic (Claude) と Voyage AI に送信されます: プロジェクトの「目的・背景・スコープ」/ ナレッジ・リスク・課題・振り返り・メモの本文 (公開範囲が下書きでないもの) / チャット検索のクエリ文字列。\n次のデータは送信されません: パスワードなどの認証情報 / 添付ファイルの中身 / コメント本文 / 個人情報 (氏名・メールアドレス) など。',
    visibleTo: 'all',
  },
  {
    id: 'backup-export',
    category: 'data',
    q: 'データのバックアップ・エクスポートはできますか？',
    a: 'テナント管理者は、テナント設定から全データを ZIP 形式で一括エクスポートできます。各一覧画面 (ナレッジ・リスク・課題・振り返り・メモ) の「エクスポート」ボタンから個別の CSV ダウンロードも可能です。退会前のデータ救出にもこの機能をお使いください。',
    visibleTo: 'all',
  },

  // ===== account (PR2 / B-1-d) =====
  {
    id: 'forgot-org-id',
    category: 'account',
    q: '組織 ID を忘れました',
    a: '次のいずれかで確認できます: (1) ログイン画面の「組織 ID」入力欄を空にしてフォーカスすると、過去にログイン成功した組織 ID が最大 5 件・90 日間候補表示されます / (2) 招待時に受信したメール本文「【重要】ログイン情報」セクションに記載 / (3) 同じ組織のメンバー (テナント管理者など) に確認。',
    visibleTo: 'all',
  },
  {
    id: 'password-link-expiry',
    category: 'account',
    q: 'パスワード設定リンクの有効期限はどれくらいですか？',
    a: '招待メールおよびパスワード再設定メールに含まれるリンクは 24 時間で期限切れになります。期限切れの場合、ログイン画面の「パスワードを忘れた方」から再発行してください (一般メンバーで再発行できない場合はテナント管理者に依頼)。',
    visibleTo: 'all',
  },
  {
    id: 'invitation-email-not-received',
    category: 'account',
    q: '招待メールが届きません',
    a: '送信元は noreply@tasukiba.com です。次の順に確認してください:\n1. 迷惑メールフォルダ・スパムフォルダを確認\n2. 会社のメールフィルタで noreply@tasukiba.com を受信許可リストに追加\n3. メールアドレスのスペルミス (テナント管理者の招待画面で確認)\n4. 解決しなければテナント管理者から再招待',
    visibleTo: 'all',
  },

  // ===== business (PR2 / A-2-1, A-2-2, PR3 / A-3-1) =====
  {
    id: 'risk-vs-issue',
    category: 'business',
    q: 'リスクと課題の違いは何ですか？',
    a: 'リスクは「まだ起きていない、起きるかもしれない問題」、課題は「すでに起きていて対応が必要な問題」です。リスクが実際に起こったら、そのリスクは触らず別途「課題」として新規登録するのがおすすめ (リスク側に「警戒した結果」が記録として残り、後の振り返りに役立つため)。',
    visibleTo: 'all',
  },
  {
    id: 'wp-vs-activity',
    category: 'business',
    q: 'WP と Activity はどう使い分ければよいですか？',
    a: 'WP (作業パッケージ) は「大きなまとまり」、Activity はその中の「実際に手を動かす作業 1 単位」です。担当者・予定工数・期間は Activity に設定します (WP には子 Activity の合計が自動表示されます)。\n例: 営業企画プロジェクトで「提案資料作成 (WP)」の中に「スライド設計 / グラフ作成 / 校正 (各 Activity)」を入れる、といった使い方です。1 つの Activity は半日〜1 週間程度に収めると進捗が見やすくなります。',
    visibleTo: 'all',
  },
  {
    id: 'knowledge-vs-retrospective',
    category: 'business',
    q: 'ナレッジと振り返りはどう使い分けますか？',
    a: '振り返りはプロジェクト終了時などに Keep (続けたい) / Problem (困った) / Try (次は工夫する) の 3 視点で経験を整理する場所です。ナレッジは他のプロジェクトでも再利用できそうな業務知識を独立した文書として残す場所です。振り返りの Try で出た工夫のうち、他チームでも使えそうなものをナレッジに切り出すと、組織の財産が貯まります。',
    visibleTo: 'all',
  },

  // ===== role (PR3 / B-2-a-1) =====
  {
    id: 'role-comparison',
    category: 'role',
    q: '運営者 / テナント管理者 / 一般メンバーの違いは？',
    a: '運営者: テナント作成・削除・課金管理 (自社含む全社対応)。テナント管理者: 自社のテナント作成・削除・課金管理 / メンバー招待・ロール変更 / プロジェクト・ナレッジ・課題の作成・編集。一般メンバー: プロジェクト・ナレッジ・課題の作成・編集のみ。他社のデータはいずれのロールでも閲覧不可 (運営者は課金集計のみ確認)。',
    visibleTo: 'all',
  },

  // ===== business / search (PR3 / B-2-c-1) =====
  {
    id: 'chat-search-no-hit',
    category: 'business',
    q: 'チャット検索で結果が 0 件になります',
    a: 'キーワード単体ではなく 50〜200 字程度の文章で、業務文脈や専門用語を含めるとヒットしやすくなります。例:「決済」だけより「クレジットカード決済の API 連携で発生したエラー対応」のように具体的に書くのがコツです。',
    visibleTo: 'all',
  },

  // ===========================================================================
  // PR9 (2026-05-29): 業務操作の具体仕様を網羅する FAQ を 25 件追加
  //   ユーザ指示「CSV カラム ↔ 一覧カラム対応 / visibility=自分のみ にしたい場合は draft 設定」
  //   など、初心者が離脱せず業務を進められる粒度で記述する。
  // ===========================================================================

  // ===== account / MFA =====
  {
    id: 'mfa-setup',
    category: 'account',
    q: 'MFA (二段階認証) を有効化する手順を教えてください',
    a: 'テナント管理者・一般メンバーともに任意で有効化できます (運営者のみ強制)。手順:\n1. ログイン後、画面右上のアカウントメニュー → 設定\n2. 「セキュリティ」セクション →「二段階認証 (MFA) を有効化」ボタン\n3. 画面の QR コードを Google Authenticator / Authy などのアプリで読み取る\n4. アプリに表示される 6 桁コードを入力 → 有効化完了\n5. 表示された「リカバリーコード」を必ず紙またはパスワードマネージャに保存 (端末紛失時の唯一の救済手段)',
    visibleTo: 'all',
  },
  {
    id: 'mfa-recovery-code-lost',
    category: 'account',
    q: 'MFA のリカバリーコードを紛失してログインできません',
    a: '一般メンバーの場合: テナント管理者に依頼し、ユーザ管理画面から「MFA リセット」を実行してもらってください (再設定用メールが届きます)。テナント管理者本人の場合: 公式 LP のお問い合わせフォームから運営にご連絡ください (本人確認後にリセット対応)。リカバリーコードは必ずパスワードマネージャ等に保管してください。',
    visibleTo: 'all',
  },
  {
    id: 'password-strength-requirement',
    category: 'account',
    q: 'パスワードの強度要件は?',
    a: '12 文字以上で、英大文字・英小文字・数字・記号のうち 3 種類以上を含むことが必須です。これらを満たさないパスワードはサインアップ画面でエラーになります。',
    visibleTo: 'all',
  },

  // ===========================================================================
  // ★最重要★ CSV インポート詳細 (テナント管理者の初回ログイン後の離脱防止)
  //   ユーザ指示: 「CSV のどのカラムが一覧のどのカラムに該当するのか、どの値がどの選択肢に
  //   なるのか」をフクロウが具体的に答えられるようにする。
  //   ground truth: docs/public/csv-import-guide.md
  // ===========================================================================
  {
    id: 'import-features-overview',
    category: 'import',
    q: 'たすきばには 3 種類のインポート機能があると聞きました。どれをいつ使えばいいですか?',
    a: '用途に応じて使い分けてください (すべてテナント管理者または各画面の権限保有者のみ):\n\n1. データインポート (ZIP 一括取込) — テナント設定画面の「データインポート」セクション\n   用途: 別のたすきば組織からのテナント移行 / バックアップからの復元\n   対象: ユーザ・ナレッジ・課題・振り返り・メモ・顧客・ステークホルダー等を横断的に一括\n   形式: 本サービスから出力した ZIP ファイル のみ (外部 Excel ZIP は拒否)\n\n2. 外部データ移行ウィザード — テナント設定画面 →「外部データ移行ウィザード」リンク\n   用途: 他社サービスや社内 wiki から既存ナレッジ・課題を初回移行\n   対象: Knowledge と RiskIssue の 2 種類のみ (CSV)\n   制限: 1 ファイル 5,000 行 / 50 MB\n\n3. エンティティ別 sync-import — 各一覧画面 (ナレッジ・リスク・課題等) の「インポート」ボタン\n   用途: 既存データをエクスポート → 編集 → 再取込 (round-trip)\n   対象: 当該エンティティのみ\n   制限: 1 ファイル 500 行 / 10 MB',
    visibleTo: 'tenant_admin',
  },
  {
    id: 'import-zip-tenant',
    category: 'import',
    q: 'テナント設定画面の「データインポート」(ZIP 一括取込) の手順を教えてください',
    a: '本サービスから出力した ZIP を再取込する機能です (バックアップ復元・テナント移行用)。手順:\n1. 事前準備: ページ上部の「データエクスポート」セクション →「📦 全データを ZIP でダウンロード」ボタンで ZIP を取得\n2. 同じテナント設定画面 →「データインポート」セクションへ\n3. 「ZIP ファイル」欄の「ファイルを選択」ボタン → 用意した ZIP を選択\n4. 「インポート実行」ボタン\n5. 結果画面で取り込み件数を確認\n対象: ユーザ・顧客・ステークホルダー・プロジェクト・WBS・ナレッジ・リスク・課題・振り返り・メモ・添付ファイル等 すべての業務データを横断的に取り込みます。\n注意: 受付できるファイルは本サービスから出力した ZIP のみ。Excel ファイル / 独自フォーマットの ZIP は拒否されます (外部システムからの移行は「外部データ移行ウィザード」をご利用ください)。',
    visibleTo: 'tenant_admin',
  },
  {
    id: 'import-external-wizard-where-to-start',
    category: 'import',
    q: '初回ログイン後、社内 wiki や旧 PM ツールの既存ナレッジを CSV で取り込みたい。どこから始めれば?',
    a: 'テナント管理者の方の最初の一歩としておすすめです。「外部データ移行ウィザード」を使います。手順:\n1. 画面右上のアカウントメニュー → 設定 → テナント設定\n2. 「データインポート」セクションの中の黄色い案内ボックスから「外部データ移行ウィザード」リンクをクリック (または直接 /settings/tenant/external-import)\n3. ウィザード上部の「テンプレート CSV (Knowledge / RiskIssue) をダウンロード」を押してテンプレートを取得\n4. Excel でテンプレートを編集 →「CSV UTF-8 (コンマ区切り)」で保存\n5. ウィザードに戻りファイル選択 → マッピング → プレビュー → 取込実行\n料金は全プラン無料 (embedding 生成費用も発生しません)。1 ファイル最大 5,000 行・50 MB まで。',
    visibleTo: 'tenant_admin',
  },
  {
    id: 'import-external-wizard-4steps-detail',
    category: 'import',
    q: '外部データ移行ウィザードの 4 ステップを詳しく教えてください',
    a: 'Step 1: ファイル選択\n  ① 用意した CSV を「ファイルを選択」ボタンで指定\n  ② 取り込むエンティティを「Knowledge」または「RiskIssue」から選択\n  ③ RiskIssue の場合: 全行を所属させる「デフォルトプロジェクト」を選択\n  ④「次へ (マッピング設定) →」ボタン\n\nStep 2: カラムマッピング\n  ① CSV の各列を、サービス側のフィールドにプルダウンで対応付け\n  ② 必須フィールド (Knowledge は title/background/content/result、RiskIssue は type/title/content/impact/priority) を必ずマッピング\n  ③ 任意フィールド (visibility / knowledgeType / impact 等) もマッピング可能 (空欄は既定値が入る)\n  ④「プレビューを表示 →」ボタン\n\nStep 3: プレビュー (取込前確認)\n  ① 取込予定の各行が表示される\n  ② エラー行が「エラー N 行」と表示されたら CSV を修正 (詳細は別 FAQ「プレビューで『エラー N 行』」)\n  ③ 内容を確認したら「📥 取込実行」ボタン\n\nStep 4: 結果\n  ① 取込成功件数とエラー件数が表示される\n  ② 失敗した行があれば原因と一緒に表示されるので、CSV を修正して再取込\n各ステップで前に戻ることもできます。取込実行ボタンを押すまでデータは入りません。',
    visibleTo: 'tenant_admin',
  },
  {
    id: 'import-sync-import-where',
    category: 'import',
    q: 'エンティティ別 sync-import (各一覧画面のインポート) はどう使いますか?',
    a: '各エンティティ一覧画面の右上「インポート」ボタンから利用できる「往復編集」用の機能です (一般メンバー以上、自分が作ったデータのみ)。手順:\n1. 一覧画面 (ナレッジ・リスク・課題・振り返り・メモ等) の「エクスポート」ボタンで既存データの CSV をダウンロード\n2. Excel で編集 (一括更新・追加)\n3. 同じ一覧画面の「インポート」ボタンで CSV をアップロード\n4. ID 列がある行は既存データを上書き、ID 列がない行は新規作成\n制限: 1 ファイル 500 行 / 10 MB。階層エンティティ (WBS のタスク) は親エンティティ名で重複判定されるため、テキストエディタで確認してから取り込んでください。',
    visibleTo: 'all',
  },
  {
    id: 'csv-knowledge-required-fields',
    category: 'import',
    q: 'Knowledge (ナレッジ) CSV の必須カラムは何ですか?',
    a: '必須カラムは 4 つです: \n- title (タイトル、短い件名)\n- background (背景、複数行可)\n- content (内容、本文、複数行可)\n- result (結果、起きた結果・結論、複数行可)\nその他に任意カラム (knowledgeType / conclusion / recommendation / reusability / devMethod / techTags / processTags / businessDomainTags / visibility) があります。任意カラムは空欄でも構いません。',
    visibleTo: 'tenant_admin',
  },
  {
    id: 'csv-knowledge-type-values',
    category: 'import',
    q: 'Knowledge CSV の knowledgeType カラムには何を入れればいいですか?',
    a: '次の 5 つの値のいずれか (半角小文字):\n- failure: 失敗事例\n- success: 成功事例\n- lesson: 教訓・気づき\n- template: テンプレート (再利用可能な雛形)\n- general: 一般的なナレッジ (既定値)\n空欄にすると general として扱われます。「Failure」「FAILURE」のような大文字混在はエラーになるため、必ず半角小文字で記入してください。',
    visibleTo: 'tenant_admin',
  },
  {
    id: 'csv-knowledge-visibility-mapping',
    category: 'import',
    q: 'Knowledge CSV で公開範囲を「自分のみ」にしたいです。どのカラムにどの値?',
    a: 'visibility カラムに次のいずれかを設定します (Knowledge の場合):\n- draft → 「自分のみ」(他のメンバーから見えない、提案エンジンの対象外、課金対象外)\n- project → 「プロジェクト内」(関係メンバーのみに公開)\n- company → 「全メンバー (公開)」(全社員に公開、提案エンジン候補に並ぶ。既定値)\n空欄の場合は company (全メンバー公開) になります。「自分のみ」にしたい行は明示的に draft と書いてください。',
    visibleTo: 'tenant_admin',
  },
  {
    id: 'csv-riskissue-required-fields',
    category: 'import',
    q: 'RiskIssue (リスク・課題) CSV の必須カラムは何ですか?',
    a: '必須カラムは 5 つです:\n- type: risk (リスク) または issue (課題)\n- title: 短い件名\n- content: 本文 (複数行可)\n- impact: 影響度 (low / medium / high)\n- priority: 優先度 (low / medium / high)\n任意カラム: cause / likelihood / responsePolicy / responseDetail / deadline / state / lessonLearned / visibility / riskNature / projectId\nprojectId はマッピング無しの場合、ステップ 1 で選んだ「デフォルトプロジェクト」に全行が所属します。',
    visibleTo: 'tenant_admin',
  },
  {
    id: 'csv-riskissue-type-values',
    category: 'import',
    q: 'RiskIssue の type カラムは何を入れる?',
    a: '半角小文字の risk または issue です。\n- risk: まだ起きていない、起きるかもしれない問題 (= リスク)\n- issue: すでに起きていて対応が必要な問題 (= 課題)\n「Risk」「ISSUE」のような大文字混在はエラーになります。',
    visibleTo: 'tenant_admin',
  },
  {
    id: 'csv-riskissue-visibility-mapping',
    category: 'import',
    q: 'RiskIssue CSV で公開範囲を設定したい。どのカラムにどの値?',
    a: 'visibility カラムに次のいずれかを設定します (RiskIssue は 2 段階):\n- draft → 「自分のみ」(既定値、提案エンジン対象外、課金対象外)\n- public → 「公開」(提案エンジンの候補に並ぶ)\n空欄の場合は draft (自分のみ) になります。Knowledge と違って RiskIssue には company / project がないことに注意。',
    visibleTo: 'tenant_admin',
  },
  {
    id: 'csv-impact-priority-likelihood-values',
    category: 'import',
    q: 'impact / priority / likelihood カラムに入れる値は?',
    a: '3 つとも共通で、半角小文字の low / medium / high のいずれかです。\n- low: 低い\n- medium: 中程度\n- high: 高い\n「High」「中」「High Priority」など、大文字混在・日本語・記号付きはエラーになります。Excel のドロップダウンリスト機能を使うと入力ミスを防げます。',
    visibleTo: 'tenant_admin',
  },
  {
    id: 'csv-date-format',
    category: 'import',
    q: 'CSV の日付 (deadline) はどう書けばいいですか?',
    a: '必ず YYYY-MM-DD のハイフン区切り (例: 2026-12-31)。\n- ❌ 2026/12/31 (スラッシュ) はエラー\n- ❌ 12-31-2026 (米国式) はエラー\n- ❌ 令和8年12月31日 (和暦) はエラー\nExcel は日付セルを自動的にスラッシュ表示に変換することがあるので、セル書式を「文字列」に変更してから入力するか、CSV 保存後にメモ帳で確認してください。',
    visibleTo: 'tenant_admin',
  },
  {
    id: 'csv-multiline-cells',
    category: 'import',
    q: 'background / content / result など、改行を含む長文セルはどう書く?',
    a: '改行を含むセルは必ず全体をダブルクォート ("...") で囲んでください。改行を入れたい位置で、Excel なら Alt + Enter (Mac は Option + 改行)、CSV を直接編集する場合は普通に改行を入れます。\n例 (CSV 直接編集):\ntitle,content\n"提案資料の作り方","1. テンプレートを開く\n2. 顧客情報を入力\n3. 提案内容を記入"\nExcel で保存する際に自動でクォートが付かない場合があるので、保存後にメモ帳で開いてダブルクォートが入っているか確認してください。',
    visibleTo: 'tenant_admin',
  },
  {
    id: 'csv-encoding',
    category: 'import',
    q: 'CSV の文字コードは何にすればいい?',
    a: '必ず UTF-8 (BOM 付きでも無しでも可) です。Excel の既定保存形式 Shift_JIS では日本語が文字化けします。Excel での保存手順:\n1. 「ファイル」→「名前を付けて保存」\n2. ファイル形式のドロップダウンから「CSV UTF-8 (コンマ区切り) (*.csv)」を選択\n3. 保存\nWindows / Mac とも同じ手順です。',
    visibleTo: 'tenant_admin',
  },
  {
    id: 'csv-tags-syntax',
    category: 'import',
    q: 'techTags / processTags / businessDomainTags は CSV にどう書く?',
    a: '1 つのセル内で**カンマ区切り** にしてください。複数タグは半角カンマで区切ります。\n例: techTags 列に `react,nextjs,prisma`\n例: processTags 列に `要件定義,設計,テスト`\nセル全体に半角カンマが含まれるため、セルをダブルクォートで囲む必要があります (Excel が自動で囲んでくれます)。',
    visibleTo: 'tenant_admin',
  },
  {
    id: 'csv-row-and-file-limits',
    category: 'import',
    q: 'CSV は何行まで取り込めますか? ファイルサイズ上限は?',
    a: '外部データ移行ウィザード (テナント管理者専用): 1 ファイル最大 5,000 行 / ファイルサイズ 50 MB / 全プラン無料。\nエンティティ別 sync-import (各一覧画面の「インポート」ボタン): 1 ファイル 500 行 / 10 MB。\n5,000 行を超える場合は複数ファイルに分割して取り込んでください。',
    visibleTo: 'tenant_admin',
  },
  {
    id: 'csv-error-recovery',
    category: 'import',
    q: 'プレビュー画面で「エラー N 行」と表示された。実データには入っていますか?',
    a: '取込実行前のため、データはまだ入っていません。よくあるエラーと対処:\n- 「必須フィールドが空」→ Excel で該当行の値を入力\n- 「knowledgeType は failure/success/lesson/template/general のいずれか」→ 半角小文字で表のいずれかに修正\n- 「impact は low/medium/high のいずれか」→ 大文字混在を半角小文字に修正\n- 「deadline が YYYY-MM-DD 形式ではありません」→ スラッシュ区切りからハイフン区切りに修正\n- 「取込後にナレッジ本文の 2 行目以降が消えている」→ 改行セルがダブルクォートで囲まれていない可能性。CSV をメモ帳で確認',
    visibleTo: 'tenant_admin',
  },

  // ===========================================================================
  // プラン変更 / 月次予算上限 (テナント管理者の運営作業)
  // ===========================================================================
  {
    id: 'plan-upgrade-procedure',
    category: 'admin',
    q: 'Beginner から Expert / Pro にアップグレードする手順を教えてください',
    a: '手順 (テナント管理者のみ):\n1. テナント設定画面を開く (画面右上アカウントメニュー → 設定 → テナント設定)\n2. 「プラン情報」セクションを開く\n3. 「Expert にアップグレード」または「Pro にアップグレード」ボタンを押す\n4. 確認ダイアログで「アップグレードする」をクリック\n5. その瞬間に新プランが反映されます (日割り計算なし)\n以降の操作は新単価 (Expert: ¥10/回、Pro: ¥15/回) で課金されます。Beginner には戻せないので、月額を抑えたい場合は「月次予算上限」を ¥0 に設定してください。',
    visibleTo: 'tenant_admin',
  },
  {
    id: 'budget-cap-setting',
    category: 'admin',
    q: '月次予算上限を設定する手順を教えてください',
    a: 'Expert / Pro プランの方が利用できる機能です。手順:\n1. テナント設定 → 「課金・プラン」セクション\n2. 「月次予算上限」入力欄に円単位で金額を設定 (例: 10000)\n3. 「保存」ボタン\n設定額に達するとプロジェクト作成・更新の AI 機能が一時停止し、想定外の請求を防ぎます。データの作成・編集は引き続き可能ですが、新規データが提案エンジンに反映されません。翌月 1 日に自動でリセットされます。 ¥0 に設定すると AI 機能の追加課金が一切発生しない運用も可能です。',
    visibleTo: 'tenant_admin',
  },
  {
    id: 'beginner-90day-timeline',
    category: 'admin',
    q: 'Beginner プラン (無料試用) のタイムラインを教えてください',
    a: '組織作成からの経過日数別の挙動:\n- 0〜59 日: 通常運用、すべての機能を利用可能\n- 60 日: 期限警告メール送信 (通常運用継続)\n- 75 日: 期限警告メール再送 (通常運用継続)\n- 90 日: 読み取り専用モードに移行 (閲覧・エクスポート・アップグレード・セルフ解約のみ可能)\n- 150 日: 自動削除 30 日前予告メール\n- 170 日: 最終警告メール (10 日前)\n- 180 日: 業務データが自動的に物理削除 (ログイン不可、復旧不可)\n継続利用の場合は 90 日経過前に Expert / Pro へアップグレードしてください。',
    visibleTo: 'tenant_admin',
  },

  // ===========================================================================
  // メンバー招待 (テナント管理者の運営作業)
  // ===========================================================================
  {
    id: 'invite-member-procedure',
    category: 'admin',
    q: 'メンバーを招待する手順を教えてください',
    a: '手順 (テナント管理者のみ):\n1. 画面右上のアカウントメニュー → 「ユーザ管理」\n2. 「メンバーを招待」ボタン\n3. 招待先のメールアドレスと付与するロール (テナント管理者 / 一般メンバー) を入力\n4. 「招待を送信」ボタン\n相手にパスワード設定リンク付きの招待メールが noreply@tasukiba.com から届きます (有効期限 24 時間)。届かない場合は迷惑メールフォルダを確認するか、再招待してください。',
    visibleTo: 'tenant_admin',
  },
] as const;

/**
 * カテゴリ別ラベル (UI 表示用、AI prompt にも含める)。
 */
export const FAQ_CATEGORY_LABELS: Record<FaqCategory, string> = {
  service: 'サービスについて',
  business: '業務利用について',
  account: 'アカウント・ログインについて',
  role: '権限とロールについて',
  data: 'データとプライバシー',
  billing: '請求と支払いについて',
  admin: 'テナント管理者向け (課金・プラン・席数)',
  import: '外部データ取込・移行について',
};

/**
 * ★severity-1★ ユーザロールに応じてフィルタした FAQ を返す。
 *
 * **必ず API レイヤで本関数を通してから AI に渡すこと**。直接 FAQ_ENTRIES を渡すと
 * 一般ユーザに料金詳細が漏洩する。フクロウの「情報流出を防ぐ鍵」コンセプトの実装核。
 *
 * 開示ロジック:
 *   - `all`: 全員
 *   - `tenant_admin`: viewer.isTenantAdmin が true のときのみ
 *   - `project_pm`: viewer.hasAnyProjectPmRole が true のときのみ
 *     (= 少なくとも 1 プロジェクトで PM/PL ロールを持つ場合)
 */
export function getFaqEntriesForRole(viewer: ViewerRoles): readonly FaqEntry[] {
  return FAQ_ENTRIES.filter((e) => {
    if (e.visibleTo === 'all') return true;
    if (e.visibleTo === 'tenant_admin') return viewer.isTenantAdmin;
    if (e.visibleTo === 'project_pm') return viewer.hasAnyProjectPmRole;
    return false; // 未知の visibleTo は fail-closed (デフォルト非開示)
  });
}

/**
 * id で FAQ を引く (sourceFaqIds[] からの逆引き / deep link 解決用)。
 *
 * **注意**: 本関数は権限フィルタを行わない。呼び出し側で必ず getFaqEntriesForRole の
 * 結果と照合してから露出すること (sourceFaqId が viewer の権限スコープ内に含まれるか確認)。
 */
export function getFaqEntryById(id: string): FaqEntry | undefined {
  return FAQ_ENTRIES.find((e) => e.id === id);
}

/**
 * AI prompt に同梱する FAQ 全文の plain text 表現を生成。
 * 形式: 「[id] (カテゴリ) Q: ... / A: ...」を改行で区切る。
 *
 * **必ず viewer に応じてフィルタ済みの FAQ のみを渡す**。AI に「許可外の質問には
 * 『その内容は◯◯ロールの方にお尋ねください』と返す」よう system prompt で指示すること。
 */
export function buildFaqPromptSection(viewer: ViewerRoles): string {
  const entries = getFaqEntriesForRole(viewer);
  return entries
    .map(
      (e) =>
        `[${e.id}] (${FAQ_CATEGORY_LABELS[e.category]})\nQ: ${e.q}\nA: ${e.a}`,
    )
    .join('\n\n');
}

/**
 * 開示が拒否された理由を AI に教える「ロール外質問用ガイダンス」を生成。
 * system prompt の末尾に含めることで、AI が「料金は tenant_admin にお尋ねください」等を
 * 自動で返せるようにする。
 */
export function buildRoleGuardancePromptSection(viewer: ViewerRoles): string {
  const denied: string[] = [];
  if (!viewer.isTenantAdmin) {
    denied.push(
      '- 料金体系・課金詳細・テナント運営 (席数管理・プラン変更・解約等) はテナント管理者のみが知ることができます。一般ユーザから質問されたら「申し訳ありません、料金や運営の詳細はテナント管理者の方にお尋ねください」とお答えしてください。',
    );
  }
  if (!viewer.hasAnyProjectPmRole) {
    denied.push(
      '- 提案エンジン (参考タブ) の動作詳細やプロジェクト編集の挙動など、PM/PL 限定機能の質問には「申し訳ありません、その機能の詳細は PM/PL ロールの方にお尋ねください」とお答えしてください。',
    );
  }
  if (denied.length === 0) {
    // ★severity-2★ fail-open 防御 (PR9): AI に「制限なし」と明示すると、
    //   prompt injection で「全権限ユーザだから何でも答えていい」と誤認させやすい。
    //   常に「下記の許可された FAQ/ガイドにある情報のみを答える」と中立的に伝える。
    return '本ユーザのロールに対する追加の開示制限はありませんが、回答は常に下記の許可された FAQ と使い方ガイドにある情報のみを根拠としてください。';
  }
  return [
    '★重要★ あなたは「情報流出を防ぐ鍵」の役割を持ちます。下記の開示制限を必ず守ってください:',
    ...denied,
    '上記の制限対象について質問されたら、回答本文に該当する情報を一切含めず (具体的な金額・期間・上限値・操作手順なども一切出さず)、「申し訳ありません、(ロール) の方にお尋ねください」とのみ返答してください。',
  ].join('\n');
}
