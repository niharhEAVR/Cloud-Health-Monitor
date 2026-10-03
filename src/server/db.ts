import "server-only";

import { Pool, type PoolClient, type QueryResultRow } from "pg";

import { parseServerEnv } from "@/server/env";

let pool: Pool | undefined;

export function getPool(): Pool {
  if (pool !== undefined) {
    return pool;
  }

  const env = parseServerEnv();
  pool = new Pool({
    connectionString: env.DATABASE_URL,
    connectionTimeoutMillis: env.DATABASE_CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: 30_000,
    max: env.DATABASE_POOL_MAX,
    // Apply timeouts as connection settings before application queries run.
    options: `-c statement_timeout=${env.DATABASE_STATEMENT_TIMEOUT_MS} -c lock_timeout=5000`,
  });
  pool.on("error", (error) => {
    // Keep process-level failure handling in the runtime entrypoint. Listening
    // here prevents an idle-client error from becoming an unhandled event.
    console.error("Unexpected PostgreSQL idle client error", { message: error.message });
  });

  return pool;
}

export async function withTransaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const value = await callback(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function queryOne<T extends QueryResultRow>(
  client: Pick<PoolClient, "query">,
  text: string,
  values: unknown[] = [],
): Promise<T | null> {
  const result = await client.query<T>(text, values);
  return result.rows[0] ?? null;
}

export async function closePool(): Promise<void> {
  if (pool === undefined) {
    return;
  }
  const activePool = pool;
  pool = undefined;
  await activePool.end();
}
