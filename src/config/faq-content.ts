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
 * ★severity-1★ 厳格な最小権限 (least privilege)。実権限は check-permission.ts の
 * ROLE_PERMISSIONS に基づいて付与すること (画面で実行できない操作の手順を、その操作を
 * 実行できないロールに開示しない)。フクロウ単体では権限を理解できないため、ここで明示した
 * タグが唯一の開示根拠となる。
 *
 * 開示段 (階層内包: all ⊆ project_member ⊆ project_pm。tenant_admin は systemRole 軸で別建て):
 * - `all`: 全員に開示可。サービス概要・ログイン/アカウント・MFA・データ取扱い・コンセプト系
 * - `project_member`: 少なくとも 1 プロジェクトで member 以上 (member / pm_tl) のユーザのみ。
 *   課題・リスク・ナレッジの作成、タスク進捗更新など「作業者として実行する操作」の手順。
 *   viewer のみ / 未所属ユーザには開示しない (check-permission.ts: risk:create 等は member+ のみ)。
 * - `project_pm`: 少なくとも 1 プロジェクトで PM/PL (pm_tl) ロールを持つユーザのみ。
 *   提案エンジン (参考タブ)・ステークホルダータブ・プロジェクト作成/編集・プロジェクトへの
 *   メンバー割当など (check-permission.ts: stakeholder:* / project:create 等は pm_tl+ のみ)。
 * - `tenant_admin`: テナント管理者 (admin / super_admin) のみ。
 *   料金体系・課金詳細・新規ユーザ招待・CSV 外部移行ウィザード・テナント運営。
 *
 * 複数プロジェクトで異なるロールを持つユーザは「最大ロール」を採用 (guide-role.service.ts と整合)。
 */
// ★単一ソース★ 開示段の全値。型 (FaqVisibleTo) とランタイム検証 (check-faq-embeddings-sync.ts の
//   VALID_VISIBLE_TO) の両方をこの 1 箇所から導出する。段を追加するときはここだけ更新すれば、
//   型・CI 構造チェック・SQL マッピングが一貫する (project_member 追加時に検証許可リスト更新を
//   漏らし CI fail した反省。新段追加時の更新漏れを構造的に防ぐ)。
export const FAQ_VISIBLE_TO_VALUES = [
  'all',
  'project_member',
  'project_pm',
  'tenant_admin',
] as const;

