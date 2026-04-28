import { readFile } from "node:fs/promises";
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";

type BindValue = string | number | null;

export interface TestD1 {
  prepare(sql: string): TestStatement;
  exec(sql: string): Promise<void>;
}

export class TestStatement {
  private params: BindValue[] = [];

  constructor(private readonly db: Database, private readonly sql: string) {}

  bind(...params: BindValue[]): TestStatement {
    this.params = params.map((param) => param ?? null);
    return this;
  }

  async run(): Promise<{ success: boolean }> {
    this.db.run(this.sql, this.params);
    return { success: true };
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const rows = await this.all<T>();
    return (rows.results[0] as T | undefined) ?? null;
  }

  async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
    const result = this.db.exec(this.sql, this.params);
    if (result.length === 0) return { results: [] };
    const table = result[0]!;
    return {
      results: table.values.map((row) =>
        Object.fromEntries(table.columns.map((column, index) => [column, row[index] ?? null]))
      ) as T[]
    };
  }
}

export async function createTestDb(): Promise<TestD1> {
  const SQL: SqlJsStatic = await initSqlJs();
  const db = new SQL.Database();
  const schema = await readFile("src/db/schema.sql", "utf8");
  db.run(schema);
  return {
    prepare(sql: string) {
      return new TestStatement(db, sql);
    },
    async exec(sql: string) {
      db.run(sql);
    }
  };
}
