const MAX_USER_ID_LENGTH = 300;
const MATRIX_ID_RE = /^@[^:]{1,200}:[a-zA-Z0-9.\-]{1,200}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Accepts Matrix IDs (@user:server) or UUIDs — both are the formats the client sends.
export function isValidUserId(id: string): boolean {
  if (!id || id.length > MAX_USER_ID_LENGTH) return false;
  return MATRIX_ID_RE.test(id) || UUID_RE.test(id);
}
