import Ajv from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { ERROR_CODES } from "./types.js";
import { getLogger } from "./logging.js";

// Upstream MCP servers hand us tool input schemas in whatever JSON Schema
// dialect they were written in. Ajv resolves a declared `$schema` against the
// meta-schemas its class knows and throws `no schema with key or ref` for one
// it does not — with a draft-07-only instance every Linear tool call (Linear
// declares draft 2020-12) failed as "Approved, but the action failed: no
// schema with key or ref https://json-schema.org/draft/2020-12/schema".
//
// Supported-dialect policy: draft-07 and UNDECLARED schemas validate on a
// draft-07 instance (the historical behaviour, incl. tuple-form `items: [...]`,
// which the 2020-12 class rejects); schemas that explicitly declare draft
// 2020-12 validate on an `Ajv2020` instance (native `prefixItems`, `$defs`,
// `unevaluatedProperties`). Routing by declaration — rather than one instance
// with an extra meta-schema — keeps each dialect's semantics intact. Other
// declared drafts (2019-09, 06, 04) still throw exactly as before; add a
// dedicated class + fixtures if an upstream ever needs one.
const DRAFT_2020_12_MARKER = "/draft/2020-12/";

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
  private readonly ajvDraft07: Ajv;
  private readonly ajv2020: Ajv2020;
  private injectedSchemaCache = new WeakMap<object, object>();

  constructor() {
    const options = {
      strict: false as const,  // allow unknown formats/keywords from upstream schemas
      allErrors: true,
      verbose: true,
    };
    this.ajvDraft07 = new Ajv(options);
    this.ajv2020 = new Ajv2020(options);
    // Standard formats (date, date-time, email, …) on both instances.
    addFormats(this.ajvDraft07);
    addFormats(this.ajv2020);
  }

  /** Pick the validator whose dialect matches the schema's own declaration. */
  private ajvFor(schema: { $schema?: unknown }): Ajv | Ajv2020 {
    const declared = typeof schema?.$schema === "string" ? schema.$schema : "";
    return declared.includes(DRAFT_2020_12_MARKER) ? this.ajv2020 : this.ajvDraft07;
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
      validate = this.ajvFor(effectiveSchema).compile(effectiveSchema);
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