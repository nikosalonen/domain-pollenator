import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const lambdaClient = new LambdaClient({});

const DOMAINS_TABLE_NAME = process.env.DOMAINS_TABLE_NAME!;
const DOMAIN_CHECKER_FUNCTION_NAME = process.env.DOMAIN_CHECKER_FUNCTION_NAME!;

interface DomainItem {
  domainName: string;
  expirationDate?: string;
  lastChecked?: string;
  nextCheckDate?: string;
  status?: string;
}

export const handler = async (event: any) => {
  console.log('Scheduler Lambda triggered', JSON.stringify(event));

  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayISO = today.toISOString().split('T')[0];

    // Scan all domains from DynamoDB
    const scanCommand = new ScanCommand({
      TableName: DOMAINS_TABLE_NAME,
    });

    const result = await dynamoClient.send(scanCommand);
    const domains = (result.Items || []) as DomainItem[];

    console.log(`Found ${domains.length} domains in table`);

    // Filter domains that need checking
    const domainsToCheck = domains.filter((domain) => {
      if (!domain.nextCheckDate) {
        return true; // Never checked, check now
      }
      return domain.nextCheckDate <= todayISO;
    });

    console.log(`${domainsToCheck.length} domains need checking`);

    // Invoke DomainChecker for each domain
    const invokePromises = domainsToCheck.map(async (domain) => {
      try {
        const invokeCommand = new InvokeCommand({
          FunctionName: DOMAIN_CHECKER_FUNCTION_NAME,
          InvocationType: 'Event', // Async invocation
          Payload: JSON.stringify({
            domainName: domain.domainName,
          }),
        });

        await lambdaClient.send(invokeCommand);
        console.log(`Invoked checker for domain: ${domain.domainName}`);
      } catch (error) {
        console.error(`Failed to invoke checker for ${domain.domainName}:`, error);
      }
    });

    await Promise.all(invokePromises);

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: `Processed ${domainsToCheck.length} domains for checking`,
        domainsChecked: domainsToCheck.length,
        totalDomains: domains.length,
      }),
    };
  } catch (error) {
    console.error('Scheduler error:', error);
    throw error;
  }
};

