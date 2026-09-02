import { createRequire } from "node:module";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { ERROR_CODES } from "./types.js";
import { getLogger } from "./logging.js";

// Upstream MCP servers hand us tool input schemas in whatever JSON Schema
// dialect they were written in. Linear's declare `$schema: draft/2020-12`;
// most others declare draft-07 or nothing. Ajv resolves a declared `$schema`
// against its registered meta-schemas and throws `no schema with key or ref`
// for one it does not know — with a draft-07-only instance every Linear tool
// call failed as "Approved, but the action failed: no schema with key or ref
// https://json-schema.org/draft/2020-12/schema". Use the 2020-12 class and
// register the draft-07 meta-schema so both dialects (and undeclared
// schemas) compile. The meta-schema is CJS JSON; createRequire avoids ESM
// JSON-import attributes (same pattern as installGracefulFs / tokenRefreshLock).
const requireFn = createRequire(import.meta.url);
const draft7MetaSchema = requireFn("ajv/dist/refs/json-schema-draft-07.json");

const logger = getLogger();

export class ValidationError extends Error {
  code: number;
  errors: any[];
  strippedArgs: string[];
  
  constructor(message: string, errors: any[], strippedArgs: string[] = []) {
    super(message);
    this.name = "ValidationError";
    this.code = ERROR_CODES.ARG_VALIDATION_FAILED;
    this.errors = errors;
    this.strippedArgs = strippedArgs;
  }
}

export interface ValidationResult {
  valid: boolean;
  errors: any[];
  strippedArgs: string[];
}

export class Validator {
  private ajv: Ajv2020;
  private injectedSchemaCache = new WeakMap<object, object>();

  constructor() {
    this.ajv = new Ajv2020({
      strict: false,  // Changed to false to allow unknown formats
      allErrors: true,
      verbose: true,
    });
    // Draft-07 schemas (the common case) must keep compiling on the 2020-12 class.
    this.ajv.addMetaSchema(draft7MetaSchema);

    // Add support for standard formats like date, date-time, email, etc.
    addFormats(this.ajv);
  }

  /** Validates data against schema. Mutates `data` in place to strip unknown
   *  top-level properties when `additionalProperties: false`. Returns validation
   *  status, Ajv errors, and names of stripped properties. */
  validate(schema: any, data: any, context?: { package_id?: string; tool_id?: string }): ValidationResult {
    logger.debug("Validating arguments", {
      package_id: context?.package_id,
      tool_id: context?.tool_id,
      schema_keys: schema ? Object.keys(schema) : [],
      data_keys: typeof data === "object" && data ? Object.keys(data) : [],
    });

    if (!schema) {
      throw new ValidationError("Schema is required", []);
    }

    // Inject additionalProperties: false for schemas that omit it.
    // Uses WeakMap cache to preserve Ajv's internal compiled-schema cache.
    let effectiveSchema = schema;
    if (
      schema.properties &&
      !("additionalProperties" in schema) &&
      !schema.oneOf &&
      !schema.allOf &&
      !schema.anyOf &&
      !schema.patternProperties
    ) {
      const cached = this.injectedSchemaCache.get(schema);
      if (cached) {
        effectiveSchema = cached;
      } else {
        effectiveSchema = { ...schema, additionalProperties: false };
        this.injectedSchemaCache.set(schema, effectiveSchema);
      }
    }

    // Strip unknown top-level properties so Ajv validates only known fields.
    // The caller (useTool handler) rejects when strippedArgs.length > 0.
    const strippedArgs: string[] = [];
    if (
      effectiveSchema.additionalProperties === false &&
      effectiveSchema.properties &&
      typeof data === 'object' &&
      data !== null
    ) {
      const allowed = new Set(Object.keys(effectiveSchema.properties));
      for (const key of Object.keys(data)) {
        if (!allowed.has(key)) {
          strippedArgs.push(key);
          delete data[key];
        }
      }
      if (strippedArgs.length > 0) {
        logger.warn("Detected unknown properties in tool args", {
          package_id: context?.package_id,
          tool_id: context?.tool_id,
          stripped: strippedArgs,
        });
      }
    }

    // Compile schema with better error handling for format issues
    let validate;
    try {
      validate = this.ajv.compile(effectiveSchema);
    } catch (error) {
      logger.warn("Schema compilation warning", {
        package_id: context?.package_id,
        tool_id: context?.tool_id,
        error: error instanceof Error ? error.message : String(error),
        hint: "This might be due to custom formats in the schema"
      });
      // Re-throw to maintain existing behavior
      throw error;
    }
    
    const valid = validate(data);
    const errors = validate.errors || [];

    if (!valid) {
      logger.warn("Validation failed", {
        package_id: context?.package_id,
        tool_id: context?.tool_id,
        errors: errors.map(err => ({
          instancePath: err.instancePath,
          schemaPath: err.schemaPath,
          keyword: err.keyword,
          message: err.message,
        })),
      });

      return {
        valid: false,
        errors,
        strippedArgs,
      };
    }

    logger.debug("Validation passed", {
      package_id: context?.package_id,
      tool_id: context?.tool_id,
    });

    return {
      valid: true,
      errors,
      strippedArgs,
    };
  }
}

let validator: Validator;

export function getValidator(): Validator {
  if (!validator) {
    validator = new Validator();
  }
  return validator;
}