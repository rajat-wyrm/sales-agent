import { NavLink, useNavigate } from "react-router-dom";
import { useAuthStore } from "@/stores/auth";
import {
  BarChart2,
  Users,
  Building2,
  Contact,
  GitMerge,
  TrendingUp,
  Settings as SettingsIcon,
  LogOut,
  X,
  ShieldCheck,
  Radar,
} from "lucide-react";
import { Logo } from "@/components/Logo";
import { cn } from "@/components/ui/cn";
import { Avatar } from "@/components/ui/avatar";

const NAV_ITEMS = [
  { to: "/dashboard", label: "Dashboard", icon: BarChart2 },
  { to: "/leads", label: "Leads", icon: Users },
  { to: "/companies", label: "Companies", icon: Building2 },
  { to: "/contacts", label: "Contacts", icon: Contact },
  { to: "/duplicates", label: "Duplicates", icon: GitMerge },
  { to: "/analytics", label: "Analytics", icon: TrendingUp },
];

interface SidebarProps {
  drawerOpen?: boolean;
  onDrawerClose?: () => void;
}

export function SidebarNavItems({
  onNavigate,
  compact,
}: {
  onNavigate?: () => void;
  compact?: boolean;
}) {
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();
  const isAdmin = user?.role === "admin";

  const handleLogout = async () => {
    await logout();
    navigate("/login");
  };

  const items = [...NAV_ITEMS];
  if (isAdmin) {
    items.push({ to: "/settings", label: "Settings", icon: SettingsIcon });
  }

  return (
    <nav className="flex flex-1 flex-col gap-1 px-3 py-4">
      {items.map(({ to, label, icon: Icon }) => (
        <NavLink
          key={to}
          to={to}
          onClick={onNavigate}
          title={compact ? label : undefined}
          className={({ isActive }) =>
            cn(
              "group flex items-center gap-3 rounded-lg px-3 py-2 text-[13.5px] font-medium transition-colors duration-150",
              compact && "justify-center px-0",
              isActive
                ? "bg-sidebar-active text-sidebar-active-foreground"
                : "text-sidebar-foreground hover:bg-sidebar-muted hover:text-foreground"
            )
          }
        >
          {({ isActive }) => (
            <>
              <Icon className={cn("h-[18px] w-[18px] shrink-0", compact && "h-5 w-5")} strokeWidth={isActive ? 2.2 : 1.8} />
              {!compact && <span className="truncate">{label}</span>}
              {isActive && !compact && (
                <span className="ml-auto h-1.5 w-1.5 rounded-full bg-sidebar-active-foreground" />
              )}
            </>
          )}
        </NavLink>
      ))}

      <div className="mt-auto flex flex-col gap-1 border-t border-sidebar-border pt-3">
        <div className={cn("flex items-center gap-3 px-3 py-2", compact && "justify-center px-0")}>
          <Avatar name={user?.email} size="sm" />
          {!compact && (
            <div className="min-w-0 leading-tight">
              <p className="truncate text-[13px] font-medium text-foreground">
                {user?.email || "User"}
              </p>
              <p className="flex items-center gap-1 text-[11.5px] capitalize text-muted-foreground">
                <ShieldCheck className="h-3 w-3" />
                {user?.role || "user"}
              </p>
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={handleLogout}
          title="Sign out"
          className={cn(
            "flex items-center gap-3 rounded-lg px-3 py-2 text-[13.5px] font-medium text-muted-foreground transition-colors duration-150 hover:bg-destructive-soft hover:text-destructive",
            compact && "justify-center px-0"
          )}
        >
          <LogOut className="h-[18px] w-[18px]" />
          {!compact && "Sign out"}
        </button>
      </div>
    </nav>
  );
}

const Sidebar = ({ drawerOpen = false, onDrawerClose }: SidebarProps) => {
  return (
    <>
      {/* Desktop sidebar: full at xl, icon-only between md and xl, hidden below md */}
      <aside className="hidden h-full w-16 flex-col border-r border-sidebar-border bg-sidebar md:flex xl:w-64">
        <div className="flex h-16 items-center border-b border-sidebar-border px-4">
          <div className="hidden xl:block">
            <Logo />
          </div>
          <Logo showText={false} className="mx-auto xl:hidden" />
        </div>
        <SidebarNavItems compact />
      </aside>

      {/* Mobile drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-overlay md:hidden">
          <div
            className="absolute inset-0 bg-zinc-950/40 backdrop-blur-sm animate-overlay-in"
            onClick={onDrawerClose}
            aria-hidden
          />
          <aside className="absolute inset-y-0 left-0 flex w-72 flex-col border-r border-sidebar-border bg-sidebar shadow-float animate-drawer-in">
            <div className="flex h-16 items-center justify-between border-b border-sidebar-border px-4">
              <Logo />
              <button
                type="button"
                onClick={onDrawerClose}
                className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                aria-label="Close menu"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <SidebarNavItems onNavigate={onDrawerClose} />
          </aside>
        </div>
      )}

      {/* Mobile brand hint */}
      <div className="flex h-14 items-center justify-center border-b border-sidebar-border bg-sidebar md:hidden">
        <span className="flex items-center gap-2 text-sm font-bold text-foreground">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600">
            <Radar className="h-4 w-4 text-white" />
          </span>
          HireGen
        </span>
      </div>
    </>
  );
};

export default Sidebar;