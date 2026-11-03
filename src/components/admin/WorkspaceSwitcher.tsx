"use client";

import { useState } from "react";
import { api } from "@/lib/api";

/** Shown only to people who belong to more than one workspace. Switching reloads the product in the chosen workspace. */
export function WorkspaceSwitcher({ currentId, workspaces }: { currentId: string; workspaces: { id: string; name: string }[] }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (workspaces.length < 2) return null;

  async function change(orgId: string) {
    setBusy(true);
    setError(null);
    try {
      await api.switchWorkspace(orgId);
      // A hard navigation on purpose (not router.push): no client state or cached data from the previous workspace may survive.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign("/admin");
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="border-t border-slate-100 px-4 py-3">
      <label htmlFor="workspace-switcher" className="label">
        Workspace
      </label>
      <select id="workspace-switcher" className="input text-sm" value={currentId} disabled={busy} onChange={(e) => void change(e.target.value)}>
        {workspaces.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name}
          </option>
        ))}
      </select>
      {error && <p role="alert" className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}
