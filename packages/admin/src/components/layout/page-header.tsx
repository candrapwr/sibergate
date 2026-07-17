import type { ReactNode } from 'react';

/** Page header with title + optional actions (right-aligned). */
export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border pb-4">
      <div>
        <h1 className="text-lg font-semibold">{title}</h1>
        {subtitle && <p className="mt-0.5 text-[13px] text-muted-foreground">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
