/** Research features are off unless explicitly enabled. */
export function isResearchEnabled(): boolean {
  return process.env.RI_RESEARCH_ENABLED === "true";
}
