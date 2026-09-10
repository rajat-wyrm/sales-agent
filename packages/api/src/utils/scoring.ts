import type postgres from 'postgres';

interface LeadScoreInput {
  hr_name?: string | null;
  hr_personal_email?: string | null;
  hr_personal_mobile?: string | null;
  hr_linkedin_url?: string | null;
  company_default_email?: string | null;
  company_default_phone?: string | null;
  salary_range?: string | null;
  job_description?: string | null;
  job_url?: string | null;
  email_status?: string | null;
  whatsapp_status?: string | null;
}

interface ScoreResult {
  score: number;
  breakdown: Record<string, { points: number; reason: string }>;
  band: 'hot' | 'warm' | 'cold';
}

export function calculateLeadScore(input: LeadScoreInput): ScoreResult {
  const breakdown: Record<string, { points: number; reason: string }> = {};
  let score = 0;

  if (input.hr_name) {
    score += 20;
    breakdown.hr_name = { points: 20, reason: 'HR name found' };
  }

  if (input.hr_personal_email || input.hr_personal_mobile) {
    score += 25;
    breakdown.hr_contact = {
      points: 25,
      reason: input.hr_personal_email
        ? 'HR personal email found'
        : 'HR personal mobile found',
    };
  }

  if (input.hr_linkedin_url) {
    score += 15;
    breakdown.hr_linkedin = { points: 15, reason: 'HR LinkedIn URL found' };
  }

  if (input.company_default_email || input.company_default_phone) {
    score += 10;
    breakdown.company_contact = {
      points: 10,
      reason: input.company_default_email
        ? 'Company official email found'
        : 'Company official mobile found',
    };
  }

  const qualityScore = Math.min(
    10,
    (input.salary_range ? 3 : 0) +
      (input.job_description && input.job_description.length > 100 ? 4 : 0) +
      (input.job_url ? 3 : 0),
  );
  if (qualityScore > 0) {
    score += qualityScore;
    breakdown.job_quality = { points: qualityScore, reason: 'Job description quality indicators' };
  }

  if (input.email_status === 'valid') {
    score += 10;
    breakdown.email_verified = { points: 10, reason: 'Email verified deliverable' };
  }

  if (input.whatsapp_status === 'registered') {
    score += 10;
    breakdown.whatsapp_verified = { points: 10, reason: 'WhatsApp number verified active' };
  }

  const band: 'hot' | 'warm' | 'cold' = score >= 70 ? 'hot' : score >= 40 ? 'warm' : 'cold';

  return { score, breakdown, band };
}

export async function recomputeLeadScore(
  sql: postgres.Sql,
  leadId: string,
  options?: { pipelineStage?: string },
): Promise<number> {
  const rows = await sql.unsafe(
    `SELECT
       hc.full_name as hr_name,
       hc.personal_email as hr_personal_email,
       hc.personal_mobile as hr_personal_mobile,
       hc.linkedin_url as hr_linkedin_url,
       c.default_email as company_default_email,
       c.default_phone as company_default_phone,
       jp.salary_range, jp.description as job_description, jp.job_url,
       l.email_status, l.whatsapp_status
     FROM leads l
     JOIN companies c ON l.company_id = c.id
     LEFT JOIN hr_contacts hc ON l.hr_contact_id = hc.id
     JOIN job_postings jp ON l.job_posting_id = jp.id
     WHERE l.id = $1`,
    [leadId],
  );

  if (!rows || rows.length === 0) {
    return 0;
  }

  const row = rows[0]!;
  const result = calculateLeadScore({
    hr_name: row.hr_name as string | null | undefined,
    hr_personal_email: row.hr_personal_email as string | null | undefined,
    hr_personal_mobile: row.hr_personal_mobile as string | null | undefined,
    hr_linkedin_url: row.hr_linkedin_url as string | null | undefined,
    company_default_email: row.company_default_email as string | null | undefined,
    company_default_phone: row.company_default_phone as string | null | undefined,
    salary_range: row.salary_range as string | null | undefined,
    job_description: row.job_description as string | null | undefined,
    job_url: row.job_url as string | null | undefined,
    email_status: row.email_status as string | null | undefined,
    whatsapp_status: row.whatsapp_status as string | null | undefined,
  });

  const setClauses: string[] = ['lead_score = $1', 'updated_at = NOW()'];
  const values: any[] = [result.score];

  if (options?.pipelineStage) {
    values.push(options.pipelineStage);
    setClauses.push(`pipeline_stage = $${values.length}`);
  }

  await sql.unsafe(
    `UPDATE leads SET ${setClauses.join(', ')} WHERE id = $${values.length + 1}`,
    [...values, leadId] as any,
  );

  return result.score;
}
