import { BookOpenText } from "lucide-react";
import { BRAND } from "@/lib/brand";

export const APP_NAME = BRAND.name;

export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <div className="brand-gradient flex h-8 w-8 items-center justify-center rounded-lg text-white shadow-sm">
        <BookOpenText className="h-4.5 w-4.5" />
      </div>
      {!compact && <span className="text-lg font-bold tracking-tight text-slate-800">{APP_NAME}</span>}
    </div>
  );
}
