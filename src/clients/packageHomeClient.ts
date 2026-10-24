import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpClient, PackageConfig, PackageHome } from "../types.js";

export class PackageHomeClient implements McpClient {
  private client = new Client({ name: "super-mcp-router", version: "1.0.0" });
  private transport: StreamableHTTPClientTransport;
  private connected = false;

  constructor(private config: PackageConfig, home: PackageHome) {
    this.transport = new StreamableHTTPClientTransport(new URL(home.url), {
      requestInit: { headers: home.headers },
    });
    this.client.onclose = () => { this.connected = false; };
  }

  private async request<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      const failures = new Set<unknown>();
      let cause: unknown = error;
      while (cause && typeof cause === "object" && !failures.has(cause)) {
        failures.add(cause);
        const detail = cause as { code?: unknown; message?: string; cause?: unknown };
        if ([502, 503, 504, -32001].includes(Number(detail.code)) ||
            /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|UND_ERR|timeout|timed out|fetch failed/i.test(`${detail.code} ${detail.message}`)) {
          this.connected = false;
          throw this.unreachableError(error);
        }
        cause = detail.cause;
      }
      throw error;
    }
  }

  unreachableError(cause: unknown): Error {
    const name = this.config.name || process.env.SUPER_MCP_APP_NAME || "Rebel";
    return new Error(`Your cloud isn't reachable, so ${name} is paused for now. It'll pick up again when the cloud's back.`, { cause });
  }

  async connect(): Promise<void> {
    await this.request(() => this.client.connect(this.transport, { timeout: 30_000 }));
    this.connected = true;
  }
  async listTools() {
    return this.request(async () => (await this.client.listTools()).tools);
  }
  async callTool(name: string, args: unknown) {
    // No replay after dispatch, even if the response is lost.
    return this.request(() => this.client.callTool({ name, arguments: args as Record<string, unknown> }, undefined, {
      timeout: this.config.timeout ?? Number(process.env.SUPER_MCP_TOOL_TIMEOUT || 14_400_000),
    }));
  }
  async listResources() {
    return this.request(() => this.client.listResources());
  }
  async readResource(uri: string) {
    return this.request(() => this.client.readResource({ uri }));
  }
  async healthCheck(): Promise<"ok" | "error"> {
    return this.connected ? "ok" : "error";
  }
  async close(): Promise<void> {
    await this.client.close();
    this.connected = false;
  }
}
