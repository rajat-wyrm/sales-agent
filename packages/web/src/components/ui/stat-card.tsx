import type { LucideIcon } from "lucide-react"
import { cn } from "@/components/ui/cn"
import { Spinner } from "@/components/ui/spinner"

export type StatTone = "primary" | "success" | "warning" | "danger" | "info" | "muted"

const toneMap: Record<StatTone, string> = {
  primary: "bg-primary-soft text-primary-hover",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-hot-soft text-hot",
  info: "bg-info-soft text-info",
  muted: "bg-muted text-muted-foreground",
}

export interface StatCardProps {
  icon: LucideIcon
  label: string
  value?: number | string | null
  tone?: StatTone
  suffix?: string
  hint?: string
  loading?: boolean
  className?: string
}

export function StatCard({
  icon: Icon,
  label,
  value,
  tone = "muted",
  suffix,
  hint,
  loading,
  className,
}: StatCardProps) {
  return (
    <div
      className={cn(
        "card flex items-start gap-4 p-5 transition-shadow duration-200 hover:shadow-card-hover",
        className
      )}
    >
      <div
        className={cn(
          "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl",
          toneMap[tone]
        )}
      >
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-muted-foreground">{label}</p>
        <div className="mt-0.5 flex items-baseline gap-1.5">
          {loading ? (
            <div className="skeleton h-7 w-16" />
          ) : (
            <>
              <span className="text-2xl font-semibold tracking-tight tabular-nums">
                {value ?? '—'}
              </span>
              {suffix && <span className="text-sm text-muted-foreground">{suffix}</span>}
            </>
          )}
        </div>
        {hint && <p className="mt-1 truncate text-xs text-muted-foreground">{hint}</p>}
      </div>
    </div>
  )
}

export function StatCardSkeleton() {
  return (
    <div className="card flex items-start gap-4 p-5">
      <div className="skeleton h-11 w-11 rounded-xl" />
      <div className="flex-1 space-y-2.5">
        <div className="skeleton h-3.5 w-24" />
        <div className="skeleton h-7 w-16" />
      </div>
    </div>
  )
}

export function StatCardGrid({
  loading,
  children,
}: {
  loading?: boolean
  children: React.ReactNode
}) {
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4 xl:grid-cols-5">
      {loading
        ? Array.from({ length: 5 }).map((_, i) => <StatCardSkeleton key={i} />)
        : children}
    </div>
  )
}