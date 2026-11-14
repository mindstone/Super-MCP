/**
 * Keeps secrets from a connector's configuration out of text the model or a person reads (errors,
 * health advice, help). A person may put an API key anywhere in a connector's address (userinfo,
 * path, query, fragment), in a local connector's command and arguments, or in its environment and
 * headers, so only the parts that cannot hold one are shown.
 */
import type { PackageConfig } from "./types.js";

export function commandBasename(command: string): string {
  return command.split(/[\\/]/).pop() ?? "";
}

/** A local connector's program name only: no directory, no arguments. */
export function connectorCommandLabel(command: string | undefined): string {
  return commandBasename(command || "echo") || "configured executable";
}

/** A connector address's scheme, host and port only. */
export function connectorUrlLabel(url: string | undefined): string {
  if (!url) return "not set";
  try {
    const { origin } = new URL(url);
    return origin === "null" ? "configured address" : origin;
  } catch {
    return "configured address";
  }
}

const REDACTED = "[redacted]";
// Shorter pieces of configuration ("-y", "v1", "Bearer") are not keys, and replacing them everywhere
// would garble the text. Fields that are secrets by definition (an address's password, an OAuth
// client secret) are removed from a shorter length.
const MIN_SECRET_LENGTH = 8;
const MIN_DECLARED_SECRET_LENGTH = 4;

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** A value, and each piece of it split at separators, so "Bearer KEY" or "--key=KEY" yields KEY. */
function withPieces(value: string): string[] {
  return [value, ...value.split(/[\s=:,;&/?#@"'\\]+/)];
}

/**
 * A URL part's pieces, raw and decoded. Each piece is decoded on its own, so one malformed escape
 * elsewhere in the part does not stop the rest being decoded.
 */
function withEncodings(value: string): string[] {
  const pieces = [...withPieces(value), ...withPieces(safeDecode(value))];
  return pieces.flatMap((piece) => [piece, safeDecode(piece), encodeURIComponent(safeDecode(piece))]);
}

function urlCandidates(url: string): string[] {
  try {
    const parsed = new URL(url);
    const values = [
      parsed.username,
      parsed.pathname,
      parsed.search,
      parsed.hash,
      parsed.hash.slice(1),
      ...parsed.searchParams.values(),
    ];
    return values.flatMap(withEncodings);
  } catch {
    return withPieces(url);
  }
}

function declaredSecrets(config: PackageConfig): string[] {
  const secrets: string[] = [];
  if (config.oauthClientSecret) secrets.push(config.oauthClientSecret);
  if (config.base_url) {
    try {
      const { password } = new URL(config.base_url);
      if (password) secrets.push(...withEncodings(password));
    } catch {
      // Not a URL: urlCandidates covers its pieces.
    }
  }
  return secrets.filter((value) => value.length >= MIN_DECLARED_SECRET_LENGTH);
}

function secretCandidates(config: PackageConfig): string[] {
  const values = [
    ...(config.base_url ? urlCandidates(config.base_url) : []),
    ...(config.command ? withPieces(config.command) : []),
    ...(config.args ?? []).flatMap(withPieces),
    ...Object.values(config.env ?? {}).flatMap(withPieces),
    ...Object.values(config.extra_headers ?? {}).flatMap(withPieces),
  ].filter((value) => value.length >= MIN_SECRET_LENGTH);
  // The connector's id, name and program name say which connector failed; a value they contain is
  // not secret.
  const program = config.command ? connectorCommandLabel(config.command) : "";
  return [...values, ...declaredSecrets(config)].filter(
    (value) => !config.id.includes(value) && !config.name.includes(value) && !program.includes(value),
  );
}

/**
 * Removes every secret-bearing value of the connectors' configuration from text: a full address
 * becomes its origin, a full command its program name, and any part of the address, command
 * directory, argument, environment value or header value becomes "[redacted]". Connector ids and
 * names are not secrets, so the text still says which connector failed.
 */
export function redactConnectorSecrets(text: string, configs: PackageConfig | readonly PackageConfig[]): string {
  const list = Array.isArray(configs) ? configs : [configs as PackageConfig];
  let result = text;
  const replace = (value: string | undefined, label: string) => {
    if (value && value !== label) result = result.split(value).join(label);
  };

  // Whole values first, so a full address or command keeps a readable label.
  for (const config of list) {
    if (config.base_url) {
      const label = connectorUrlLabel(config.base_url);
      replace(config.base_url, label);
      try {
        replace(new URL(config.base_url).href, label);
      } catch {
        // Not a URL: its pieces are removed below.
      }
    }
    if (config.command) replace(config.command, connectorCommandLabel(config.command));
  }

  // Longest first, so a value that contains another is removed whole.
  const secrets = [...new Set(list.flatMap(secretCandidates))].sort((a, b) => b.length - a.length);
  for (const secret of secrets) replace(secret, REDACTED);
  return result;
}

/** Applies redactConnectorSecrets to every string in an error's message and data. */
export function redactConnectorSecretsDeep<T>(value: T, configs: readonly PackageConfig[]): T {
  if (typeof value === "string") return redactConnectorSecrets(value, configs) as T;
  if (Array.isArray(value)) return value.map((item) => redactConnectorSecretsDeep(item, configs)) as T;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactConnectorSecretsDeep(item, configs)]),
    ) as T;
  }
  return value;
}
