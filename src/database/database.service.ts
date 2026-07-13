import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";

export type SqlExecutor = Pool | PoolClient;

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private readonly pool: Pool;

  constructor(configService: ConfigService) {
    this.pool = new Pool({
      connectionString: configService.getOrThrow<string>("DATABASE_URL"),
      ssl: {
        rejectUnauthorized: false
      },
      // Fail fast when the DB is unreachable instead of queueing checkouts
      // forever, and recycle idle connections before the pooler's own idle
      // close can race a checkout.
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
      keepAlive: true,
      // Client-side per-query ceiling: a wedged statement rejects its promise
      // and frees the pool slot instead of pinning it forever. Generous —
      // nothing legitimate in the API runs anywhere near this long.
      query_timeout: 60_000
    });

    // A dropped IDLE connection (Supabase restart, pooler failover, network
    // blip) emits 'error' on the pool. Without a listener Node treats that as
    // an uncaught exception and kills the process; with one, the broken
    // client is discarded and the pool replaces it on the next checkout.
    this.pool.on("error", (err) => {
      this.logger.warn(`Idle database connection errored (client recycled): ${err.message}`);
    });
  }

  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values: unknown[] = [],
    executor?: SqlExecutor
  ): Promise<QueryResult<T>> {
    return (executor ?? this.pool).query<T>(text, values);
  }

  async transaction<T>(
    handler: (client: PoolClient) => Promise<T>
  ): Promise<T> {
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      const result = await handler(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async ping(): Promise<void> {
    await this.query("SELECT 1");
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}
