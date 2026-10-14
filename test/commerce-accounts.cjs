const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { randomBytes, createCipheriv, createDecipheriv } = require('node:crypto');
const { AccountsStore, ACCOUNT_RESULT_CODES, normalizeIdentity } = require('../src/commerce-accounts.cjs');

function encryption() {
  const key = randomBytes(32);
  return {
    seal(value) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64'); },
    unseal(value) { const bytes = Buffer.from(value, 'base64'), decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'); }
  };
}
function fixture(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'isola-accounts-test-'));
  const profiles = [{ id: 'profile-1', status: 'closed' }, { id: 'profile-2', status: 'closed' }, { id: 'profile-3', status: 'closed' }];
  const changes = [], options = { dir, profiles: () => profiles, ...encryption(), onChange: value => changes.push(value), ...overrides };
  const store = new AccountsStore(options);
  t.after(() => { assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, options, profiles, changes };
}
function input(overrides = {}) { return { platform: 'vinted', label: 'My Vinted account', login: 'owner@example.test', password: 'Only-in-memory secret 123', profileId: 'profile-1', ...overrides }; }
function identity(memberId = '12345', overrides = {}) { return { verified: true, memberId, username: 'vinted-owner', profileURL: 'https://www.vinted.fr/member/' + memberId, ...overrides }; }
function rawStore(options, data) { return JSON.stringify({ format: 'isola-commerce-accounts', version: 1, encryptedData: options.seal(JSON.stringify(data)) }); }
function decodedStore(f) { const envelope = JSON.parse(fs.readFileSync(f.store.file, 'utf8')); return JSON.parse(f.options.unseal(envelope.encryptedData)); }

test('encrypted account persistence contains no plaintext credentials, login or metadata and reloads safely', async t => {
  const f = fixture(t), saved = f.store.save(input());
  assert.equal(saved.platform, 'vinted'); assert.equal(saved.hasPassword, true); assert.equal(saved.identity, null); assert.equal(saved.status, 'saved');
  const raw = fs.readFileSync(f.store.file, 'utf8');
  for (const secret of [input().password, input().login, input().label, input().profileId]) assert.equal(raw.includes(secret), false);
  assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ['encryptedData', 'format', 'version']);
  const restarted = new AccountsStore(f.options); assert.deepEqual(restarted.list(), [saved]);
  const result = await restarted.withCredentials(saved.id, credentials => { assert.equal(credentials.password, input().password); return 'safe service result'; });
  assert.equal(result, 'safe service result');
  const inside = decodedStore(f).accounts[0]; assert.equal(inside.password, undefined); assert.notEqual(inside.encryptedPassword, input().password);
});

test('DTOs and notifications contain only hasPassword and cannot mutate stored identity', async t => {
  const f = fixture(t), saved = f.store.save(input()); const verified = f.store.verify(saved.id, identity());
  for (const value of [f.store.list(), f.store.get(saved.id), f.store.findByProfile('profile-1'), f.changes]) {
    const raw = JSON.stringify(value); assert.equal(raw.includes(input().password), false); assert.equal(raw.includes('encryptedPassword'), false); assert.equal(raw.includes('"password"'), false);
  }
  verified.identity.memberId = '999'; verified.lastResult.message = 'edited';
  assert.equal(f.store.get(saved.id).identity.memberId, '12345'); assert.equal(f.store.get(saved.id).lastResult.message, ACCOUNT_RESULT_CODES.LOGIN_VERIFIED);
  assert.equal(f.store.findByProfile('missing'), null);
});

test('omitting a password preserves it, empty does not clear it, and clearing is explicit', async t => {
  const { store } = fixture(t); const saved = store.save(input());
  store.save({ id: saved.id, label: 'New label' });
  assert.equal(await store.withCredentials(saved.id, c => c.password === input().password), true);
  assert.throws(() => store.save({ id: saved.id, password: '' }), { code: 'ACCOUNT_INVALID' });
  assert.equal(store.get(saved.id).hasPassword, true);
  assert.throws(() => store.save({ id: saved.id, password: 'new', clearPassword: true }), { code: 'ACCOUNT_INVALID' });
  store.save({ id: saved.id, password: ' new password with spaces ' });
  assert.equal(await store.withCredentials(saved.id, c => c.password === ' new password with spaces '), true);
  store.save({ id: saved.id, clearPassword: true }); assert.equal(store.get(saved.id).hasPassword, false);
  await assert.rejects(store.withCredentials(saved.id, () => assert.fail('callback must not run')), { code: 'ACCOUNT_PASSWORD_REQUIRED' });
  assert.throws(() => store.save(input({ profileId: 'profile-2', login: 'no-password', password: undefined })), { code: 'ACCOUNT_INVALID' });
});

