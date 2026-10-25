import { cookies } from "next/headers";
import type { CSSProperties } from "react";
import { PanelSidebar } from "@/components/panel/panel-sidebar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";

export default async function PanelLayout({ children }: LayoutProps<"/">) {
  // The sidebar component stores its open state in this cookie, so a reload keeps it collapsed.
  const open = (await cookies()).get("sidebar_state")?.value !== "false";
  return (
    <SidebarProvider
      defaultOpen={open}
      style={{ "--sidebar-width": "calc(var(--spacing) * 60)", "--header-height": "calc(var(--spacing) * 12)" } as CSSProperties}
    >
      <PanelSidebar variant="inset" />
      <SidebarInset className="h-svh min-h-0 overflow-hidden md:h-[calc(100svh-1rem)]">{children}</SidebarInset>
    </SidebarProvider>
  );
}
