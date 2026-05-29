'use client';

/**
 * 使い方ガイド client (PR I / 2026-05-11 リファクタ)
 *
 * 構成 (上から順):
 *   1. ヘッダ (タイトル + 自分のロール表示) — LP/FAQ ボタンは削除 (AccountMenu に集約)
 *   2. サービスの全体像 — 4 ステップフロー (視覚的) + ロール×できること表
 *   3. あなたのやること — ユーザのロール (admin/pm/member/viewer) に応じたセクションのみ
 *   4. 用語集 — ロールに応じて必要な用語のみ (一般・閲覧者は AI ロジック関連を省略)
 *   5. 末尾 CTA — LP / FAQ / Discord (旧 PR では top + bottom の重複あり → bottom のみに)
 *
 * 設計判断:
 *   - **タブ廃止**: 「自分のロールを選ぶ」操作を撤廃。ユーザに不要な選択コストを掛けない。
 *     admin / super_admin にはテナント管理者の作業を表示 (= PM 作業は別途プロジェクト内 UI で学習)
 *   - **AI 詳細は admin/pm のみ**: 業務に直接関係しない「埋め込み」「Anthropic 単価」等は
 *     一般メンバー・閲覧者の用語集から除外
 *   - **視覚的全体像**: 横並びの 4 ステップフロー (矢印付き) + 表でロール × やることを併記
 */

import Link from 'next/link';
import { useTranslations } from 'next-intl';
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
import type { GuideRole } from '@/services/guide-role.service';
import { HelpChatInput } from '@/components/help-chat/help-chat-input';

type Props = {
  /** 解決済の表示ロール (= guide-role.service.ts で systemRole + projectRole から判定) */
  role: GuideRole;
  /** ロールラベル併記用 (admin と super_admin の区別) */
  systemRole: string;
  userName: string;
};

const ROLE_LABEL: Record<GuideRole, string> = {
  admin: 'テナント管理者',
  pm: 'PM / PL (プロジェクト管理者)',
  member: '一般メンバー',
  viewer: '閲覧者',
};