test('new accounts may omit the password and input validation never includes a submitted secret', t => {
  const { store } = fixture(t); const noPassword = input(); delete noPassword.password;
  assert.equal(store.save(noPassword).hasPassword, false);
  for (const update of [{ platform: 'other' }, { label: '' }, { label: 'x'.repeat(81) }, { login: 'bad login' }, { login: 'x'.repeat(255) }, { profileId: 'missing' }, { profileId: '../escape' }, { password: undefined }, { password: 'x'.repeat(1025) }, { password: 'secret\nline' }]) {
    assert.throws(() => store.save({ ...input({ login: 'other', profileId: 'profile-2' }), ...update }), error => !error.message.includes('secret\nline'));
  }
});

test('login case folding and profile binding enforce unique accounts before any disk change', t => {
  const f = fixture(t); f.store.save(input({ login: 'Owner@Example.test' })); const before = fs.readFileSync(f.store.file, 'utf8');
  assert.throws(() => f.store.save(input({ login: 'owner@example.TEST', profileId: 'profile-2' })), { code: 'ACCOUNT_CONFLICT' });
  assert.throws(() => f.store.save(input({ login: 'another', profileId: 'profile-1' })), { code: 'ACCOUNT_CONFLICT' });
  assert.equal(fs.readFileSync(f.store.file, 'utf8'), before); assert.equal(f.store.list().length, 1);
  const a = f.store.list()[0]; f.store.save({ id: a.id, login: 'OWNER@example.test' });
  assert.equal(f.store.get(a.id).login, 'OWNER@example.test');
});

test('verified members have canonical URLs and remain unique across environments', t => {
  const { store } = fixture(t); const a = store.save(input()), b = store.save(input({ login: 'another', profileId: 'profile-2' }));
  const verified = store.verify(a.id, identity('12345', { profileURL: 'https://www.vinted.fr/member/12345-owner' }));
  assert.equal(verified.identity.profileURL, 'https://www.vinted.fr/member/12345'); assert.equal(verified.status, 'logged_in'); assert.equal(verified.lastLoginAt, verified.identity.verifiedAt);
  assert.throws(() => store.verify(b.id, identity()), { code: 'ACCOUNT_CONFLICT' }); assert.equal(store.get(b.id).identity, null);
  assert.throws(() => store.verify(a.id, identity('54321')), { code: 'ACCOUNT_CHANGED' }); assert.equal(store.get(a.id).identity.memberId, '12345');
  store.verify(a.id, identity('12345', { username: 'renamed-owner' })); assert.equal(store.get(a.id).identity.username, 'renamed-owner');
});

test('only trusted verification can set identity and malformed member receipts fail closed', t => {
  const { store } = fixture(t); const a = store.save({ ...input(), identity: identity(), status: 'logged_in' });
  assert.equal(a.identity, null); assert.equal(a.status, 'saved');
  for (const observation of [identity('0'), identity('0123'), identity('123', { verified: false }), identity('123', { profileURL: 'https://evil.test/member/123' }), identity('123', { profileURL: 'https://www.vinted.fr/member/124' }), identity('123', { profileURL: 'https://www.vinted.fr/member/123?token=secret' }), identity('123', { username: 'bad\nname' })]) assert.throws(() => store.verify(a.id, observation));
  assert.throws(() => store.markResult(a.id, { status: 'logged_in' }), { code: 'IDENTITY_UNVERIFIED' }); assert.equal(store.get(a.id).identity, null);
  assert.equal(normalizeIdentity(identity('1')).profileURL, 'https://www.vinted.fr/member/1');
});

test('binding and removal require closed profiles while ordinary label/password changes remain possible', t => {
  const { store, profiles } = fixture(t); const a = store.save(input()); profiles[0].status = 'running'; profiles[0].running = true;
  assert.doesNotThrow(() => store.save({ id: a.id, label: 'Running account', password: 'replacement password' }));
  assert.throws(() => store.remove(a.id), { code: 'PROFILE_OPEN' }); assert.throws(() => store.save({ id: a.id, profileId: 'profile-2' }), { code: 'PROFILE_OPEN' });
  profiles[0].status = 'closed'; profiles[0].running = false; profiles[1].status = 'starting';
  assert.throws(() => store.save({ id: a.id, profileId: 'profile-2' }), { code: 'PROFILE_OPEN' }); profiles[1].status = 'closed';
  store.verify(a.id, identity()); store.save({ id: a.id, profileId: 'profile-2' }); assert.equal(store.get(a.id).identity, null); assert.equal(store.findByProfile('profile-1'), null);
  assert.equal(store.remove(a.id).removed, true); assert.equal(store.list().length, 0); assert.throws(() => store.get(a.id), { code: 'ACCOUNT_NOT_FOUND' });
});

