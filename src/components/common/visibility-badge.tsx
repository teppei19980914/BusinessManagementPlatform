'use client';

/**
 * VisibilityBadge (Phase E 要件 1〜3 / 共通部品化, 2026-04-29):
 *
 * 「公開範囲」を表示するバッジの共通部品。
 * 同一の「`<Badge variant={x === 'public' ? 'default' : 'outline'}>{label}</Badge>`」
 * パターンが Memo / Risk / Issue / Retrospective / Knowledge / 全○○一覧で繰り返し
 * 出現していたため抽出。
 *
 * 値域:
 *   - 'draft' / 'public' : Risk / Issue / Retrospective / Knowledge (PR #60 で 2 値統合)
 *   - 'private' / 'public': Memo (DB schema が独立)
 *
 * 表示マッピング:
 *   - public  → default variant (塗りつぶし) + 「公開」ラベル
 *   - draft   → outline variant + 「下書き」ラベル
 *   - private → outline variant + 「非公開」ラベル
 *
 * i18n: ラベルは呼出側で渡す (next-intl の hook は server/client 境界の都合で
 *       ラッパ側で hard-code しない)。
 */

import { Badge } from '@/components/ui/badge';

type VisibilityValue = 'draft' | 'public' | 'private' | string;

type Props = {
  visibility: VisibilityValue;
  /** 表示ラベル (ja: 下書き / 公開 / 非公開、en: Draft / Public / Private) */
  label: string;
  /** 「公開: 」のような prefix を付けたい場合 (Retrospective が使用) */
  prefix?: string;
  className?: string;
};

export function VisibilityBadge({ visibility, label, prefix, className }: Props) {
  // public のみ default variant (塗りつぶし)。それ以外 (draft / private / 不明値) は outline。
  const variant = visibility === 'public' ? 'default' : 'outline';
  return (
    <Badge variant={variant} className={className}>
      {prefix}{label}
    </Badge>
  );
}
