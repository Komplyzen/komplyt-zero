/**
 * Text for a failed parameter validation, shared by the MCP HTTP route, the stdio server and the
 * REST routes. An unknown key (a misspelled parameter) names the key and lists the valid ones, so an
 * agent can correct itself; every other issue keeps the `path: message` form.
 */
import { ZodObject, type ZodError, type ZodType } from 'zod';

type Issue = ZodError['issues'][number];

function validKeys(schema: ZodType | undefined): string[] | undefined {
  return schema instanceof ZodObject ? Object.keys(schema.shape) : undefined;
}

function describeIssue(issue: Issue, schema: ZodType | undefined): string {
  const path = issue.path.map(String).join('.');
  if (issue.code === 'unrecognized_keys') {
    const names = issue.keys.map((k) => `"${k}"`).join(', ');
    const noun = `Unrecognized ${issue.keys.length === 1 ? 'key' : 'keys'} ${names}`;
    // The valid keys are those of the top-level schema: only right when the unknown key sits there.
    if (path) return `${path}: ${noun}`;
    const valid = validKeys(schema);
    return valid && valid.length > 0 ? `${noun}; valid keys: ${valid.join(', ')}` : noun;
  }
  return path ? `${path}: ${issue.message}` : issue.message;
}

/** Every issue, joined with "; ". */
export function describeIssues(error: ZodError, schema?: ZodType): string {
  return error.issues.map((issue) => describeIssue(issue, schema)).join('; ');
}

/** The first issue only (the REST routes keep their error message short). */
export function describeFirstIssue(error: ZodError, schema?: ZodType): string {
  const issue = error.issues[0];
  return issue ? describeIssue(issue, schema) : 'Invalid request';
}
