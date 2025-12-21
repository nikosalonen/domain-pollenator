# Post-MVP Improvements

## High Priority

### Dead Letter Queues (SQS)
**Status:** Pending  
**Benefit:** Captures failed async Lambda invocations (RDAP API failures, SES send failures) that would otherwise be lost. Enables retry logic and failure investigation.  
**Free Tier:** 1M requests/month

### CloudWatch Alarms
**Status:** Pending  
**Benefit:** Monitor Lambda errors, DynamoDB throttling, and SES bounces. Get notified when things break instead of discovering issues later.  
**Free Tier:** 10 alarms

### Systems Manager Parameter Store
**Status:** Pending  
**Benefit:** Replace hardcoded/env var email with centralized, encrypted config. Easier to update without redeployment.  
**Free Tier:** 10,000 parameters

