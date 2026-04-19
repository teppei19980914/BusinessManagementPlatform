'use client';

/**
 * useBatchAttachments (PR #67): 一覧表示用の添付バッチ取得フック。
 *
 * 使い方:
 *   const attachmentsByEntity = useBatchAttachments('risk', risks.map(r => r.id));
 *   // 各行 render: attachmentsByEntity[r.id] ?? []
 *
 * 実装方針:
 *   - entityIds が変わったら POST /api/attachments/batch で一括取得
 *   - 結果を Map として保持し、行レンダリングで O(1) lookup させる
 *   - 失敗時は空 Map を返す (一覧そのものを落とさない)
 *   - react-hooks/set-state-in-effect の例外は他のサジェスト API と同様
 */

import { useEffect, useRef, useState } from 'react';
import type { AttachmentEntityType } from '@/lib/validators/attachment';
import type { AttachmentDTO } from '@/services/attachment.service';

export function useBatchAttachments(
  entityType: AttachmentEntityType,
  entityIds: string[],
  slot: string = 'general',
): Record<string, AttachmentDTO[]> {
  const [map, setMap] = useState<Record<string, AttachmentDTO[]>>({});
  // entityIds は毎レンダで新しい配列になるため、内容変化を文字列比較で検出
  const key = entityIds.join(',') + '|' + slot + '|' + entityType;
  const keyRef = useRef<string>('');

  useEffect(() => {
    if (keyRef.current === key) return;
    keyRef.current = key;
    if (entityIds.length === 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 空 ID リストへの初期化、DESIGN.md §22 例外 (外部 API 同期)
      setMap({});
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/attachments/batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ entityType, entityIds, slot }),
        });
        if (!res.ok) {
          if (!cancelled) setMap({});
          return;
        }
        const json = await res.json();
        if (!cancelled) setMap((json.data as Record<string, AttachmentDTO[]>) ?? {});
      } catch {
        if (!cancelled) setMap({});
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [key, entityType, entityIds, slot]);

  return map;
}
