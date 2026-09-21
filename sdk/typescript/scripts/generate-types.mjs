#!/usr/bin/env node
/**
 * Generates `src/generated/schema.ts` from the AOA OpenAPI 3.1 spec.
 *
 * Usage:
 *   node scripts/generate-types.mjs            # regenerate from openapi.snapshot.json
 *   node scripts/generate-types.mjs --fetch    # download the live spec, update the snapshot, regenerate
 *   node scripts/generate-types.mjs --fetch=https://example.test/openapi.json
 *   node scripts/generate-types.mjs --check    # exit 1 if the generated file is stale
 *
 * No dependencies: the spec uses a small JSON Schema subset ($ref, allOf,
 * enum, const, nullable type arrays, objects, arrays), and this file maps
 * exactly that subset to TypeScript. An unsupported construct becomes
 * `unknown` rather than a wrong type.
 *
 * Adding an endpoint to the API needs no SDK code: run `--fetch`, and the
 * new operation appears as a typed method named after its operationId.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SNAPSHOT_PATH = path.join(ROOT, 'openapi.snapshot.json');
export const OUTPUT_PATH = path.join(ROOT, 'src', 'generated', 'schema.ts');
const DEFAULT_SPEC_URL = 'https://aoa.com.ua/openapi.json';
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Enums that get a named type instead of an inline union, keyed by the JSON
 * of their values. Filled per run in `generateSchemaModule`.
 */
let namedEnums = new Map();

/**
 * Gaps in the published spec that the API already implements. Each patch
 * applies only while the gap exists, so it becomes a no-op once the spec is
 * fixed upstream. Keep this list short and explain every entry.
 */
const SPEC_PATCHES = [
  {
    operationId: 'updateWebhook',
    // PATCH /webhooks/{endpointId} reads `isActive` and `events` from a JSON
    // body, but the spec declares no requestBody for it.
    apply: (operation, spec) => {
      if (operation.requestBody) return;
      const eventsSchema = findWebhookEventsSchema(spec) ?? {
        type: 'array',
        items: { type: 'string' },
      };
      operation.requestBody = {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                isActive: {
                  type: 'boolean',
                  description:
                    'Enable or disable delivery. Enabling also resets the failure counter.',
                },
                events: {
                  ...eventsSchema,
                  description: 'Replaces the subscribed event types.',
                },
              },
            },
          },
        },
      };
    },
  },
];

const pascalCase = (value) =>
  value.replace(/(^|[^A-Za-z0-9])([A-Za-z0-9])/g, (_, __, char) =>
    char.toUpperCase(),
  );

const propertyKey = (name) =>
  IDENTIFIER.test(name) ? name : JSON.stringify(name);

const refName = (ref) => {
  const match = /^#\/components\/schemas\/(.+)$/.exec(ref);
  if (!match) throw new Error(`Unsupported $ref: ${ref}`);
  return pascalCase(match[1]);
};

