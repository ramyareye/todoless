import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createTodolessMcpServer, DEFAULT_API_BASE_URL } from './mcp-server.mjs';

const transport = new StdioServerTransport();
const apiBaseUrl = process.env.TODOLESS_API_BASE_URL || DEFAULT_API_BASE_URL;
const apiKey = process.env.TODOLESS_API_KEY;
if (!apiKey) {
  console.error('TODOLESS_API_KEY is required');
  process.exit(1);
}
const server = createTodolessMcpServer({ apiBaseUrl, apiKey });
await server.connect(transport);
