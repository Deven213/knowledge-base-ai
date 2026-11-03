"use client";

import { Stethoscope } from "lucide-react";
import { EmptyState } from "@/components/ui";

/** Shown instead of the consultation pages to anyone who isn't a doctor. A client component, so the icon can be passed to EmptyState from here (a server page can't hand a component to one). */
export function NotADoctor() {
  return (
    <div className="card mt-6">
      <EmptyState icon={Stethoscope} title="Consultations are for doctors">
        Only a person with the Doctor role can record and review consultations. An administrator can give you that role in Settings, Team.
      </EmptyState>
    </div>
  );
}
