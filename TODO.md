# Post-MVP Improvements

**Scope note:** this is a one-person service watching a handful of domains — one scheduler
run per day and a few WHOIS checks per week. Usage rounds to zero against any AWS pricing
tier, so free-tier limits are not a real constraint. Keep solutions correspondingly simple.
(The free-tier figures previously listed here were dated anyway — e.g. the old 62k/month
SES allowance no longer exists for newer accounts.)

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

- ~~Dead Letter Queues (SQS)~~ — shared DLQ as `onFailure` destination on all three
  Lambdas, depth alarm notifies via SNS email (2026-07-06)
- ~~CI workflow~~ — GitHub Actions runs typecheck, tests, and synth on push/PR (2026-07-06)
