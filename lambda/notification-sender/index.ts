import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';

const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sesClient = new SESClient({});

const DOMAINS_TABLE_NAME = process.env.DOMAINS_TABLE_NAME!;
const NOTIFICATION_EMAIL = process.env.NOTIFICATION_EMAIL!;

export const handler = async (event: any) => {
  console.log('NotificationSender Lambda triggered', JSON.stringify(event));

  const domainName = event.domainName || (event.body ? JSON.parse(event.body).domainName : null);
  const expirationDate = event.expirationDate || (event.body ? JSON.parse(event.body).expirationDate : null);
  const daysUntilExpiration = event.daysUntilExpiration !== undefined
    ? event.daysUntilExpiration
    : (event.body ? JSON.parse(event.body).daysUntilExpiration : null);

  if (!domainName || !expirationDate) {
    throw new Error('domainName and expirationDate are required');
  }

  try {
    const days = daysUntilExpiration !== null ? daysUntilExpiration : calculateDaysUntilExpiration(expirationDate);

    // Create email content
    const subject = `Domain Expired: ${domainName}`;
    const body = `
Domain Expired Alert

Domain: ${domainName}
Expiration Date: ${expirationDate}
Days Since Expiration: ${Math.abs(days)}

This domain has expired. You may want to attempt to register it now that it's available.

---
This is an automated message from Domain Pollenator.
    `.trim();

    // Send email via SES
    const sendEmailCommand = new SendEmailCommand({
      Source: NOTIFICATION_EMAIL,
      Destination: {
        ToAddresses: [NOTIFICATION_EMAIL],
      },
      Message: {
        Subject: {
          Data: subject,
          Charset: 'UTF-8',
        },
        Body: {
          Text: {
            Data: body,
            Charset: 'UTF-8',
          },
        },
      },
    });

    await sesClient.send(sendEmailCommand);
    console.log(`Notification email sent for domain: ${domainName}`);

    // Mark domain as notified in DynamoDB
    const updateCommand = new UpdateCommand({
      TableName: DOMAINS_TABLE_NAME,
      Key: { domainName },
      UpdateExpression: 'SET notified = :notified',
      ExpressionAttributeValues: {
        ':notified': true,
      },
    });

    await dynamoClient.send(updateCommand);
    console.log(`Marked domain ${domainName} as notified`);

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: `Notification sent for domain: ${domainName}`,
        domainName,
        expirationDate,
        daysUntilExpiration: days,
      }),
    };
  } catch (error) {
    console.error(`Error sending notification for ${domainName}:`, error);
    throw error;
  }
};

function calculateDaysUntilExpiration(expirationDate: string): number {
  const expDate = new Date(expirationDate);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.floor((expDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

