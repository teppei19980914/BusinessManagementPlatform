'use client';

/**
 * ヘルプ・FAQ client (PR I / #2)。
 *
 * 構成:
 *   1. ヘッダ (タイトル + 使い方ガイドへの戻りリンク)
 *   2. 一般 FAQ (Q&A をカテゴリ別グループ化、<details> accordion)
 *   3. テナント管理者向け FAQ (条件付き表示) + 生成 AI の仕組み解説
 *   4. 末尾: それでも解決しないとき (Discord / 機能要望リンク)
 *
 * UX 配慮:
 *   - 必要最低限: アコーディオンの初期は全閉じ。クリックで展開 (情報密度を抑え視線疲労を回避)
 *   - 関連質問は同カテゴリ内に集約 (「業務利用」「課金」「データ」「AI」)
 *   - admin 専用セクションは認証ロールで切替 (一般ユーザに課金詳細を見せない)
 */

import Image from 'next/image';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  GUIDE_ROUTE,
  getFeatureRequestUrl,
} from '@/config';

type Props = {
  isTenantAdmin: boolean;
};

export function HelpClient({ isTenantAdmin }: Props) {
  // 2026-05-11: Discord / LP は AccountMenu (画面右上) に集約したため当画面の末尾 CTA から削除。
  //   機能要望リンクのみ /help 末尾に残す (= 機能改善依頼は FAQ 文脈で発生しやすいため)。
  const tNav = useTranslations('nav');
  const featureRequest = getFeatureRequestUrl();

  return (
    <div className="mx-auto max-w-4xl space-y-8 pb-12">
      {/* ヘッダ */}
      <header className="space-y-2">
        <h1 className="text-2xl font-bold">ヘルプ・よくある質問</h1>
        <p className="text-sm text-muted-foreground">
          初めての方は{' '}
          <Link href={GUIDE_ROUTE} className="text-primary underline">
            使い方ガイド
          </Link>{' '}
          を先に読むのがおすすめです。ここでは個別の「困った」に答えます。
        </p>
      </header>

      {/* サービスについて (マスコット紹介) */}
      <FaqCategory title="サービスについて">
        <FaqItem
          q="ヘッダーや favicon に出ているフクロウは何ですか？"
          a={
            <div className="space-y-3">
              <div className="flex flex-col items-center gap-2 sm:flex-row sm:items-start sm:gap-4">
                <Image
                  src="/mascot-owl.png"
                  alt="たすきフクロウ"
                  width={120}
                  height={120}
                  className="shrink-0 rounded-lg"
                />
                <div className="space-y-2 text-sm">
                  <p>
                    たすきばの公式マスコット <strong>「たすきフクロウ」</strong> です。
                    フクロウは古来より <strong>「知恵」「記憶」「夜でも見守る」</strong>{' '}
                    の象徴とされ、たすきばが大切にする 3 つの軸 ―
                    プロジェクト管理 / ナレッジ管理 / セキュリティ ― と重なります。
                  </p>
                  <p>
                    羽でドキュメントを抱え、胸元には鍵穴付きの盾、背景には円形のバリア。
                    「知見を守り、次の担当者に渡す」というサービスの根幹をそのまま絵にしています。
                  </p>
                  <p className="text-muted-foreground">
                    画面の左上・タブのアイコン・SNS シェア時のプレビューなど、
                    たすきばに関わるあらゆる場所で皆さんの仕事のそばに居つづけます。
                  </p>
                </div>
              </div>
            </div>
          }
        />
      </FaqCategory>

      {/* 業務利用に関する FAQ */}
      <FaqCategory title="業務利用について">
        <FaqItem
          q="リスクと課題の違いは何ですか？"
          a={
            <p>
              <strong>リスク</strong> は「まだ起きていない、起きるかもしれない問題」、<strong>課題</strong> は「すでに起きていて対応が必要な問題」です。リスクが実際に起こったら、そのリスクは触らず別途「課題」として新規登録するのがおすすめ (リスク側に「警戒した結果」が記録として残り、後の振り返りに役立つため)。
            </p>
          }
        />
        <FaqItem
          q="WP と Activity はどう使い分ければよいですか？"
          a={
            <>
              <p>
                <strong>WP (作業パッケージ)</strong> は「大きなまとまり」、<strong>Activity</strong> はその中の「実際に手を動かす作業 1 単位」です。担当者・予定工数・期間は <strong>Activity に</strong> 設定します (WP には子 Activity の合計が自動表示されます)。
              </p>
              <p className="mt-2 text-muted-foreground">
                例: 営業企画プロジェクトで「提案資料作成 (WP)」の中に「スライド設計 / グラフ作成 / 校正 (各 Activity)」を入れる、といった使い方です。1 つの Activity は <strong>半日〜1 週間</strong> 程度に収めると進捗が見やすくなります。
              </p>
            </>
          }
        />
        <FaqItem
          q="ナレッジと振り返りはどう使い分けますか？"
          a={
            <p>
              <strong>振り返り</strong> はプロジェクト終了時などに <strong>Keep (続けたい) / Problem (困った) / Try (次は工夫する)</strong> の 3 視点で経験を整理する場所です。<strong>ナレッジ</strong> は他のプロジェクトでも再利用できそうな業務知識を独立した文書として残す場所です。振り返りの Try で出た工夫のうち、他チームでも使えそうなものをナレッジに切り出すと、組織の財産が貯まります。
            </p>
          }
        />
        <FaqItem
          q="提案エンジン (参考タブ) には何が表示されますか？"
          a={
            <>
              <p>
                今のプロジェクトと <strong>内容が似ている過去のリスク・課題・ナレッジ・振り返り</strong> を AI が自動で探して並べます。自社内のデータと、運営が用意した参考事例 (シードデータ) の両方を検索します (シード参照はテナント設定で OFF にできます)。
              </p>
              <p className="mt-2">
                Pro プランでは <strong>「なぜ参考になるか」</strong> の説明文も付きます (より高機能な AI を使用)。
              </p>
              <p className="mt-2 text-muted-foreground">
                ※ 新しく登録したデータが提案に出てくるまで <strong>数秒〜のタイムラグ</strong> が発生します (AI が内容を読み取って検索用データを作るため)。
              </p>
            </>
          }
        />
        <FaqItem
          q="メンション (@) はどう使いますか？"
          a={
            <p>
              コメント入力中に <code>@</code> を入れると候補がポップアップします。
              選択するとそのユーザに通知 (画面右上のベル) が届きます。
              質問・確認依頼・期日リマインドなど「相手に確実に見てほしい」ときに使ってください。
            </p>
          }
        />
        {/* PR-9 / ADR-0026 (2026-05-29): embedding 非同期化に伴う「保存直後の反映遅延」案内。
            PR2 (feat/faq-pr2-clarity-rewrite): 「特徴量」「private」「全○○一覧」などの専門表現を平易化。 */}
        <FaqItem
          q="登録したナレッジ／メモ／振り返り／プロジェクトが提案や一覧に出てきません"
          a={
            <>
              <p>
                まず <strong>「公開範囲」が「全メンバー (公開)」になっているか</strong> を確認してください。「自分のみ (下書き)」のデータは、提案エンジンや全メンバー向け一覧画面には出ません。
              </p>
              <p className="mt-2">
                公開設定済の場合は、保存ボタンを押してから提案エンジンに表示されるまで <strong>数秒〜のタイムラグ</strong> が発生します (AI が内容を読み取って検索用データを作っているため)。「保存しました」直後に表示されない場合は、数十秒待ってからページを再読み込みしてください。
              </p>
            </>
          }
        />
        <FaqItem
          q="解消した課題やリスクが提案に出てきません"
          a={
            <>
              <p>
                課題・リスクは次の <strong>2 つの条件を両方</strong> 満たしたときだけ提案候補になります:
              </p>
              <ul className="mt-2 ml-4 list-disc space-y-1">
                <li><strong>状態が「解消」</strong> (解消前のものは対象外)</li>
                <li><strong>公開範囲が「全メンバー (公開)」</strong></li>
              </ul>
              <p className="mt-2">
                両方を満たしてから <strong>数秒〜のタイムラグ</strong> で順次反映されます。
              </p>
            </>
          }
        />
        <FaqItem
          q="既存資産のテキストを編集したのに提案結果が変わりません"
          a={
            <>
              <p>
                テキスト編集後、AI が内容を読み直して <strong>検索用データを作り直す</strong> ため、反映までに <strong>数秒〜のタイムラグ</strong> が発生します。
              </p>
              <p className="mt-2 text-muted-foreground">
                ※ タイトル・本文以外の項目 (タグ・優先度・期日など) の編集では作り直しは走りません (提案に使うのは本文テキストだけのため)。
              </p>
            </>
          }
        />
        <FaqItem
          q="プロジェクトを誤って削除しました、復元できますか？"
          a={
            <p>
              削除後 <strong>30 日以内</strong> なら、テナント管理者経由で運営側にお問い合わせください (内部的にはまだ残っており復元可能)。30 日経過後は完全に削除され、復元できません。誤削除予防のため、削除確認ダイアログでは慎重にご判断ください。
            </p>
          }
        />
        <FaqItem
          q="終了 (closed) したプロジェクトは編集できますか？"
          a={
            <p>
              <strong>編集できます</strong> (権限があれば)。「終了」は表示用のステータスで、編集ロックではありません。終了後の振り返り追記やナレッジ整理などにご活用ください。
            </p>
          }
        />
        <FaqItem
          q="プロジェクトをテンプレートから複製できますか？"
          a={
            <p>
              プロジェクト全体のテンプレート機能は現時点で未実装です。<strong>WBS (作業構造) 単位の複製</strong> はプロジェクト内の WBS 画面 (タスク一覧) から実行できます。
            </p>
          }
        />
        <FaqItem
          q="チャット検索で結果が 0 件になります"
          a={
            <p>
              キーワード単体ではなく <strong>50〜200 字程度の文章で、業務文脈や専門用語を含める</strong> とヒットしやすくなります。例:「決済」だけより「クレジットカード決済の API 連携で発生したエラー対応」のように具体的に書くのがコツです。
            </p>
          }
        />
        <FaqItem
          q="「下書き / 自分のみ」のデータも提案に出てきますか？"
          a={
            <p>
              出てきません。<strong>「下書き / 自分のみ」状態のデータは提案エンジンの対象外</strong> です (検索用データも作られないため、コスト面でも無駄が発生しない設計)。提案に出したい場合は公開範囲を「プロジェクト内公開」または「全メンバー (公開)」に変更してください。
            </p>
          }
        />
        <FaqItem
          q="「なぜ参考になる?」ボタンは押すたびに ¥15 課金されますか？"
          a={
            <p>
              いいえ、<strong>同じ組み合わせ (今のプロジェクト × 参考候補) で 2 回目以降はキャッシュから表示され、追加課金は発生しません</strong>。組み合わせが変わったとき (別の候補で押す / 元データの本文が編集された後) のみ ¥15 が発生します。
            </p>
          }
        />
      </FaqCategory>

      {/* 権限とロール */}
      <FaqCategory title="権限とロールについて">
        <FaqItem
          q="運営者 / テナント管理者 / 一般メンバーの違いは？"
          a={
            <div className="mt-2 overflow-x-auto rounded-md border">
              <table className="w-full border-collapse text-sm">
                <thead className="bg-muted/40">
                  <tr>
                    <th className="border-b p-2 text-left">操作</th>
                    <th className="border-b p-2 text-left">運営者</th>
                    <th className="border-b p-2 text-left">テナント管理者</th>
                    <th className="border-b p-2 text-left">一般メンバー</th>
                  </tr>
                </thead>
                <tbody>
                  <tr><td className="border-b p-2">テナント作成・削除・課金管理</td><td className="border-b p-2">○</td><td className="border-b p-2">○ (自社のみ)</td><td className="border-b p-2">−</td></tr>
                  <tr><td className="border-b p-2">メンバー招待・ロール変更</td><td className="border-b p-2">−</td><td className="border-b p-2">○</td><td className="border-b p-2">−</td></tr>
                  <tr><td className="border-b p-2">プロジェクト・ナレッジ・課題の作成/編集</td><td className="border-b p-2">−</td><td className="border-b p-2">○</td><td className="border-b p-2">○</td></tr>
                  <tr><td className="p-2">他社データの閲覧</td><td className="p-2">課金集計のみ</td><td className="p-2">−</td><td className="p-2">−</td></tr>
                </tbody>
              </table>
            </div>
          }
        />
        <FaqItem
          q="自分のロールはどこで確認できますか？"
          a={
            <p>
              画面右上のアカウントメニュー (アバターアイコン) を開くと、<strong>組織 → ロール → 名前 → メール</strong> の順で表示されます。
            </p>
          }
        />
        <FaqItem
          q="退職者が担当していたナレッジ・課題はどう引き継ぎますか？"
          a={
            <p>
              ナレッジ・リスク・課題・振り返り・メモは <strong>担当者 (assignee) を別のメンバーに付け替える</strong> ことで引き継げます。各データの編集画面の「担当者」欄から変更してください (データ自体はそのまま残ります)。
            </p>
          }
        />
      </FaqCategory>

      {/* アカウント・ログイン */}
      <FaqCategory title="アカウント・ログインについて">
        <FaqItem
          q="組織 ID を忘れました"
          a={
            <p>
              次のいずれかで確認できます: (1) ログイン画面の「組織 ID」入力欄を空にしてフォーカスすると、過去にログイン成功した組織 ID が <strong>最大 5 件・90 日間</strong> 候補表示されます / (2) 招待時に受信したメール本文「【重要】ログイン情報」セクションに記載 / (3) 同じ組織のメンバー (テナント管理者など) に確認。
            </p>
          }
        />
        <FaqItem
          q="パスワード設定リンクの有効期限はどれくらいですか？"
          a={
            <p>
              招待メールおよびパスワード再設定メールに含まれるリンクは <strong>24 時間で期限切れ</strong> になります。期限切れの場合、ログイン画面の「パスワードを忘れた方」から再発行してください (一般メンバーで再発行できない場合はテナント管理者に依頼)。
            </p>
          }
        />
        <FaqItem
          q="招待メールが届きません"
          a={
            <>
              <p>
                送信元は <strong><code>noreply@tasukiba.com</code></strong> です。次の順に確認してください:
              </p>
              <ol className="mt-2 ml-4 list-decimal space-y-1">
                <li>迷惑メールフォルダ・スパムフォルダを確認</li>
                <li>会社のメールフィルタで <code>noreply@tasukiba.com</code> を受信許可リストに追加</li>
                <li>メールアドレスのスペルミス (テナント管理者の招待画面で確認)</li>
                <li>解決しなければテナント管理者から再招待</li>
              </ol>
            </>
          }
        />
      </FaqCategory>

      {/* データ・プライバシー */}
      <FaqCategory title="データとプライバシー">
        <FaqItem
          q="他テナントの情報は見えますか？"
          a={
            <p>
              いいえ、見えません。テナント (= 会社) ごとにデータは完全に分かれており、運営者も他社の業務データの中身は見ません (請求のための件数・金額の集計のみ確認します)。
            </p>
          }
        />
        <FaqItem
          q="退会するとデータはどうなりますか？"
          a={
            <>
              <p>プランによって異なります。</p>
              <ul className="mt-2 ml-4 list-disc space-y-1">
                <li>
                  <strong>Beginner</strong>: 組織作成から 90 日で読み取り専用、合計 180 日で業務データが <strong>自動的に削除</strong> されます (削除前に事前メール通知あり)。
                </li>
                <li>
                  <strong>Expert / Pro</strong>: テナント設定の「セルフ解約」を実行すると、解約から約 90 日後に業務データが削除されます。
                </li>
              </ul>
              <p className="mt-2">
                削除前にデータが必要な場合は、テナント設定 →「エクスポート」から CSV を取得してください。請求書など法律で保管が必要な記録は別途 5 年間運営側で保管します。
              </p>
            </>
          }
        />
        <FaqItem
          q="退会したあと、同じ組織で再加入できますか？"
          a={
            <p>
              削除後は新しい組織として作り直す必要があります (組織 ID は再利用できません)。以前の業務データは復元できないため、必要な情報は必ず削除前にエクスポートしてください。
            </p>
          }
        />
        <FaqItem
          q="AI に送られるデータは何ですか？"
          a={
            <>
              <p>
                提案エンジンおよびチャット検索のために、次のデータが Anthropic (Claude) と Voyage AI に送信されます:
              </p>
              <ul className="mt-2 ml-4 list-disc space-y-1">
                <li>プロジェクトの「目的・背景・スコープ」</li>
                <li>ナレッジ・リスク・課題・振り返り・メモの本文 (公開範囲が draft でないもの)</li>
                <li>チャット検索のクエリ文字列</li>
              </ul>
              <p className="mt-2">
                次のデータは <strong>送信されません</strong>: パスワードなどの認証情報 / 添付ファイルの中身 / コメント本文 / 個人情報 (氏名・メールアドレス) など。
              </p>
            </>
          }
        />
        <FaqItem
          q="データのバックアップ・エクスポートはできますか？"
          a={
            <p>
              テナント管理者は <Link href="/settings/tenant" className="text-primary underline">テナント設定</Link> から全データを ZIP 形式で一括エクスポートできます。各一覧画面 (ナレッジ・リスク・課題・振り返り・メモ) の「エクスポート」ボタンから個別の CSV ダウンロードも可能です。退会前のデータ救出にもこの機能をお使いください。
            </p>
          }
        />
        <FaqItem
          q="個人メモと全メモの違いは何ですか？"
          a={
            <>
              <p>
                <strong>個人メモ</strong> 画面は、あなた自身が作成したすべてのメモ
                (公開・非公開どちらも) を管理・編集する場所です。
              </p>
              <p className="mt-2">
                <strong>全メモ</strong> 画面は、同じテナントに所属する他のメンバーが
                <strong>「公開」設定</strong> にしたメモを横断して読める場所です
                (閲覧のみ、編集はそれぞれの作成者だけが可能)。
              </p>
              <p className="mt-2 text-muted-foreground">
                補足: あなたがメンションされたメモは、自分宛として届くため
                「個人メモ」にも自動的に表示されます。
              </p>
            </>
          }
        />
        <FaqItem
          q="ナレッジの公開範囲 (下書き / プロジェクト内 / 全メンバー) はどう使い分けますか？"
          a={
            <>
              <p>用途別の目安:</p>
              <ul className="mt-2 ml-4 list-disc space-y-1">
                <li><strong>下書き (draft)</strong>: 自分の作業メモ。他のメンバーから見えない (提案エンジン対象外)</li>
                <li><strong>プロジェクト内 (project)</strong>: 関係するプロジェクトメンバーのみに公開</li>
                <li><strong>全メンバー (company)</strong>: 全社員に公開、提案エンジンの候補にも並ぶ</li>
              </ul>
              <p className="mt-2">
                リスク・課題 (RiskIssue) は <strong>下書き</strong> または <strong>公開</strong> の 2 段階です。
              </p>
            </>
          }
        />
        <FaqItem
          q="公開範囲を後から変更できますか？"
          a={
            <p>
              はい、各データの編集画面で変更できます (PM・テナント管理者のみ)。<strong>「下書き → 全メンバー」に初めて変更した時点で AI が検索用データを作成</strong> するため、提案エンジンに反映されるまで <strong>数秒〜のタイムラグ</strong> が発生します。
            </p>
          }
        />
        <FaqItem
          q="@メンションした個人メモは相手から見えますか？"
          a={
            <p>
              メモには <strong>private (自分のみ) と public (全メンバーに公開) の 2 段階</strong> があります。private なメモ内で @メンションしても、相手は閲覧できません (通知も飛びません)。共有したい場合は <strong>public に変更してから</strong> @メンションしてください。
            </p>
          }
        />
      </FaqCategory>

      {/* テナント管理者向け FAQ + 生成 AI 解説 */}
      {isTenantAdmin && (
        <>
          {/* 2026-05-28: 「初回ログイン後に既存ナレッジを CSV で一括取込したい」というテナント
              管理者特有の作業を支援。手順本体は /settings/tenant/external-import (ウィザード)
              にあり、ここでは「どこから始めるか」「形式」「よくあるエラー」を抜粋で説明する。 */}
          <FaqCategory
            title="外部データの取込・移行について (CSV インポート、テナント管理者のみ)"
            tone="admin"
          >
            <FaqItem
              q="社内 wiki / Excel / 旧 PM ツールに蓄積した既存ナレッジ・課題を、初回ログイン後に一括取込したい"
              a={
                <div className="space-y-2">
                  <p>
                    <strong>テナント管理者のみ</strong>が利用できる「外部データ移行ウィザード」で、
                    ナレッジと過去課題 (リスク / イシュー) を CSV で一括取込できます。
                    料金は <strong>全プラン無料</strong> (embedding 生成費用も発生しません / ADR-0019)。
                  </p>
                  <ol className="list-decimal space-y-1 pl-5">
                    <li>
                      画面右上アカウントメニュー → <strong>設定</strong> →{' '}
                      <Link href="/settings/tenant" className="text-primary underline">
                        テナント設定
                      </Link>{' '}
                      を開く
                    </li>
                    <li>
                      「データインポート」セクションの黄色い案内ボックスから{' '}
                      <Link href="/settings/tenant/external-import" className="text-primary underline">
                        外部データ移行ウィザード
                      </Link>{' '}
                      に進む
                    </li>
                    <li>
                      ウィザード上部の <strong>テンプレート CSV</strong>{' '}
                      (Knowledge / RiskIssue) をダウンロードし、Excel で編集 → 「名前を付けて保存」→{' '}
                      <strong>「CSV UTF-8 (コンマ区切り)」</strong> で保存
                    </li>
                    <li>
                      ウィザード 4 ステップ (ファイル選択 → マッピング → プレビュー → 取込) を進める。
                      プレビューで件数・エラーを確認できるので、取込前に CSV を修正可能
                    </li>
                  </ol>
                </div>
              }
            />
            <FaqItem
              q="どんな CSV フォーマットなら取込できますか?"
              a={
                <ul className="list-disc space-y-1 pl-5">
                  <li>
                    文字コード: <strong>UTF-8</strong> (Excel 既定の Shift_JIS では文字化け。
                    保存時に必ず「CSV UTF-8 (コンマ区切り)」を選択)
                  </li>
                  <li>1 行目はヘッダ行 (列名)、区切りはカンマ (タブ・セミコロン不可)</li>
                  <li>
                    本文・背景・原因など <strong>改行を含む長文セル</strong> は{' '}
                    <strong>必ずダブルクォート (<code>&quot;</code>) で囲む</strong>{' '}
                    (Excel でセル内改行は Alt + Enter)
                  </li>
                  <li>
                    日付は <strong><code>YYYY-MM-DD</code> 形式</strong> (例: <code>2026-12-31</code>。
                    <code>2026/12/31</code> 不可)
                  </li>
                  <li>影響度・優先度等の選択値は <strong>半角小文字</strong> (例: <code>high</code>、<code>High</code> 不可)</li>
                  <li>ファイルサイズ上限: <strong>50 MB</strong></li>
                </ul>
              }
            />
            <FaqItem
              q="プレビューで「エラー N 行」と表示されたときの直し方"
              a={
                <>
                  <p>取込実行前なのでデータは入っていません。代表的なエラー原因と対処:</p>
                  <ul className="mt-2 list-disc space-y-1 pl-5">
                    <li>
                      <strong>必須フィールドが空</strong> (<code>title</code> /{' '}
                      <code>content</code> 等) → Excel で該当行の値を入力
                    </li>
                    <li>
                      <strong>値の制限違反</strong> (<code>knowledgeType</code>{' '}
                      は <code>failure/success/lesson/template/general</code>、
                      <code>impact</code> は <code>low/medium/high</code>) → 表のいずれかに半角小文字で修正
                    </li>
                    <li>
                      <strong>日付形式</strong> (<code>deadline</code>) → スラッシュではなくハイフン区切り
                      <code>YYYY-MM-DD</code>
                    </li>
                    <li>
                      <strong>取込後に本文の 2 行目以降が消えている</strong> →{' '}
                      改行を含むセルがダブルクォートで囲まれていなかった可能性。CSV をメモ帳 / VS Code で開き
                      該当セルが <code>&quot;...&quot;</code> で囲まれているか確認 (Excel 保存時にクォートが外れる事故あり)
                    </li>
                  </ul>
                  <p className="mt-3 text-muted-foreground">
                    <strong>Excel での操作補足</strong>:
                  </p>
                  <ul className="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
                    <li>
                      <strong>CSV UTF-8 で保存</strong>: Excel メニュー「ファイル」→「名前を付けて保存」→ ファイル形式のドロップダウンから「CSV UTF-8 (コンマ区切り) (*.csv)」を選択 (Windows / Mac とも同じ)
                    </li>
                    <li>
                      <strong>セル内改行</strong>: 改行を入れたいセル内で <code>Alt + Enter</code> (Mac は <code>Option + 改行</code>) を押す。改行を含むセルは保存時に自動的に <code>&quot;</code> で囲まれる
                    </li>
                  </ul>
                </>
              }
            />
            <FaqItem
              q="本ウィザードで取り込めるのは何ですか? 振り返り・メモ・WBS も取り込めますか?"
              a={
                <>
                  <p>
                    本ウィザード (Phase 1) で取り込めるのは <strong>ナレッジ (Knowledge)</strong>{' '}
                    と <strong>リスク・課題 (RiskIssue)</strong> の 2 種類です。
                  </p>
                  <p className="mt-2">
                    振り返り・メモ・WBS (タスク) は本ウィザードの対象外で、それぞれの一覧画面の「インポート」ボタンから
                    個別に CSV 取込する経路があります (エクスポート → 編集 → 再取込 する round-trip 型のため、
                    外部システムからの初回投入には向きません)。
                  </p>
                </>
              }
            />
            <FaqItem
              q="プラン (Beginner / Expert / Pro) によって CSV 取込時の上限は変わりますか?"
              a={
                <>
                  <p>
                    <strong>ファイル容量・行数の上限は全プラン共通</strong> です:
                  </p>
                  <ul className="mt-2 list-disc space-y-1 pl-5">
                    <li>
                      <strong>外部データ移行ウィザード</strong>: ファイル 50 MB / 合計 5,000 行 / 全プラン無料 (ADR-0019)
                    </li>
                    <li>
                      <strong>エンティティ別 sync-import</strong> (各一覧画面): ファイル 10 MB / 500 行
                    </li>
                  </ul>
                  <p className="mt-2">
                    一方、<strong>DB 容量超過時の挙動</strong> は <strong>プランごとに異なります</strong> (ADR-0020 §11、2026-05-28 改修):
                  </p>
                  <div className="mt-2 overflow-x-auto rounded-md border">
                    <table className="w-full border-collapse text-xs">
                      <thead className="bg-muted/40">
                        <tr>
                          <th className="border-b p-2 text-left">取込後の予測使用量</th>
                          <th className="border-b p-2 text-left">Beginner</th>
                          <th className="border-b p-2 text-left">Expert / Pro</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr>
                          <td className="border-b p-2">&lt; 50 MB (無料枠内)</td>
                          <td className="border-b p-2 text-emerald-700 dark:text-emerald-400">取込可</td>
                          <td className="border-b p-2 text-emerald-700 dark:text-emerald-400">取込可</td>
                        </tr>
                        <tr>
                          <td className="border-b p-2">50 MB - 1 GB</td>
                          <td className="border-b p-2 text-destructive">⛔ 取込ブロック</td>
                          <td className="border-b p-2">取込可 (¥0〜¥50/月)</td>
                        </tr>
                        <tr>
                          <td className="border-b p-2">1 GB - 10 GB (L1)</td>
                          <td className="border-b p-2 text-destructive">⛔ 取込ブロック</td>
                          <td className="border-b p-2 text-amber-700 dark:text-amber-400">⚠ 警告 (取込可)</td>
                        </tr>
                        <tr>
                          <td className="border-b p-2">10 GB - 50 GB (L2)</td>
                          <td className="border-b p-2 text-destructive">⛔ 取込ブロック</td>
                          <td className="border-b p-2 text-amber-700 dark:text-amber-400">⚠ 警告 (取込可)</td>
                        </tr>
                        <tr>
                          <td className="p-2">≥ 50 GB (ハードキャップ)</td>
                          <td className="p-2 text-destructive">⛔ 取込ブロック</td>
                          <td className="p-2 text-destructive">⛔ 取込ブロック</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                  <p className="mt-2 text-muted-foreground">
                    <strong>Beginner プランの方</strong>: 50 MB 無料枠を超える取込は preview で警告表示 + 取込ボタン無効化されます (= 意図せず課金が発生することはありません)。50 MB を超えるデータをまとめて取り込みたい場合は Expert / Pro プランへアップグレードしてください。
                  </p>
                  <p className="mt-2 text-muted-foreground">
                    <strong>Expert / Pro プランの方</strong>: preview 画面で「取込後の予測使用量」と「予測月次課金額」が表示されます。内容を確認のうえ取込を実行してください。詳細は{' '}
                    <Link href="/settings/tenant" className="text-primary underline">
                      テナント設定
                    </Link>{' '}
                    →「使用量」タブで確認できます。
                  </p>
                </>
              }
            />
            <FaqItem
              q="取込後のデータの「公開範囲」はどうなりますか?"
              a={
                <ul className="list-disc space-y-1 pl-5">
                  <li>
                    Knowledge の <code>visibility</code> 既定値は <strong><code>company</code></strong>{' '}
                    (テナント全員に公開、他プロジェクトの提案エンジン候補に並ぶ)
                  </li>
                  <li>
                    RiskIssue の <code>visibility</code> 既定値は <strong><code>draft</code></strong>{' '}
                    (自分のみ、提案エンジン非表示 / 課金対象外)
                  </li>
                  <li>
                    CSV の <code>visibility</code> 列で行ごとに <code>draft</code> / <code>project</code> /{' '}
                    <code>company</code> (RiskIssue は <code>draft</code> / <code>public</code>) を指定可能
                  </li>
                  <li>
                    取込後に各データの編集画面から個別に公開範囲を変更することもできます
                  </li>
                </ul>
              }
            />
          </FaqCategory>

          <FaqCategory
            title="請求と支払いについて (テナント管理者のみ)"
            tone="admin"
          >
            <FaqItem
              q="いつ請求されますか？"
              a={
                <p>
                  <strong>月末締め → 翌月 25 日 (固定) がお支払い期限</strong> です (土日祝に当たる場合は翌営業日)。請求書 PDF は締日の翌月 15 日までにご請求先メールアドレスへ送付されます。
                </p>
              }
            />
            <FaqItem
              q="月途中でプランを変えたら料金はどうなりますか？"
              a={
                <p>
                  たすきばは「使ったぶんだけ」の従量課金 (1 回ごと) のため、切替前の利用分は切替前の単価、切替後は切替後の単価で計算されます (日割り計算はありません)。Beginner → Expert / Pro と Expert ↔ Pro は <strong>切替ボタンを押した瞬間に反映</strong> されます。
                </p>
              }
            />
            <FaqItem
              q="支払い方法はクレジットカード以外にありますか？"
              a={
                <p>
                  <strong>銀行振込 (請求書 PDF 受領)</strong> と <strong>クレジットカード (Stripe 自動引き落とし)</strong> の 2 種類です。新規組織の初期設定は銀行振込で、{' '}
                  <Link href="/settings/tenant" className="text-primary underline">
                    テナント設定
                  </Link>
                  {' '}からクレジットカードに変更できます (運営の事情でクレジットカード払いが一時的に選択できない場合があります)。
                </p>
              }
            />
            <FaqItem
              q="請求書 PDF はどこからダウンロードできますか？"
              a={
                <p>
                  銀行振込の場合は毎月 15 日までに <strong>ご請求先メールアドレス宛に PDF が直接送付</strong> されます (ダッシュボード内にダウンロード画面はありません)。クレジットカードの場合は Stripe の請求書 URL がメールに含まれ、そこからダウンロードできます。
                </p>
              }
            />
            <FaqItem
              q="消費税はどう計算されますか？"
              a={
                <p>
                  <strong>10% を四捨五入</strong> で計算します。請求書には税抜・税込の両方を明記します。
                </p>
              }
            />
            <FaqItem
              q="Beginner プランで DB 容量 50 MB を超えるとどうなりますか？"
              a={
                <p>
                  <strong>新しいデータの保存・編集ができなくなります</strong> (Beginner は無料プランのため、超過しても課金は発生しません)。不要なデータを削除すると 30 秒ほどで空き容量が自動再集計され、書き込みが再開されます。継続的に多く保存したい場合は Expert / Pro へアップグレードしてください。
                </p>
              }
            />
            <FaqItem
              q="DB 容量・ファイル容量はどこで確認できますか？"
              a={
                <p>
                  <Link href="/settings/tenant" className="text-primary underline">
                    テナント設定
                  </Link>
                  {' '}の <strong>「使用量」タブ</strong> で確認できます。ページを開いた瞬間に再集計されるため、削除直後でも実際の容量が反映されます。
                </p>
              }
            />
            <FaqItem
              q="50 GB のハードキャップに達したら何が起こりますか？"
              a={
                <p>
                  全プラン共通で <strong>新規データの保存・編集が止まります</strong> (エクスポート・既存データ閲覧・削除は引き続き可能)。サービス全体の安定性を守るための上限値で、継続利用には不要データの削除をお願いします。
                </p>
              }
            />
          </FaqCategory>

          <FaqCategory
            title="テナント管理者向け (課金・プラン・席数)"
            tone="admin"
          >
            <FaqItem
              q="プラン (Beginner / Expert / Pro) の違いは？"
              a={
                <>
                  <div className="mt-2 overflow-x-auto rounded-md border">
                    <table className="w-full border-collapse text-sm">
                      <thead className="bg-muted/40">
                        <tr>
                          <th className="border-b p-2 text-left">項目</th>
                          <th className="border-b p-2 text-left">Beginner (無料)</th>
                          <th className="border-b p-2 text-left">Expert (¥10/回)</th>
                          <th className="border-b p-2 text-left">Pro (¥15/回)</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr>
                          <td className="border-b p-2">席数</td>
                          <td className="border-b p-2">5 人まで</td>
                          <td className="border-b p-2">無制限</td>
                          <td className="border-b p-2">無制限</td>
                        </tr>
                        <tr>
                          <td className="border-b p-2">プロジェクト作成/更新</td>
                          <td className="border-b p-2">月 50 回まで無料</td>
                          <td className="border-b p-2">¥10/回</td>
                          <td className="border-b p-2">¥15/回</td>
                        </tr>
                        <tr>
                          <td className="border-b p-2">資産入力 / チャット検索</td>
                          <td className="border-b p-2" colSpan={3}>全プラン無料・無制限</td>
                        </tr>
                        <tr>
                          <td className="border-b p-2">使う AI モデル</td>
                          <td className="border-b p-2">基本 AI (Claude Haiku)</td>
                          <td className="border-b p-2">基本 AI (Claude Haiku)</td>
                          <td className="border-b p-2">高機能 AI (Claude Sonnet)</td>
                        </tr>
                        <tr>
                          <td className="p-2">「なぜ参考になる?」機能</td>
                          <td className="p-2 text-muted-foreground">利用不可</td>
                          <td className="p-2 text-muted-foreground">利用不可</td>
                          <td className="p-2">利用可 (¥15/回)</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                  <p className="mt-2 text-muted-foreground">
                    詳細は{' '}
                    <Link href="/settings/tenant" className="text-primary underline">
                      テナント設定
                    </Link>
                    {' '}のプラン情報セクションで確認できます。
                  </p>
                </>
              }
            />
            <FaqItem
              q="Expert と Pro の切替はいつ反映されますか？"
              a={
                <p>
                  Expert ↔ Pro の切替は <strong>切替ボタンを押した瞬間に即時反映</strong> されます (日割り計算なし、切替前後の利用分はそれぞれの単価で計算)。Beginner プランへ戻すことはできません (「Expert / Pro から Beginner プランに戻せますか？」FAQ を参照)。
                </p>
              }
            />
            <FaqItem
              q="月次予算上限を超えるとどうなりますか？"
              a={
                <p>
                  設定額に達した時点で <strong>AI 機能の一部が一時停止</strong> します。データの作成・編集は引き続きできますが、新しく登録したデータが提案に反映されず検索精度がやや下がります。<strong>翌月 1 日に自動で元に戻ります</strong> (途中で復活させたい場合は予算上限を引き上げてください)。
                </p>
              }
            />
            <FaqItem
              q="シードデータ (運営が用意した参考事例) を使いたくありません"
              a={
                <p>
                  <Link href="/settings/tenant" className="text-primary underline">
                    テナント設定
                  </Link>{' '}
                  →「シードデータ参照」を OFF にしてください。以降は自社内のデータのみで提案が組まれます (他の会社のデータは一切参照しません)。
                </p>
              }
            />
            <FaqItem
              q="Expert / Pro から Beginner プランに戻せますか？"
              a={
                <p>
                  <strong>戻せません</strong>。Beginner は試用期間 (90 日) 用のプランで、一度上位プランに上げると同じ組織では使えなくなります。月額の利用をゼロに抑えたい場合は、Expert / Pro のまま <strong>テナント設定 →「月次予算上限」を ¥0</strong> に設定してください (AI 機能が一時停止し、追加課金が発生しません)。
                </p>
              }
            />
          </FaqCategory>

          {/* 生成 AI の仕組み (admin 限定、難しい言葉を避けた説明)
              2026-05-13: 「中学生でも分かる」表現に書き直し。
              ADR-0019 (2026-05-24): 課金対象は BILLABLE_FEATURE_UNITS (project-upsert /
              suggestion-explanation / auto-tag-extract) のみに縮小。資産入力・チャット検索・
              CSV インポートは全プラン無料化。Expert ¥5 → ¥10、Pro ¥15 据置。 */}
          <section className="rounded-lg border bg-card p-5">
            <h2 className="text-lg font-semibold">生成 AI の仕組みと注意事項 (テナント管理者向け)</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              組織全体のコスト管理を担う立場として、AI がどこで動いていて何にお金がかかるのかを知っておくと安心です。難しい言葉は避けてまとめました。
            </p>

            <div className="mt-5 space-y-6 text-sm">
              {/* 1. AI を使っている機能の一覧 (中学生レベルの平易な説明) */}
              <div>
                <h3 className="font-medium">このサービスで AI を使っている場所</h3>
                <ul className="mt-2 list-disc space-y-2 pl-5">
                  <li>
                    <strong>タグの自動付け</strong>:
                    プロジェクトを作ったとき、目的・背景・スコープに書いた文章を AI が読んで、「業種」「使う技術」「工程」のキーワードを自動で付けてくれます。後で似たプロジェクトを探すときの目印になります。
                  </li>
                  <li>
                    <strong>文章の数値化 (検索の下準備)</strong>:
                    プロジェクト・ナレッジ・リスク・課題・振り返りを保存するとき、AI が文章を「意味を表す数字の列」に変換して裏方で保管します。これがあるおかげで、後から「言い方は違うけれど内容が似ているもの」を見つけられます。ユーザが直接画面で触る場面はありません。
                  </li>
                  <li>
                    <strong>「なぜ参考になるか」の説明文</strong>:
                    提案された過去資料の横にあるボタンを押すと、「なぜ今のプロジェクトに役立つのか」を AI が日本語で短くまとめてくれます。Pro プランでのみ使えます。
                  </li>
                  <li>
                    <strong>似ているもの探し本体 (提案タブの並び順)</strong>:
                    提案タブで過去資料を「似ている順」に並べる処理です。すでに保存してある「数値化」の結果を使うだけで、新たに AI を呼ばないので追加料金はかかりません。
                  </li>
                </ul>
                <p className="mt-2 text-xs text-muted-foreground">
                  なお、パスワードなどの認証情報、コメントの本文、添付ファイルの中身は AI に送られていません。AI に送られるのは、プロジェクト概要やナレッジ本文といった業務テキストだけです。
                </p>
              </div>

              {/* 2. 課金対象 / 対象外のサマリ表 */}
              <div>
                <h3 className="font-medium">課金対象 / 対象外のまとめ</h3>
                <div className="mt-2 overflow-x-auto rounded-md border">
                  <table className="w-full border-collapse text-sm">
                    <thead className="bg-muted/40">
                      <tr>
                        <th className="border-b p-2 text-left">機能</th>
                        <th className="border-b p-2 text-left">課金扱い</th>
                        <th className="border-b p-2 text-left">「1 回」の数え方</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td className="border-b p-2 align-top">タグの自動付け</td>
                        <td className="border-b p-2 align-top text-amber-700 dark:text-amber-400">課金対象</td>
                        <td className="border-b p-2 align-top">プロジェクトを作成・編集するたびに 1 回</td>
                      </tr>
                      <tr>
                        <td className="border-b p-2 align-top">文章の数値化 (検索の下準備)</td>
                        <td className="border-b p-2 align-top text-amber-700 dark:text-amber-400">課金対象</td>
                        <td className="border-b p-2 align-top">
                          プロジェクト / ナレッジ / リスク / 課題 / 振り返り / 外部データ取り込み を保存するたびに 1 回
                        </td>
                      </tr>
                      <tr>
                        <td className="border-b p-2 align-top">「なぜ参考になるか」説明文 (Pro 限定)</td>
                        <td className="border-b p-2 align-top text-amber-700 dark:text-amber-400">課金対象</td>
                        <td className="border-b p-2 align-top">
                          ボタンを押した瞬間に 1 回 (同じ組み合わせで 2 回目以降押した場合は保存済の結果が表示され、追加料金はかかりません)
                        </td>
                      </tr>
                      <tr>
                        <td className="p-2 align-top">似ているもの探し本体 (提案タブの並び順)</td>
                        <td className="p-2 align-top text-emerald-700 dark:text-emerald-400">課金対象外</td>
                        <td className="p-2 align-top">表示・並び替えだけでは AI を呼びません</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>

              {/* 3. プラン別 (Beginner / Expert / Pro) の対応表 */}
              <div>
                <h3 className="font-medium">プラン別の対応 (使えるもの・使う AI モデル・料金)</h3>
                <div className="mt-2 overflow-x-auto rounded-md border">
                  <table className="w-full border-collapse text-sm">
                    <thead className="bg-muted/40">
                      <tr>
                        <th className="border-b p-2 text-left">項目</th>
                        <th className="border-b p-2 text-left">Beginner</th>
                        <th className="border-b p-2 text-left">Expert</th>
                        <th className="border-b p-2 text-left">Pro</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td className="border-b p-2 align-top">席数</td>
                        <td className="border-b p-2 align-top">5 人まで</td>
                        <td className="border-b p-2 align-top">無制限</td>
                        <td className="border-b p-2 align-top">無制限</td>
                      </tr>
                      <tr>
                        <td className="border-b p-2 align-top">プロジェクト作成/更新の月上限</td>
                        <td className="border-b p-2 align-top">月 50 回まで</td>
                        <td className="border-b p-2 align-top">無制限</td>
                        <td className="border-b p-2 align-top">無制限</td>
                      </tr>
                      <tr>
                        <td className="border-b p-2 align-top">資産入力 / チャット検索</td>
                        <td className="border-b p-2 align-top">無料・無制限</td>
                        <td className="border-b p-2 align-top">無料・無制限</td>
                        <td className="border-b p-2 align-top">無料・無制限</td>
                      </tr>
                      <tr>
                        <td className="border-b p-2 align-top">1 回あたりの料金 (プロジェクト作成/更新)</td>
                        <td className="border-b p-2 align-top">無料 (月 50 回まで)</td>
                        <td className="border-b p-2 align-top">¥10 / 回</td>
                        <td className="border-b p-2 align-top">¥15 / 回</td>
                      </tr>
                      <tr>
                        <td className="border-b p-2 align-top">なぜ?機能 (Pro 限定)</td>
                        <td className="border-b p-2 align-top">利用不可</td>
                        <td className="border-b p-2 align-top">利用不可</td>
                        <td className="border-b p-2 align-top">¥15 / 回</td>
                      </tr>
                      <tr>
                        <td className="border-b p-2 align-top">タグの自動付け で使う AI</td>
                        <td className="border-b p-2 align-top">Claude Haiku</td>
                        <td className="border-b p-2 align-top">Claude Haiku</td>
                        <td className="border-b p-2 align-top">
                          Claude Sonnet
                          <span className="ml-1 text-xs text-muted-foreground">(より賢いモデル)</span>
                        </td>
                      </tr>
                      <tr>
                        <td className="border-b p-2 align-top">文章の数値化 で使う AI</td>
                        <td className="border-b p-2 align-top" colSpan={3}>
                          Voyage voyage-4-lite (全プラン共通)
                        </td>
                      </tr>
                      <tr>
                        <td className="border-b p-2 align-top">「なぜ参考になるか」説明文</td>
                        <td className="border-b p-2 align-top text-muted-foreground">使えません</td>
                        <td className="border-b p-2 align-top text-muted-foreground">使えません</td>
                        <td className="border-b p-2 align-top">
                          使える
                          <span className="ml-1 text-xs text-muted-foreground">(Claude Sonnet)</span>
                        </td>
                      </tr>
                      <tr>
                        <td className="border-b p-2 align-top">似ているもの探し本体 (提案タブ)</td>
                        <td className="border-b p-2 align-top">使える</td>
                        <td className="border-b p-2 align-top">使える</td>
                        <td className="border-b p-2 align-top">使える</td>
                      </tr>
                      <tr>
                        <td className="border-b p-2 align-top">月の予算上限の設定</td>
                        <td className="border-b p-2 align-top text-muted-foreground">設定不可 (プロジェクト作成・更新 月 50 回で自動停止)</td>
                        <td className="border-b p-2 align-top">設定可能</td>
                        <td className="border-b p-2 align-top">設定可能</td>
                      </tr>
                      <tr>
                        <td className="p-2 align-top">上限に達したとき</td>
                        <td className="p-2 align-top" colSpan={3}>
                          自動で「お休みモード」に切り替わります。すでに保存してある数値化結果を使った検索 (提案タブ) は止まらず、新しい AI 呼出 (= 新しい課金) だけが止まります。翌月 1 日にリセットされて元に戻ります。
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  ※ Expert / Pro の単価は初期値です。テナントごとに個別調整されている場合は{' '}
                  <Link href="/settings/tenant" className="text-primary underline">
                    テナント設定
                  </Link>{' '}
                  で実際の単価を確認できます。
                </p>
              </div>

              {/* 4. 利用状況の確認場所 */}
              <div>
                <h3 className="font-medium">「いつ・誰が・いくら使ったか」の確認</h3>
                <p className="mt-1">
                  すべての AI 呼出は記録されていて、「いつ」「誰が」「どの機能で」「いくら」使ったかをテナント設定画面から見られます。月末の精算やコスト見直しの根拠としてお使いください。
                </p>
              </div>
            </div>
          </section>
        </>
      )}

      {/* それでも解決しないとき */}
      {/* 2026-05-13 docs/discord-community-positioning: Discord は「開発者へのサポート窓口」ではなく
          開発者・ユーザが集まる「コミュニティ」と位置付ける。具体的な活用例 (質問 / 利用事例の共有) を
          提示することで、ユーザ同士のやり取りが生まれることを伝える (横展開対象)。 */}
      <section className="rounded-lg border bg-muted/40 p-5">
        <h2 className="text-base font-semibold">解決しなかった場合</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          ここで解決しない場合は、画面右上のアカウントメニューから{' '}
          <strong>Discord</strong> にアクセスしていただき、開発者に直接聞くことができます。
          たすきば Discord は開発者と他のユーザが集まる場所で、次のように活用できます:
        </p>
        <ul className="mt-2 list-disc pl-5 text-sm text-muted-foreground">
          <li>たすきば Discord 上で開発者に対して直接質問してみましょう。</li>
          <li>たすきば Discord 上で他のユーザに利用事例や運用のコツを聞いてみましょう。</li>
          <li>バグ報告や機能改善のご要望もコミュニティ内で歓迎されています。</li>
        </ul>
        <p className="mt-3 text-sm text-muted-foreground">
          サービス紹介や別途まとめてご要望をお送りいただく場合は、下記のリンクもご利用ください。
        </p>
        {featureRequest && (
          <div className="mt-3 flex flex-wrap gap-2">
            <a
              href={featureRequest}
              target="_blank"
              rel="noopener noreferrer"
              title={tNav('featureRequestTooltip')}
              className="inline-flex items-center gap-1.5 rounded-md bg-card px-3 py-1.5 text-sm hover:bg-accent"
            >
              ✨ {tNav('featureRequest')}
            </a>
          </div>
        )}
      </section>
    </div>
  );
}

function FaqCategory({
  title,
  tone,
  children,
}: {
  title: string;
  tone?: 'admin';
  children: React.ReactNode;
}) {
  return (
    <section
      className={
        tone === 'admin'
          ? 'rounded-lg border border-info/30 bg-info/5 p-5'
          : 'rounded-lg border bg-card p-5'
      }
    >
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="mt-3 space-y-2">{children}</div>
    </section>
  );
}

function FaqItem({ q, a }: { q: string; a: React.ReactNode }) {
  return (
    <details className="group rounded border bg-background p-3 [&[open]]:bg-accent/30">
      <summary className="cursor-pointer list-none text-sm font-medium [&::-webkit-details-marker]:hidden">
        <span className="mr-2 text-muted-foreground group-open:hidden" aria-hidden>
          ▶
        </span>
        <span className="mr-2 text-muted-foreground hidden group-open:inline" aria-hidden>
          ▼
        </span>
        {q}
      </summary>
      <div className="mt-2 text-sm text-foreground/90">{a}</div>
    </details>
  );
}
