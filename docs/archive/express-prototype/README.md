# 🗂️ Headless Todo API

A developer-first, API-only todo backend. Build any frontend you want.

## Features

- **🔐 API Key Authentication** - Simple Bearer token auth
- **🏢 Multi-tenant Workspaces** - Organize todos by project/context
- **📋 Rich Todos** - Tags, priorities (low/medium/high), due dates
- **⚡ Webhooks** - Real-time notifications for integrations
- **🔍 Filtering** - Query by status, priority, or tag

## Quick Start

```bash
# Install dependencies
npm install

# Start the server
npm start

# Server runs on http://localhost:3001
```

## API Reference

### Base URL
```
http://localhost:3001/api/v1
```

### Authentication

All endpoints (except `/auth/register`) require an API key in the Authorization header:

```
Authorization: Bearer htd_your_api_key_here
```

---

### Auth

#### Register User
```http
POST /api/v1/auth/register
Content-Type: application/json

{
  "email": "developer@example.com"
}
```

**Response:**
```json
{
  "message": "Registration successful",
  "user": { "id": "user_abc123", "email": "developer@example.com" },
  "api_key": "htd_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "default_workspace": { "id": "ws_xyz789", "name": "Default" }
}
```

---

### Workspaces

#### List Workspaces
```http
GET /api/v1/workspaces
Authorization: Bearer htd_xxx
```

#### Create Workspace
```http
POST /api/v1/workspaces
Authorization: Bearer htd_xxx
Content-Type: application/json

{
  "name": "Work Projects"
}
```

#### Get Workspace
```http
GET /api/v1/workspaces/:id
```

#### Delete Workspace
```http
DELETE /api/v1/workspaces/:id
```

---

### Todos

#### List Todos
```http
GET /api/v1/workspaces/:workspaceId/todos
Authorization: Bearer htd_xxx
```

**Query Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `completed` | boolean | Filter by completion status |
| `priority` | string | Filter by priority (low, medium, high) |
| `tag` | string | Filter by tag name |
| `limit` | number | Max results (default: 50, max: 100) |
| `offset` | number | Pagination offset |

**Examples:**
```bash
# Get active todos
GET /api/v1/workspaces/ws_123/todos?completed=false

# Get high priority todos
GET /api/v1/workspaces/ws_123/todos?priority=high

# Get todos with specific tag
GET /api/v1/workspaces/ws_123/todos?tag=urgent
```

#### Create Todo
```http
POST /api/v1/workspaces/:workspaceId/todos
Authorization: Bearer htd_xxx
Content-Type: application/json

{
  "title": "Implement user auth",
  "description": "Add OAuth2 support",
  "priority": "high",
  "due_date": "2024-03-15",
  "tags": ["backend", "security"]
}
```

#### Get Todo
```http
GET /api/v1/todos/:id
```

#### Update Todo
```http
PATCH /api/v1/todos/:id
Content-Type: application/json

{
  "completed": true
}
```

**Updatable fields:** `title`, `description`, `completed`, `priority`, `due_date`, `tags`

#### Delete Todo
```http
DELETE /api/v1/todos/:id
```

---

### Webhooks

#### List Webhooks
```http
GET /api/v1/workspaces/:workspaceId/webhooks
```

#### Create Webhook
```http
POST /api/v1/workspaces/:workspaceId/webhooks
Content-Type: application/json

{
  "url": "https://your-app.com/webhooks/todos",
  "events": ["todo.created", "todo.completed"]
}
```

**Available Events:**
- `todo.created` - New todo created
- `todo.updated` - Todo modified
- `todo.completed` - Todo marked complete
- `todo.deleted` - Todo removed

**Response includes a `secret` for verifying webhook signatures.**

#### Toggle Webhook
```http
PATCH /api/v1/webhooks/:id
Content-Type: application/json

{
  "active": false
}
```

#### Delete Webhook
```http
DELETE /api/v1/webhooks/:id
```

---

### Webhook Payload

```json
{
  "event": "todo.created",
  "timestamp": "2024-02-15T10:30:00.000Z",
  "data": {
    "id": "todo_abc123",
    "title": "My task",
    "completed": false,
    "priority": "high",
    "tags": ["work"]
  }
}
```

**Headers:**
```
X-Webhook-Event: todo.created
X-Webhook-Signature: t=1707990600000,v1=abc123...
```

**Verify signatures:**
```javascript
const crypto = require('crypto');

function verifyWebhook(payload, signature, secret) {
  const [timestamp, hash] = signature.split(',').map(p => p.split('=')[1]);
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${JSON.stringify(payload)}`)
    .digest('hex');
  return hash === expected;
}
```

---

## Error Responses

```json
{
  "error": "Unauthorized",
  "message": "Invalid API key"
}
```

| Status | Meaning |
|--------|---------|
| 400 | Bad Request - Invalid input |
| 401 | Unauthorized - Missing/invalid API key |
| 404 | Not Found - Resource doesn't exist |
| 409 | Conflict - Resource already exists |

---

## Example: Full Workflow

```bash
# 1. Register
curl -X POST http://localhost:3001/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email": "me@example.com"}'

# Save the api_key from response!

# 2. Create a workspace
curl -X POST http://localhost:3001/api/v1/workspaces \
  -H "Authorization: Bearer htd_your_key" \
  -H "Content-Type: application/json" \
  -d '{"name": "Side Project"}'

# 3. Add todos
curl -X POST http://localhost:3001/api/v1/workspaces/ws_xxx/todos \
  -H "Authorization: Bearer htd_your_key" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Build MVP",
    "priority": "high",
    "tags": ["launch", "urgent"]
  }'

# 4. Set up webhook
curl -X POST http://localhost:3001/api/v1/workspaces/ws_xxx/webhooks \
  -H "Authorization: Bearer htd_your_key" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://hooks.slack.com/services/xxx",
    "events": ["todo.completed"]
  }'

# 5. Complete todo (triggers webhook!)
curl -X PATCH http://localhost:3001/api/v1/todos/todo_xxx \
  -H "Authorization: Bearer htd_your_key" \
  -H "Content-Type: application/json" \
  -d '{"completed": true}'
```

---

## Deployment

### Docker

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 3001
CMD ["npm", "start"]
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3001 | Server port |

---

## License

MIT