test('business-history and busy guards receive safe DTOs, block changes and never leak their exception', t => {
  let blocked = false; const calls = []; const { store } = fixture(t, { assertMutable: context => { calls.push(context); if (blocked) throw Error(input().password); } });
  const a = store.save(input()); store.verify(a.id, identity()); blocked = true;
  for (const update of [{ profileId: 'profile-2' }, { login: 'new-login' }, { label: 'new-label' }]) assert.throws(() => store.save({ id: a.id, ...update }), error => error.code === 'ACCOUNT_CHANGE_BLOCKED' && !error.message.includes(input().password));
  assert.throws(() => store.remove(a.id), { code: 'ACCOUNT_CHANGE_BLOCKED' }); assert.equal(store.get(a.id).identity.memberId, '12345');
  assert.ok(calls.some(row => row.action === 'rebind')); assert.ok(calls.some(row => row.action === 'change-login')); assert.equal(JSON.stringify(calls).includes(input().password), false);
});

test('login results contain fixed safe messages, preserve identity and recover an interrupted login without submitting', t => {
  const f = fixture(t), a = f.store.save(input()); f.store.verify(a.id, identity());
  f.store.markResult(a.id, { status: 'awaiting_user', code: 'CHALLENGE_REQUIRED', message: input().password });
  assert.equal(f.store.get(a.id).lastResult.message, ACCOUNT_RESULT_CODES.CHALLENGE_REQUIRED); assert.equal(f.store.get(a.id).identity.memberId, '12345');
  f.store.markResult(a.id, { status: 'error', code: 'RAW_SECRET_EXCEPTION', message: input().password }); assert.equal(f.store.get(a.id).lastResult.code, 'LOGIN_FAILED');
  f.store.markResult(a.id, { status: 'logging_in' }); const previousLoginAt = f.store.get(a.id).lastLoginAt;
  const restarted = new AccountsStore(f.options), recovered = restarted.get(a.id);
  assert.equal(recovered.status, 'awaiting_user'); assert.equal(recovered.lastResult.code, 'LOGIN_OUTCOME_UNKNOWN'); assert.equal(recovered.lastLoginAt, previousLoginAt); assert.equal(recovered.identity.memberId, '12345');
  assert.equal(new AccountsStore(f.options).get(a.id).status, 'awaiting_user');
});

test('withCredentials locks account edits, allows trusted result updates, and scrubs transient object references', async t => {
  const { store } = fixture(t), a = store.save(input()); let release, reference;
  const pending = store.withCredentials(a.id, async credentials => { reference = credentials; await new Promise(resolve => { release = resolve; }); store.verify(a.id, identity()); return 'verified'; });
  assert.equal(store.isBusy(a.id), true); assert.throws(() => store.save({ id: a.id, label: 'race' }), { code: 'ACCOUNT_BUSY' }); assert.throws(() => store.remove(a.id), { code: 'ACCOUNT_BUSY' });
  await assert.rejects(store.withCredentials(a.id, () => undefined), { code: 'ACCOUNT_BUSY' }); store.markResult(a.id, { status: 'logging_in' }); release();
  assert.equal(await pending, 'verified'); assert.equal(reference.password, ''); assert.equal(store.isBusy(a.id), false); assert.equal(store.get(a.id).status, 'logged_in');
});

test('credential callbacks and decryption errors expose only fixed messages', async t => {
  const f = fixture(t), a = f.store.save(input());
  await assert.rejects(f.store.withCredentials(a.id, credentials => { throw Error('bad password=' + credentials.password); }), error => error.code === 'ACCOUNT_OPERATION_FAILED' && !error.message.includes(input().password) && error.cause === undefined);
  await assert.rejects(f.store.withCredentials(a.id, () => { const error = Error(input().password); error.code = 'CHALLENGE_REQUIRED'; throw error; }), error => error.code === 'CHALLENGE_REQUIRED' && error.message === ACCOUNT_RESULT_CODES.CHALLENGE_REQUIRED);
  const unseal = f.store.unseal; f.store.unseal = () => { throw Error(input().password); };
  await assert.rejects(f.store.withCredentials(a.id, () => assert.fail()), error => error.code === 'ACCOUNT_CREDENTIALS_UNAVAILABLE' && !error.message.includes(input().password)); f.store.unseal = unseal;
  assert.equal(f.store.isBusy(a.id), false);
});

