import React, { useState, useEffect } from 'react';

// Simulated API responses for demo
const generateId = () => Math.random().toString(36).substr(2, 9);
const generateApiKey = () => 'htd_' + Math.random().toString(36).substr(2, 32);

const initialWorkspaces = [
  { id: 'ws_1', name: 'Personal', createdAt: '2024-01-15' },
  { id: 'ws_2', name: 'Work Projects', createdAt: '2024-02-01' },
];

const initialTodos = [
  { id: 't_1', title: 'Design API schema', description: 'Define endpoints and data models', completed: true, priority: 'high', dueDate: '2024-02-10', tags: ['backend', 'planning'], workspaceId: 'ws_2' },
  { id: 't_2', title: 'Implement authentication', description: 'API key based auth with rate limiting', completed: false, priority: 'high', dueDate: '2024-02-15', tags: ['backend', 'security'], workspaceId: 'ws_2' },
  { id: 't_3', title: 'Build webhook system', description: 'Event-driven notifications', completed: false, priority: 'medium', dueDate: '2024-02-20', tags: ['backend'], workspaceId: 'ws_2' },
  { id: 't_4', title: 'Buy groceries', description: 'Milk, eggs, bread', completed: false, priority: 'low', dueDate: '2024-02-12', tags: ['errands'], workspaceId: 'ws_1' },
  { id: 't_5', title: 'Call dentist', description: 'Schedule annual checkup', completed: true, priority: 'medium', dueDate: '2024-02-08', tags: ['health'], workspaceId: 'ws_1' },
];

const initialWebhooks = [
  { id: 'wh_1', url: 'https://api.slack.com/hooks/abc123', events: ['todo.created', 'todo.completed'], workspaceId: 'ws_2', active: true },
];

