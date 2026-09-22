import { ValidationError } from "./errors.js";

interface SecretPattern {
  name: string;
  regex: RegExp;
}

/**
 * Obvious credential shapes. This is a storage-hygiene filter, not a
 * security boundary: it must never be used to justify logging raw content.
 */
const SECRET_PATTERNS: SecretPattern[] = [
  { name: "anthropic_key", regex: /sk-ant-[A-Za-z0-9\-_]{16,}/g },
  { name: "openai_key", regex: /\bsk-[A-Za-z0-9_-]{12,}\b/g },
  { name: "aws_access_key_id", regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  {
    name: "github_token",
    regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{12,}\b/g,
  },
  { name: "github_pat", regex: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { name: "slack_token", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: "google_api_key", regex: /\bAIza[0-9A-Za-z\-_]{30,}\b/g },
  { name: "credential_url", regex: /https?:\/\/[^\s/@:]+:[^\s/@]+@/g },
  {
    name: "jwt",
    regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  { name: "bearer_header", regex: /\bBearer\s+[A-Za-z0-9\-._~+/]{20,}=*/gi },
  {
    name: "private_key_block",
    regex:
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    name: "credential_assignment",
    regex:
      /((?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|authorization|token|bearer)["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[^\s"',;}]+/gi,
  },
];

/** Names of the credential patterns that appear in `text`. */
export function findCredentials(text: string | null | undefined): string[] {
  if (!text) return [];
  const found = new Set<string>();
  for (const pattern of SECRET_PATTERNS) {
    pattern.regex.lastIndex = 0;
    if (pattern.regex.test(text)) found.add(pattern.name);
  }
  return [...found];
}

/** Replace credential-shaped substrings with an explicit marker. */
export function redactSecrets(text: string | null | undefined): string {
  if (!text) return "";
  let output = text;
  for (const pattern of SECRET_PATTERNS) {
    output =
      pattern.name === "credential_assignment"
        ? output.replace(pattern.regex, "$1[REDACTED]")
        : output.replace(pattern.regex, `[REDACTED:${pattern.name}]`);
  }
  return output;
}

/**
 * Reject content that obviously embeds credentials before it is accepted as
 * operator input (goal, constraints, instructions).
 */
export function assertNoCredentials(
  text: string | null | undefined,
  context: string,
): void {
  const found = findCredentials(text);
  if (found.length > 0) {
    throw new ValidationError(
      `${context} appears to embed credentials (${found.join(", ")}); supply secrets via the environment`,
      {
        context,
        patterns: found,
      },
    );
  }
}

/** Recursively sanitize structured evidence without corrupting its JSON syntax. */
export function redactValue<T>(value: T): T {
  const visit = (v: unknown, depth = 0): unknown => {
    if (typeof v === "string") return redactSecrets(v);
    if (v === null || typeof v !== "object") return v;
    if (depth > 30) return "[nested value omitted]";
    if (Array.isArray(v))
      return v.map((item, i) =>
        i > 0 &&
        typeof v[i - 1] === "string" &&
        /^--?(?:api[-_]?key|token|password|secret|authorization|bearer)$/i.test(
          v[i - 1],
        )
          ? "[REDACTED]"
          : visit(item, depth + 1),
      );
    return Object.fromEntries(
      Object.entries(v).map(([key, item]) => [
        key,
        /^(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|secret|authorization|token)$/i.test(
          key,
        ) && item != null
          ? "[REDACTED]"
          : visit(item, depth + 1),
      ]),
    );
  };
  return visit(value) as T;
}
