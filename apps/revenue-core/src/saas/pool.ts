import { Pool, type PoolClient, type PoolConfig } from "pg";
import { saasEnabled, tenantContext } from "./context";

/** Every checkout is initialized, including requests without a tenant. Reset before reuse. */
export function tenantPool(options: PoolConfig): Pool {
  const pool = new Pool(options);
  const checkout = pool.connect.bind(pool);
  const connect = async (): Promise<PoolClient> => {
    const client = await checkout();
    const release = client.release.bind(client);
    if (!saasEnabled()) return client;
    const tenant = tenantContext.getStore();
    try {
      await client.query(
        "SELECT set_config('app.workspace_id',$1,false),set_config('app.account_id',$2,false)",
        [tenant?.workspaceId || "", tenant ? String(tenant.accountId) : ""],
      );
    } catch (error) {
      release(true);
      throw error;
    }
    let released = false;
    client.release = (error?: Error | boolean) => {
      if (released) return;
      released = true;
      if (error) {
        release(error);
        return;
      }
      // ROLLBACK also clears accidentally abandoned transactions before resetting context.
      void client
        .query("ROLLBACK; RESET app.workspace_id; RESET app.account_id")
        .then(
          () => release(),
          () => release(true),
        );
    };
    return client;
  };
  return new Proxy(pool, {
    get(target, property) {
      if (property === "connect") return connect;
      if (property === "query")
        return async (...args: any[]) => {
          const client = await connect();
          try {
            return await (client.query as any)(...args);
          } finally {
            client.release();
          }
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
