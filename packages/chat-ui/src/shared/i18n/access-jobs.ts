// @rights-copy: included in the rights wording guard.
import { defineTranslations } from "./translation-area";

// Instance > Access: the words of the keys `admin/access/kinds/jobs.ts` names.
export const accessJobs = defineTranslations({
  en: {
    "access.kindJobs": "Jobs",
    "access.actionRetryJobsDescription":
      "Run a background job again that failed or gave up, on the Jobs page."
  },
  de: {
    "access.kindJobs": "Jobs",
    "access.actionRetryJobsDescription":
      "Einen Job im Hintergrund erneut ausführen, der fehlgeschlagen ist oder aufgegeben wurde, auf der Seite Jobs."
  }
});
