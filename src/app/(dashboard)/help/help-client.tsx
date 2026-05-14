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

      {/* 業務利用に関する FAQ */}
      <FaqCategory title="業務利用について">
        <FaqItem
          q="リスクと課題の違いは何ですか？"
          a={
            <>
              <p>
                <strong>リスク</strong> は「まだ発生していない潜在的な不確実性」、
                <strong>課題</strong> は「すでに発生したブロッカー・要対処事項」です。
                リスクが顕在化したら同じレコードを課題に変換するのではなく、課題として新規起票することを推奨します
                (リスク側に「対策で抑えられた」記録が残るため)。
              </p>
            </>
          }
        />
        <FaqItem
          q="WP と Activity はどう使い分ければよいですか？"
          a={
            <>
              <p>
                <strong>WP (作業パッケージ)</strong> は集約タスクで、子を持つ「枠」です。
                <strong>Activity</strong> は実作業の末端で、人が手を動かす単位。
                予定工数・担当者・期間は <strong>Activity に</strong> 設定します
                (WP は子 Activity の合計として自動表示)。
              </p>
              <p className="mt-2 text-muted-foreground">
                目安: 1 つの Activity は 0.5〜5 人日程度に収めると進捗管理しやすくなります。
              </p>
            </>
          }
        />
        <FaqItem
          q="ナレッジと振り返りはどう使い分けますか？"
          a={
            <p>
              <strong>振り返り</strong> はプロジェクト/イテレーション末尾で「特定の経験」をまとめる KPT 形式。
              <strong>ナレッジ</strong> は「再利用される業務知識」を独立した文書にしたもの。
              振り返りで Try に挙がった項目のうち、汎用化できるものをナレッジに昇格させる流れがおすすめです。
            </p>
          }
        />
        <FaqItem
          q="提案エンジン (参考タブ) には何が表示されますか？"
          a={
            <>
              <p>
                プロジェクトの内容に <strong>類似した過去のリスク・課題・ナレッジ・振り返り</strong> が、
                AI による意味的類似度ベースで自動抽出されます。
                自テナント内のデータ + 管理テナント (運営提供のシードデータ) を横断検索します
                (シード参照はテナント設定で OFF も可能)。
              </p>
              <p className="mt-2">
                Pro プランでは「なぜ参考になるか」の説明文 (Claude Sonnet 生成) も付与されます。
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
      </FaqCategory>

      {/* データ・プライバシー */}
      <FaqCategory title="データとプライバシー">
        <FaqItem
          q="他テナントの情報は見えますか？"
          a={
            <p>
              いいえ、見えません。テナントは <strong>最上位の認可境界</strong>{' '}
              で、業務データは完全に分離されています。運営 (super_admin) も他テナントの内部データは閲覧できません
              (集計値や課金情報を除く)。
            </p>
          }
        />
        <FaqItem
          q="退会するとデータはどうなりますか？"
          a={
            <p>
              テナント削除を申請すると、<strong>30 日間の Grace 期間</strong> を経て物理削除されます。
              この間にエクスポート (CSV) で引き上げが可能です。法的保管義務のあるログ (監査ログ等) は匿名化して別途保管されます。
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
      </FaqCategory>

      {/* テナント管理者向け FAQ + 生成 AI 解説 */}
      {isTenantAdmin && (
        <>
          <FaqCategory
            title="テナント管理者向け (課金・プラン・席数)"
            tone="admin"
          >
            <FaqItem
              q="プラン (Beginner / Expert / Pro) の違いは？"
              a={
                <>
                  <ul className="list-disc space-y-1 pl-5">
                    <li>
                      <strong>Beginner (無料)</strong>: 5 席まで・月 100 回 API 呼出・Claude Haiku。
                      上限到達で <strong>縮退モード</strong> (エンティティ作成・更新は継続、AI 裏方処理のみ一時停止)。
                    </li>
                    <li>
                      <strong>Expert (¥10/回)</strong>: 席数無制限・Claude Haiku・月間使用量上限なし
                      (予算上限は自己設定可)。
                    </li>
                    <li>
                      <strong>Pro (¥30/回)</strong>: 席数無制限・Claude Sonnet・AI 説明文付き提案。
                    </li>
                  </ul>
                  <p className="mt-2 text-muted-foreground">
                    詳細は{' '}
                    <Link href="/settings/tenant" className="text-primary underline">
                      テナント設定
                    </Link>{' '}
                    のプラン情報セクション。
                  </p>
                </>
              }
            />
            <FaqItem
              q="ダウングレード (Pro → Beginner) は即時反映されますか？"
              a={
                <p>
                  いいえ、<strong>当月末まで現プラン継続、翌月 1 日から Beginner に切替</strong>{' '}
                  します。月途中ダウングレードによる課金回避を防ぐ仕様です。
                  また現席数が 6 名以上の場合はシステム側でダウングレードを拒否します
                  (5 名以下にしてから再試行)。
                </p>
              }
            />
            <FaqItem
              q="月次予算上限を超えるとどうなりますか？"
              a={
                <>
                  <p>
                    設定額に達した時点で <strong>縮退モード</strong> に切り替わります。
                    エンティティの作成・更新は HTTP 200 で継続でき、embedding 生成・auto-tag 抽出・
                    AI 説明文生成 などの AI 裏方処理のみ一時停止します。
                  </p>
                  <p className="mt-2">
                    提案エンジンでは embedding 未生成の候補を <strong>タグ：テキスト = 5：5 の重み再配分</strong>
                    で評価し、可能な限り検索精度を維持します。
                  </p>
                  <p className="mt-2">
                    翌月 1 日のリセットで上限が解除され、同時に <strong>月初バッチで embedding を一括補完生成</strong>
                    して提案精度が完全回復します。月初を待たず即時復活する場合は予算上限の引き上げを行ってください。
                  </p>
                </>
              }
            />
            <FaqItem
              q="シードデータ (管理テナントの参考事例) を使いたくありません"
              a={
                <p>
                  <Link href="/settings/tenant" className="text-primary underline">
                    テナント設定
                  </Link>{' '}
                  →「シードデータ参照」を OFF にしてください。
                  以降は自テナント内のデータのみで提案が組まれます
                  (Phase 2 テナント分離適用後、他テナントのデータは一切参照しません)。
                </p>
              }
            />
          </FaqCategory>

          {/* 生成 AI の仕組み (admin 限定、難しい言葉を避けた説明)
              2026-05-13: 「中学生でも分かる」表現に書き直し。実装ベースで embedding も課金対象として記載
              (resolveCostForPlan は plan 単価をそのまま返すため、Voyage 呼出も Expert ¥10 / Pro ¥30 が加算される)。 */}
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
                        <td className="border-b p-2 align-top">月の AI 呼出回数</td>
                        <td className="border-b p-2 align-top">月 100 回まで</td>
                        <td className="border-b p-2 align-top">無制限</td>
                        <td className="border-b p-2 align-top">無制限</td>
                      </tr>
                      <tr>
                        <td className="border-b p-2 align-top">1 回あたりの料金</td>
                        <td className="border-b p-2 align-top">無料 (月 100 回まで)</td>
                        <td className="border-b p-2 align-top">¥10 / 回</td>
                        <td className="border-b p-2 align-top">¥30 / 回</td>
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
                        <td className="border-b p-2 align-top text-muted-foreground">設定不可 (月 100 回で自動停止)</td>
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
