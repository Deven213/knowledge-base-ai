import "server-only";
import type { CloudFolderDTO } from "@/lib/integrations";
import { IntegrationAuthError, IntegrationError } from "./errors";

// Minimal Google Drive (v3) and Microsoft Graph (OneDrive) clients: list folders, list files in a
// folder, download a file. Requests go only to the providers' fixed API hosts.

export interface CloudFile {
  id: string;
  name: string;
  size: number | null;
  mimeType: string | null;
  modifiedAt: string | null;
  webUrl: string | null;
}

export interface CloudDrive {
  label: string;
  rootId: string;
  account(token: string): Promise<string>;
  listFolders(token: string, parentId: string): Promise<CloudFolderDTO[]>;
  listFiles(token: string, folderId: string): Promise<CloudFile[]>;
  download(token: string, file: CloudFile, maxBytes: number): Promise<Buffer>;
}

const ID_PATTERN = /^[A-Za-z0-9!_.:-]{1,200}$/;
function checkId(id: string): string {
  if (!ID_PATTERN.test(id)) throw new IntegrationError("Invalid folder or file ID.");
  return id;
}

async function api<T>(label: string, url: string, token: string, what: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new IntegrationError(`${label} could not be reached.`, 502);
  }
  if (res.status === 401) throw new IntegrationAuthError(`${label} connection expired. Reconnect ${label}.`);
  if (res.status === 403) throw new IntegrationError(`Unable to access ${what} in ${label} (permission denied).`, 403);
  if (res.status === 404) throw new IntegrationError(`${what[0]!.toUpperCase()}${what.slice(1)} no longer exists in ${label}.`, 404);
  if (res.status === 429) throw new IntegrationError(`${label} is rate limiting requests. Try again in a few minutes.`, 429);
  if (!res.ok) throw new IntegrationError(`${label} returned an error (HTTP ${res.status}).`, 502);
  return (await res.json()) as T;
}

async function downloadBytes(label: string, url: string, token: string, maxBytes: number): Promise<Buffer> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000) });
  } catch {
    throw new IntegrationError(`The file could not be downloaded from ${label}.`, 502);
  }
  if (res.status === 401) throw new IntegrationAuthError(`${label} connection expired. Reconnect ${label}.`);
  if (!res.ok) throw new IntegrationError(`The file could not be downloaded from ${label} (HTTP ${res.status}).`, 502);
  if (Number(res.headers.get("content-length") ?? 0) > maxBytes) throw new IntegrationError(`The file is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > maxBytes) throw new IntegrationError(`The file is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`);
  return buffer;
}

// ── Google Drive ──

const G = "https://www.googleapis.com/drive/v3";
const G_FOLDER = "application/vnd.google-apps.folder";

interface GFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  webViewLink?: string;
}

async function gList(token: string, q: string, fields: string): Promise<GFile[]> {
  const out: GFile[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${G}/files`);
    url.searchParams.set("q", q);
    url.searchParams.set("fields", `nextPageToken, files(${fields})`);
    url.searchParams.set("pageSize", "200");
    url.searchParams.set("orderBy", "name");
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("includeItemsFromAllDrives", "true");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const page = await api<{ files: GFile[]; nextPageToken?: string }>("Google Drive", url.href, token, "the selected folder");
    out.push(...page.files);
    pageToken = page.nextPageToken;
  } while (pageToken && out.length < 2000);
  return out;
}

export const googleDrive: CloudDrive = {
  label: "Google Drive",
  rootId: "root",
  async account(token) {
    const about = await api<{ user?: { emailAddress?: string; displayName?: string } }>("Google Drive", `${G}/about?fields=user(displayName,emailAddress)`, token, "your account");
    return about.user?.emailAddress ?? about.user?.displayName ?? "Google account";
  },
  async listFolders(token, parentId) {
    const files = await gList(token, `'${checkId(parentId)}' in parents and mimeType = '${G_FOLDER}' and trashed = false`, "id,name");
    return files.map((f) => ({ id: f.id, name: f.name }));
  },
  async listFiles(token, folderId) {
    const files = await gList(token, `'${checkId(folderId)}' in parents and mimeType != '${G_FOLDER}' and trashed = false`, "id,name,mimeType,size,modifiedTime,webViewLink");
    return files.map((f) => ({ id: f.id, name: f.name, size: f.size ? Number(f.size) : null, mimeType: f.mimeType, modifiedAt: f.modifiedTime ?? null, webUrl: f.webViewLink ?? null }));
  },
  download(token, file, maxBytes) {
    return downloadBytes("Google Drive", `${G}/files/${encodeURIComponent(checkId(file.id))}?alt=media&supportsAllDrives=true`, token, maxBytes);
  },
};

// ── OneDrive (Microsoft Graph) ──

const M = "https://graph.microsoft.com/v1.0";

interface MItem {
  id: string;
  name: string;
  size?: number;
  folder?: unknown;
  file?: { mimeType?: string };
  lastModifiedDateTime?: string;
  webUrl?: string;
}

async function mChildren(token: string, parentId: string): Promise<MItem[]> {
  const out: MItem[] = [];
  const base = parentId === "root" ? `${M}/me/drive/root/children` : `${M}/me/drive/items/${encodeURIComponent(checkId(parentId))}/children`;
  let next: string | undefined = `${base}?$top=200&$select=id,name,size,folder,file,lastModifiedDateTime,webUrl`;
  while (next && out.length < 2000) {
    // Follow only Graph's own paging links.
    if (!next.startsWith(`${M}/`)) break;
    const page: { value: MItem[]; "@odata.nextLink"?: string } = await api("OneDrive", next, token, "the selected folder");
    out.push(...page.value);
    next = page["@odata.nextLink"];
  }
  return out;
}

export const oneDrive: CloudDrive = {
  label: "OneDrive",
  rootId: "root",
  async account(token) {
    const me = await api<{ displayName?: string; userPrincipalName?: string; mail?: string }>("OneDrive", `${M}/me?$select=displayName,userPrincipalName,mail`, token, "your account");
    return me.mail ?? me.userPrincipalName ?? me.displayName ?? "Microsoft account";
  },
  async listFolders(token, parentId) {
    return (await mChildren(token, parentId)).filter((i) => i.folder).map((i) => ({ id: i.id, name: i.name }));
  },
  async listFiles(token, folderId) {
    return (await mChildren(token, folderId))
      .filter((i) => i.file)
      .map((i) => ({ id: i.id, name: i.name, size: i.size ?? null, mimeType: i.file?.mimeType ?? null, modifiedAt: i.lastModifiedDateTime ?? null, webUrl: i.webUrl ?? null }));
  },
  download(token, file, maxBytes) {
    // Graph answers with a redirect to a pre-authenticated download URL, which fetch follows.
    return downloadBytes("OneDrive", `${M}/me/drive/items/${encodeURIComponent(checkId(file.id))}/content`, token, maxBytes);
  },
};
