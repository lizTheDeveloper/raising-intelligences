/**
 * A 4-digit year from 1900 to the current year, or null. Client-side
 * convenience only; the server validates again and is authoritative.
 */
export function parseBirthYear(input: string, now: Date = new Date()): number | null {
  if (!/^\d{4}$/.test(input)) return null;
  const year = Number(input);
  return year >= 1900 && year <= now.getFullYear() ? year : null;
}
