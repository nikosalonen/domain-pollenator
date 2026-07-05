import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { DomainPollenatorStack } from '../lib/domain-pollenator-stack';

let template: Template;

beforeAll(() => {
  process.env.NOTIFICATION_EMAIL = 'alerts@example.com';
  process.env.SENDER_EMAIL = 'noreply@example.com';
  const app = new cdk.App();
  const stack = new DomainPollenatorStack(app, 'TestStack');
  template = Template.fromStack(stack);
});

describe('DomainsTable', () => {
  it('is retained on stack deletion', () => {
    template.hasResource('AWS::DynamoDB::Table', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    });
  });

  it('uses on-demand billing with domainName as partition key', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [{ AttributeName: 'domainName', KeyType: 'HASH' }],
    });
  });
});

describe('Lambda functions', () => {
  it('creates exactly three functions on the Node.js 24 runtime', () => {
    const functions = template.findResources('AWS::Lambda::Function');
    expect(Object.keys(functions)).toHaveLength(3);
    for (const fn of Object.values(functions)) {
      expect(fn.Properties.Runtime).toBe('nodejs24.x');
    }
  });

  it('gives the domain checker enough timeout for a full WHOIS referral chain', () => {
    // Worst case: 5 referral hops x 10s socket timeout
    template.hasResourceProperties('AWS::Lambda::Function', {
      Timeout: 60,
      Environment: {
        Variables: Match.objectLike({
          NOTIFICATION_SENDER_FUNCTION_NAME: Match.anyValue(),
        }),
      },
    });
  });

  it('passes each function only the env vars it reads', () => {
    // Scheduler: table + checker function name, nothing else
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: {
          DOMAINS_TABLE_NAME: Match.anyValue(),
          DOMAIN_CHECKER_FUNCTION_NAME: Match.anyValue(),
        },
      },
    });
    // Domain checker: table + notification sender function name, no NOTIFICATION_EMAIL
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: {
          DOMAINS_TABLE_NAME: Match.anyValue(),
          NOTIFICATION_SENDER_FUNCTION_NAME: Match.anyValue(),
        },
      },
    });
    // Notification sender: table + both email addresses
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: {
          DOMAINS_TABLE_NAME: Match.anyValue(),
          NOTIFICATION_EMAIL: 'alerts@example.com',
          SENDER_EMAIL: 'noreply@example.com',
        },
      },
    });
  });
});

describe('IAM permissions', () => {
  const allStatements = () => {
    const policies = template.findResources('AWS::IAM::Policy');
    return Object.values(policies).flatMap((p) => p.Properties.PolicyDocument.Statement as any[]);
  };

  const statementsWithAction = (action: string) =>
    allStatements().filter((s) => [s.Action].flat().includes(action));

  it('scopes SES sending to the sender identities instead of *', () => {
    const sesStatements = statementsWithAction('ses:SendEmail');
    expect(sesStatements).toHaveLength(1);
    const resources = [sesStatements[0].Resource].flat();
    expect(resources).toHaveLength(2);
    expect(resources).not.toContain('*');
  });

  it('scopes lambda:InvokeFunction to specific function ARNs', () => {
    const invokeStatements = statementsWithAction('lambda:InvokeFunction');
    expect(invokeStatements.length).toBeGreaterThanOrEqual(2);
    for (const statement of invokeStatements) {
      expect([statement.Resource].flat()).not.toContain('*');
    }
  });

  it('does not grant the notification sender read access to the table', () => {
    // The notification sender only flips notification flags via UpdateItem
    const policies = template.findResources('AWS::IAM::Policy');
    const senderPolicy = Object.values(policies).find((p) =>
      (p.Properties.PolicyDocument.Statement as any[]).some((s) => [s.Action].flat().includes('ses:SendEmail'))
    );
    expect(senderPolicy).toBeDefined();
    const actions = (senderPolicy!.Properties.PolicyDocument.Statement as any[]).flatMap((s) => [s.Action].flat());
    expect(actions).toContain('dynamodb:UpdateItem');
    expect(actions).not.toContain('dynamodb:GetItem');
    expect(actions).not.toContain('dynamodb:Scan');
    expect(actions).not.toContain('dynamodb:Query');
  });
});

describe('Scheduling', () => {
  it('triggers the scheduler daily at midnight UTC', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'cron(0 0 * * ? *)',
      State: 'ENABLED',
    });
  });
});

describe('Failure handling', () => {
  it('creates a single shared dead-letter queue with 14-day retention', () => {
    const queues = template.findResources('AWS::SQS::Queue');
    expect(Object.keys(queues)).toHaveLength(1);
    template.hasResourceProperties('AWS::SQS::Queue', {
      MessageRetentionPeriod: 14 * 24 * 60 * 60,
    });
  });

  it('routes failed async invocations of every function to the DLQ', () => {
    const configs = template.findResources('AWS::Lambda::EventInvokeConfig');
    expect(Object.keys(configs)).toHaveLength(3);
    for (const config of Object.values(configs)) {
      expect(config.Properties.DestinationConfig.OnFailure.Destination).toBeDefined();
    }
  });

  it('alarms on DLQ depth and notifies via SNS email', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'AWS/SQS',
      MetricName: 'ApproximateNumberOfMessagesVisible',
      Threshold: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      TreatMissingData: 'notBreaching',
      AlarmActions: [Match.anyValue()],
    });
    template.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email',
      Endpoint: 'alerts@example.com',
    });
  });
});
