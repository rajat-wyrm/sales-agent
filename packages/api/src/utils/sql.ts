/**
 * Build a case-insensitive "contains" LIKE pattern from untrusted input.
 *
 * `%` and `_` are LIKE wildcards, so passing a user's filter straight into
 * `%${value}%` let a single `_` match any character and `%` match anything --
 * a search for "acme_" silently returned unrelated companies, and a lone `%`
 * turned into a full table scan. Backslash is escaped first so an input
 * containing `\%` cannot smuggle a wildcard past the escaping.
 *
 * Pair with `ESCAPE '\'` in the SQL for an unambiguous pattern.
 */
export function likeContains(value: string): string {
  return `%${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}