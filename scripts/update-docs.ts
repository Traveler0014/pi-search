/**
 * update-docs.ts — Scan extension source code via TypeScript AST and regenerate
 * the root README.md with an accurate extension catalog.
 *
 * Supports three directory layouts:
 *   1. <name>.ts                          (bare file — not recommended)
 *   2. <name>/index.ts                    (simple plugin)
 *   3. <category>/<name>/index.ts         (grouped plugins)
 *
 * Extracts from each extension's index.ts:
 *   - pi.registerProvider()  → provider id, display name, model list
 *   - pi.registerCommand()   → command name, description
 *   - pi.registerTool()      → tool name, description
 *   - pi.registerShortcut()  → shortcut key, description
 *   - pi.registerFlag()      → flag name, description
 *
 * Repo metadata (title, install URL) is read from the root package.json.
 *
 * Usage: npx tsx scripts/update-docs.ts
 */

import ts from "typescript";
import * as fs from "node:fs";
import * as path from "node:path";

// ── Types ────────────────────────────────────────────────────────────────────

interface RepoConfig {
  name: string;
  description: string;
  repository: string;
  installUrl: string;
}

interface ProviderInfo {
  id: string;
  name: string;
  models: ModelInfo[];
}

interface ModelInfo {
  id: string;
  name: string;
  reasoning: boolean;
  input: string[];
  contextWindow: number;
  maxTokens: number;
}

interface CommandInfo {
  name: string;
  description: string;
}

interface ToolInfo {
  name: string;
  description: string;
}

interface ShortcutInfo {
  key: string;
  description: string;
}

interface FlagInfo {
  name: string;
  description: string;
}

interface ExtensionInfo {
  /** Relative path from repo root (e.g. "example-provider" or "tools/example-plugin") */
  relPath: string;
  /** Directory name (last component) */
  dirName: string;
  providers: ProviderInfo[];
  commands: CommandInfo[];
  tools: ToolInfo[];
  shortcuts: ShortcutInfo[];
  flags: FlagInfo[];
}

// ── Repo Config ──────────────────────────────────────────────────────────────

function readRepoConfig(repoRoot: string): RepoConfig {
  const pkgPath = path.join(repoRoot, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  return {
    name: pkg.name ?? "pi-extensions",
    description: pkg.description ?? "Collection of pi extensions",
    repository: pkg.repository ?? "",
    installUrl: pkg.installUrl ?? pkg.repository ?? "",
  };
}

// ── AST Helpers ──────────────────────────────────────────────────────────────

/** Get string literal value from a node, or undefined */
function getStringLiteral(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return undefined;
}

/** Get a property value from an object literal expression by property name */
function getObjectProperty(
  obj: ts.ObjectLiteralExpression,
  propName: string,
): ts.Expression | undefined {
  for (const prop of obj.properties) {
    if (
      ts.isPropertyAssignment(prop) &&
      ((ts.isIdentifier(prop.name) && prop.name.text === propName) ||
        (ts.isStringLiteral(prop.name) && prop.name.text === propName))
    ) {
      return prop.initializer;
    }
  }
  return undefined;
}

/** Extract string value from a property in an object literal */
function getStringProp(
  obj: ts.ObjectLiteralExpression,
  propName: string,
): string | undefined {
  const expr = getObjectProperty(obj, propName);
  if (expr) return getStringLiteral(expr);
  return undefined;
}

/** Extract boolean value from a property */
function getBoolProp(
  obj: ts.ObjectLiteralExpression,
  propName: string,
): boolean | undefined {
  const expr = getObjectProperty(obj, propName);
  if (expr && expr.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expr && expr.kind === ts.SyntaxKind.FalseKeyword) return false;
  return undefined;
}

/** Extract number value from a property */
function getNumProp(
  obj: ts.ObjectLiteralExpression,
  propName: string,
): number | undefined {
  const expr = getObjectProperty(obj, propName);
  if (expr && ts.isNumericLiteral(expr)) return Number(expr.text);
  return undefined;
}

/** Extract string array from a property like input: ["text", "image"] */
function getStringArrayProp(
  obj: ts.ObjectLiteralExpression,
  propName: string,
): string[] | undefined {
  const expr = getObjectProperty(obj, propName);
  if (expr && ts.isArrayLiteralExpression(expr)) {
    return expr.elements
      .map((el) => getStringLiteral(el))
      .filter((s): s is string => s !== undefined);
  }
  return undefined;
}

/**
 * Check if a call expression matches `pi.registerXxx(...)`.
 * Returns the method name (e.g. "registerProvider") or undefined.
 */
function getRegisterMethod(
  callExpr: ts.CallExpression,
): string | undefined {
  const expr = callExpr.expression;
  if (
    ts.isPropertyAccessExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === "pi" &&
    expr.name.text.startsWith("register")
  ) {
    return expr.name.text;
  }
  return undefined;
}

// ── Extractors ───────────────────────────────────────────────────────────────

/** Extract models from a top-level `const MODELS = [...]` array */
function extractModelsArray(sourceFile: ts.SourceFile): ModelInfo[] {
  const models: ModelInfo[] = [];

  for (const stmt of sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) continue;

    for (const decl of stmt.declarationList.declarations) {
      if (
        ts.isIdentifier(decl.name) &&
        decl.name.text === "MODELS" &&
        decl.initializer &&
        ts.isArrayLiteralExpression(decl.initializer)
      ) {
        for (const el of decl.initializer.elements) {
          if (ts.isObjectLiteralExpression(el)) {
            const model = extractModelInfo(el);
            if (model) models.push(model);
          }
        }
      }
    }
  }

  return models;
}

