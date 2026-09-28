import { LogOut } from "lucide-react";

/**
 * Signs out with a plain form POST: the server deletes the session and redirects to the landing
 * page (works even before any JavaScript has loaded).
 */
export function LogoutButton({ compact = false, className = "" }: { compact?: boolean; className?: string }) {
  return (
    <form action="/api/auth/logout" method="post" className={className}>
      <button
        type="submit"
        title="Log out"
        aria-label="Log out"
        className={`btn btn-ghost gap-1.5 text-slate-500 hover:text-red-600 ${compact ? "p-2" : "px-2.5 py-1.5 text-sm"}`}
      >
        <LogOut className="h-4 w-4" />
        {!compact && <span>Logout</span>}
      </button>
    </form>
  );
}