export type FaqVisibleTo = (typeof FAQ_VISIBLE_TO_VALUES)[number];

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
   * 少なくとも 1 プロジェクトで PM/PL (pm_tl) ロールを持つか (= project_pm 開示判定)。
   * ProjectMember から動的解決 (help/chat route が算出)。
   */
  hasAnyProjectPmRole: boolean;
  /**
   * 少なくとも 1 プロジェクトで member 以上 (member / pm_tl) のメンバーシップを持つか
   * (= project_member 開示判定)。viewer のみ / 未所属は false。
   * ProjectMember から動的解決 (help/chat route が算出)。
   */
  hasAnyProjectMembership: boolean;
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
    q: 'データ容量・ファイル容量に上限はありますか？大量に蓄積しても保存は止まりませんか？',
    a: '累積容量に上限はありません (2026-05-31 改定)。Expert / Pro プランでは、蓄積したデータがどれだけ増えても従量課金 (DB 1GB ごと ¥50・ファイル 1GB ごと ¥10) が続くだけで、保存・編集・アップロードが止まることはありません (「データはたすきばの命」)。\n1 回の登録 (作成・更新) で送れる本文は DB 5MB まで、1 ファイルは 50MB までという上限はありますが、これは 1 回の操作でサーバにかかる瞬間的な負荷を抑えるためのもので、累積容量とは無関係です。\nなお Beginner プランのみ、無料枠 (DB 50MB / ファイル 100MB) を超えると新規作成・更新・アップロードが止まります (削除は可能、課金は発生しません)。継続利用には Expert / Pro へのアップグレードをご検討ください。',
    visibleTo: 'tenant_admin',
  },
  // ADR-0030 (2026-05-30): データ容量 (DB) とファイルストレージの違いを明示する FAQ。
  //   2 つの従量課金軸 (DB 容量 = テキストデータ / ファイルストレージ = 添付ファイル本体) を
  //   一般ユーザにも分かりやすく説明し、データの保存場所を理解する助けにする。
  //   category: 'data' (= 一般公開可能、データ構造の話。具体的な料金額は billing カテゴリで tenant_admin 限定に維持)。
  {
    id: 'db-vs-storage-distinction',
    category: 'data',
    q: 'データ容量 (DB) とファイルストレージの違いは何ですか？',
    a: '保存される対象が異なります。\n- **データ容量 (DB)**: テキスト系データを保存する PostgreSQL の容量を指します。プロジェクトの目的・背景・スコープ、ナレッジ・リスク・課題・振り返り・メモの本文、URL・リンクのテキスト、コメント、タグ等は全てここに含まれます。\n- **ファイルストレージ**: 添付ファイル本体 (PDF / Excel / Word / 画像 等) を保存する Supabase Storage の容量を指します。**ファイルそのもの**だけが対象で、ファイル名やコメント等のテキスト情報は DB 側に入ります。\n料金体系の詳細はテナント管理者にお問い合わせください。',
    visibleTo: 'all',
  },
  {
    id: 'storage-links-and-urls',
    category: 'data',
    q: 'リンクや URL はどちらの容量に含まれますか？',
    a: 'URL・リンクは **テキストデータ** のため、**データ容量 (DB)** にカウントされます。「ファイルへのリンク」「外部 URL」「Markdown のリンク記法」等もすべて DB 側です。ファイル本体 (PDF/Excel 等を添付ファイル機能でアップロードしたもの) のみが **ファイルストレージ** にカウントされます。',
    visibleTo: 'all',
  },
  {
    id: 'storage-attachment-files',
    category: 'data',
    q: 'PDF / Excel / 画像はどちらの容量に含まれますか？',
    a: '添付ファイル機能でアップロードした **ファイル本体** は **ファイルストレージ** にカウントされます (Supabase Storage に保存)。ただし、ファイル名・説明文・コメント等のテキスト情報は **データ容量 (DB)** 側に入ります。Markdown のテキスト中に画像を埋め込んだ場合 (= 画像 URL の参照のみ) は DB 側だけがカウント対象です。',
    visibleTo: 'all',
  },
  // ADR-0030 (2026-05-30): Embedding 月次予算上限 (= tenant_admin 限定 / billing カテゴリ)。
  {
    id: 'embedding-monthly-budget-cap',
    category: 'billing',
    q: 'Embedding の月次予算上限はどう設定しますか？',
    a: 'Expert / Pro プランのテナント管理者は、設定 → テナント → 「使用量」タブ → 「Embedding 生成回数」セクション直下のフォームから、金額単位 (円/月) で上限を設定できます。上限超過時は新規 embedding 生成のみ自動停止しますが、既存 embedding を使ったチャット意味検索や提案エンジンは継続利用可能です。生成失敗した分は月初の自動補完バッチで次月の枠で生成されます。LLM (プロジェクト作成・なぜ?機能) 用の予算上限とは独立で管理されます。',
    visibleTo: 'tenant_admin',
  },
  // Beginner Embedding 100 件試用上限は service カテゴリ (= 全プラン共通の使い方説明、一般公開可能)。
  {
    id: 'beginner-embedding-monthly-limit',
    category: 'service',
    q: 'Beginner プランで Embedding は無制限ですか？',
    a: 'Beginner プランは Embedding を **月 100 件まで** 利用できます (ADR-0030 / 2026-05-30)。資産入力・チャット意味検索・CSV インポート (100 件取込でも 1 件としてカウント)・添付ファイル索引化が対象です。100 件到達後は新規 embedding 生成が当月停止し、月初の自動リセット、または Expert / Pro プランへのアップグレードで復活します。チャット意味検索 (= 既存 embedding を使う検索) や提案エンジンは上限到達後も継続利用可能です。',
    visibleTo: 'all',
  },
  // ADR-0030 (2026-05-30): 「今月請求金額」セクションの説明 (tenant_admin 限定 / billing)。
  {
    id: 'monthly-billing-total',
    category: 'billing',
    q: '今月の請求金額はどこで確認できますか？',
    a: '設定 → テナント → 「請求」タブの先頭にある「今月請求金額」セクションで確認できます。LLM 費用 / Embedding 費用 / DB 容量超過 (想定) / ファイルストレージ超過 (想定) の 4 内訳と合計 (税抜) を表示します。DB 容量・ファイルストレージは月中ピーク値に基づく想定請求額のため、月末の自動集計で確定値に置き換わります。',
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

  // ===========================================================================
  // G1-a (2026-05-31): docs/public 全面リフレッシュを根拠に「初めて使う人の疑問」を拡充。
  //   開示段は roles-permissions-guide.md / check-permission.ts の実権限に厳格準拠。
  //   - 最初の一歩 (ロール別)・しくみ概念・作業者向け操作・PM 向け機能・容量課金。
  //   出典: about.md / account-setup-guide.md / project-creation-guide.md /
  //         concepts-guide.md / roles-permissions-guide.md / db-capacity-billing-guide.md /
  //         file-storage-billing-guide.md / risk-issue-guide.md / knowledge-guide.md /
  //         my-tasks-guide.md / suggestion-guide.md / stakeholder-guide.md
  // ===========================================================================

  // ----- all: 最初の一歩 (ロール非依存の道案内) + しくみ概念 -----
  {
    id: 'getting-started-what-to-do',
    category: 'business',
    q: 'ログインしました。まず何をすればいいですか？',
    a: 'あなたの役割によって最初の一歩が変わります。\n- プロジェクトを任されている方: 画面左メニューの「プロジェクト一覧」から担当プロジェクトを開いて内容を確認しましょう。\n- 作業を担当する方: 画面右上メニューの「マイタスク」で自分の担当作業を確認しましょう。\n- まだ何も割り当てられていない方: 管理者からプロジェクトに招待されるのを待つか、「使い方ガイド」で全体像をつかんでください。\n迷ったときは、画面右下のたすきフクロウ (🦉アイコン) に話しかけるか、「使い方ガイド」「よくある質問」をご覧ください。',
    visibleTo: 'all',
  },
  {
    id: 'db-vs-file-storage-concept',
    category: 'data',
    q: '「DB容量」と「ファイルストレージ」は何が違うのですか？',
    a: '保存先と中身が違います。\n- DB容量: 入力した文字データ (プロジェクトの目的・ナレッジ本文・コメント・タグ・URL の文字列など) を集計します。\n- ファイルストレージ: 添付したファイル本体 (PDF・Excel・画像など) を集計します。\nURL リンクは「文字」なので DB容量、ファイルをアップロードした場合だけファイルストレージに数えられます。それぞれの無料枠や料金については、テナント管理者の方にご確認ください。',
    visibleTo: 'all',
  },
  {
    id: 'semantic-search-vs-fulltext',
    category: 'business',
    q: 'たすきばの検索はキーワード検索と何が違うのですか？',
    a: 'たすきばの「意味検索」は、入力した文字を含むものを返すのではなく、「意味の近さ」で並べ替えて返します。そのため「請求書」と「インボイス」のように言い方が違っても、近い内容として拾えます。画面右下のたすきフクロウに、50〜200 字くらいの文章で具体的に書くとよりよく見つかります。よくある質問ページの検索ボックスは、こちらとは別に FAQ の文言を直接さがすためのものです。',
    visibleTo: 'all',
  },

  // ----- project_member (member 以上): 作業者として行う操作の手順 -----
  {
    id: 'member-first-step',
    category: 'business',
    q: 'プロジェクトのメンバーに入りました。まず何をすればいいですか？',
    a: 'まず画面右上メニューの「マイタスク」で自分の担当作業を確認しましょう。作業を進めながら、これから起きそうな心配ごとは「リスク」、すでに起きた問題は「課題」に登録します。共有したい気づきは「ナレッジ」に書き残してください。コメントで @ を付けると、関係者に確実に通知できます。',
    visibleTo: 'project_member',
  },
  {
    id: 'create-risk-issue-howto',
    category: 'business',
    q: 'リスクや課題はどうやって登録しますか？',
    a: 'プロジェクトに参加しているメンバーなら登録できます。プロジェクト詳細画面の「リスク」「課題」タブを開き、「新規作成」から入力します。リスクは「まだ起きていないが、起こるかもしれない問題」、課題は「すでに起きていて対応が必要な問題」です。公開範囲を「公開」にすると、他のメンバーや今後のプロジェクトの参考に活用されます (下書きのままだと自分だけが見られます)。',
    visibleTo: 'project_member',
  },
  {
    id: 'create-knowledge-howto',
    category: 'business',
    q: 'ナレッジはどうやって書けばいいですか？',
    a: '画面左メニューの「ナレッジ」→「新規作成」から、タイトルと本文を入力して保存します。最初は公開範囲「下書き (自分のみ)」で書きためても構いません。整理できたら公開範囲を「公開」に変えると、他のメンバーや今後のプロジェクトの提案に活用されます。「他のチームでも役立ちそうな工夫」を残すと、組織の財産になっていきます。',
    visibleTo: 'project_member',
  },
  {
    id: 'update-task-progress-howto',
    category: 'business',
    q: '自分の担当タスクの進捗はどこで更新しますか？',
    a: '画面右上メニューの「マイタスク」を開くと、自分が担当する作業がプロジェクトごとに表示されます。各タスクの状態 (未着手 / 着手 / 完了) や実績を更新すると進捗に反映されます。更新できるのは自分が担当しているタスクのみです (他の人が作った計画そのものの編集は PM/PL が行います)。',
    visibleTo: 'project_member',
  },

  // ----- project_pm (PM/PL): 判断業務・PM 限定機能 -----
  {
    id: 'pm-first-step',
    category: 'business',
    q: 'プロジェクトを任されました (PM/PL)。最初に何をすればいいですか？',
    a: 'まず担当プロジェクトを開き、作成直後の「参考」タブで過去の似た事例 (リスク・課題・ナレッジ・振り返り) を確認します。次に「WBS」タブで作業を WP (作業のまとまり) → Activity (実作業) に分解し、担当者・予定工数・期間を設定します。進行中はリスク・課題を記録し、完了後は「振り返り」で Keep / Problem / Try を整理してください。',
    visibleTo: 'project_pm',
  },
  {
    id: 'create-project-howto',
    category: 'business',
    q: '新しいプロジェクトはどうやって作りますか？',
    a: 'PM/PL またはテナント管理者が作成できます。「プロジェクト一覧」→「新規作成」から、プロジェクト名・顧客・開始/終了予定日・担当などを入力します。「目的・背景・スコープ」を具体的に書くほど、AI が内容を読み取って「参考」タブに並べる過去事例の精度が上がります。',
    visibleTo: 'project_pm',
  },
  {
    id: 'reference-tab-howto',
    category: 'business',
    q: '「参考」タブには何が表示されますか？どう使いますか？',
    a: 'プロジェクト詳細の「参考」タブには、今のプロジェクトと内容が似た過去のリスク・課題・ナレッジ・振り返りが、関連の強い順に自動で並びます。プロジェクト作成直後に必ず目を通すと、過去の教訓の見落としを防げます。自社内のデータと、運営が用意した参考事例の両方が対象です (参考事例の参照はテナント設定で OFF にもできます)。',
    visibleTo: 'project_pm',
  },
  {
    id: 'stakeholder-howto',
    category: 'business',
    q: 'ステークホルダータブとは何ですか？',
    a: '案件の関係者 (発注元の担当者・キーパーソンなど) の情報を整理する場所です。個人情報や人物評を含むため、メンバー・閲覧者には表示されません。プロジェクト詳細の「ステークホルダー」タブから登録・編集できます。',
    visibleTo: 'project_pm',
  },

  // ----- tenant_admin: 容量課金の違い + 管理者の最初の一歩 -----
  {
    id: 'db-capacity-vs-file-storage',
    category: 'billing',
    q: '「DB容量(従量課金)」と「ファイルストレージ(添付ファイル従量課金)」の違いと料金は？',
    a: 'テナント設定の「使用量」では、2 種類の容量を別々に集計・課金しています。\n- DB容量(従量課金): 入力したテキストデータ (目的・ナレッジ本文・コメント・タグ・URL の文字列など) を集計します。無料枠は 50MB で、超えた分は 1GB ごとに ¥50 です。\n- ファイルストレージ(添付ファイル従量課金): 添付したファイル本体 (PDF・Excel・画像など) を集計します。無料枠は 100MB で、超えた分は 1GB ごとに ¥10 です (1 ファイルの上限は 50MB)。\nどちらも全プラン共通で 50GB に達すると新規の保存・編集が止まります。最新の使用量はテナント設定の「使用量」タブで確認できます (ページを開いた瞬間に再集計されます)。',
    visibleTo: 'tenant_admin',
  },
  {
    id: 'admin-first-step',
    category: 'admin',
    q: 'テナント管理者です。組織を作った直後にやるべきことは？',
    a: 'おすすめの順番です:\n1. 自分の MFA (二段階認証) を有効化 (設定 →「セキュリティ」)\n2. メンバーを招待 (アカウントメニュー →「ユーザ管理」→「メンバーを招待」)\n3. 社内 wiki や旧ツールに既存のナレッジ・課題があれば、テナント設定 →「外部データ移行ウィザード」で CSV 一括取込\n4. Expert / Pro の場合は「月次予算上限」を設定して想定外の請求を防止\n各手順の詳細は、画面右下のたすきフクロウや「使い方ガイド」でご確認いただけます。',
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
 * 開示ロジック (★階層内包★: 上位ロールは下位段を見られる):
 *   - `all`: 全員
 *   - `project_member`: hasAnyProjectMembership / hasAnyProjectPmRole / isTenantAdmin のいずれか
 *     (= member 以上のメンバーシップを持つ、または PM/PL、またはテナント管理者)
 *   - `project_pm`: hasAnyProjectPmRole / isTenantAdmin のいずれか
 *     (= PM/PL ロールを持つ、またはテナント管理者。admin は全プロジェクトの PM 操作が可能なため内包)
 *   - `tenant_admin`: viewer.isTenantAdmin が true のときのみ
 */
export function getFaqEntriesForRole(viewer: ViewerRoles): readonly FaqEntry[] {
  return FAQ_ENTRIES.filter((e) => canViewerSee(e.visibleTo, viewer));
}

/**
 * 単一の開示段に対する可視判定 (★階層内包★)。FAQ / Guide で共通利用する。
 * admin (isTenantAdmin) は全プロジェクト操作が可能なため project_pm / project_member を内包し、
 * PM/PL は project_member を内包する。
 */
export function canViewerSee(
  visibleTo: FaqVisibleTo,
  viewer: ViewerRoles,
): boolean {
  switch (visibleTo) {
    case 'all':
      return true;
    case 'project_member':
      return (
        viewer.hasAnyProjectMembership ||
        viewer.hasAnyProjectPmRole ||
        viewer.isTenantAdmin
      );
    case 'project_pm':
      return viewer.hasAnyProjectPmRole || viewer.isTenantAdmin;
    case 'tenant_admin':
      return viewer.isTenantAdmin;
    default:
      return false; // 未知の visibleTo は fail-closed (デフォルト非開示)
  }
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
      '- 料金体系・課金詳細・テナント運営 (席数管理・プラン変更・解約・新規ユーザ招待等) はテナント管理者のみが知ることができます。それ以外の方から質問されたら「申し訳ありません、料金や運営の詳細はテナント管理者の方にお尋ねください」とだけお答えしてください。',
    );
  }
  if (!viewer.hasAnyProjectPmRole && !viewer.isTenantAdmin) {
    denied.push(
      '- 提案エンジン (参考タブ)・ステークホルダー・プロジェクト作成/編集など、PM/PL 限定機能の質問には「申し訳ありません、その機能の詳細は PM/PL ロールの方にお尋ねください」とだけお答えしてください。',
    );
  }
  if (!canViewerSee('project_member', viewer)) {
    denied.push(
      '- 課題・リスク・ナレッジの作成やタスクの進捗更新など、プロジェクトのメンバー (作業者) が行う操作手順は、プロジェクトに参加しているメンバーの方のみにご案内します。未参加・閲覧のみの方から質問されたら「申し訳ありません、その操作はプロジェクトのメンバーの方にお尋ねください」とだけお答えしてください。',
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
    // ★G2-a2★ 制限対象への返答は「短い謝罪 + 該当ロールへの誘導 1 文のみ」。
    //   具体的な金額・期間・上限値・操作手順は当然出さず、加えて画面名・問い合わせ先・
    //   確認方法などの追加案内も一切付けない (冗長な回答を防ぐ)。
    '上記の制限対象について質問されたら、具体的な金額・期間・上限値・操作手順は一切含めず、かつ画面名・問い合わせ先・確認方法などの追加案内も付けず、「申し訳ありません、(ロール) の方にお尋ねください」のような短い謝罪と誘導の 1 文のみで返答してください。',
  ].join('\n');
}
