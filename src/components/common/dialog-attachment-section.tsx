'use client';

/**
 * DialogAttachmentSection (Phase E 要件 1〜3 / 共通部品化, 2026-04-29):
 *
 * 編集 dialog 内の URL 添付セクションを共通化。
 * `{!readOnly && (<><SingleUrlField source/><AttachmentList general/></>)}` の構造が
 * 3 つの dialog (knowledge / retrospective / risk) で同じ shape で繰り返されていた。
 *
 * **readOnly 非表示の理由**: §5.14 (`fix/attachment-list-non-member-403`) で確立した
 * パターン。dialog を非作成者が開く場合 (Phase B 要件 5)、AttachmentList 内部の
 * `/api/attachments?entityType=...` GET で 403 が返るため readOnly 時は描画しない。
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
  /** dialog 全体の readOnly モード (作成者本人以外で true)。true の時はセクションごと非表示 */
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
  if (readOnly) return null;
  return (
    <>
      {source && (
        <SingleUrlField
          entityType={entityType}
          entityId={entityId}
          slot="source"
          canEdit
          label={source.label}
          defaultDisplayName={source.defaultDisplayName}
        />
      )}
      <AttachmentList
        entityType={entityType}
        entityId={entityId}
        canEdit
        label={mainLabel}
      />
    </>
  );
}
