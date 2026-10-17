import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from './config.js';
import type { YouGileClient } from './http/client.js';
import type { ToolDeps, ToolGroup } from './tools/_shared.js';
import { registerBoardsTools } from './tools/boards.js';
import { registerChatsTools } from './tools/chats.js';
import { registerColumnsTools } from './tools/columns.js';
import { registerCompanyTools } from './tools/company.js';
import { registerDepartmentsTools } from './tools/departments.js';
import { registerProjectsTools } from './tools/projects.js';
import { registerRolesTools } from './tools/roles.js';
import { registerStickersTools } from './tools/stickers.js';
import { registerTasksTools } from './tools/tasks.js';
import { registerUsersTools } from './tools/users.js';
import { registerWebhooksTools } from './tools/webhooks.js';

export const SERVER_NAME = 'yougile-mcp';
export const SERVER_VERSION = '0.1.0';

const groups: ToolGroup[] = [
  registerUsersTools,
  registerCompanyTools,
  registerProjectsTools,
  registerRolesTools,
  registerDepartmentsTools,
  registerBoardsTools,
  registerColumnsTools,
  registerTasksTools,
  registerStickersTools,
  registerChatsTools,
  registerWebhooksTools,
];

export function createServer(config: Config, deps: { client: YouGileClient }): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const toolDeps: ToolDeps = { client: deps.client, config };
  for (const register of groups) register(server, toolDeps);
  return server;
}
