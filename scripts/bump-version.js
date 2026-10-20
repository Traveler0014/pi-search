#!/usr/bin/env node
/**
 * bump-version.js — set the version of the package(s) this repo publishes.
 *
 * Usage:
 *   node scripts/bump-version.js <extension-path|package.json> <version>
 *
 * The extension package is always bumped. A repo-root package.json is bumped
 * too when it declares the *same* package name — the single-extension layout,
 * where the root is what `pi install` reads — together with its lockfile entry.
 * Multi-extension repos leave the root alone, because there its version means
 * nothing.
 *
 * Files that actually changed are printed one per line, so `release.sh` can
 * stage exactly those.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function fail(message) {
  process.stderr.write(`✗ ${message}\n`);
  process.exit(1);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

function writeJson(file, data) {
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

/** Set `version` on a JSON file; returns true when it changed something. */
function setVersion(file, version) {
  if (!fs.existsSync(file)) return false;
  const data = readJson(file);
  if (data.version === version) return false;
  data.version = version;
  writeJson(file, data);
  return true;
}

const [target, version] = process.argv.slice(2);

if (!target || !version) {
  fail("Usage: node scripts/bump-version.js <extension-path|package.json> <version>");
}
if (!SEMVER.test(version)) {
  fail(`Invalid version "${version}" (expected x.y.z)`);
}

const extPkgPath = target.endsWith("package.json")
  ? path.resolve(repoRoot, target)
  : path.resolve(repoRoot, target, "package.json");

if (!fs.existsSync(extPkgPath)) fail(`Package not found: ${extPkgPath}`);

const extPkg = readJson(extPkgPath);
if (!extPkg.name) fail(`${extPkgPath} has no "name"`);
if (!extPkg.version) fail(`${extPkgPath} has no "version"`);

const changed = [];

if (setVersion(extPkgPath, version)) changed.push(extPkgPath);

// Lockfile first: it shares the root package's name, and a version bump that
// skips it leaves `npm ci` complaining about a file it thinks is stale.
const rootPkgPath = path.join(repoRoot, "package.json");
const lockPath = path.join(repoRoot, "package-lock.json");
const rootPkg =
  rootPkgPath !== extPkgPath && fs.existsSync(rootPkgPath)
    ? readJson(rootPkgPath)
    : null;

if (rootPkg && rootPkg.name === extPkg.name) {
  if (setVersion(rootPkgPath, version)) changed.push(rootPkgPath);

  if (fs.existsSync(lockPath)) {
    const lock = readJson(lockPath);
    if (lock.name === extPkg.name) {
      let touched = false;
      if (lock.version !== version) {
        lock.version = version;
        touched = true;
      }
      const rootEntry = lock.packages?.[""];
      if (rootEntry && rootEntry.version !== version) {
        rootEntry.version = version;
        touched = true;
      }
      if (touched) {
        writeJson(lockPath, lock);
        changed.push(lockPath);
      }
    }
  }
}

if (changed.length === 0) {
  process.stderr.write(`  (already at v${version})\n`);
}

process.stdout.write(changed.map((file) => `${file}\n`).join(""));
