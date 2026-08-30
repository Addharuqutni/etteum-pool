import { useEffect, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import Sidebar from "./Sidebar";
import { Menu } from "lucide-react";

interface LayoutProps {
  onLogout?: () => void;
}

export default function Layout({ onLogout }: LayoutProps) {
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem("sidebar-collapsed") === "true";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem("sidebar-collapsed", collapsed ? "true" : "false");
    } catch {}
  }, [collapsed]);

  return (
    <div className="min-h-screen">
      {/* Mobile scrim. Flat ink, no blur — this is a terminal tool, and a
          frosted pane over a data table just makes the data unreadable. */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-[var(--scrim)] md:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden
        />
      )}

      <Sidebar
        onLogout={onLogout}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        collapsed={collapsed}
        onToggleCollapse={() => setCollapsed((v) => !v)}
      />

      {/* Top padding only clears the fixed mobile menu button; on desktop that
          button is gone, so the content starts near the top instead of under
          4rem of dead space. */}
      <main
        className={
          "h-screen overflow-y-auto px-4 pb-8 pt-16 transition-[margin] duration-200 [transition-timing-function:var(--ease-out-expo)] md:px-5 md:pt-5 " +
          (collapsed ? "md:ml-14" : "md:ml-[228px]")
        }
      >
        {/* Mobile menu button — 40px tap target, sits on the page rail */}
        <button
          onClick={() => setSidebarOpen(true)}
          className="fixed top-3 left-3 z-30 md:hidden flex h-10 w-10 items-center justify-center rounded-md border border-[var(--border)] bg-[var(--card)] text-[var(--foreground)] transition-colors duration-150 ease-out hover:border-[var(--primary)]/40 hover:text-[var(--primary)]"
          aria-label="Open menu"
        >
          <Menu className="w-5 h-5" />
        </button>

        {/* key on pathname replays the one entry animation per navigation */}
        <div key={location.pathname} className="rise">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
