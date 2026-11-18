import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
export interface ProfileQuestion {
  id: string;
  label: string;
  question: string;
  hint: string;
}
export function loadUnderstandingSkill() {
  const source = fileURLToPath(
    new URL("../skills/understand-user/", import.meta.url),
  );
  const dir = existsSync(join(source, "SKILL.md"))
    ? source
    : fileURLToPath(new URL("../../skills/understand-user/", import.meta.url));
  const loaded = loadSkillsFromDir({ dir, source: "mr-on-bundled" });
  if (loaded.diagnostics.length || loaded.skills.length !== 1)
    throw Error("Failed to load the user-understanding skill");
  const text = readFileSync(join(dir, "SKILL.md"), "utf8");
  const questions = JSON.parse(
    readFileSync(join(dir, "questions.json"), "utf8"),
  ) as ProfileQuestion[];
  return { skill: loaded.skills[0], text, questions };
}