function extractModelInfo(obj: ts.ObjectLiteralExpression): ModelInfo | undefined {
  const id = getStringProp(obj, "id");
  if (!id) return undefined;

  return {
    id,
    name: getStringProp(obj, "name") ?? id,
    reasoning: getBoolProp(obj, "reasoning") ?? false,
    input: getStringArrayProp(obj, "input") ?? ["text"],
    contextWindow: getNumProp(obj, "contextWindow") ?? 0,
    maxTokens: getNumProp(obj, "maxTokens") ?? 0,
  };
}

/** Extract provider info from pi.registerProvider("id", { ... }) */
function extractProvider(
  callExpr: ts.CallExpression,
  modelsArray: ModelInfo[],
): ProviderInfo | undefined {
  const args = callExpr.arguments;
  if (args.length < 2) return undefined;

  const id = getStringLiteral(args[0]);
  if (!id) return undefined;

  const opts = args[1];
  if (!ts.isObjectLiteralExpression(opts)) return undefined;

  const name = getStringProp(opts, "name") ?? id;

  return { id, name, models: modelsArray };
}

/** Extract command info from pi.registerCommand("name", { ... }) */
function extractCommand(callExpr: ts.CallExpression): CommandInfo | undefined {
  const args = callExpr.arguments;
  if (args.length < 2) return undefined;

  const name = getStringLiteral(args[0]);
  if (!name) return undefined;

  const opts = args[1];
  if (!ts.isObjectLiteralExpression(opts)) return undefined;

  return {
    name,
    description: getStringProp(opts, "description") ?? "",
  };
}

/** Extract tool info from pi.registerTool({ name, description, ... }) */
function extractTool(callExpr: ts.CallExpression): ToolInfo | undefined {
  const args = callExpr.arguments;
  if (args.length < 1) return undefined;

  const opts = args[0];
  if (!ts.isObjectLiteralExpression(opts)) return undefined;

  const name = getStringProp(opts, "name");
  if (!name) return undefined;

  return {
    name,
    description: getStringProp(opts, "description") ?? "",
  };
}

