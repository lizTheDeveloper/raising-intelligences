export type BirthYearResult =
  | { ok: true; birthYear: number; isAdult: boolean }
  | { ok: false; error: string };

/**
 * Validates a self-reported birth year (an integer year, not a string) and
 * classifies it. The 19-year calendar-year gap is deliberately conservative:
 * without a birthday, a gap of 19 guarantees the player has turned 18.
 */
export function classifyBirthYear(input: unknown, now: Date = new Date()): BirthYearResult {
  const thisYear = now.getFullYear();
  if (typeof input !== "number" || !Number.isInteger(input)) {
    return { ok: false, error: "birthYear must be an integer year" };
  }
  if (input < 1900 || input > thisYear) {
    return { ok: false, error: `birthYear must be between 1900 and ${thisYear}` };
  }
  return { ok: true, birthYear: input, isAdult: thisYear - input >= 19 };
}
