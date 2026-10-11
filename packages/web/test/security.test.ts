import { describe, expect, it } from 'vitest';
import { admit, cookieName, sessionCookie, type RequestFacts } from '../src/security.js';

const gate = { port: 4321, token: 'the-token' };
const own = '127.0.0.1:4321';
const request = (facts: Partial<RequestFacts>): RequestFacts => ({ method: 'GET', url: '/', host: own, origin: undefined, cookie: undefined, ...facts });
const cookie = `${cookieName(4321)}=the-token`;

describe('admit', () => {
  it('takes the token from the query once, and from the cookie after', () => {
    expect(admit(gate, request({ url: '/?token=the-token' }))).toEqual({ ok: true, fromQuery: true });
    expect(admit(gate, request({ cookie: `other=1; ${cookie}` }))).toEqual({ ok: true, fromQuery: false });
    expect(admit(gate, request({ host: 'localhost:4321', cookie }))).toEqual({ ok: true, fromQuery: false });
  });

  it('refuses a request without the token, with a wrong one, or with another server’s cookie', () => {
    expect(admit(gate, request({}))).toMatchObject({ ok: false, status: 401 });
    expect(admit(gate, request({ url: '/?token=the-tokeN' }))).toMatchObject({ ok: false, status: 401 });
    expect(admit(gate, request({ url: '/?token=the-token-and-more' }))).toMatchObject({ ok: false, status: 401 });
    expect(admit(gate, request({ cookie: `${cookieName(4322)}=the-token` }))).toMatchObject({ ok: false, status: 401 });
  });

  it('refuses a request addressed to another host, as a DNS-rebinding page sends it, token or not', () => {
    for (const host of ['evil.example:4321', '127.0.0.1:4322', '127.0.0.1', '0.0.0.0:4321', undefined]) {
      expect(admit(gate, request({ host, url: '/?token=the-token', cookie })), String(host)).toEqual({ ok: false, status: 403, reason: 'host' });
    }
  });

  it('refuses a POST from any page but this server’s own, even with the cookie', () => {
    for (const origin of ['http://evil.example', 'null', 'http://127.0.0.1:4322', 'https://127.0.0.1:4321', undefined]) {
      expect(admit(gate, request({ method: 'POST', url: '/message', origin, cookie })), String(origin)).toEqual({ ok: false, status: 403, reason: 'origin' });
    }
    expect(admit(gate, request({ method: 'POST', url: '/message', origin: `http://${own}`, cookie }))).toEqual({ ok: true, fromQuery: false });
  });

  it('sets a cookie scripts cannot read and other sites never send', () => {
    expect(sessionCookie(gate)).toBe(`${cookieName(4321)}=the-token; HttpOnly; SameSite=Strict; Path=/`);
  });
});
