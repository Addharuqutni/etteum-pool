import { NavLink, useLocation } from "react-router-dom";
import { useEffect } from "react";
import {
  LayoutDashboard,
  Users,
  Cpu,
  Key,
  Activity,
  BarChart3,
  Sliders,
  Bot,
  CreditCard,
  Globe,
  MessagesSquare,
  Sparkles,
  Filter,
  Plug,
  Layers,
  LogOut,
  X,
  Sun,
  Moon,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useTheme } from "@/hooks/useTheme";
import { useWsStatus } from "@/hooks/useWebSocket";

interface NavItem {
  label: string;
  path: string;
  icon: React.ComponentType<{ className?: string }>;
}

interface NavSection {
  title: string;
  items: NavItem[];
}

const navSections: NavSection[] = [
  {
    title: "ACCOUNTS",
    items: [
      { label: "Dashboard", path: "/", icon: LayoutDashboard },
      { label: "Accounts", path: "/accounts", icon: Users },
      { label: "Models", path: "/models", icon: Cpu },
      { label: "Combos", path: "/combos", icon: Layers },
    ],
  },
  {
    title: "TOOLS",
    items: [
      { label: "Model Studio", path: "/model-studio", icon: MessagesSquare },
      { label: "Image Studio", path: "/image-studio", icon: Sparkles },
      { label: "Integration", path: "/integration", icon: Plug },
    ],
  },
  {
    title: "PROXY",
    items: [
      { label: "API Key", path: "/api-key", icon: Key },
      { label: "Proxy Pool", path: "/proxy-pool", icon: Globe },
      { label: "VCC Pool", path: "/vcc-pool", icon: CreditCard },
      { label: "Filter Rules", path: "/filter-rules", icon: Filter },
      { label: "Proxy Settings", path: "/settings", icon: Sliders },
    ],
  },
  {
    title: "LOGS & ANALYTICS",
    items: [
      { label: "Requests", path: "/requests", icon: Activity },
      { label: "Login Logs", path: "/bot-logs", icon: Bot },
      { label: "Usage", path: "/usage", icon: BarChart3 },
    ],
  },
];

interface SidebarProps {
  onLogout?: () => void;
  open?: boolean;
  onClose?: () => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

export default function Sidebar({ onLogout, open, onClose, collapsed = false, onToggleCollapse }: SidebarProps) {
  const location = useLocation();
  const { theme, toggleTheme } = useTheme();
  const wsStatus = useWsStatus();

  useEffect(() => {
    onClose?.();
  }, [location.pathname]);

  const wsMeta =
    wsStatus === "open"
      ? { color: "var(--success)", label: "LIVE" }
      : wsStatus === "connecting"
        ? { color: "var(--warning)", label: "CONNECTING" }
        : { color: "var(--error)", label: "OFFLINE" };

  return (
      <aside
      className={cn(
        /* dvh, not vh: on mobile browsers the URL bar makes 100vh taller than
           the visible viewport, which pushes the nav footer off-screen. */
        "fixed top-0 left-0 z-overlay flex h-dvh flex-col border-r border-[var(--sidebar-border)] bg-[var(--sidebar-bg)] transition-[width,transform] duration-200 [transition-timing-function:var(--ease-out-expo)]",
        collapsed ? "w-[var(--rail-collapsed)]" : "w-[var(--rail-width)]",
        open ? "translate-x-0" : "-translate-x-full md:translate-x-0"
      )}
    >
      {/* Identity + connection state. The one glow in the app lives here and
          only when the socket is actually open. */}
      <div className={cn(
        "relative h-12 shrink-0 border-b border-[var(--sidebar-border)] px-3",
        collapsed ? "flex items-center justify-center" : "flex items-center justify-between"
      )}>
        <div className="flex min-w-0 items-center gap-2.5">
          <img src="/etteum.svg" alt="Etteum" className="w-5 h-5 flex-shrink-0" />
          {!collapsed && (
            <div className="min-w-0">
              <div className="font-mono text-[length:var(--sidebar-wordmark-size)] font-semibold leading-none tracking-caps text-[var(--foreground)]">
                ETTEUM
              </div>
              <div className="mt-1 flex items-center gap-1.5" role="status">
                <span
                  aria-hidden
                  className={cn(
                    "inline-block h-1 w-1 rounded-full",
                    wsStatus === "open" && "live-dot"
                  )}
                  style={{
                    backgroundColor: wsMeta.color,
                    boxShadow: wsStatus === "open" ? `0 0 6px ${wsMeta.color}` : undefined,
                  }}
                />
                <span className="font-mono text-[length:var(--sidebar-status-size)] tracking-[length:var(--sidebar-status-tracking)] text-[var(--muted-foreground)]">
                  {wsMeta.label}
                </span>
              </div>
            </div>
          )}
          {collapsed && (
            <span
              className={cn(
                "absolute right-1.5 top-1.5 h-1 w-1 rounded-full",
                wsStatus === "open" && "live-dot"
              )}
              style={{ backgroundColor: wsMeta.color }}
              role="status"
              aria-label={`Connection ${wsMeta.label}`}
              title={wsMeta.label}
            />
          )}
        </div>
        {onClose && !collapsed && (
          <button
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--muted-foreground)] transition-colors duration-150 ease-out hover:text-[var(--foreground)] md:hidden"
            aria-label="Close menu"
          >
            <X className="w-4 h-4" />
          </button>
        )}

