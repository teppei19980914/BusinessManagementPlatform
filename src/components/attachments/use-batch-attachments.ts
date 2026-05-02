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

import { useEffect, useMemo, useRef, useState } from 'react';
import type { AttachmentEntityType } from '@/lib/validators/attachment';
import type { AttachmentDTO } from '@/services/attachment.service';

// UUID v1-v8 (RFC 4122) — 一覧 entity の id は全て gen_random_uuid() 由来 (= UUID v4)。
//   2026-05-01 fix/attachments-batch-400: クライアント側でも事前 filter を挟み、
//   無駄な 400 ラウンドトリップ + Vercel log ノイズを防ぐ。
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

export function useBatchAttachments(
  entityType: AttachmentEntityType,
  entityIds: string[],
  slot: string = 'general',
): Record<string, AttachmentDTO[]> {
  const [map, setMap] = useState<Record<string, AttachmentDTO[]>>({});
  // 不正 ID (空文字 / 一時 ID / ステージ中など) を事前除外。サーバ側の lenient フィルタと
  // 二重防御し、無駄な 400 を発生させない。`useMemo` で entityIds の identity 変動を吸収。
  const validIds = useMemo(
    () => entityIds.filter((id) => typeof id === 'string' && UUID_RE.test(id)),
    [entityIds],
  );
  // validIds 単位で fetch trigger (entityIds の中身が同じなら fetch 不要)
  const key = validIds.join(',') + '|' + slot + '|' + entityType;
  const keyRef = useRef<string>('');

  useEffect(() => {
    if (keyRef.current === key) return;
    keyRef.current = key;
    if (validIds.length === 0) {
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
          body: JSON.stringify({ entityType, entityIds: validIds, slot }),
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
  }, [key, entityType, validIds, slot]);

  return map;
}
