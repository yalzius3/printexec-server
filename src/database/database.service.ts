import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";

export type SqlExecutor = Pool | PoolClient;

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly pool: Pool;

  constructor(configService: ConfigService) {
    this.pool = new Pool({
      connectionString: configService.getOrThrow<string>("DATABASE_URL"),
      ssl: {
        rejectUnauthorized: false
      }
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
