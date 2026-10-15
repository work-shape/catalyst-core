import type { PersonalApiKeyStore } from "@work-shape/catalyst-core";
import {
  approveConnectCode,
  createPersonalApiKey,
  findConnectCode,
  listPersonalApiKeys,
  markPersonalApiKeyUsed,
  redeemConnectCode,
  resolvePersonalApiKey,
  revokePersonalApiKey,
  startConnectCode
} from "../postgres-personal-api-key-operations";
import type { PostgresConnection } from "../postgres-database";

export function createPostgresPersonalApiKeyStore(db: PostgresConnection): PersonalApiKeyStore {
  return {
    listPersonalApiKeys: (input) => listPersonalApiKeys(db, input),
    createPersonalApiKey: (input) => createPersonalApiKey(db, input),
    revokePersonalApiKey: (input) => revokePersonalApiKey(db, input),
    resolvePersonalApiKey: (input) => resolvePersonalApiKey(db, input),
    markPersonalApiKeyUsed: (input) => markPersonalApiKeyUsed(db, input),
    startConnectCode: (input) => startConnectCode(db, input),
    findConnectCode: (input) => findConnectCode(db, input),
    approveConnectCode: (input) => approveConnectCode(db, input),
    redeemConnectCode: (input) => redeemConnectCode(db, input)
  };
}
