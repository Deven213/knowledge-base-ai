import "server-only";
import { scopeKey, websiteHost, type KnowledgeScope, type KnowledgeSourceDTO } from "@/lib/knowledge-scope";
import type { DocumentRow } from "../db/repositories";

// Knowledge scopes are resolved to document IDs on the server, at question time, from the documents'
// own source metadata (source_type, integration_id, source_url). Retrieval then uses the existing
// document filter of the vector search: there is no second retrieval path.

/** Documents chat can search: indexed with the current embedding model. */
export function searchableDocuments(rows: DocumentRow[], embeddingModel: string): DocumentRow[] {
  return rows.filter((r) => r.status === "ready" && r.embedding_models === embeddingModel);
}

function inScope(row: DocumentRow, scope: KnowledgeScope): boolean {
  switch (scope.type) {
    case "all":
      return true;
    case "document":
      return row.id === scope.documentId;
    case "website":
      return row.source_type === "website" && row.integration_id === scope.integrationId && websiteHost(row.source_url) === scope.host;
    default:
      return row.source_type === scope.type && row.integration_id === scope.integrationId;
  }
}

/**
 * Document IDs to search for a scope: undefined = everything; otherwise exactly these documents
 * (possibly none, in which case nothing is searched — never "everything").
 */
export function scopeDocumentIds(rows: DocumentRow[], scope: KnowledgeScope): string[] | undefined {
  if (scope.type === "all") return undefined;
  return rows.filter((r) => inScope(r, scope)).map((r) => r.id);
}

/** "Chat with" options: All Knowledge Base, each website, Google Drive, OneDrive, each uploaded document. */
export function listKnowledgeSources(rows: DocumentRow[]): KnowledgeSourceDTO[] {
  const groups = new Map<string, KnowledgeSourceDTO>();
  const add = (scope: KnowledgeScope, label: string) => {
    const key = scopeKey(scope);
    const existing = groups.get(key);
    if (existing) existing.count += 1;
    else groups.set(key, { key, scope, label, count: 1 });
  };

  for (const row of rows) {
    if (row.source_type === "website" && row.integration_id) {
      const host = websiteHost(row.source_url);
      if (host) add({ type: "website", integrationId: row.integration_id, host }, host);
    } else if (row.source_type === "google_drive" && row.integration_id) {
      add({ type: "google_drive", integrationId: row.integration_id }, "Google Drive");
    } else if (row.source_type === "onedrive" && row.integration_id) {
      add({ type: "onedrive", integrationId: row.integration_id }, "OneDrive");
    } else if (!row.source_type || row.source_type === "upload") {
      add({ type: "document", documentId: row.id }, row.filename);
    }
  }

  const order: Record<KnowledgeScope["type"], number> = { all: 0, website: 1, google_drive: 2, onedrive: 3, document: 4 };
  const sources = [...groups.values()].sort((a, b) => order[a.scope.type] - order[b.scope.type] || a.label.localeCompare(b.label));
  return [{ key: "all", scope: { type: "all" }, label: "All Knowledge Base", count: rows.length }, ...sources];
}