/** Extract shortcut info from pi.registerShortcut("key", { ... }) */
function extractShortcut(callExpr: ts.CallExpression): ShortcutInfo | undefined {
  const args = callExpr.arguments;
  if (args.length < 2) return undefined;

  const key = getStringLiteral(args[0]);
  if (!key) return undefined;

  const opts = args[1];
  if (!ts.isObjectLiteralExpression(opts)) return undefined;

  return {
    key,
    description: getStringProp(opts, "description") ?? "",
  };
}

/** Extract flag info from pi.registerFlag("name", { ... }) */
function extractFlag(callExpr: ts.CallExpression): FlagInfo | undefined {
  const args = callExpr.arguments;
  if (args.length < 2) return undefined;

  const name = getStringLiteral(args[0]);
  if (!name) return undefined;

  const opts = args[1];
  if (!ts.isObjectLiteralExpression(opts)) return undefined;

  return {
    name,
    description: getStringProp(opts, "description") ?? "",
  };
}

// ── Import Resolution ────────────────────────────────────────────────────────

/** Resolve a TypeScript import specifier to an actual file path. */
function resolveImport(baseDir: string, specifier: string): string | null {
  // Only follow relative imports (./xxx, ../xxx)
  if (!specifier.startsWith(".")) return null;

  const candidates = [
    path.join(baseDir, specifier + ".ts"),
    path.join(baseDir, specifier + ".tsx"),
    path.join(baseDir, specifier, "index.ts"),
    path.join(baseDir, specifier, "index.tsx"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/** Collect local import paths from a source file. */
function collectLocalImports(sourceFile: ts.SourceFile, baseDir: string): string[] {
  const imports: string[] = [];

  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const resolved = resolveImport(baseDir, node.moduleSpecifier.text);
      if (resolved) imports.push(resolved);
    }
    // Also handle dynamic imports and re-exports
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const resolved = resolveImport(baseDir, node.moduleSpecifier.text);
      if (resolved) imports.push(resolved);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return imports;
}

// ── Main Parser ──────────────────────────────────────────────────────────────

function parseExtension(extDir: string): ExtensionInfo | undefined {
  const indexPath = path.join(extDir, "index.ts");
  if (!fs.existsSync(indexPath)) return undefined;

  const dirName = path.basename(extDir);
  const info: ExtensionInfo = {
    relPath: "", // filled by caller
    dirName,
    providers: [],
    commands: [],
    tools: [],
    shortcuts: [],
    flags: [],
  };

  // Recursively scan index.ts and all its local imports
  const scanned = new Set<string>();
  const queue: string[] = [indexPath];

  // MODELS array is scoped per file (used by providers in the same file)
  while (queue.length > 0) {
    const filePath = queue.shift()!;
    const normalized = path.resolve(filePath);
    if (scanned.has(normalized)) continue;
    scanned.add(normalized);

    if (!fs.existsSync(normalized)) continue;
    const source = fs.readFileSync(normalized, "utf-8");
    const sourceFile = ts.createSourceFile(
      path.basename(normalized),
      source,
      ts.ScriptTarget.Latest,
      true,
    );

    const modelsArray = extractModelsArray(sourceFile);

    // Walk the AST looking for pi.registerXxx() calls
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node)) {
        const method = getRegisterMethod(node);
        if (method) {
          switch (method) {
            case "registerProvider": {
              const provider = extractProvider(node, modelsArray);
              if (provider) info.providers.push(provider);
              break;
            }
            case "registerCommand": {
              const cmd = extractCommand(node);
              if (cmd) info.commands.push(cmd);
              break;
            }
            case "registerTool": {
              const tool = extractTool(node);
              if (tool) info.tools.push(tool);
              break;
            }
            case "registerShortcut": {
              const shortcut = extractShortcut(node);
              if (shortcut) info.shortcuts.push(shortcut);
              break;
            }
            case "registerFlag": {
              const flag = extractFlag(node);
              if (flag) info.flags.push(flag);
              break;
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);

    // Enqueue local imports for recursive scanning
    const baseDir = path.dirname(normalized);
    const localImports = collectLocalImports(sourceFile, baseDir);
    for (const imp of localImports) {
      const resolved = path.resolve(imp);
      if (!scanned.has(resolved)) queue.push(resolved);
    }
  }

  return info;
}

// ── Extension Discovery ──────────────────────────────────────────────────────

const SKIP_DIRS = new Set([".git", "node_modules", "scripts", ".github", ".pi"]);

/**
 * Recursively find all directories containing index.ts (extension roots).
 * Supports layouts:
 *   - <name>/index.ts
 *   - <category>/<name>/index.ts
 */
function findExtensions(repoRoot: string): { relPath: string; absPath: string }[] {
  const results: { relPath: string; absPath: string }[] = [];

  function walk(dir: string, depth: number) {
    if (depth > 2) return; // max depth: category/plugin

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;

      const childDir = path.join(dir, entry.name);
      const indexPath = path.join(childDir, "index.ts");

      if (fs.existsSync(indexPath)) {
        results.push({
          relPath: path.relative(repoRoot, childDir),
          absPath: childDir,
        });
      } else {
        // Recurse deeper (for category/plugin layout)
        walk(childDir, depth + 1);
      }
    }
  }

  walk(repoRoot, 0);
  return results.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

// ── README Generator ─────────────────────────────────────────────────────────

function formatContextWindow(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 2)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

function generateReadme(config: RepoConfig, extensions: ExtensionInfo[]): string {
  const installUrl = config.installUrl;
  const lines: string[] = [];

  lines.push(`# ${config.name}`);
  lines.push("");
  lines.push(config.description);
  lines.push("");
  lines.push(
    "> **Auto-generated**: The extension catalog below is generated by `scripts/update-docs.ts`.",
  );
  lines.push("> Edit the source files and re-run the script to update.");
  lines.push("");
  lines.push("## Extensions");
  lines.push("");

  // Summary table
  lines.push("| Extension | Providers | Commands | Tools |");
  lines.push("|-----------|-----------|----------|-------|");
  for (const ext of extensions) {
    const providerNames = ext.providers.map((p) => `\`${p.id}\``).join(", ") || "—";
    const commandNames =
      ext.commands.map((c) => `\`/${c.name}\``).join(", ") || "—";
    const toolNames = ext.tools.map((t) => `\`${t.name}\``).join(", ") || "—";
    lines.push(
      `| [${ext.relPath}](./${ext.relPath}) | ${providerNames} | ${commandNames} | ${toolNames} |`,
    );
  }
  lines.push("");

  // Detailed sections
  for (const ext of extensions) {
    lines.push(`### [${ext.relPath}](./${ext.relPath})`);
    lines.push("");

    // Read first descriptive line from extension's README
    const extReadme = path.join(ext.relPath, "README.md");
    if (fs.existsSync(extReadme)) {
      const readmeContent = fs.readFileSync(extReadme, "utf-8");
      const firstDesc = readmeContent
        .split("\n")
        .find((l) => l.trim() && !l.startsWith("#"));
      if (firstDesc) {
        lines.push(firstDesc.trim());
        lines.push("");
      }
    }

    // Providers
    for (const provider of ext.providers) {
      lines.push(`**Provider:** ${provider.name} (\`${provider.id}\`)`);
      lines.push("");

      if (provider.models.length > 0) {
        lines.push("<details>");
        lines.push(`<summary>Models (${provider.models.length})</summary>`);
        lines.push("");
        lines.push("| Model | Context | Max Output | Image | Reasoning |");
        lines.push("|-------|---------|------------|-------|-----------|");
        for (const m of provider.models) {
          const img = m.input.includes("image") ? "✓" : "✗";
          const reason = m.reasoning ? "✓" : "✗";
          lines.push(
            `| \`${m.id}\` | ${formatContextWindow(m.contextWindow)} | ${formatContextWindow(m.maxTokens)} | ${img} | ${reason} |`,
          );
        }
        lines.push("");
        lines.push("</details>");
        lines.push("");
      }
    }

    // Commands
    if (ext.commands.length > 0) {
      lines.push("**Commands:**");
      lines.push("");
      for (const c of ext.commands) {
        lines.push(
          c.description
            ? `- \`/${c.name}\` — ${c.description}`
            : `- \`/${c.name}\``,
        );
      }
      lines.push("");
    }

    // Tools
    if (ext.tools.length > 0) {
      lines.push("**Tools:**");
      lines.push("");
      for (const t of ext.tools) {
        lines.push(
          t.description
            ? `- \`${t.name}\` — ${t.description}`
            : `- \`${t.name}\``,
        );
      }
      lines.push("");
    }

    // Shortcuts
    if (ext.shortcuts.length > 0) {
      lines.push("**Shortcuts:**");
      lines.push("");
      for (const s of ext.shortcuts) {
        lines.push(
          s.description
            ? `- \`${s.key}\` — ${s.description}`
            : `- \`${s.key}\``,
        );
      }
      lines.push("");
    }

    // Flags
    if (ext.flags.length > 0) {
      lines.push("**Flags:**");
      lines.push("");
      for (const f of ext.flags) {
        lines.push(
          f.description
            ? `- \`--${f.name}\` — ${f.description}`
            : `- \`--${f.name}\``,
        );
      }
      lines.push("");
    }

    lines.push("---");
    lines.push("");
  }

  // Footer
  lines.push("## Installation");
  lines.push("");
  if (installUrl) {
    lines.push("```bash");
    lines.push(`pi install ${installUrl}`);
    lines.push("```");
    lines.push("");
    lines.push("Update with:");
    lines.push("");
    lines.push("```bash");
    lines.push("pi update --extensions");
    lines.push("```");
    lines.push("");
  }
  lines.push("## License");
  lines.push("");
  lines.push("MIT");
  lines.push("");

  return lines.join("\n");
}

// ── Entry Point ──────────────────────────────────────────────────────────────

function main() {
  const repoRoot = path.resolve(import.meta.dirname ?? ".", "..");
  const readmePath = path.join(repoRoot, "README.md");

  const config = readRepoConfig(repoRoot);
  console.log(`  Repo: ${config.name}`);

  const extDirs = findExtensions(repoRoot);
  const extensions: ExtensionInfo[] = [];

  for (const { relPath, absPath } of extDirs) {
    const info = parseExtension(absPath);
    if (info) {
      info.relPath = relPath;
      extensions.push(info);
      console.log(
        `  ✓ ${relPath}: ${info.providers.length} provider(s), ${info.commands.length} command(s), ${info.tools.length} tool(s)`,
      );
    }
  }

  if (extensions.length === 0) {
    console.error("No extensions found.");
    process.exit(1);
  }

  const generated = generateReadme(config, extensions);

  // Support preamble: if the existing README contains a <!-- AUTO --> marker,
  // preserve everything before it and append the generated catalog after.
  let finalReadme = generated;
  if (fs.existsSync(readmePath)) {
    const existing = fs.readFileSync(readmePath, "utf-8");
    const marker = "<!-- AUTO -->";
    const idx = existing.indexOf(marker);
    if (idx !== -1) {
      const preamble = existing.slice(0, idx).trimEnd();
      // Strip title + description block generated by generateReadme()
      const withoutTitle = generated.replace(/^# [^\n]+\n\n[^\n]+\n\n/, "");
      finalReadme = preamble + "\n\n" + withoutTitle;
    }
  }

  fs.writeFileSync(readmePath, finalReadme, "utf-8");
  console.log(`\n✓ Updated ${readmePath}`);
}

main();
