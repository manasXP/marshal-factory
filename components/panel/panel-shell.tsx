"use client";

import { ActivityIcon, FolderGit2Icon, InboxIcon, KanbanIcon, ListOrderedIcon, type LucideIcon, PanelLeftIcon, ServerIcon, SettingsIcon } from "lucide-react";
import { LayoutGroup, MotionConfig, motion } from "motion/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, type ReactElement, type ReactNode, useContext, useEffect, useState } from "react";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Sheet, SheetPopup, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** The layout reads this cookie, so a reload keeps the rail collapsed. */
export const COLLAPSED_COOKIE = "sidebar_state";

type NavItem = { href: "/inbox" | "/" | "/queue" | "/activity" | "/machines" | "/repositories" | "/settings"; label: string; icon: LucideIcon };

/** The jobs come first, led by the inbox of jobs that need the owner. */
const NAV: readonly (readonly NavItem[])[] = [
  [
    { href: "/inbox", label: "Inbox", icon: InboxIcon },
    { href: "/", label: "Jobs", icon: KanbanIcon },
    { href: "/queue", label: "Queue", icon: ListOrderedIcon },
  ],
  [
    { href: "/activity", label: "Other activity", icon: ActivityIcon },
    { href: "/machines", label: "Machines", icon: ServerIcon },
    { href: "/repositories", label: "Repositories", icon: FolderGit2Icon },
    { href: "/settings", label: "Settings", icon: SettingsIcon },
  ],
];

const spring = { type: "spring", stiffness: 500, damping: 40 } as const;

const isActive = (href: NavItem["href"], pathname: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));

/** Typing in a field must never toggle the rail or walk a list. */
export const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

type Shell = { openNav: () => void };

const ShellContext = createContext<Shell | null>(null);

export function useShell() {
  const shell = useContext(ShellContext);
  if (!shell) throw new Error("useShell needs a PanelShell above it");
  return shell;
}

function RailTip({ collapsed, label, children }: { collapsed: boolean; label: ReactNode; children: ReactElement }) {
  return (
    <Tooltip disabled={!collapsed}>
      <TooltipTrigger render={children} />
      <TooltipPopup side="right" sideOffset={8}>
        {label}
      </TooltipPopup>
    </Tooltip>
  );
}

function Nav({
  collapsed,
  inboxCount,
  queueBadge,
  onNavigate,
  onToggle,
}: {
  collapsed: boolean;
  inboxCount: ReactNode;
  queueBadge: ReactNode;
  onNavigate?: () => void;
  onToggle?: () => void;
}) {
  const pathname = usePathname();
  const fade = cn("transition-opacity duration-150", collapsed && "pointer-events-none opacity-0");
  return (
    <div className="flex h-full min-h-0 flex-col whitespace-nowrap">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3.5">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-[5px] bg-primary text-[11px] font-semibold text-primary-foreground">M</span>
        <span className={cn("min-w-0 truncate font-medium", fade)}>Marshal Factory</span>
      </div>
      <nav aria-label="Panel" data-collapsed={collapsed || undefined} className="flex min-h-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto px-1.5 py-2">
        {NAV.map((group) => (
          <div key={group[0]!.href} className="flex flex-col gap-px">
            {group.map(({ href, label, icon: Icon }) => {
              const on = isActive(href, pathname);
              return (
                <RailTip key={href} collapsed={collapsed} label={label}>
                  <Link
                    href={href}
                    onClick={onNavigate}
                    aria-current={on ? "page" : undefined}
                    aria-label={collapsed ? label : undefined}
                    className={cn(
                      "relative flex h-8 items-center gap-2 overflow-hidden rounded-md px-2.5 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                      on ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                    )}
                  >
                    {on && <motion.span layoutId="panel-nav-marker" transition={spring} className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-foreground" />}
                    <Icon className="size-4 shrink-0" />
                    <span className={cn("min-w-0 flex-1 truncate", fade)}>{label}</span>
                    {href === "/inbox" && inboxCount}
                    {href === "/queue" && queueBadge}
                  </Link>
                </RailTip>
              );
            })}
          </div>
        ))}
      </nav>
      {/* The rail toggle keeps the bottom-left corner in both states; the theme menu sits beside it, or above it when collapsed. */}
      <div className="relative flex h-10 shrink-0 items-center gap-1 border-t px-1.5">
        {onToggle && (
          <RailTip
            collapsed
            label={
              <span className="flex items-center gap-1.5">
                {collapsed ? "Expand" : "Collapse"}
                <Kbd>[</Kbd>
              </span>
            }
          >
            <Button aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} aria-expanded={!collapsed} onClick={onToggle} size="icon-sm" variant="ghost">
              <PanelLeftIcon />
            </Button>
          </RailTip>
        )}
        <div className={cn(collapsed && "absolute bottom-full left-1.5 mb-1.5")}>
          <ThemeToggle />
        </div>
      </div>
    </div>
  );
}

/** The app frame: a hairline rail on the left that collapses with `[`, and a column each page fills with its header, content and footer. */
export function PanelShell({ defaultCollapsed, inboxCount, queueBadge, children }: { defaultCollapsed: boolean; inboxCount: ReactNode; queueBadge: ReactNode; children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    document.cookie = `${COLLAPSED_COOKIE}=${!collapsed}; path=/; max-age=${60 * 60 * 24 * 365}`;
  }, [collapsed]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "[" || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      setCollapsed((c) => !c);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const shell: Shell = { openNav: () => setNavOpen(true) };

  return (
    <MotionConfig reducedMotion="user">
      <ShellContext value={shell}>
        <LayoutGroup id="panel-shell">
          <div className="flex h-svh min-h-0 w-full overflow-hidden bg-background text-sm">
            <motion.aside
              aria-label="Sidebar"
              animate={{ width: collapsed ? 48 : 232 }}
              initial={false}
              transition={spring}
              className="hidden shrink-0 overflow-hidden border-e md:block"
            >
              <Nav collapsed={collapsed} inboxCount={inboxCount} queueBadge={queueBadge} onToggle={() => setCollapsed((c) => !c)} />
            </motion.aside>
            <Sheet open={navOpen} onOpenChange={setNavOpen}>
              <SheetPopup side="left" className="w-64 max-w-[85%] md:hidden">
                <SheetTitle className="sr-only">Navigation</SheetTitle>
                <Nav collapsed={false} inboxCount={inboxCount} queueBadge={queueBadge} onNavigate={() => setNavOpen(false)} />
              </SheetPopup>
            </Sheet>
            <main className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</main>
          </div>
        </LayoutGroup>
      </ShellContext>
    </MotionConfig>
  );
}
