import fs from "fs/promises";
import path from "path";
import { randomBytes } from "crypto";
import { spawn } from "child_process";
import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

interface OAuthStore {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  discoveryState?: OAuthDiscoveryState;
  pendingState?: string;
  authorizationUrl?: string;
  updatedAt?: string;
}

export interface FileOAuthProviderOptions {
  serverId: string;
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
  private readonly scope?: string;
  private readonly storePath: string;
  private readonly callbackUrl: string;
  private readonly shouldOpenBrowser: boolean;
  private loaded = false;
  private store: OAuthStore = {};

  constructor(options: FileOAuthProviderOptions) {
    this.serverId = options.serverId;
    this.scope = options.scope;
    const authDir = options.authDir || process.env.MCP_OAUTH_STORE?.trim() || path.resolve(process.cwd(), ".mcp-oauth");
    const safeId = options.serverId.replace(/[^a-zA-Z0-9_.-]/g, "_");
    this.storePath = path.join(authDir, `${safeId}.json`);
    const callbackBase = (options.callbackBase || process.env.MCP_OAUTH_CALLBACK_BASE?.trim() ||
      `http://127.0.0.1:${process.env.ADMIN_PORT?.trim() || "3001"}`).replace(/\/$/, "");
    this.callbackUrl = `${callbackBase}/oauth/callback/${encodeURIComponent(options.serverId)}`;
    this.shouldOpenBrowser = options.openBrowser ?? process.env.MCP_OAUTH_OPEN_BROWSER?.toLowerCase() !== "false";
  }

  private async load(): Promise<OAuthStore> {
    if (this.loaded) return this.store;
    try {
      this.store = JSON.parse(await fs.readFile(this.storePath, "utf-8")) as OAuthStore;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      this.store = {};
    }
    this.loaded = true;
    return this.store;
  }

  private async save(): Promise<void> {
    this.store.updatedAt = new Date().toISOString();
    await fs.mkdir(path.dirname(this.storePath), { recursive: true });
    await fs.writeFile(this.storePath, JSON.stringify(this.store, null, 2), { encoding: "utf-8", mode: 0o600 });
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
    const current = await this.load();
    if (!current.pendingState) {
      current.pendingState = randomBytes(24).toString("base64url");
      await this.save();
    }
    return current.pendingState;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return (await this.load()).clientInformation;
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    (await this.load()).clientInformation = info;
    await this.save();
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.load()).tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    (await this.load()).tokens = tokens;
    await this.save();
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    const current = await this.load();
    current.authorizationUrl = authorizationUrl.toString();
    await this.save();
    if (this.shouldOpenBrowser) openExternal(current.authorizationUrl);
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    (await this.load()).codeVerifier = codeVerifier;
    await this.save();
  }

  async codeVerifier(): Promise<string> {
    const verifier = (await this.load()).codeVerifier;
    if (!verifier) throw new Error(`OAuth PKCE verifier is missing for ${this.serverId}`);
    return verifier;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    const current = await this.load();
    if (scope === "all" || scope === "client") delete current.clientInformation;
    if (scope === "all" || scope === "tokens") delete current.tokens;
    if (scope === "all" || scope === "verifier") delete current.codeVerifier;
    if (scope === "all" || scope === "discovery") delete current.discoveryState;
    if (scope === "all") {
      delete current.pendingState;
      delete current.authorizationUrl;
    }
    await this.save();
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    (await this.load()).discoveryState = state;
    await this.save();
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return (await this.load()).discoveryState;
  }

  async beginAuthorization(options?: { resetTokens?: boolean }): Promise<void> {
    const current = await this.load();
    current.pendingState = randomBytes(24).toString("base64url");
    delete current.codeVerifier;
    delete current.authorizationUrl;
    if (options?.resetTokens) delete current.tokens;
    await this.save();
  }

  async verifyState(state: string | undefined): Promise<boolean> {
    const expected = (await this.load()).pendingState;
    return Boolean(expected && state && expected === state);
  }

  async completeAuthorization(): Promise<void> {
    const current = await this.load();
    delete current.pendingState;
    delete current.authorizationUrl;
    delete current.codeVerifier;
    await this.save();
  }

  async authorizationStatus(): Promise<{
    configured: true;
    connected: boolean;
    pending: boolean;
    authorization_url?: string;
    callback_url: string;
  }> {
    const current = await this.load();
    return {
      configured: true,
      connected: Boolean(current.tokens?.access_token),
      pending: Boolean(current.pendingState && current.authorizationUrl),
      authorization_url: current.authorizationUrl,
      callback_url: this.callbackUrl,
    };
  }
}
