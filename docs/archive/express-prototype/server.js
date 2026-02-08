/**
 * Headless Todo API - A Developer-First Todo Backend
 * 
 * Features:
 * - API Key Authentication
 * - Multi-tenant Workspaces
 * - Todos with tags, priorities, due dates
 * - Webhook notifications
 * 
 * Run: npm install && node server.js
 */

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 3001;

// Initialize SQLite database
const db = new Database('headless-todo.db');

// ============================================
// DATABASE SCHEMA
// ============================================

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    api_key TEXT UNIQUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    user_id TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS todos (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    completed INTEGER DEFAULT 0,
    priority TEXT DEFAULT 'medium',
    due_date TEXT,
    workspace_id TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
  );

  CREATE TABLE IF NOT EXISTS tags (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    todo_id TEXT NOT NULL,
    FOREIGN KEY (todo_id) REFERENCES todos(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS webhooks (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    events TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    active INTEGER DEFAULT 1,
    secret TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
  );

  CREATE INDEX IF NOT EXISTS idx_todos_workspace ON todos(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_webhooks_workspace ON webhooks(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_tags_todo ON tags(todo_id);
`);

// ============================================
// MIDDLEWARE
// ============================================

app.use(cors());
app.use(express.json());

// Request logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} | ${req.method} ${req.path}`);
  next();
});

// API Key Authentication
const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ 
      error: 'Unauthorized',
      message: 'Missing or invalid Authorization header. Use: Bearer <api_key>'
    });
  }

  const apiKey = authHeader.substring(7);
  const user = db.prepare('SELECT * FROM users WHERE api_key = ?').get(apiKey);

  if (!user) {
    return res.status(401).json({ 
      error: 'Unauthorized',
      message: 'Invalid API key'
    });
  }

  req.user = user;
  next();
};

// ============================================
// HELPER FUNCTIONS
// ============================================

const generateId = (prefix = '') => `${prefix}${crypto.randomBytes(8).toString('hex')}`;
const generateApiKey = () => `htd_${crypto.randomBytes(24).toString('hex')}`;
const generateWebhookSecret = () => `whsec_${crypto.randomBytes(24).toString('hex')}`;

// Dispatch webhook events
async function dispatchWebhooks(workspaceId, event, payload) {
  const webhooks = db.prepare(
    'SELECT * FROM webhooks WHERE workspace_id = ? AND active = 1'
  ).all(workspaceId);

  for (const webhook of webhooks) {
    const events = JSON.parse(webhook.events);
    if (!events.includes(event)) continue;

    const timestamp = Date.now();
    const signature = crypto
      .createHmac('sha256', webhook.secret)
      .update(`${timestamp}.${JSON.stringify(payload)}`)
      .digest('hex');

    try {
      await fetch(webhook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': `t=${timestamp},v1=${signature}`,
          'X-Webhook-Event': event
        },
        body: JSON.stringify({
          event,
          timestamp: new Date().toISOString(),
          data: payload
        })
      });
      console.log(`Webhook dispatched: ${event} -> ${webhook.url}`);
    } catch (err) {
      console.error(`Webhook failed: ${webhook.url}`, err.message);
    }
  }
}

// Get todo with tags
function getTodoWithTags(todoId) {
  const todo = db.prepare('SELECT * FROM todos WHERE id = ?').get(todoId);
  if (!todo) return null;
  
  const tags = db.prepare('SELECT name FROM tags WHERE todo_id = ?').all(todoId);
  return {
    ...todo,
    completed: Boolean(todo.completed),
    tags: tags.map(t => t.name)
  };
}

// ============================================
// AUTH ROUTES (No auth required)
// ============================================

// Register new user
app.post('/api/v1/auth/register', (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (existing) {
    return res.status(409).json({ error: 'Email already registered' });
  }

  const user = {
    id: generateId('user_'),
    email,
    api_key: generateApiKey()
  };

  db.prepare('INSERT INTO users (id, email, api_key) VALUES (?, ?, ?)')
    .run(user.id, user.email, user.api_key);

  // Create default workspace
  const workspace = {
    id: generateId('ws_'),
    name: 'Default',
    user_id: user.id
  };

  db.prepare('INSERT INTO workspaces (id, name, user_id) VALUES (?, ?, ?)')
    .run(workspace.id, workspace.name, workspace.user_id);

  res.status(201).json({
    message: 'Registration successful',
    user: { id: user.id, email: user.email },
    api_key: user.api_key,
    default_workspace: workspace
  });
});

// ============================================
// WORKSPACE ROUTES
// ============================================

