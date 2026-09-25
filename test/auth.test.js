'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createLinkClient,
  createPkcePair,
  createTokenStore,
  runLinkFlow,
} = require('../src/auth');

function fakeApp(dir) {
  return { getPath: () => dir, getVersion: () => '2.1.4' };
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'steeny-auth-'));
}

function jsonResponse(status, payload) {
  return { status, ok: status >= 200 && status < 300, json: async () => payload };
}

test('PKCE challenge is the S256 hash of the verifier', () => {
  const { verifier, challenge } = createPkcePair();
  const expected = crypto
    .createHash('sha256').update(verifier).digest().toString('base64url');

  assert.equal(challenge, expected);
  // RFC 7636 allows 43..128 characters; anything shorter weakens the binding.
  assert.ok(verifier.length >= 43 && verifier.length <= 128);
  assert.match(verifier, /^[A-Za-z0-9_-]+$/);
});

test('two flows never reuse a verifier', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) seen.add(createPkcePair().verifier);
  assert.equal(seen.size, 200);
});

test('token survives a round trip through the encrypted store', () => {
  const dir = tempDir();
  const store = createTokenStore({
    app: fakeApp(dir),
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: value => Buffer.from(`enc:${value}`),
      decryptString: buffer => buffer.toString().replace(/^enc:/, ''),
    },
  });

  store.write('token-123');
  assert.equal(store.read(), 'token-123');

  // The plaintext token must not be sitting in the file.
  const raw = fs.readFileSync(path.join(dir, 'session.json'), 'utf8');
  assert.ok(!raw.includes('token-123'));
  assert.match(raw, /"encrypted":true/);

  store.clear();
  assert.equal(store.read(), null);
});

test('token file is written with owner-only permissions', { skip: process.platform === 'win32' }, () => {
  const dir = tempDir();
  const store = createTokenStore({
    app: fakeApp(dir),
    safeStorage: { isEncryptionAvailable: () => false },
  });

  store.write('token-123');
  const mode = fs.statSync(path.join(dir, 'session.json')).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('an unreadable store asks for a fresh sign-in instead of throwing', () => {
  const dir = tempDir();
  const store = createTokenStore({
    app: fakeApp(dir),
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: value => Buffer.from(value),
      decryptString: () => { throw new Error('keyring reset'); },
    },
    logger: { warn: () => undefined },
  });

  store.write('token-123');
  assert.equal(store.read(), null);
});

test('a network failure is flagged offline so the caller keeps the token', async () => {
  const client = createLinkClient({
    origin: 'https://music.steeny.xyz',
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  });

  await assert.rejects(
    () => client.start('challenge'),
    error => error.offline === true,
  );
});

test('a rejected token is reported as unauthorized, not as an outage', async () => {
  const client = createLinkClient({
    origin: 'https://music.steeny.xyz',
    fetchImpl: async () => jsonResponse(401, { error: 'Unauthorized' }),
  });

  const result = await client.establishSession('stale-token');
  assert.equal(result.ok, false);
  assert.equal(result.unauthorized, true);
});

test('the flow opens the browser and returns the token once approved', async () => {
  const opened = [];
  const polls = ['pending', 'pending', 'approved'];
  const states = [];
  const client = {
    start: async challenge => {
      assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);
      return {
        device_code: 'd'.repeat(64),
        user_code: 'ABCD-2345',
        verification_url: 'https://music.steeny.xyz/link/abc',
        interval: 0,
        expires_in: 600,
      };
    },
    poll: async () => polls.shift(),
    exchange: async (deviceCode, verifier) => {
      assert.equal(deviceCode, 'd'.repeat(64));
      assert.ok(verifier.length >= 43);
      return { token: 'token-123', user: { id: 7, username: 'ivan' } };
    },
  };

  const result = await runLinkFlow({
    client,
    openBrowser: url => opened.push(url),
    onState: state => states.push(state.status),
  });

  assert.equal(result.status, 'authorized');
  assert.equal(result.token, 'token-123');
  assert.deepEqual(opened, ['https://music.steeny.xyz/link/abc']);
  assert.ok(states.includes('waiting'));
  assert.ok(states.includes('finishing'));
});

test('a denial in the browser ends the flow without a token', async () => {
  const client = {
    start: async () => ({
      device_code: 'd'.repeat(64),
      user_code: 'ABCD-2345',
      verification_url: 'https://music.steeny.xyz/link/abc',
      interval: 0,
      expires_in: 600,
    }),
    poll: async () => 'denied',
    exchange: async () => assert.fail('must not exchange a denied request'),
  };

  const result = await runLinkFlow({ client, openBrowser: () => undefined });
  assert.equal(result.status, 'denied');
});

test('a blip while polling does not abort a valid request', async () => {
  const polls = [
    () => { const e = new Error('offline'); e.offline = true; throw e; },
    () => 'approved',
  ];
  const client = {
    start: async () => ({
      device_code: 'd'.repeat(64),
      user_code: 'ABCD-2345',
      verification_url: 'https://music.steeny.xyz/link/abc',
      interval: 0,
      expires_in: 600,
    }),
    poll: async () => polls.shift()(),
    exchange: async () => ({ token: 'token-123', user: {} }),
  };

  const result = await runLinkFlow({ client, openBrowser: () => undefined });
  assert.equal(result.status, 'authorized');
});

test('cancelling stops the flow', async () => {
  const controller = new AbortController();
  const client = {
    start: async () => {
      controller.abort();
      return {
        device_code: 'd'.repeat(64),
        user_code: 'ABCD-2345',
        verification_url: 'https://music.steeny.xyz/link/abc',
        interval: 1,
        expires_in: 600,
      };
    },
    poll: async () => assert.fail('must not poll after cancellation'),
    exchange: async () => assert.fail('must not exchange after cancellation'),
  };

  const result = await runLinkFlow({
    client,
    openBrowser: () => undefined,
    signal: controller.signal,
  });
  assert.equal(result.status, 'cancelled');
});

test('the client never ships a password form of its own', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'assets', 'link.html'),
    'utf8',
  );
  assert.doesNotMatch(source, /type="password"/);
  assert.match(source, /Войти через браузер/);
});

test('signing out clears both the token and the cookie', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'main.js'),
    'utf8',
  );
  // A stale cookie would silently sign the user back in on the next launch.
  assert.match(source, /clearStorageData\(\{ storages: \['cookies'\] \}\)/);
  assert.match(source, /tokenStore\?\.clear\(\)/);
});
