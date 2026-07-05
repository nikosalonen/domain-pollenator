# Domain Pollenator

A serverless microservice that monitors domain expiration dates and sends email reminders before — and an alert after — domains expire. Built with AWS CDK for a single user watching a handful of domains, so everything is deliberately simple and effectively free to run.

## Architecture

- **DynamoDB**: Stores domain records (name, expiration date, status, notification flags)
- **Lambda Functions**:
  - Scheduler: Runs daily and picks the domains due for a check
  - Domain Checker: Queries WHOIS (starting at `whois.iana.org`, following registry referrals) to get expiration dates
  - Notification Sender: Sends email reminders/alerts via SES
- **EventBridge**: Daily cron trigger (midnight UTC)
- **SES**: Email notifications (3-day reminder, 1-day reminder, expired alert)
- **SQS + CloudWatch + SNS**: Failed async invocations land in a shared dead-letter queue; an alarm on queue depth emails the owner

## Prerequisites

- Node.js 24 (see `.nvmrc`)
- AWS CLI configured with appropriate credentials
- SES sender and recipient addresses verified in the AWS Console

## Setup

1. Install dependencies:
```bash
npm install
```

2. Create a `.env` file with your addresses (baked in at synth time — a deploy without them falls back to example defaults):
```bash
NOTIFICATION_EMAIL=you@example.com
SENDER_EMAIL=noreply@yourdomain.com
```

3. Bootstrap CDK (first time only, and again whenever the stack starts using a new AWS service — the script pins the CloudFormation execution role to an explicit policy list):
```bash
npm run bootstrap
```

4. Deploy the stack:
```bash
npm run deploy
```

5. Confirm the SNS subscription for failure alerts. If your mail client auto-follows unsubscribe links (symptom: an "unsubscribe confirmation" arrives right after you confirm), don't click the confirmation link — copy the `Token` from its URL and confirm via CLI so unsubscribing requires AWS credentials:
```bash
aws sns confirm-subscription --topic-arn <AlertTopic-arn> --token <token> --authenticate-on-unsubscribe true
```

## Adding Domains

Add domains to the DynamoDB table with just their name; the checker fills in the rest on its next run:

```bash
aws dynamodb put-item \
  --table-name <DomainsTableName> \
  --item '{"domainName": {"S": "example.com"}}'
```

Checks are scheduled around the expiration milestones: 3 days before (reminder), 1 day before (reminder), 1 day after (expired alert), then every 30 days while expired.

## Development

```bash
npm test           # vitest: CDK assertion tests + unit tests for the WHOIS date logic
npm run build      # TypeScript typecheck (noEmit)
npm run synth      # synthesize the CloudFormation template
npm run diff       # compare against the deployed stack
npm run deploy     # deploy
npm run destroy    # tear down (the domains table is retained)
```

CI (GitHub Actions) runs typecheck, tests, and synth on every push and pull request. Dependabot keeps npm dependencies and workflow actions updated weekly.

## Troubleshooting

- **Failure alerts**: anything that fails after Lambda's built-in retries lands in the `FailedInvocationsQueue` DLQ and triggers an email — inspect the queue messages for the original event payload
- Check CloudWatch Logs for per-Lambda execution logs (one week retention)
- Verify both SES addresses are verified in the AWS Console (both sender and recipient, if the account is in the SES sandbox)
- "not authorized to perform &lt;service&gt;:&lt;action&gt;" from `cdk-*-cfn-exec-role` during deploy means the bootstrap policy list needs that service added — update the `bootstrap` script and re-run it
