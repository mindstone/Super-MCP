import type { PackageConfig } from "../../src/types.js";

export const NOT_SETTLED = Symbol("not settled");

export const settledWithin = (call: Promise<unknown>, ms: number) => {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    call.then((value) => ({ value }), (error: unknown) => ({ error })),
    new Promise<typeof NOT_SETTLED>((resolve) => { timer = setTimeout(() => resolve(NOT_SETTLED), ms); }),
  ]).finally(() => clearTimeout(timer));
};

export const config = (url: string): PackageConfig => ({
  id: "acme", name: "Acme", transport: "http", base_url: url, visibility: "default",
} as PackageConfig);
