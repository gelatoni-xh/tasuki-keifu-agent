import type { Metrics } from './contracts.js';

type Diagnostic = NonNullable<NonNullable<Metrics['researchCalls']>[number]['diagnostic']>;
const ERROR_BODY_LIMIT = 32 * 1024;
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

// Keep only diagnostic fields, never full bodies, prompts, outputs, cookies or auth headers.
export function diagnosticText(value: unknown, secrets: string[] = [], limit = 1500): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  let text = String(value);
  for (const secret of secrets.filter(Boolean)) text = text.split(secret).join('[REDACTED]');
  text = text.replace(/\bBearer\s+[^\s"'<>;,]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk-|sess-)[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/(["']?(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|cookie)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;<>]+)/gi, '$1[REDACTED]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, url => {
      try { const parsed = new URL(url); return parsed.origin + parsed.pathname; } catch { return '[URL]'; }
    })
    .replace(/[\u0000-\u001f\u007f]/g, ' ');
  return text.trim().slice(0, limit) || undefined;
}

export function upstreamDiagnostic(value: unknown, secrets: string[]): Diagnostic['upstream'] {
  const root = record(value), response = record(root.response);
  const error = record(root.error ?? response.error);
  const field = (v: unknown, limit = 200) => diagnosticText(v, secrets, limit);
  const upstream = {
    code: field(error.code ?? root.code), type: field(error.type), param: field(error.param ?? root.param),
    message: [error.message, typeof root.error === 'string' ? root.error : undefined, root.message, root.msg, root.err, root.error_msg, record(root.header).message]
      .map(value => field(value, 1500)).find(value => value !== undefined),
    incompleteReason: field(record(root.incomplete_details ?? response.incomplete_details).reason),
    requestId: field(root.request_id ?? root.requestId ?? error.request_id ?? response.request_id),
  };
  return Object.values(upstream).some(v => v !== undefined) ? upstream : undefined;
}

export function diagnosticHeaders(headers: Headers, secrets: string[]) {
  const result: Record<string, string> = {};
  for (const key of ['x-request-id', 'openai-request-id', 'request-id', 'x-oneapi-request-id', 'x-one-api-request-id', 'x-new-api-request-id', 'x-client-request-id', 'cf-ray', 'x-amzn-trace-id', 'retry-after', 'content-type', 'server', 'x-ratelimit-limit-requests', 'x-ratelimit-remaining-requests', 'x-ratelimit-reset-requests', 'x-ratelimit-limit-tokens', 'x-ratelimit-remaining-tokens', 'x-ratelimit-reset-tokens']) {
    const value = diagnosticText(headers.get(key), secrets, 200);
    if (value) result[key] = value;
  }
  return result;
}

export async function httpErrorDiagnostic(response: Response, secrets: string[]): Promise<Diagnostic> {
  const diagnostic: Diagnostic = { phase: 'http', code: `http_${response.status}` };
  const reader = response.body?.getReader();
  if (!reader) return { ...diagnostic, bodyFormat: 'empty', bodyBytesRead: 0 };
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < ERROR_BODY_LIMIT) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value.subarray(0, ERROR_BODY_LIMIT - size);
      chunks.push(chunk); size += chunk.byteLength;
      if (size === ERROR_BODY_LIMIT) { diagnostic.bodyTruncated = true; break; }
    }
  } catch (error) {
    diagnostic.bodyReadError = error instanceof Error ? error.name.slice(0, 80) : 'UnknownError';
  } finally {
    // Do not let a broken upstream cancellation hide the original HTTP error.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  diagnostic.bodyBytesRead = size;
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const text = new TextDecoder().decode(bytes);
  if (!text.trim()) return { ...diagnostic, bodyFormat: 'empty' };
  try {
    diagnostic.upstream = upstreamDiagnostic(JSON.parse(text), secrets);
    diagnostic.bodyFormat = 'json';
  } catch {
    diagnostic.bodyFormat = /<\s*(?:!doctype|html|head|body)/i.test(text) ? 'html' : 'text';
    const title = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
    const excerpt = diagnostic.bodyFormat === 'html' ? title ?? text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<[^>]*>/g, ' ') : text;
    diagnostic.upstream = { message: diagnosticText(excerpt, secrets) };
  }
  return diagnostic;
}