export function GuideClient({ role, systemRole, userName }: Props) {
  const tNav = useTranslations('nav');
  const discord = getDiscordInviteUrl();
  // admin/pm 向けには AI ロジックや課金関連の用語まで含める。member/viewer には含めない。
  const showAdvancedTerms = role === 'admin' || role === 'pm';
  const displayRoleLabel =
    systemRole === 'super_admin' ? 'システム管理者 (プラットフォーム運営者)' : ROLE_LABEL[role];

  return (
    <div className="mx-auto max-w-5xl space-y-10 pb-12">
      {/* ヘッダ */}
      <header className="space-y-2">
        <h1 className="text-2xl font-bold">使い方ガイド</h1>
        <p className="text-sm text-muted-foreground">
          {userName ? `${userName} さん、` : ''}
          ようこそ。たすきば Knowledge Relay は「過去のプロジェクトの教訓を{' '}
          <strong>次のプロジェクトで自動的に再利用</strong>
          する」ことを目指す業務マネジメントプラットフォームです。
        </p>
        <p className="inline-flex items-center gap-2 rounded-md border bg-info/5 px-3 py-1 text-xs">
          <span className="text-muted-foreground">あなたのロール:</span>
          <strong>{displayRoleLabel}</strong>
        </p>
      </header>

      {/* ADR-0027 (2026-05-29 PR6): たすきフクロウ AI チャット入力。
          ガイド本文を読み下す前に「何から始めればよい?」を直接フクロウに聞ける動線を提供。 */}
      <HelpChatInput
        variant="page"
        greeting={`こんにちは、たすきフクロウです。\nあなたのロールでできることや、最初にやるべきことなどを聞いてみてください。`}
      />

      {/* 1. サービスの全体像 (視覚化) */}
      <section id="overview" className="space-y-4">
        <h2 className="text-xl font-semibold">サービスの全体像</h2>
        <p className="text-sm">
          プロジェクトを進めると「<strong>過去にも同じ判断をした</strong>」
          「<strong>同じ課題で詰まった</strong>」が繰り返されます。本サービスは
          WBS / リスク / 課題 / 振り返り / ナレッジ を 1 つの空間で扱い、
          新しいプロジェクトに <strong>類似の過去事例を自動で提示</strong> することでこの繰り返しを断ちます。
        </p>

        {/* フロー図: 4 ステップ (横並び、矢印付き) */}
        <FlowDiagram />

        {/* ロール × やること マトリクス表 */}
        <RoleMatrix activeRole={role} />
      </section>

      {/* 2. あなたのやること (ユーザのロール用セクションのみ表示) */}
      <section id="your-work" className="space-y-3">
        <h2 className="text-xl font-semibold">あなたのやること</h2>
        {role === 'admin' && <AdminActions systemRole={systemRole} />}
        {role === 'pm' && <PmActions />}
        {role === 'member' && <MemberActions />}
        {role === 'viewer' && <ViewerActions />}
      </section>

      {/* 3. 用語集 (ロールに応じて項目数を絞る) */}
      <section id="glossary" className="space-y-3">
        <h2 className="text-xl font-semibold">用語集</h2>
        <p className="text-sm text-muted-foreground">
          Ctrl+F (Cmd+F) でキーワード検索できます。
        </p>
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {/* 全ロール共通の基本用語 */}
          <GlossaryItem term="プロジェクト">
            業務の最上位単位。1 つのプロジェクト配下に WBS / リスク / 課題 / 振り返り / ナレッジ等がぶら下がります。
          </GlossaryItem>
          <GlossaryItem term="WBS / WP / Activity">
            プロジェクトの作業を <strong>WP (作業パッケージ)</strong> →{' '}
            <strong>Activity (実作業)</strong> の階層で分解したもの。担当者・予定工数は Activity に付与します。
          </GlossaryItem>
          <GlossaryItem term="ガントチャート">
            タスクを時間軸で並べた工程表。期日超過・並列稼働を視覚的に把握できます。
          </GlossaryItem>
          <GlossaryItem term="リスク / 課題">
            リスク = まだ発生していない潜在的な障害。課題 = すでに発生したブロッカー。
          </GlossaryItem>
          <GlossaryItem term="振り返り / ナレッジ">
            振り返り = プロジェクト後の KPT 形式での内省。ナレッジ = 業務知識を独立した文書にしたもの。
          </GlossaryItem>
          <GlossaryItem term="メンション (@)">
            コメント中で <code>@ユーザ名</code> を入力するとそのユーザに通知が届きます。
          </GlossaryItem>
          <GlossaryItem term="たすきフクロウ (チャット意味検索)">
            全画面右下に常駐する公式マスコット「たすきフクロウ」アイコン。クリックするとチャットパネルが開き、
            <strong>自然文で過去資産を相談</strong> できます。LINE / Teams 風の吹き出し UI で、
            フクロウが Project / Knowledge / Risk / Issue / Retrospective / Memo / 添付ファイル
            を横断検索して提案を返します (全プラン無料・無制限)。
          </GlossaryItem>

          {/* admin/pm のみに表示する高度な用語 */}
          {showAdvancedTerms && (
            <>
              <GlossaryItem term="提案エンジン (参考タブ)">
                プロジェクトの内容に類似した過去のリスク・課題・ナレッジを <strong>自動で抽出</strong>
                して提示する機能。Pro プランでは AI による「なぜ参考になるか」の説明文も付きます。
              </GlossaryItem>
              <GlossaryItem term="テナント">
                <strong>会社・組織</strong> 単位の最上位区切り。テナント間でデータは完全に分離されます。
              </GlossaryItem>
              <GlossaryItem term="プラン (Beginner / Expert / Pro)">
                <strong>Beginner</strong> = 無料・5 席まで (プロジェクト作成・更新 月 50 回まで)。
                <strong>Expert</strong> = 席数無制限・プロジェクト作成・更新 ¥10/回。
                <strong>Pro</strong> = 席数無制限・¥15/回 + AI 説明文付き提案。
              </GlossaryItem>
            </>
          )}
        </dl>
      </section>

      {/* 4. 末尾 CTA: LP / FAQ / Discord (旧 PR I では top にもあった重複を解消) */}
      {/* 2026-05-13 docs/discord-community-positioning: Discord は「開発者へのサポート窓口」ではなく
          開発者・ユーザが集まる「コミュニティ」と位置付ける。ユーザ同士の利用事例共有も発生する場であり、
          単方向のサポートチャネルと誤認されないよう文言を統一する (横展開対象)。 */}
      <section className="rounded-lg border bg-muted/40 p-5">
        <h2 className="text-base font-semibold">関連リンク</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          サービスの背景は LP、よくある質問は FAQ、開発者や他のユーザと話したいときは
          <strong>たすきばコミュニティ (Discord)</strong> でどうぞ (利用事例の共有・質問・バグ報告・要望)。
          画面右上のアカウントメニューからも常時アクセスできます。
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <a
            href={PRODUCT_LP_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md bg-card px-3 py-1.5 text-sm hover:bg-accent"
          >
            🌐 サービス紹介ページ (LP)
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

// ================================================================
// 全体像: 視覚的なフロー図 + ロール × やること表
// ================================================================

/**
 * 4 ステップフロー図 (横並び、矢印付き)。
 * SVG ではなく Tailwind の grid + 矢印を CSS で実現 (依存追加なし)。
 */
function FlowDiagram() {
  const steps = [
    {
      n: 1,
      title: 'プロジェクト作成',
      body: '概要を入力すると、関連する過去のナレッジ・リスク・課題が「参考タブ」に自動表示',
    },
    {
      n: 2,
      title: 'WBS で作業分解',
      body: '作業を WP → Activity に分解し、担当者と予定工数を設定。ガントチャートで進捗を可視化',
    },
    {
      n: 3,
      title: '進行中の記録',
      body: 'リスク・課題・振り返り・ナレッジを発生時点で記録。チームの暗黙知を形式知に',
    },
    {
      n: 4,
      title: '次プロジェクトへ',
      body: '記録した知見は次のプロジェクトの「参考タブ」に自動的に再利用される',
    },
  ];
  return (
    <div
      className="rounded-lg border bg-card p-4"
      aria-label="プロジェクトライフサイクルの 4 ステップフロー"
    >
      <ol className="grid grid-cols-1 gap-3 md:grid-cols-4">
        {steps.map((s, idx) => (
          <li
            key={s.n}
            className="relative flex flex-col rounded-md border bg-background p-3 md:pr-5"
          >
            <div className="mb-2 flex items-center gap-2">
              <span className="flex size-7 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
                {s.n}
              </span>
              <strong className="text-sm">{s.title}</strong>
            </div>
            <p className="text-xs text-muted-foreground">{s.body}</p>
            {/* 矢印 (md 以上で右側に表示、最終ステップは非表示) */}
            {idx < steps.length - 1 && (
              <span
                aria-hidden
                className="absolute -right-3 top-1/2 hidden -translate-y-1/2 text-lg text-muted-foreground md:block"
              >
                →
              </span>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * ロール × できること マトリクス表。
 * 自分のロール行を背景色で強調し、「自分は何ができるか」を一目で把握できる。
 */
function RoleMatrix({ activeRole }: { activeRole: GuideRole }) {
  const rows: Array<{
    role: GuideRole;
    label: string;
    items: Array<'create' | 'edit' | 'view' | 'admin'>;
  }> = [
    // 2026-05-13 docs/guide-role-actions: 実装真実 (check-permission.ts) と一致させる修正。
    //   旧マトリクスは admin が 'create' / 'edit' 非可能と表示していたが、これは誤り。
    //   `admin` ロールは check-permission.ts:58 で全アクション (project:create / update / delete /
    //   change_status / task:* / knowledge:* / risk:* / member:manage / admin:users 等) を許可済み。
    //   ガイドが実装と乖離するとユーザが「admin はプロジェクトを作れない」と誤認するため修正。
    { role: 'admin', label: 'テナント管理者', items: ['create', 'edit', 'view', 'admin'] },
    { role: 'pm', label: 'PM / PL', items: ['create', 'edit', 'view'] },
    { role: 'member', label: '一般メンバー', items: ['edit', 'view'] },
    { role: 'viewer', label: '閲覧者', items: ['view'] },
  ];
  const cols: Array<{ key: 'admin' | 'create' | 'edit' | 'view'; label: string }> = [
    { key: 'create', label: 'プロジェクト作成・WBS 計画' },
    { key: 'edit', label: '担当タスクの進捗更新 / 起票' },
    { key: 'view', label: 'リスク・課題・ナレッジ閲覧' },
    { key: 'admin', label: 'ユーザ管理・プラン設定' },
  ];
  return (
    <div className="overflow-x-auto rounded-lg border bg-card">
      <table className="w-full border-collapse text-sm">
        <thead className="bg-muted/40">
          <tr>
            <th className="border-b p-2 text-left">ロール</th>
            {cols.map((c) => (
              <th key={c.key} className="border-b p-2 text-left text-xs font-medium">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const isMe = r.role === activeRole;
            return (
              <tr
                key={r.role}
                className={isMe ? 'bg-info/10 font-medium' : ''}
                aria-label={isMe ? `あなたのロール: ${r.label}` : undefined}
              >
                <td className="border-b p-2">
                  {r.label}
                  {isMe && (
                    <span className="ml-2 rounded bg-info/30 px-1.5 py-0.5 text-xs">あなた</span>
                  )}
                </td>
                {cols.map((c) => (
                  <td key={c.key} className="border-b p-2 text-center">
                    {r.items.includes(c.key) ? (
                      <span aria-label="可能" className="text-emerald-600 dark:text-emerald-400">
                        ✓
                      </span>
                    ) : (
                      <span aria-label="不可" className="text-muted-foreground/40">
                        −
                      </span>
                    )}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ================================================================
// ロール別アクション (ユーザのロールに応じて 1 つだけレンダされる)
// ================================================================

function AdminActions({ systemRole }: { systemRole: string }) {
  return (
    <div className="space-y-3 rounded-md border bg-card p-4">
      <p className="text-sm text-muted-foreground">
        組織全体の設定・ユーザ管理・課金プランの調整、および新規プロジェクトの立ち上げを担当します。
      </p>
      <ol className="list-decimal space-y-1.5 pl-6 text-sm">
        <li>
          <Link className="text-primary underline" href="/admin/users">
            ユーザ管理
          </Link>{' '}
          からメンバーを招待 (メール送信)。受信者がパスワードを設定すると参加完了。
        </li>
        {/* 2026-05-13 docs/guide-role-actions: プロジェクト新規作成は admin の主要業務として明示。
            実装真実 (check-permission.ts) では admin / pm_tl の両方が project:create 可能だが、
            運用フロー上 admin がプロジェクトを立ち上げて PM/PL にメンバー権限を割り当てるのが
            標準的。pm_tl も自身で作成可だが、組織管理の文脈では admin の役割が中心。 */}
        <li>
          <Link className="text-primary underline" href={PROJECTS_ROUTE}>
            プロジェクト一覧
          </Link>{' '}
          で「+ 新規」を押して新しいプロジェクトを立ち上げ、PM/PL に運営権限を割り当て。
        </li>
        <li>
          <Link className="text-primary underline" href="/settings/tenant">
            テナント設定
          </Link>{' '}
          でプラン・月次予算・請求先・支払い方法を確認・変更。
        </li>
        <li>
          <Link className="text-primary underline" href="/admin/audit-logs">
            監査ログ
          </Link>{' '}
          /{' '}
          <Link className="text-primary underline" href="/admin/role-changes">
            権限変更
          </Link>{' '}
          で重要操作の追跡 (退職時引継ぎ等)。
        </li>
        <li>
          生成 AI の利用状況・課金額は{' '}
          <Link className="text-primary underline" href="/settings/tenant">
            テナント設定
          </Link>{' '}
          のダッシュボードで日次確認。
        </li>
        {systemRole === 'super_admin' && (
          <li>
            <strong>システム管理者向け:</strong>{' '}
            <Link className="text-primary underline" href="/admin/super">
              システム管理者ダッシュボード
            </Link>{' '}
            から全テナントの使用量・請求合計・休眠テナント警告を確認できます。
          </li>
        )}
      </ol>
    </div>
  );
}

function PmActions() {
  return (
    <div className="space-y-3 rounded-md border bg-card p-4">
      <p className="text-sm text-muted-foreground">
        プロジェクトの計画・進捗管理・人員配置・リスク統制を担います。
      </p>
      <ol className="list-decimal space-y-1.5 pl-6 text-sm">
        {/* 2026-05-13 docs/guide-role-actions: 運用フローを反映。テナント管理者がプロジェクトを
            立ち上げて PM/PL に権限割当するのが標準。pm_tl 自身もプロジェクト作成可だが (実装真実)、
            ガイドとしては「割り当てられた直後の動き」を主軸に説明する方がユーザに伝わりやすい。 */}
        <li>
          テナント管理者から割り当てられたプロジェクトを{' '}
          <Link className="text-primary underline" href={PROJECTS_ROUTE}>
            プロジェクト一覧
          </Link>{' '}
          で開き、概要・期間・顧客を確認。自身で新たに立ち上げる場合は「+ 新規」を押せば、AI が自動でタグを抽出します。
        </li>
        <li>
          作成直後の <strong>「参考」タブ</strong> に並ぶ過去のリスク・課題・ナレッジを必ず確認 (見落とし防止)。
        </li>
        <li>
          WBS タブで作業を <strong>WP → Activity</strong> に分解。Activity に担当者・予定工数・期間を設定。
        </li>
        <li>
          ガントチャートで並列稼働状況・期日超過を確認、必要なら工数集計でメンバーの過負荷を検知。
        </li>
        <li>
          発生し得る不確実性は{' '}
          <Link className="text-primary underline" href={ALL_RISKS_ROUTE}>
            リスク
          </Link>
          、すでに発生したブロッカーは{' '}
          <Link className="text-primary underline" href={ALL_ISSUES_ROUTE}>
            課題
          </Link>{' '}
          に記録。
        </li>
        <li>
          プロジェクト完了後は{' '}
          <Link className="text-primary underline" href={ALL_RETROSPECTIVES_ROUTE}>
            振り返り
          </Link>{' '}
          を必ず実施 (Keep/Problem/Try)。これが次プロジェクトの参考になります。
        </li>
        <li>
          重要な学びは{' '}
          <Link className="text-primary underline" href={KNOWLEDGE_ROUTE}>
            ナレッジ
          </Link>{' '}
          として独立記録 (公開範囲を「公開」に設定すれば、テナント内の他プロジェクトからも参照できます)。
        </li>
      </ol>
    </div>
  );
}

function MemberActions() {
  return (
    <div className="space-y-3 rounded-md border bg-card p-4">
      <p className="text-sm text-muted-foreground">
        アサインされた作業の進行と、現場で気づいた知見の記録が中心です。
      </p>
      <ol className="list-decimal space-y-1.5 pl-6 text-sm">
        <li>
          毎日まず{' '}
          <Link className="text-primary underline" href={MY_TASKS_ROUTE}>
            マイタスク
          </Link>{' '}
          を開く。担当 Activity がプロジェクト毎にツリー表示されます。
        </li>
        <li>
          Activity の状態 (未着手 / 着手 / 完了) を更新し、進捗バーで実績を反映。
        </li>
        <li>
          作業中に「将来詰まりそう」と感じたら即{' '}
          <Link className="text-primary underline" href={ALL_RISKS_ROUTE}>
            リスク
          </Link>{' '}
          に起票。すでに詰まったら{' '}
          <Link className="text-primary underline" href={ALL_ISSUES_ROUTE}>
            課題
          </Link>{' '}
          に。
        </li>
        <li>
          コメントで <code>@</code> を使って関係者にメンション (確実に通知が届きます)。
        </li>
        <li>
          共有したい知見は{' '}
          <Link className="text-primary underline" href={KNOWLEDGE_ROUTE}>
            ナレッジ
          </Link>{' '}
          に書き起こす (公開範囲はプロジェクト内 / 全社で選択可)。
        </li>
      </ol>
    </div>
  );
}

function ViewerActions() {
  return (
    <div className="space-y-3 rounded-md border bg-card p-4">
      <p className="text-sm text-muted-foreground">
        書き込みは行えませんが、関係者にプロジェクトの状況を共有する用途で使います (役員・営業担当など)。
      </p>
      <ol className="list-decimal space-y-1.5 pl-6 text-sm">
        <li>プロジェクト概要・WBS・ガントチャートを <strong>閲覧のみ</strong> 可能。</li>
        <li>リスク・課題・ナレッジ・振り返りも閲覧可能 (公開範囲に応じて)。</li>
        <li>コメントの新規投稿は不可。質問は別途メンバー経由で書き込んでもらう運用。</li>
        <li>マイタスク画面は使えません (担当タスクが付与されないため)。</li>
      </ol>
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
