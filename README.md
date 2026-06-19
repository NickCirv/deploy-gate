<div align="center">

# deploy-gate

**Block bad deploys before they hit production — zero config, zero dependencies.**

[![License: MIT](https://img.shields.io/badge/license-MIT-green?labelColor=0B0A09)](LICENSE)
[![Zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen?labelColor=0B0A09)](package.json)
[![Node >=18](https://img.shields.io/badge/node-%3E%3D18-blue?labelColor=0B0A09)](package.json)

</div>

## Install

```bash
npx github:NickCirv/deploy-gate
```

## Usage

```bash
# Run default gates from your project root (no config needed)
npx github:NickCirv/deploy-gate

# Specify environment
npx github:NickCirv/deploy-gate --env staging

# Install as a git pre-push hook
npx github:NickCirv/deploy-gate --setup-hook
```

| Flag | Description |
|------|-------------|
| `--env <name>` | Load the `[name]` section from `.deploygate` (default: `production`) |
| `--config <path>` | Use a config file other than `.deploygate` |
| `--skip <gates>` | Comma-separated list of gates to skip |
| `--setup-hook` | Install a git pre-push hook that runs deploy-gate automatically |

## What it does

deploy-gate runs a set of named checks ("gates") against your project before you deploy. With no config file it runs five sensible defaults: no `debugger` statements, no committed `node_modules`, no `console.log` in source directories, clean working tree, and correct branch. Failed gates exit `1` and block the deploy; warnings exit `0` but are displayed.

Drop a `.deploygate` file in your project root to configure gates per environment — run tests, enforce a build step, scan for hardcoded secrets, or require a specific branch name. Any gate can be set to `warn` (allow deploy) or `fail` (block deploy).

```ini
[production]
no_debugger: true
no_secrets: true
tests_pass: npm test
branch_is: main
uncommitted_changes: fail

[staging]
uncommitted_changes: warn
no_debugger: true
```

---
<sub>Zero dependencies · Node >=18 · MIT · by <a href="https://github.com/NickCirv">NickCirv</a></sub>
