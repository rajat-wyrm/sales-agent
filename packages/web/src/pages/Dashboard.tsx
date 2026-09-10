import React from 'react';
import { useQuery } from 'react-query';
import { dashboard, admin } from '@/lib/api';
import { useSSE } from '@/hooks/useSSE';
import { useAuthStore } from '@/stores/auth';
import { CreditUsageResponse, RunLog } from '@/lib/api';
import {
  Users,
  Flame,
  Sun,
  Snowflake,
  ShieldAlert,
  Zap,
  TrendingUp,
  Activity,
  BarChart3,
  CheckCircle2,
  Clock,
  AlertTriangle,
} from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { StatCard, StatCardGrid } from '@/components/ui/stat-card';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { PageLoader } from '@/components/ui/spinner';
import { ErrorState } from '@/components/ui/error-state';
import { EmptyState } from '@/components/ui/empty-state';
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

const Dashboard: React.FC = () => {
  const { data, isLoading, error, refetch } = useQuery('dashboard-stats', () => dashboard.stats(), {
    refetchInterval: 30000,
  });

  const { data: creditData } = useQuery('dashboard-credits', () => dashboard.credits(), {
    refetchInterval: 30000,
  });

  const user = useAuthStore((s) => s.user);
  const isAdmin = user?.role === 'admin';

  const { data: runsData } = useQuery('dashboard-runs', () => admin.getRuns(10), {
    refetchInterval: 30000,
    enabled: isAdmin,
  });

  useSSE('/sse/token', (event) => {
    if (
      event.type === 'stats_updated' ||
      event.type === 'lead_score_updated' ||
      event.type === 'pipeline_stage_changed'
    ) {
      refetch();
    }
  });

  if (isLoading) return <PageLoader label="Loading dashboard…" />;
  if (error)
    return <ErrorState title="Error loading dashboard" message={(error as Error).message} onRetry={() => refetch()} />;

  const totals = data?.totals || {
    total_leads: 0,
    hot: 0,
    warm: 0,
    cold: 0,
    do_not_contact: 0,
  };

  const credits: CreditUsageResponse | undefined = creditData as CreditUsageResponse | undefined;
  const runs: RunLog[] = (runsData as any)?.runs || (runsData as any) || [];

  const creditPercent = credits ? Math.min((credits.used / credits.limit) * 100, 100) : 0;
  const creditTone = creditPercent > 80 ? 'bg-destructive' : creditPercent > 50 ? 'bg-warning' : 'bg-success';

  const runStatusIcon = (run: RunLog) => {
    if (run.finished_at) return <CheckCircle2 className="h-4 w-4 text-success" />;
    if (run.started_at && !run.finished_at)
      return <Clock className="h-4 w-4 animate-pulse text-info" />;
    return <AlertTriangle className="h-4 w-4 text-muted-foreground" />;
  };

  const funnel = data?.funnel ? (data.funnel as Record<string, number>) : {};
  const maxCount = Math.max(...Object.values(funnel), 1);
  const totalLeads = Object.values(funnel).reduce((a, b) => a + b, 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        description="Live overview of your lead pipeline and intelligence health"
      />

      <StatCardGrid>
        <StatCard icon={Users} label="Total Leads" value={totals.total_leads} tone="primary" />
        <StatCard icon={Flame} label="Hot Leads" value={totals.hot} tone="danger" />
        <StatCard icon={Sun} label="Warm Leads" value={totals.warm} tone="warning" />
        <StatCard icon={Snowflake} label="Cold Leads" value={totals.cold} tone="info" />
        <StatCard icon={ShieldAlert} label="Do Not Contact" value={totals.do_not_contact || 0} tone="muted" />
      </StatCardGrid>

      {credits && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Zap className="h-5 w-5 text-warning" />
              Credit Usage
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">
                <span className="font-semibold text-foreground">{credits.used.toLocaleString()}</span> of{' '}
                {credits.limit.toLocaleString()} credits used
              </span>
              <span className="font-medium tabular-nums">{creditPercent.toFixed(1)}%</span>
            </div>
            <div className="h-3 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={`h-3 rounded-full transition-all duration-500 ${creditTone}`}
                style={{ width: `${creditPercent}%` }}
              />
            </div>
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>Remaining: {credits.remaining.toLocaleString()} credits</span>
              {credits.period_start && credits.period_end && (
                <span>
                  {formatDateTime(credits.period_start)} – {formatDateTime(credits.period_end)}
                </span>
              )}
            </div>
            {credits.by_provider && Object.keys(credits.by_provider).length > 0 && (
              <div className="grid grid-cols-2 gap-3 pt-2 md:grid-cols-4">
                {Object.entries(credits.by_provider).map(([provider, usage]) => {
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

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5 text-primary" />
              Pipeline Funnel
            </CardTitle>
          </CardHeader>
          <CardContent>
            {Object.keys(funnel).length === 0 ? (
              <EmptyState icon={BarChart3} title="No pipeline data yet" description="Leads will appear here as they're discovered." />
            ) : (
              <div className="space-y-4">
                {Object.entries(funnel).map(([stage, count]) => {
                  const pct = ((count as number) / maxCount) * 100;
                  const share = totalLeads > 0 ? (((count as number) / totalLeads) * 100).toFixed(1) : '0';
                  return (
                    <div key={stage} className="space-y-1.5">
                      <div className="flex items-center justify-between text-[13px]">
                        <span className="font-medium text-foreground capitalize">
                          {STAGE_LABELS[stage] || stage.replace(/_/g, ' ')}
                        </span>
                        <span className="tabular-nums text-muted-foreground">
                          {count as number} <span className="text-xs">({share}%)</span>
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

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Activity className="h-5 w-5 text-info" />
              Source Health
            </CardTitle>
          </CardHeader>
          <CardContent>
            {data?.source_health && data.source_health.length > 0 ? (
              <div className="space-y-2">
                {data.source_health.map((s: any) => (
                  <div
                    key={s.source_name}
                    className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2.5"
                  >
                    <span className="truncate text-sm font-medium capitalize">{s.source_name}</span>
                    {s.is_open ? (
                      <Badge variant="danger" className="shrink-0">
                        {s.consecutive_failures} failures
                      </Badge>
                    ) : (
                      <Badge variant="success" className="shrink-0">
                        Healthy
                      </Badge>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState icon={Activity} title="No source health data" description="Source status will appear once scrapers begin running." />
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BarChart3 className="h-5 w-5 text-muted-foreground" />
            Recent Runs
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {runs.length === 0 ? (
            <EmptyState icon={BarChart3} title="No run history" description="Scrape runs will appear here once triggered." />
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
                  {runs.map((run: RunLog) => (
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
                        className="table-td max-w-[180px] truncate text-xs text-destructive"
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

export default Dashboard;