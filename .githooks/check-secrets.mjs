// Secret scanner for a live public repository.
//
//   npm run audit:secrets              check everything git tracks
//   node tools/check-secrets.mjs --staged   check staged changes only (the git hook)
//
// Exit code 1 on any finding, so it works as a pre-commit hook and in CI.
//
// This repository is public, so a commit is published the moment it is pushed — there is
// no staging area between "committed" and "on the internet". That is what this guards.
//
// Deliberately generic: it knows credential SHAPES, not project specifics. Every pattern
// here would apply to any repository. Keep it that way — a scanner that encodes what a
// particular project is hiding becomes a description of what a particular project is
// hiding, which is the opposite of useful in a public tree.
//
// A finding is not automatically a disaster; the point is that it becomes a DECISION
// rather than a surprise. Silence one with an inline `public-safe-ignore` comment on the
// offending line, and say why.
//
// This is a backstop, not the primary defence. Turn on GitHub push protection too — it
// knows hundreds of vendor token formats that this list does not.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const rootFlag = process.argv.indexOf("--root");
const ROOT =
  rootFlag !== -1 && process.argv[rootFlag + 1]
    ? path.resolve(process.argv[rootFlag + 1])
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STAGED = process.argv.includes("--staged");
const git = (...a) => execFileSync("git", ["-C", ROOT, ...a], { encoding: "utf8", maxBuffer: 64 << 20 });

/** Paths that should never be committed, matched against the repo-relative path. */
const FORBIDDEN_PATHS = [
  { re: /(^|\/)\.env($|\.)/, why: "environment file — assume it holds credentials." },
  {
    re: /\.(pem|pfx|p12|key|keystore)$/i,
    why: "private key / certificate material.",
    allow: [/^examples\//, /test|fixture/i],
  },
  {
    re: /(^|\/)people\.ya?ml$/i,
    why: "records file: may hold real PII.",
    allow: [/^examples\/fill-forms\/people\.yaml$/], // the deliberately-fake sample fixture
  },
];

/** Content patterns. Keep these SPECIFIC — a noisy checker is one nobody runs. */
const FORBIDDEN_CONTENT = [
  {
    id: "private-key",
    re: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/,
    why: "an actual private key",
  },
  { id: "aws-key", re: /\bAKIA[0-9A-Z]{16}\b/, why: "an AWS access key id" },
  {
    id: "token",
    re: /\b(gh[pousr]_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/,
    why: "a GitHub / OpenAI / Slack token",
  },
  {
    id: "assigned-secret",
    // `password = "literal"` — but not a param NAME, a doc example, or a ${ENV} reference.
    //
    // The leading boundary is NOT \b: `_` is a word character, so `\bsecret` cannot match
    // inside API_SECRET / CLIENT_SECRET / app_secret — the SCREAMING_SNAKE_CASE that a
    // hardcoded credential is most likely to be spelled in. This scanner reported "clean"
    // over a live GA4 api_secret in extension/src/telemetry.ts for exactly that reason.
    re: /(?:^|[^A-Za-z0-9])(api[_-]?key|secret|passwd|password|token)\s*[:=]\s*["'`](?!\s*\$\{)[^"'`\n]{8,}["'`]/i,
    why: "a hard-coded credential",
    // The engine legitimately talks about password PARAMS throughout the registry and docs.
    allowFile: [/^core\/src\/opw\//, /^docs\//, /^extension\/resources\/python\//, /^examples\//, /\.test\.ts$/],
  },
  {
    id: "local-path",
    // ANY drive-letter path, either slash direction — not just Users/Documents. The first
    // version of this rule required a backslash and one of those two folder names, and it
    // sailed past a hardcoded venv interpreter path in two shipped e2e harnesses.
    // Generic on purpose: naming the real internal directories here would publish the very
    // thing the rule exists to catch.
    // Requires THREE levels (drive, folder, subfolder) and skips the standard Windows
    // install roots, so it catches a personal directory while ignoring both the security
    // tests' `C:\x` placeholders and the dependency prober's "C:\Program Files\gs\…".
    // C:\Users\<name>\… is deliberately NOT exempt — that is the commonest leak of all.
    re: /\b[A-Z]:[\\/](?!(?:Program Files(?: \(x86\))?|Windows|ProgramData)[\\/])[A-Za-z0-9._-]+[\\/][A-Za-z0-9._-]+[\\/]|(?:^|[\s"'`(=])\/(?:home|Users)\/[a-z][a-z0-9._-]*\//,
    why: "an absolute path from a developer machine — will not exist on anyone else's",
    allowFile: [
      /^docs\/python-setup\.md$/, // documents a venv path on purpose
    ],
  },
];

const files = (STAGED ? git("diff", "--cached", "--name-only", "--diff-filter=ACM") : git("ls-files"))
  .split("\n")
  .map((s) => s.trim())
  .filter(Boolean);

const SKIP_CONTENT =
  /(^|\/)(package-lock\.json|\.gitignore)$|\.(png|jpg|jpeg|gif|webp|pdf|zip|vsix|ico|woff2?|docx|xlsx|pptx|mp4|heic)$/i;

const findings = [];

for (const f of files) {
  for (const rule of FORBIDDEN_PATHS) {
    if (!rule.re.test(f)) continue;
    if (rule.allow?.some((a) => a.test(f))) continue;
    findings.push({ file: f, line: 0, id: "forbidden-path", why: rule.why });
  }

  if (SKIP_CONTENT.test(f)) continue;
  const abs = path.join(ROOT, f);
  if (!fs.existsSync(abs)) continue;
  let text;
  try {
    text = fs.readFileSync(abs, "utf8");
  } catch {
    continue; // binary or unreadable
  }
  if (text.includes("\u0000")) continue; // binary — an ESCAPE, never a literal control byte

  const lines = text.split(/\r?\n/);
  for (const rule of FORBIDDEN_CONTENT) {
    if (rule.allowFile?.some((a) => a.test(f))) continue;
    lines.forEach((line, i) => {
      if (line.includes("public-safe-ignore")) return;
      const m = rule.re.exec(line);
      if (m) findings.push({ file: f, line: i + 1, id: rule.id, why: rule.why, hit: m[0].slice(0, 60) });
    });
  }
}

if (findings.length === 0) {
  console.log(`check-secrets: clean — ${files.length} ${STAGED ? "staged" : "tracked"} file(s) checked`);
  process.exit(0);
}

console.error(`\ncheck-secrets: ${findings.length} finding(s)\n`);
const byId = new Map();
for (const f of findings) byId.set(f.id, [...(byId.get(f.id) ?? []), f]);
for (const [id, group] of byId) {
  console.error(`  ${id} — ${group[0].why}`);
  for (const f of group.slice(0, 12)) {
    console.error(`      ${f.file}${f.line ? `:${f.line}` : ""}${f.hit ? `   ${f.hit}` : ""}`);
  }
  if (group.length > 12) console.error(`      … and ${group.length - 12} more`);
  console.error("");
}
console.error("Fix, or silence deliberately with a `public-safe-ignore` comment on the line,");
console.error("with a note explaining why.\n");
process.exit(1);
