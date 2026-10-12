import { randomBytes, timingSafeEqual } from 'node:crypto';

/** What every request must prove: it came to this server by its own address, and carries the token printed at start. */
export type Gate = { readonly port: number; readonly token: string };

export type RequestFacts = {
  readonly method: string;
  readonly url: string;
  readonly host: string | undefined;
  readonly origin: string | undefined;
  readonly cookie: string | undefined;
};

/** `fromQuery`: the token came in the address, so the response sets the cookie and leaves the token out of the page's URL. */
export type Verdict = { readonly ok: true; readonly fromQuery: boolean } | { readonly ok: false; readonly status: 401 | 403; readonly reason: string };

export const newToken = (): string => randomBytes(24).toString('base64url');

/** Cookies are scoped by host, not port, so two servers on 127.0.0.1 each need their own name. */
export const cookieName = (port: number): string => `gcode_web_${port}`;

export const sessionCookie = (gate: Gate): string => `${cookieName(gate.port)}=${gate.token}; HttpOnly; SameSite=Strict; Path=/`;

const allowedHosts = (port: number): readonly string[] => [`127.0.0.1:${port}`, `localhost:${port}`];

const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const cookieValue = (header: string | undefined, name: string): string | undefined =>
  header
    ?.split(';')
    .map((part) => part.trim().split('='))
    .find(([key]) => key === name)?.[1];

/**
 * Admits a request only by this server's own address, which a DNS-rebinding page cannot fake, with the token in the
 * cookie or the query. A request that changes anything must also come from a page of this server: a page elsewhere can
 * send a POST here, but its browser names its own origin.
 */
export function admit(gate: Gate, request: RequestFacts): Verdict {
  if (request.host === undefined || !allowedHosts(gate.port).includes(request.host)) return { ok: false, status: 403, reason: 'host' };
  if (request.method !== 'GET' && request.method !== 'HEAD' && request.origin !== `http://${request.host}`) return { ok: false, status: 403, reason: 'origin' };
  const cookie = cookieValue(request.cookie, cookieName(gate.port));
  if (cookie !== undefined && same(cookie, gate.token)) return { ok: true, fromQuery: false };
  const query = new URL(request.url, 'http://localhost').searchParams.get('token');
  if (query !== null && same(query, gate.token)) return { ok: true, fromQuery: true };
  return { ok: false, status: 401, reason: 'token' };
}
