---
name: marketing-qa
description: Marketing asset verification — Playwright screenshots at multiple viewports, copy checking, layout validation, and broken link detection.
user_invocable: true
---

# Marketing QA

Verify marketing assets using Playwright browser automation and screenshots.

## Viewports (always test all three)

| Device | Size |
|--------|------|
| Desktop | 1920x1080 |
| Tablet | 768x1024 |
| Mobile | 375x812 |

## Verification Checklist

- [ ] Text content matches expected copy
- [ ] No broken layouts or overflow at any viewport
- [ ] All images load (no broken image icons)
- [ ] No dead links (check href targets)
- [ ] Buttons and CTAs are visible and tappable on mobile
- [ ] Page loads without console errors

## Workflow

```typescript
const viewports = [
  { width: 1920, height: 1080, name: 'desktop' },
  { width: 768, height: 1024, name: 'tablet' },
  { width: 375, height: 812, name: 'mobile' },
];
for (const vp of viewports) {
  await page.setViewportSize({ width: vp.width, height: vp.height });
  await page.screenshot({ path: `qa-${vp.name}.png`, fullPage: true });
}
```

## Sites to Verify

| Site | Source |
|------|--------|
| multiversestudios.xyz | Company site (MVEE repo) |
| play.multiversestudios.xyz/precursors/ | Precursors game |
| play.multiversestudios.xyz/mvee/ | MVEE game |

## Report Format

```markdown
## QA Report: [Page Name]
**URL**: [url] | **Date**: [date]

### Desktop (1920x1080)
- Issues: [none / list]

### Tablet (768x1024)
- Issues: [none / list]

### Mobile (375x812)
- Issues: [none / list]
```