test('atomic rename failure rolls back memory and disk, removes temporary files and faults future writes', t => {
  let fail = false; const io = { ...fs, renameSync: (...args) => { if (fail) throw Error(input().password); return fs.renameSync(...args); } };
  const f = fixture(t, { fsImpl: io }), a = f.store.save(input()), before = fs.readFileSync(f.store.file, 'utf8'); fail = true;
  assert.throws(() => f.store.save({ id: a.id, label: 'uncommitted', password: 'new secret' }), error => error.code === 'ACCOUNT_STORAGE_FAILED' && !error.message.includes(input().password));
  assert.deepEqual(f.store.get(a.id), a); assert.equal(fs.readFileSync(f.store.file, 'utf8'), before); assert.deepEqual(fs.readdirSync(f.dir), ['commerce-accounts.json']); assert.equal(f.store.faulted, true);
  assert.throws(() => f.store.remove(a.id), { code: 'ACCOUNT_STORAGE_FAULTED' }); assert.deepEqual(new AccountsStore(f.options).get(a.id), a);
});

test('sealing failures leave committed data untouched and never fall back to plaintext storage', t => {
  const f = fixture(t), a = f.store.save(input()), before = fs.readFileSync(f.store.file, 'utf8');
  f.store.seal = () => { throw Error(input().password); };
  assert.throws(() => f.store.save({ id: a.id, password: 'new password' }), error => error.code === 'ACCOUNT_ENCRYPTION_UNAVAILABLE' && !error.message.includes(input().password));
  assert.deepEqual(f.store.get(a.id), a); assert.equal(fs.readFileSync(f.store.file, 'utf8'), before);
  f.store.seal = value => value; assert.throws(() => f.store.save({ id: a.id, label: 'changed' }), { code: 'ACCOUNT_ENCRYPTION_UNAVAILABLE' });
});

test('malformed, undecryptable and duplicate storage is preserved rather than reset', t => {
  const f = fixture(t), a = f.store.save(input()); const valid = fs.readFileSync(f.store.file, 'utf8'), data = decodedStore(f);
  const badRows = [
    '{invalid json', JSON.stringify({ format: 'isola-commerce-accounts', version: 1, encryptedData: 'not valid ciphertext' }),
    rawStore(f.options, { version: 2, accounts: [] }), rawStore(f.options, { version: 1, accounts: [data.accounts[0], data.accounts[0]] }),
    rawStore(f.options, { version: 1, accounts: [{ ...data.accounts[0], status: 'logged_in', identity: null }] }),
    rawStore(f.options, { version: 1, accounts: [{ ...data.accounts[0], lastResult: { status: 'saved', code: 'SAVED', message: input().password, at: a.createdAt } }] })
  ];
  for (const malformed of badRows) { fs.writeFileSync(f.store.file, malformed); assert.throws(() => new AccountsStore(f.options), error => error.code === 'ACCOUNT_STORAGE_INVALID' && !error.message.includes(input().password)); assert.equal(fs.readFileSync(f.store.file, 'utf8'), malformed); }
  fs.writeFileSync(f.store.file, valid); assert.deepEqual(new AccountsStore(f.options).get(a.id), a);
});

test('external storage replacement is never overwritten by a stale in-memory instance', t => {
  const f = fixture(t), a = f.store.save(input()); const other = new AccountsStore(f.options); other.save({ id: a.id, label: 'Written by another instance' }); const current = fs.readFileSync(f.store.file, 'utf8');
  assert.throws(() => f.store.save({ id: a.id, label: 'stale overwrite' }), { code: 'ACCOUNT_STORAGE_FAILED' }); assert.equal(fs.readFileSync(f.store.file, 'utf8'), current); assert.equal(f.store.get(a.id).label, a.label);
});

