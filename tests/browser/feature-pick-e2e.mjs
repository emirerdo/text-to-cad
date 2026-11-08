#!/usr/bin/env node
// Pointing at a mesh and telling the agent, end to end in a real browser, against a part whose true
// numbers are known by construction. It owns its project, its viewer and its browser.
//
//   node tests/browser/feature-pick-e2e.mjs [--out DIR]
//
// The part: a bar 100 x 18 x 14 mm, its two long top edges rolled R2. Served as an STL and as a URDF
// that stands it up (part +Z faces the assembly's -Y) through a symlink, as tools/preview.sh serves.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { chromium } = createRequire(path.join(REPO, "packages/core/package.json"))("playwright");
const { PNG } = createRequire(path.join(REPO, "apps/web/package.json"))("pngjs");
const out = process.argv[2] === "--out" ? path.resolve(process.argv[3]) : "";
const python = process.env.PYTHON_BIN || [path.join(REPO, ".venv/bin/python"), "python3"].find(candidate => candidate === "python3" || fs.existsSync(candidate));
const SETTLE_MS = 500;
const GUARD = { "content-type": "application/json", "x-cadgen-viewer": "1" };

// ---- the part ------------------------------------------------------------------------------------
function barStl({ length = 100, width = 18, height = 14, radius = 2, steps = 8 } = {}) {
  const section = [[0, 0], [width, 0]];
  for (let i = 0; i <= steps; i += 1) { const a = (Math.PI / 2) * (i / steps); section.push([width - radius + radius * Math.cos(a), height - radius + radius * Math.sin(a)]); }
  for (let i = 0; i <= steps; i += 1) { const a = Math.PI / 2 + (Math.PI / 2) * (i / steps); section.push([radius + radius * Math.cos(a), height - radius + radius * Math.sin(a)]); }
  const near = section.map(([y, z]) => [0, y, z]), far = section.map(([y, z]) => [length, y, z]);
  const triangles = [];
  section.forEach((_, i) => { const j = (i + 1) % section.length; triangles.push([near[j], far[j], far[i]], [near[j], far[i], near[i]]); });
  for (let i = 1; i < section.length - 1; i += 1) triangles.push([near[0], near[i], near[i + 1]], [far[0], far[i + 1], far[i]]);
  const buffer = Buffer.alloc(84 + 50 * triangles.length);
  buffer.writeUInt32LE(triangles.length, 80);
  triangles.forEach((triangle, t) => triangle.forEach((vertex, v) => vertex.forEach((c, k) => buffer.writeFloatLE(c, 84 + 50 * t + 12 + 12 * v + 4 * k))));
  return buffer;
}

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cfp.")));
const exportDir = path.join(tmp, "repo/projects/stand/export");
fs.mkdirSync(exportDir, { recursive: true });
fs.writeFileSync(path.join(exportDir, "bar.stl"), barStl());
fs.writeFileSync(path.join(exportDir, "design.urdf"), `<?xml version="1.0"?>
<robot name="stand"><link name="base_link"/><link name="bar"><visual name="bar"><origin xyz="0.01 0 0" rpy="1.5707963267948966 0 0"/><geometry><mesh filename="bar.stl" scale="0.001 0.001 0.001"/></geometry></visual></link>
<joint name="fix" type="fixed"><parent link="base_link"/><child link="bar"/></joint></robot>
`);
const previewDir = path.join(tmp, "repo/preview");
fs.mkdirSync(previewDir);
fs.symlinkSync(exportDir, path.join(previewDir, "Stand"));
const SERVED_URDF = path.join(previewDir, "Stand/design.urdf");
const SERVED_STL = path.join(previewDir, "Stand/bar.stl");
const REAL_STL = path.join(exportDir, "bar.stl");

const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});

// ---- the viewer -------------------------------------------------------------------------------------
const port = await freePort();
const origin = `http://127.0.0.1:${port}`;
const viewer = spawn(python, ["-m", "cadgen.viewer", "--host", "127.0.0.1", "--port", String(port)], {
  cwd: previewDir, stdio: "ignore",
  env: { ...process.env, CADGEN_AGENT_CONTEXT: "1", CADGEN_VIEWER_DIST: path.join(REPO, "apps/web/dist"), CADGEN_CACHE_DIR: path.join(tmp, "cache"), CADGEN_STATE_DIR: path.join(tmp, "state"), CADGEN_DAEMON: "0", PYTHONPATH: path.join(REPO, "packages/cadgen/src") },
});
for (let attempt = 0; ; attempt += 1) {
  const up = await fetch(`${origin}/__cad/server`).then(response => response.ok, () => false);
  if (up) break;
  if (attempt > 120) throw new Error("the viewer did not start");
  await new Promise(resolve => setTimeout(resolve, 250));
}

