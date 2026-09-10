import React, { useMemo } from 'react';
import { useQuery } from 'react-query';
import { dashboard, admin, CreditUsageResponse, RunLog } from '@/lib/api';
import { PageHeader } from '@/components/ui/page-header';
import { StatCard, StatCardGrid } from '@/components/ui/stat-card';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { PageLoader } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import {
  Users,
  Flame,
  Sun,
  Snowflake,
  TrendingUp,
  Zap,
  BarChart3,
  CheckCircle2,
  Clock,
  AlertTriangle,
} from 'lucide-react';
import { formatDateTime } from '@/lib/format';

const STAGE_LABELS: Record<string, string> = {
  discovered: 'Discovered',
  enriched: 'Enriched',
  verified: 'Verified',
  drafted: 'Drafted',
  contacted: 'Contacted',
  replied: 'Replied',
  bounced: 'Bounced',
};

const Analytics: React.FC = () => {
  const { data: stats, isLoading: statsLoading } = useQuery('dashboard-stats', () => dashboard.stats());
  const { data: credits, isLoading: creditsLoading } = useQuery('dashboard-credits', () => dashboard.credits());
  const { data: runs, isLoading: runsLoading } = useQuery('dashboard-runs', () => admin.getRuns(20));

  const funnelEntries = useMemo(() => {
    if (!stats?.funnel) return [];
    return Object.entries(stats.funnel).sort((a, b) => (b[1] as number) - (a[1] as number));
  }, [stats]);

  const totalFunnel = useMemo(
    () => funnelEntries.reduce((sum, [, count]) => sum + (count as number), 0),
    [funnelEntries],
  );

  const creditUsage: CreditUsageResponse | undefined = credits as CreditUsageResponse | undefined;
  const runList: RunLog[] = (runs as any)?.runs || [];

  const runStatusIcon = (run: RunLog) => {
    if (run.finished_at) return <CheckCircle2 className="h-4 w-4 text-success" />;
    if (run.started_at && !run.finished_at) return <Clock className="h-4 w-4 animate-pulse text-info" />;
    return <AlertTriangle className="h-4 w-4 text-muted-foreground" />;
  };

  if (statsLoading || creditsLoading || runsLoading) {
    return <PageLoader label="Loading analytics…" />;
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Analytics" description="Deep dive into pipeline performance and resource usage" />

      <StatCardGrid>
        <StatCard icon={Users} label="Total Leads" value={stats?.totals?.total_leads ?? 0} tone="primary" />
        <StatCard icon={Flame} label="Hot Leads" value={stats?.totals?.hot ?? 0} tone="danger" />
        <StatCard icon={Sun} label="Warm Leads" value={stats?.totals?.warm ?? 0} tone="warning" />
        <StatCard icon={Snowflake} label="Cold Leads" value={stats?.totals?.cold ?? 0} tone="info" />
      </StatCardGrid>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5 text-primary" />
            Pipeline Conversion
          </CardTitle>
        </CardHeader>
        <CardContent>
          {totalFunnel === 0 ? (
            <EmptyState icon={TrendingUp} title="No pipeline data yet." description="Funnel metrics will appear once leads are discovered." />
          ) : (
            <div className="space-y-4">
              {funnelEntries.map(([stage, count]) => {
                const pct = totalFunnel > 0 ? ((count as number) / totalFunnel) * 100 : 0;
                const stageLabel = STAGE_LABELS[stage] || stage.replace(/_/g, ' ');
                const meta = STAGE_META[stage as keyof typeof STAGE_META];
                return (
                  <div key={stage} className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[13px] font-medium capitalize">{stageLabel}</span>
                      <span className="text-[13px] font-medium tabular-nums">
                        {count as number} <span className="text-xs text-muted-foreground">({pct.toFixed(1)}%)</span>
                      </span>
                    </div>
                    <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-2.5 rounded-full bg-gradient-to-r from-primary to-indigo-400 transition-all duration-500"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {creditUsage && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Zap className="h-5 w-5 text-warning" />
              Credit Usage
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <div className="rounded-lg border border-border bg-muted/40 p-4">
                <p className="text-xs text-muted-foreground">Used</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">{creditUsage.used.toLocaleString()}</p>
                <p className="text-xs text-muted-foreground">of {creditUsage.limit.toLocaleString()} total</p>
              </div>
              <div className="rounded-lg border border-border bg-muted/40 p-4">
                <p className="text-xs text-muted-foreground">Remaining</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">{creditUsage.remaining.toLocaleString()}</p>
              </div>
              <div className="rounded-lg border border-border bg-muted/40 p-4">
                <p className="text-xs text-muted-foreground">Billing Period</p>
                <p className="mt-1 text-lg font-semibold">
                  {formatDateTime(creditUsage.period_start)} – {formatDateTime(creditUsage.period_end)}
                </p>
              </div>
            </div>

            {creditUsage.by_provider && Object.keys(creditUsage.by_provider).length > 0 && (
              <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
                {Object.entries(creditUsage.by_provider).map(([provider, usage]) => {
                  const pct = usage.limit > 0 ? Math.min((usage.used / usage.limit) * 100, 100) : 0;
                  return (
                    <div key={provider} className="rounded-lg border border-border bg-muted/50 p-3">
                      <p className="mb-1 text-xs text-muted-foreground capitalize">{provider}</p>
                      <p className="text-sm font-medium tabular-nums">
                        {usage.used}/{usage.limit}
                      </p>
                      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                        <div
                          className={`h-1.5 rounded-full ${pct > 80 ? 'bg-destructive' : pct > 50 ? 'bg-warning' : 'bg-success'}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BarChart3 className="h-5 w-5 text-muted-foreground" />
            Run History
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {runList.length === 0 ? (
            <EmptyState icon={BarChart3} title="No runs recorded yet." description="Scrape runs will appear here once triggered." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border">
                    <th className="table-th">Status</th>
                    <th className="table-th">Run ID</th>
                    <th className="table-th">Attempted</th>
                    <th className="table-th">Succeeded</th>
                    <th className="table-th">Leads Found</th>
                    <th className="table-th">New</th>
                    <th className="table-th">Started</th>
                    <th className="table-th">Finished</th>
                    <th className="table-th">Circuit Broken</th>
                  </tr>
                </thead>
                <tbody>
                  {runList.map((run: RunLog) => (
                    <tr key={run.id} className="border-b border-border transition-colors last:border-0 hover:bg-accent/50">
                      <td className="table-td">{runStatusIcon(run)}</td>
                      <td className="table-td font-mono text-xs">{run.id}</td>
                      <td className="table-td tabular-nums">{run.sources_attempted}</td>
                      <td className="table-td tabular-nums">{run.sources_succeeded}</td>
                      <td className="table-td tabular-nums font-medium">{run.leads_found}</td>
                      <td className="table-td tabular-nums">{run.leads_deduped}</td>
                      <td className="table-td text-xs text-muted-foreground">{formatDateTime(run.started_at)}</td>
                      <td className="table-td text-xs text-muted-foreground">
                        {run.finished_at ? formatDateTime(run.finished_at) : '—'}
                      </td>
                      <td
                        className="table-td max-w-[200px] truncate text-xs text-destructive"
                        title={run.sources_circuit_broken?.join(', ') || ''}
                      >
                        {run.sources_circuit_broken?.join(', ') || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default Analytics;