test('an existing commerce identity can acquire credentials and is linked only after a fresh matching observation', async t => {
  const { CommerceEngine } = require('../src/commerce-engine.cjs');
  const f = fixture(t), engine = new CommerceEngine({ dir: f.dir, profiles: () => f.profiles, accounts: f.store, seal: f.options.seal, unseal: f.options.unseal, adapter: { readiness: () => ({}) } });
  try {
    engine.bindMarketAccount('profile-1', identity('12345', { documentKey: 'old-verified-document' }));
    const saved = f.store.save(input()); assert.equal(saved.identity, null); assert.equal(engine.db.marketAccounts[0].memberId, '12345');
    assert.throws(() => engine.bindMarketAccount('profile-1', identity('99999', { documentKey: 'wrong-document' })), { code: 'ACCOUNT_CHANGED' }); assert.equal(f.store.get(saved.id).identity, null);
    engine.bindMarketAccount('profile-1', identity('12345', { documentKey: 'fresh-matching-document' }));
    assert.equal(f.store.get(saved.id).identity.memberId, '12345'); assert.equal(engine.db.marketAccounts.length, 1);
    assert.equal(engine.accountObservations.get('profile-1').documentKey, 'fresh-matching-document');
    assert.equal(await f.store.withCredentials(saved.id, c => c.password === input().password), true);
  } finally { await engine.close(); }
});

test('an account-store write failure during verification cannot create a commerce binding or observation', async t => {
  const { CommerceEngine } = require('../src/commerce-engine.cjs');
  const f = fixture(t), saved = f.store.save(input());
  const engine = new CommerceEngine({ dir: f.dir, profiles: () => f.profiles, accounts: f.store, seal: f.options.seal, unseal: f.options.unseal, adapter: { readiness: () => ({}) } });
  const original = fs.readFileSync(engine.file, 'utf8');
  try {
    f.store.seal = () => { throw Error(input().password); };
    assert.throws(() => engine.bindMarketAccount('profile-1', identity('12345', { documentKey: 'fresh-document' })), error => error.code === 'ACCOUNT_ENCRYPTION_UNAVAILABLE' && !error.message.includes(input().password));
    assert.equal(f.store.get(saved.id).identity, null); assert.deepEqual(engine.db.marketAccounts, []); assert.equal(engine.accountObservations.size, 0); assert.equal(fs.readFileSync(engine.file, 'utf8'), original);
  } finally { await engine.close(); }
});

function commerceOptions(f, accounts, calls = { ready: 0, poll: 0, sends: 0 }) {
  return { dir: f.dir, profiles: () => f.profiles, accounts, seal: f.options.seal, unseal: f.options.unseal,
    clientFactory: () => { throw Error('Supplier access is forbidden in account storage tests'); },
    adapter: { readiness: () => ({ capabilities: { messages: true } }), requireReady: async () => { calls.ready++; throw Error('Business input must not start'); }, poll: async () => { calls.poll++; return []; }, sendReply: async () => { calls.sends++; throw Error('Business writes must not start'); } }
  };
}
function queuedMessage(engine) {
  engine.db.products = [{ id: 'product-1', sku: 'FIXTURE', name: 'Fixture product', stock: 10, priceCents: 1000, photoSetsAvailable: 1 }];
  const plan = engine.savePlan({ profileId: 'profile-1', productId: 'product-1', listingPriceCents: 2500, minOfferCents: 2000, targetCount: 2, enabled: true, autoReply: true });
  plan.activeListingId = '123456'; engine.persist();
  return engine.enqueue('message', plan, { id: 'message-1', listingId: '123456', buyerUsername: 'fixture-buyer' }, 'message:message-1');
}

test('a vault-only committed identity survives a failed second-file write and blocks another legacy profile after restart', async t => {
  const { CommerceEngine } = require('../src/commerce-engine.cjs');
  const f = fixture(t), saved = f.store.save(input()), engine = new CommerceEngine(commerceOptions(f, f.store));
  const originalEngineFile = fs.readFileSync(engine.file, 'utf8');
  engine.persist = function () { this.faulted = true; throw Error('Simulated second-file commit failure'); };
  assert.throws(() => engine.bindMarketAccount('profile-1', identity('12345', { documentKey: 'before-crash' })), /second-file/);
  assert.equal(f.store.get(saved.id).identity.memberId, '12345'); assert.equal(fs.readFileSync(engine.file, 'utf8'), originalEngineFile); await engine.close();
  const restartedVault = new AccountsStore(f.options), restarted = new CommerceEngine(commerceOptions(f, restartedVault));
  try {
    assert.deepEqual(restarted.db.marketAccounts, []); assert.equal(restarted.marketAccountRecords().length, 1); assert.equal(restarted.marketAccountRecords()[0].profileId, 'profile-1');
    const before = fs.readFileSync(restarted.file, 'utf8');
    assert.throws(() => restarted.bindMarketAccount('profile-2', identity('12345', { documentKey: 'other-profile' })), { code: 'ACCOUNT_CONFLICT' });
    assert.deepEqual(restarted.db.marketAccounts, []); assert.equal(restarted.accountObservations.size, 0); assert.equal(fs.readFileSync(restarted.file, 'utf8'), before);
    restarted.bindMarketAccount('profile-1', identity('12345', { documentKey: 'fresh-original-profile' }));
    assert.equal(restarted.db.marketAccounts.length, 1); assert.equal(restarted.marketAccountRecords().length, 1); assert.equal(restarted.accountObservations.get('profile-1').documentKey, 'fresh-original-profile');
  } finally { await restarted.close(); }
});

