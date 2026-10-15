const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');

const ACCOUNT_STATUSES = Object.freeze(['saved', 'logging_in', 'awaiting_user', 'logged_in', 'error']);
const ACCOUNT_RESULT_CODES = Object.freeze({
  SAVED: '账号已保存。', LOGIN_STARTED: '正在当前指纹环境中发起登录。', LOGIN_REQUIRED: '请在当前窗口完成登录。',
  LOGIN_VERIFIED: '已核对当前窗口的登录账号。', LOGIN_FAILED: '登录未完成，请打开当前窗口核对。',
  LOGIN_OUTCOME_UNKNOWN: '上次登录过程已中断；请核对当前窗口，不会自动重复提交。',
  CHALLENGE_REQUIRED: '请在当前窗口手动完成验证码或安全验证。', INVALID_CREDENTIALS: '登录信息未被网站接受，请核对后再操作。',
  ACCOUNT_CONFIRMATION_REQUIRED: '请核对当前窗口的账号身份。', ACCOUNT_CHANGED: '当前窗口的账号与保存的绑定不同，请核对。',
  ACCOUNT_CONFLICT: '该平台账号已绑定其他指纹环境。', IDENTITY_UNVERIFIED: '尚未取得可核对的账号身份，请在当前窗口检查。',
  PAGE_UNSUPPORTED: '当前页面不支持自动登录，请在当前窗口处理。', PAGE_CHANGED: '登录页面已改变，请重新核对当前窗口。',
  FORM_NOT_FOUND: '未找到可安全填写的登录表单，请在当前窗口处理。', STOPPED: '登录操作已停止，请核对当前窗口。',
  UNAVAILABLE: '登录暂不可用，请打开当前窗口核对。'
});
const DEFAULT_CODE = { saved: 'SAVED', logging_in: 'LOGIN_STARTED', awaiting_user: 'LOGIN_REQUIRED', logged_in: 'LOGIN_VERIFIED', error: 'LOGIN_FAILED' };
const REVIEW_CODES = new Set(['LOGIN_STARTED','LOGIN_OUTCOME_UNKNOWN','CHALLENGE_REQUIRED','ACCOUNT_CONFIRMATION_REQUIRED','PAGE_CHANGED','IDENTITY_UNVERIFIED']);
function accountNeedsLoginReview(account) { return account?.loginReviewPending === true || account?.status === 'logging_in' || REVIEW_CODES.has(account?.lastResult?.code); }
const MAX_ACCOUNTS = 500, MAX_FILE_BYTES = 8 * 1024 * 1024;
const clone = value => structuredClone(value);
const now = () => new Date().toISOString();
const hash = value => createHash('sha256').update(value).digest('hex');
function problem(code, message) { const error = Error(message); error.code = code; return error; }
function plain(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function identifier(value) { if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(value)) throw problem('ACCOUNT_INVALID', '账号或环境标识无效'); return value; }
function text(value, limit, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) throw problem('ACCOUNT_INVALID', label + '无效');
  return value.trim();
}
function loginKey(value) { return value.normalize('NFKC').toLowerCase().replaceAll('ß', 'ss').replaceAll('ς', 'σ'); }
function normalizedLogin(value) {
  const login = text(value, 254, '登录邮箱或用户名').normalize('NFKC');
  if (login.length > 254 || /\s/u.test(login)) throw problem('ACCOUNT_INVALID', '登录邮箱或用户名无效');
  return login;
}
function timestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw problem('ACCOUNT_INVALID', '账号时间记录无效');
  return value;
}
function normalizeIdentity(observed, at = now()) {
  if (!plain(observed) || observed.verified !== true || typeof observed.memberId !== 'string' || !/^[1-9]\d{0,24}$/.test(observed.memberId)) throw problem('IDENTITY_UNVERIFIED', '平台账号身份尚未核对');
  const username = text(observed.username, 100, '平台用户名');
  let url;
  try { url = new URL(observed.profileURL); } catch { throw problem('IDENTITY_UNVERIFIED', '平台账号地址无效'); }
  if (url.origin !== 'https://www.vinted.fr' || url.username || url.password || url.search || url.hash || !new RegExp('^/member/' + observed.memberId + '(?:-[^/]+)?$').test(url.pathname)) throw problem('IDENTITY_UNVERIFIED', '平台账号地址与编号不一致');
  return { memberId: observed.memberId, username, profileURL: 'https://www.vinted.fr/member/' + observed.memberId, verifiedAt: timestamp(at) };
}
function publicAccount(row) {
  return { id: row.id, platform: row.platform, label: row.label, login: row.login, profileId: row.profileId, hasPassword: !!row.encryptedPassword, identity: clone(row.identity), status: row.status, lastResult: clone(row.lastResult), loginReviewPending: accountNeedsLoginReview(row), lastLoginAt: row.lastLoginAt, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

class AccountsStore {
  #rows = [];
  #fingerprint = null;
  #faulted = false;
  #busy = new Set();
  constructor({ dir, profiles = () => [], seal, unseal, assertMutable = () => {}, onChange = () => {}, fsImpl = fs } = {}) {
    if (typeof dir !== 'string' || !dir || typeof profiles !== 'function' || typeof seal !== 'function' || typeof unseal !== 'function' || typeof assertMutable !== 'function' || typeof onChange !== 'function') throw problem('ACCOUNT_CONFIG_INVALID', '账号存储或加密服务未配置');
    this.dir = path.resolve(dir); this.file = path.join(this.dir, 'commerce-accounts.json');
    this.profiles = profiles; this.seal = seal; this.unseal = unseal; this.assertMutable = assertMutable; this.onChange = onChange; this.fs = fsImpl;
    try {
      this.fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      if (this.fs.existsSync(this.file)) {
        const stat = this.fs.lstatSync(this.file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) throw Error('invalid file');
        const raw = this.fs.readFileSync(this.file, 'utf8'), envelope = JSON.parse(raw);
        if (!plain(envelope) || envelope.format !== 'isola-commerce-accounts' || envelope.version !== 1 || typeof envelope.encryptedData !== 'string' || !envelope.encryptedData) throw Error('invalid envelope');
        const decrypted = this.unseal(envelope.encryptedData);
        if (typeof decrypted !== 'string' || Buffer.byteLength(decrypted) > MAX_FILE_BYTES) throw Error('invalid data');
        const data = JSON.parse(decrypted);
        if (!plain(data) || data.version !== 1 || !Array.isArray(data.accounts) || data.accounts.length > MAX_ACCOUNTS) throw Error('invalid data');
        this.#rows = data.accounts.map(row => this.#validateStored(row)); this.#unique(this.#rows); this.#fingerprint = hash(raw);
      }
    } catch { throw problem('ACCOUNT_STORAGE_INVALID', '账号存储无法读取或解密，原文件已保留；请先恢复存储后再继续'); }
    if (this.#rows.some(row => row.status === 'logging_in')) {
      const recovered = clone(this.#rows);
      for (const row of recovered) if (row.status === 'logging_in') {
        row.status = 'awaiting_user'; row.lastResult = this.#result({ status: 'awaiting_user', code: 'LOGIN_OUTCOME_UNKNOWN' }); row.updatedAt = row.lastResult.at;
      }
      this.#commit(recovered);
    }
  }
  get faulted() { return this.#faulted; }
  list() { return this.#rows.map(publicAccount); }
  get(id) { return publicAccount(this.#account(id)); }
  findByProfile(profileId) { const row = this.#rows.find(account => account.profileId === profileId); return row ? publicAccount(row) : null; }
  isBusy(id) { return this.#busy.has(id); }
  #account(id) { identifier(id); const row = this.#rows.find(account => account.id === id); if (!row) throw problem('ACCOUNT_NOT_FOUND', '账号不存在'); return row; }
  #available(id) { if (this.#faulted) throw problem('ACCOUNT_STORAGE_FAULTED', '账号存储已暂停，请检查磁盘并重启应用'); if (id && this.#busy.has(id)) throw problem('ACCOUNT_BUSY', '账号正在登录或核对，请等待当前操作结束'); }
  #profile(id, allowMissing = false) {
    let rows;
    try { rows = this.profiles(); } catch { throw problem('PROFILE_UNAVAILABLE', '暂时无法核对指纹环境'); }
    if (!Array.isArray(rows)) throw problem('PROFILE_UNAVAILABLE', '暂时无法核对指纹环境');
    const profile = rows.find(row => row.id === id);
    if (!profile && !allowMissing) throw problem('PROFILE_NOT_FOUND', '请选择现有的指纹环境');
    return profile;
  }
  #closed(id, allowMissing = false) {
    const profile = this.#profile(id, allowMissing);
    if (profile && (profile.running === true || profile.status && profile.status !== 'closed')) throw problem('PROFILE_OPEN', '请先关闭相关指纹环境，再绑定或删除账号');
  }
  #guard(action, account, next) {
    try { const result = this.assertMutable({ action, account: account ? publicAccount(account) : null, next: next ? publicAccount(next) : null }); if (result && typeof result.then === 'function') { Promise.resolve(result).catch(() => {}); throw Error('blocked'); } if (result === false) throw Error('blocked'); }
    catch { throw problem('ACCOUNT_CHANGE_BLOCKED', '账号正在使用或已有运营关联，暂不能修改此绑定'); }
  }
  #encrypt(value) {
    try { const encrypted = this.seal(value); if (typeof encrypted !== 'string' || !encrypted || encrypted === value) throw Error('invalid encryption'); return encrypted; }
    catch { throw problem('ACCOUNT_ENCRYPTION_UNAVAILABLE', '系统加密服务不可用，账号信息未保存'); }
  }
  #unique(rows) {
    const ids = new Set(), profiles = new Set(), logins = new Set(), members = new Set();
    for (const row of rows) {
      const login = loginKey(row.login), member = row.identity?.memberId;
      if (ids.has(row.id) || profiles.has(row.profileId) || logins.has(login) || member && members.has(member)) throw problem('ACCOUNT_CONFLICT', '该登录账号、指纹环境或平台身份已被其他账号使用');
      ids.add(row.id); profiles.add(row.profileId); logins.add(login); if (member) members.add(member);
    }
  }
  #result(input) {
    if (!plain(input) || !ACCOUNT_STATUSES.includes(input.status)) throw problem('ACCOUNT_INVALID', '账号登录状态无效');
    const code = typeof input.code === 'string' && Object.hasOwn(ACCOUNT_RESULT_CODES, input.code) ? input.code : DEFAULT_CODE[input.status];
    // Caller messages and exception details are deliberately never persisted.
    return { status: input.status, code, message: ACCOUNT_RESULT_CODES[code], at: timestamp(input.at ?? now()) };
  }
  #validateStored(row) {
    if (!plain(row) || row.platform !== 'vinted' || typeof row.encryptedPassword !== 'string' || row.encryptedPassword.length > 65536 || !ACCOUNT_STATUSES.includes(row.status) || row.loginReviewPending !== undefined && typeof row.loginReviewPending !== 'boolean') throw Error('invalid account');
    const result = { id: identifier(row.id), platform: 'vinted', label: text(row.label, 80, '账号名称'), login: normalizedLogin(row.login), profileId: identifier(row.profileId), encryptedPassword: row.encryptedPassword, identity: null, status: row.status, lastResult: null, loginReviewPending: accountNeedsLoginReview(row), lastLoginAt: row.lastLoginAt === null ? null : timestamp(row.lastLoginAt), createdAt: timestamp(row.createdAt), updatedAt: timestamp(row.updatedAt) };
    if (row.identity !== null) {
      const identity = normalizeIdentity({ ...row.identity, verified: true }, row.identity.verifiedAt);
      if (JSON.stringify(identity) !== JSON.stringify(row.identity)) throw Error('noncanonical identity');
      result.identity = identity;
    }
    if (row.lastResult !== null) {
      if (!plain(row.lastResult) || row.lastResult.status !== row.status || !Object.hasOwn(ACCOUNT_RESULT_CODES, row.lastResult.code)) throw Error('invalid result');
      result.lastResult = this.#result(row.lastResult);
      if (result.lastResult.message !== row.lastResult.message) throw Error('invalid result message');
    }
    if (row.status === 'logged_in' && !result.identity) throw Error('unverified logged-in account');
    return result;
  }
  #commit(rows) {
    this.#available(); this.#unique(rows);
    const encryptedData = this.#encrypt(JSON.stringify({ version: 1, accounts: rows }));
    const raw = JSON.stringify({ format: 'isola-commerce-accounts', version: 1, encryptedData }, null, 2);
    if (Buffer.byteLength(raw) > MAX_FILE_BYTES) throw problem('ACCOUNT_LIMIT', '账号存储超过容量限制');
    const temp = this.file + '.tmp-' + randomUUID(); let created = false;
    try {
      const current = this.fs.existsSync(this.file) ? hash(this.fs.readFileSync(this.file)) : null;
      if (current !== this.#fingerprint) throw Error('external storage change');
      const fd = this.fs.openSync(temp, 'wx', 0o600); created = true;
      try { this.fs.writeFileSync(fd, raw, 'utf8'); this.fs.fsyncSync(fd); } finally { this.fs.closeSync(fd); }
      this.fs.renameSync(temp, this.file); created = false;
      // Directory fsync is best-effort: opening a directory is unsupported on
      // Windows. The atomic rename is the commit point on every platform.
      try { const fd = this.fs.openSync(this.dir, 'r'); try { this.fs.fsyncSync(fd); } finally { this.fs.closeSync(fd); } } catch {}
    } catch {
      this.#faulted = true;
      throw problem('ACCOUNT_STORAGE_FAILED', '账号信息未能安全保存，原状态已保留；请检查磁盘并重启应用');
    } finally { if (created) { try { this.fs.unlinkSync(temp); } catch {} } }
    this.#rows = rows; this.#fingerprint = hash(raw);
    try { this.onChange(this.list()); } catch { /* A notification cannot undo a committed write. */ }
  }
  save(input = {}) {
    if (!plain(input)) throw problem('ACCOUNT_INVALID', '账号配置无效');
    const previous = input.id ? this.#account(input.id) : null; this.#available(previous?.id);
    if (!previous && this.#rows.length >= MAX_ACCOUNTS) throw problem('ACCOUNT_LIMIT', '最多保存 500 个账号');
    const platform = input.platform ?? previous?.platform ?? 'vinted'; if (platform !== 'vinted') throw problem('ACCOUNT_INVALID', '当前仅支持 Vinted 账号');
    const label = text(input.label ?? previous?.label, 80, '账号名称'), login = normalizedLogin(input.login ?? previous?.login), profileId = identifier(input.profileId ?? previous?.profileId);
    this.#profile(profileId);
    const loginChanged = !!previous && loginKey(login) !== loginKey(previous.login), rebound = !!previous && profileId !== previous.profileId;
    if (!previous || rebound) { this.#closed(profileId); if (previous) this.#closed(previous.profileId, true); }
    if (input.clearPassword !== undefined && typeof input.clearPassword !== 'boolean') throw problem('ACCOUNT_INVALID', '密码清除选项无效');
    const passwordPresent = Object.hasOwn(input, 'password');
    if (passwordPresent && (typeof input.password !== 'string' || !input.password || input.password.length > 1024 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(input.password))) throw problem('ACCOUNT_INVALID', '密码无效；不修改时请省略，清除时请使用明确的清除选项');
    if (input.clearPassword && passwordPresent) throw problem('ACCOUNT_INVALID', '不能同时设置和清除密码');
    const at = now(), row = { id: previous?.id ?? randomUUID(), platform, label, login, profileId, encryptedPassword: previous?.encryptedPassword ?? '', identity: previous && !loginChanged && !rebound ? clone(previous.identity) : null, status: previous?.status ?? 'saved', lastResult: clone(previous?.lastResult ?? null), loginReviewPending: previous ? accountNeedsLoginReview(previous) : false, lastLoginAt: previous?.lastLoginAt ?? null, createdAt: previous?.createdAt ?? at, updatedAt: at };
    if (loginChanged || rebound || passwordPresent || input.clearPassword) { row.status = 'saved'; row.lastResult = this.#result({ status: 'saved', at }); row.loginReviewPending = false; if (loginChanged || rebound) row.lastLoginAt = null; }
    this.#guard(!previous ? 'create' : rebound ? 'rebind' : loginChanged ? 'change-login' : 'update', previous, row);
    if (passwordPresent) row.encryptedPassword = this.#encrypt(input.password); else if (input.clearPassword) row.encryptedPassword = '';
    const rows = clone(this.#rows), index = rows.findIndex(account => account.id === row.id); if (index < 0) rows.push(row); else rows[index] = row;
    this.#commit(rows); return publicAccount(row);
  }
  remove(id) {
    const row = this.#account(id); this.#available(id); this.#closed(row.profileId, true); this.#guard('remove', row, null);
    this.#commit(this.#rows.filter(account => account.id !== id).map(clone)); return { removed: true, id };
  }
  verify(id, observed) {
    this.#available(); const previous = this.#account(id), identity = normalizeIdentity(observed);
    if (previous.identity && previous.identity.memberId !== identity.memberId) throw problem('ACCOUNT_CHANGED', ACCOUNT_RESULT_CODES.ACCOUNT_CHANGED);
    const rows = clone(this.#rows), row = rows.find(account => account.id === id); row.identity = identity; row.status = 'logged_in'; row.lastResult = this.#result({ status: 'logged_in', at: identity.verifiedAt }); row.loginReviewPending = false; row.lastLoginAt = identity.verifiedAt; row.updatedAt = identity.verifiedAt;
    this.#commit(rows); return publicAccount(row);
  }
  markResult(id, input) {
    this.#available(); const previous = this.#account(id), result = this.#result(input);
    if(input.loginReviewPending !== undefined && typeof input.loginReviewPending !== 'boolean') throw problem('ACCOUNT_INVALID', '账号核对状态无效');
    if (result.status === 'logged_in' && !previous.identity) throw problem('IDENTITY_UNVERIFIED', ACCOUNT_RESULT_CODES.IDENTITY_UNVERIFIED);
    // A failed read must report its own result without erasing the independent
    // read-before-login latch. Only fresh identity verification or an explicit
    // credential/binding edit clears that latch.
    const rows = clone(this.#rows), row = rows.find(account => account.id === id); row.status = result.status; row.lastResult = result; row.loginReviewPending = accountNeedsLoginReview(previous) || accountNeedsLoginReview({status:result.status,lastResult:result}) || input.loginReviewPending === true; row.updatedAt = result.at; if (result.status === 'logged_in') row.lastLoginAt = result.at;
    this.#commit(rows); return publicAccount(row);
  }
  async withCredentials(id, callback) {
    const row = this.#account(id); this.#available(id);
    if (typeof callback !== 'function') throw problem('ACCOUNT_INVALID', '登录操作无效');
    if (!row.encryptedPassword) throw problem('ACCOUNT_PASSWORD_REQUIRED', '请先为此账号保存密码，或在当前窗口手动登录');
    this.#busy.add(id); let password, credentials;
    try {
      try { password = this.unseal(row.encryptedPassword); if (typeof password !== 'string' || !password || password.length > 1024 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(password)) throw Error('invalid credentials'); }
      catch { throw problem('ACCOUNT_CREDENTIALS_UNAVAILABLE', '账号密码无法解密，请在本机重新保存密码'); }
      credentials = { id: row.id, platform: row.platform, login: row.login, password, profileId: row.profileId, identity: clone(row.identity) };
      try { return await callback(credentials); }
      catch (error) { const code = typeof error?.code === 'string' && Object.hasOwn(ACCOUNT_RESULT_CODES, error.code) ? error.code : 'ACCOUNT_OPERATION_FAILED'; throw problem(code, ACCOUNT_RESULT_CODES[code] ?? '账号登录操作未完成，请核对当前窗口'); }
    } finally { if (credentials) credentials.password = ''; password = ''; this.#busy.delete(id); }
  }
}

module.exports = { AccountsStore, ACCOUNT_STATUSES, ACCOUNT_RESULT_CODES, normalizeIdentity, accountNeedsLoginReview };
