'use client';

/**
 * DialogAttachmentSection (Phase E 要件 1〜3 / 共通部品化, 2026-04-29):
 *
 * 編集 dialog 内の URL 添付セクションを共通化。
 * `{!readOnly && (<><SingleUrlField source/><AttachmentList general/></>)}` の構造が
 * 3 つの dialog (knowledge / retrospective / risk) で同じ shape で繰り返されていた。
 *
 * 2026-05-01 (PR fix/sticky-and-readonly-links): readOnly 時の挙動を変更。
 *   旧仕様: readOnly なら `return null` でセクションごと非表示。
 *           これにより「全○○」(cross-list の readOnly dialog) で参考リンクが見えなかった。
 *   新仕様: readOnly でも `canEdit={false}` で **読み取り専用表示** (リンク一覧は見える、
 *           追加/編集/削除 UI のみ非表示)。`/api/attachments` GET は public な entity に
 *           対しては fix/cross-list-non-member-columns (2026-04-27) で非メンバー閲覧可
 *           として開放済のため、403 で詰まる経路は既に解消されている。
 *
 * 受け付けるスロット:
 *   - source (任意): SingleUrlField を slot='source' で挿入。一次情報源 URL 用 (Knowledge)。
 *   - main: AttachmentList を slot='general' で挿入 (全 dialog 共通)。
 */

import { SingleUrlField } from '@/components/attachments/single-url-field';
import { AttachmentList } from '@/components/attachments/attachment-list';
import type { AttachmentEntityType } from '@/lib/validators/attachment';

type Props = {
  entityType: AttachmentEntityType;
  entityId: string;
  /** dialog 全体の readOnly モード (作成者本人以外で true)。
   *  true → 追加/編集/削除 UI を隠した参照表示、false → 編集可能 */
  readOnly: boolean;
  /** 単数スロットの URL (Knowledge: '一次情報源 URL')。省略時は描画しない */
  source?: {
    label: string;
    defaultDisplayName?: string;
  };
  /** 複数スロットの URL ('参考リンク' / '関連 URL') */
  mainLabel: string;
};

export function DialogAttachmentSection({
  entityType,
  entityId,
  readOnly,
  source,
  mainLabel,
}: Props) {
  // 2026-05-01: readOnly でもセクションを描画。`canEdit` を反転させて編集 UI のみ隠す。
  const canEdit = !readOnly;
  return (
    <>
      {source && (
        <SingleUrlField
          entityType={entityType}
          entityId={entityId}
          slot="source"
          canEdit={canEdit}
          label={source.label}
          defaultDisplayName={source.defaultDisplayName}
        />
      )}
      <AttachmentList
        entityType={entityType}
        entityId={entityId}
        canEdit={canEdit}
        label={mainLabel}
      />
    </>
  );
}