test('contradictory vault and commerce identities remain blocked after restart despite a fresh page observation', async t => {
  const { CommerceEngine } = require('../src/commerce-engine.cjs');
  const f = fixture(t), calls = { ready: 0, poll: 0, sends: 0 }, engine = new CommerceEngine(commerceOptions(f, f.store, calls));
  engine.bindMarketAccount('profile-1', identity('11111', { documentKey: 'legacy-document' }));
  const job = queuedMessage(engine), saved = f.store.save(input());
  // Represents two independently restored valid files with conflicting identity
  // evidence; neither file may silently take precedence over the other.
  f.store.verify(saved.id, identity('22222')); await engine.close(); f.profiles[0].status = 'running';
  const restartedVault = new AccountsStore(f.options), restarted = new CommerceEngine(commerceOptions(f, restartedVault, calls));
  try {
    restarted.accountObservations.set('profile-1', { profileId: 'profile-1', memberId: '11111', verified: true, documentKey: 'fresh-page-document', checkedAt: new Date().toISOString() });
    assert.deepEqual(restarted.marketAccountRecords().filter(a => a.profileId === 'profile-1').map(a => a.memberId).sort(), ['11111', '22222']);
    const status = restarted.queueHealth().jobs.find(row => row.jobId === job.id); assert.equal(status.state, 'blocked'); assert.equal(status.reasonCode, 'ACCOUNT_RECORD_CONFLICT');
    const restoredJob = restarted.db.jobs.find(row => row.id === job.id); await assert.rejects(restarted.runJob(restoredJob), { code: 'ACCOUNT_CONFLICT' });
    assert.equal(restoredJob.state, 'queued'); assert.deepEqual(calls, { ready: 0, poll: 0, sends: 0 }); assert.equal(restarted.active.size, 0);
  } finally { await restarted.close(); }
});

test('a faulted vault blocks queue eligibility, startup, polling and direct business execution', async t => {
  const { CommerceEngine } = require('../src/commerce-engine.cjs');
  let fail = false; const io = { ...fs, renameSync: (...args) => { if (fail) throw Error('Simulated vault disk failure'); return fs.renameSync(...args); } };
  const f = fixture(t, { fsImpl: io }), saved = f.store.save(input()), calls = { ready: 0, poll: 0, sends: 0 };
  const engine = new CommerceEngine(commerceOptions(f, f.store, calls));
  try {
    const job = queuedMessage(engine); engine.bindMarketAccount('profile-1', identity('12345', { documentKey: 'fresh-page-document' })); f.profiles[0].status = 'running';
    assert.equal(engine.queueHealth().jobs.find(row => row.jobId === job.id).state, 'ready');
    fail = true; assert.throws(() => f.store.save({ id: saved.id, label: 'Uncommitted label' }), { code: 'ACCOUNT_STORAGE_FAILED' });
    assert.equal(engine.faulted, false); assert.equal(f.store.faulted, true); assert.equal(engine.storageFaulted(), true); assert.equal(engine.state().faulted, true);
    const status = engine.queueHealth().jobs.find(row => row.jobId === job.id); assert.equal(status.state, 'blocked'); assert.equal(status.reasonCode, 'STORAGE_UNAVAILABLE');
    assert.throws(() => engine.setRunning(true), /存储/); assert.equal(engine.running, false); assert.equal(engine.timer, null);
    await assert.rejects(engine.runOnce(), /存储/); assert.equal(engine.tickCurrent(engine.runGeneration, new AbortController().signal), false);
    await assert.rejects(engine.runJob(job), { code: 'STOPPED' });
    assert.equal(job.state, 'queued'); assert.deepEqual(calls, { ready: 0, poll: 0, sends: 0 }); assert.equal(engine.active.size, 0); assert.deepEqual(engine.leases.activeProfileIds(), []);
  } finally { await engine.close(); }
});
