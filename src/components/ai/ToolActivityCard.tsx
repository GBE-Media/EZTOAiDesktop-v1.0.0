import type { ToolActivity } from '@/types/assistant';

export function ToolActivityCard({ activity }: { activity: ToolActivity }) {
  return (
    <div className="rounded-lg border border-border bg-secondary/20 p-2 text-[11px]">
      <div className="font-medium">{activity.title}</div>
      {activity.summary && <div className="text-muted-foreground">{activity.summary}</div>}
    </div>
  );
}
