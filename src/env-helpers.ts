import { z } from 'zod';

/** Blank or whitespace-only env values mean "unset" (a template line like `KG_X=`). */
export function blankToUndefined(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  return t === '' ? undefined : t;
}

/** Same, and case-insensitive: for switches where `TRUE` and `Yes` should work. */
export function lowerOrUndefined(v: unknown): unknown {
  const t = blankToUndefined(v);
  return typeof t === 'string' ? t.toLowerCase() : t;
}

/**
 * On/off switch parsed explicitly. z.coerce.boolean() would read the string
 * 'false' as true; this accepts true/false, 1/0, yes/no, on/off (any case),
 * treats blank as unset, and rejects anything else.
 */
export function envFlag(defaultValue: boolean) {
  return z.preprocess(
    lowerOrUndefined,
    z.enum(['true', 'false', '1', '0', 'yes', 'no', 'on', 'off']).default(defaultValue ? 'true' : 'false')
  ).transform((v) => v === 'true' || v === '1' || v === 'yes' || v === 'on');
}

/** Format a failed parse as `  VAR: message` lines. */
export function formatEnvIssues(error: z.ZodError): string {
  return error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
}
