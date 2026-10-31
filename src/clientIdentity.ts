/**
 * The name this router gives to outside services: the OAuth client name a
 * provider's consent screen and connected-apps list show (RFC 7591 dynamic
 * client registration), and the `clientInfo` an MCP server sees in `initialize`.
 *
 * A host app sets its own identity through the environment (the same
 * `SUPER_MCP_APP_NAME` that brands the callback page). Unset, the router
 * identifies as "super-mcp-router", so other users of this package see no change.
 *
 * A client registered before a host set its name keeps the old name at the
 * provider until it is re-registered; nothing here forces that.
 */

const DEFAULT_CLIENT_NAME = "super-mcp-router";
const CLIENT_VERSION = "0.1.0";

function envValue(key: string): string | undefined {
  const value = process.env[key]?.trim();
  return value ? value : undefined;
}

/** `clientInfo` for an MCP `Client`. */
export function getMcpClientInfo(): { name: string; version: string } {
  return { name: envValue("SUPER_MCP_APP_NAME") ?? DEFAULT_CLIENT_NAME, version: CLIENT_VERSION };
}

/**
 * Identity fields for an OAuth client registration. `client_uri` and `logo_uri`
 * are sent only when the host sets them, and must be public https URLs: a
 * provider fetches them to render its consent screen.
 */
export function getOAuthClientIdentity(): { client_name: string; client_uri?: string; logo_uri?: string } {
  const clientUri = envValue("SUPER_MCP_APP_URL");
  const logoUri = envValue("SUPER_MCP_APP_LOGO_URL");
  return {
    client_name: getMcpClientInfo().name,
    ...(clientUri && { client_uri: clientUri }),
    ...(logoUri && { logo_uri: logoUri }),
  };
}
