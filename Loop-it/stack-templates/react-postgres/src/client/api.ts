import { config } from './config.js';

// The client sends the bearer token it obtained from the auth service; it holds
// no secrets of its own. The token is the only credential the browser carries.

export interface Task {
  id: string;
  title: string;
  done: boolean;
  created_at: string;
  updated_at: string;
}

async function request<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${config.apiBaseUrl}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...init.headers,
    },
  });
  if (!response.ok) {
    throw new Error(`request failed: ${response.status}`);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export function listTasks(token: string): Promise<{ tasks: Task[] }> {
  return request('/api/tasks', token);
}

export function createTask(token: string, title: string): Promise<{ task: Task }> {
  return request('/api/tasks', token, {
    method: 'POST',
    body: JSON.stringify({ title }),
  });
}

export function updateTask(
  token: string,
  id: string,
  patch: { title?: string; done?: boolean },
): Promise<{ task: Task }> {
  return request(`/api/tasks/${id}`, token, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export function deleteTask(token: string, id: string): Promise<void> {
  return request(`/api/tasks/${id}`, token, { method: 'DELETE' });
}
