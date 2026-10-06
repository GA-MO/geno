import { describe, expect, it } from 'vitest';
import { REDACTED, redactSecrets } from '../src/redact.js';

// Every value here is made up. They have the shape of real secrets, so the rules match them.
const OPENAI = `sk-proj-${'Fake0'.repeat(8)}`;
const ANTHROPIC = `sk-ant-api03-${'fAkE1'.repeat(10)}`;
const GITHUB = `ghp_${'F4ke'.repeat(9)}`;
const GITHUB_FINE = `github_pat_11${'FAKE0'.repeat(5)}_${'fake9'.repeat(6)}`;
const AWS_ID = 'AKIAIOSFODNN7EXAMPLE';
const SLACK = 'xoxb-1234567890-fakefakefake';
const GOOGLE = `AIza${'Fake_-0'.repeat(5)}`;
const STRIPE = `sk_test_${'F4ke'.repeat(6)}`;
const NPM = `npm_${'Fake0'.repeat(7)}X`;
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlLXVzZXIifQ.ZmFrZS1zaWduYXR1cmUtMDAw';
const KEY_BODY = 'MIIEfakeFAKEfake0000\nAAAAfakefakefakefake\n';

describe('redactSecrets', () => {
  const cases: readonly [what: string, input: string, expected: string][] = [
    ['an OpenAI key', `OPENAI_KEY is ${OPENAI} here`, `OPENAI_KEY is ${REDACTED} here`],
    ['an Anthropic key', `using ${ANTHROPIC}`, `using ${REDACTED}`],
    ['a GitHub token', `remote: ${GITHUB} rejected`, `remote: ${REDACTED} rejected`],
    ['a fine-grained GitHub token', `pat ${GITHUB_FINE}`, `pat ${REDACTED}`],
    ['an AWS access key ID', `aws id ${AWS_ID} in use`, `aws id ${REDACTED} in use`],
    ['a Slack token', `slack ${SLACK}`, `slack ${REDACTED}`],
    ['a Google API key', `maps ${GOOGLE}`, `maps ${REDACTED}`],
    ['a Stripe secret key', `stripe ${STRIPE}`, `stripe ${REDACTED}`],
    ['an npm token', `//registry.npmjs.org/:_authToken=${NPM}`, `//registry.npmjs.org/:_authToken=${REDACTED}`],
    ['a JSON web token', `cookie: ${JWT}`, `cookie: ${REDACTED}`],
    ['a bearer token', 'curl -H "Authorization: Bearer abc123def456ghi"', `curl -H "Authorization: Bearer ${REDACTED}"`],
    ['basic auth in a header', 'Authorization: Basic dXNlcjpmYWtlcGFzcw==', `Authorization: Basic ${REDACTED}`],
    ['a password in a URL', 'cloning https://sam:hunter2fake@git.example.com/repo.git', `cloning https://sam:${REDACTED}@git.example.com/repo.git`],
    ['a database URL', 'DATABASE_URL=postgres://app:p4ss-fake@localhost:5432/db', `DATABASE_URL=postgres://app:${REDACTED}@localhost:5432/db`],
    ['password=', 'mysql --user=root password=hunter2fake --host db', `mysql --user=root password=${REDACTED} --host db`],
    ['an exported token', 'export GITHUB_TOKEN=abcdef0123456789', `export GITHUB_TOKEN=${REDACTED}`],
    ['a quoted JSON secret', '{"client_secret": "fake value 42", "id": 7}', `{"client_secret": ${REDACTED}, "id": 7}`],
    ['a YAML api key', 'api_key: fakefake1234', `api_key: ${REDACTED}`],
    ['a token in a query string', 'GET /cb?access_token=fake123&state=ok', `GET /cb?access_token=${REDACTED}&state=ok`],
    ['a secret flag', 'deploy --api-key fakefake99 --region us', `deploy --api-key ${REDACTED} --region us`],
    ['a secret flag with =', 'login --password="fake pass"', `login --password=${REDACTED}`],
    [
      'a private key block',
      `before\n-----BEGIN RSA PRIVATE KEY-----\n${KEY_BODY}-----END RSA PRIVATE KEY-----\nafter`,
      `before\n-----BEGIN RSA PRIVATE KEY-----${REDACTED}-----END RSA PRIVATE KEY-----\nafter`,
    ],
    ['a private key block cut off at the end', `cat id\n-----BEGIN OPENSSH PRIVATE KEY-----\n${KEY_BODY}`, `cat id\n-----BEGIN OPENSSH PRIVATE KEY-----${REDACTED}-----END OPENSSH PRIVATE KEY-----`],
  ];

  it.each(cases)('replaces %s', (_what, input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
  });

  it.each(cases)('changes nothing more on a second pass over %s', (_what, input) => {
    const once = redactSecrets(input);
    expect(redactSecrets(once)).toBe(once);
  });

  it('leaves ordinary output alone', () => {
    const plain = [
      'Tests: 3 failed, 41 passed',
      'input tokens: 1200, max_tokens=4096',
      'Bearer authentication is configured',
      'Token generation took 12ms',
      'see https://nextjs.org/docs/app and http://localhost:3000/api',
      'error TS2304: Cannot find name "secretSauce".',
      'sk-short',
      'git log --author=sam',
      'src/auth/password-reset.ts:12:5',
    ].join('\n');
    expect(redactSecrets(plain)).toBe(plain);
  });

  it('replaces every secret on a line, not only the first', () => {
    expect(redactSecrets(`a=${OPENAI} b=${GITHUB} token=x1`)).toBe(`a=${REDACTED} b=${REDACTED} token=${REDACTED}`);
  });
});
