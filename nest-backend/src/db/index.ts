import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

function createDb() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL environment variable is not set');
  }
  const queryClient = postgres(connectionString);
  return drizzle(queryClient, { schema });
}

// Lazy singleton — only throws when first actually used, not at import time
let _db: ReturnType<typeof createDb> | null = null;

export const db = new Proxy({} as ReturnType<typeof createDb>, {
  get(_target, prop) {
    if (!_db) _db = createDb();
    return (_db as any)[prop];
  },
});

export * from './schema.js';
