import { OAuthClient, Keyset } from "@atproto/oauth-client";
import { WebcryptoKey } from "@atproto/jwk-webcrypto";

export interface AtEnv {
  DB: D1Database;
  ATPROTO_CLIENT_JWK?: string;
}

const STATE_TTL_MS = 10 * 60_000;
const SESSION_TTL_MS = 60 * 60_000;

// Short-lived PKCE/state records, read back on the callback.
export function stateStore(db: D1Database) {
  return {
    async get(key: string) {
      const row = await db
        .prepare("SELECT data FROM oauth_state WHERE key = ? AND expires_at > ?")
        .bind(key, Date.now())
        .first<{ data: string }>();
      return row ? JSON.parse(row.data) : undefined;
    },
    async set(key: string, value: unknown) {
      await db
        .prepare("INSERT OR REPLACE INTO oauth_state (key, data, expires_at) VALUES (?, ?, ?)")
        .bind(key, JSON.stringify(value), Date.now() + STATE_TTL_MS)
        .run();
    },
    async del(key: string) {
      await db.prepare("DELETE FROM oauth_state WHERE key = ?").bind(key).run();
    },
  };
}

// Token session, held only until the callback has read the DID, then deleted.
export function sessionStore(db: D1Database) {
  return {
    async get(key: string) {
      const row = await db
        .prepare("SELECT data FROM atp_sessions WHERE key = ? AND expires_at > ?")
        .bind(key, Date.now())
        .first<{ data: string }>();
      return row ? JSON.parse(row.data) : undefined;
    },
    async set(key: string, value: unknown) {
      await db
        .prepare("INSERT OR REPLACE INTO atp_sessions (key, data, expires_at) VALUES (?, ?, ?)")
        .bind(key, JSON.stringify(value), Date.now() + SESSION_TTL_MS)
        .run();
    },
    async del(key: string) {
      await db.prepare("DELETE FROM atp_sessions WHERE key = ?").bind(key).run();
    },
  };
}

// WebCrypto-backed runtime for DPoP keys, nonces, and PKCE.
export function runtime() {
  return {
    createKey: (algs: string[]) => WebcryptoKey.generate(algs),
    getRandomValues: (length: number) => crypto.getRandomValues(new Uint8Array(length)),
    digest: async (bytes: Uint8Array, algorithm: { name: string }) => {
      const name = algorithm.name === "sha256" ? "SHA-256" : algorithm.name;
      return new Uint8Array(await crypto.subtle.digest(name, bytes));
    },
  };
}

export async function makeClient(env: AtEnv, origin: string, clientMetadata: object) {
  if (!env.ATPROTO_CLIENT_JWK) throw new Error("ATPROTO_CLIENT_JWK is not set");
  const key = await WebcryptoKey.fromJWK(JSON.parse(env.ATPROTO_CLIENT_JWK));
  return new OAuthClient({
    responseMode: "query",
    clientMetadata: clientMetadata as any,
    keyset: new Keyset([key]),
    stateStore: stateStore(env.DB),
    sessionStore: sessionStore(env.DB),
    runtimeImplementation: runtime() as any,
  });
}