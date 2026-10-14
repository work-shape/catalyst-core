import { apiOperations } from "@vivd-catalyst/api-contract";
import type { Route } from "../http/route";
import { PersonalApiKeysWorkflow, authorizeOwnKeyChange } from "../personal-api-keys-workflow";
import type { ChatServerOptions } from "../types";

/**
 * You > API keys, the CLI's connect code, and the Personal keys of Instance > API access. The
 * changes are registered operations: each call is an Operation Run with its audit rows. The
 * module `personalApiKeys` refuses all of them where it is off.
 */
export function registerPersonalApiKeyRoutes(route: Route, options: ChatServerOptions): void {
  const workflow = new PersonalApiKeysWorkflow(options);
  const createOwn = apiOperations["me.api_keys.create"];
  const revokeOwn = apiOperations["me.api_keys.revoke"];
  const confirmCode = apiOperations["me.connect_codes.confirm"];

  route(apiOperations["me.api_keys.list"], ({ user, paging }) =>
    workflow.listOwnKeys(user, paging)
  );

  route.operation(createOwn, {
    // A key can be revoked. Its descriptor declares the answer `secret`: the run keeps none.
    changeClass: "reversible",
    authorize: authorizeOwnKeyChange(createOwn.id),
    execute: (input, context) => workflow.createOwnKey(context, input)
  });

  route.operation(revokeOwn, {
    // A revoked key stays revoked.
    authorize: authorizeOwnKeyChange(revokeOwn.id),
    resource: ({ keyId }) => ({ kind: "api_credential", id: keyId }),
    execute: ({ keyId }, context) => workflow.revokeOwnKey(context, keyId)
  });

  route(apiOperations["me.connect_codes.get"], ({ params }) =>
    workflow.getConnectCode(params.userCode)
  );

  route.operation(confirmCode, {
    // The key it lets the CLI collect can be revoked.
    changeClass: "reversible",
    authorize: authorizeOwnKeyChange(confirmCode.id),
    execute: ({ userCode, ...fields }, context) =>
      workflow.confirmConnectCode(context, userCode, fields)
  });

  // Public: the code alone grants nothing, and the CLI is signed in nowhere yet.
  route(apiOperations["connect_codes.start"], ({ body }) =>
    workflow.startConnectCode(body.clientLabel)
  );

  route(apiOperations["connect_codes.redeem"], ({ body, context }) =>
    workflow.redeemConnectCode(body.deviceCode, context.correlationId)
  );

  route(apiOperations["personal_api_keys.list"], ({ user, context, paging }) =>
    workflow.listEveryKey(user, context, paging)
  );

  route.operation(apiOperations["personal_api_keys.revoke"], {
    resource: ({ keyId }) => ({ kind: "api_credential", id: keyId }),
    execute: ({ keyId }, context) => workflow.revokeAnyKey(context, keyId)
  });
}