// List workspaces
app.get('/api/v1/workspaces', authenticate, (req, res) => {
  const workspaces = db.prepare(
    'SELECT * FROM workspaces WHERE user_id = ? ORDER BY created_at DESC'
  ).all(req.user.id);

  res.json({ workspaces });
});

// Create workspace
app.post('/api/v1/workspaces', authenticate, (req, res) => {
  const { name } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Workspace name is required' });
  }

  const workspace = {
    id: generateId('ws_'),
    name,
    user_id: req.user.id
  };

  db.prepare('INSERT INTO workspaces (id, name, user_id) VALUES (?, ?, ?)')
    .run(workspace.id, workspace.name, workspace.user_id);

  res.status(201).json(workspace);
});

// Get workspace
app.get('/api/v1/workspaces/:id', authenticate, (req, res) => {
  const workspace = db.prepare(
    'SELECT * FROM workspaces WHERE id = ? AND user_id = ?'
  ).get(req.params.id, req.user.id);

  if (!workspace) {
    return res.status(404).json({ error: 'Workspace not found' });
  }

  res.json(workspace);
});

// Delete workspace
app.delete('/api/v1/workspaces/:id', authenticate, (req, res) => {
  const workspace = db.prepare(
    'SELECT * FROM workspaces WHERE id = ? AND user_id = ?'
  ).get(req.params.id, req.user.id);

  if (!workspace) {
    return res.status(404).json({ error: 'Workspace not found' });
  }

  // Delete associated todos and webhooks
  db.prepare('DELETE FROM tags WHERE todo_id IN (SELECT id FROM todos WHERE workspace_id = ?)').run(req.params.id);
  db.prepare('DELETE FROM todos WHERE workspace_id = ?').run(req.params.id);
  db.prepare('DELETE FROM webhooks WHERE workspace_id = ?').run(req.params.id);
  db.prepare('DELETE FROM workspaces WHERE id = ?').run(req.params.id);

  res.json({ success: true, message: 'Workspace deleted' });
});

// ============================================
// TODO ROUTES
// ============================================

// List todos in workspace
app.get('/api/v1/workspaces/:workspaceId/todos', authenticate, (req, res) => {
  const workspace = db.prepare(
    'SELECT * FROM workspaces WHERE id = ? AND user_id = ?'
  ).get(req.params.workspaceId, req.user.id);

  if (!workspace) {
    return res.status(404).json({ error: 'Workspace not found' });
  }

  let query = 'SELECT * FROM todos WHERE workspace_id = ?';
  const params = [req.params.workspaceId];

  // Filter by completed status
  if (req.query.completed !== undefined) {
    query += ' AND completed = ?';
    params.push(req.query.completed === 'true' ? 1 : 0);
  }

  // Filter by priority
  if (req.query.priority) {
    query += ' AND priority = ?';
    params.push(req.query.priority);
  }

  // Filter by tag
  if (req.query.tag) {
    query += ' AND id IN (SELECT todo_id FROM tags WHERE name = ?)';
    params.push(req.query.tag);
  }

  query += ' ORDER BY created_at DESC';

  // Pagination
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const offset = parseInt(req.query.offset) || 0;
  query += ` LIMIT ${limit} OFFSET ${offset}`;

  const todos = db.prepare(query).all(...params);

  // Attach tags to each todo
  const todosWithTags = todos.map(todo => {
    const tags = db.prepare('SELECT name FROM tags WHERE todo_id = ?').all(todo.id);
    return {
      ...todo,
      completed: Boolean(todo.completed),
      tags: tags.map(t => t.name)
    };
  });

  res.json({ 
    todos: todosWithTags,
    pagination: { limit, offset }
  });
});

