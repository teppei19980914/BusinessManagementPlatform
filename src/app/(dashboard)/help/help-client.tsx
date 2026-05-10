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
  PRODUCT_LP_URL,
  getDiscordInviteUrl,
  getFeatureRequestUrl,
} from '@/config';

type Props = {
  isTenantAdmin: boolean;
};

export function HelpClient({ isTenantAdmin }: Props) {
  const tNav = useTranslations('nav');
  const discord = getDiscordInviteUrl();
  const featureRequest = getFeatureRequestUrl() ?? discord;

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
            <p>
              <strong>個人メモ</strong> は自分だけが見える private メモ、
              <strong>全メモ</strong> は visibility=public のメモ横断画面です。
              メンションされたメモは「個人メモ」にも表示されます (=自分宛として届く)。
            </p>
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
                      上限到達で提案機能が縮退モード。
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
                <p>
                  設定額に達した時点で <strong>提案エンジンが縮退モード</strong>{' '}
                  に切り替わります (embedding ベース並びのみ・AI 説明なし)。
                  既存データの閲覧・編集は影響を受けません。翌月 1 日にリセットされ通常モードに戻ります。
                </p>
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

          {/* 生成 AI の仕組み (admin 限定で詳しく) */}
          <section className="rounded-lg border bg-card p-5">
            <h2 className="text-lg font-semibold">生成 AI の仕組みと注意事項 (テナント管理者向け)</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              組織全体のコスト管理とコンプライアンスを担う立場として、AI まわりの挙動を理解しておくと安心です。
            </p>
            <div className="mt-4 space-y-3 text-sm">
              <div>
                <h3 className="font-medium">どこに何を投げているか</h3>
                <ul className="mt-1 list-disc space-y-0.5 pl-5">
                  <li>
                    <strong>埋め込み (embedding)</strong>: Voyage AI の voyage-4-lite モデルに、
                    プロジェクト概要・ナレッジ本文を送信。検索用ベクトル化のための裏方処理で <strong>課金対象外</strong>。
                  </li>
                  <li>
                    <strong>タグ抽出 / 説明文生成</strong>: Anthropic Claude
                    (Haiku または Sonnet) に、対象コンテンツを送信。Beginner/Expert は Haiku、Pro は Sonnet。
                  </li>
                  <li>
                    <strong>送信されないもの</strong>: 個別ユーザのコメント本文・添付ファイル・パスワード等の認証情報。
                  </li>
                </ul>
              </div>
              <div>
                <h3 className="font-medium">課金単位 (per-API-call)</h3>
                <p className="mt-1">
                  「ユーザに見える 1 操作」が 1 回。プロジェクト作成時の自動タグ抽出 + 初回提案生成は内部的に複数モデル呼出ですが <strong>1 回</strong> としてカウント。embedding 生成は無料。
                </p>
              </div>
              <div>
                <h3 className="font-medium">月次予算と縮退モード</h3>
                <p className="mt-1">
                  予算超過 / Beginner 月 100 回到達時は <strong>縮退モード</strong>{' '}
                  に自動切替。embedding ベース並びのみとなり、新たな AI 課金は発生しません。
                </p>
              </div>
              <div>
                <h3 className="font-medium">ログとトレーサビリティ</h3>
                <p className="mt-1">
                  すべての API 呼出は <code>ApiCallLog</code>{' '}
                  に保存され、テナント管理者が「いつ・誰が・どの機能で・いくら」使ったかを設定画面で確認できます。
                  クレーム対応・コスト最適化の根拠となります。
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
          直接ご連絡いただければ開発者がお答えします。お気軽にどうぞ。
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {discord && (
            <a
              href={discord}
              target="_blank"
              rel="noopener noreferrer"
              title={tNav('contactDeveloperTooltip')}
              className="inline-flex items-center gap-1.5 rounded-md bg-card px-3 py-1.5 text-sm hover:bg-accent"
            >
              💬 {tNav('contactDeveloper')}
            </a>
          )}
          {featureRequest && (
            <a
              href={featureRequest}
              target="_blank"
              rel="noopener noreferrer"
              title={tNav('featureRequestTooltip')}
              className="inline-flex items-center gap-1.5 rounded-md bg-card px-3 py-1.5 text-sm hover:bg-accent"
            >
              ✨ {tNav('featureRequest')}
            </a>
          )}
          <a
            href={PRODUCT_LP_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md bg-card px-3 py-1.5 text-sm hover:bg-accent"
          >
            🌐 サービス紹介ページ
          </a>
        </div>
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
