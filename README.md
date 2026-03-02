# deploy-gate

The deployment that would have broken production.
The one you forgot to test.
This catches it.

---

## Install

```bash
npm install -g deploy-gate
```

Or use directly without installing:

```bash
npx deploy-gate
```

## Zero-config usage

Run from any project root. deploy-gate detects your environment and runs sensible defaults:

```bash
node index.js
```

Default gates (no config needed):
- `no_console_log` — warns if console.log found in src/, lib/, etc.
- `no_debugger` — blocks if `debugger;` found in source
- `uncommitted_changes` — warns if working tree is dirty
- `branch_check` — warns if you're not on main/master
- `node_modules_committed` — blocks if node_modules tracked in git

## Config file

Create a `.deploygate` file in your project root:

```ini
# .deploygate

[production]
no_console_log: true
no_debugger: true
no_todo_in: src/,lib/
no_secrets: true
tests_pass: npm test
build_passes: npm run build
uncommitted_changes: fail
branch_is: main

[staging]
uncommitted_changes: warn
no_debugger: true
tests_pass: npm test
```

## All gate types

| Gate | Value | What it checks |
|------|-------|----------------|
| `no_console_log` | `true` / `warn` | Finds console.log in src/, lib/ |
| `no_debugger` | `true` / `warn` | Finds debugger; statements |
| `no_todo_in` | `src/,lib/` | TODO/FIXME/HACK in those paths |
| `no_secrets` | `true` | Hardcoded api_key, password, token patterns |
| `tests_pass` | `npm test` | Runs command, fails if non-zero exit |
| `build_passes` | `npm run build` | Same as tests_pass |
| `uncommitted_changes` | `warn` / `fail` | git status --porcelain |
| `branch_is` | `main` | Enforces exact branch name |

Values:
- `true` / `fail` — gate failure blocks deployment (exit code 1)
- `warn` — gate failure shown but deployment allowed (exit code 0)

## CLI flags

```bash
# Specify environment (default: production)
node index.js --env staging

# Use a different config file
node index.js --config ./deploy-config

# Skip specific gates (comma-separated)
node index.js --skip no_console_log,branch_check

# Install git pre-push hook
node index.js --setup-hook
```

## Git hook integration

Install once per project:

```bash
node index.js --setup-hook
```

After that, every `git push` automatically runs deploy-gate. Block a push with failing gates. Bypass in true emergencies:

```bash
git push --no-verify
```

## CI integration

```yaml
# GitHub Actions
- name: Deploy gate
  run: node index.js --env production
```

```bash
# Any CI script
node index.js --env production || exit 1
```

Exit codes:
- `0` — all gates passed (warnings don't block)
- `1` — one or more gates failed

## Output example

```
╔══════════════════════════════════════════╗
║          DEPLOY GATE                     ║
╚══════════════════════════════════════════╝

  Environment: production
  Config:      .deploygate [production]
  Gates:       5

─────────────────────────────────────────────

  ✓ PASS  no_debugger              No debugger statements found
  ✓ PASS  tests_pass               Tests passed: npm test
  ✓ PASS  no_secrets               No hardcoded secrets detected
  ⚠ WARN  uncommitted_changes      3 uncommitted change(s)
  ✗ FAIL  branch_is                On branch "feature/new-thing", expected "main"

─────────────────────────────────────────────

  ✓ 3 passed  ⚠ 1 warned  ✗ 1 failed

  DEPLOYMENT BLOCKED — Blocked. Your future self thanks me.

  Gates that must pass before deploying:
  ✗ branch_is: On branch "feature/new-thing", expected "main"
    Fix: Switch to the main branch: git checkout main
```

## License

MIT
