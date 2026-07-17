import type { LucideIcon } from 'lucide-react';

export function EmptyState({
  icon: Icon,
  title,
  hint,
}: {
  icon: LucideIcon;
  title: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-16">
      <Icon size={28} className="mb-3 text-muted-foreground" strokeWidth={1.5} />
      <p className="text-sm font-medium">{title}</p>
      {hint && <p className="mt-1 text-[13px] text-muted-foreground">{hint}</p>}
    </div>
  );
}
