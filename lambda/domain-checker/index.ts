import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import * as net from 'net';

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

async function queryWhoisServer(domain: string, server: string, timeout: number = 10000): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = new net.Socket();
    let response = '';
    let resolved = false;

    const cleanup = () => {
      if (!resolved) {
        resolved = true;
        client.destroy();
      }
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`WHOIS timeout for ${server}`));
    }, timeout);

    client.setEncoding('utf8');

    client.on('connect', () => {
      client.write(`${domain}\r\n`);
    });

    client.on('data', (chunk: Buffer) => {
      response += chunk.toString();
    });

    client.on('end', () => {
      clearTimeout(timer);
      if (!resolved) {
        resolved = true;
        resolve(response);
      }
    });

    client.on('error', (err: Error) => {
      clearTimeout(timer);
      cleanup();
      reject(err);
    });

    try {
      client.connect(43, server);
    } catch (err) {
      clearTimeout(timer);
      cleanup();
      reject(err);
    }
  });
}

async function queryWhoisWithReferrals(domain: string, startServer: string, maxDepth: number = 5): Promise<string> {
  const visited = new Set<string>();
  let currentServer = startServer;
  let depth = 0;

  while (depth < maxDepth) {
    if (visited.has(currentServer)) {
      throw new Error(`Circular WHOIS referral detected: ${currentServer}`);
    }
    visited.add(currentServer);

    console.log(`Querying WHOIS server: ${currentServer} (depth: ${depth})`);
    const response = await queryWhoisServer(domain, currentServer);

    // Check for referral to another server
    const referMatch = response.match(/refer:\s*([^\s\r\n]+)/i);
    if (referMatch) {
      const nextServer = referMatch[1].trim();
      if (nextServer !== currentServer && !visited.has(nextServer)) {
        currentServer = nextServer;
        depth++;
        continue;
      }
    }

    return response;
  }

  throw new Error(`Max WHOIS referral depth reached (${maxDepth})`);
}

function parseExpirationDate(dateStr: string): string | null {
  // Clean up the date string
  dateStr = dateStr.trim().replace(/[^\d\w\s\-\/\.:TZ]/g, '');

  // Try parsing as ISO date first
  const isoMatch = dateStr.match(/^(\d{4}-\d{2}-\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z?)?$/);
  if (isoMatch) {
    const date = new Date(isoMatch[1]);
    if (!isNaN(date.getTime())) {
      return date.toISOString().split('T')[0];
    }
  }

  // Try DD-MMM-YYYY format (e.g., "31-Dec-2024")
  const mmmMatch = dateStr.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (mmmMatch) {
    const [, day, month, year] = mmmMatch;
    const monthMap: { [key: string]: string } = {
      'jan': '01', 'feb': '02', 'mar': '03', 'apr': '04',
      'may': '05', 'jun': '06', 'jul': '07', 'aug': '08',
      'sep': '09', 'oct': '10', 'nov': '11', 'dec': '12',
    };
    const monthNum = monthMap[month.toLowerCase()];
    if (monthNum) {
      const date = new Date(`${year}-${monthNum}-${day.padStart(2, '0')}`);
      if (!isNaN(date.getTime())) {
        return date.toISOString().split('T')[0];
      }
    }
  }

  // Try DD/MM/YYYY or DD.MM.YYYY format
  const slashMatch = dateStr.match(/^(\d{1,2})[\/\.](\d{1,2})[\/\.](\d{4})$/);
  if (slashMatch) {
    const [, day, month, year] = slashMatch;
    const date = new Date(`${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`);
    if (!isNaN(date.getTime())) {
      return date.toISOString().split('T')[0];
    }
  }

  // Try YYYY-MM-DD format
  const dashMatch = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dashMatch) {
    const date = new Date(dateStr);
    if (!isNaN(date.getTime())) {
      return date.toISOString().split('T')[0];
    }
  }

  return null;
}

async function queryWhois(domain: string): Promise<string | null> {
  try {
    console.log(`Querying WHOIS for ${domain} via IANA`);
    const whoisData = await queryWhoisWithReferrals(domain, 'whois.iana.org');

    // Search for expiration-related fields
    const expirationFields = [
      /expir\w+\s+date[^:]*:\s*([^\r\n]+)/i,
      /expir\w+[^:]*:\s*([^\r\n]+)/i,
      /renewal[^:]*:\s*([^\r\n]+)/i,
      /expires?[^:]*:\s*([^\r\n]+)/i,
    ];

    for (const pattern of expirationFields) {
      const match = whoisData.match(pattern);
      if (match && match[1]) {
        const dateStr = match[1].trim();
        const expirationDate = parseExpirationDate(dateStr);

        if (expirationDate) {
          console.log(`Found expiration date: ${expirationDate} (parsed from: ${dateStr})`);
          return expirationDate;
        }
      }
    }

    console.log(`No parseable expiration date found in WHOIS response for ${domain}`);
    return null;
  } catch (error) {
    console.error(`WHOIS query failed for ${domain}:`, error);
    return null;
  }
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

    // Query WHOIS via IANA (automatically follows referrals to correct registry)
    const expirationDate = await queryWhois(domainName);

    // If no expiration date found, handle gracefully
    if (!expirationDate) {
      console.warn(`No expiration date found for domain: ${domainName}. Setting status to 'unknown' and scheduling retry.`);
      
      const today = new Date().toISOString().split('T')[0];
      // Schedule retry in 7 days
      const retryDate = new Date();
      retryDate.setDate(retryDate.getDate() + 7);
      const nextCheckDate = retryDate.toISOString().split('T')[0];

      // Update DynamoDB with unknown status
      const updateCommand = new UpdateCommand({
        TableName: DOMAINS_TABLE_NAME,
        Key: { domainName },
        UpdateExpression: 'SET lastChecked = :checked, nextCheckDate = :next, #status = :status',
        ExpressionAttributeNames: {
          '#status': 'status',
        },
        ExpressionAttributeValues: {
          ':checked': today,
          ':next': nextCheckDate,
          ':status': 'unknown',
        },
      });

      if (!currentItem.createdAt) {
        updateCommand.input.UpdateExpression += ', createdAt = :created';
        updateCommand.input.ExpressionAttributeValues![':created'] = today;
      }

      await dynamoClient.send(updateCommand);

      return {
        statusCode: 200,
        body: JSON.stringify({
          domainName,
          status: 'unknown',
          message: 'Expiration date not available. Will retry in 7 days.',
          nextCheckDate,
        }),
      };
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

