'use client';

/**
 * StagedAttachmentsInput (PR #67): 作成ダイアログ内で使う添付入力フォーム。
 *
 * 背景: 既存の `AttachmentList` は `entityId` を前提に API と直接やり取りする。
 * 一方「新規作成」時点ではまだ entity が存在しないため、一旦ローカル state
 * (React useState) に URL を積んでおき、親ダイアログが entity 作成成功後に
 * `persistStagedAttachments` を呼んで一括 POST する設計。
 *
 * 使い方 (親コンポーネント):
 *   const [staged, setStaged] = useState<StagedAttachment[]>([]);
 *   <StagedAttachmentsInput value={staged} onChange={setStaged} />
 *   // create 成功後:
 *   await persistStagedAttachments({ entityType: 'risk', entityId: newId, items: staged });
 *
 * エラーハンドリング方針:
 *   - entity 作成は成功したが一部添付の POST が失敗した場合、親エンティティは残す
 *   - 失敗分だけ親に返し、ユーザに「一部添付の保存に失敗しました」と伝える
 */

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { AttachmentEntityType } from '@/lib/validators/attachment';

export type StagedAttachment = {
  displayName: string;
  url: string;
};

type Props = {
  value: StagedAttachment[];
  onChange: (next: StagedAttachment[]) => void;
  label?: string;
};

/** URL スキームのクライアント側簡易検査 (サーバ側 validator とロジックを揃える) */
const SAFE_URL_SCHEME = /^https?:\/\//i;

export function StagedAttachmentsInput({ value, onChange, label = '関連 URL' }: Props) {
  function addEmpty() {
    onChange([...value, { displayName: '', url: '' }]);
  }
  function removeAt(i: number) {
    onChange(value.filter((_, idx) => idx !== i));
  }
  function updateAt(i: number, patch: Partial<StagedAttachment>) {
    onChange(value.map((v, idx) => (idx === i ? { ...v, ...patch } : v)));
  }

  return (
    <div className="space-y-2">
      <Label>{label} <span className="text-xs text-muted-foreground">(作成後に自動で保存されます)</span></Label>
      {value.length === 0 && (
        <p className="text-xs text-muted-foreground">添付なし</p>
      )}
      {value.map((item, i) => {
        const schemeInvalid = item.url.length > 0 && !SAFE_URL_SCHEME.test(item.url);
        return (
          <div key={i} className="flex items-end gap-2 rounded border bg-muted p-2">
            <div className="flex-1 space-y-1">
              <Label className="text-xs">表示名</Label>
              <Input
                value={item.displayName}
                onChange={(e) => updateAt(i, { displayName: e.target.value })}
                placeholder="例: 設計書"
                maxLength={200}
              />
            </div>
            <div className="flex-[2] space-y-1">
              <Label className="text-xs">URL</Label>
              <Input
                type="url"
                value={item.url}
                onChange={(e) => updateAt(i, { url: e.target.value })}
                placeholder="https://..."
                maxLength={2000}
                pattern="https?://.*"
              />
              {schemeInvalid && (
                <p className="text-xs text-destructive">http:// または https:// で始まる必要があります</p>
              )}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-destructive"
              onClick={() => removeAt(i)}
            >
              削除
            </Button>
          </div>
        );
      })}
      <Button type="button" variant="outline" size="sm" onClick={addEmpty}>
        + URL を追加
      </Button>
    </div>
  );
}

/**
 * 作成成功直後、ステージされた添付を API に一括 POST する。
 * 失敗件数を返し、部分成功時に親が通知できるようにする。
 */
export async function persistStagedAttachments(args: {
  entityType: AttachmentEntityType;
  entityId: string;
  items: StagedAttachment[];
}): Promise<{ succeeded: number; failed: number }> {
  let succeeded = 0;
  let failed = 0;
  for (const item of args.items) {
    // 空欄は無視 (ユーザが「追加」ボタンで空行を作ったまま送信した場合)
    if (!item.url || !item.displayName) continue;
    if (!SAFE_URL_SCHEME.test(item.url)) {
      failed++;
      continue;
    }
    try {
      const res = await fetch('/api/attachments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entityType: args.entityType,
          entityId: args.entityId,
          slot: 'general',
          displayName: item.displayName,
          url: item.url,
        }),
      });
      if (res.ok) succeeded++;
      else failed++;
    } catch {
      failed++;
    }
  }
  return { succeeded, failed };
}
