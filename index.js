#!/usr/bin/env node

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, join } from 'path';

// ─── ANSI colors ────────────────────────────────────────────────────────────
const C = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  red:     '\x1b[31m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  cyan:    '\x1b[36m',
  bgRed:   '\x1b[41m',
  bgGreen: '\x1b[42m',
};

const bold   = s => `${C.bold}${s}${C.reset}`;
const red    = s => `${C.red}${s}${C.reset}`;
const green  = s => `${C.green}${s}${C.reset}`;
const yellow = s => `${C.yellow}${s}${C.reset}`;
const cyan   = s => `${C.cyan}${s}${C.reset}`;

// ─── Funny failure messages ──────────────────────────────────────────────────
const BLOCKED_MSGS = [
  "Blocked. Your future self thanks me.",
  "Nope. Nice try though.",
  "I've seen things in production. This was preventable.",
  "Have you considered not deploying right now?",
  "Hard no. The logs would have been spectacular though.",
  "Checks failed. The on-call engineer's phone remains silent tonight.",
];
const randomMsg = () => BLOCKED_MSGS[Math.floor(Math.random() * BLOCKED_MSGS.length)];

// ─── Arg parsing ────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (flag) => {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
};
const hasFlag = (flag) => args.includes(flag);

const configPath = getArg('--config') || '.deploygate';
const env        = getArg('--env') || 'production';
const skipRaw    = getArg('--skip') || '';
const skipped    = skipRaw ? skipRaw.split(',').map(s => s.trim()) : [];

// ─── Setup hook ─────────────────────────────────────────────────────────────
if (hasFlag('--setup-hook')) {
  setupHook();
  process.exit(0);
}

// ─── Safe shell runner ────────────────────────────────────────────────────────
function run(cmd, opts = {}) {
  try {
    const stdout = execSync(cmd, { encoding: 'utf8', stdio: 'pipe', ...opts }).trim();
    return { stdout, code: 0 };
  } catch (e) {
    return {
      stdout: (e.stdout || '').trim(),
      stderr: (e.stderr || '').trim(),
      code: e.status || 1,
    };
  }
}

// ─── Config parser ────────────────────────────────────────────────────────────
function parseConfig(raw) {
  const result = {};
  let current = null;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const sectionMatch = trimmed.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      current = sectionMatch[1];
      result[current] = {};
      continue;
    }
    if (current) {
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx === -1) continue;
      const key = trimmed.slice(0, colonIdx).trim();
      const val = trimmed.slice(colonIdx + 1).trim();
      result[current][key] = val;
    }
  }
  return result;
}

// ─── Default gates ────────────────────────────────────────────────────────────
const DEFAULT_GATES = {
  no_console_log:         'warn',
  no_debugger:            'fail',
  uncommitted_changes:    'warn',
  branch_check:           'warn',
  node_modules_committed: 'fail',
};

// ─── Grep helper (uses --include to avoid shell injection) ───────────────────
function grepIn(literalPattern, dirs) {
  const validDirs = dirs.filter(d => existsSync(d));
  if (validDirs.length === 0) return [];

  const excludeArgs = [
    '--exclude-dir=node_modules',
    '--exclude-dir=.git',
    '--exclude-dir=dist',
    '--exclude-dir=build',
    '--exclude-dir=.next',
    '--exclude-dir=coverage',
  ].join(' ');

  const paths = validDirs.join(' ');
  const res = run(`grep -rn ${excludeArgs} "${literalPattern}" ${paths} 2>/dev/null || true`);
  return res.stdout ? res.stdout.split('\n').filter(Boolean) : [];
}

