import { buildApp } from './app.js';

const port = Number(process.env.PORT ?? 3100);
const host = process.env.HOST ?? '0.0.0.0';

const { app } = await buildApp();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.log.info(`${signal} received, shutting down`);
    void app.close().then(() => process.exit(0));
  });
}

try {
  await app.listen({ port, host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
