import type { ReactNode } from "react";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { ThemeToggle } from "@/components/theme-toggle";
import { cn } from "@/lib/utils";
import type { FeedStatus } from "./sealed";

const STATUS: Record<FeedStatus, { dot: string; label: string }> = {
  live: { dot: "animate-pulse bg-success", label: "Live" },
  connecting: { dot: "bg-warning", label: "Connecting" },
  off: { dot: "bg-faint", label: "Live updates off in previews" },
};

/** The page title beside the sidebar toggle, and how fresh the page's data is on the right. */
export function PanelHeader({ title, status, note, actions }: { title: string; status: FeedStatus; note?: string; actions?: ReactNode }) {
  return (
    <header className="flex h-(--header-height) shrink-0 items-center gap-2 border-b">
      <div className="flex w-full items-center gap-1 px-4 lg:gap-2 lg:px-6">
        <SidebarTrigger className="-ml-1" />
        <Separator orientation="vertical" className="mx-2 data-[orientation=vertical]:h-4" />
        <h1 className="text-base font-medium">{title}</h1>
        <div className="ml-auto flex items-center gap-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span className={cn("size-1.5 shrink-0 rounded-full", STATUS[status].dot)} />
            <span>
              {STATUS[status].label}
              {note && ` · ${note}`}
            </span>
          </div>
          {actions}
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
