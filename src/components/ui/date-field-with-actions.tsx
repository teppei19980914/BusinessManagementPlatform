'use client';

/**
 * DateFieldWithActions (PR #71 初版 / PR #72 刷新):
 *   日付フィールド本体と「今日」「削除」ボタンを横並びにした共通部品。
 *
 * PR #72 の変更点:
 *   ブラウザ標準 `<input type="date">` はカレンダーポップオーバー内部に独自の
 *   「今日」「クリア」ボタン (ベンダー依存) を持ち、CSS/JS で非表示にできない。
 *   ユーザ要望 (PR #72 Task 1) で「カレンダー内の今日/削除は消してほしい」ため、
 *   native input を完全に排して自作の Popover + 日付グリッドに置き換える。
 *
 *   カレンダーは「月ナビゲーション + 7×6 の日付グリッド」のみで、
 *   今日/クリアは常時外側 (右側) のボタンから行う設計に統一した。
 *
 * 使い方 (PR #71 の呼び出し側に変更なし — 後方互換):
 *   <DateFieldWithActions value={x} onChange={setX} />
 *   value / onChange は 'YYYY-MM-DD' 文字列 (空文字 '' がクリア状態)。
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import {
  buildMonthGrid,
  formatYMD,
  parseYMD,
  todayString,
} from './date-field-helpers';

const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

type CalendarPanelProps = {
  value: string;
  onSelect: (value: string) => void;
};

/**
 * 日付グリッド本体 (ポップオーバー内側)。「今日」「削除」ボタンは意図的に持たない
 * (PR #72 要件: カレンダー内からそれらの機能を取り除く)。
 */
function CalendarPanel({ value, onSelect }: CalendarPanelProps) {
  const parsed = parseYMD(value);
  const initialY = parsed?.y ?? new Date().getFullYear();
  const initialM = parsed?.m ?? new Date().getMonth() + 1;

  // 表示中の年月 (ナビで動く)。選択値とは独立。
  const [visibleY, setVisibleY] = useState(initialY);
  const [visibleM, setVisibleM] = useState(initialM);

  const grid = buildMonthGrid(visibleY, visibleM);
  const today = todayString();

  function prevMonth() {
    if (visibleM === 1) {
      setVisibleY(visibleY - 1);
      setVisibleM(12);
    } else {
      setVisibleM(visibleM - 1);
    }
  }
  function nextMonth() {
    if (visibleM === 12) {
      setVisibleY(visibleY + 1);
      setVisibleM(1);
    } else {
      setVisibleM(visibleM + 1);
    }
  }

  return (
    <div className="w-[min(90vw,260px)] rounded-md border bg-card p-2 shadow-md">{/* PR #128: 320px 端末等での画面外はみ出し回避 (viewport 幅の 90% 上限) */}
      <div className="mb-2 flex items-center justify-between">
        <button
          type="button"
          onClick={prevMonth}
          className="rounded px-2 py-1 text-sm hover:bg-accent"
          aria-label="前の月"
        >
          ‹
        </button>
        <div className="text-sm font-medium" aria-live="polite">
          {visibleY} 年 {visibleM} 月
        </div>
        <button
          type="button"
          onClick={nextMonth}
          className="rounded px-2 py-1 text-sm hover:bg-accent"
          aria-label="次の月"
        >
          ›
        </button>
      </div>
      <div className="grid grid-cols-7 gap-0.5 text-center text-xs text-muted-foreground">
        {WEEKDAY_LABELS.map((label, i) => (
          <div key={label} className={i === 0 ? 'text-destructive' : i === 6 ? 'text-info' : ''}>
            {label}
          </div>
        ))}
      </div>
      <div className="mt-1 grid grid-cols-7 gap-0.5">
        {grid.flat().map((d, idx) => {
          if (d === null) {
            return <div key={idx} className="h-8" aria-hidden />;
          }
          const ymd = formatYMD(visibleY, visibleM, d);
          const isSelected = ymd === value;
          const isToday = ymd === today;
          return (
            <button
              key={idx}
              type="button"
              onClick={() => onSelect(ymd)}
              className={[
                'h-8 rounded text-sm transition-colors',
                isSelected
                  ? 'bg-info text-info-foreground hover:bg-info/90'
                  : isToday
                    ? 'bg-info/10 font-semibold text-info hover:bg-info/20'
                    : 'hover:bg-accent',
              ].join(' ')}
              aria-label={ymd}
              aria-current={isToday ? 'date' : undefined}
              aria-pressed={isSelected}
            >
              {d}
            </button>
          );
        })}
      </div>
    </div>
  );
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
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // 外部クリック / Escape で閉じる
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const displayText = value || '日付を選択';

  return (
    // PR #85: gap-1 (4px) は 2 列並び時にボタンが圧迫されたので gap-2 + flex-wrap で逃がす
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative flex-1" ref={rootRef}>
        <button
          type="button"
          onClick={() => !disabled && setOpen((v) => !v)}
          disabled={disabled}
          aria-haspopup="dialog"
          aria-expanded={open}
          data-required={required ? 'true' : undefined}
          className={[
            'flex h-9 w-full items-center rounded-md border border-input bg-background px-3 py-1 text-left text-sm shadow-xs transition-colors',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            disabled ? 'cursor-not-allowed opacity-50' : 'hover:bg-muted',
            !value ? 'text-muted-foreground' : 'text-foreground',
          ].join(' ')}
        >
          {displayText}
        </button>
        {open && (
          <div className="absolute left-0 top-full z-50 mt-1" role="dialog" aria-label="日付選択">
            <CalendarPanel
              value={value}
              onSelect={(ymd) => {
                onChange(ymd);
                setOpen(false);
              }}
            />
          </div>
        )}
      </div>
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
          className="shrink-0 px-2 text-muted-foreground"
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
