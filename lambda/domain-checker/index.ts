import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const lambdaClient = new LambdaClient({});

const DOMAINS_TABLE_NAME = process.env.DOMAINS_TABLE_NAME!;
const NOTIFICATION_SENDER_FUNCTION_NAME = process.env.NOTIFICATION_SENDER_FUNCTION_NAME!;

interface DomainItem {
  domainName: string;
  expirationDate?: string;
  lastChecked?: string;
  nextCheckDate?: string;
  status?: string;
  notified?: boolean;
  createdAt?: string;
}

interface RDAPResponse {
  events?: Array<{
    eventAction: string;
    eventDate: string;
  }>;
  handle?: string;
  ldhName?: string;
}

function calculateNextCheckDate(expirationDate: string): string {
  const expDate = new Date(expirationDate);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const daysUntilExpiration = Math.floor((expDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

  // If domain has already expired, no need to schedule another check
  if (daysUntilExpiration < 0) {
    // Return a far future date to prevent further checks
    const farFuture = new Date(today);
    farFuture.setFullYear(farFuture.getFullYear() + 10);
    return farFuture.toISOString().split('T')[0];
  }

  // Schedule check for 1 day after expiration date
  const nextCheck = new Date(expDate);
  nextCheck.setDate(nextCheck.getDate() + 1);
  return nextCheck.toISOString().split('T')[0];
}

function determineStatus(expirationDate: string): string {
  const expDate = new Date(expirationDate);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const daysUntilExpiration = Math.floor((expDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

  if (daysUntilExpiration < 0) {
    return 'expired';
  } else if (daysUntilExpiration <= 7) {
    return 'expiring_soon';
  }
  return 'active';
}

async function queryRDAP(domain: string): Promise<RDAPResponse | null> {
  const rdapUrls = [
    `https://rdap.org/domain/${domain}`,
    `https://rdap.verisign.com/${domain}/domain`,
  ];

  for (const url of rdapUrls) {
    try {
      console.log(`Querying RDAP: ${url}`);
      const response = await fetch(url, {
        headers: {
          'Accept': 'application/rdap+json',
        },
      });

      if (response.ok) {
        const data = await response.json() as RDAPResponse;
        return data;
      }
    } catch (error) {
      console.error(`RDAP query failed for ${url}:`, error);
      continue;
    }
  }

  return null;
}

function extractExpirationDate(rdapData: RDAPResponse): string | null {
  if (!rdapData.events) {
    return null;
  }

  const expirationEvent = rdapData.events.find(
    (event) => event.eventAction === 'expiration'
  );

  if (expirationEvent && expirationEvent.eventDate) {
    return expirationEvent.eventDate.split('T')[0]; // Extract date part only
  }

  return null;
}

export const handler = async (event: any) => {
  console.log('DomainChecker Lambda triggered', JSON.stringify(event));

  const domainName = event.domainName || (event.body ? JSON.parse(event.body).domainName : null);

  if (!domainName) {
    throw new Error('domainName is required');
  }

  try {
    // Get current domain record
    const getCommand = new GetCommand({
      TableName: DOMAINS_TABLE_NAME,
      Key: { domainName },
    });

    const existingRecord = await dynamoClient.send(getCommand);
    const currentItem = (existingRecord.Item || { domainName }) as DomainItem;

    // Query RDAP API
    const rdapData = await queryRDAP(domainName);

    if (!rdapData) {
      console.error(`Failed to get RDAP data for ${domainName}`);
      throw new Error(`Failed to query RDAP for domain: ${domainName}`);
    }

    const expirationDate = extractExpirationDate(rdapData);

    if (!expirationDate) {
      console.error(`No expiration date found in RDAP data for ${domainName}`);
      throw new Error(`No expiration date found for domain: ${domainName}`);
    }

    const today = new Date().toISOString().split('T')[0];
    const status = determineStatus(expirationDate);
    const nextCheckDate = calculateNextCheckDate(expirationDate);

    // Update DynamoDB
    const updateCommand = new UpdateCommand({
      TableName: DOMAINS_TABLE_NAME,
      Key: { domainName },
      UpdateExpression: 'SET expirationDate = :exp, lastChecked = :checked, nextCheckDate = :next, #status = :status',
      ExpressionAttributeNames: {
        '#status': 'status',
      },
      ExpressionAttributeValues: {
        ':exp': expirationDate,
        ':checked': today,
        ':next': nextCheckDate,
        ':status': status,
      },
    });

    // Set createdAt if this is a new record
    if (!currentItem.createdAt) {
      updateCommand.input.UpdateExpression += ', createdAt = :created';
      updateCommand.input.ExpressionAttributeValues![':created'] = today;
    }

    await dynamoClient.send(updateCommand);

    console.log(`Updated domain ${domainName}: expiration=${expirationDate}, status=${status}, nextCheck=${nextCheckDate}`);

    // Check if we need to send notification (only if domain is actually expired)
    const expDate = new Date(expirationDate);
    const todayDate = new Date();
    todayDate.setHours(0, 0, 0, 0);
    const daysUntilExpiration = Math.floor((expDate.getTime() - todayDate.getTime()) / (1000 * 60 * 60 * 24));

    // Only notify if domain is actually expired and hasn't been notified yet
    if (daysUntilExpiration < 0 && !currentItem.notified) {
      // Trigger notification sender
      try {
        const invokeCommand = new InvokeCommand({
          FunctionName: NOTIFICATION_SENDER_FUNCTION_NAME,
          InvocationType: 'Event',
          Payload: JSON.stringify({
            domainName,
            expirationDate,
            daysUntilExpiration,
          }),
        });

        await lambdaClient.send(invokeCommand);
        console.log(`Triggered notification for expired domain ${domainName}`);
      } catch (error) {
        console.error(`Failed to trigger notification for ${domainName}:`, error);
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        domainName,
        expirationDate,
        status,
        nextCheckDate,
        daysUntilExpiration,
      }),
    };
  } catch (error) {
    console.error(`Error checking domain ${domainName}:`, error);
    throw error;
  }
};