// Create todo
app.post('/api/v1/workspaces/:workspaceId/todos', authenticate, (req, res) => {
  const workspace = db.prepare(
    'SELECT * FROM workspaces WHERE id = ? AND user_id = ?'
  ).get(req.params.workspaceId, req.user.id);

  if (!workspace) {
    return res.status(404).json({ error: 'Workspace not found' });
  }

  const { title, description, priority, due_date, tags } = req.body;

  if (!title) {
    return res.status(400).json({ error: 'Title is required' });
  }

  if (priority && !['low', 'medium', 'high'].includes(priority)) {
    return res.status(400).json({ error: 'Priority must be low, medium, or high' });
  }

  const todo = {
    id: generateId('todo_'),
    title,
    description: description || null,
    priority: priority || 'medium',
    due_date: due_date || null,
    workspace_id: req.params.workspaceId
  };

  db.prepare(`
    INSERT INTO todos (id, title, description, priority, due_date, workspace_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(todo.id, todo.title, todo.description, todo.priority, todo.due_date, todo.workspace_id);

  // Add tags
  if (tags && Array.isArray(tags)) {
    const insertTag = db.prepare('INSERT INTO tags (id, name, todo_id) VALUES (?, ?, ?)');
    tags.forEach(tag => {
      insertTag.run(generateId('tag_'), tag, todo.id);
    });
  }

  const createdTodo = getTodoWithTags(todo.id);
  
  // Dispatch webhook
  dispatchWebhooks(req.params.workspaceId, 'todo.created', createdTodo);

  res.status(201).json(createdTodo);
});

// Get single todo
app.get('/api/v1/todos/:id', authenticate, (req, res) => {
  const todo = db.prepare(`
    SELECT t.* FROM todos t
    JOIN workspaces w ON t.workspace_id = w.id
    WHERE t.id = ? AND w.user_id = ?
  `).get(req.params.id, req.user.id);

  if (!todo) {
    return res.status(404).json({ error: 'Todo not found' });
  }

  res.json(getTodoWithTags(req.params.id));
});

// Update todo
app.patch('/api/v1/todos/:id', authenticate, (req, res) => {
  const todo = db.prepare(`
    SELECT t.* FROM todos t
    JOIN workspaces w ON t.workspace_id = w.id
    WHERE t.id = ? AND w.user_id = ?
  `).get(req.params.id, req.user.id);

  if (!todo) {
    return res.status(404).json({ error: 'Todo not found' });
  }

  const { title, description, completed, priority, due_date, tags } = req.body;
  const updates = [];
  const values = [];

  if (title !== undefined) { updates.push('title = ?'); values.push(title); }
  if (description !== undefined) { updates.push('description = ?'); values.push(description); }
  if (completed !== undefined) { updates.push('completed = ?'); values.push(completed ? 1 : 0); }
  if (priority !== undefined) { updates.push('priority = ?'); values.push(priority); }
  if (due_date !== undefined) { updates.push('due_date = ?'); values.push(due_date); }

  if (updates.length > 0) {
    updates.push('updated_at = CURRENT_TIMESTAMP');
    values.push(req.params.id);
    db.prepare(`UPDATE todos SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  }

  // Update tags if provided
  if (tags !== undefined && Array.isArray(tags)) {
    db.prepare('DELETE FROM tags WHERE todo_id = ?').run(req.params.id);
    const insertTag = db.prepare('INSERT INTO tags (id, name, todo_id) VALUES (?, ?, ?)');
    tags.forEach(tag => {
      insertTag.run(generateId('tag_'), tag, req.params.id);
    });
  }

  const updatedTodo = getTodoWithTags(req.params.id);

  // Dispatch appropriate webhook
  const event = completed !== undefined && completed ? 'todo.completed' : 'todo.updated';
  dispatchWebhooks(todo.workspace_id, event, updatedTodo);

  res.json(updatedTodo);
});

// Delete todo
app.delete('/api/v1/todos/:id', authenticate, (req, res) => {
  const todo = db.prepare(`
    SELECT t.* FROM todos t
    JOIN workspaces w ON t.workspace_id = w.id
    WHERE t.id = ? AND w.user_id = ?
  `).get(req.params.id, req.user.id);

  if (!todo) {
    return res.status(404).json({ error: 'Todo not found' });
  }

  const todoData = getTodoWithTags(req.params.id);

  db.prepare('DELETE FROM tags WHERE todo_id = ?').run(req.params.id);
  db.prepare('DELETE FROM todos WHERE id = ?').run(req.params.id);

  dispatchWebhooks(todo.workspace_id, 'todo.deleted', todoData);

  res.json({ success: true, message: 'Todo deleted' });
});

// ============================================
// WEBHOOK ROUTES
// ============================================

// List webhooks
app.get('/api/v1/workspaces/:workspaceId/webhooks', authenticate, (req, res) => {
  const workspace = db.prepare(
    'SELECT * FROM workspaces WHERE id = ? AND user_id = ?'
  ).get(req.params.workspaceId, req.user.id);

  if (!workspace) {
    return res.status(404).json({ error: 'Workspace not found' });
  }

  const webhooks = db.prepare(
    'SELECT id, url, events, active, created_at FROM webhooks WHERE workspace_id = ?'
  ).all(req.params.workspaceId);

  res.json({
    webhooks: webhooks.map(w => ({
      ...w,
      events: JSON.parse(w.events),
      active: Boolean(w.active)
    }))
  });
});

