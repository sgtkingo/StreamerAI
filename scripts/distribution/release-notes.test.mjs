import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bumpLevel,
  nextVersion,
  stampRelease,
  unreleasedNotes,
  versionNotes,
} from "./release-notes.mjs";

const notes = `# StreamerAI release notes

## Unreleased

- Server updates with rollback
- Windows app

## v0.1.0 (2026-11-01)

First pilot.
`;

test("bump level comes from the highest commit marker", () => {
  assert.equal(bumpLevel(["Fix player (patch)", "Add app (MINOR)"]), "minor");
  assert.equal(bumpLevel(["Rework (major)", "x (patch)"]), "major");
  assert.equal(bumpLevel(["Regular commit"]), null);
  assert.equal(
    bumpLevel([
      "Add release pipeline\n\n- bump from (major)/(minor)/(patch)",
      "Ship household setup (minor)",
    ]),
    "minor",
  );
  assert.equal(bumpLevel(["Docs\n\nMention (major) here"]), null);
  assert.equal(bumpLevel(['Revert "Release 1.0.0 (major)"']), null);
  assert.equal(nextVersion("0.1.9", "patch"), "0.1.10");
  assert.equal(nextVersion("0.1.9", "minor"), "0.2.0");
  assert.equal(nextVersion("0.1.9", "major"), "1.0.0");
});

test("release stamps the unreleased section and starts a new one", () => {
  assert.equal(
    unreleasedNotes(notes),
    "- Server updates with rollback\n- Windows app",
  );
  const stamped = stampRelease(notes, "0.2.0", "2026-11-16");
  assert.equal(unreleasedNotes(stamped), "");
  assert.equal(
    versionNotes(stamped, "0.2.0"),
    "- Server updates with rollback\n- Windows app",
  );
  assert.equal(versionNotes(stamped, "0.1.0"), "First pilot.");
  assert.match(stamped, /^# StreamerAI release notes\n\n## Unreleased\n/);
  const again = stampRelease(stamped, "0.2.1", "2026-11-17");
  assert.equal(versionNotes(again, "0.2.1"), "Maintenance release.");
  assert.equal(versionNotes(again, "0.2.0"), versionNotes(stamped, "0.2.0"));
});
