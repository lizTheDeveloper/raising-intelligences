// Reverse repeat-offender bans that the old grooming classifier applied to
// good-faith players. DRY-RUN by default: prints the IPs it would unban and the
// flag reasons that got them there, so a human can eyeball them before acting.
// Run for real with:  APPLY=1 node scripts/reverse-false-positive-bans.mjs
import pg from "pg";

const apply = process.env.APPLY === "1";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const bans = await pool.query(
  `SELECT ip_address, reason FROM banned_ips WHERE reason LIKE 'moderation_flag:%'`
);

for (const b of bans.rows) {
  const flags = await pool.query(
    `SELECT reason, created_at FROM moderation_flags WHERE ip_address = $1 ORDER BY created_at`,
    [b.ip_address]
  );
  console.log(`\n=== ${b.ip_address} (${flags.rows.length} flags) ===`);
  for (const f of flags.rows) console.log("  -", String(f.reason).replace(/\s+/g, " ").slice(0, 180));
  if (apply) {
    await pool.query(`DELETE FROM banned_ips WHERE ip_address = $1`, [b.ip_address]);
    console.log("  -> UNBANNED");
  }
}

console.log(apply ? "\nApplied." : "\nDry run. Re-run with APPLY=1 to unban. Review the reasons above first.");
await pool.end();
