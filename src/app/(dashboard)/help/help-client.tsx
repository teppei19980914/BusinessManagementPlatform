'use client';

/**
 * よくある質問 (FAQ) client (PR I / 2026-05-11 リファクタ).
 *
 * 構成:
 *   1. ヘッダ (タイトル「よくある質問」+ 使い方ガイドへの戻りリンク)
 *   2. 業務利用について — 機能の概念・使い分け
 *   3. データとプライバシー — 組織分離・退会・エクスポート
 *   4. 操作・設定 — パスワード変更 / テーマ / 通知
 *   5. 組織管理者向け (課金・プラン・席数) — admin/super_admin 限定表示
 *   6. コストが発生するタイミングと注意点 — admin/super_admin 限定表示
 *   7. 末尾: 機能要望リンクのみ (LP/Discord は AccountMenu に集約済 = 2026-05-11)
 *
 * UX 配慮 (2026-05-11):
 *   - **概念的な表現に統一**: 「テナント」→「組織」、「埋め込み」「Anthropic Claude」等の
 *     内部実装用語を排除。エンジニアでない利用者でも理解できる文言に統一。
 *   - **「提案エンジン」→「提案タブ」**: 画面上で見える名前で参照することで、ユーザが
 *     どこを見ればよいかすぐ分かる。
 *   - **「コストが発生するタイミング」を新セクション化**: 旧「生成 AI の仕組み」は実装視点
 *     だったが、組織管理者の本当の関心事はコスト発生条件と請求への影響なので、その視点で再構成。
 *   - **FAQ の充実**: 不要なサポート問い合わせを減らし、開発者・利用者双方の負荷を下げる。
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
        <h1 className="text-2xl font-bold">よくある質問</h1>
        <p className="text-sm text-muted-foreground">
          初めての方は{' '}
          <Link href={GUIDE_ROUTE} className="text-primary underline">
            使い方ガイド
          </Link>{' '}
          を先に読むのがおすすめです。ここでは個別の「困った」に答えます。
        </p>
      </header>

      {/* 業務利用について */}
      <FaqCategory title="業務利用について">
        <FaqItem
          q="提案タブには何が表示されますか？"
          a={
            <p>
              プロジェクトの内容に <strong>類似した過去のリスク・課題・ナレッジ・振り返り</strong>{' '}
              が、類似度の高いものから自動的に並べて表示されます。新しいプロジェクトを始めるときに「以前似たような状況で何が起きたか」を見落とさないための機能です。
            </p>
          }
        />
        <FaqItem
          q="リスクと課題の違いは何ですか？"
          a={
            <p>
              <strong>リスク</strong> は「まだ発生していない、将来起こり得る障害」、
              <strong>課題</strong> は「すでに発生していて対処が必要な問題」です。
              リスクが実際に発生したら、課題として新しく起票することをおすすめします
              (リスク側に「対策が効いた / 効かなかった」記録が残るため)。
            </p>
          }
        />
        <FaqItem
          q="WBS の「WP」と「Activity」はどう使い分けますか？"
          a={
            <>
              <p>
                <strong>WP (作業パッケージ)</strong> は「親の枠」、<strong>Activity</strong>{' '}
                は「実際に人が作業する末端のタスク」です。担当者・予定工数・期間は{' '}
                <strong>Activity に</strong> 設定します (WP は配下の Activity の合計が自動で表示されます)。
              </p>
              <p className="mt-2 text-muted-foreground">
                目安: 1 つの Activity は 0.5〜5 人日程度に収めると、進捗管理しやすくなります。
              </p>
            </>
          }
        />
        <FaqItem
          q="ナレッジと振り返りはどう使い分けますか？"
          a={
            <p>
              <strong>振り返り</strong> はプロジェクトやイテレーションの終わりに「特定の経験」を Keep / Problem / Try でまとめるもの。
              <strong>ナレッジ</strong> は「他のプロジェクトでも再利用できる業務知識」を独立した文書として残すものです。
              振り返りの Try のうち、汎用化できるものをナレッジに昇格させる流れがおすすめです。
            </p>
          }
        />
        <FaqItem
          q="メンション (@) はどう使いますか？"
          a={
            <p>
              コメント入力中に <code>@</code> を入れるとユーザ候補が表示されます。
              選択するとそのユーザに通知 (画面右上のベルマーク) が届きます。
              質問・確認依頼・期日リマインドなど「相手に確実に見てほしい」ときに使ってください。
            </p>
          }
        />
        <FaqItem
          q="新しいプロジェクトはどう作成しますか？"
          a={
            <p>
              ヘッダの <strong>「全プロジェクト」</strong> から「+ 新規」ボタンを押し、概要・期間・顧客などを入力します。
              作成直後の <strong>「提案タブ」</strong> に過去の類似事例が並ぶので、必ず確認してから WBS の計画に進むことをおすすめします。
            </p>
          }
        />
        <FaqItem
          q="ガントチャートでは何が確認できますか？"
          a={
            <p>
              プロジェクト内の Activity (作業) を <strong>時間軸で並べた工程表</strong> を確認できます。
              期日超過・並列稼働・担当者の負荷集中などを視覚的に把握でき、計画の見直しに使えます。
            </p>
          }
        />
        <FaqItem
          q="通知 (ベルマーク) には何が表示されますか？"
          a={
            <p>
              自分が <strong>メンション (@) された投稿</strong> や、
              <strong>担当 Activity の期日が近い</strong> 等の重要な変化が表示されます。
              必要なものだけ届くよう設計しており、通知メールの有無は{' '}
              <Link href="/settings" className="text-primary underline">
                個人設定
              </Link>{' '}
              で切替可能です。
            </p>
          }
        />
      </FaqCategory>

      {/* データとプライバシー */}
      <FaqCategory title="データとプライバシー">
        <FaqItem
          q="他の組織の情報は見えますか？"
          a={
            <p>
              いいえ、見えません。<strong>組織 (テナント) 単位でデータは完全に分離</strong>{' '}
              されており、別の組織の業務情報は閲覧できません。運営者も他組織の内部データ (プロジェクトやナレッジの本文) は閲覧できません。
            </p>
          }
        />
        <FaqItem
          q="退会するとデータはどうなりますか？"
          a={
            <p>
              組織の退会を申請すると、<strong>30 日間の猶予期間</strong>{' '}
              を経て業務データは完全に削除されます。この間にデータエクスポート機能で必要な情報を引き上げることができます。
              法的保管義務のある記録 (請求関連のログ等) は匿名化したうえで別途保管されます。
            </p>
          }
        />
        <FaqItem
          q="個人メモと全メモの違いは何ですか？"
          a={
            <p>
              <strong>個人メモ</strong> は自分だけが見られる private なメモ、
              <strong>全メモ</strong> は組織内で公開されたメモを横断的に閲覧する画面です。
              他のユーザに <code>@</code> でメンションされたメモは、自分宛として「個人メモ」にも表示されます。
            </p>
          }
        />
        <FaqItem
          q="自分のデータをエクスポートできますか？"
          a={
            <p>
              はい、組織管理者であれば{' '}
              <Link href="/settings/tenant" className="text-primary underline">
                組織設定
              </Link>{' '}
              からプロジェクト・ナレッジ・振り返り等を ZIP 形式でまとめて取得できます。
              監査・移行・バックアップ用途にお使いください。
            </p>
          }
        />
        <FaqItem
          q="パスワードを忘れてログインできない場合は？"
          a={
            <p>
              ログイン画面の「パスワードをお忘れですか？」リンクから、メールアドレスを入力するとパスワード再設定用のリンクが送信されます。
              リンクは <strong>1 時間で失効</strong> するため、受信後はすぐに再設定してください。
            </p>
          }
        />
      </FaqCategory>

      {/* 操作・設定 */}
      <FaqCategory title="操作・設定">
        <FaqItem
          q="パスワードを変更するには？"
          a={
            <p>
              画面右上のアカウントメニュー →{' '}
              <Link href="/settings" className="text-primary underline">
                個人設定
              </Link>{' '}
              から変更できます。安全のため、現在のパスワードの入力が必要です。
            </p>
          }
        />
        <FaqItem
          q="表示テーマ (見た目) を変更するには？"
          a={
            <p>
              <Link href="/settings" className="text-primary underline">
                個人設定
              </Link>{' '}
              の「テーマ」から、ライト / ダーク / 8 種のカラーバリエーション (パステル / ポップ) を選択できます。
              選択内容はブラウザを閉じても保存され、別の端末でログインしても引き継がれます。
            </p>
          }
        />
        <FaqItem
          q="通知メールをオフにできますか？"
          a={
            <p>
              はい、{' '}
              <Link href="/settings" className="text-primary underline">
                個人設定
              </Link>{' '}
              の「通知設定」から、メンション通知・期日リマインドなどを個別にオン / オフできます。
              画面上のベルマーク通知は引き続き表示されるため、メールだけ抑えたい場合に便利です。
            </p>
          }
        />
        <FaqItem
          q="二要素認証 (MFA) を設定するには？"
          a={
            <p>
              <Link href="/settings" className="text-primary underline">
                個人設定
              </Link>{' '}
              の「セキュリティ」から、認証アプリ (Google Authenticator など) で MFA を有効化できます。
              組織管理者は組織全体で MFA を必須化することもできます。
            </p>
          }
        />
      </FaqCategory>

      {/* 組織管理者向け FAQ + コスト発生タイミング */}
      {isTenantAdmin && (
        <>
          <FaqCategory
            title="組織管理者向け (課金・プラン・席数)"
            tone="admin"
          >
            {/* 2026-05-11: ユーザ要望 #4 — コスト発生タイミング FAQ を冒頭に追加 */}
            <FaqItem
              q="このサービスでコストが発生するのはどんなときですか？"
              a={
                <>
                  <p>大きく分けて、コストが発生する場面は <strong>2 つだけ</strong> です。</p>
                  <ul className="mt-2 list-disc space-y-1 pl-5">
                    <li>
                      <strong>生成 AI の利用</strong>:
                      プロジェクト作成 / 更新、リスク・課題・ナレッジ・振り返りの作成 / 更新などのタイミングで AI が呼び出され、Expert / Pro プランでは 1 操作ごとに固定料金が発生します。Beginner プランは月 100 回まで無料です。
                    </li>
                    <li>
                      <strong>Storage プラン (アドオン) の追加契約</strong>:
                      標準容量を超える容量を契約した場合、月額固定で追加コストが発生します (Plus / Pro / Enterprise の 3 種)。
                    </li>
                  </ul>
                  <p className="mt-2 text-muted-foreground">
                    詳しい内訳は本ページ下部の「コストが発生するタイミングと注意点」をご覧ください。
                  </p>
                </>
              }
            />
            <FaqItem
              q="プラン (Beginner / Expert / Pro) の違いは？"
              a={
                <>
                  <ul className="list-disc space-y-1 pl-5">
                    <li>
                      <strong>Beginner (無料)</strong>: 5 席まで・月 100 回まで AI 機能を無料で利用。上限到達後は AI による自動提案が縮退します。
                    </li>
                    <li>
                      <strong>Expert (¥10 / 回)</strong>: 席数無制限・AI 機能の利用は 1 操作 ¥10 の従量課金。月次予算上限は自分で設定可能。
                    </li>
                    <li>
                      <strong>Pro (¥30 / 回)</strong>: 席数無制限・AI 機能の利用は 1 操作 ¥30。提案タブで「なぜ参考になるか」の AI 説明文も表示されます。
                    </li>
                  </ul>
                  <p className="mt-2 text-muted-foreground">
                    詳細は{' '}
                    <Link href="/settings/tenant" className="text-primary underline">
                      組織設定
                    </Link>{' '}
                    のプラン情報セクションで確認できます。
                  </p>
                </>
              }
            />
            <FaqItem
              q="プラン変更はいつ反映されますか？"
              a={
                <>
                  <p>
                    <strong>アップグレード</strong> (例: Beginner → Pro) は即時反映されます。
                  </p>
                  <p className="mt-2">
                    <strong>ダウングレード</strong> (例: Pro → Beginner) は「当月末まで現プラン継続、翌月 1 日から新プランに切替」となります。
                    月途中での料金回避を防ぐ仕様です。なお Beginner への変更時に席数が 5 名を超えていると、ダウングレードは拒否されます (事前に席数を 5 名以下に減らしてください)。
                  </p>
                </>
              }
            />
            <FaqItem
              q="月次予算上限を超えるとどうなりますか？"
              a={
                <p>
                  設定した予算額に達した時点で、AI 機能が <strong>自動的に縮退モード</strong>{' '}
                  に切り替わります。新たな AI 課金は発生しません。既存データの閲覧・編集は影響を受けず、翌月 1 日にリセットされて通常モードに戻ります。
                </p>
              }
            />
            <FaqItem
              q="運営提供の参考事例 (シードデータ) を使いたくありません"
              a={
                <p>
                  <Link href="/settings/tenant" className="text-primary underline">
                    組織設定
                  </Link>{' '}
                  →「シードデータ参照」を OFF にしてください。以降は自分の組織内のデータのみで提案タブが組み立てられます。
                </p>
              }
            />
            <FaqItem
              q="メンバーを招待するには？"
              a={
                <p>
                  <Link href="/admin/users" className="text-primary underline">
                    ユーザ管理画面
                  </Link>{' '}
                  からメールアドレスを指定して招待します。招待メールのリンクから受信者がパスワードを設定すると、組織のメンバーとして参加できます。
                </p>
              }
            />
            <FaqItem
              q="使用状況や請求額はどこで確認できますか？"
              a={
                <p>
                  <Link href="/settings/tenant" className="text-primary underline">
                    組織設定
                  </Link>{' '}
                  のダッシュボードで、当月の AI 利用回数・予想請求額・席数の使用状況を日次で確認できます。月単位の CSV エクスポートも可能です。
                </p>
              }
            />
          </FaqCategory>

          {/* コストが発生するタイミングと注意点 (旧: 生成 AI の仕組み) */}
          {/* 2026-05-11: ユーザ要望 #5/#6 — タイトル変更 + 内容を「コスト発生条件」中心の概念的記述に再構成 */}
          <section className="rounded-lg border border-info/30 bg-info/5 p-5">
            <h2 className="text-lg font-semibold">コストが発生するタイミングと注意点</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              組織全体のコスト管理を担う立場として、いつ・どんな操作でコストが発生するかを把握しておくと安心です。
              本サービスでコストが発生する場面は「生成 AI の利用」と「Storage アドオンの契約」の 2 つのみです。
            </p>
            <div className="mt-4 space-y-4 text-sm">
              {/* 1. いつコストが追加されるか */}
              <div>
                <h3 className="font-medium">いつコストが追加されるか (生成 AI 関連)</h3>
                <p className="mt-1 text-muted-foreground">
                  以下のユーザ操作のタイミングで AI が呼び出され、Expert / Pro プランでは 1 操作ごとに固定料金が発生します
                  (Beginner プランは月 100 回まで無料、上限到達後は AI 機能が縮退モードに切替)。
                </p>
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  <li>
                    <strong>プロジェクトの作成 / 更新</strong>
                    <span className="ml-2 text-muted-foreground">
                      — 内容に基づくタグ抽出 + 関連事例の提示
                    </span>
                  </li>
                  <li>
                    <strong>リスク・課題・ナレッジ・振り返りの作成 / 更新</strong>
                    <span className="ml-2 text-muted-foreground">
                      — 類似事例の再評価 + 提案タブの更新
                    </span>
                  </li>
                  <li>
                    <strong>提案タブの「なぜ？」の表示</strong>{' '}
                    <span className="rounded bg-info/30 px-1.5 py-0.5 text-xs font-medium text-info">
                      Pro プラン限定
                    </span>
                    <span className="ml-2 text-muted-foreground">
                      — 「なぜこの事例が参考になるか」の AI 説明文を生成
                    </span>
                  </li>
                </ul>
              </div>

              {/* 2. 1 操作 = 1 課金 */}
              <div>
                <h3 className="font-medium">1 操作 = 1 課金 (重要)</h3>
                <p className="mt-1">
                  「ユーザに見える 1 つの操作」が <strong>1 回の課金単位</strong> です。
                  たとえばプロジェクトを作成すると、裏側で AI が複数回動いていても{' '}
                  <strong>合計 1 回</strong> としてカウントされます。連続して同じ画面を開いても、新たな AI 呼出が発生しない限り課金されません。
                </p>
              </div>

              {/* 3. 月次予算上限と縮退モード */}
              <div>
                <h3 className="font-medium">月次予算上限に達したらどうなる？</h3>
                <p className="mt-1">
                  予算上限 / Beginner プランの月 100 回上限に到達すると、AI 機能が <strong>自動的に縮退モード</strong>{' '}
                  に切り替わり、新たな AI 課金は発生しません。既存データの閲覧・編集は通常どおり可能で、提案タブも以前の生成結果が表示され続けます。
                  翌月 1 日に自動でリセットされ、通常モードに復帰します。
                </p>
              </div>

              {/* 4. Storage アドオン */}
              <div>
                <h3 className="font-medium">Storage プラン (アドオン) の追加コスト</h3>
                <p className="mt-1 text-muted-foreground">
                  添付ファイル・画像などのデータ容量が標準枠を超える場合に契約する月額固定のオプションです。
                  契約はいつでも{' '}
                  <Link href="/settings/tenant" className="text-primary underline">
                    組織設定
                  </Link>{' '}
                  から変更でき、ダウングレード時のみ翌月 1 日反映となります。
                </p>
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  <li>
                    <strong>Standard</strong>: 標準枠 (プランに応じて 50〜300 MB)。追加コストなし。
                  </li>
                  <li>
                    <strong>Plus</strong>: +200 MB、月額 ¥500。
                  </li>
                  <li>
                    <strong>Pro</strong>: +1 GB、月額 ¥1,500。
                  </li>
                  <li>
                    <strong>Enterprise</strong>: +5 GB、月額 ¥5,000。
                  </li>
                </ul>
              </div>

              {/* 5. 使用履歴の確認方法 */}
              <div>
                <h3 className="font-medium">使用履歴・請求の確認方法</h3>
                <p className="mt-1">
                  すべての AI 操作と Storage 契約の月額は記録されており、
                  <Link href="/settings/tenant" className="text-primary underline">
                    組織設定
                  </Link>{' '}
                  のダッシュボードから「いつ・どの機能で・いくら」使ったかを日次で確認できます。
                  月単位の CSV エクスポートも可能なので、請求業務やコスト最適化の根拠としてご活用ください。
                </p>
              </div>
            </div>
          </section>
        </>
      )}

      {/* それでも解決しないとき */}
      <section className="rounded-lg border bg-muted/40 p-5">
        <h2 className="text-base font-semibold">解決しなかった場合</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          ここで解決しない場合は、画面右上のアカウントメニューから{' '}
          <strong>Discord (開発者へ質問)</strong> や{' '}
          <strong>サービス紹介ページ</strong> にアクセスできます。
          機能改善のご要望は下記から直接お送りください。
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
        <span className="mr-2 hidden text-muted-foreground group-open:inline" aria-hidden>
          ▼
        </span>
        {q}
      </summary>
      <div className="mt-2 text-sm text-foreground/90">{a}</div>
    </details>
  );
}
