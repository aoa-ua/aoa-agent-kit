#!/usr/bin/env node
/**
 * Consistency checks for the kit, no dependencies:
 *  - every skills/<dir>/SKILL.md has frontmatter valid for the Agent Skills
 *    spec (agentskills.io): name = directory, 1..64 [a-z0-9-], description
 *    1..1024 chars, and plain-scalar-safe YAML;
 *  - plugin.json and mcp.json follow the closed Agent Plugins 1.0.0 schemas;
 *  - every operation of the OpenAPI snapshot has a method in all three SDKs.
 *
 * Run: node scripts/validate-kit.mjs
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const fail = (message) => errors.push(message);
const read = (relative) => readFile(path.join(ROOT, relative), 'utf8');

const SKILL_NAME = /^(?!.*--)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const PLUGIN_NAME = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

/** Top-level `key: value` pairs of a YAML frontmatter block. */
const parseFrontmatter = (text, file) => {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) {
    fail(`${file}: missing YAML frontmatter`);
    return {};
  }
  const fields = {};
  for (const line of match[1].split('\n')) {
    if (/^\s/.test(line) || !line.trim()) continue; // nested map lines
    const separator = line.indexOf(':');
    if (separator === -1) {
      fail(`${file}: cannot parse frontmatter line "${line}"`);
      continue;
    }
    fields[line.slice(0, separator)] = line.slice(separator + 1).trim();
  }
  return fields;
};

const checkPlainScalar = (value, where) => {
  if (value.includes(': ')) fail(`${where}: contains ": " (breaks a YAML plain scalar)`);
  if (value.includes(' #')) fail(`${where}: contains " #" (starts a YAML comment)`);
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(value)) {
    fail(`${where}: starts with a YAML indicator character`);
  }
};

const checkSkills = async () => {
  const entries = await readdir(path.join(ROOT, 'skills'), { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory());
  if (directories.length === 0) fail('skills/: no skills found');
  for (const directory of directories) {
    const file = `skills/${directory.name}/SKILL.md`;
    const text = await read(file).catch(() => null);
    if (text === null) {
      fail(`${file}: missing`);
      continue;
    }
    const { name, description, license } = parseFrontmatter(text, file);
    if (name !== directory.name) fail(`${file}: name "${name}" must equal the directory name`);
    if (!name || name.length > 64 || !SKILL_NAME.test(name)) fail(`${file}: invalid name "${name}"`);
    if (!description) fail(`${file}: description is required`);
    else {
      if (description.length > 1024) fail(`${file}: description is ${description.length} chars (max 1024)`);
      checkPlainScalar(description, `${file} description`);
    }
    if (!license) fail(`${file}: license is recommended for published skills`);
    const lines = text.split('\n').length;
    if (lines > 500) fail(`${file}: ${lines} lines (keep SKILL.md under 500)`);
    for (const [, target] of text.matchAll(/\]\((?!https?:)([^)#]+)\)/g)) {
      const resolved = path.join(ROOT, 'skills', directory.name, target);
      if (!(await stat(resolved).catch(() => null))) fail(`${file}: broken link ${target}`);
    }
  }
};

const checkPlugin = async () => {
  const manifest = JSON.parse(await read('plugin.json'));
  const allowed = new Set(['$schema', 'name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'extensions']);
  for (const key of Object.keys(manifest)) {
    if (!allowed.has(key)) fail(`plugin.json: unknown top-level field "${key}"`);
  }
  if (manifest.$schema !== 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json') {
    fail('plugin.json: $schema must be the Agent Plugins 1.0.0 identifier');
  }
  if (typeof manifest.name !== 'string' || manifest.name.length > 64 || !PLUGIN_NAME.test(manifest.name)) {
    fail(`plugin.json: invalid name "${manifest.name}"`);
  }
  for (const key of Object.keys(manifest.author ?? {})) {
    if (!['name', 'email', 'url'].includes(key)) fail(`plugin.json: author.${key} is not allowed`);
  }

  const mcp = JSON.parse(await read('mcp.json'));
  if (mcp.$schema !== 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json') {
    fail('mcp.json: $schema must be the Agent Plugins 1.0.0 MCP identifier');
  }
  for (const key of Object.keys(mcp)) {
    if (!['$schema', 'mcpServers'].includes(key)) fail(`mcp.json: unknown top-level field "${key}"`);
  }
  for (const [name, server] of Object.entries(mcp.mcpServers ?? {})) {
    if (server.type !== 'streamable-http') continue;
    for (const key of Object.keys(server)) {
      if (!['type', 'url', 'headers'].includes(key)) fail(`mcp.json: ${name}.${key} is not allowed`);
    }
    if (!/^https:\/\/[^@#]+$/.test(server.url ?? '')) fail(`mcp.json: ${name}.url must be https without userinfo or fragment`);
  }
};

const snakeCase = (value) => value.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
const pascalCase = (value) => value[0].toUpperCase() + value.slice(1);

const checkSdkCoverage = async () => {
  const spec = JSON.parse(await read('sdk/typescript/openapi.snapshot.json'));
  const typescript = await read('sdk/typescript/src/generated/schema.ts');
  const python = await read('sdk/python/src/aoa_sdk/client.py');
  const go = await read('sdk/go/operations.go');
  for (const [apiPath, item] of Object.entries(spec.paths)) {
    for (const operation of Object.values(item)) {
      const id = operation?.operationId;
      if (!id) continue;
      if (!typescript.includes(`  ${id}(params`)) fail(`TypeScript SDK: no method ${id} (run npm run generate)`);
      if (!python.includes(`def ${snakeCase(id)}(`)) fail(`Python SDK: no method ${snakeCase(id)}`);
      if (!python.includes(`"${apiPath}"`)) fail(`Python SDK: path ${apiPath} is not used`);
      if (!go.includes(`) ${pascalCase(id)}(ctx context.Context`)) fail(`Go SDK: no method ${pascalCase(id)}`);
      if (!go.includes(`"${apiPath}"`)) fail(`Go SDK: path ${apiPath} is not used`);
    }
  }
};

await checkSkills();
await checkPlugin();
await checkSdkCoverage();

if (errors.length) {
  console.error(errors.map((message) => `✗ ${message}`).join('\n'));
  process.exit(1);
}
console.log('Kit is consistent: skills, plugin manifest, MCP config and SDK coverage.');
