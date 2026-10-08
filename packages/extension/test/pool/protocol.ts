import { request } from 'node:http';

/**
 * A suite for a pooled VS Code window to run: its bundle, the folder it opens, the folder whose files become the
 * window's `User` files (settings.json, mcp.json), its extension host's env, and the file its console output goes to.
 */
export type Job = {
  readonly suite: string;
  readonly workspace: string;
  readonly user: string;
  readonly env: Readonly<Record<string, string>>;
  readonly log: string;
};

/** A window's extension host asking what to do: the folder it has open, and whether it has run a job yet. */
export type Hello = { readonly window: number; readonly folder: string | null; readonly fresh: boolean };

/** What the host does next. Every job runs in a fresh extension host, so a host that ran one only ever leaves. */
export type Order =
  | { readonly do: 'run'; readonly job: Job }
  | { readonly do: 'open'; readonly folder: string }
  | { readonly do: 'reload' }
  | { readonly do: 'quit' }
  | { readonly do: 'ignore' };

export type Done = { readonly window: number; readonly error?: { readonly message: string; readonly stack?: string } };

/** A window a test file holds until it ends: the port its CDP endpoint listens on, and its user data folder. */
export type Lease = { readonly id: number; readonly debugPort: number; readonly userData: string };

/**
 * POSTs `body` as JSON and returns the parsed reply. node:http, not fetch: a suite's run is one request that can
 * last many minutes, past undici's five-minute header timeout.
 */
export function post<T>(url: string, body: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (text += chunk));
      res.on('end', () => {
        if (res.statusCode !== 200) reject(new Error(`${url}: ${res.statusCode} ${text}`));
        else resolve((text === '' ? undefined : JSON.parse(text)) as T);
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}
