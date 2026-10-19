const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { validateLesson } = require("./validate");

test("File Browser Lesson matches the schema and only references its designated Lab ID", () => {
  const lesson = JSON.parse(
    fs.readFileSync(path.join(__dirname, "filebrowser-auth-hook.json"), "utf8"),
  );
  assert.deepEqual(validateLesson(lesson), []);
  assert.deepEqual(
    lesson.spec.labs.map(({ ref, labId, purpose }) => ({ ref, labId, purpose })),
    [
      { ref: "vulnerable", labId: "vulhub/filebrowser-cve-2026-54088", purpose: "reproduce" },
      { ref: "fixed", labId: "vulhub/filebrowser-cve-2026-54088", purpose: "compare-fix" },
    ],
  );
});

test("go-git Lesson matches the schema and uses one comparison Lab", () => {
  const lesson = JSON.parse(
    fs.readFileSync(path.join(__dirname, "go-git-loose-reference-path-traversal.json"), "utf8"),
  );
  assert.deepEqual(validateLesson(lesson), []);
  assert.deepEqual(
    lesson.spec.labs.map(({ ref, labId, purpose }) => ({ ref, labId, purpose })),
    [
      { ref: "vulnerable", labId: "reprokit/go-git-cve-2026-71557", purpose: "reproduce" },
      { ref: "fixed", labId: "reprokit/go-git-cve-2026-71557", purpose: "compare-fix" },
    ],
  );
});