const resolveRef = (spec, value) => {
  if (!value?.$ref) return value;
  const segments = value.$ref.replace(/^#\//, '').split('/');
  let node = spec;
  for (const segment of segments) node = node?.[segment];
  if (!node) throw new Error(`Cannot resolve ${value.$ref}`);
  return resolveRef(spec, node);
};

const findWebhookEventsSchema = (spec) => {
  for (const pathItem of Object.values(spec.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (operation?.operationId !== 'createWebhook') continue;
      const schema =
        operation.requestBody?.content?.['application/json']?.schema;
      return schema?.properties?.events;
    }
  }
  return undefined;
};

/** True when a union or intersection sits at the top level of `type`. */
const needsParens = (type) => {
  let depth = 0;
  for (let i = 0; i < type.length; i += 1) {
    const char = type[i];
    if ('{(<['.includes(char)) depth += 1;
    else if ('})>]'.includes(char)) depth -= 1;
    else if (depth === 0 && (char === '|' || char === '&')) return true;
  }
  return false;
};

const wrap = (type) => (needsParens(type) ? `(${type})` : type);

const list = (values) =>
  `[${values.map((value) => JSON.stringify(value)).join(', ')}]`;

const escapeComment = (text) => String(text).replace(/\*\//g, '*\\/');

/** JSDoc lines for a schema: description plus the constraints worth seeing. */
const docLines = (schema, indent) => {
  if (!schema || typeof schema !== 'object' || schema.$ref) return [];
  const notes = [];
  if (schema.description) notes.push(...String(schema.description).split('\n'));
  const constraints = [];
  if (schema.format) constraints.push(`format ${schema.format}`);
  if (schema.minimum !== undefined) constraints.push(`min ${schema.minimum}`);
  if (schema.maximum !== undefined) constraints.push(`max ${schema.maximum}`);
  if (schema.minLength !== undefined)
    constraints.push(`minLength ${schema.minLength}`);
  if (schema.maxLength !== undefined)
    constraints.push(`maxLength ${schema.maxLength}`);
  if (schema.minItems !== undefined)
    constraints.push(`minItems ${schema.minItems}`);
  if (schema.maxItems !== undefined)
    constraints.push(`maxItems ${schema.maxItems}`);
  if (schema.pattern) constraints.push(`pattern ${schema.pattern}`);
  if (constraints.length) notes.push(constraints.join(', '));
  if (schema.default !== undefined)
    notes.push(`@default ${JSON.stringify(schema.default)}`);
  if (schema.example !== undefined)
    notes.push(`@example ${JSON.stringify(schema.example)}`);
  if (!notes.length) return [];
  if (notes.length === 1) return [`${indent}/** ${escapeComment(notes[0])} */`];
  return [
    `${indent}/**`,
    ...notes.map((line) => `${indent} * ${escapeComment(line)}`.trimEnd()),
    `${indent} */`,
  ];
};

const objectType = (schema, indent) => {
  const inner = `${indent}  `;
  const required = new Set(schema.required ?? []);
  const lines = [];
  const properties = Object.entries(schema.properties ?? {});
  for (const [name, property] of properties) {
    lines.push(...docLines(property, inner));
    const optional = required.has(name) ? '' : '?';
    lines.push(
      `${inner}${propertyKey(name)}${optional}: ${tsType(property, inner)};`,
    );
  }
  const extra = schema.additionalProperties;
  if (extra && typeof extra === 'object') {
    // An index signature must accept every declared property type too.
    const valueType = properties.length ? 'unknown' : tsType(extra, inner);
    lines.push(`${inner}[key: string]: ${valueType};`);
  }
  if (!lines.length) {
    return extra === false ? 'Record<string, never>' : 'Record<string, unknown>';
  }
  return `{\n${lines.join('\n')}\n${indent}}`;
};

export const tsType = (schema, indent = '') => {
  if (!schema || typeof schema !== 'object') return 'unknown';
  if (schema.$ref) return refName(schema.$ref);
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (Array.isArray(schema.enum)) {
    const named = namedEnums.get(JSON.stringify(schema.enum));
    if (named) return named;
    return schema.enum.map((value) => JSON.stringify(value)).join(' | ');
  }
  if (Array.isArray(schema.allOf)) {
    return schema.allOf.map((part) => wrap(tsType(part, indent))).join(' & ');
  }
  const variants = schema.oneOf ?? schema.anyOf;
  if (Array.isArray(variants)) {
    return variants.map((part) => wrap(tsType(part, indent))).join(' | ');
  }
  const types = Array.isArray(schema.type)
    ? schema.type
    : schema.type
      ? [schema.type]
      : [];
  if (types.length > 1) {
    return types
      .map((type) => wrap(tsType({ ...schema, type }, indent)))
      .join(' | ');
  }
  switch (types[0]) {
    case 'string':
      return 'string';
    case 'integer':
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    case 'array':
      return `Array<${tsType(schema.items, indent)}>`;
    case 'object':
      return objectType(schema, indent);
    default:
      return schema.properties ? objectType(schema, indent) : 'unknown';
  }
};

const isPlainObjectSchema = (schema) =>
  schema &&
  !schema.$ref &&
  !schema.allOf &&
  !schema.oneOf &&
  !schema.anyOf &&
  (schema.type === 'object' || (!schema.type && schema.properties)) &&
  Object.keys(schema.properties ?? {}).length > 0;

/**
 * The success envelope always carries `data` (see the API's `apiOk`), but
 * some inline response schemas in the spec forget to mark it required.
 */
const requireEnvelopeData = (schema) => {
  if (!schema || schema.$ref || !schema.properties?.data) return schema;
  const required = new Set(schema.required ?? []);
  required.add('data');
  return { ...schema, required: [...required] };
};

const collectOperations = (spec) => {
  const operations = [];
  for (const [apiPath, pathItem] of Object.entries(spec.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!operation?.operationId) continue;
      for (const patch of SPEC_PATCHES) {
        if (patch.operationId === operation.operationId) {
          patch.apply(operation, spec);
        }
      }
      const parameters = [
        ...(pathItem.parameters ?? []),
        ...(operation.parameters ?? []),
      ].map((parameter) => resolveRef(spec, parameter));

      const pathParams = parameters.filter((p) => p.in === 'path');
      const queryParams = parameters.filter((p) => p.in === 'query');
      const idempotencyHeader = parameters.find(
        (p) => p.in === 'header' && p.name.toLowerCase() === 'idempotency-key',
      );

      const requestBody = resolveRef(spec, operation.requestBody);
      const bodySchema = requestBody?.content?.['application/json']?.schema;
      const resolvedBody = bodySchema ? resolveRef(spec, bodySchema) : null;
      const bodyMode = !bodySchema
        ? 'none'
        : isPlainObjectSchema(resolvedBody)
          ? 'flat'
          : 'wrapped';

      const responses = [];
      for (const [status, rawResponse] of Object.entries(
        operation.responses ?? {},
      )) {
        if (!/^2\d\d$/.test(status)) continue;
        const response = resolveRef(spec, rawResponse);
        const schema = response?.content?.['application/json']?.schema;
        if (schema) responses.push({ status, schema: requireEnvelopeData(schema) });
      }

      const security = operation.security ?? spec.security ?? [];
      const requiresAuth =
        security.length > 0 &&
        security.every((requirement) => Object.keys(requirement).length > 0);

      operations.push({
        operationId: operation.operationId,
        method: method.toUpperCase(),
        path: apiPath,
        summary: operation.summary,
        description: operation.description,
        pathParams,
        queryParams,
        idempotencyKey: idempotencyHeader
          ? idempotencyHeader.required
            ? 'required'
            : 'optional'
          : 'none',
        bodySchema,
        resolvedBody,
        bodyRequired: Boolean(requestBody?.required),
        bodyMode,
        responses,
        requiresAuth,
        deprecated: Boolean(operation.deprecated),
      });
    }
  }
  return operations;
};

const parameterSchema = (parameter) => ({
  ...(parameter.schema ?? { type: 'string' }),
  ...(parameter.description ? { description: parameter.description } : {}),
});

/** Params = path params + query params + (flat) body fields, one object. */
const paramsDeclaration = (operation, name) => {
  const properties = {};
  const required = [];
  const origin = new Map();
  const add = (key, schema, isRequired, source) => {
    if (origin.has(key)) {
      throw new Error(
        `${operation.operationId}: parameter "${key}" appears in both ${origin.get(key)} and ${source}; flat params cannot represent this`,
      );
    }
    origin.set(key, source);
    properties[key] = schema;
    if (isRequired) required.push(key);
  };
  for (const parameter of operation.pathParams) {
    add(parameter.name, parameterSchema(parameter), true, 'path');
  }
  for (const parameter of operation.queryParams) {
    add(
      parameter.name,
      parameterSchema(parameter),
      Boolean(parameter.required),
      'query',
    );
  }

  let tail = '';
  if (operation.bodyMode === 'flat') {
    if (operation.bodySchema.$ref) {
      for (const key of Object.keys(operation.resolvedBody.properties ?? {})) {
        if (origin.has(key)) {
          throw new Error(
            `${operation.operationId}: body field "${key}" collides with a ${origin.get(key)} parameter`,
          );
        }
      }
      tail = ` & ${refName(operation.bodySchema.$ref)}`;
    } else {
      const bodyRequired = new Set(operation.resolvedBody.required ?? []);
      for (const [key, schema] of Object.entries(
        operation.resolvedBody.properties,
      )) {
        add(key, schema, bodyRequired.has(key), 'body');
      }
    }
  } else if (operation.bodyMode === 'wrapped') {
    add('body', operation.bodySchema, operation.bodyRequired, 'body');
  }

  const hasRequired =
    required.length > 0 ||
    (operation.bodyMode === 'flat' &&
      operation.bodySchema.$ref &&
      (operation.resolvedBody.required ?? []).length > 0);
  const objectSchema = { type: 'object', properties, required };
  const base = Object.keys(properties).length
    ? tsType(objectSchema)
    : 'Record<string, never>';
  const declaration =
    tail || !Object.keys(properties).length
      ? `export type ${name} = ${base}${tail};`
      : `export interface ${name} ${base}`;
  return { declaration, hasRequired };
};

const operationDoc = (operation) => {
  const lines = [];
  if (operation.summary) lines.push(operation.summary);
  if (operation.description) lines.push('', ...operation.description.split('\n'));
  lines.push(
    '',
    `\`${operation.method} ${operation.path}\` · ${operation.requiresAuth ? 'requires an API key' : 'no API key needed'}${operation.idempotencyKey === 'required' ? ' · Idempotency-Key is generated when not given' : ''}`,
  );
  if (operation.deprecated) lines.push('@deprecated');
  return [
    '  /**',
    ...lines.map((line) => `   * ${escapeComment(line)}`.trimEnd()),
    '   */',
  ];
};

export const generateSchemaModule = (inputSpec) => {
  const spec = structuredClone(inputSpec);
  const operations = collectOperations(spec);
  if (!operations.length) throw new Error('The spec has no operations');

  const webhookEvents = findWebhookEventsSchema(spec)?.items?.enum;
  namedEnums = new Map(
    webhookEvents?.length
      ? [[JSON.stringify(webhookEvents), 'WebhookEventType']]
      : [],
  );

  const out = [];
  out.push(
    '/**',
    ' * AUTO-GENERATED by scripts/generate-types.mjs from openapi.snapshot.json.',
    ' * Do not edit by hand: run `npm run generate` (or `npm run generate:fetch`).',
    ' */',
    '/* eslint-disable */',
    '',
    "import type { RequestOptions } from '../options.js';",
    '',
    `/** \`info.version\` of the spec these types were generated from. */`,
    `export const API_SPEC_VERSION = ${JSON.stringify(spec.info?.version ?? 'unknown')};`,
    '',
    `/** Default server from the spec. */`,
    `export const SPEC_SERVER_URL = ${JSON.stringify(spec.servers?.[0]?.url ?? 'https://aoa.com.ua/api/v1')};`,
    '',
    '// ─── Schemas ────────────────────────────────────────────────────────────────',
    '',
  );

  for (const [schemaName, schema] of Object.entries(
    spec.components?.schemas ?? {},
  )) {
    const name = pascalCase(schemaName);
    out.push(...docLines(schema, ''));
    if (isPlainObjectSchema(schema)) {
      out.push(`export interface ${name} ${tsType(schema)}`, '');
    } else {
      out.push(`export type ${name} = ${tsType(schema)};`, '');
    }
  }

  out.push(
    '/** Webhook event types accepted by `createWebhook`. */',
    webhookEvents?.length
      ? `export const WEBHOOK_EVENT_TYPES = ${list(webhookEvents)} as const;`
      : 'export const WEBHOOK_EVENT_TYPES = [] as readonly string[];',
    '',
    'export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];',
    '',
    '// ─── Operations ─────────────────────────────────────────────────────────────',
    '',
  );

  const methodLines = [];
  const typeMapLines = [];
  const tableLines = [];

  for (const operation of operations) {
    const base = pascalCase(operation.operationId);
    const paramsName = `${base}Params`;
    const responseName = `${base}Response`;
    const { declaration, hasRequired } = paramsDeclaration(
      operation,
      paramsName,
    );
    out.push(
      `/** Parameters of \`${operation.operationId}\` (path, query and body fields in one object). */`,
      declaration,
      '',
    );
    const responseType = operation.responses.length
      ? operation.responses
          .map((response) => wrap(tsType(response.schema)))
          .join(' | ')
      : 'unknown';
    out.push(
      `/** Success body of \`${operation.operationId}\` (${operation.responses.map((r) => r.status).join(', ') || 'no JSON'}). */`,
      `export type ${responseName} = ${responseType};`,
      '',
    );

    const optional = hasRequired ? '' : '?';
    methodLines.push(
      ...operationDoc(operation),
      `  ${operation.operationId}(params${optional}: ${paramsName}, options?: RequestOptions): Promise<${responseName}>;`,
    );
    typeMapLines.push(
      `  ${operation.operationId}: { params: ${paramsName}; response: ${responseName} };`,
    );
    tableLines.push(
      `  ${operation.operationId}: {`,
      `    method: ${JSON.stringify(operation.method)},`,
      `    path: ${JSON.stringify(operation.path)},`,
      `    pathParams: ${list(operation.pathParams.map((p) => p.name))},`,
      `    queryParams: ${list(operation.queryParams.map((p) => p.name))},`,
      `    body: ${JSON.stringify(operation.bodyMode)},`,
      `    idempotencyKey: ${JSON.stringify(operation.idempotencyKey)},`,
      `    requiresAuth: ${operation.requiresAuth},`,
      '  },',
    );
  }

  out.push(
    '/** Runtime description of every operation; the client is built from it. */',
    'export interface OperationSpec {',
    "  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';",
    '  path: string;',
    '  pathParams: readonly string[];',
    '  queryParams: readonly string[];',
    "  /** `flat`: body fields sit next to path/query params; `wrapped`: under `body`. */",
    "  body: 'none' | 'flat' | 'wrapped';",
    "  idempotencyKey: 'none' | 'optional' | 'required';",
    '  requiresAuth: boolean;',
    '}',
    '',
    'export const OPERATIONS = {',
    ...tableLines,
    '} as const satisfies Record<string, OperationSpec>;',
    '',
    'export type OperationId = keyof typeof OPERATIONS;',
    '',
    'export interface OperationTypes {',
    ...typeMapLines,
    '}',
    '',
    '/** One typed method per operationId. */',
    'export interface OperationMethods {',
    ...methodLines,
    '}',
    '',
  );

  return out.join('\n');
};

const fetchSpec = async (url) => {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`GET ${url} failed with HTTP ${response.status}`);
  }
  return response.json();
};

const main = async () => {
  const args = process.argv.slice(2);
  const fetchArg = args.find((arg) => arg.startsWith('--fetch'));
  const check = args.includes('--check');

  let spec;
  if (fetchArg) {
    const url = fetchArg.includes('=')
      ? fetchArg.slice(fetchArg.indexOf('=') + 1)
      : DEFAULT_SPEC_URL;
    spec = await fetchSpec(url);
    await writeFile(SNAPSHOT_PATH, `${JSON.stringify(spec, null, 2)}\n`);
    console.log(`Snapshot updated from ${url}`);
  } else {
    spec = JSON.parse(await readFile(SNAPSHOT_PATH, 'utf8'));
  }

  const source = generateSchemaModule(spec);
  if (check) {
    const current = await readFile(OUTPUT_PATH, 'utf8').catch(() => '');
    if (current !== source) {
      console.error(
        'src/generated/schema.ts is stale: run `npm run generate` and commit the result.',
      );
      process.exit(1);
    }
    console.log('src/generated/schema.ts is up to date.');
    return;
  }
  await writeFile(OUTPUT_PATH, source);
  console.log(`Wrote ${path.relative(ROOT, OUTPUT_PATH)}`);
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
