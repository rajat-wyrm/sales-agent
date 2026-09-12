import type {
  DataQuality,
  EmailStatus,
  PipelineStage,
  ScoreBand,
  WhatsAppStatus,
} from '@/lib/types';

export function formatDate(value?: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function formatDateTime(value?: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function timeAgo(value?: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  const diff = Date.now() - d.getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return formatDate(value);
}

export function formatNumber(value?: number | null): string {
  if (value == null) return '—';
  return value.toLocaleString('en-US');
}

export function initials(name?: string | null): string {
  if (!name) return '?';
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
}

export function domainFromUrl(url?: string | null): string {
  if (!url) return '';
  try {
    return new URL(url.includes('://') ? url : `https://${url}`).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export const SCORE_BAND_META: Record<
  ScoreBand,
  { label: string; className: string; dot: string }
> = {
  hot: {
    label: 'Hot',
    className: 'bg-hot-soft text-hot border-hot/20',
    dot: 'bg-hot',
  },
  warm: {
    label: 'Warm',
    className: 'bg-warm-soft text-warm border-warm/20',
    dot: 'bg-warm',
  },
  cold: {
    label: 'Cold',
    className: 'bg-cold-soft text-cold border-cold/20',
    dot: 'bg-cold',
  },
};

export const STAGE_META: Record<PipelineStage, { label: string; className: string }> = {
  discovered: { label: 'Discovered', className: 'bg-muted text-muted-foreground border-border' },
  enriched: { label: 'Enriched', className: 'bg-info-soft text-info border-info/20' },
  verified: { label: 'Verified', className: 'bg-success-soft text-success border-success/20' },
  drafted: { label: 'Drafted', className: 'bg-primary-soft text-primary border-primary/20' },
  contacted: { label: 'Contacted', className: 'bg-primary-soft text-primary border-primary/20' },
  replied: { label: 'Replied', className: 'bg-success-soft text-success border-success/20' },
  bounced: { label: 'Bounced', className: 'bg-destructive-soft text-destructive border-destructive/20' },
};

export const EMAIL_STATUS_META: Record<Exclude<EmailStatus, null> | 'null', { label: string; className: string }> = {
  valid: { label: 'Email valid', className: 'bg-success-soft text-success border-success/20' },
  invalid: { label: 'Email invalid', className: 'bg-destructive-soft text-destructive border-destructive/20' },
  catch_all: { label: 'Catch-all', className: 'bg-warning-soft text-warning border-warning/20' },
  disposable: { label: 'Disposable', className: 'bg-warning-soft text-warning border-warning/20' },
  unknown: { label: 'Email unknown', className: 'bg-muted text-muted-foreground border-border' },
  null: { label: 'Not verified', className: 'bg-muted text-muted-foreground border-border' },
};

export const WHATSAPP_STATUS_META: Record<Exclude<WhatsAppStatus, null> | 'null', { label: string; className: string }> = {
  registered: { label: 'WhatsApp on', className: 'bg-success-soft text-success border-success/20' },
  not_registered: {
    label: 'No WhatsApp',
    className: 'bg-destructive-soft text-destructive border-destructive/20',
  },
  unknown: { label: 'WhatsApp unknown', className: 'bg-muted text-muted-foreground border-border' },
  null: { label: 'Not verified', className: 'bg-muted text-muted-foreground border-border' },
};

export const DATA_QUALITY_META: Record<DataQuality, { label: string; className: string }> = {
  complete: { label: 'Complete', className: 'bg-success-soft text-success border-success/20' },
  incomplete: { label: 'Incomplete', className: 'bg-warning-soft text-warning border-warning/20' },
};

export const PROVIDER_LABELS: Record<string, string> = {
  apollo: 'Apollo',
  hunter: 'Hunter',
  apollo_io: 'Apollo.io',
  'apollo.io': 'Apollo.io',
  hunter_io: 'Hunter.io',
  'hunter.io': 'Hunter.io',
  abstract: 'Abstract',
  abstractapi: 'Abstract',
  apollo_manual: 'Apollo (manual)',
};

export const PROVIDER_COLORS: Record<string, string> = {
  apollo: 'bg-info-soft text-info border-info/20',
  apollo_io: 'bg-info-soft text-info border-info/20',
  'apollo.io': 'bg-info-soft text-info border-info/20',
  hunter: 'bg-success-soft text-success border-success/20',
  hunter_io: 'bg-success-soft text-success border-success/20',
  'hunter.io': 'bg-success-soft text-success border-success/20',
  abstract: 'bg-primary-soft text-primary border-primary/20',
  abstractapi: 'bg-primary-soft text-primary border-primary/20',
};

export const SOURCE_ICON: Record<string, string> = {
  linkedin: 'in',
  indeed: 'in',
  naukri: 'n',
  glassdoor: 'gd',
};

export function scoreToColor(score: number): string {
  if (score >= 80) return 'bg-success';
  if (score >= 50) return 'bg-warning';
  return 'bg-destructive';
}

export function scoreTextColor(score: number): string {
  if (score >= 80) return 'text-success';
  if (score >= 50) return 'text-warning';
  return 'text-destructive';
}