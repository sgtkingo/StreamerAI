import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/**
 * RELEASE_NOTES.md keeps upcoming changes under "## Unreleased". A release
 * moves that section under "## vX.Y.Z (date)", starts a new empty
 * "## Unreleased" and publishes only the released section.
 */
export const UNRELEASED = "## Unreleased";
const PLACEHOLDER = "_Nothing yet._";

function sections(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const starts = [];
  lines.forEach((line, index) => {
    if (/^## /.test(line)) starts.push(index);
  });
  return { lines, starts };
}

/** The body of the "## Unreleased" section (without its heading). */
export function unreleasedNotes(text) {
  const { lines, starts } = sections(text);
  const start = starts.find((index) => lines[index].trim() === UNRELEASED);
  if (start === undefined) return "";
  const end = starts.find((index) => index > start) ?? lines.length;
  const body = lines
    .slice(start + 1, end)
    .join("\n")
    .trim();
  return body === PLACEHOLDER ? "" : body;
}

/** Moves the unreleased notes under the version heading. */
export function stampRelease(text, version, date) {
  const notes = unreleasedNotes(text);
  const { lines, starts } = sections(text);
  const start = starts.find((index) => lines[index].trim() === UNRELEASED);
  const released = `## v${version} (${date})\n\n${notes || "Maintenance release."}\n`;
  const fresh = `${UNRELEASED}\n\n${PLACEHOLDER}\n\n${released}`;
  if (start === undefined) {
    const first = starts[0] ?? lines.length;
    const head = lines.slice(0, first).join("\n").trimEnd();
    const rest = lines.slice(first).join("\n").trim();
    return `${head ? `${head}\n\n` : ""}${fresh}${rest ? `\n${rest}\n` : ""}`;
  }
  const end = starts.find((index) => index > start) ?? lines.length;
  const head = lines.slice(0, start).join("\n").trimEnd();
  const rest = lines.slice(end).join("\n").trim();
  return `${head ? `${head}\n\n` : ""}${fresh}${rest ? `\n${rest}\n` : ""}`;
}

/** The notes of one released version. */
export function versionNotes(text, version) {
  const { lines, starts } = sections(text);
  const start = starts.find((index) =>
    lines[index].startsWith(`## v${version} `),
  );
  if (start === undefined) return "";
  const end = starts.find((index) => index > start) ?? lines.length;
  return lines
    .slice(start + 1, end)
    .join("\n")
    .trim();
}

export function nextVersion(current, level) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(current);
  if (!match) throw new Error(`Invalid current version ${current}.`);
  const [major, minor, patch] = match.slice(1).map(Number);
  if (level === "major") return `${major + 1}.0.0`;
  if (level === "minor") return `${major}.${minor + 1}.0`;
  if (level === "patch") return `${major}.${minor}.${patch + 1}`;
  throw new Error(`Unknown bump level ${level}.`);
}

/** Highest (major) / (minor) / (patch) marker in the given commit messages. */
/**
 * Only the subject (first line) of a commit asks for a release, so a body that
 * merely mentions the markers does not. Reverts never release.
 */
export function bumpLevel(messages) {
  const subjects = messages
    .map((message) => String(message).split(/\r?\n/, 1)[0])
    .filter((subject) => !/^revert\b/i.test(subject))
    .join("\n");
  for (const level of ["major", "minor", "patch"])
    if (new RegExp(`\\(${level}\\)`, "i").test(subjects)) return level;
  return null;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { values } = parseArgs({
    options: {
      file: { type: "string", default: "RELEASE_NOTES.md" },
      stamp: { type: "string" },
      date: { type: "string" },
      notes: { type: "string" },
    },
  });
  const text = readFileSync(values.file, "utf8");
  if (values.stamp) {
    writeFileSync(
      values.file,
      stampRelease(
        text,
        values.stamp,
        values.date ?? new Date().toISOString().slice(0, 10),
      ),
    );
  } else if (values.notes) {
    process.stdout.write(versionNotes(text, values.notes) + "\n");
  } else {
    process.stdout.write(unreleasedNotes(text) + "\n");
  }
}
