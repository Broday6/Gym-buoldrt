import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteEngine } from './engine/sqlite.js';
import { TypesenseEngine } from './engine/typesense.js';
import type { SearchEngine } from './engine/types.js';
import { SearchService } from './services/search.js';
import { SiteRegistry } from './config/sites.js';
import { EventCollector } from './events/collector.js';
import { createPool, migrate, type Db } from './db/pool.js';
import { KeyStore } from './routes/auth.js';
import { registerRoutes } from './routes/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));

export interface AppOptions {
  databaseUrl?: string;
  enginePath?: string;
  /** Skip API-key checks. Set by COMPASS_DEV_OPEN for the demo storefront. */
  open?: boolean;
  logger?: boolean;
}

export interface BuiltApp {
  app: FastifyInstance;
  engine: SearchEngine;
  db: Db;
  collector: EventCollector;
  sites: SiteRegistry;
  search: SearchService;
}

/** Choose the retrieval core: Typesense when configured, SQLite otherwise. */
export function createEngine(options: AppOptions = {}): SearchEngine {
  if (process.env.TYPESENSE_HOST) {
    return new TypesenseEngine({
      host: process.env.TYPESENSE_HOST,
      port: Number(process.env.TYPESENSE_PORT ?? 8108),
      protocol: process.env.TYPESENSE_PROTOCOL ?? 'http',
      apiKey: process.env.TYPESENSE_API_KEY ?? '',
    });
  }
  return new SqliteEngine(options.enginePath ?? process.env.COMPASS_INDEX_PATH ?? './data/compass.db');
}

export async function buildApp(options: AppOptions = {}): Promise<BuiltApp> {
  const db = createPool(options.databaseUrl);
  await migrate(db);

  const engine = createEngine(options);
  const sites = SiteRegistry.load();
  const search = new SearchService(engine);
  const collector = new EventCollector(db);
  collector.start();

  const app = Fastify({
    logger: options.logger === false ? false : { level: process.env.LOG_LEVEL ?? 'info' },
    // Storefront search bodies are small; anything larger is a catalogue push.
    bodyLimit: 64 * 1024 * 1024,
  });

  await app.register(cors, { origin: true, methods: ['GET', 'POST', 'OPTIONS'] });

  const keyStore = new KeyStore(db);
  const open = options.open ?? process.env.COMPASS_DEV_OPEN === '1';
  await registerRoutes(app, { engine, search, sites, collector, db, auth: { keyStore, open } });

  // The demo storefront and the built SDK bundle, when present.
  const demoDir = resolve(HERE, '../../demo/public');
  if (existsSync(demoDir)) {
    await app.register(fastifyStatic, { root: demoDir, prefix: '/demo/' });
  }
  // The SDK ships as plain ES modules, so it is served straight from source.
  const sdkDir = resolve(HERE, '../../sdk/src');
  if (existsSync(sdkDir)) {
    await app.register(fastifyStatic, { root: sdkDir, prefix: '/sdk/', decorateReply: false });
  }

  app.addHook('onClose', async () => {
    await collector.stop();
    await engine.close();
    await db.end();
  });

  void join;
  return { app, engine, db, collector, sites, search };
}
