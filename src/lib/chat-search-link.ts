/**
 * チャット意味検索の hit → 詳細遷移 URL を生成する pure ヘルパ。
 *
 * URL 規約は [src/lib/entity-link.ts] (通知の deep link 生成) と整合させる。
 * 「全○○」一覧画面側で `useAutoOpenDialog` が `?xxxId=...` を読み取って
 * 該当行の参照ダイアログを auto-open する設計に依存している。
 *
 * 詳細 page.tsx は MVP 時点で project 以外は存在せず、`useAutoOpenDialog`
 * 経由のダイアログ表示が唯一の単票閲覧手段。`/risks/{id}` 等のパス指定は 404 になる
 * (PR #432 リリース時の不具合: 全 5 資産のうち project 以外で 404、UAT で報告)。
 *
 * 振り分けルール:
 *   - project       : /projects/{id}                      (専用詳細 page あり)
 *   - knowledge     : /knowledge?knowledgeId={id}         (全ナレッジで auto-open)
 *   - risk          : /risks?riskId={id}                  (全リスクで auto-open)
 *   - issue         : /issues?riskId={id}                 (全課題で auto-open、queryKey は共通 'riskId')
 *   - retrospective : /retrospectives?retroId={id}        (全振り返りで auto-open)
 *   - memo (自分)    : /memos?memoId={id}                  (個人メモ画面で auto-open。自分の private も対象)
 *   - memo (他人 public) : /all-memos?memoId={id}          (全メモ画面で auto-open、read-only)
 *
 * memo の振り分けは authorUserId と viewerUserId の比較で行う。
 * viewerUserId が未指定 (session 未取得等) の場合は安全側に /all-memos を返す
 * (= 自分の private memo は開けないが、他人の public memo へのリンクは破綻しない)。
 *
 * entity-link.ts (通知 deep link) との差分: 通知では memo を常に `/all-memos` 一本に倒すが、
 * チャット意味検索は自分の private memo も結果対象 (chat-search.service.ts §loadMemos) のため
 * `/memos` での auto-open 経路を必要とする。本ヘルパは chat-search 固有の分岐を持つ。
 *
 * 拡張性 (将来):
 *   - 新規 kind 追加時は exhaustive switch がコンパイルエラーで気付かせる
 *   - 専用詳細 page を後で作る場合はこの 1 ファイルの該当 case を差し替えるだけ
 *   - options 引数を追加すれば commentId / tab / anchor 等の deep link 拡張に対応可能
 *
 * セキュリティ: hit.id は DB UUID 由来で特殊文字を含まないが、`encodeURIComponent` を
 * 通す defense-in-depth で URL injection / CodeQL 警告を予防する (commit 4629d3e で
 * 同種警告 4 件を解消した方針と整合)。
 */

import type { ChatSearchHit } from '@/services/chat-search.service';

export interface BuildChatHitLinkOptions {
  /** ログイン中ユーザの id。memo の自分/他人 判定に使用。 */
  viewerUserId?: string | null;
}

export function buildChatHitLink(
  hit: ChatSearchHit,
  options: BuildChatHitLinkOptions = {},
): string {
  const id = encodeURIComponent(hit.id);
  switch (hit.kind) {
    case 'project':
      return `/projects/${id}`;
    case 'knowledge':
      return `/knowledge?knowledgeId=${id}`;
    case 'risk':
      return `/risks?riskId=${id}`;
    case 'issue':
      return `/issues?riskId=${id}`;
    case 'retrospective':
      return `/retrospectives?retroId=${id}`;
    case 'memo': {
      const viewerUserId = options.viewerUserId;
      const isOwn =
        viewerUserId != null && hit.authorUserId != null && hit.authorUserId === viewerUserId;
      return isOwn ? `/memos?memoId=${id}` : `/all-memos?memoId=${id}`;
    }
    default: {
      const _exhaustive: never = hit.kind;
      throw new Error(`Unknown chat hit kind: ${String(_exhaustive)}`);
    }
  }
}
