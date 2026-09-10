import { Radar } from "lucide-react";
import { cn } from "@/components/ui/cn";

export function Logo({
  className,
  showText = true,
}: {
  className?: string;
  showText?: boolean;
}) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <div className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 via-indigo-600 to-violet-600 shadow-sm shadow-indigo-500/30">
        <Radar className="h-5 w-5 text-white" strokeWidth={2.2} />
      </div>
      {showText && (
        <div className="min-w-0 leading-tight">
          <p className="text-[15px] font-bold tracking-tight text-foreground">
            HireGen
          </p>
          <p className="text-[10.5px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            Lead Intelligence
          </p>
        </div>
      )}
    </div>
  );
}