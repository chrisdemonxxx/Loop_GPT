import { useState } from 'react';
import { Button } from './components/ui/button';

/** Starter screen — replace with the app the user asked for. */
export function App(): JSX.Element {
  const [count, setCount] = useState(0);

  return (
    <main className="mx-auto max-w-3xl px-5 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">It works</h1>
      <p className="mt-2 text-sm opacity-80">
        Replace this component with the app that was asked for.
      </p>
      <div className="mt-6">
        <Button type="button" onClick={() => setCount((n) => n + 1)}>
          clicked {count} times
        </Button>
      </div>
    </main>
  );
}
