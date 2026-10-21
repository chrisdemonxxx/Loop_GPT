import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { createApp } from './app.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const app = createApp(config, pool);

const server = app.listen(config.port, () => {
  console.warn(`api listening on port ${config.port}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => {
      void pool.end().then(() => process.exit(0));
    });
  });
}
