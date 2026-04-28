'use client';

import { useState } from 'react';
import { Input } from './input';

/**
 * 数値入力フィールド。
 *
 * 仕様（2026-04-17 ユーザ要件）:
 * - 入力値が **min 以上（既定: 1）の有効値** の場合 → その値を保持・表示
 * - 入力値が **min 未満 もしくは 数値以外** の場合 → 値を 0 に再正規化し、表示もクリア
 *   （空の input は視覚的に「0（未入力相当）」を意味する）
 *
 * 従来の `<Input type="number" value={number} onChange={Number(e.target.value)}>` では、
 * 値 0 が "0" として表示されたままになり、ユーザが 0 を削除して別の値を入力しづらい
 * UX バグが発生していた。本コンポーネントは内部で文字列状態を持ち、外部には
 * 常に有効な number（min 以上 もしくは 0）を onChange で通知する。
 *
 * Props:
 * - value: 親が保持する現在値（number）
 * - onChange: 値が変わった際に呼ばれる。常に number を渡す
 * - min: 有効とみなす最小値（既定 1）。これ未満なら 0 にリセット
 * - max: 任意。これを超える値は max に丸める
 * - step / className / required / placeholder: 通常の input 属性
 */
type NumberInputProps = {
  value: number;
  onChange: (next: number) => void;
  min?: number;
  max?: number;
  step?: number;
  className?: string;
  required?: boolean;
  placeholder?: string;
  disabled?: boolean;
  'aria-label'?: string;
};

export function toDisplay(value: number, min: number): string {
  // 有効値なら数値文字列、無効値（min 未満）なら空文字で「0 が残らない」状態を作る
  if (Number.isFinite(value) && value >= min) return String(value);
  return '';
}

/**
 * blur 時の入力テキストを正規化する。ユーザ要件の「1以上なら値、0以下/非数値なら 0」を反映。
 * 返り値の `display` をそのまま input に反映し、`value` をフォーム state に反映する。
 */
export function normalizeNumberInput(
  text: string,
  min: number,
  max?: number,
): { value: number; display: string } {
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed < min) {
    return { value: 0, display: '' };
  }
  const clamped = typeof max === 'number' && parsed > max ? max : parsed;
  return { value: clamped, display: String(clamped) };
}

export function NumberInput({
  value,
  onChange,
  min = 1,
  max,
  step,
  className,
  required,
  placeholder,
  disabled,
  'aria-label': ariaLabel,
}: NumberInputProps) {
  // ユーザが編集中のテキストバッファ。null は「at rest」状態で、
  // 表示は prop の value から派生させる（外部更新に自動追従）。
  const [editingText, setEditingText] = useState<string | null>(null);
  const display = editingText ?? toDisplay(value, min);

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    setEditingText(e.target.value);
  }

  function handleBlur() {
    const result = normalizeNumberInput(editingText ?? '', min, max);
    setEditingText(null); // 編集バッファを捨て、再度 value 派生の表示に戻す
    if (value !== result.value) onChange(result.value);
  }

  // Phase C 要件 21 (2026-04-28): step が 1 未満 (0.5 等の小数 step) の場合は
  //   inputMode='decimal' で小数点キー付きキーパッドを出す (iOS 対応)。
  //   step 未指定 / 1 以上の場合は従来通り 'numeric' (整数キーパッド)。
  const inputModeValue: 'numeric' | 'decimal'
    = step != null && step < 1 ? 'decimal' : 'numeric';

  return (
    <Input
      type="number"
      inputMode={inputModeValue}
      value={display}
      onChange={handleChange}
      onBlur={handleBlur}
      min={min}
      max={max}
      step={step}
      className={className}
      required={required}
      placeholder={placeholder}
      disabled={disabled}
      aria-label={ariaLabel}
    />
  );
}
