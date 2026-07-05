#!/usr/bin/env node
// image-to-cad — generate a parametric KinetiCAD model from photos and/or a
// text description, using Claude vision. Validates the result and retries
// with the validator's error list until it loads.
//
//   node generate.mjs --describe "a desk fan, base 150mm wide" -o out/model.json
//   node generate.mjs -i front.jpg -i side.jpg --describe "wheel dia 80mm" -o out/model.json
//   node generate.mjs --from-json draft.json -o out/model.json     # no API call:
//       validate + wrap an externally produced model (e.g. from a chat session)
//
// Auth: ANTHROPIC_API_KEY env var (or an `ant auth login` profile).
// Load the result: KinetiCAD → Load button → pick the output file.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateModel } from './validate.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const MODEL = process.env.IMAGE_TO_CAD_MODEL || 'claude-opus-4-8';
const MAX_ATTEMPTS = 3;

// ---- arg parsing ----
const args = process.argv.slice(2);
const images = [];
let describe = '';
let outPath = 'out/model.json';
let fromJson = null;
for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case '-i': case '--image': images.push(args[++i]); break;
    case '-d': case '--describe': describe = args[++i]; break;
    case '-o': case '--out': outPath = args[++i]; break;
    case '--from-json': fromJson = args[++i]; break;
    case '-h': case '--help':
      console.log('usage: generate.mjs [-i image.jpg]... [--describe "text"] [-o out.json] [--from-json draft.json]');
      process.exit(0);
      break;
    default:
      console.error(`unknown argument: ${args[i]}`);
      process.exit(2);
  }
}

const MEDIA_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };

function report(doc) {
  const { errors, warnings } = validateModel(doc);
  for (const w of warnings) console.log(`  WARN  ${w}`);
  for (const e of errors) console.log(`  ERROR ${e}`);
  return { errors, warnings };
}

function save(doc) {
  const out = resolve(outPath);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(doc, null, 2));
  const parts = doc.state.assembly.parts.length;
  const mates = doc.state.assembly.mates.length;
  console.log(`\nWrote ${out} (${parts} parts, ${mates} mates)`);
  console.log('Load it in KinetiCAD with the toolbar Load button.');
}

// ---- stub mode: validate + wrap an externally produced model ----
if (fromJson) {
  let doc = JSON.parse(readFileSync(fromJson, 'utf8'));
  // Accept either the full envelope or a bare `state` object.
  if (!('version' in doc) && doc.assembly) doc = { state: doc, version: 9 };
  if (!('version' in doc) && doc.state) doc = { ...doc, version: 9 };
  console.log(`Validating ${fromJson} ...`);
  const { errors } = report(doc);
  if (errors.length > 0) process.exit(1);
  save(doc);
  process.exit(0);
}

// ---- generation mode ----
if (images.length === 0 && !describe) {
  console.error('nothing to do: pass -i images and/or --describe text (or --from-json)');
  process.exit(2);
}

const { default: Anthropic } = await import('@anthropic-ai/sdk');
const client = new Anthropic();
const systemPrompt = readFileSync(resolve(here, 'PROMPT.md'), 'utf8');
const example = readFileSync(
  resolve(here, '..', '..', 'artifacts', 'kineticad', 'public', 'seeds', 'windmill.js'),
  'utf8',
);

const content = [];
for (const img of images) {
  const mediaType = MEDIA_TYPES[extname(img).toLowerCase()];
  if (!mediaType) { console.error(`unsupported image type: ${img}`); process.exit(2); }
  content.push({
    type: 'image',
    source: { type: 'base64', media_type: mediaType, data: readFileSync(img).toString('base64') },
  });
}
content.push({
  type: 'text',
  text:
    `Reference example — the windmill seed (a valid model of this schema):\n\n${example}\n\n` +
    `---\n\nModel the object shown${images.length ? ' in the image(s)' : ''}.` +
    (describe ? `\n\nDescription / measurements from the user:\n${describe}` : ''),
});

const messages = [{ role: 'user', content }];

for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  console.log(`Generating (attempt ${attempt}/${MAX_ATTEMPTS}, ${MODEL}) ...`);
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 32000,
    thinking: { type: 'adaptive' },
    system: systemPrompt,
    messages,
  });
  const response = await stream.finalMessage();
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');

  let doc;
  try {
    // Tolerate accidental markdown fences.
    const raw = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
    doc = JSON.parse(raw);
  } catch (e) {
    console.log(`  ERROR response was not valid JSON: ${e.message}`);
    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: `Your response was not valid JSON (${e.message}). Respond with the complete corrected JSON document only.` });
    continue;
  }

  const { errors } = report(doc);
  if (errors.length === 0) {
    save(doc);
    process.exit(0);
  }
  messages.push({ role: 'assistant', content: response.content });
  messages.push({
    role: 'user',
    content:
      `The model failed validation with these errors:\n` +
      errors.map((e) => `- ${e}`).join('\n') +
      `\n\nRespond with the complete corrected JSON document only.`,
  });
}

console.error(`\nFailed to produce a valid model after ${MAX_ATTEMPTS} attempts.`);
process.exit(1);
