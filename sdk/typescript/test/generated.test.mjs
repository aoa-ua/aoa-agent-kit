import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import {
  generateSchemaModule,
  OUTPUT_PATH,
  SNAPSHOT_PATH,
  tsType,
} from '../scripts/generate-types.mjs';

const spec = JSON.parse(await readFile(SNAPSHOT_PATH, 'utf8'));

const specOperations = () =>
  Object.entries(spec.paths).flatMap(([path, item]) =>
    Object.entries(item)
      .filter(([, operation]) => operation?.operationId)
      .map(([method, operation]) => ({
        operationId: operation.operationId,
        method: method.toUpperCase(),
        path,
      })),
  );

describe('generator', () => {
  it('src/generated/schema.ts matches the snapshot', async () => {
    const current = await readFile(OUTPUT_PATH, 'utf8');
    assert.equal(current, generateSchemaModule(spec));
  });

  it('emits a method and a table row for every operation', () => {
    const source = generateSchemaModule(spec);
    for (const { operationId, method, path } of specOperations()) {
      assert.ok(source.includes(`  ${operationId}(params`), operationId);
      assert.ok(
        source.includes(`  ${operationId}: {\n    method: "${method}",\n    path: "${path}",`),
        `${operationId} table row`,
      );
    }
  });

  it('maps the JSON Schema subset used by the spec', () => {
    assert.equal(tsType({ type: ['string', 'null'] }), 'string | null');
    assert.equal(tsType({ type: 'boolean', const: true }), 'true');
    assert.equal(tsType({ enum: ['a', 'b'] }), '"a" | "b"');
    assert.equal(tsType({ type: 'array', items: { $ref: '#/components/schemas/Order' } }), 'Array<Order>');
    assert.equal(
      tsType({ allOf: [{ $ref: '#/components/schemas/Price' }, { type: 'object', properties: { id: { type: 'string' } } }] }),
      'Price & {\n  id?: string;\n}',
    );
    assert.equal(tsType({ type: 'object', additionalProperties: { type: 'integer' } }), '{\n  [key: string]: number;\n}');
    assert.equal(tsType({}), 'unknown');
  });

  it('adds new operations without SDK code changes', () => {
    const extended = structuredClone(spec);
    extended.paths['/things/{thingId}'] = {
      get: {
        operationId: 'getThing',
        parameters: [{ name: 'thingId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'string' } } } } } } },
      },
    };
    const source = generateSchemaModule(extended);
    assert.ok(source.includes('getThing(params: GetThingParams'));
    assert.ok(source.includes('export type GetThingResponse = {\n  data: string;\n};'));
  });

  it('refuses a param that is both a path param and a body field', () => {
    const broken = structuredClone(spec);
    broken.paths['/clash/{eventId}'] = {
      post: {
        operationId: 'clash',
        parameters: [{ name: 'eventId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { eventId: { type: 'string' } } } } } },
        responses: {},
      },
    };
    assert.throws(() => generateSchemaModule(broken), /eventId/);
  });
});
