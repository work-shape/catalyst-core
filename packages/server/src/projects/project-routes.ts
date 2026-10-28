import { apiOperations } from "@work-shape/catalyst-api-contract";
import {
  AppError,
  asCollaborationWorkspaceId,
  auditActorFromUser,
  isAuthenticatedServicePrincipal,
  type AuthenticatedIdentity,
  type AuthenticatedUser,
  type OperationAuthorization
} from "@work-shape/catalyst-core";
import { ConversationWorkflow } from "../conversations/conversation-service";
import { displaysInline } from "../http/download";
import { contentDisposition } from "../routes/conversation-file-routes";
import type { Route } from "../http/route";
import { conversationIdParam } from "../routes/request-context";
import type { ChatServerOptions } from "../types";
import { addDraftAttachmentFromBytes } from "../routes/draft-attachment-routes";
import { ProjectFileService } from "./project-files";
import { ProjectWorkflow } from "./project-service";
import { ProjectSetupService } from "./project-setup";
import { resolveRequestLocale } from "../routes/request-context";

/**
 * Projects (PRJ-1), of the module `projects`, which refuses all of them where it is off. A
 * project is chat work of people: membership and the audience decide every call, so no grant
 * is asked and a service principal is refused.
 */
export function registerProjectRoutes(route: Route, options: ChatServerOptions): void {
  const projects = new ProjectWorkflow(options);
  const conversations = new ConversationWorkflow(options);
  const files = new ProjectFileService(options);
  const setup = new ProjectSetupService(options);

  route(apiOperations["projects.list"], ({ user, params }) =>
    projects.list(user, asCollaborationWorkspaceId(params.collaborationWorkspaceId))
  );

  route(apiOperations["projects.list_mine"], ({ user }) => projects.listMine(user));

  route(apiOperations["projects.get"], ({ user, params }) =>
    projects.get(user, params.projectName)
  );

  route.operation(apiOperations["projects.create"], {
    // Nothing deletes a project yet: it stays once made.
    changeClass: "irreversible",
    authorize: authorizePerson("projects.create"),
    resource: ({ collaborationWorkspaceId }) => ({
      kind: "collaboration_workspace",
      id: collaborationWorkspaceId
    }),
    execute: ({ collaborationWorkspaceId, title, description, audience }, context) =>
      projects.create(personOf(context.actor), context, {
        collaborationWorkspaceId: asCollaborationWorkspaceId(collaborationWorkspaceId),
        title,
        ...(description ? { description } : {}),
        ...(audience ? { audience } : {})
      })
  });

  // A project's default agent and skills (PRJ-7) and Knowledge Bases (PRJ-8).
  route(apiOperations["projects.setup.get"], ({ user, params, request }) =>
    setup.setup(user, params.projectId, resolveRequestLocale(options, request))
  );

  route.operation(apiOperations["projects.setup.set"], {
    // The earlier choice is set again by the same call.
    changeClass: "reversible",
    authorize: authorizePerson("projects.setup.set"),
    resource: ({ projectId }) => ({ kind: "project", id: projectId }),
    execute: ({ projectId, defaultAgent, skills, knowledgeBases }, context) =>
      setup.set(
        personOf(context.actor),
        {
          correlationId: context.correlationId,
          audit: context.audit,
          ...(context.runtime.locale ? { locale: context.runtime.locale } : {})
        },
        projectId,
        {
          ...(defaultAgent === undefined ? {} : { defaultAgent }),
          ...(skills === undefined ? {} : { skills }),
          ...(knowledgeBases === undefined ? {} : { knowledgeBases })
        }
      )
  });

  route.operation(apiOperations["conversations.set_project"], {
    // Taken out again, or put back, by the same call.
    changeClass: "reversible",
    authorize: authorizePerson("conversations.set_project"),
    resource: ({ conversationId }) => ({ kind: "conversation", id: conversationId }),
    execute: ({ conversationId, projectId }, context) =>
      conversations.setConversationProject(
        conversationIdParam({ conversationId }),
        personOf(context.actor),
        context,
        projectId
      )
  });

  // Project files (PRJ-2). The service asks the project's audience on every call.
  route(apiOperations["projects.files.list"], ({ user, params }) =>
    files.listFiles(user, params.projectId)
  );

  route(apiOperations["projects.files.versions"], ({ user, params, query }) =>
    files.versions(user, params.projectId, query.path)
  );

  route(apiOperations["conversations.project_instructions.get"], ({ user, params }) =>
    files.conversationInstructions(user, params.conversationId)
  );

  route(apiOperations["projects.files.get_content"], async ({ user, params, query, reply }) => {
    const file = await files.content(user, params.projectId, query.path, query.version);
    const download = query.download === "true";
    return reply
      .header("content-type", file.mimeType)
      .header("content-length", String(file.bytes.byteLength))
      .header("cache-control", "private, max-age=60")
      .header("x-content-type-options", "nosniff")
      .header(
        "content-disposition",
        contentDisposition(
          !download && displaysInline(file.mimeType) ? "inline" : "attachment",
          file.filename
        )
      )
      .send(Buffer.from(file.bytes));
  });

  route.operation(apiOperations["projects.files.upload"], {
    // The earlier version is kept: a restore takes it back.
    changeClass: "reversible",
    authorize: authorizePerson("projects.files.upload"),
    resource: ({ projectId }) => ({ kind: "project", id: projectId }),
    uploadLimitBytes: files.limits.maxFileBytes,
    execute: async ({ projectId, path, replaces }, context) => {
      const upload = context.runtime.upload;
      if (!upload) throw new AppError("VALIDATION_FAILED", "A file upload is required");
      if (upload.byteSize > files.limits.maxFileBytes) {
        throw new AppError(
          "VALIDATION_FAILED",
          `A project file has at most ${String(files.limits.maxFileBytes)} bytes`,
          { reason: "project_file_bytes_limit" },
          { exposeMessage: true }
        );
      }
      return files.upload(personOf(context.actor), projectId, {
        ...(path ? { path } : {}),
        filename: upload.filename,
        ...(upload.mimeType ? { mimeType: upload.mimeType } : {}),
        bytes: await upload.read(),
        ...(replaces === undefined ? {} : { replaces })
      });
    }
  });

  route.operation(apiOperations["projects.files.move"], {
    changeClass: "reversible",
    authorize: authorizePerson("projects.files.move"),
    resource: ({ projectId }) => ({ kind: "project", id: projectId }),
    execute: ({ projectId, from, to }, context) =>
      files.move(personOf(context.actor), projectId, from, to)
  });

  route.operation(apiOperations["projects.files.delete"], {
    // A deletion is a version: a restore takes it back.
    changeClass: "reversible",
    authorize: authorizePerson("projects.files.delete"),
    resource: ({ projectId }) => ({ kind: "project", id: projectId }),
    execute: ({ projectId, path, replaces }, context) =>
      files.remove(personOf(context.actor), projectId, path, replaces)
  });

  route.operation(apiOperations["projects.files.purge"], {
    changeClass: "irreversible",
    authorize: authorizePerson("projects.files.purge"),
    resource: ({ projectId }) => ({ kind: "project", id: projectId }),
    execute: async ({ projectId, path }, context) => {
      const purged = await files.purge(personOf(context.actor), projectId, path);
      // Ids and a count: never the path, which can name a client.
      await context.audit.record({
        type: "project.file_purged",
        status: "success",
        actor: auditActorFromUser(personOf(context.actor)),
        subject: projectId,
        correlationId: context.correlationId,
        metadata: { versions: purged.versions }
      });
      return purged;
    }
  });

  route.operation(apiOperations["projects.files.restore"], {
    changeClass: "reversible",
    authorize: authorizePerson("projects.files.restore"),
    resource: ({ projectId }) => ({ kind: "project", id: projectId }),
    execute: ({ projectId, path, version, replaces }, context) =>
      files.restore(personOf(context.actor), projectId, {
        path,
        version,
        ...(replaces === undefined ? {} : { replaces })
      })
  });

  route.operation(apiOperations["conversations.project_files.save"], {
    changeClass: "reversible",
    authorize: authorizePerson("conversations.project_files.save"),
    resource: ({ conversationId }) => ({ kind: "conversation", id: conversationId }),
    execute: ({ conversationId, source, path }, context) =>
      files.saveFromConversation(personOf(context.actor), conversationId, {
        source,
        ...(path ? { path } : {})
      })
  });

  route.operation(apiOperations["conversations.draft_attachments.add_from_project"], {
    // The draft attachment is removed as one uploaded is.
    changeClass: "reversible",
    authorize: authorizePerson("conversations.draft_attachments.add_from_project"),
    resource: ({ conversationId }) => ({ kind: "conversation", id: conversationId }),
    execute: async ({ conversationId, projectId, path, agentName }, context) => {
      const user = personOf(context.actor);
      const file = await files.fileForConversation(user, conversationId, { projectId, path });
      return addDraftAttachmentFromBytes(options, {
        conversation: file.conversation,
        user,
        access: context.access,
        ...(agentName ? { agentName } : {}),
        ...(context.runtime.locale ? { locale: context.runtime.locale } : {}),
        filename: file.filename,
        mimeType: file.mimeType,
        bytes: file.bytes
      });
    }
  });
}

function authorizePerson(action: string) {
  return (_input: unknown, { actor }: { actor: AuthenticatedIdentity }): OperationAuthorization =>
    isAuthenticatedServicePrincipal(actor)
      ? { allowed: false, action, reason: "no_grant", message: "Only a person works in projects" }
      : { allowed: true };
}

function personOf(actor: AuthenticatedIdentity): AuthenticatedUser {
  if (isAuthenticatedServicePrincipal(actor)) {
    throw new AppError("FORBIDDEN", "Only a person works in projects");
  }
  return actor;
}
