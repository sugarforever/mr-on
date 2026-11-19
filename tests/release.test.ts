import assert from "node:assert/strict";
import { test } from "node:test";
import { validateRelease } from "../scripts/release-metadata.js";

test("release metadata binds stable tag to package and lockfile", () => {
  const pkg = { name: "mr-on", version: "0.2.0" };
  const lock = { name: "mr-on", version: "0.2.0", packages: { "": pkg } };
  assert.equal(validateRelease("v0.2.0", pkg, lock), "0.2.0");
  for (const tag of [
    "v0.1.0",
    "main",
    "v0.2.0-beta.1",
    "v01.2.0",
    "v0.2.0\n",
  ]) {
    assert.throws(() => validateRelease(tag, pkg, lock));
  }
  assert.throws(() =>
    validateRelease("v0.2.0", { ...pkg, private: true }, lock),
  );
  assert.throws(() =>
    validateRelease("v0.2.0", pkg, { ...lock, version: "0.1.0" }),
  );
  assert.throws(() =>
    validateRelease("v0.2.0", pkg, {
      ...lock,
      packages: { "": { ...pkg, version: "0.1.0" } },
    }),
  );
});