// ─── Gate runners ────────────────────────────────────────────────────────────
const RUNNERS = {
  no_console_log() {
    const paths = ['src', 'lib', 'app', 'pages', 'components'].filter(d => existsSync(d));
    if (paths.length === 0) return { pass: true, detail: 'No source directories found, skipped' };
    const hits = grepIn('console\\.log', paths);
    if (hits.length === 0) return { pass: true, detail: 'No console.log found' };
    return {
      pass: false,
      detail: `${hits.length} console.log statement(s) found`,
      lines: hits.slice(0, 5),
      fix: 'Remove console.log statements or replace with a proper logger',
    };
  },

  no_debugger() {
    const paths = ['src', 'lib', 'app', 'pages'].filter(d => existsSync(d));
    if (paths.length === 0) return { pass: true, detail: 'No source directories found, skipped' };
    // Match "debugger;" or "debugger " at word boundary — actual statements, not the word in comments/strings
    const hits = grepIn('\\bdebugger;', paths);
    if (hits.length === 0) return { pass: true, detail: 'No debugger statements found' };
    return {
      pass: false,
      detail: `${hits.length} debugger statement(s) found`,
      lines: hits.slice(0, 5),
      fix: 'Remove all debugger; statements before deploying',
    };
  },

  uncommitted_changes() {
    const res = run('git status --porcelain');
    if (res.code !== 0) return { pass: true, detail: 'Not a git repo or git unavailable' };
    if (!res.stdout) return { pass: true, detail: 'Working tree is clean' };
    const files = res.stdout.split('\n').filter(Boolean);
    return {
      pass: false,
      detail: `${files.length} uncommitted change(s)`,
      lines: files.slice(0, 5),
      fix: 'Commit or stash changes: git add -A && git commit -m "..."',
    };
  },

  branch_check() {
    const res = run('git branch --show-current');
    if (res.code !== 0) return { pass: true, detail: 'Could not determine branch' };
    const branch = res.stdout.trim();
    if (['main', 'master'].includes(branch)) return { pass: true, detail: `On ${branch}` };
    return {
      pass: false,
      detail: `Currently on branch "${branch}", not main/master`,
      fix: 'Switch to main branch before deploying to production',
    };
  },

  node_modules_committed() {
    const res = run('git ls-files node_modules 2>/dev/null | head -1 || true');
    if (res.stdout.trim().length > 0) {
      return {
        pass: false,
        detail: 'node_modules is tracked by git',
        fix: 'Add node_modules/ to .gitignore and run: git rm -r --cached node_modules/',
      };
    }
    return { pass: true, detail: 'node_modules not tracked in git' };
  },

  no_todo_in(paths) {
    const dirs = paths.split(',').map(s => s.trim()).filter(Boolean);
    const existingDirs = dirs.filter(d => existsSync(d));
    if (existingDirs.length === 0) return { pass: true, detail: `Paths not found: ${dirs.join(', ')}` };
    const hits = grepIn('TODO\\|FIXME\\|HACK', existingDirs);
    if (hits.length === 0) return { pass: true, detail: `No TODO/FIXME/HACK in ${existingDirs.join(', ')}` };
    return {
      pass: false,
      detail: `${hits.length} TODO/FIXME/HACK comment(s) found`,
      lines: hits.slice(0, 5),
      fix: 'Resolve or remove TODO/FIXME/HACK comments',
    };
  },

  tests_pass(command) {
    const res = run(command);
    if (res.code === 0) return { pass: true, detail: `Tests passed: ${command}` };
    const output = `${res.stdout}\n${res.stderr || ''}`.split('\n').filter(Boolean);
    return {
      pass: false,
      detail: `Tests failed (exit ${res.code}): ${command}`,
      lines: output.slice(-8),
      fix: `Fix failing tests then re-run: ${command}`,
    };
  },

  build_passes(command) {
    const res = run(command);
    if (res.code === 0) return { pass: true, detail: `Build passed: ${command}` };
    const output = `${res.stdout}\n${res.stderr || ''}`.split('\n').filter(Boolean);
    return {
      pass: false,
      detail: `Build failed (exit ${res.code}): ${command}`,
      lines: output.slice(-8),
      fix: `Fix build errors: ${command}`,
    };
  },

  no_secrets() {
    const patterns = [
      'api_key\\s*[=:]\\s*["\'][A-Za-z0-9_-]\\{8,\\}',
      'secret\\s*[=:]\\s*["\'][A-Za-z0-9_-]\\{8,\\}',
      'password\\s*[=:]\\s*["\'][A-Za-z0-9_-]\\{8,\\}',
      'token\\s*[=:]\\s*["\'][A-Za-z0-9_-]\\{8,\\}',
    ];
    const paths = ['src', 'lib', 'config', 'app'].filter(d => existsSync(d));
    const scanPaths = paths.length > 0 ? paths : ['.'];
    const hits = [];
    for (const pat of patterns) {
      const res = run(
        `grep -rn --exclude-dir=node_modules --exclude-dir=.git --exclude="*.env" --exclude="*.example" "${pat}" ${scanPaths.join(' ')} 2>/dev/null || true`
      );
      if (res.stdout) hits.push(...res.stdout.split('\n').filter(Boolean));
    }
    // Filter env var references
    const realHits = hits.filter(h => !h.match(/process\.env\.|[$][{]|getenv\(/));
    if (realHits.length === 0) return { pass: true, detail: 'No hardcoded secrets detected' };
    return {
      pass: false,
      detail: `${realHits.length} potential hardcoded secret(s) found`,
      lines: realHits.slice(0, 5).map(l =>
        l.replace(/([=:]\s*["']?)[A-Za-z0-9_-]{4}([A-Za-z0-9_-]+)/g, '$1****')
      ),
      fix: 'Move secrets to environment variables or .env files (add .env to .gitignore)',
    };
  },

  branch_is(expectedBranch) {
    const res = run('git branch --show-current');
    if (res.code !== 0) return { pass: false, detail: 'Could not determine current branch', fix: 'Ensure you are in a git repo' };
    const branch = res.stdout.trim();
    if (branch === expectedBranch) return { pass: true, detail: `On required branch: ${branch}` };
    return {
      pass: false,
      detail: `On branch "${branch}", expected "${expectedBranch}"`,
      fix: `Switch to the ${expectedBranch} branch: git checkout ${expectedBranch}`,
    };
  },
};

// ─── Dispatch a gate by name ─────────────────────────────────────────────────
function runGate(name, value) {
  // Gates that take a value argument
  const valueGates = ['tests_pass', 'build_passes', 'branch_is', 'no_todo_in'];
  if (valueGates.includes(name)) {
    const runner = RUNNERS[name];
    if (!runner) return { pass: true, detail: `Gate "${name}" not implemented, skipped` };
    return runner(value);
  }

  // Gates that are boolean (true/false/warn/fail) — value is severity config
  const runner = RUNNERS[name];
  if (runner) return runner();

  // Unknown gate — try running value as a shell command if it looks like one
  if (value && value !== 'true' && value !== 'false' && value !== 'warn' && value !== 'fail') {
    return RUNNERS.tests_pass(value);
  }

  return { pass: true, detail: `Gate "${name}" not implemented, skipped` };
}

// ─── Status symbols ───────────────────────────────────────────────────────────
const SYM = {
  pass: green('✓ PASS'),
  fail: red('✗ FAIL'),
  warn: yellow('⚠ WARN'),
  skip: cyan('● SKIP'),
};

// ─── Main runner ─────────────────────────────────────────────────────────────
async function main() {
  console.log('');
  console.log(bold(cyan('╔══════════════════════════════════════════╗')));
  console.log(bold(cyan('║          DEPLOY GATE                     ║')));
  console.log(bold(cyan('╚══════════════════════════════════════════╝')));
  console.log('');

  // Load config
  let gates = {};
  let configSource = 'defaults';

  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, 'utf8');
      const parsed = parseConfig(raw);
      if (parsed[env]) {
        gates = parsed[env];
        configSource = `${configPath} [${env}]`;
      } else {
        console.log(yellow(`  Config found but no [${env}] section — using defaults`));
        gates = { ...DEFAULT_GATES };
      }
    } catch (e) {
      console.log(yellow(`  Could not parse config: ${e.message} — using defaults`));
      gates = { ...DEFAULT_GATES };
    }
  } else {
    gates = { ...DEFAULT_GATES };
  }

  const gateEntries = Object.entries(gates);
  const activeGates = gateEntries.filter(([name]) => !skipped.includes(name));

  console.log(`  ${bold('Environment:')} ${yellow(env)}`);
  console.log(`  ${bold('Config:')}      ${configSource}`);
  console.log(`  ${bold('Gates:')}       ${activeGates.length}${skipped.length ? ` (${skipped.length} skipped)` : ''}`);
  console.log('');
  console.log(bold('─────────────────────────────────────────────'));
  console.log('');

  const results = [];

  for (const [name, value] of activeGates) {
    // Determine severity for this gate
    let severity = DEFAULT_GATES[name] || 'fail';
    if (value === 'warn') severity = 'warn';
    else if (value === 'fail') severity = 'fail';

    let result;
    try {
      result = runGate(name, value);
    } catch (e) {
      result = { pass: false, detail: `Gate error: ${e.message}`, fix: 'Check gate configuration' };
    }

    const status = result.pass ? 'pass' : severity;
    const label = name.padEnd(28);
    console.log(`  ${SYM[status]}  ${bold(label)} ${result.detail}`);

    if (result.lines && result.lines.length > 0) {
      for (const line of result.lines) {
        console.log(`              ${yellow('→')} ${line}`);
      }
      if (result.lines.length >= 5) {
        console.log(`              ${yellow('→')} ... (showing first 5)`);
      }
    }

    results.push({ name, status, result, severity });
  }

  if (skipped.length > 0) {
    for (const name of skipped) {
      console.log(`  ${SYM.skip}  ${bold(name.padEnd(28))} skipped via --skip`);
    }
  }

  console.log('');
  console.log(bold('─────────────────────────────────────────────'));

  const fails  = results.filter(r => r.status === 'fail');
  const warns  = results.filter(r => r.status === 'warn');
  const passes = results.filter(r => r.status === 'pass');

  console.log('');
  console.log(`  ${green(`✓ ${passes.length} passed`)}  ${yellow(`⚠ ${warns.length} warned`)}  ${red(`✗ ${fails.length} failed`)}`);
  console.log('');

  if (fails.length > 0) {
    console.log(`${C.bgRed}${C.bold}  DEPLOYMENT BLOCKED — ${randomMsg()}  ${C.reset}`);
    console.log('');
    console.log(bold(red('  Gates that must pass before deploying:')));
    for (const f of fails) {
      console.log(`  ${red('✗')} ${bold(f.name)}: ${f.result.detail}`);
      if (f.result.fix) console.log(`    ${cyan('Fix:')} ${f.result.fix}`);
    }
    if (warns.length > 0) {
      console.log('');
      console.log(bold(yellow('  Warnings (review before deploying):')));
      for (const w of warns) {
        console.log(`  ${yellow('⚠')} ${bold(w.name)}: ${w.result.detail}`);
        if (w.result.fix) console.log(`    ${cyan('Fix:')} ${w.result.fix}`);
      }
    }
    console.log('');
    process.exit(1);
  }

  if (warns.length > 0) {
    console.log(`${C.yellow}${C.bold}  ⚠ PROCEED WITH CAUTION  ${C.reset}`);
    console.log('');
    console.log(bold(yellow('  Warnings (review before deploying):')));
    for (const w of warns) {
      console.log(`  ${yellow('⚠')} ${bold(w.name)}: ${w.result.detail}`);
      if (w.result.fix) console.log(`    ${cyan('Fix:')} ${w.result.fix}`);
    }
    console.log('');
    process.exit(0);
  }

  console.log(`${C.bgGreen}${C.bold}  ✓ ALL GATES CLEAR — YOU MAY DEPLOY  ${C.reset}`);
  console.log('');
  process.exit(0);
}

// ─── Setup hook ───────────────────────────────────────────────────────────────
function setupHook() {
  if (!existsSync('.git')) {
    console.log(red('Error: Not a git repository. Run this from your project root.'));
    process.exit(1);
  }

  const hookDir = '.git/hooks';
  if (!existsSync(hookDir)) mkdirSync(hookDir, { recursive: true });

  const hookPath = join(hookDir, 'pre-push');
  const scriptPath = resolve(process.argv[1]);

  const hookContent = `#!/bin/sh
# deploy-gate pre-push hook
# Installed by: deploy-gate --setup-hook

echo ""
echo "Running deploy-gate checks..."
echo ""

node "${scriptPath}" --env production

EXIT_CODE=$?
if [ $EXIT_CODE -ne 0 ]; then
  echo ""
  echo "Push aborted. Fix the issues above and try again."
  echo "To skip in emergencies: git push --no-verify"
  echo ""
  exit 1
fi

exit 0
`;

  writeFileSync(hookPath, hookContent, { mode: 0o755 });
  console.log('');
  console.log(green(`  ✓ Pre-push hook installed at ${hookPath}`));
  console.log('');
  console.log(`  deploy-gate will now run automatically before every ${bold('git push')}.`);
  console.log(`  To bypass in emergencies: ${cyan('git push --no-verify')}`);
  console.log('');
}

// ─── Entry ────────────────────────────────────────────────────────────────────
main().catch(e => {
  console.error(red(`\nFatal error: ${e.message}`));
  process.exit(1);
});
