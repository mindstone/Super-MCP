import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
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
      if (error instanceof StreamableHTTPError && (error.code === 401 || error.code === 404)) {
        this.connected = false;
        if (error.code === 401) throw new Error("Rebel couldn't reach your cloud with its current sign-in. It'll retry automatically.", { cause: error });
        throw error;
      }
      const failures = new Set<unknown>();
      let cause: unknown = error;
      while (cause && typeof cause === "object" && !failures.has(cause)) {
        failures.add(cause);
        const detail = cause as { code?: unknown; cause?: unknown };
        if ((cause instanceof StreamableHTTPError && cause.code !== undefined && [502, 503, 504].includes(cause.code)) ||
            (cause instanceof McpError && cause.code === ErrorCode.RequestTimeout &&
              cause.data !== null && typeof cause.data === "object" &&
              "timeout" in cause.data && typeof cause.data.timeout === "number") ||
            (typeof detail.code === "string" && /^(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPIPE|UND_ERR_.*)$/.test(detail.code))) {
          this.connected = false;
          throw this.unreachableError(error);
        }
        cause = detail.cause;
      }
      throw error;
    }
  }

  unreachableError(cause: unknown): Error {
    return new Error(`Your cloud isn't reachable, so ${this.config.name} is paused for now. It'll pick up again when the cloud's back.`, { cause });
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
