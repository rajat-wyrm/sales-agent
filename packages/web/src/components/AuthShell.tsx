import React from 'react';
import { motion } from 'framer-motion';
import { Logo } from '@/components/Logo';
import { Sparkles, Zap, Globe2 } from 'lucide-react';

const FEATURES = [
  { icon: Globe2, title: 'Every India source', body: 'Naukri · Internshala · Apna · Cutshort · ATS boards + 30 more, run in parallel.' },
  { icon: Sparkles, title: 'HR contact enrichment', body: 'An autonomous fallback army finds the person behind every posting.' },
  { icon: Zap, title: 'Fully automatic', body: 'One click scrapes, enriches, verifies and drafts. You just review.' },
];

// Shared premium split-screen used by Login + Register.
export function AuthShell({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-screen overflow-hidden bg-background">
      <div className="relative hidden w-1/2 flex-col justify-between overflow-hidden border-r border-border bg-sage-soft/40 p-12 lg:flex">
        <div className="relative z-10"><Logo /></div>
        <div className="relative z-10 max-w-md">
          <p className="eyebrow mb-4">Autonomous lead intelligence</p>
          <h1 className="text-4xl font-bold leading-[1.1] tracking-tight">
            Find every fresher job in India and the HR behind it.
          </h1>
          <p className="mt-4 text-[15px] leading-relaxed text-muted-foreground">
            Scrape → enrich → verify → draft, on autopilot. Contact enrichment with an army of free + paid fallbacks, so a lead never comes back empty.
          </p>
          <div className="mt-8 space-y-4">
            {FEATURES.map((f, i) => (
              <motion.div key={f.title} initial={{ opacity: 0, x: -16 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.2 + i * 0.12 }} className="flex items-start gap-3">
                <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-border/60 bg-surface/50 text-primary backdrop-blur"><f.icon className="h-[18px] w-[18px]" /></div>
                <div><p className="text-sm font-semibold text-foreground">{f.title}</p><p className="text-[13px] text-muted-foreground">{f.body}</p></div>
              </motion.div>
            ))}
          </div>
        </div>
        <p className="relative z-10 text-xs text-muted-foreground/70">© {new Date().getFullYear()} HireGen · Lead Intelligence Engine</p>
      </div>

      <div className="flex w-full items-center justify-center px-6 py-12 lg:w-1/2">
        <motion.div initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }} className="w-full max-w-[380px]">
          <div className="mb-8 flex flex-col items-center gap-3 text-center lg:hidden"><Logo /></div>
          <div className="mb-8">
            <h2 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
          </div>
          <div className="card p-6 sm:p-7">{children}</div>
        </motion.div>
      </div>
    </div>
  );
}
