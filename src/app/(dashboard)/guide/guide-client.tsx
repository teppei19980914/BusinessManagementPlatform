'use client';

/**
 * 使い方ガイド client (PR I / #1)。
 *
 * 構成 (上から順):
 *   1. ヘッダ (タイトル + LP への CTA)
 *   2. このサービスの全体像 (3 行サマリ + 1 ステップフロー)
 *   3. 用語集 (用語 → 説明、Ctrl+F 検索しやすい定義リスト)
 *   4. ロール別の使い方 (tab: 管理者 / PM・PL / 一般メンバー / 閲覧者)
 *   5. 末尾 CTA (LP / Discord / FAQ への導線)
 *
 * UX 配慮:
 *   - 必要最低限の構成: アコーディオンや動画は使わず、「読み下すだけで分かる」 1 画面構成
 *   - 重複情報を避け、各 tab は対象ロールのアクションだけを箇条書き化 (=スキャン読みできる)
 *   - 全文 ja のみ。en 切替は v1.x 以降で対応 (β は ja 想定)
 */

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  PRODUCT_LP_URL,
  HELP_ROUTE,
  PROJECTS_ROUTE,
  MY_TASKS_ROUTE,
  KNOWLEDGE_ROUTE,
  ALL_RISKS_ROUTE,
  ALL_ISSUES_ROUTE,
  ALL_RETROSPECTIVES_ROUTE,
  getDiscordInviteUrl,
} from '@/config';

type Props = {
  initialTab: 'admin' | 'pm' | 'member' | 'viewer';
  userName: string;
};