const browser = await chromium.launch({ headless: true, args: [`--use-angle=${process.platform === "darwin" ? "metal" : "swiftshader"}`, "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"] });
const failures = [];
let sessions = 0;
const read = async (session = `s${++sessions}`) => {
  const response = await fetch(`${origin}/__cad/context/read`, { method: "POST", headers: GUARD, body: JSON.stringify({ session, cwd: path.join(tmp, "repo") }) });
  assert.equal(response.status, 200);
  return (await response.json()).items.map(item => item.text);
};

async function open(file) {
  const context = await browser.newContext({ viewport: { width: 1024, height: 640 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const errors = [];
  page.on("pageerror", error => errors.push(String(error)));
  await page.addInitScript(() => {
    window.__cadModelBounds = () => {
      const placement = window.__cadModelPlacement;
      if (Array.isArray(placement?.boundsMin)) return { min: placement.boundsMin, max: placement.boundsMax };
      const stage = window.__cadStage?.();
      return stage?.bounds ? { min: stage.bounds.min, max: stage.bounds.max } : null;
    };
  });
  await page.goto(`${origin}/?file=${encodeURIComponent(file)}`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-slot="cad-file-view"] [aria-busy="false"]').first().waitFor({ timeout: 120_000 });
  await page.waitForFunction(() => { const b = window.__cadModelBounds?.(); return Array.isArray(b?.min); }, null, { timeout: 120_000 });
  await page.waitForTimeout(700);
  const box = await page.locator("canvas").first().boundingBox();
  return { context, page, errors, box };
}

/** Click, let the selection settle, and read what an agent would be told. */
async function clickAndRead(view, x, y, options = {}) {
  await view.page.mouse.click(x, y, options);
  return settled();
}

/** What an agent would be told once the selection has settled: a pick is published a moment after it lands. */
async function settled(wanted = null) {
  let text = "";
  for (let waited = 0; waited < 2500; waited += 150) {
    await new Promise(resolve => setTimeout(resolve, 150));
    text = (await read()).join("\n");
    if (waited >= SETTLE_MS && (wanted ? wanted.test(text) : text)) return text;
  }
  return text;
}

/** Walk a line down the canvas until a click tells something that matches. */
async function find(view, pattern, { column = 0.5 } = {}) {
  const { box } = view;
  for (let fraction = 0.2; fraction <= 0.8; fraction += 0.0125) {
    const x = box.x + box.width * column, y = box.y + box.height * fraction;
    const text = await clickAndRead(view, x, y);
    if (pattern.test(text)) return { x, y, text };
    // A second plain click on the one selected thing clears it; start each probe from nothing.
    await view.page.keyboard.press("Escape");
  }
  assert.fail(`no click on the model told ${pattern}`);
}

async function chooseMode(view, mode) {
  await view.page.locator("[data-tool-mode-trigger]").first().click();
  await view.page.locator(`[data-tool-mode="${mode}"]`).click();
  await view.page.waitForTimeout(150);
}

const pngOf = file => PNG.sync.read(fs.readFileSync(file));
function pinPixels(png) {
  let count = 0;
  for (let i = 0; i < png.data.length; i += 4) if (Math.abs(png.data[i] - 0x4f) < 14 && Math.abs(png.data[i + 1] - 0x9d) < 14 && Math.abs(png.data[i + 2] - 0xff) < 14) count += 1;
  return count;
}

const only = process.env.E2E_ONLY ? new RegExp(process.env.E2E_ONLY) : null;
async function check(name, run) {
  // The check that finds the part's top is what the others click on.
  if (only && !only.test(name) && !name.startsWith("the top of the part")) return;
  const started = Date.now();
  try { await run(); console.log(`  ok   ${name} (${((Date.now() - started) / 1000).toFixed(1)}s)`); }
  catch (error) { failures.push(`${name}: ${error.message}`); console.error(`  FAIL ${name}\n       ${error.message}`); }
}

// ---- the checks ---------------------------------------------------------------------------------------
try {
  const urdf = await open(SERVED_URDF);
  let top;
  await check("a URDF offers Select and Draw", async () => {
    const labels = await urdf.page.locator('[data-cad-tool-groups] button').evaluateAll(nodes => nodes.map(node => node.getAttribute("aria-label") || node.innerText));
    assert.ok(labels.some(label => /Select/.test(label)), labels.join());
    assert.ok(labels.some(label => /Draw/.test(label)), labels.join());
  });
  await check("the top of the part is told exactly, by its real path", async () => {
    top = await find(urdf, /plane, normal \+Z/);
    assert.match(top.text, /1 face · bar · /);
    assert.ok(top.text.includes(REAL_STL), top.text);
    assert.ok(!top.text.includes("/preview/"), top.text);
    assert.match(top.text, /plane, normal \+Z \(assembly -Y\), z = 14\.00, x 0\.00\.\.100\.00, y 2\.00\.\.16\.00, area 1400\.00 mm²/);
    assert.match(top.text, /14\.00 of material behind it along -Z/);
    assert.match(top.text, /part 100\.00 x 18\.00 x 14\.00/);
    assert.match(top.text, /seen from /);
  });
  await check("the picture shows the pin", async () => {
    const image = /Image[^:]*: (.+\.png)/.exec(top.text)?.[1];
    assert.ok(image && fs.existsSync(image), `no image in: ${top.text}`);
    if (out) { fs.mkdirSync(out, { recursive: true }); fs.copyFileSync(image, path.join(out, "picked.png")); }
    assert.ok(pinPixels(pngOf(image)) > 120, `pin pixels: ${pinPixels(pngOf(image))}`);
  });
  await check("the box says it waits for the next message, then that it went", async () => {
    await urdf.page.keyboard.press("Escape");
    await urdf.page.mouse.click(top.x, top.y);
    await urdf.page.waitForTimeout(SETTLE_MS);
    const chip = urdf.page.locator('[data-quick-edit-chip="agent"]');
    assert.match(await chip.innerText(), /Next message/);
    await read("the-conversation");
    await urdf.page.waitForSelector('[data-quick-edit-chip="agent"][data-delivered]', { timeout: 5000 });
    assert.match(await chip.innerText(), /Sent/);
    assert.deepEqual(await read("the-conversation"), [], "a conversation is told once");
  });
  await check("hovering lights a face before anything is clicked", async () => {
    await urdf.page.keyboard.press("Escape");
    await urdf.page.mouse.move(urdf.box.x + 4, urdf.box.y + 4);
    await urdf.page.waitForTimeout(250);
    const before = PNG.sync.read(await urdf.page.screenshot({ clip: urdf.box }));
    const inside = { x: top.x, y: top.y + 35 };
    await urdf.page.mouse.move(inside.x, inside.y);
    await urdf.page.waitForTimeout(250);
    await urdf.page.mouse.move(inside.x + 2, inside.y);
    await urdf.page.waitForTimeout(250);
    const after = PNG.sync.read(await urdf.page.screenshot({ clip: urdf.box }));
    if (out) fs.writeFileSync(path.join(out, "hover.png"), PNG.sync.write(after));
    let changed = 0;
    for (let i = 0; i < after.data.length; i += 4) if (Math.abs(after.data[i] - before.data[i]) + Math.abs(after.data[i + 2] - before.data[i + 2]) > 24) changed += 1;
    assert.ok(changed > 2000, `only ${changed} pixels changed`);
    await urdf.page.mouse.move(urdf.box.x + 4, urdf.box.y + 4);
  });
  await check("a rolled edge is told as a cylinder with its radius", async () => {
    await urdf.page.keyboard.press("Escape");
    const roll = await find(urdf, /^\s+cylinder R2\.00/m);
    assert.match(roll.text, /cylinder R2\.00 convex, axis [+-]X, 90° of arc/);
  });
  await check("Shift adds a numbered second pick, a plain click replaces", async () => {
    await urdf.page.keyboard.press("Escape");
    const first = await clickAndRead(urdf, top.x, top.y);
    assert.match(first, /^1 face/m);
    await urdf.page.keyboard.down("Shift");
    await urdf.page.mouse.click(top.x + 3, top.y - 60);
    await urdf.page.keyboard.up("Shift");
    const both = await settled(/^2 /m);
    assert.match(both, /^1 face/m, both);
    assert.match(both, /^2 (face|edge)/m, both);
    await urdf.page.mouse.click(top.x, top.y);
    await urdf.page.waitForTimeout(SETTLE_MS * 2);
    const again = (await read()).join("\n");
    assert.doesNotMatch(again, /^2 /m, again);
  });
  await check("Escape takes it all back out of the context", async () => {
    await urdf.page.mouse.click(top.x + 3, top.y);
    await urdf.page.waitForTimeout(SETTLE_MS);
    await urdf.page.keyboard.press("Escape");
    await urdf.page.waitForTimeout(SETTLE_MS);
    assert.deepEqual(await read(), []);
  });
  await check("a note goes with the selection", async () => {
    await urdf.page.keyboard.press("Escape");
    await urdf.page.mouse.click(top.x, top.y);
    await urdf.page.waitForTimeout(SETTLE_MS);
    await urdf.page.keyboard.type("lower this by 2 mm");
    await urdf.page.waitForTimeout(SETTLE_MS);
    const text = (await read()).join("\n");
    assert.match(text, /^lower this by 2 mm/m);
    assert.match(text, /References:\n1 face · bar/);
  });
  await check("a note that has gone is not said again", async () => {
    // Escape keeps a written note, as a box with a note always has: the X is what clears one.
    await urdf.page.locator('[aria-label="Close Quick Edit"]').click({ timeout: 1000 }).catch(() => {});
    await urdf.page.waitForTimeout(SETTLE_MS);
    await urdf.page.mouse.click(top.x + 5, top.y + 30);
    await urdf.page.waitForTimeout(SETTLE_MS);
    await urdf.page.keyboard.type("make it thinner");
    await urdf.page.waitForTimeout(SETTLE_MS * 2);
    assert.match((await read("note-conversation")).join("\n"), /make it thinner/);
    await urdf.page.waitForSelector('[data-quick-edit-chip="agent"][data-delivered]', { timeout: 5000 });
    await urdf.page.waitForTimeout(SETTLE_MS * 3);
    assert.equal(await urdf.page.locator("[data-quick-edit-box] textarea").inputValue(), "");
    assert.deepEqual(await read("note-conversation"), [], "the selection was told again");
    assert.match(await urdf.page.locator('[data-quick-edit-chip="agent"]').innerText(), /Sent/);
  });
  await check("Edges picks an edge, by its shape and length", async () => {
    await urdf.page.keyboard.press("Escape");
    await chooseMode(urdf, "edges");
    const edge = await find(urdf, /^1 edge/m);
    assert.match(edge.text, /line, 100\.00 long|tangent|sharp/);
  });
  await check("Points picks the exact place", async () => {
    await urdf.page.keyboard.press("Escape");
    await chooseMode(urdf, "points");
    const text = await clickAndRead(urdf, top.x, top.y);
    assert.match(text, /^1 point · bar/m);
    assert.match(text, /on plane z = 14\.00/);
  });
  await check("Parts picks the whole part", async () => {
    await urdf.page.keyboard.press("Escape");
    await chooseMode(urdf, "parts");
    const text = await clickAndRead(urdf, top.x, top.y);
    assert.match(text, /^1 part · bar/m);
    assert.match(text, /100\.00 x 18\.00 x 14\.00/);
    await chooseMode(urdf, "all");
  });
  await check("Draw goes with the selection, and its ink is in the picture", async () => {
    await urdf.page.keyboard.press("Escape");
    await urdf.page.waitForTimeout(SETTLE_MS);
    await urdf.page.locator('[data-cad-tool-groups] button[aria-label="Draw"]').click();
    await urdf.page.waitForSelector("[data-drawing-ready]", { timeout: 30_000 });
    await urdf.page.mouse.move(urdf.box.x + urdf.box.width * 0.45, urdf.box.y + urdf.box.height * 0.4);
    await urdf.page.mouse.down();
    await urdf.page.mouse.move(urdf.box.x + urdf.box.width * 0.65, urdf.box.y + urdf.box.height * 0.6, { steps: 12 });
    await urdf.page.mouse.up();
    await urdf.page.waitForTimeout(SETTLE_MS + 300);
    if (out) await urdf.page.screenshot({ path: path.join(out, "draw.png") });
    assert.equal(await urdf.page.locator('[data-quick-edit-chip="sketch"]').count(), 1);
    const text = (await read()).join("\n");
    assert.match(text, /Image[^:]*: .+\.png/, text);
    await urdf.page.locator('[data-cad-tool-groups] button[aria-label="Draw"]').click();
  });
  await check("a reload leaves nothing behind", async () => {
    await urdf.page.locator('[aria-label="Close Quick Edit"]').click({ timeout: 1000 }).catch(() => {});
    await urdf.page.mouse.click(top.x, top.y);
    await urdf.page.waitForTimeout(SETTLE_MS);
    await urdf.page.reload({ waitUntil: "domcontentloaded" });
    await urdf.page.waitForTimeout(800);
    assert.deepEqual(await read(), []);
  });
  await check("the URDF page raised no errors", async () => assert.deepEqual(urdf.errors, []));
  await urdf.context.close();

  const stl = await open(SERVED_STL);
  await check("a lone STL can be pointed at, in its own frame", async () => {
    const face = await find(stl, /plane, normal/);
    assert.match(face.text, /1 face · bar · /);
    assert.ok(face.text.includes(REAL_STL), face.text);
    assert.doesNotMatch(face.text, /assembly/);
    if (out) await stl.page.screenshot({ path: path.join(out, "stl.png") });
  });
  await check("the STL page raised no errors", async () => assert.deepEqual(stl.errors, []));
  await stl.context.close();
} finally {
  await browser.close();
  viewer.kill("SIGTERM");
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (failures.length) { console.error(`feature pick e2e: ${failures.length} FAILED`); process.exit(1); }
console.log("feature pick e2e: PASS");
