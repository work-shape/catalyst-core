// @rights-copy: included in the rights wording guard.
import { defineTranslations } from "./translation-area";

// Instance > Access: the words of the keys `admin/access/kinds/skill.ts` names.
export const accessSkill = defineTranslations({
  en: {
    "access.scopeSkill": "Skill {name}",
    "access.kindSkill": "Skills",
    "access.objectSkill": "the skill {name}",
    "access.actionApproveSkillDescription":
      "Approve proposed changes to a skill that wait in the Inbox"
  },
  de: {
    "access.scopeSkill": "Skill {name}",
    "access.kindSkill": "Skills",
    "access.objectSkill": "den Skill {name}",
    "access.actionApproveSkillDescription":
      "Vorgeschlagene Änderungen an einem Skill freigeben, die im Eingang warten"
  }
});
