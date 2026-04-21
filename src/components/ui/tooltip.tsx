'use client';

import * as React from 'react';
import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip';

import { cn } from '@/lib/utils';

/**
 * ホバーで付随情報を表示する base-ui Tooltip の薄いラッパ。
 *
 * 使い方:
 *   <Tooltip content={<>詳細</>}>
 *     <div>hover me</div>
 *   </Tooltip>
 *
 * children には単一 React 要素を渡す（trigger 要素として使用される）。
 * delay (ms) は Trigger の開閉遅延で base-ui デフォルトの 600ms より短めに上書き。
 */
function Tooltip({
  content,
  children,
  delay = 150,
  side = 'top',
  align = 'center',
  className,
}: {
  content: React.ReactNode;
  children: React.ReactElement;
  delay?: number;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  className?: string;
}) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger delay={delay} render={children} />
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner side={side} align={align} sideOffset={6} className="isolate z-50">
          <TooltipPrimitive.Popup
            className={cn(
              'pointer-events-none rounded-md bg-foreground px-2.5 py-1.5 text-xs text-background shadow-md ring-1 ring-foreground/10 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0',
              className,
            )}
          >
            {content}
          </TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

export { Tooltip };
