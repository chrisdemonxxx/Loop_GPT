import { useCallback, useEffect, useState } from 'react';
import { createTask, deleteTask, listTasks, updateTask } from './api.js';
import type { Task } from './api.js';

// A deliberately small example UI for the tasks feature. It reads the bearer
// token from wherever the host page stores it after the auth service issued it;
// this template does not implement the login screen itself.
function useToken(): string {
  return window.localStorage.getItem('access_token') ?? '';
}

export function App(): JSX.Element {
  const token = useToken();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { tasks: rows } = await listTasks(token);
      setTasks(rows);
    } catch {
      setError('could not load tasks');
    }
  }, [token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onCreate = async () => {
    if (title.trim() === '') {
      return;
    }
    await createTask(token, title);
    setTitle('');
    await refresh();
  };

  const onToggle = async (task: Task) => {
    await updateTask(token, task.id, { done: !task.done });
    await refresh();
  };

  const onDelete = async (task: Task) => {
    await deleteTask(token, task.id);
    await refresh();
  };

  return (
    <main>
      <h1>Tasks</h1>
      {error !== null ? <p role="alert">{error}</p> : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void onCreate();
        }}
      >
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="New task"
          aria-label="New task"
        />
        <button type="submit">Add</button>
      </form>
      <ul>
        {tasks.map((task) => (
          <li key={task.id}>
            <label>
              <input type="checkbox" checked={task.done} onChange={() => void onToggle(task)} />
              {task.title}
            </label>
            <button type="button" onClick={() => void onDelete(task)}>
              Delete
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}
