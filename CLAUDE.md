# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Serverless AWS microservice (CDK + TypeScript) that monitors domain expiration dates via WHOIS and sends email reminders/alerts through SES. Designed to stay within AWS free tier. No linter is configured.

## Commands

```bash
npm test           # vitest — CDK assertion tests + unit tests for the domain-checker date logic (test/)
npx vitest run test/domain-checker.test.ts   # run a single test file
npm run build      # tsc typecheck only (noEmit — Lambdas are bundled by esbuild at synth)
npm run synth      # cdk synth — synthesize CloudFormation template (good smoke test)
npm run diff       # cdk diff against deployed stack
npm run deploy     # cdk deploy
npm run bootstrap  # cdk bootstrap with scoped execution policies (first time only)
```

Deployment config comes from a `.env` file (loaded via dotenv in `bin/domain-pollenator.ts`) or exported env vars: `NOTIFICATION_EMAIL`, `SENDER_EMAIL`. These are read at **synth time** and baked into Lambda environment variables — changing them requires a redeploy. Default region is `eu-west-1`.

The CDK bootstrap pins the CloudFormation execution role to an explicit managed-policy list (the `bootstrap` script). **When the stack starts using a new AWS service, add the matching policy to that list and re-run `npm run bootstrap`** — otherwise the deploy fails with `not authorized to perform <service>:<action>` from the `cdk-*-cfn-exec-role`. IAM caps the role at 10 managed policies.

## Architecture

CDK app: `bin/domain-pollenator.ts` → single stack `lib/domain-pollenator-stack.ts`. Each Lambda lives in `lambda/<name>/index.ts`, is bundled directly from TypeScript by `NodejsFunction`/esbuild, and has its own `package.json` for its AWS SDK dependencies (root `package.json` only holds CDK tooling).

Event flow (all Lambda-to-Lambda invocations are async, `InvocationType: 'Event'`):

1. **EventBridge** cron fires daily at midnight UTC → **Scheduler** (`lambda/scheduler/`)
2. **Scheduler** scans the DynamoDB `DomainsTable` (partition key `domainName`) and invokes **Domain Checker** for each domain whose `nextCheckDate` ≤ today (or that has never been checked)
3. **Domain Checker** (`lambda/domain-checker/`) queries WHOIS starting at `whois.iana.org` over raw TCP port 43, following `refer:` referrals to the authoritative registry. It parses the expiration date out of freeform WHOIS text (multiple field-name and date-format patterns), updates the domain record, and invokes **Notification Sender** when a notification is due
4. **Notification Sender** (`lambda/notification-sender/`) sends the SES email, then sets the corresponding dedup flag on the domain record

Failed async invocations of any of the three Lambdas land in a shared SQS DLQ (after Lambda's built-in retries); a CloudWatch alarm on queue depth notifies `NOTIFICATION_EMAIL` via SNS.

Note: despite "RDAP" appearing in the README and some descriptions, the checker actually uses classic WHOIS (port 43), not RDAP.

### Scheduling and notification logic (spread across the Lambdas)

- All dates are stored as `YYYY-MM-DD` strings and compared lexicographically.
- `calculateNextCheckDate` (domain-checker) sets the next check to hit the reminder milestones: 3 days before expiration → 1 day before → 1 day after expiration; already-expired domains re-check every 30 days; WHOIS parse failures get status `unknown` and retry in 7 days.
- Three notification types with matching dedup flags on the DynamoDB item: `reminder_3days`/`reminded3Days`, `reminder_1day`/`reminded1Day`, `expired`/`notified`. Domain Checker reads the flags to decide whether to notify; Notification Sender sets them after a successful send.
- When the WHOIS expiration date changes (domain renewed), Domain Checker resets all three flags so the next cycle re-notifies.
- The `DomainItem` interface is duplicated in each Lambda (they can drift — scheduler's copy lacks the notification flags). Keep them in sync when changing the record shape.
- The domain-checker's pure functions (`parseExpirationDate`, `calculateNextCheckDate`, `determineStatus`) are exported for unit testing; tests freeze time with fake timers and run under `TZ=UTC` (set in `vitest.config.ts`) because the date logic mixes UTC and local time.

Domain records are created externally (AWS CLI/Console `put-item` with just `domainName`); the checker fills in the rest on first run.

<!-- code-review-graph MCP tools -->
## MCP Tools: code-review-graph

**IMPORTANT: This project has a knowledge graph. ALWAYS use the
code-review-graph MCP tools BEFORE using Grep/Glob/Read to explore
the codebase.** The graph is faster, cheaper (fewer tokens), and gives
you structural context (callers, dependents, test coverage) that file
scanning cannot.

### When to use graph tools FIRST

- **Exploring code**: `semantic_search_nodes` or `query_graph` instead of Grep
- **Understanding impact**: `get_impact_radius` instead of manually tracing imports
- **Code review**: `detect_changes` + `get_review_context` instead of reading entire files
- **Finding relationships**: `query_graph` with callers_of/callees_of/imports_of/tests_for
- **Architecture questions**: `get_architecture_overview` + `list_communities`

Fall back to Grep/Glob/Read **only** when the graph doesn't cover what you need.

### Key Tools

| Tool | Use when |
| ------ | ---------- |
| `detect_changes` | Reviewing code changes — gives risk-scored analysis |
| `get_review_context` | Need source snippets for review — token-efficient |
| `get_impact_radius` | Understanding blast radius of a change |
| `get_affected_flows` | Finding which execution paths are impacted |
| `query_graph` | Tracing callers, callees, imports, tests, dependencies |
| `semantic_search_nodes` | Finding functions/classes by name or keyword |
| `get_architecture_overview` | Understanding high-level codebase structure |
| `refactor_tool` | Planning renames, finding dead code |

### Workflow

1. The graph auto-updates on file changes (via hooks).
2. Use `detect_changes` for code review.
3. Use `get_affected_flows` to understand impact.
4. Use `query_graph` pattern="tests_for" to check coverage.
