# Domain Pollenator

A serverless microservice that monitors domain expiration dates and sends email notifications when domains actually expire. Built with AWS CDK and designed to stay within AWS free tier limits.

## Architecture

- **DynamoDB**: Stores domain information (name, expiration date, status)
- **Lambda Functions**: 
  - Scheduler: Runs daily to determine which domains need checking
  - Domain Checker: Queries RDAP API to get expiration dates
  - Notification Sender: Sends email alerts via SES
- **EventBridge**: Daily cron trigger (midnight UTC)
- **SES**: Email notifications

## Prerequisites

- Node.js 18+ and npm
- AWS CLI configured with appropriate credentials
- AWS CDK CLI: `npm install -g aws-cdk`
- SES email address verified in AWS Console

## Setup

1. Install dependencies:
```bash
npm install
```

2. Set your notification email (optional, defaults to `your-email@example.com`):
```bash
export NOTIFICATION_EMAIL=your-email@example.com
```

   Optionally set the sender email address (defaults to `noreply@domain-pollenator.com`):
```bash
export SENDER_EMAIL=noreply@yourdomain.com
```

3. Bootstrap CDK (first time only):
```bash
cdk bootstrap
```

4. Deploy the stack:
```bash
npm run deploy
```

## Adding Domains

After deployment, add domains to the DynamoDB table. You can use the AWS Console or CLI:

```bash
aws dynamodb put-item \
  --table-name <DomainsTableName> \
  --item '{"domainName": {"S": "example.com"}}'
```

The scheduler will automatically check domains right after their expiration date. Domains are scheduled to be checked 1 day after their expiration date to verify if they have actually expired.

## SES Configuration

Before the service can send emails, you must:

1. Verify your notification email address in SES Console (the recipient)
2. Verify your sender email address in SES Console (defaults to `noreply@domain-pollenator.com`, or set via `SENDER_EMAIL`)
3. If in SES Sandbox, verify both sender and recipient emails
4. Request production access if needed (for sending to unverified emails)

## Free Tier Considerations

This service is designed to stay within AWS free tier:
- DynamoDB: 25 GB storage, 25 read/write units (sufficient for <50 domains)
- Lambda: 1M requests/month, 400K GB-seconds
- EventBridge: 1M custom events/month
- SES: 62,000 emails/month
- CloudWatch Logs: 5 GB ingestion, 5 GB storage

## Useful Commands

- `npm run build` - Compile TypeScript
- `npm run watch` - Watch for changes and compile
- `npm run cdk synth` - Synthesize CloudFormation template
- `npm run cdk deploy` - Deploy stack to AWS
- `npm run cdk diff` - Compare deployed stack with current state
- `cdk destroy` - Destroy the stack

## Troubleshooting

- Check CloudWatch Logs for Lambda execution logs
- Verify SES email is verified in AWS Console
- Ensure DynamoDB table exists and has correct permissions
- Check EventBridge rule is enabled and scheduled correctly

