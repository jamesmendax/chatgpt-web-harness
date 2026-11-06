import fs from "fs/promises";
import path from "path";
import { createHash, randomBytes, randomUUID } from "crypto";
import { spawn } from "child_process";
import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

interface OAuthStore {
  identity?: string;
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  discoveryState?: OAuthDiscoveryState;
  pendingState?: string;
  authorizationUrl?: string;
  updatedAt?: string;
}

// Shared by provider instances in this process, but never held across OAuth network requests.
const storeOperations = new Map<string, Promise<unknown>>();

export interface FileOAuthProviderOptions {
  serverId: string;
  serverUrl: string;
  scope?: string;
  authDir?: string;
  callbackBase?: string;
  openBrowser?: boolean;
}

function openExternal(url: string): void {
  try {
    const child = process.platform === "win32"
      ? spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore", windowsHide: true })
      : process.platform === "darwin"
        ? spawn("open", [url], { detached: true, stdio: "ignore" })
        : spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
    child.unref();
  } catch {
    // The Admin UI also exposes the authorization URL, so browser launch failure is non-fatal.
  }
}

export class FileOAuthClientProvider implements OAuthClientProvider {
  private readonly serverId: string;
  private readonly identity: string;
  private readonly scope?: string;
  private readonly storePath: string;
  private readonly callbackUrl: string;
  private readonly shouldOpenBrowser: boolean;

  constructor(options: FileOAuthProviderOptions) {
    if (typeof options.serverId !== "string" || !options.serverId ||
        typeof options.serverUrl !== "string" || !options.serverUrl) {
      throw new Error("OAuth storage requires a server ID and URL");
    }
    this.serverId = options.serverId;
    this.scope = options.scope;
    const authDir = options.authDir || process.env.MCP_OAUTH_STORE?.trim() || path.resolve(process.cwd(), ".mcp-oauth");
    // Hash the exact ID and configured URL as a tuple. This avoids filename
    // filtering and case-folding collisions without placing the URL in a path.
    this.identity = createHash("sha256")
      .update(JSON.stringify(["mcp-oauth-v2", options.serverId, options.serverUrl]), "utf8")
      .digest("hex");
    this.storePath = path.join(authDir, `v2-${this.identity}.json`);
    const callbackBase = (options.callbackBase || process.env.MCP_OAUTH_CALLBACK_BASE?.trim() ||
      `http://127.0.0.1:${process.env.ADMIN_PORT?.trim() || "3001"}`).replace(/\/$/, "");
    this.callbackUrl = `${callbackBase}/oauth/callback/${encodeURIComponent(options.serverId)}`;
    this.shouldOpenBrowser = options.openBrowser ?? process.env.MCP_OAUTH_OPEN_BROWSER?.toLowerCase() !== "false";
  }

  private async load(): Promise<OAuthStore> {
    try {
      const stored = JSON.parse(await fs.readFile(this.storePath, "utf-8")) as OAuthStore;
      if (!stored || typeof stored !== "object" || Array.isArray(stored) || stored.identity !== this.identity) {
        throw new Error("OAuth store identity mismatch");
      }
      return stored;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      return {};
    }
  }

  private async withStore<T>(operation: (store: OAuthStore) => Promise<T>): Promise<T> {
    const key = process.platform === "win32" ? path.resolve(this.storePath).toLowerCase() : path.resolve(this.storePath);
    const previous = storeOperations.get(key) ?? Promise.resolve();
    // Load after prior mutations commit. A cached snapshot from another provider
    // or a concurrent status request must not resurrect credentials after logout.
    const result = previous.catch(() => undefined).then(async () => operation(await this.load()));
    storeOperations.set(key, result);
    try { return await result; }
    finally { if (storeOperations.get(key) === result) storeOperations.delete(key); }
  }

  private async save(store: OAuthStore): Promise<void> {
    store.identity = this.identity;
    store.updatedAt = new Date().toISOString();
    const bytes = JSON.stringify(store, null, 2);
    await fs.mkdir(path.dirname(this.storePath), { recursive: true });
    const temporary = `${this.storePath}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(temporary, "wx", 0o600);
      await handle.writeFile(bytes, "utf-8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temporary, this.storePath);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await fs.unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  get redirectUrl(): string {
    return this.callbackUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.callbackUrl],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "ChatGPT Local Coder",
      ...(this.scope ? { scope: this.scope } : {}),
    };
  }

  async state(): Promise<string> {
    return this.withStore(async current => {
      if (!current.pendingState) {
        current.pendingState = randomBytes(24).toString("base64url");
        await this.save(current);
      }
      return current.pendingState;
    });
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return this.withStore(async current => current.clientInformation);
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    await this.withStore(async current => { current.clientInformation = info; await this.save(current); });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return this.withStore(async current => current.tokens);
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.withStore(async current => { current.tokens = tokens; await this.save(current); });
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    const url = authorizationUrl.toString();
    await this.withStore(async current => { current.authorizationUrl = url; await this.save(current); });
    if (this.shouldOpenBrowser) openExternal(url);
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.withStore(async current => { current.codeVerifier = codeVerifier; await this.save(current); });
  }

  async codeVerifier(): Promise<string> {
    const verifier = await this.withStore(async current => current.codeVerifier);
    if (!verifier) throw new Error(`OAuth PKCE verifier is missing for ${this.serverId}`);
    return verifier;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    await this.withStore(async current => {
      if (scope === "all" || scope === "client") delete current.clientInformation;
      if (scope === "all" || scope === "tokens") delete current.tokens;
      if (scope === "all" || scope === "verifier") delete current.codeVerifier;
      if (scope === "all" || scope === "discovery") delete current.discoveryState;
      if (scope === "all") {
        delete current.pendingState;
        delete current.authorizationUrl;
      }
      await this.save(current);
    });
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    await this.withStore(async current => { current.discoveryState = state; await this.save(current); });
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return this.withStore(async current => current.discoveryState);
  }

  async beginAuthorization(options?: { resetTokens?: boolean }): Promise<void> {
    await this.withStore(async current => {
      current.pendingState = randomBytes(24).toString("base64url");
      delete current.codeVerifier;
      delete current.authorizationUrl;
      if (options?.resetTokens) delete current.tokens;
      await this.save(current);
    });
  }

  async verifyState(state: string | undefined): Promise<boolean> {
    const expected = await this.withStore(async current => current.pendingState);
    return Boolean(expected && state && expected === state);
  }

  async completeAuthorization(): Promise<void> {
    await this.withStore(async current => {
      delete current.pendingState;
      delete current.authorizationUrl;
      delete current.codeVerifier;
      await this.save(current);
    });
  }

  async authorizationStatus(): Promise<{
    configured: true;
    connected: boolean;
    pending: boolean;
    authorization_url?: string;
    callback_url: string;
  }> {
    return this.withStore(async current => ({
      configured: true,
      connected: Boolean(current.tokens?.access_token),
      pending: Boolean(current.pendingState && current.authorizationUrl),
      authorization_url: current.authorizationUrl,
      callback_url: this.callbackUrl,
    }));
  }
}
