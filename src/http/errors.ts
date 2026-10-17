export type ErrorCode =
  | 'auth'
  | 'forbidden'
  | 'not_found'
  | 'validation'
  | 'rate_limited'
  | 'timeout'
  | 'network'
  | 'server'
  | 'unknown'
  | 'unknown_outcome';

export class YouGileError extends Error {
  status: number | null;
  code: ErrorCode;
  retryable: boolean;

  constructor(message: string, code: ErrorCode, status: number | null = null, retryable = false) {
    super(message);
    this.name = 'YouGileError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

const hints: Partial<Record<ErrorCode, string>> = {
  auth: 'check YOUGILE_API_KEY',
  forbidden: 'key owner lacks permission',
  not_found: 'check the id; it may be deleted (try includeDeleted)',
  unknown_outcome: 'the write may have completed; re-read before retrying',
};

export function errorFromStatus(status: number, message: string, retryable = false): YouGileError {
  const code: ErrorCode =
    status === 400 || status === 422
      ? 'validation'
      : status === 401
        ? 'auth'
        : status === 403
          ? 'forbidden'
          : status === 404
            ? 'not_found'
            : status === 429
              ? 'rate_limited'
              : status >= 500
                ? 'server'
                : 'unknown';
  return new YouGileError(message, code, status, retryable);
}

export function toToolError(
  e: unknown,
  apiKey?: string,
): {
  isError: true;
  content: [{ type: 'text'; text: string }];
} {
  let code: ErrorCode = 'unknown';
  let status: number | null = null;
  let message = 'Unexpected error';
  if (e instanceof YouGileError) {
    code = e.code;
    status = e.status;
    message = e.message;
  }
  if (apiKey) message = message.split(apiKey).join('[redacted]');
  message = message
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[URL]')
    .replace(/<[^>]*>/g, '[HTML]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 300);
  const statusText = status === null ? '' : ` (HTTP ${status})`;
  const hint = hints[code] ? `; ${hints[code]}` : '';
  return {
    isError: true,
    content: [{ type: 'text', text: `YouGile ${code}${statusText}: ${message}${hint}` }],
  };
}
