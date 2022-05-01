import {
  APIGatewayProxyEvent,
  APIGatewayProxyEventQueryStringParameters,
  APIGatewayProxyResult,
} from "aws-lambda";
import AWS, { AWSError } from "aws-sdk";
import { Key } from "aws-sdk/clients/dynamodb";
import { v4 } from "uuid";

type Action =
  | "getClients"
  | "getMessages"
  | "sendMessage"
  | "$connect"
  | "$disconnect";

type Client = {
  connectionId: string;
  nickname: string;
};

type SendMessageBody = {
  recipientNickname: string;
  message: string;
};

type GetMessagesBody = {
  targetNickname: string;
  startKey: Key | undefined;
  limit: number;
};

const CLIENTS_TABLE_NAME = "Clients";
const MESSAGES_TABLE_NAME = "Messages";

const docClient = new AWS.DynamoDB.DocumentClient();

const apigw = new AWS.ApiGatewayManagementApi({
  endpoint: process.env.WSSAPIGATEWAYENDPOINT,
});

const responseOK = {
  statusCode: 200,
  body: "",
};

const responseForbidden = {
  statusCode: 403,
  body: "",
};

class HandlerError extends Error {}

export const handle = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  console.log("event:", event);
  const connectionId = event.requestContext.connectionId as string;
  const routeKey = event.requestContext.routeKey as Action;

  try {
    switch (routeKey) {
      case "$connect":
        return handleConnect(connectionId, event.queryStringParameters);
      case "$disconnect":
        return handleDisconnect(connectionId);
      case "getClients":
        return handleGetClients(connectionId);
      case "sendMessage":
        return handleSendMessage(
          await getClient(connectionId),
          parseSendMessageBody(event.body),
        );
      case "getMessages":
        return handleGetMessages(
          await getClient(connectionId),
          parseGetMessageBody(event.body),
        );
      default:
        return responseForbidden;
    }
  } catch (e) {
    if (e instanceof HandlerError) {
      await postToConnection(
        connectionId,
        JSON.stringify({ type: "error", message: e.message }),
      );
      return responseOK;
    }

    throw e;
  }
};

const handleConnect = async (
  connectionId: string,
  queryParameters: APIGatewayProxyEventQueryStringParameters | null,
) => {
  if (!queryParameters || !queryParameters["nickname"]) {
    return responseForbidden;
  }

  const existingConnectionId = await getConnectionIdByNickname(
    queryParameters["nickname"],
  );
  if (
    existingConnectionId &&
    (await postToConnection(
      existingConnectionId,
      JSON.stringify({ type: "ping" }),
    ))
  ) {
    return responseForbidden;
  }

  await docClient
    .put({
      TableName: CLIENTS_TABLE_NAME,
      Item: {
        connectionId,
        nickname: queryParameters["nickname"],
      },
    })
    .promise();

  await notifyClientChange(connectionId);

  return responseOK;
};

const notifyClientChange = async (excludedConnectionId: string) => {
  const clients = await getAllClients();

  await Promise.all(
    clients.map(async (c) => {
      if (excludedConnectionId === c.connectionId) {
        return;
      }

      await postToConnection(
        c.connectionId,
        JSON.stringify({ type: "clients", value: clients }),
      );
    }),
  );
};

const getAllClients = async (): Promise<Client[]> => {
  const output = await docClient
    .scan({
      TableName: CLIENTS_TABLE_NAME,
    })
    .promise();

  const clients = output.Items || [];

  return clients as Client[];
};

const postToConnection = async (
  connectionId: string,
  messageBody: string,
): Promise<boolean> => {
  try {
    await apigw
      .postToConnection({
        ConnectionId: connectionId,
        Data: messageBody,
      })
      .promise();

    return true;
  } catch (e) {
    if (isConnectionNotExistError(e)) {
      await docClient
        .delete({
          TableName: CLIENTS_TABLE_NAME,
          Key: {
            connectionId: connectionId,
          },
        })
        .promise();

      return false;
    } else {
      throw e;
    }
  }
};

