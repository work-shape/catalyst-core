import { skillFileText, type SkillFileInput } from "./skill-files";

// Well-known key shapes only. A warning reveals the location, never any matched text.
const SECRET_LIKE =
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|xox[abpr]-[A-Za-z0-9-]+|sk-[A-Za-z0-9_-]{20,}/u;

export function skillSecretWarnings(
  files: readonly SkillFileInput[]
): { code: string; message: string }[] {
  return [...files]
    .sort((left, right) => left.path.localeCompare(right.path))
    .flatMap((file) => {
      const text = skillFileText(file.bytes);
      if (text === undefined) return [];
      return text.split(/\r\n|\n|\r/u).flatMap((line, index) =>
        SECRET_LIKE.test(line)
          ? [
              {
                code: "skill_file_secret_like",
                message: `Possible secret in '${file.path}' at line ${index + 1}.`
              }
            ]
          : []
      );
    });
}
