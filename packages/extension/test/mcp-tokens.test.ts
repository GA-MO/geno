import { afterEach, describe, expect, it } from 'vitest';
import { fakeOAuth, type FakeOAuth } from '../../engine/test/fake-oauth.js';
import { McpTokenStore, type Secrets, type SignInBrowser } from '../src/chat/mcp-tokens.js';

/** SecretStorage as a map, so a test can see everything that was kept. */
function fakeSecrets(): Secrets & { readonly entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    get: async (key) => entries.get(key),
    store: async (key, value) => void entries.set(key, value),
    delete: async (key) => void entries.delete(key),
  };
}

const REDIRECT = 'http://127.0.0.1:1/callback';

/** The user's browser, which says yes: it opens the page and reads where the server sends it back. */
const approvingBrowser = (opened: URL[] = []): SignInBrowser => ({
  redirectUrl: REDIRECT,
  async authorize(url) {
    opened.push(url);
    const response = await fetch(url, { redirect: 'manual' });
    const location = response.headers.get('location');
    if (location === null) throw new Error(`the page answered ${response.status}: ${await response.text()}`);
    return new URL(location).searchParams;
  },
});

const oauths: FakeOAuth[] = [];
afterEach(async () => {
  await Promise.all(oauths.splice(0).map((oauth) => oauth.close()));
});

async function setUp(expiresIn?: number) {
  const oauth = await fakeOAuth(expiresIn === undefined ? {} : { expiresIn });
  oauths.push(oauth);
  let now = 1_000_000;
  const secrets = fakeSecrets();
  const store = new McpTokenStore(secrets, () => now);
  const server = { name: 'docs', url: oauth.mcpUrl };
  const later = (ms: number) => void (now += ms);
  /** The access token works on the fake MCP server: what the engine would see. */
  const works = async (token: string | undefined) =>
    token !== undefined && (await fetch(oauth.mcpUrl, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' })).status !== 401;
  return { oauth, secrets, store, server, later, works };
}

describe('the MCP token store', () => {
  it('has no token before sign-in', async () => {
    const { store, server, secrets } = await setUp();
    expect(await store.isSignedIn(server)).toBe(false);
    expect(await store.accessToken(server, false)).toBeUndefined();
    expect(await store.accessToken(server, true)).toBeUndefined();
    expect(secrets.entries.size).toBe(0);
  });

  it('signs in through the 401, the metadata, client registration and PKCE, and keeps the tokens only in SecretStorage', async () => {
    const { store, server, secrets, oauth, works } = await setUp();
    const opened: URL[] = [];
    await store.signIn(server, approvingBrowser(opened));
    expect(oauth.log.filter((entry) => !entry.startsWith('mcp:'))).toEqual(['register', 'authorize', 'token:authorization_code']);
    expect(opened).toHaveLength(1);
    expect(opened[0]!.origin).toBe(oauth.issuer);
    expect(opened[0]!.searchParams.get('code_challenge_method')).toBe('S256');
    expect(opened[0]!.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(opened[0]!.searchParams.get('resource')).toBe(oauth.mcpUrl);

    const token = await store.accessToken(server, false);
    expect(await works(token)).toBe(true);
    expect(await store.isSignedIn(server)).toBe(true);
    expect([...secrets.entries.keys()]).toEqual([`gcode.mcp.oauth:${JSON.stringify(['docs', oauth.mcpUrl])}`]);
    const kept = [...secrets.entries.values()].join('');
    expect(oauth.issued.every((issued) => kept.includes(issued)), 'both the access and the refresh token are kept').toBe(true);
  });

  it('keys a sign-in by name and address, so another server never gets its token', async () => {
    const { store, server } = await setUp();
    await store.signIn(server, approvingBrowser());
    expect(await store.accessToken({ name: 'docs', url: 'http://127.0.0.1:9/mcp' }, false)).toBeUndefined();
    expect(await store.accessToken({ name: 'other', url: server.url }, false)).toBeUndefined();
  });

  it('hands out the same token until it is about to expire, then refreshes it', async () => {
    const { store, server, oauth, later, works } = await setUp(600);
    await store.signIn(server, approvingBrowser());
    const first = await store.accessToken(server, false);
    later(60_000);
    expect(await store.accessToken(server, false), 'still fresh').toBe(first);
    later(500_000);
    const second = await store.accessToken(server, false);
    expect(second).not.toBe(first);
    expect(await works(second)).toBe(true);
    expect(oauth.log.filter((entry) => entry === 'token:refresh_token')).toHaveLength(1);
  });

  it('refreshes a token the server refused, once for asks that come together', async () => {
    const { store, server, oauth, works } = await setUp();
    await store.signIn(server, approvingBrowser());
    const first = await store.accessToken(server, false);
    oauth.expireAccess();
    expect(await works(first)).toBe(false);
    const [a, b] = await Promise.all([store.accessToken(server, true), store.accessToken(server, true)]);
    expect(a).toBe(b);
    expect(await works(a)).toBe(true);
    expect(oauth.log.filter((entry) => entry === 'token:refresh_token')).toHaveLength(1);
  });

  it('ends the sign-in when the server refuses the refresh token', async () => {
    const { store, server, oauth, secrets } = await setUp();
    await store.signIn(server, approvingBrowser());
    oauth.revokeAll();
    expect(await store.accessToken(server, true)).toBeUndefined();
    expect(await store.isSignedIn(server)).toBe(false);
    expect(secrets.entries.size).toBe(0);
  });

  it('keeps the sign-in when the server cannot be reached for a refresh', async () => {
    const { store, server, oauth } = await setUp();
    await store.signIn(server, approvingBrowser());
    await oauth.close();
    oauths.splice(0);
    expect(await store.accessToken(server, true)).toBeUndefined();
    expect(await store.isSignedIn(server)).toBe(true);
  });

  it('signs out by forgetting everything it kept', async () => {
    const { store, server, secrets } = await setUp();
    await store.signIn(server, approvingBrowser());
    await store.signOut(server);
    expect(secrets.entries.size).toBe(0);
    expect(await store.accessToken(server, false)).toBeUndefined();
  });

  it('refuses a sign-in that comes back for another request, and keeps no token', async () => {
    const { store, server, secrets } = await setUp();
    const browser = approvingBrowser();
    const forged: SignInBrowser = {
      redirectUrl: browser.redirectUrl,
      async authorize(url) {
        const back = await browser.authorize(url);
        back.set('state', 'forged');
        return back;
      },
    };
    await expect(store.signIn(server, forged)).rejects.toThrow('the sign-in came back for another request');
    expect(secrets.entries.size).toBe(0);
  });

  it('reuses the registered client for the same redirect, and registers again for another', async () => {
    const { store, server, oauth } = await setUp();
    await store.signIn(server, approvingBrowser());
    await store.signIn(server, approvingBrowser());
    expect(oauth.log.filter((entry) => entry === 'register')).toHaveLength(1);
    const elsewhere = approvingBrowser();
    await store.signIn(server, { redirectUrl: 'http://127.0.0.1:2/callback', authorize: elsewhere.authorize });
    expect(oauth.log.filter((entry) => entry === 'register')).toHaveLength(2);
  });
});