        {/* Collapse handle — rides the seam between sidebar and content */}
        <button
          onClick={onToggleCollapse}
          className="absolute -right-2.5 top-1/2 z-sticky hidden h-5 w-5 -translate-y-1/2 items-center justify-center rounded-sm border border-[var(--border)] bg-[var(--card)] text-[var(--muted-foreground)] interactive hover:border-[var(--primary)]/40 hover:text-[var(--primary-text)] active:scale-[0.97] md:flex"
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!collapsed}
        >
          {collapsed ? <ChevronRight className="w-3 h-3" /> : <ChevronLeft className="w-3 h-3" />}
        </button>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-2 py-3">
        {navSections.map((section) => (
          <div key={section.title} className="mb-4 last:mb-0">
            {!collapsed ? (
              /* Label plus a rule that runs to the edge — the section reads as
                 a labelled band, not a floating caption. */
              <div className="flex items-center gap-2 px-2.5 pb-1.5 pt-1">
                <h2 className="eyebrow shrink-0">{section.title}</h2>
                <span aria-hidden className="h-px min-w-0 flex-1 bg-[var(--sidebar-border)]" />
              </div>
            ) : (
              <div aria-hidden className="mx-2 mb-2 h-px bg-[var(--sidebar-border)]" />
            )}
            <ul>
              {section.items.map((item) => (
                <li key={item.path}>
                    <NavLink
                    to={item.path}
                    end={item.path === "/"}
                    className={({ isActive }) =>
                      cn(
                        "relative flex items-center gap-2.5 rounded-sm font-mono text-body tracking-[0.02em] transition-[color,background-color] duration-150 [transition-timing-function:var(--ease-out-expo)]",
                        collapsed ? "h-9 justify-center px-0" : "h-9 px-2.5 md:h-8",
                        isActive
                          ? // Active is stated three ways at once — full-height
                            // brand marker on the rail, tinted bed, brighter
                            // weight — so it survives a fast scan of 14 items.
                            "bg-[var(--primary)]/[0.09] font-medium text-[var(--primary-text)] before:absolute before:inset-y-0 before:left-0 before:w-[2px] before:bg-[var(--primary)]"
                          : "text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
                      )
                    }
                    title={collapsed ? item.label : undefined}
                  >
                    <item.icon className="w-4 h-4 flex-shrink-0" />
                    {!collapsed && <span className="truncate">{item.label}</span>}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      {/* Theme & session */}
      <div className={cn("shrink-0 border-t border-[var(--sidebar-border)] p-2", collapsed && "px-2")}>
        <button
          onClick={toggleTheme}
          className={cn(
            "flex w-full items-center gap-2.5 rounded-sm font-mono text-body text-[var(--muted-foreground)] transition-colors duration-150 ease-out hover:bg-[var(--secondary)] hover:text-[var(--foreground)]",
            collapsed ? "h-9 justify-center px-0" : "h-9 px-2.5 md:h-8"
          )}
          aria-label="Toggle theme"
          title={collapsed ? (theme === "dark" ? "Light" : "Dark") : undefined}
        >
          {theme === "dark" ? <Sun className="w-4 h-4 flex-shrink-0" /> : <Moon className="w-4 h-4 flex-shrink-0" />}
          {!collapsed && (theme === "dark" ? "Light" : "Dark")}
        </button>
        {onLogout && (
          <button
            onClick={onLogout}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-sm font-mono text-body text-[var(--muted-foreground)] transition-colors duration-150 ease-out hover:bg-[var(--destructive)]/10 hover:text-[var(--destructive-text)]",
              collapsed ? "h-9 justify-center px-0" : "h-9 px-2.5 md:h-8"
            )}
            title={collapsed ? "Sign out" : undefined}
          >
            <LogOut className="w-4 h-4 flex-shrink-0" />
            {!collapsed && "Sign out"}
          </button>
        )}
      </div>
    </aside>
  );
}
