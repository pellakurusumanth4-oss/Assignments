import { app } from './app.ts';
import { DB } from './database/DB.ts';

await DB.migrate();

const port = Number(process.env.PORT ?? 3000);

const server = app.listen(port, (error) => {
  // Express 5 reports listen failures (e.g. EADDRINUSE) here instead of throwing them.
  if (error) throw error;
  console.log(`Ledger API listening on http://localhost:${port}/api (docs: http://localhost:${port}/api/docs)`);
});

// `docker stop` sends SIGTERM: stop accepting connections, let in-flight requests finish, then close the pool.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => server.close(() => void DB.end()));
}
