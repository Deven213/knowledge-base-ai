"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { CalendarDays, ChevronRight, Plus, Search, Settings, Trash2 } from "lucide-react";
import { LogoutButton } from "../LogoutButton";
import type { ConversationSummaryDTO } from "@/lib/types";
import { Logo } from "../Logo";

function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function groupLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (dayKey(iso) === dayKey(today.toISOString())) return "Today";
  if (dayKey(iso) === dayKey(yesterday.toISOString())) return "Yesterday";
  return d.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
}

interface Props {
  conversations: ConversationSummaryDTO[];
  activeId: string | null;
  search: string;
  onSearch: (q: string) => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (c: ConversationSummaryDTO) => void;
}

export function ChatSidebar({ conversations, activeId, search, onSearch, onSelect, onNew, onDelete }: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const groups = useMemo(() => {
    const map = new Map<string, ConversationSummaryDTO[]>();
    for (const c of conversations) {
      const label = groupLabel(c.updatedAt);
      map.set(label, [...(map.get(label) ?? []), c]);
    }
    return [...map.entries()];
  }, [conversations]);

  const toggle = (label: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });

  return (
    <div className="flex h-full flex-col bg-white">
      <div className="px-4 pt-5 pb-3">
        <Logo />
      </div>
      <div className="space-y-2 px-3">
        <button type="button" onClick={onNew} className="btn btn-dark w-full">
          <Plus className="h-4 w-4" /> New chat
        </button>
        <label className="relative block">
          <span className="sr-only">Search chats</span>
          <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input className="input pl-9" placeholder="Search chats..." value={search} onChange={(e) => onSearch(e.target.value)} />
        </label>
      </div>

      <nav className="mt-3 flex-1 overflow-y-auto px-2 pb-3" aria-label="Chat history">
        {groups.map(([label, items]) => {
          const isCollapsed = collapsed.has(label);
          return (
            <div key={label} className="mb-1">
              <button
                type="button"
                onClick={() => toggle(label)}
                aria-expanded={!isCollapsed}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
              >
                <ChevronRight className={`h-3.5 w-3.5 text-slate-400 transition-transform ${isCollapsed ? "" : "rotate-90"}`} />
                <CalendarDays className="h-4 w-4 text-slate-400" />
                <span className="flex-1 text-left font-medium">{label}</span>
                <span className="rounded-full bg-slate-100 px-1.5 text-[11px] text-slate-500">{items.length}</span>
              </button>
              {!isCollapsed && (
                <ul className="mt-0.5 ml-5 border-l border-slate-100 pl-2">
                  {items.map((c) => (
                    <li key={c.id} className="group relative">
                      <button
                        type="button"
                        onClick={() => onSelect(c.id)}
                        aria-current={c.id === activeId ? "true" : undefined}
                        className={`block w-full truncate rounded-md py-1.5 pr-7 pl-2 text-left text-sm ${
                          c.id === activeId ? "bg-brand-50 font-medium text-brand-700" : "text-slate-600 hover:bg-slate-50"
                        }`}
                        title={c.title}
                      >
                        {c.title}
                      </button>
                      <button
                        type="button"
                        onClick={() => onDelete(c)}
                        aria-label={`Delete chat "${c.title}"`}
                        className="absolute top-1/2 right-1 -translate-y-1/2 rounded p-1 text-slate-400 opacity-0 group-hover:opacity-100 hover:bg-red-50 hover:text-red-600 focus:opacity-100"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
        <p className="py-4 text-center text-xs text-slate-400">
          {conversations.length === 0 ? (search ? "No chats match your search" : "No chats yet") : "You've reached the end"}
        </p>
      </nav>

      <div className="flex items-center gap-1 border-t border-slate-100 py-2 pr-2">
        <Link href="/admin" className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-4 py-1.5 hover:bg-slate-50">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-600 text-xs font-semibold text-white">A</div>
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-1.5 truncate text-sm font-medium text-slate-800">
              Administrator
              <span className="rounded-full bg-amber-100 px-1.5 py-px text-[10px] font-semibold text-amber-800">Demo</span>
            </p>
            <p className="truncate text-xs text-slate-500">Admin panel</p>
          </div>
          <Settings className="h-4 w-4 shrink-0 text-slate-400" />
        </Link>
        <LogoutButton compact />
      </div>
    </div>
  );
}
