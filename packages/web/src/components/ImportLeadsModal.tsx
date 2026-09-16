import React, { useMemo, useRef, useState } from 'react';
import { useMutation } from 'react-query';
import { Upload, FileSpreadsheet, CheckCircle2, AlertTriangle, Loader2 } from 'lucide-react';
import { leads as leadsApi, type ImportResult } from '@/lib/api';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { normaliseLeadRecords, parseDelimited, type ParsedImport } from '@/lib/leadColumns';

const MAX_FILE_BYTES = 8 * 1024 * 1024; // ~5k rows of full-fidelity export

/**
 * CSV / TSV import with automatic dedup.
 *
 * The file is parsed here purely for the preview (which columns we recognised, how many
 * rows look usable); the server re-parses the raw text and owns every dedup decision, so
 * what a user sees as "will merge" can never disagree with what actually happens.
 */
export function ImportLeadsModal({
  open, onClose, onDone,
}: {
  open: boolean;
  onClose: () => void;
  /** Called after a successful commit so the list refetches. */
  onDone: (result: ImportResult) => void;
}) {
  const [fileName, setFileName] = useState('');
  const [text, setText] = useState('');
  const [parsed, setParsed] = useState<ParsedImport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<ImportResult | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setFileName(''); setText(''); setParsed(null); setError(null); setPlan(null);
    if (fileRef.current) fileRef.current.value = '';
  };

  const analyse = (name: string, contents: string) => {
    setFileName(name); setText(contents); setPlan(null); setError(null);
    try {
      const table = parseDelimited(contents);
      if (table.length < 2) { setError('Need a header row plus at least one data row.'); setParsed(null); return; }
      const p = normaliseLeadRecords(table);
      if (Object.keys(p.mapped).length === 0) {
        setError('None of the column headers matched a known field. Rename them to match our export, or use common names like Company, Job Title, Email.');
        setParsed(null); return;
      }
      if (p.records.length === 0) {
        setError('Headers were recognised but no row had a company, job title or contact.');
        setParsed(null); return;
      }
      setParsed(p);
    } catch (e: any) {
      setError(e?.message ?? 'Could not read that file');
      setParsed(null);
    }
  };

  const onFile = (f: File | undefined) => {
    if (!f) return reset();
    if (f.size > MAX_FILE_BYTES) {
      setError(`File is ${(f.size / 1048576).toFixed(1)} MB. Split it into smaller files (max ${MAX_FILE_BYTES / 1048576} MB).`);
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => setError('Could not read the file');
    reader.onload = () => analyse(f.name, String(reader.result ?? ''));
    reader.readAsText(f);
  };

  const dryRun = useMutation(
    () => leadsApi.importCsv({ csv: text, dry_run: true }),
    { onSuccess: (r) => setPlan(r), onError: (e: any) => setError(readableError(e)) },
  );

  const commit = useMutation(
    () => leadsApi.importCsv({ csv: text }),
    { onSuccess: (r) => { onDone(r); reset(); onClose(); }, onError: (e: any) => setError(readableError(e)) },
  );

  const mappedEntries = parsed ? Object.entries(parsed.mapped) : [];
  const sample = parsed?.records.slice(0, 5) ?? [];
  const sampleFields = useMemo(
    () => ['company_name', 'job_title', 'hr_name', 'hr_email', 'location', 'salary_range'].filter((f) => mappedEntries.some(([k]) => k === f)),
    [mappedEntries],
  );

  return (
    <Modal
      open={open}
      onClose={() => { if (!commit.isLoading) { reset(); onClose(); } }}
      title="Import leads from CSV"
      description="Drop a CSV or TSV from another agency or your own sheet. Columns are matched by name and duplicates are merged automatically — nothing is imported twice."
      size="lg"
      footer={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {parsed ? `${parsed.records.length} usable rows · ${mappedEntries.length} columns matched${parsed.unmapped.length ? ` · ${parsed.unmapped.length} ignored` : ''}` : 'No file loaded'}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => { reset(); onClose(); }} disabled={commit.isLoading}>Close</Button>
            <Button variant="outline" onClick={() => dryRun.mutate()} disabled={!text || dryRun.isLoading}>
              {dryRun.isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
              {dryRun.isLoading ? 'Checking…' : 'Check for duplicates'}
            </Button>
            <Button onClick={() => commit.mutate()} disabled={!parsed || commit.isLoading}>
              {commit.isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              {commit.isLoading ? 'Importing…' : `Import ${parsed?.records.length ?? 0} leads`}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        <label
          className="flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-input bg-muted/30 px-4 py-6 text-center transition-colors hover:border-primary hover:bg-primary-soft/40"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); onFile(e.dataTransfer.files?.[0]); }}
        >
          <input
            ref={fileRef} type="file" accept=".csv,.tsv,.txt,text/csv" className="sr-only"
            aria-label="Choose CSV file" onChange={(e) => onFile(e.target.files?.[0] ?? undefined)}
          />
          <FileSpreadsheet className="h-6 w-6 text-muted-foreground" />
          <span className="text-sm font-medium">{fileName || 'Choose a .csv / .tsv file or drag it here'}</span>
          <span className="text-xs text-muted-foreground">Excel: save as CSV UTF-8 first. Exported HireGen files import straight back.</span>
        </label>

        {error && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>{error}</span>
          </div>
        )}

        {plan && (
          <div className="rounded-md border border-border bg-muted/30 p-3 text-sm">
            <p className="mb-2 font-medium">Dry run — nothing was written</p>
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
              <Stat label="New leads" value={plan.created} tone="ok" />
              <Stat label="Merged into existing" value={plan.merged} tone="warn" />
              <Stat label="Near-duplicates flagged" value={plan.merged_fuzzy} tone="warn" />
              <Stat label="Skipped" value={plan.skipped} tone={plan.skipped ? 'bad' : 'muted'} />
            </div>
          </div>
        )}

        {parsed && (
          <>
            <div>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Detected columns</p>
              <div className="flex flex-wrap gap-1.5">
                {mappedEntries.map(([field, header]) => (
                  <Badge key={field} variant="secondary" className="font-normal">{header} → {field.replace(/_/g, ' ')}</Badge>
                ))}
                {parsed.unmapped.map((h) => (
                  <Badge key={h} variant="outline" className="font-normal text-muted-foreground line-through">{h}</Badge>
                ))}
              </div>
            </div>

            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-left text-xs">
                <thead className="bg-muted/50">
                  <tr>{sampleFields.map((f) => <th key={f} className="whitespace-nowrap px-2.5 py-1.5 font-medium">{f.replace(/_/g, ' ')}</th>)}</tr>
                </thead>
                <tbody>
                  {sample.map((r, i) => (
                    <tr key={i} className="border-t border-border">
                      {sampleFields.map((f) => (
                        <td key={f} className="max-w-[220px] truncate px-2.5 py-1.5" title={r[f]}>{r[f] || '—'}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {parsed.records.length > sample.length && (
                <p className="px-2.5 py-1.5 text-[11px] text-muted-foreground">+ {parsed.records.length - sample.length} more rows</p>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: 'ok' | 'warn' | 'bad' | 'muted' }) {
  const cls = { ok: 'text-success', warn: 'text-warning', bad: 'text-destructive', muted: 'text-muted-foreground' }[tone];
  return <span><b className={cls}>{value}</b> <span className="text-muted-foreground">{label}</span></span>;
}

/** Axios errors carry either { error } or Fastify's validation issues array. */
export function readableError(e: any): string {
  const data = e?.response?.data;
  if (typeof data === 'string') return data.slice(0, 300);
  if (data?.error) return String(data.error).slice(0, 300);
  if (Array.isArray(data?.details) && data.details[0]?.message) return data.details[0].message;
  return e?.message || 'Import failed';
}
