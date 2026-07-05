# Post-MVP Improvements

**Scope note:** this is a one-person service watching a handful of domains — one scheduler
run per day and a few WHOIS checks per week. Usage rounds to zero against any AWS pricing
tier, so free-tier limits are not a real constraint. Keep solutions correspondingly simple.
(The free-tier figures previously listed here were dated anyway — e.g. the old 62k/month
SES allowance no longer exists for newer accounts.)

## High Priority

### Dead Letter Queues (SQS)
**Status:** Pending
**Benefit:** All three async hops (EventBridge → Scheduler → Checker → Sender) are
fire-and-forget. A failed WHOIS lookup or SES send vanishes silently after Lambda's
built-in retries. A single shared SQS DLQ (`onFailure` destination on the Lambdas)
plus one alarm on its depth is enough at this scale.

## Nice to Have

### CloudWatch Alarms
**Status:** Pending
**Benefit:** Know when the daily run breaks instead of noticing weeks later. At this
scale one alarm on Lambda errors (all three functions) covers it; skip the
DynamoDB-throttling and SES-bounce alarms unless they actually occur.

### Systems Manager Parameter Store
**Status:** Pending
**Benefit:** Change notification/sender email without a redeploy. Low urgency for a
single user — a redeploy is cheap.
**Caveat:** the SES IAM policy scopes send permissions to identity ARNs derived from
`SENDER_EMAIL` at synth time. A runtime SSM lookup would break that scoping — resolve
the parameter at synth time (`valueFromLookup`) or keep the sender static and only
move the recipient.

## Done

- ~~CI workflow~~ — GitHub Actions runs typecheck, tests, and synth on push/PR (2026-07-06)
