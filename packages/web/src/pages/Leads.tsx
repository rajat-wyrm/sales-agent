import React, { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from 'react-query';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  flexRender,
  createColumnHelper,
  SortingState,
  ColumnFiltersState,
} from '@tanstack/react-table';
import { useNavigate } from 'react-router-dom';
import { leads as leadsApi } from '@/lib/api';
import { Lead } from '@/lib/types';
import {
  Search,
  RefreshCw,
  ChevronUp,
  ChevronDown,
  Play,
  Sparkles,
  BadgeCheck,
  FileText,
  MessageCircle,
  Eye,
  Users,
  Mail,
  XCircle,
} from 'lucide-react';
import { useSSE } from '@/hooks/useSSE';
import { useAuthStore } from '@/stores/auth';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Avatar } from '@/components/ui/avatar';
import { Select } from '@/components/ui/select';
import { PageHeader } from '@/components/ui/page-header';
import { PageLoader } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { Pagination } from '@/components/ui/pagination';
import { Card, CardContent, CardTitle } from '@/components/ui/card';
import { SCORE_BAND_META, STAGE_META, EMAIL_STATUS_META, WHATSAPP_STATUS_META, formatDate } from '@/lib/format';

const PAGE_SIZE = 10;

const Leads: React.FC = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [globalFilter, setGlobalFilter] = useState('');
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: PAGE_SIZE });
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [draftChannel, setDraftChannel] = useState<'email' | 'whatsapp' | 'both'>('both');
  const [experienceFilter, setExperienceFilter] = useState<'fresher' | '0-1yr' | '0-2yr' | 'no-experience' | ''>('');

  const sortParam = sorting.length > 0 ? sorting[0].id : 'created_at';
  const sortOrder = sorting.length > 0 ? (sorting[0].desc ? 'desc' : 'asc') : 'desc';
  const scoreBand = columnFilters.find((f) => f.id === 'score_band')?.value as string | undefined;
  const pipelineStage = columnFilters.find((f) => f.id === 'pipeline_stage')?.value as string | undefined;
  const sourceSite = columnFilters.find((f) => f.id === 'source_site')?.value as string | undefined;
  const experience = experienceFilter || undefined;
  const page = pagination.pageIndex + 1;
  const limit = pagination.pageSize;

  const { data, isLoading, refetch, isError, error } = useQuery(
    ['leads', page, limit, sortParam, sortOrder, scoreBand, pipelineStage, sourceSite, globalFilter, experience],
    () =>
      leadsApi.list({
        page,
        limit,
        sort_by: sortParam as 'lead_score' | 'created_at' | 'updated_at' | 'company_name' | 'job_title' | 'source_site' | 'hr_name',
        sort_order: sortOrder as 'asc' | 'desc',
        score_band: scoreBand,
        pipeline_stage: pipelineStage,
        source_site: sourceSite,
        filter: globalFilter || undefined,
        experience,
      }),
    { staleTime: 30000, onError: () => {} },
  );

  useSSE('/sse/token', (event) => {
    if (
      event.type === 'lead_updated' ||
      event.type === 'lead_score_updated' ||
      event.type === 'pipeline_stage_changed' ||
      event.type === 'enrichment_completed' ||
      event.type === 'verification_completed' ||
      event.type === 'send_completed'
    ) {
      refetch();
    }
  });

  const bulkDraftMutation = useMutation(
    ({ leadIds, channel }: { leadIds: string[]; channel: 'email' | 'whatsapp' | 'both' }) =>
      leadsApi.bulkDraft(leadIds, channel),
    {
      onSuccess: () => {
        setSelectedIds(new Set());
        queryClient.invalidateQueries('leads');
        toast({ title: 'Drafts generated', description: 'Outreach drafts queued for selected leads.', variant: 'success' });
      },
      onError: (err) => {
        toast({ title: 'Failed to generate drafts', description: (err as Error).message, variant: 'error' });
      },
    },
  );

  const runAction = (fn: Promise<unknown>, successMsg: string) => {
    fn.then(() => toast({ title: successMsg, variant: 'success' })).catch((err: Error) =>
      toast({ title: 'Action failed', description: err.message, variant: 'error' }),
    );
  };

  const handleView = (id: string) => navigate(`/leads/${id}`);
  const handleEnrich = (id: string) => runAction(leadsApi.enrich(id, 'auto'), 'Enrichment started');
  const handleVerify = (id: string) => runAction(leadsApi.verify(id), 'Verification completed');
  const handleDraft = (id: string) => runAction(leadsApi.draft(id, 'both'), 'Draft generated');
  const handleSend = (id: string, channel: 'email' | 'whatsapp' | 'both' = 'both') =>
    runAction(leadsApi.send(id, channel), 'Message sent');

  const toggleSelectAll = () => {
    const allIds = new Set<string>(leadRows.map((r: { original: Lead }) => r.original.id));
    if (allIds.size === selectedIds.size && Array.from(allIds).every((id) => selectedIds.has(id))) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(allIds);
    }
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleBulkDraft = () => {
    if (selectedIds.size === 0) return;
    bulkDraftMutation.mutate({ leadIds: Array.from(selectedIds), channel: draftChannel });
  };

  const leadData = (data as any) ?? { data: [], pagination: { page: 1, limit: 50, total: 0, pages: 0 } };
  const leadRows = leadData.data || [];

  const canEnrich = (lead: Lead) =>
    lead.pipeline_stage === 'discovered' || lead.pipeline_stage === 'enriched';
  const canVerify = (lead: Lead) =>
    lead.pipeline_stage === 'enriched' && !lead.do_not_contact;
  const canDraft = (lead: Lead) =>
    ['enriched', 'verified'].includes(lead.pipeline_stage) && !lead.do_not_contact;
  const canSend = (lead: Lead) =>
    ['drafted', 'contacted'].includes(lead.pipeline_stage) && !lead.do_not_contact;

  const columnHelper = createColumnHelper<Lead>();

  const columns = useMemo(
    () => [
      columnHelper.display({
        id: 'select',
        header: () => (
          <input
            type="checkbox"
            aria-label="Select all leads"
            checked={leadRows.length > 0 && leadRows.every((r: Lead) => selectedIds.has(r.id))}
            onChange={toggleSelectAll}
            className="h-4 w-4 cursor-pointer rounded border-input accent-primary"
          />
        ),
        cell: ({ row }) => (
          <input
            type="checkbox"
            aria-label={`Select ${row.original.company_name || row.original.id}`}
            checked={selectedIds.has(row.original.id)}
            onChange={() => toggleSelect(row.original.id)}
            className="h-4 w-4 cursor-pointer rounded border-input accent-primary"
          />
        ),
        size: 40,
      }),
      columnHelper.accessor('lead_score', {
        header: 'Score',
        cell: (info) => {
          const band = info.row.original.score_band as 'hot' | 'warm' | 'cold';
          const meta = SCORE_BAND_META[band];
          return (
            <div className="flex items-center gap-2">
              <span className="inline-flex h-8 w-8 items-center justify-center rounded-full border bg-muted text-[13px] font-bold tabular-nums">
                {info.getValue()}
              </span>
              {meta && <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />}
            </div>
          );
        },
      }),
      columnHelper.accessor('company_name', {
        header: 'Company',
        cell: (info) => (
          <div className="min-w-0">
            <p className="truncate font-medium text-foreground">{info.getValue() || '—'}</p>
            {info.row.original.company_domain && (
              <p className="truncate text-xs text-muted-foreground">{info.row.original.company_domain}</p>
            )}
          </div>
        ),
      }),
      columnHelper.accessor('job_title', {
        header: 'Job Title',
        cell: (info) => {
          const lead = info.row.original;
          const title = info.getValue() || lead.source_site || '—';
          return <span className="text-muted-foreground">{title}</span>;
        },
      }),
      columnHelper.accessor('hr_name', {
        header: 'HR Name',
        cell: (info) => {
          const lead = info.row.original;
          return lead.hr_name ? (
            <div className="flex items-center gap-2.5">
              <Avatar name={lead.hr_name} size="sm" />
              <div className="min-w-0">
                <p className="truncate text-[13px] font-medium">{lead.hr_name}</p>
                {lead.hr_email && <p className="truncate text-xs text-muted-foreground">{lead.hr_email}</p>}
              </div>
            </div>
          ) : (
            <span className="text-xs text-muted-foreground">Not yet enriched</span>
          );
        },
      }),
      columnHelper.display({
        id: 'verification',
        header: 'Verification',
        cell: ({ row }) => {
          const lead = row.original;
          const emailMeta = EMAIL_STATUS_META[lead.email_status ?? 'unknown'];
          const waMeta = WHATSAPP_STATUS_META[lead.whatsapp_status ?? 'unknown'];
          return (
            <div className="flex flex-wrap gap-1.5">
              {emailMeta && <Badge className={emailMeta.className}>{emailMeta.label}</Badge>}
              {waMeta && <Badge className={waMeta.className}>{waMeta.label}</Badge>}
            </div>
          );
        },
      }),
      columnHelper.display({
        id: 'stage',
        header: 'Stage',
        cell: ({ row }) => {
          const meta = STAGE_META[row.original.pipeline_stage];
          return (
            <Badge className={meta.className}>
              <span className="capitalize">{meta.label}</span>
            </Badge>
          );
        },
      }),
      columnHelper.accessor('source_site', {
        header: 'Source',
        cell: (info) => (
          <span className="text-[13px] text-muted-foreground capitalize">{info.getValue() || '—'}</span>
        ),
      }),
      columnHelper.accessor('created_at', {
        header: 'Discovered',
        cell: (info) => <span className="text-[13px] text-muted-foreground">{formatDate(info.getValue())}</span>,
      }),
      columnHelper.display({
        id: 'actions',
        header: 'Actions',
        cell: ({ row }) => {
          const lead = row.original;
          return (
            <div className="flex flex-wrap items-center gap-1.5 whitespace-nowrap">
              <Button onClick={() => handleView(lead.id)} variant="ghost" size="icon-sm" title="View lead">
                <Eye className="h-4 w-4" />
              </Button>
              {canEnrich(lead) && (
                <Button onClick={() => handleEnrich(lead.id)} variant="soft" size="sm" disabled={lead.do_not_contact}>
                  <Sparkles className="h-3.5 w-3.5" />
                  Enrich
                </Button>
              )}
              {canVerify(lead) && (
                <Button onClick={() => handleVerify(lead.id)} variant="soft" size="sm">
                  <BadgeCheck className="h-3.5 w-3.5" />
                  Verify
                </Button>
              )}
              {canDraft(lead) && (
                <Button onClick={() => handleDraft(lead.id)} variant="soft" size="sm">
                  <FileText className="h-3.5 w-3.5" />
                  Draft
                </Button>
              )}
              {canSend(lead) && (
                <>
                  <Button
                    onClick={() => handleSend(lead.id, 'email')}
                    variant="outline"
                    size="sm"
                    className="text-success hover:bg-success-soft"
                  >
                    <Mail className="h-3.5 w-3.5" />
                    Email
                  </Button>
                  <Button
                    onClick={() => handleSend(lead.id, 'whatsapp')}
                    variant="outline"
                    size="sm"
                    className="text-info hover:bg-info-soft"
                  >
                    <MessageCircle className="h-3.5 w-3.5" />
                    WhatsApp
                  </Button>
                </>
              )}
              {lead.do_not_contact && (
                <Badge variant="danger">
                  <XCircle className="h-3 w-3" />
                  DNC
                </Badge>
              )}
            </div>
          );
        },
      }),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [leadRows, selectedIds, toast],
  );

  const table = useReactTable({
    data: leadRows,
    columns,
    state: { sorting, columnFilters, globalFilter, pagination },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
    onPaginationChange: setPagination,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    manualPagination: true,
    manualSorting: true,
    manualFiltering: true,
    pageCount: leadData.pagination?.pages ?? 0,
  });

  if (isLoading) return <PageLoader label="Loading leads..." />;

  if (isError) {
    const isAuthError = error instanceof Error && error.message?.includes('401');
    return (
      <ErrorState
        title="Error loading leads"
        message={(error as Error).message}
        onRetry={() => {
          if (isAuthError) {
            useAuthStore.getState?.()?.logout?.();
            navigate('/login');
          } else {
            refetch();
          }
        }}
      />
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Leads"
        description="Track, enrich, and reach out to your discovered leads"
        actions={
          <>
            <div className="relative w-full sm:w-64">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                value={globalFilter ?? ''}
                onChange={(e) => setGlobalFilter(e.target.value)}
                placeholder="Search leads…"
                className="input pl-9"
              />
            </div>
            <Select
              value={experienceFilter}
              onChange={(e) => setExperienceFilter(e.target.value as never)}
              className="w-40"
              aria-label="Filter by experience"
            >
              <option value="">All experience</option>
              <option value="fresher">Fresher</option>
              <option value="0-1yr">0-1 years</option>
              <option value="0-2yr">0-2 years</option>
              <option value="no-experience">No experience</option>
            </Select>
            <Button variant="outline" onClick={() => refetch()}>
              <RefreshCw className="h-4 w-4" />
              Refresh
            </Button>
          </>
        }
      />

      {selectedIds.size > 0 && (
        <div className="card flex flex-wrap items-center gap-3 border-primary/30 bg-primary-soft px-4 py-3 animate-fade-in">
          <Users className="h-4 w-4 text-primary" />
          <span className="text-sm font-medium text-foreground">
            {selectedIds.size} lead{selectedIds.size > 1 ? 's' : ''} selected
          </span>
          <Select
            value={draftChannel}
            onChange={(e) => setDraftChannel(e.target.value as 'email' | 'whatsapp' | 'both')}
            className="w-36"
            aria-label="Draft channel"
          >
            <option value="both">Both channels</option>
            <option value="email">Email</option>
            <option value="whatsapp">WhatsApp</option>
          </Select>
          <Button onClick={handleBulkDraft} loading={bulkDraftMutation.isLoading}>
            <Play className="h-4 w-4" />
            {bulkDraftMutation.isLoading ? 'Generating…' : 'Generate Drafts'}
          </Button>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setSelectedIds(new Set())}>
            Clear selection
          </Button>
        </div>
      )}

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              {table.getHeaderGroups().map((headerGroup) => (
                <tr key={headerGroup.id} className="border-b border-border bg-muted/40">
                  {headerGroup.headers.map((header) => (
                    <th
                      key={header.id}
                      className="table-th select-none"
                      onClick={header.column.getCanSort() ? header.column.getToggleSortingHandler() : undefined}
                      style={{ cursor: header.column.getCanSort() ? 'pointer' : 'default', width: header.getSize() }}
                    >
                      <span className="inline-flex items-center gap-1">
                        {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                        {header.column.getCanSort() && (
                          <span className="inline-flex flex-col">
                            <ChevronUp
                              className={`-mb-1 h-3 w-3 ${header.column.getIsSorted() === 'asc' ? 'text-primary' : 'text-muted-foreground/40'}`}
                            />
                            <ChevronDown
                              className={`h-3 w-3 ${header.column.getIsSorted() === 'desc' ? 'text-primary' : 'text-muted-foreground/40'}`}
                            />
                          </span>
                        )}
                      </span>
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody>
              {table.getRowModel().rows.length === 0 ? (
                <tr>
                  <td colSpan={columns.length} className="px-4 py-4">
                    <EmptyState
                      icon={Users}
                      title="No leads found."
                      description="Try adjusting your search or refresh to pull the latest leads."
                      action={
                        <Button variant="outline" size="sm" onClick={() => refetch()}>
                          <RefreshCw className="h-3.5 w-3.5" />
                          Refresh
                        </Button>
                      }
                    />
                  </td>
                </tr>
              ) : (
                table.getRowModel().rows.map((row) => (
                  <tr
                    key={row.id}
                    className={`border-b border-border transition-colors last:border-0 hover:bg-accent/50 ${selectedIds.has(row.original.id) ? 'bg-primary-soft/40' : ''}`}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id} className="table-td">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {leadData.pagination && (
          <div className="border-t border-border">
            <Pagination pagination={leadData.pagination} onPageChange={(p) => setPagination({ ...pagination, pageIndex: p - 1 })} />
          </div>
        )}
      </div>
    </div>
  );
};

export default Leads;