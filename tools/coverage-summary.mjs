#!/usr/bin/env node
// Renders a coverage-summary.json as a markdown table for $GITHUB_STEP_SUMMARY, so the numbers are on
// the run page instead of buried in a log fold. Thresholds live in the vitest configs and are enforced
// there -- this only reports, and never fails a build of its own accord.
//
//   node tools/coverage-summary.mjs coverage/coverage-summary.json "Engine" >> "$GITHUB_STEP_SUMMARY"
import { readFileSync } from 'node:fs';

const [file, label = 'Coverage'] = process.argv.slice(2);

let total;
try {
    total = JSON.parse(readFileSync(file, 'utf8')).total;
} catch {
    // A crashed run leaves no report. Say so rather than emitting an empty table.
    console.log(`### ${label} coverage\n\n_No coverage report was produced._`);
    process.exit(0);
}

const rows = ['statements', 'branches', 'functions', 'lines']
    .map((m) => `| ${m[0].toUpperCase()}${m.slice(1)} | ${total[m].covered} / ${total[m].total} | ${total[m].pct}% |`)
    .join('\n');

console.log(`### ${label} coverage

| Metric | Covered | % |
| --- | --- | --- |
${rows}`);
