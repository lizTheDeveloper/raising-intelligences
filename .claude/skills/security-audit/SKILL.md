---
name: security-audit
description: Audit Multiverse Games code and infrastructure for vulnerabilities — OWASP Top 10, secrets hygiene, dependency CVEs, prompt injection detection.
user_invocable: true
---

# Security Audit

Use this skill to review code, configs, and deployments for security vulnerabilities.

## Audit Checklist

### 1. Secrets Scan
```bash
grep -rn --include="*.ts" --include="*.js" --include="*.json" --include="*.env" \
  -E "(API_KEY|SECRET|password|token|sk_live|sk_test)" \
  games/
```
**Rule:** Keys and credentials must NEVER be in repos or client bundles. Use Vaultwarden or env vars only.

### 2. OWASP Top 10
Check game code and server logic for:
- **Injection** — User input in eval(), SQL, shell commands
- **XSS** — Unsanitized user content in DOM
- **Auth bypass** — Missing auth checks on protected endpoints
- **Insecure deserialization** — Untrusted data in deserializers
- **SSRF** — User-controlled URLs in server requests

### 3. Folkfork Pipeline (High Risk)
User-generated content pipeline. Check for:
- Code injection in submitted mods
- Malicious file uploads
- Sandbox escape vectors
- Prompt injection in user text (see `craft-verification` skill)

### 4. Dependency Audit
```bash
cd games/mvee && npm audit
cd games/precursors && npm audit
```

### 5. Infrastructure
- Hetzner: Exposed ports, missing TLS, default creds
- Matrix: Access controls, federation settings
- Agent configs: `dangerouslySkipPermissions` without justification

## Severity

| Level | Criteria | Example |
|-------|----------|---------|
| Critical | Actively exploitable | Exposed production API key |
| High | Moderate effort to exploit | XSS in player UI |
| Medium | Specific conditions needed | Missing rate limiting |
| Low | Theoretical / minimal impact | Verbose error messages |

## Report Format

```markdown
## Security Audit — [Scope] — [Date]

### Findings
1. **[SEVERITY] [Title]**
   - Location: `file:line`
   - Risk: What can be exploited
   - Fix: Recommended remediation

### Summary: Critical: X | High: X | Medium: X | Low: X
```

## Rules

- Never log secrets. Redact in reports.
- File issues with `[SECURITY]` prefix.
- When in doubt, flag it. False positives < breaches.
- Use OSS tools: `npm audit`, `pip-audit`, `trivy`, `semgrep`.

## Role context

From the security-engineer persona ("paranoid by design"): cypherpunk mindset — defense in depth, transparent auditable systems, distrust of security-through-obscurity; file issues, not blame. Scope spans all projects: Precursors, MVEE, Never Ever Land, Folkfork, the studios website, shared infra, and **agent configs** (flag `dangerouslySkipPermissions` without justification, leaked credentials in logs, unsafe adapter settings). Incident response: on a found vulnerability, file a `critical`/`high` MUL-#### ticket with `[SECURITY]` prefix, propose a fix, and escalate immediately. Communication style: lead with the risk, then evidence, then the fix — direct and factual, no sugarcoating, no panic.