export function GuideClient({ initialTab, userName }: Props) {
  const tNav = useTranslations('nav');
  const discord = getDiscordInviteUrl();

  return (
    <div className="mx-auto max-w-5xl space-y-10 pb-12">
      {/* ヘッダ */}
      <header className="space-y-3">
        <h1 className="text-2xl font-bold">使い方ガイド</h1>
        <p className="text-sm text-muted-foreground">
          {userName ? `${userName} さん、` : ''}
          ようこそ。たすきば Knowledge Relay は「過去のプロジェクトの教訓を <strong>次のプロジェクトで自動的に再利用</strong>
          する」ことを目指す業務マネジメントプラットフォームです。
          このページでは全体像・用語・ロール別の使い方を 1 画面で確認できます。
        </p>
        <div className="flex flex-wrap gap-2 pt-2">
          <a
            href={PRODUCT_LP_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md border bg-card px-3 py-1.5 text-sm hover:bg-accent"
          >
            <span aria-hidden>🌐</span> サービス紹介ページ (LP) を見る
          </a>
          <Link
            href={HELP_ROUTE}
            className="inline-flex items-center gap-1.5 rounded-md border bg-card px-3 py-1.5 text-sm hover:bg-accent"
          >
            <span aria-hidden>❓</span> よくある質問 (FAQ)
          </Link>
        </div>
      </header>

      {/* 1. 全体像 */}
      <section id="overview" className="space-y-3">
        <h2 className="text-xl font-semibold">サービスの全体像</h2>
        <p className="text-sm">
          プロジェクトを進めると、知らず知らずのうちに「<strong>過去にも同じ判断をした</strong>」「
          <strong>同じ課題で詰まった</strong>」が繰り返されます。本サービスは <strong>WBS / リスク / 課題 / 振り返り / ナレッジ</strong>
          を 1 つの空間で扱い、新規プロジェクト着手時に <strong>類似の過去事例を自動で提示</strong>
          することでこの繰り返しを断ちます。
        </p>
        <ol className="list-decimal space-y-1.5 pl-6 text-sm">
          <li>
            プロジェクトを作る → 自動で関連するナレッジ・リスク・過去課題が「参考」タブに並ぶ
          </li>
          <li>
            WBS を切る (作業を Activity 単位まで分解) → ガントチャートで進捗を見える化
          </li>
          <li>進行中に発生したリスク・課題・振り返り・ナレッジを記録</li>
          <li>
            プロジェクト終了時、記録した知見が <strong>次のプロジェクトの参考</strong> として自動的に再利用される
          </li>
        </ol>
      </section>

      {/* 2. 用語集 */}
      <section id="glossary" className="space-y-3">
        <h2 className="text-xl font-semibold">用語集</h2>
        <p className="text-sm text-muted-foreground">
          Ctrl+F (Cmd+F) でキーワード検索できます。
        </p>
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <GlossaryItem term="プロジェクト">
            業務の最上位単位。1 つのプロジェクト配下に WBS / リスク / 課題 / 振り返り / ナレッジ等がぶら下がります。
          </GlossaryItem>
          <GlossaryItem term="ProjectMember (プロジェクトメンバー)">
            プロジェクトに参加するユーザの登録単位。<strong>PM/PL</strong>・<strong>一般メンバー</strong>・
            <strong>閲覧者</strong> の 3 種のプロジェクトロールを持ちます。
          </GlossaryItem>
          <GlossaryItem term="WBS (Work Breakdown Structure)">
            プロジェクトの作業を <strong>WP (作業パッケージ)</strong> → <strong>Activity (実作業)</strong>{' '}
            の階層で分解したもの。Activity が予実・予定工数・進捗の管理単位です。
          </GlossaryItem>
          <GlossaryItem term="WP / Activity">
            WBS の構成要素。WP は子を持つ「集約タスク」、Activity は実際に人が作業する「末端タスク」。担当者・予定工数は Activity に付与します。
          </GlossaryItem>
          <GlossaryItem term="ガントチャート">
            タスクを時間軸で並べた工程表。期日超過・並列稼働・依存関係を視覚的に把握できます。
          </GlossaryItem>
          <GlossaryItem term="リスク">
            まだ発生していない潜在的な障害・不確実性。発生確率と影響度で評価し、対策を準備します。
          </GlossaryItem>
          <GlossaryItem term="課題">
            <strong>すでに発生した</strong> 障害・遅延・要対処事項。リスクが顕在化したものや、新しく発覚したブロッカー。
          </GlossaryItem>
          <GlossaryItem term="振り返り">
            プロジェクト/イテレーション後の Keep / Problem / Try (KPT) 形式での内省。次のプロジェクトに渡す「経験知」のソース。
          </GlossaryItem>
          <GlossaryItem term="ナレッジ">
            業務知識・ノウハウ・成功パターンを単独の文書として記録したもの。複数プロジェクトを跨いで参照されます。
          </GlossaryItem>
          <GlossaryItem term="提案エンジン (参考タブ)">
            プロジェクトの内容に類似した過去のリスク・課題・ナレッジ・振り返りを <strong>自動で抽出</strong> して提示する機能。Pro プランでは AI による「なぜ参考になるか」の説明文も付きます。
          </GlossaryItem>
          <GlossaryItem term="メンション (@)">
            コメント中で <code>@ユーザ名</code> を入力するとそのユーザに通知が届きます。確実に見てほしい依頼や質問に活用してください。
          </GlossaryItem>
          <GlossaryItem term="テナント">
            <strong>会社・組織</strong> 単位の最上位区切り。テナント間でデータは完全に分離され、他テナントの情報は閲覧できません。
          </GlossaryItem>
          <GlossaryItem term="プラン (Beginner / Expert / Pro)">
            <strong>Beginner</strong> = 無料・5 席まで。<strong>Expert</strong> = 席数無制限・1 API 呼出 ¥10。
            <strong>Pro</strong> = 席数無制限・1 API 呼出 ¥30 + AI 説明文付き提案。
          </GlossaryItem>
        </dl>
      </section>

      {/* 3. ロール別の使い方 */}
      <section id="by-role" className="space-y-3">
        <h2 className="text-xl font-semibold">ロール別の使い方</h2>
        <p className="text-sm text-muted-foreground">
          自分のロールを選んで「最初にやるべきこと」を確認してください。複数ロールを兼ねる場合は順に閲覧できます。
        </p>
        <Tabs defaultValue={initialTab} className="gap-3">
          <TabsList className="flex-wrap">
            <TabsTrigger value="admin">テナント管理者</TabsTrigger>
            <TabsTrigger value="pm">PM・PL (プロジェクト管理者)</TabsTrigger>
            <TabsTrigger value="member">一般メンバー</TabsTrigger>
            <TabsTrigger value="viewer">閲覧者</TabsTrigger>
          </TabsList>

          {/* テナント管理者 */}
          <TabsContent value="admin" className="space-y-3 rounded-md border bg-card p-4">
            <h3 className="font-medium">テナント管理者がやること</h3>
            <p className="text-sm text-muted-foreground">
              組織全体の設定・ユーザ管理・課金プランの調整を担当します。一般のプロジェクト業務はメンバーに任せ、運営側に専念できます。
            </p>
            <ol className="list-decimal space-y-1.5 pl-6 text-sm">
              <li>
                <Link className="text-primary underline" href="/admin/users">
                  ユーザ管理
                </Link>{' '}
                でメンバーを招待 (メール送信)。承認すると自テナント配下に参加。
              </li>
              <li>
                <Link className="text-primary underline" href="/settings/tenant">
                  テナント設定
                </Link>{' '}
                でプラン (Beginner/Expert/Pro)・月次予算・請求先・支払い方法を確認。
              </li>
              <li>
                <Link className="text-primary underline" href="/admin/audit-logs">
                  監査ログ
                </Link>{' '}
                /{' '}
                <Link className="text-primary underline" href="/admin/role-changes">
                  権限変更
                </Link>{' '}
                で重要操作の追跡 (退職時の引継ぎ等)。
              </li>
              <li>
                提案エンジンの <strong>シードデータ参照</strong>{' '}
                (管理テナントの参考事例) を使うか / 使わないかをテナント設定で切替。
              </li>
              <li>
                生成 AI の利用状況・課金額は{' '}
                <Link className="text-primary underline" href="/settings/tenant">
                  テナント設定
                </Link>{' '}
                のダッシュボードで日次確認。
              </li>
            </ol>
          </TabsContent>

          {/* PM/PL */}
          <TabsContent value="pm" className="space-y-3 rounded-md border bg-card p-4">
            <h3 className="font-medium">PM・PL がやること</h3>
            <p className="text-sm text-muted-foreground">
              プロジェクトの計画・進捗管理・人員配置・リスク統制を担います。
            </p>
            <ol className="list-decimal space-y-1.5 pl-6 text-sm">
              <li>
                <Link className="text-primary underline" href={PROJECTS_ROUTE}>
                  プロジェクト一覧
                </Link>{' '}
                で「+ 新規」を押し、概要・期間・顧客を入力 → AI が自動でタグを抽出。
              </li>
              <li>
                作成直後の <strong>「参考」タブ</strong> に並ぶ過去のリスク・課題・ナレッジを必ず確認 (見落とし防止)。
              </li>
              <li>
                WBS タブで作業を <strong>WP → Activity</strong>{' '}
                に分解。Activity に担当者・予定工数・期間を設定。
              </li>
              <li>
                ガントチャートで並列稼働状況・期日超過を確認、必要なら工数集計ダイアログでメンバーの過負荷を検知。
              </li>
              <li>
                発生し得る不確実性は <Link className="text-primary underline" href={ALL_RISKS_ROUTE}>
                  リスク
                </Link>
                、すでに発生したブロッカーは <Link className="text-primary underline" href={ALL_ISSUES_ROUTE}>
                  課題
                </Link>{' '}
                に記録。
              </li>
              <li>
                プロジェクト完了後は <Link className="text-primary underline" href={ALL_RETROSPECTIVES_ROUTE}>
                  振り返り
                </Link>{' '}
                を必ず実施 (Keep/Problem/Try)。これが次プロジェクトの参考になります。
              </li>
              <li>
                重要な学びは <Link className="text-primary underline" href={KNOWLEDGE_ROUTE}>
                  ナレッジ
                </Link>{' '}
                として独立記録 (visibility=public で他プロジェクトからも参照可)。
              </li>
            </ol>
          </TabsContent>

          {/* 一般メンバー */}
          <TabsContent value="member" className="space-y-3 rounded-md border bg-card p-4">
            <h3 className="font-medium">一般メンバーがやること</h3>
            <p className="text-sm text-muted-foreground">
              アサインされた作業の進行と、現場で気づいた知見の記録が中心です。
            </p>
            <ol className="list-decimal space-y-1.5 pl-6 text-sm">
              <li>
                毎日まず <Link className="text-primary underline" href={MY_TASKS_ROUTE}>
                  マイタスク
                </Link>{' '}
                を開く。担当 Activity がプロジェクト毎にツリー表示されます。
              </li>
              <li>
                Activity の状態 (未着手 / 着手 / 完了) を更新し、進捗バーで実績を反映。
              </li>
              <li>
                作業中に「これは将来 hazard になりそう」と感じたら即{' '}
                <Link className="text-primary underline" href={ALL_RISKS_ROUTE}>
                  リスク
                </Link>{' '}
                に起票。すでに詰まったら <Link className="text-primary underline" href={ALL_ISSUES_ROUTE}>
                  課題
                </Link>{' '}
                に。
              </li>
              <li>
                コメントで <code>@</code>{' '}
                を使って関係者にメンション (相手に確実に通知が届きます)。
              </li>
              <li>
                共有したい知見は <Link className="text-primary underline" href={KNOWLEDGE_ROUTE}>
                  ナレッジ
                </Link>{' '}
                に書き起こす (visibility をプロジェクト内/全社で選択可)。
              </li>
            </ol>
          </TabsContent>

          {/* 閲覧者 */}
          <TabsContent value="viewer" className="space-y-3 rounded-md border bg-card p-4">
            <h3 className="font-medium">閲覧者ができること</h3>
            <p className="text-sm text-muted-foreground">
              書き込みは行えませんが、関係者にプロジェクトの状況を共有する用途で使います (役員・営業担当など)。
            </p>
            <ol className="list-decimal space-y-1.5 pl-6 text-sm">
              <li>プロジェクト概要・WBS・ガントチャートを <strong>閲覧のみ</strong> 可能。</li>
              <li>
                リスク・課題・ナレッジ・振り返りも閲覧可能 (visibility=public または同プロジェクトメンバーの場合)。
              </li>
              <li>コメントの新規投稿は不可。質問は別途メンバー経由で書き込んでもらう運用。</li>
              <li>マイタスク画面は使えません (担当タスクが付与されないため)。</li>
            </ol>
          </TabsContent>
        </Tabs>
      </section>

      {/* 末尾 CTA */}
      <section className="rounded-lg border bg-muted/40 p-5">
        <h2 className="text-base font-semibold">まだ分からないことがあったら</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          サービスの背景・思想は LP、よくある質問は FAQ、即時のサポートは Discord でどうぞ。
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <a
            href={PRODUCT_LP_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md bg-card px-3 py-1.5 text-sm hover:bg-accent"
          >
            🌐 LP (サービス紹介ページ)
          </a>
          <Link
            href={HELP_ROUTE}
            className="inline-flex items-center gap-1.5 rounded-md bg-card px-3 py-1.5 text-sm hover:bg-accent"
          >
            ❓ よくある質問
          </Link>
          {discord && (
            <a
              href={discord}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md bg-card px-3 py-1.5 text-sm hover:bg-accent"
            >
              💬 {tNav('contactDeveloper')}
            </a>
          )}
        </div>
      </section>
    </div>
  );
}

function GlossaryItem({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="rounded border bg-card p-3">
      <dt className="font-medium">{term}</dt>
      <dd className="mt-1 text-sm text-muted-foreground">{children}</dd>
    </div>
  );
}
