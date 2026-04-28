declare module "sql.js" {
  export interface QueryExecResult {
    columns: string[];
    values: Array<Array<string | number | Uint8Array | null>>;
  }

  export interface Database {
    run(sql: string, params?: Array<string | number | null>): void;
    exec(sql: string, params?: Array<string | number | null>): QueryExecResult[];
  }

  export interface SqlJsStatic {
    Database: new () => Database;
  }

  export default function initSqlJs(): Promise<SqlJsStatic>;
}