const isConnectionNotExistError = (e: unknown) =>
  (e as AWSError).statusCode === 410;

const handleDisconnect = async (connectionId: string) => {
  await docClient
    .delete({
      TableName: CLIENTS_TABLE_NAME,
      Key: {
        connectionId,
      },
    })
    .promise();

  await notifyClientChange(connectionId);

  return responseOK;
};

const handleGetClients = async (connectionId: string) => {
  await postToConnection(
    connectionId,
    JSON.stringify({
      type: "clients",
      value: await getAllClients(),
    }),
  );

  return responseOK;
};

const handleSendMessage = async (client: Client, body: SendMessageBody) => {
  const nicknameToNickname = getNicknameToNickname([
    client.nickname,
    body.recipientNickname,
  ]);

  await docClient
    .put({
      TableName: MESSAGES_TABLE_NAME,
      Item: {
        messageId: v4(),
        nicknameToNickname,
        message: body.message,
        sender: client.nickname,
        createdAt: new Date().getTime(),
      },
    })
    .promise();

  const recipientConnectionId = await getConnectionIdByNickname(
    body.recipientNickname,
  );

  if (recipientConnectionId) {
    await apigw
      .postToConnection({
        ConnectionId: recipientConnectionId,
        Data: JSON.stringify({
          type: "message",
          value: {
            sender: client.nickname,
            message: body.message,
          },
        }),
      })
      .promise();
  }

  return responseOK;
};

const getClient = async (connectionId: string) => {
  const output = await docClient
    .get({
      TableName: CLIENTS_TABLE_NAME,
      Key: {
        connectionId,
      },
    })
    .promise();

  if (!output.Item) {
    throw new HandlerError("client does not exist");
  }

  return output.Item as Client;
};

const parseSendMessageBody = (body: string | null): SendMessageBody => {
  const sendMsgBody = JSON.parse(body || "{}") as SendMessageBody;

  if (!sendMsgBody || !sendMsgBody.recipientNickname || !sendMsgBody.message) {
    throw new HandlerError("invalid SendMessageBody");
  }

  return sendMsgBody;
};

const getNicknameToNickname = (nicknames: string[]) =>
  nicknames.sort().join("#");

const getConnectionIdByNickname = async (
  nickname: string,
): Promise<string | undefined> => {
  const output = await docClient
    .query({
      TableName: CLIENTS_TABLE_NAME,
      IndexName: "NicknameIndex",
      KeyConditionExpression: "#nickname = :nickname",
      ExpressionAttributeNames: {
        "#nickname": "nickname",
      },
      ExpressionAttributeValues: {
        ":nickname": nickname,
      },
    })
    .promise();

  return output.Items && output.Items.length > 0
    ? output.Items[0].connectionId
    : undefined;
};

const handleGetMessages = async (client: Client, body: GetMessagesBody) => {
  const output = await docClient
    .query({
      TableName: MESSAGES_TABLE_NAME,
      IndexName: "NicknameToNicknameIndex",
      KeyConditionExpression: "#nicknameToNickname = :nicknameToNickname",
      ExpressionAttributeNames: {
        "#nicknameToNickname": "nicknameToNickname",
      },
      ExpressionAttributeValues: {
        ":nicknameToNickname": getNicknameToNickname([
          client.nickname,
          body.targetNickname,
        ]),
      },
      Limit: body.limit,
      ExclusiveStartKey: body.startKey,
      ScanIndexForward: false,
    })
    .promise();

  await postToConnection(
    client.connectionId,
    JSON.stringify({
      type: "messages",
      value: {
        messages: output.Items && output.Items.length > 0 ? output.Items : [],
        lastEvaluatedKey: output.LastEvaluatedKey,
      },
    }),
  );

  return responseOK;
};

const parseGetMessageBody = (body: string | null) => {
  const getMessagesBody = JSON.parse(body || "{}") as GetMessagesBody;

  if (
    !getMessagesBody ||
    !getMessagesBody.targetNickname ||
    !getMessagesBody.limit
  ) {
    throw new HandlerError("invalid GetMessageBody");
  }

  return getMessagesBody;
};
