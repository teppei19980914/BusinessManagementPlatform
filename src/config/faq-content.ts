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
    return '本ユーザは全権限を持つため、開示制限はありません。';
  }
  return [
    '★重要★ あなたは「情報流出を防ぐ鍵」の役割を持ちます。下記の開示制限を必ず守ってください:',
    ...denied,
  ].join('\n');
}
