import type { PagesStore } from "@work-shape/catalyst-core";
import * as operations from "../postgres-page-operations";
import type { PostgresConnection } from "../postgres-database";

export function createPostgresPagesStore(db: PostgresConnection): PagesStore {
  return {
    ensurePage: (input) => operations.ensurePage(db, input),
    createPageFileSet: (input) => operations.createPageFileSet(db, input),
    listPages: (input) => operations.listPages(db, input),
    getPage: (input) => operations.getPage(db, input),
    listPageFileSets: (input) => operations.listPageFileSets(db, input),
    getPageFileSet: (input) => operations.getPageFileSet(db, input),
    getServedFileSet: (input) => operations.getServedFileSet(db, input),
    createAssetFileSet: (input) => operations.createAssetFileSet(db, input),
    getAssetFileSet: (input) => operations.getAssetFileSet(db, input),
    deleteAssetFileSet: (input) => operations.deleteAssetFileSet(db, input),
    listConversationPageIds: (input) => operations.listConversationPageIds(db, input),
    deletePage: (input) => operations.deletePage(db, input),
    createPageBuild: (input) => operations.createPageBuild(db, input),
    getPageBuild: (input) => operations.getPageBuild(db, input),
    finishPageBuild: (input) => operations.finishPageBuild(db, input),
    deletePageBuild: (input) => operations.deletePageBuild(db, input)
  };
}
