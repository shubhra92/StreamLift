import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

const connectionString = process.env.DATABASE_URL!;

// The schema uses `timestamp without time zone` while the app writes JS Dates
// as UTC ISO strings. postgres.js normally parses a timezone-less timestamp
// with `new Date(raw)`, which interprets it in the host's local timezone; on a
// non-UTC host (e.g. IST) every Date read back shifts by the UTC offset, making
// live workers look hours stale and breaking heartbeat/expiry comparisons.
// Pin the session to UTC and parse OID 1114 (timestamp without time zone) as
// UTC. timestamptz (OID 1184) keeps its own offset and is unaffected.
const queryClient = postgres(connectionString, {
  connection: { TimeZone: "UTC" },
  // Supabase's transaction pooler (port 6543) can invalidate named prepared
  // statements between transactions. postgres.js then retries the COMMIT on a
  // fresh connection after the server has already rolled the transaction back,
  // which silently loses writes. Use unnamed/simple queries instead.
  prepare: false,
  types: {
    timestampUtc: {
      to: 1114,
      from: [1114],
      serialize: (value: Date | string) =>
        (value instanceof Date ? value : new Date(value)).toISOString(),
      parse: (raw: string) => new Date(`${raw.replace(" ", "T")}Z`),
    },
  },
});
export const db = drizzle(queryClient, { schema });

export * from './schema';
