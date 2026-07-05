import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import * as path from 'path';

export class DomainPollenatorStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // DynamoDB Table
    const domainsTable = new dynamodb.Table(this, 'DomainsTable', {
      partitionKey: { name: 'domainName', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // The domain list is the only stateful resource in the stack - keep it on stack deletion
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: false,
      },
    });

    // SES Configuration - Get email from environment variable or use default
    const notificationEmail = process.env.NOTIFICATION_EMAIL || 'your-email@example.com';
    const senderEmail = process.env.SENDER_EMAIL || 'noreply@domain-pollenator.com';

    // Lambda: Notification Sender
    const notificationSenderLambda = new NodejsFunction(this, 'NotificationSenderLambda', {
      runtime: lambda.Runtime.NODEJS_24_X,
      entry: path.join(__dirname, '../lambda/notification-sender/index.ts'),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        DOMAINS_TABLE_NAME: domainsTable.tableName,
        NOTIFICATION_EMAIL: notificationEmail,
        SENDER_EMAIL: senderEmail,
      },
      logGroup: new logs.LogGroup(this, 'NotificationSenderLambdaLogGroup', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      bundling: {
        minify: true,
      },
    });

    // Lambda: Domain Checker
    const domainCheckerLambda = new NodejsFunction(this, 'DomainCheckerLambda', {
      runtime: lambda.Runtime.NODEJS_24_X,
      entry: path.join(__dirname, '../lambda/domain-checker/index.ts'),
      // WHOIS referral chains can take up to 5 queries x 10s socket timeout
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      environment: {
        DOMAINS_TABLE_NAME: domainsTable.tableName,
        NOTIFICATION_SENDER_FUNCTION_NAME: notificationSenderLambda.functionName,
      },
      logGroup: new logs.LogGroup(this, 'DomainCheckerLambdaLogGroup', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      bundling: {
        minify: true,
      },
    });

    // Lambda: Scheduler
    const schedulerLambda = new NodejsFunction(this, 'SchedulerLambda', {
      runtime: lambda.Runtime.NODEJS_24_X,
      entry: path.join(__dirname, '../lambda/scheduler/index.ts'),
      timeout: cdk.Duration.minutes(5),
      memorySize: 256,
      environment: {
        DOMAINS_TABLE_NAME: domainsTable.tableName,
        DOMAIN_CHECKER_FUNCTION_NAME: domainCheckerLambda.functionName,
      },
      logGroup: new logs.LogGroup(this, 'SchedulerLambdaLogGroup', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      bundling: {
        minify: true,
      },
    });

    // IAM Permissions: Domain Checker
    domainsTable.grantReadWriteData(domainCheckerLambda);
    domainCheckerLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['lambda:InvokeFunction'],
        resources: [notificationSenderLambda.functionArn],
      })
    );

    // IAM Permissions: Notification Sender (only updates notification flags, never reads)
    domainsTable.grantWriteData(notificationSenderLambda);
    // Scope sending to the sender identity - covers both address- and domain-verified identities
    const senderDomain = senderEmail.split('@')[1];
    notificationSenderLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['ses:SendEmail', 'ses:SendRawEmail'],
        resources: [
          this.formatArn({ service: 'ses', resource: 'identity', resourceName: senderEmail, arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME }),
          this.formatArn({ service: 'ses', resource: 'identity', resourceName: senderDomain, arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME }),
        ],
      })
    );

    // IAM Permissions: Scheduler
    domainsTable.grantReadData(schedulerLambda);
    schedulerLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['lambda:InvokeFunction'],
        resources: [domainCheckerLambda.functionArn],
      })
    );

    // EventBridge Rule: Daily trigger at midnight UTC
    const dailyRule = new events.Rule(this, 'DailySchedulerRule', {
      schedule: events.Schedule.cron({ hour: '0', minute: '0' }),
      description: 'Triggers domain checker scheduler daily at midnight UTC',
    });

    dailyRule.addTarget(new targets.LambdaFunction(schedulerLambda));

    // Outputs
    new cdk.CfnOutput(this, 'DomainsTableName', {
      value: domainsTable.tableName,
      description: 'Name of the DynamoDB table storing domain information',
    });

    new cdk.CfnOutput(this, 'NotificationEmail', {
      value: notificationEmail,
      description: 'Email address for expiration notifications',
    });
  }
}