// Create webhook
app.post('/api/v1/workspaces/:workspaceId/webhooks', authenticate, (req, res) => {
  const workspace = db.prepare(
    'SELECT * FROM workspaces WHERE id = ? AND user_id = ?'
  ).get(req.params.workspaceId, req.user.id);

  if (!workspace) {
    return res.status(404).json({ error: 'Workspace not found' });
  }

  const { url, events } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  if (!events || !Array.isArray(events) || events.length === 0) {
    return res.status(400).json({ error: 'At least one event is required' });
  }

  const validEvents = ['todo.created', 'todo.updated', 'todo.completed', 'todo.deleted'];
  const invalidEvents = events.filter(e => !validEvents.includes(e));
  if (invalidEvents.length > 0) {
    return res.status(400).json({ 
      error: 'Invalid events',
      invalid: invalidEvents,
      valid: validEvents
    });
  }

  const webhook = {
    id: generateId('wh_'),
    url,
    events: JSON.stringify(events),
    workspace_id: req.params.workspaceId,
    secret: generateWebhookSecret()
  };

  db.prepare(`
    INSERT INTO webhooks (id, url, events, workspace_id, secret)
    VALUES (?, ?, ?, ?, ?)
  `).run(webhook.id, webhook.url, webhook.events, webhook.workspace_id, webhook.secret);

  res.status(201).json({
    id: webhook.id,
    url: webhook.url,
    events,
    active: true,
    secret: webhook.secret,
    message: 'Store this secret securely - it will only be shown once'
  });
});

// Delete webhook
app.delete('/api/v1/webhooks/:id', authenticate, (req, res) => {
  const webhook = db.prepare(`
    SELECT wh.* FROM webhooks wh
    JOIN workspaces w ON wh.workspace_id = w.id
    WHERE wh.id = ? AND w.user_id = ?
  `).get(req.params.id, req.user.id);

  if (!webhook) {
    return res.status(404).json({ error: 'Webhook not found' });
  }

  db.prepare('DELETE FROM webhooks WHERE id = ?').run(req.params.id);

  res.json({ success: true, message: 'Webhook deleted' });
});

// Toggle webhook active status
app.patch('/api/v1/webhooks/:id', authenticate, (req, res) => {
  const webhook = db.prepare(`
    SELECT wh.* FROM webhooks wh
    JOIN workspaces w ON wh.workspace_id = w.id
    WHERE wh.id = ? AND w.user_id = ?
  `).get(req.params.id, req.user.id);

  if (!webhook) {
    return res.status(404).json({ error: 'Webhook not found' });
  }

  const { active } = req.body;

  if (active !== undefined) {
    db.prepare('UPDATE webhooks SET active = ? WHERE id = ?')
      .run(active ? 1 : 0, req.params.id);
  }

  const updated = db.prepare('SELECT id, url, events, active, created_at FROM webhooks WHERE id = ?')
    .get(req.params.id);

  res.json({
    ...updated,
    events: JSON.parse(updated.events),
    active: Boolean(updated.active)
  });
});

// ============================================
// HEALTH & INFO
// ============================================

app.get('/api/v1/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

app.get('/api/v1', (req, res) => {
  res.json({
    name: 'Headless Todo API',
    version: '1.0.0',
    documentation: 'https://docs.headless-todo.dev',
    endpoints: {
      auth: {
        'POST /api/v1/auth/register': 'Register new user'
      },
      workspaces: {
        'GET /api/v1/workspaces': 'List workspaces',
        'POST /api/v1/workspaces': 'Create workspace',
        'GET /api/v1/workspaces/:id': 'Get workspace',
        'DELETE /api/v1/workspaces/:id': 'Delete workspace'
      },
      todos: {
        'GET /api/v1/workspaces/:id/todos': 'List todos (supports ?completed, ?priority, ?tag filters)',
        'POST /api/v1/workspaces/:id/todos': 'Create todo',
        'GET /api/v1/todos/:id': 'Get todo',
        'PATCH /api/v1/todos/:id': 'Update todo',
        'DELETE /api/v1/todos/:id': 'Delete todo'
      },
      webhooks: {
        'GET /api/v1/workspaces/:id/webhooks': 'List webhooks',
        'POST /api/v1/workspaces/:id/webhooks': 'Create webhook',
        'PATCH /api/v1/webhooks/:id': 'Toggle webhook',
        'DELETE /api/v1/webhooks/:id': 'Delete webhook'
      }
    }
  });
});

// ============================================
// START SERVER
// ============================================

app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   🚀 Headless Todo API running on http://localhost:${PORT}   ║
║                                                           ║
║   Endpoints:                                              ║
║   • GET  /api/v1           - API info                     ║
║   • POST /api/v1/auth/register - Create account           ║
║   • GET  /api/v1/health    - Health check                 ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
  `);
});

module.exports = app;
