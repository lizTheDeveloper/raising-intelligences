// Pragmatic email check for the optional follow-up contact. This is not an
// RFC 5322 parser: it accepts what real mailboxes look like and refuses what
// would be a typo, an injection attempt or garbage. The result is stored
// and later mailed to, so it must be a single plain address.

const MAX_LENGTH = 254;
const MAX_LOCAL = 64;
// RFC 5322 "atext" plus the dot; no quotes, commas, brackets or whitespace.
const LOCAL_RE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
// Dot-separated labels of letters/digits/hyphens (unicode letters allowed for
// internationalized domains); at least two labels; no label starts or ends
// with a hyphen.
const LABEL_RE = /^[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?$/u;

/**
 * Returns the address to store (trimmed, domain lowercased), or null when it is
 * not a plausible single email address. Never throws.
 */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_LENGTH) return null;
  // Any whitespace or control character anywhere (including inside) is refused.
  if (/[\s\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(trimmed)) return null;
  const parts = trimmed.split("@");
  if (parts.length !== 2) return null;
  const [local, domain] = parts;
  if (local.length === 0 || local.length > MAX_LOCAL || !LOCAL_RE.test(local)) return null;
  const labels = domain.split(".");
  if (labels.length < 2) return null;
  if (!labels.every((l) => LABEL_RE.test(l))) return null;
  return `${local}@${domain.toLowerCase()}`;
}