export default function HeadlessTodoDemo() {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [workspaces, setWorkspaces] = useState(initialWorkspaces);
  const [activeWorkspace, setActiveWorkspace] = useState(initialWorkspaces[0]);
  const [todos, setTodos] = useState(initialTodos);
  const [webhooks, setWebhooks] = useState(initialWebhooks);
  const [apiKey] = useState(generateApiKey());
  const [showNewTodo, setShowNewTodo] = useState(false);
  const [showNewWebhook, setShowNewWebhook] = useState(false);
  const [filter, setFilter] = useState('all');
  const [apiLogs, setApiLogs] = useState([]);
  const [newTodo, setNewTodo] = useState({ title: '', description: '', priority: 'medium', dueDate: '', tags: '' });
  const [newWebhook, setNewWebhook] = useState({ url: '', events: [] });

  const logApiCall = (method, endpoint, body = null, response = null) => {
    setApiLogs(prev => [{
      id: generateId(),
      timestamp: new Date().toISOString(),
      method,
      endpoint,
      body,
      response,
      status: 200
    }, ...prev].slice(0, 20));
  };

  const workspaceTodos = todos.filter(t => t.workspaceId === activeWorkspace?.id);
  const filteredTodos = workspaceTodos.filter(t => {
    if (filter === 'active') return !t.completed;
    if (filter === 'completed') return t.completed;
    return true;
  });

  const handleCreateTodo = () => {
    const todo = {
      id: 't_' + generateId(),
      ...newTodo,
      tags: newTodo.tags.split(',').map(t => t.trim()).filter(Boolean),
      completed: false,
      workspaceId: activeWorkspace.id
    };
    setTodos([...todos, todo]);
    logApiCall('POST', `/api/v1/workspaces/${activeWorkspace.id}/todos`, newTodo, todo);
    setNewTodo({ title: '', description: '', priority: 'medium', dueDate: '', tags: '' });
    setShowNewTodo(false);
  };

  const handleToggleTodo = (todoId) => {
    setTodos(todos.map(t => {
      if (t.id === todoId) {
        const updated = { ...t, completed: !t.completed };
        logApiCall('PATCH', `/api/v1/todos/${todoId}`, { completed: updated.completed }, updated);
        return updated;
      }
      return t;
    }));
  };

  const handleDeleteTodo = (todoId) => {
    setTodos(todos.filter(t => t.id !== todoId));
    logApiCall('DELETE', `/api/v1/todos/${todoId}`, null, { success: true });
  };

  const handleCreateWebhook = () => {
    const webhook = {
      id: 'wh_' + generateId(),
      ...newWebhook,
      workspaceId: activeWorkspace.id,
      active: true
    };
    setWebhooks([...webhooks, webhook]);
    logApiCall('POST', `/api/v1/workspaces/${activeWorkspace.id}/webhooks`, newWebhook, webhook);
    setNewWebhook({ url: '', events: [] });
    setShowNewWebhook(false);
  };

  const priorityColors = {
    high: '#ef4444',
    medium: '#f59e0b',
    low: '#22c55e'
  };

  const webhookEvents = ['todo.created', 'todo.updated', 'todo.completed', 'todo.deleted'];

  return (
    <div style={{
      minHeight: '100vh',
      background: '#0a0a0b',
      color: '#e4e4e7',
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      fontSize: '13px'
    }}>
      {/* Header */}
      <header style={{
        borderBottom: '1px solid #27272a',
        padding: '16px 24px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        background: 'linear-gradient(180deg, #18181b 0%, #0a0a0b 100%)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{
            width: '32px',
            height: '32px',
            background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
            borderRadius: '8px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontWeight: 'bold',
            fontSize: '16px'
          }}>✓</div>
          <span style={{ fontWeight: '600', fontSize: '16px', letterSpacing: '-0.5px' }}>
            Headless Todo API
          </span>
          <span style={{
            background: '#27272a',
            padding: '2px 8px',
            borderRadius: '4px',
            fontSize: '10px',
            color: '#a1a1aa'
          }}>v1.0</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <div style={{
            background: '#18181b',
            border: '1px solid #27272a',
            borderRadius: '6px',
            padding: '8px 12px',
            display: 'flex',
            alignItems: 'center',
            gap: '8px'
          }}>
            <span style={{ color: '#71717a', fontSize: '11px' }}>API Key:</span>
            <code style={{ color: '#6366f1', fontSize: '11px' }}>{apiKey.slice(0, 20)}...</code>
            <button 
              onClick={() => navigator.clipboard?.writeText(apiKey)}
              style={{
                background: 'none',
                border: 'none',
                color: '#71717a',
                cursor: 'pointer',
                padding: '2px'
              }}
            >📋</button>
          </div>
        </div>
      </header>

      <div style={{ display: 'flex', minHeight: 'calc(100vh - 65px)' }}>
        {/* Sidebar */}
        <aside style={{
          width: '220px',
          borderRight: '1px solid #27272a',
          padding: '16px',
          background: '#0f0f10'
        }}>
          <nav style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {[
              { id: 'dashboard', label: 'Dashboard', icon: '◉' },
              { id: 'todos', label: 'Todos', icon: '☐' },
              { id: 'webhooks', label: 'Webhooks', icon: '⚡' },
              { id: 'playground', label: 'API Playground', icon: '▶' },
            ].map(item => (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  padding: '10px 12px',
                  background: activeTab === item.id ? '#27272a' : 'transparent',
                  border: 'none',
                  borderRadius: '6px',
                  color: activeTab === item.id ? '#fff' : '#a1a1aa',
                  cursor: 'pointer',
                  textAlign: 'left',
                  fontSize: '13px',
                  transition: 'all 0.15s'
                }}
              >
                <span style={{ opacity: 0.7 }}>{item.icon}</span>
                {item.label}
              </button>
            ))}
          </nav>

          <div style={{ marginTop: '24px', padding: '0 4px' }}>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: '8px'
            }}>
              <span style={{ color: '#71717a', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                Workspaces
              </span>
            </div>
            {workspaces.map(ws => (
              <button
                key={ws.id}
                onClick={() => setActiveWorkspace(ws)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '8px 10px',
                  width: '100%',
                  background: activeWorkspace?.id === ws.id ? 'rgba(99, 102, 241, 0.15)' : 'transparent',
                  border: activeWorkspace?.id === ws.id ? '1px solid rgba(99, 102, 241, 0.3)' : '1px solid transparent',
                  borderRadius: '6px',
                  color: activeWorkspace?.id === ws.id ? '#818cf8' : '#a1a1aa',
                  cursor: 'pointer',
                  textAlign: 'left',
                  fontSize: '12px',
                  marginBottom: '4px'
                }}
              >
                <span style={{
                  width: '8px',
                  height: '8px',
                  borderRadius: '2px',
                  background: activeWorkspace?.id === ws.id ? '#6366f1' : '#3f3f46'
                }} />
                {ws.name}
              </button>
            ))}
          </div>
        </aside>

        {/* Main Content */}
        <main style={{ flex: 1, padding: '24px', overflow: 'auto' }}>
          {activeTab === 'dashboard' && (
            <div>
              <h1 style={{ fontSize: '24px', fontWeight: '600', marginBottom: '8px', letterSpacing: '-0.5px' }}>
                Welcome to Headless Todo API
              </h1>
              <p style={{ color: '#71717a', marginBottom: '32px' }}>
                A developer-first todo backend. Build any frontend you want.
              </p>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px', marginBottom: '32px' }}>
                {[
                  { label: 'Total Todos', value: workspaceTodos.length, color: '#6366f1' },
                  { label: 'Completed', value: workspaceTodos.filter(t => t.completed).length, color: '#22c55e' },
                  { label: 'Active Webhooks', value: webhooks.filter(w => w.workspaceId === activeWorkspace?.id).length, color: '#f59e0b' },
                ].map(stat => (
                  <div key={stat.label} style={{
                    background: '#18181b',
                    border: '1px solid #27272a',
                    borderRadius: '12px',
                    padding: '20px'
                  }}>
                    <div style={{ color: '#71717a', fontSize: '12px', marginBottom: '8px' }}>{stat.label}</div>
                    <div style={{ fontSize: '32px', fontWeight: '700', color: stat.color }}>{stat.value}</div>
                  </div>
                ))}
              </div>

              <div style={{
                background: '#18181b',
                border: '1px solid #27272a',
                borderRadius: '12px',
                padding: '20px'
              }}>
                <h3 style={{ fontSize: '14px', fontWeight: '600', marginBottom: '16px' }}>Quick Start</h3>
                <pre style={{
                  background: '#0a0a0b',
                  padding: '16px',
                  borderRadius: '8px',
                  overflow: 'auto',
                  fontSize: '12px',
                  lineHeight: '1.6'
                }}>
{`# List todos in a workspace
curl -X GET https://api.headless-todo.dev/v1/workspaces/${activeWorkspace?.id}/todos \\
  -H "Authorization: Bearer ${apiKey}"

# Create a new todo
curl -X POST https://api.headless-todo.dev/v1/workspaces/${activeWorkspace?.id}/todos \\
  -H "Authorization: Bearer ${apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"title": "My task", "priority": "high"}'`}
                </pre>
              </div>
            </div>
          )}

          {activeTab === 'todos' && (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px' }}>
                <div>
                  <h1 style={{ fontSize: '20px', fontWeight: '600', letterSpacing: '-0.5px' }}>Todos</h1>
                  <p style={{ color: '#71717a', fontSize: '12px' }}>{activeWorkspace?.name} workspace</p>
                </div>
                <button
                  onClick={() => setShowNewTodo(true)}
                  style={{
                    background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
                    border: 'none',
                    borderRadius: '8px',
                    padding: '10px 16px',
                    color: '#fff',
                    cursor: 'pointer',
                    fontWeight: '500',
                    fontSize: '13px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px'
                  }}
                >
                  + New Todo
                </button>
              </div>

              <div style={{ display: 'flex', gap: '8px', marginBottom: '20px' }}>
                {['all', 'active', 'completed'].map(f => (
                  <button
                    key={f}
                    onClick={() => setFilter(f)}
                    style={{
                      padding: '6px 12px',
                      background: filter === f ? '#27272a' : 'transparent',
                      border: '1px solid #27272a',
                      borderRadius: '6px',
                      color: filter === f ? '#fff' : '#71717a',
                      cursor: 'pointer',
                      fontSize: '12px',
                      textTransform: 'capitalize'
                    }}
                  >
                    {f}
                  </button>
                ))}
              </div>

              {showNewTodo && (
                <div style={{
                  background: '#18181b',
                  border: '1px solid #27272a',
                  borderRadius: '12px',
                  padding: '20px',
                  marginBottom: '16px'
                }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                    <input
                      placeholder="Title"
                      value={newTodo.title}
                      onChange={e => setNewTodo({ ...newTodo, title: e.target.value })}
                      style={{
                        gridColumn: '1 / -1',
                        background: '#0a0a0b',
                        border: '1px solid #27272a',
                        borderRadius: '6px',
                        padding: '10px 12px',
                        color: '#fff',
                        fontSize: '13px'
                      }}
                    />
                    <input
                      placeholder="Description"
                      value={newTodo.description}
                      onChange={e => setNewTodo({ ...newTodo, description: e.target.value })}
                      style={{
                        gridColumn: '1 / -1',
                        background: '#0a0a0b',
                        border: '1px solid #27272a',
                        borderRadius: '6px',
                        padding: '10px 12px',
                        color: '#fff',
                        fontSize: '13px'
                      }}
                    />
                    <select
                      value={newTodo.priority}
                      onChange={e => setNewTodo({ ...newTodo, priority: e.target.value })}
                      style={{
                        background: '#0a0a0b',
                        border: '1px solid #27272a',
                        borderRadius: '6px',
                        padding: '10px 12px',
                        color: '#fff',
                        fontSize: '13px'
                      }}
                    >
                      <option value="low">Low Priority</option>
                      <option value="medium">Medium Priority</option>
                      <option value="high">High Priority</option>
                    </select>
                    <input
                      type="date"
                      value={newTodo.dueDate}
                      onChange={e => setNewTodo({ ...newTodo, dueDate: e.target.value })}
                      style={{
                        background: '#0a0a0b',
                        border: '1px solid #27272a',
                        borderRadius: '6px',
                        padding: '10px 12px',
                        color: '#fff',
                        fontSize: '13px'
                      }}
                    />
                    <input
                      placeholder="Tags (comma separated)"
                      value={newTodo.tags}
                      onChange={e => setNewTodo({ ...newTodo, tags: e.target.value })}
                      style={{
                        gridColumn: '1 / -1',
                        background: '#0a0a0b',
                        border: '1px solid #27272a',
                        borderRadius: '6px',
                        padding: '10px 12px',
                        color: '#fff',
                        fontSize: '13px'
                      }}
                    />
                  </div>
                  <div style={{ display: 'flex', gap: '8px', marginTop: '16px' }}>
                    <button
                      onClick={handleCreateTodo}
                      disabled={!newTodo.title}
                      style={{
                        background: '#6366f1',
                        border: 'none',
                        borderRadius: '6px',
                        padding: '8px 16px',
                        color: '#fff',
                        cursor: 'pointer',
                        fontSize: '12px'
                      }}
                    >
                      Create Todo
                    </button>
                    <button
                      onClick={() => setShowNewTodo(false)}
                      style={{
                        background: 'transparent',
                        border: '1px solid #27272a',
                        borderRadius: '6px',
                        padding: '8px 16px',
                        color: '#a1a1aa',
                        cursor: 'pointer',
                        fontSize: '12px'
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {filteredTodos.map(todo => (
                  <div
                    key={todo.id}
                    style={{
                      background: '#18181b',
                      border: '1px solid #27272a',
                      borderRadius: '10px',
                      padding: '16px',
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: '12px',
                      opacity: todo.completed ? 0.6 : 1
                    }}
                  >
                    <button
                      onClick={() => handleToggleTodo(todo.id)}
                      style={{
                        width: '20px',
                        height: '20px',
                        borderRadius: '6px',
                        border: todo.completed ? 'none' : '2px solid #3f3f46',
                        background: todo.completed ? '#6366f1' : 'transparent',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: '#fff',
                        fontSize: '12px',
                        flexShrink: 0,
                        marginTop: '2px'
                      }}
                    >
                      {todo.completed && '✓'}
                    </button>
                    <div style={{ flex: 1 }}>
                      <div style={{
                        fontWeight: '500',
                        marginBottom: '4px',
                        textDecoration: todo.completed ? 'line-through' : 'none'
                      }}>
                        {todo.title}
                      </div>
                      {todo.description && (
                        <div style={{ color: '#71717a', fontSize: '12px', marginBottom: '8px' }}>
                          {todo.description}
                        </div>
                      )}
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                        <span style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '4px',
                          padding: '2px 8px',
                          background: `${priorityColors[todo.priority]}20`,
                          color: priorityColors[todo.priority],
                          borderRadius: '4px',
                          fontSize: '10px',
                          textTransform: 'uppercase',
                          fontWeight: '600'
                        }}>
                          {todo.priority}
                        </span>
                        {todo.dueDate && (
                          <span style={{
                            padding: '2px 8px',
                            background: '#27272a',
                            borderRadius: '4px',
                            fontSize: '10px',
                            color: '#a1a1aa'
                          }}>
                            Due: {todo.dueDate}
                          </span>
                        )}
                        {todo.tags.map(tag => (
                          <span
                            key={tag}
                            style={{
                              padding: '2px 8px',
                              background: '#27272a',
                              borderRadius: '4px',
                              fontSize: '10px',
                              color: '#818cf8'
                            }}
                          >
                            #{tag}
                          </span>
                        ))}
                      </div>
                    </div>
                    <button
                      onClick={() => handleDeleteTodo(todo.id)}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: '#71717a',
                        cursor: 'pointer',
                        padding: '4px',
                        opacity: 0.5
                      }}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeTab === 'webhooks' && (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px' }}>
                <div>
                  <h1 style={{ fontSize: '20px', fontWeight: '600', letterSpacing: '-0.5px' }}>Webhooks</h1>
                  <p style={{ color: '#71717a', fontSize: '12px' }}>Get notified when events happen</p>
                </div>
                <button
                  onClick={() => setShowNewWebhook(true)}
                  style={{
                    background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
                    border: 'none',
                    borderRadius: '8px',
                    padding: '10px 16px',
                    color: '#fff',
                    cursor: 'pointer',
                    fontWeight: '500',
                    fontSize: '13px'
                  }}
                >
                  + New Webhook
                </button>
              </div>

              {showNewWebhook && (
                <div style={{
                  background: '#18181b',
                  border: '1px solid #27272a',
                  borderRadius: '12px',
                  padding: '20px',
                  marginBottom: '16px'
                }}>
                  <input
                    placeholder="Webhook URL (https://...)"
                    value={newWebhook.url}
                    onChange={e => setNewWebhook({ ...newWebhook, url: e.target.value })}
                    style={{
                      width: '100%',
                      background: '#0a0a0b',
                      border: '1px solid #27272a',
                      borderRadius: '6px',
                      padding: '10px 12px',
                      color: '#fff',
                      fontSize: '13px',
                      marginBottom: '12px',
                      boxSizing: 'border-box'
                    }}
                  />
                  <div style={{ marginBottom: '12px' }}>
                    <div style={{ color: '#71717a', fontSize: '11px', marginBottom: '8px' }}>Events to subscribe:</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                      {webhookEvents.map(event => (
                        <label
                          key={event}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '6px',
                            padding: '6px 10px',
                            background: newWebhook.events.includes(event) ? 'rgba(99, 102, 241, 0.2)' : '#27272a',
                            border: newWebhook.events.includes(event) ? '1px solid #6366f1' : '1px solid transparent',
                            borderRadius: '6px',
                            cursor: 'pointer',
                            fontSize: '12px'
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={newWebhook.events.includes(event)}
                            onChange={e => {
                              if (e.target.checked) {
                                setNewWebhook({ ...newWebhook, events: [...newWebhook.events, event] });
                              } else {
                                setNewWebhook({ ...newWebhook, events: newWebhook.events.filter(ev => ev !== event) });
                              }
                            }}
                            style={{ display: 'none' }}
                          />
                          <span style={{ color: newWebhook.events.includes(event) ? '#818cf8' : '#a1a1aa' }}>
                            {event}
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button
                      onClick={handleCreateWebhook}
                      disabled={!newWebhook.url || newWebhook.events.length === 0}
                      style={{
                        background: '#6366f1',
                        border: 'none',
                        borderRadius: '6px',
                        padding: '8px 16px',
                        color: '#fff',
                        cursor: 'pointer',
                        fontSize: '12px'
                      }}
                    >
                      Create Webhook
                    </button>
                    <button
                      onClick={() => setShowNewWebhook(false)}
                      style={{
                        background: 'transparent',
                        border: '1px solid #27272a',
                        borderRadius: '6px',
                        padding: '8px 16px',
                        color: '#a1a1aa',
                        cursor: 'pointer',
                        fontSize: '12px'
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {webhooks.filter(w => w.workspaceId === activeWorkspace?.id).map(webhook => (
                  <div
                    key={webhook.id}
                    style={{
                      background: '#18181b',
                      border: '1px solid #27272a',
                      borderRadius: '10px',
                      padding: '16px'
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                      <code style={{ color: '#818cf8', fontSize: '13px' }}>{webhook.url}</code>
                      <span style={{
                        padding: '2px 8px',
                        background: webhook.active ? 'rgba(34, 197, 94, 0.2)' : 'rgba(239, 68, 68, 0.2)',
                        color: webhook.active ? '#22c55e' : '#ef4444',
                        borderRadius: '4px',
                        fontSize: '10px',
                        textTransform: 'uppercase'
                      }}>
                        {webhook.active ? 'Active' : 'Inactive'}
                      </span>
                    </div>
                    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                      {webhook.events.map(event => (
                        <span
                          key={event}
                          style={{
                            padding: '2px 8px',
                            background: '#27272a',
                            borderRadius: '4px',
                            fontSize: '10px',
                            color: '#a1a1aa'
                          }}
                        >
                          {event}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeTab === 'playground' && (
            <div>
              <h1 style={{ fontSize: '20px', fontWeight: '600', marginBottom: '8px', letterSpacing: '-0.5px' }}>
                API Playground
              </h1>
              <p style={{ color: '#71717a', marginBottom: '24px', fontSize: '12px' }}>
                Every action in this UI triggers a simulated API call. Watch the logs below.
              </p>

              <div style={{
                background: '#18181b',
                border: '1px solid #27272a',
                borderRadius: '12px',
                overflow: 'hidden'
              }}>
                <div style={{
                  padding: '12px 16px',
                  borderBottom: '1px solid #27272a',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between'
                }}>
                  <span style={{ fontWeight: '500', fontSize: '13px' }}>Request Log</span>
                  <span style={{ color: '#71717a', fontSize: '11px' }}>{apiLogs.length} requests</span>
                </div>
                <div style={{ maxHeight: '500px', overflow: 'auto' }}>
                  {apiLogs.length === 0 ? (
                    <div style={{ padding: '40px', textAlign: 'center', color: '#71717a' }}>
                      <p style={{ marginBottom: '8px' }}>No API calls yet</p>
                      <p style={{ fontSize: '11px' }}>Try creating or completing a todo!</p>
                    </div>
                  ) : (
                    apiLogs.map(log => (
                      <div
                        key={log.id}
                        style={{
                          padding: '12px 16px',
                          borderBottom: '1px solid #1f1f23',
                          fontSize: '12px'
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                          <span style={{
                            padding: '2px 6px',
                            background: log.method === 'GET' ? '#22c55e20' : log.method === 'POST' ? '#6366f120' : log.method === 'PATCH' ? '#f59e0b20' : '#ef444420',
                            color: log.method === 'GET' ? '#22c55e' : log.method === 'POST' ? '#6366f1' : log.method === 'PATCH' ? '#f59e0b' : '#ef4444',
                            borderRadius: '4px',
                            fontSize: '10px',
                            fontWeight: '600'
                          }}>
                            {log.method}
                          </span>
                          <code style={{ color: '#e4e4e7' }}>{log.endpoint}</code>
                          <span style={{
                            marginLeft: 'auto',
                            padding: '2px 6px',
                            background: '#22c55e20',
                            color: '#22c55e',
                            borderRadius: '4px',
                            fontSize: '10px'
                          }}>
                            200 OK
                          </span>
                        </div>
                        {log.body && (
                          <pre style={{
                            background: '#0a0a0b',
                            padding: '8px',
                            borderRadius: '4px',
                            margin: '0',
                            fontSize: '10px',
                            color: '#a1a1aa',
                            overflow: 'auto'
                          }}>
                            {JSON.stringify(log.body, null, 2)}
                          </pre>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div style={{
                marginTop: '24px',
                background: '#18181b',
                border: '1px solid #27272a',
                borderRadius: '12px',
                padding: '20px'
              }}>
                <h3 style={{ fontSize: '14px', fontWeight: '600', marginBottom: '16px' }}>API Endpoints</h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {[
                    { method: 'GET', path: '/api/v1/workspaces', desc: 'List all workspaces' },
                    { method: 'POST', path: '/api/v1/workspaces', desc: 'Create workspace' },
                    { method: 'GET', path: '/api/v1/workspaces/:id/todos', desc: 'List todos' },
                    { method: 'POST', path: '/api/v1/workspaces/:id/todos', desc: 'Create todo' },
                    { method: 'PATCH', path: '/api/v1/todos/:id', desc: 'Update todo' },
                    { method: 'DELETE', path: '/api/v1/todos/:id', desc: 'Delete todo' },
                    { method: 'GET', path: '/api/v1/workspaces/:id/webhooks', desc: 'List webhooks' },
                    { method: 'POST', path: '/api/v1/workspaces/:id/webhooks', desc: 'Create webhook' },
                  ].map((endpoint, i) => (
                    <div
                      key={i}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '12px',
                        padding: '8px 12px',
                        background: '#0a0a0b',
                        borderRadius: '6px'
                      }}
                    >
                      <span style={{
                        padding: '2px 6px',
                        background: endpoint.method === 'GET' ? '#22c55e20' : endpoint.method === 'POST' ? '#6366f120' : endpoint.method === 'PATCH' ? '#f59e0b20' : '#ef444420',
                        color: endpoint.method === 'GET' ? '#22c55e' : endpoint.method === 'POST' ? '#6366f1' : endpoint.method === 'PATCH' ? '#f59e0b' : '#ef4444',
                        borderRadius: '4px',
                        fontSize: '10px',
                        fontWeight: '600',
                        minWidth: '50px',
                        textAlign: 'center'
                      }}>
                        {endpoint.method}
                      </span>
                      <code style={{ flex: 1, color: '#e4e4e7', fontSize: '12px' }}>{endpoint.path}</code>
                      <span style={{ color: '#71717a', fontSize: '11px' }}>{endpoint.desc}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
