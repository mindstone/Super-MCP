import os from 'node:os';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { getToolTimeout, type McpClient, type PackageConfig } from './types.js';
import { getWorkspacePath } from './forwardedFiles.js';
import { expandReadInputs, getReadInputs, replaceReadLocations, type InputBases } from './fileReadInputs.js';
import { assertDispatchActive, authorizeReads, childCallContext, hasReadAuthority, type ToolDispatchContext, type ChildToolCallContext } from './fileReadProtocol.js';
import { getLogger } from './logging.js';

/** Child cwd: physical on POSIX (.native keeps symlink/..), normalized spelling on Windows. */
export function childProcessCwd(configured: string | undefined, platform: NodeJS.Platform = process.platform): string {
  if (!configured) return process.cwd();
  if (platform === 'win32') return path.resolve(configured);
  try { return realpathSync.native(configured); } catch (error) {
    // No child can start there, so its spawn error is the one that reports this.
    getLogger().warn('Connector cwd could not be resolved', { code: (error as NodeJS.ErrnoException).code });
    return path.resolve(configured);
  }
}

/** Only local subprocess declarations can describe files on this filesystem. */
export async function preflightLocalTool(client: McpClient, config: PackageConfig, name: string, args: unknown, context: ToolDispatchContext): Promise<{ args: unknown; context: ChildToolCallContext }> {
  assertDispatchActive(context);
  if (config.transport !== 'stdio') return { args, context: childCallContext(context) };
  const mode = { version: 1 as const, mode: 'standalone' as const };
  const central = hasReadAuthority(context);
  if (!central && config.cwd) return { args, context: childCallContext(context, mode) };
  const bases = effectiveInputBases(config, client);
  // Input defaults are separate from the captured process cwd and other reader bases.
  const workspace = bases.workspace?.trim();
  const connectorInputBase = !config.cwd && workspace ? path.resolve(bases.connectorCwd, workspace) : bases.connectorCwd;
  if (!central && connectorInputBase === bases.connectorCwd) return { args, context: childCallContext(context, mode) };
  const declaration = getReadInputs(await client.getToolMetadata?.(name));
  const selected = declaration && (central ? declaration : { ...declaration, inputs: declaration.inputs.filter(input =>
    input.base === 'connectorCwd' || input.base === 'connectorCwdNative') });
  const operands = selected ? await expandReadInputs(args, selected, bases, connectorInputBase, central) : [];
  if (!central) {
    const relative = operands.filter(operand => !path.parse(operand.rawPath).root);
    const executionArgs = relative.length ? replaceReadLocations(args, relative, operand => operand.resolvedPath) : args;
    assertDispatchActive(context);
    return { args: executionArgs, context: childCallContext(context, mode) };
  }
  const reads = operands.length ? await authorizeReads(operands, context, getToolTimeout(config)) : [];
  assertDispatchActive(context);
  // Central readers bind the original raw strings to the host's canonical paths.
  return { args, context: childCallContext(context, { version: 1, mode: 'central', reads }) };
}

/** Match the cwd and environment actually used by local subprocesses. */
export function effectiveInputBases(config: PackageConfig, client?: McpClient): InputBases {
  const captured = client?.getFileInputBases?.();
  if (captured) return captured;
  const workspace = getWorkspacePath();
  const env = { ...getDefaultEnvironment(), ...config.env,
    ...(workspace ? { MCP_WORKSPACE_PATH: workspace } : {}),
  };
  return calculateInputBases(childProcessCwd(config.cwd), env, process.platform, os.homedir());
}

/** Pure calculation from the effective child environment, shared by capture and fallback. */
export function calculateInputBases(connectorCwd: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform, fallbackHome: string): InputBases {
  return {
    connectorCwd,
    workspace: env.MCP_WORKSPACE_PATH?.trim(),
    // Node's os.homedir() consults USERPROFILE on Windows, HOME on POSIX.
    home: (platform === 'win32' ? env.USERPROFILE : env.HOME) ?? fallbackHome,
    temp: platform === 'win32' ? env.TEMP || env.TMP || (env.SYSTEMROOT || env.SystemRoot || env.windir) + '\\temp'
      : env.TMPDIR || env.TMP || env.TEMP || '/tmp',
  };
}
