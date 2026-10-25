-- Child-safety evidence from other services (Whispers, the LLM relay, …):
-- one flag is one case, and related cases share a group_ref so a reviewer
-- sees them together. record_kind 'suppressed_burst' is a structured
-- counter a sending service files when one sender (one seat, or one IP)
-- went over its per-window case cap: count, first/last time and up to 200
-- SHA-256 hashes of the suppressed content, under that sender's own
-- identifiers (in the encrypted payload's extra.suppressedBurst).
ALTER TABLE child_safety.evidence_cases ADD COLUMN IF NOT EXISTS group_ref TEXT;
ALTER TABLE child_safety.evidence_cases ADD COLUMN IF NOT EXISTS record_kind TEXT
  CHECK (record_kind IS NULL OR record_kind IN ('flag', 'suppressed_burst'));
CREATE INDEX IF NOT EXISTS idx_cs_cases_group ON child_safety.evidence_cases (group_ref) WHERE group_ref IS NOT NULL;
