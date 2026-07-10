# Errors

## [ERR-20260710-001] opentui-controlled-input-picker-clear

**Logged**: 2026-07-10T16:30:00+08:00
**Priority**: high
**Status**: resolved
**Area**: frontend

### Summary
Opening a picker in the same submit update did not clear OpenTUI InputRenderable's internal text.

### Error
```text
After submitting /provider and selecting claude, typing /model produced /provider/model.
```

### Context
- TUI smoke test with `bun src/tui/main.tsx --root /tmp/baton-provider-smoke`
- React state set `draft` to an empty string while moving focus from input to select.
- The controlled input retained its internal value across the focus change.

### Suggested Fix
Remount the input after command submission so OpenTUI cannot retain stale internal text; keep a TTY regression smoke check for picker commands.

### Metadata
- Reproducible: yes
- Related Files: src/tui/main.tsx

### Resolution
- **Resolved**: 2026-07-10T16:40:00+08:00
- **Notes**: The composer input now remounts after submission; provider and model picker TTY smoke tests passed with a cleared input buffer.

---
