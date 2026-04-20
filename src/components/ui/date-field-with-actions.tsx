'use client';

/**
 * DateFieldWithActions (PR #71): 日付 input の右に「今日」「削除」ボタンを備えた共通部品。
 *
 * 背景:
 *   ブラウザ標準の <input type="date"> はカレンダーポップオーバー内部にしか「今日」「削除」
 *   (クリア) 相当のボタンを持たない。ユーザはカレンダーを開く → ボタンを探す、の 2 ステップ
 *   が必要で操作負担が大きい。本コンポーネントは input の隣にボタンを常時露出し、
 *   1 クリックで今日日付設定 / 空文字クリアを実行できるようにする。
 *
 * 使い方:
 *   既存の `<Input type="date" value={x} onChange={(e) => setX(e.target.value)} />` を
 *   以下に差し替えるだけ:
 *     <DateFieldWithActions value={x} onChange={setX} />
 *
 * 互換性:
 *   - onChange は文字列を直接受け取る (onChange={setX} のように state setter を渡せる)
 *   - 空文字 '' がクリア状態を表現する (既存コードの `form.xxxDate || null` 変換と整合)
 *   - disabled / required は HTML input と同じセマンティクスで透過
 */

import type { ReactNode } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

/** 日付 (YYYY-MM-DD) を今日の文字列で返す。タイムゾーン差異を避けるためローカル時刻を使用。 */
function todayString(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

type Props = {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  required?: boolean;
  /** 削除ボタンを非表示にしたい場合 (required の場面など) */
  hideClear?: boolean;
  /** 今日ボタンの title 属性カスタマイズ用 (アクセシビリティ) */
  todayLabel?: ReactNode;
  clearLabel?: ReactNode;
};

export function DateFieldWithActions({
  value,
  onChange,
  disabled,
  required,
  hideClear,
  todayLabel = '今日',
  clearLabel = '削除',
}: Props) {
  return (
    <div className="flex items-center gap-1">
      <Input
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        required={required}
        className="flex-1"
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="shrink-0 px-2"
        onClick={() => onChange(todayString())}
        disabled={disabled}
        title="今日の日付を設定"
      >
        {todayLabel}
      </Button>
      {!hideClear && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0 px-2 text-gray-600"
          onClick={() => onChange('')}
          disabled={disabled || !value}
          title="日付をクリア"
        >
          {clearLabel}
        </Button>
      )}
    </div>
  );
}
