#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");
const { dirname, join } = require("node:path");

const packageName = "@qiankunli/baton";

let bunPackage;
try {
  bunPackage = require.resolve("bun/package.json");
} catch {
  console.error(`baton: bundled runtime is missing; reinstall with npm install -g ${packageName}`);
  process.exit(1);
}

// OpenTUI needs Bun's native FFI today. Keeping that runtime package-local lets users install
// baton through ordinary npm without managing a second system-wide runtime themselves.
const runtime = join(dirname(bunPackage), "bin", "bun.exe");
const entrypoint = join(__dirname, "bin.ts");
const child = spawnSync(runtime, [entrypoint, ...process.argv.slice(2)], {
  env: process.env,
  stdio: "inherit",
});

if (child.error) {
  console.error(`baton: failed to start bundled runtime: ${child.error.message}`);
  process.exit(1);
}

if (child.signal) {
  process.kill(process.pid, child.signal);
}

process.exit(child.status ?? 1);
