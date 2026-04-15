'use client';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

type LabeledSelectProps = {
  value: string;
  onValueChange: (value: string | null) => void;
  options: Record<string, string>;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
};

/**
 * 選択済みの値を日本語ラベルで表示する Select コンポーネント。
 * shadcn/ui v4 の Select は value をそのまま表示するため、
 * このコンポーネントでラベル変換を行う。
 */
export function LabeledSelect({
  value,
  onValueChange,
  options,
  placeholder = '選択...',
  className,
  disabled,
}: LabeledSelectProps) {
  const displayLabel = value ? options[value] || value : undefined;

  return (
    <Select value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectTrigger className={className}>
        {displayLabel ? (
          <span>{displayLabel}</span>
        ) : (
          <SelectValue placeholder={placeholder} />
        )}
      </SelectTrigger>
      <SelectContent>
        {Object.entries(options).map(([key, label]) => (
          <SelectItem key={key} value={key}>
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
