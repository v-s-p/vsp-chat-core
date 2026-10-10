import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { randomToken } from './pkce.js';

// Credentials live outside the repository, per user:
//   Windows: %LOCALAPPDATA%\vsp-chat-core\chatgpt-plan
//   other:   ~/.config/vsp-chat-core/chatgpt-plan
// Override with CHAT_CORE_CREDENTIALS_DIR (e.g. for tests).
export function defaultCredentialsDir(env = process.env, platform = process.platform) {
  if (env.CHAT_CORE_CREDENTIALS_DIR) return env.CHAT_CORE_CREDENTIALS_DIR;
  if (platform === 'win32' && env.LOCALAPPDATA) {
    return join(env.LOCALAPPDATA, 'vsp-chat-core', 'chatgpt-plan');
  }
  return join(homedir(), '.config', 'vsp-chat-core', 'chatgpt-plan');
}

// Two files, deliberately separate:
//   client.json      — issued client_id + ext_agent_host_id. Survives logout,
//                      because re-authorization must reuse the same client.
//   credentials.json — tokens + verified identity. Removed on logout or on a
//                      terminal refresh error.
export class CredentialStore {
  #dir;

  constructor(dir = defaultCredentialsDir()) {
    this.#dir = dir;
  }

  get dir() {
    return this.#dir;
  }

  async #read(name) {
    try {
      return JSON.parse(await readFile(join(this.#dir, name), 'utf8'));
    } catch (err) {
      if (err?.code === 'ENOENT') return null;
      // A corrupt file is treated as absent rather than crashing the server;
      // the user simply signs in again.
      if (err instanceof SyntaxError) return null;
      throw err;
    }
  }

  // Atomic replace: write a sibling temp file with owner-only permissions,
  // then rename over the target, so a crash never leaves a half-written
  // credential file. (On Windows the mode bits are ignored; the per-user
  // LOCALAPPDATA ACL is what protects the file there.)
  async #write(name, value) {
    await mkdir(this.#dir, { recursive: true, mode: 0o700 });
    const target = join(this.#dir, name);
    const temp = `${target}.${randomToken(6)}.tmp`;
    await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
    try {
      await rename(temp, target);
    } catch (err) {
      await rm(temp, { force: true });
      throw err;
    }
  }

  async loadClient() {
    return this.#read('client.json');
  }

  // ext_agent_host_id must be stable per machine, so it is generated once and
  // kept even before any client id has been issued.
  async ensureHostId() {
    const client = (await this.loadClient()) ?? {};
    if (client.ext_agent_host_id) return client.ext_agent_host_id;
    const hostId = randomToken(16);
    await this.#write('client.json', { ...client, ext_agent_host_id: hostId });
    return hostId;
  }

  async saveClientId(clientId) {
    const client = (await this.loadClient()) ?? {};
    await this.#write('client.json', { ...client, client_id: clientId });
  }

  async loadCredentials() {
    return this.#read('credentials.json');
  }

  async saveCredentials(record) {
    await this.#write('credentials.json', { ...record, saved_at: new Date().toISOString() });
  }

  async clearCredentials() {
    await rm(join(this.#dir, 'credentials.json'), { force: true });
  }
}
