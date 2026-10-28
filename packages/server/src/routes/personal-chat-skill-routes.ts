import { apiOperations } from "@work-shape/catalyst-api-contract";
import { AppError, auditActorFromIdentity, getSubjectUserId } from "@work-shape/catalyst-core";
import type { Route } from "../http/route";
import { isFirstPartyPerson } from "../users/operation-settings-service";
import type { ResolvedChatServerOptions } from "../types";

/**
 * "In meinen Chats verwenden" (SCOPE-MYCHATS): the skills of a person's Personal Workspace
 * that every agent may read in that person's own chats. The person reads and switches their
 * own, signed in themself: the skills are those of the signed-in person's workspace, never
 * named by a parameter, so another person's skill answers as one that does not exist. A key,
 * a service principal and an agent are refused the switch. Nothing is shared by it: which runs
 * read a skill is decided where a run's skills are resolved.
 */
export function registerPersonalChatSkillRoutes(
  route: Route,
  options: ResolvedChatServerOptions
): void {
  const store = options.configAssets.store;
  const clientInstanceId = options.clientInstanceId;
  const setOwn = apiOperations["me.chat_skills.set"];

  route(apiOperations["me.chat_skills.list"], async ({ user }) => {
    if (!isFirstPartyPerson(user)) {
      throw new AppError("FORBIDDEN", "Only you read your own skills, in the interface");
    }
    return {
      items: await store.listPersonalChatSkills({
        clientInstanceId,
        userId: getSubjectUserId(user)
      })
    };
  });

  route.operation(setOwn, {
    // A switch is turned back as easily as it was turned on.
    changeClass: "reversible",
    authorize: (_input, { actor, origin }) =>
      !isFirstPartyPerson(actor) || origin.kind !== "user"
        ? {
            allowed: false,
            action: setOwn.id,
            reason: "no_grant",
            message: "Only a person signed in themself switches their own skills for their chats"
          }
        : { allowed: true },
    async execute({ name, inMyChats }, context) {
      if (!isFirstPartyPerson(context.actor)) {
        throw new AppError("FORBIDDEN", "Only you switch your own skills, in the interface");
      }
      const userId = getSubjectUserId(context.actor);
      const skill = await store.setPersonalChatSkill({
        clientInstanceId,
        userId,
        skillName: name,
        inMyChats
      });
      // Who switched which of their skills on or off, nothing of its content.
      await context.audit.record({
        type: "user.chat_skill_changed",
        status: "success",
        actor: auditActorFromIdentity(context.actor),
        correlationId: context.correlationId,
        subject: userId,
        metadata: { skill: skill.name, inMyChats: skill.inMyChats }
      });
      return skill;
    }
  });
}
