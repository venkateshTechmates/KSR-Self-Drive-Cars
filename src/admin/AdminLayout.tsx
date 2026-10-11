// Admin shell: sidebar on wide screens, drawer + top bar on phones (ADM-08). Pages send noindex (ADM-01).
import { useLayoutEffect, useState, type ComponentType } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import {
  BarChart3,
  CalendarDays,
  Car,
  ClipboardList,
  FileStack,
  LayoutDashboard,
  LogOut,
  Menu,
  ScrollText,
  Settings,
  ShieldQuestion,
  UserCog,
  Users,
  Wallet,
  X,
} from 'lucide-react';
import type { AppRole } from '@shared/constants.ts';
import { ROLE_LABELS } from '@shared/constants.ts';
import { KsrLogo } from '@/components/brand/Brand';
import { IconButton } from '@/components/ui/Button';
import { cn } from '@/lib/cn';
import { useAuth } from './auth/AuthProvider';

interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<{ size?: number; 'aria-hidden'?: boolean }>;
  roles: readonly AppRole[];
  end?: boolean;
}

const ALL: readonly AppRole[] = ['owner', 'manager', 'staff'];
const OM: readonly AppRole[] = ['owner', 'manager'];
const O: readonly AppRole[] = ['owner'];

export const NAV: NavItem[] = [
  { to: '/admin', label: 'Dashboard', icon: LayoutDashboard, roles: ALL, end: true },
  { to: '/admin/bookings', label: 'Bookings', icon: ClipboardList, roles: ALL },
  { to: '/admin/calendar', label: 'Calendar', icon: CalendarDays, roles: OM },
  { to: '/admin/fleet', label: 'Fleet', icon: Car, roles: OM },
  { to: '/admin/customers', label: 'Customers', icon: Users, roles: OM },
  { to: '/admin/documents', label: 'Documents', icon: FileStack, roles: OM },
  { to: '/admin/payments', label: 'Payments', icon: Wallet, roles: OM },
  { to: '/admin/reports', label: 'Reports', icon: BarChart3, roles: OM },
  { to: '/admin/requests', label: 'Privacy requests', icon: ShieldQuestion, roles: OM },
  { to: '/admin/settings', label: 'Settings', icon: Settings, roles: O },
  { to: '/admin/staff', label: 'Staff', icon: UserCog, roles: O },
  { to: '/admin/audit', label: 'Audit log', icon: ScrollText, roles: O },
];

function NavList({ role, onNavigate }: { role: AppRole; onNavigate?: () => void }) {
  return (
    <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
      {NAV.filter((n) => n.roles.includes(role)).map((n) => (
        <li key={n.to}>
          <NavLink
            to={n.to}
            end={n.end}
            onClick={onNavigate}
            className={({ isActive }) =>
              cn(
                'flex min-h-11 items-center gap-3 rounded-xl px-3 font-semibold no-underline',
                isActive ? 'bg-ink text-white hover:text-white' : 'text-ink hover:bg-ink/5 hover:text-ink',
              )
            }
          >
            <n.icon size={19} aria-hidden={true} />
            {n.label}
          </NavLink>
        </li>
      ))}
    </ul>
  );
}

export function AdminLayout() {
  // Default title + noindex (ADM-01). A layout effect runs before the pages' own effects,
  // so a page's useDocumentMeta title wins.
  useLayoutEffect(() => {
    document.title = 'KSR admin';
    let robots = document.head.querySelector<HTMLMetaElement>('meta[name="robots"]');
    if (!robots) {
      robots = document.createElement('meta');
      robots.name = 'robots';
      document.head.appendChild(robots);
    }
    robots.content = 'noindex, nofollow';
  }, []);
  const { role, access, signOut } = useAuth();
  const location = useLocation();
  // The drawer closes itself on navigation: it is open only for the path it was opened on.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === location.pathname;
  const setOpen = (v: boolean) => setOpenOn(v ? location.pathname : null);
  if (!role) return null;

  const who = (
    <div className="flex items-center justify-between gap-2 border-t border-line px-3 pt-3">
      <div className="min-w-0">
        <p className="m-0 truncate font-semibold">{access?.full_name ?? 'Signed in'}</p>
        <p className="m-0 text-sm text-muted">{ROLE_LABELS[role]}</p>
      </div>
      <IconButton label="Sign out" onClick={() => void signOut()}>
        <LogOut size={19} aria-hidden="true" />
      </IconButton>
    </div>
  );

  return (
    <div className="min-h-dvh bg-page">
      <a href="#admin-main" className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-lg focus:bg-white focus:px-3 focus:py-2">
        Skip to content
      </a>
      {/* Phone top bar */}
      <header className="no-print sticky top-0 z-30 flex h-16 items-center justify-between border-b border-line bg-page px-3 lg:hidden">
        <IconButton label="Open menu" onClick={() => setOpen(true)} aria-expanded={open} aria-controls="admin-drawer">
          <Menu size={22} aria-hidden="true" />
        </IconButton>
        <KsrLogo size="sm" withName={false} />
        <span className="w-11" aria-hidden="true" />
      </header>

      {/* Drawer */}
      {open && (
        <div className="no-print fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu" id="admin-drawer">
          <button type="button" aria-label="Close menu" className="absolute inset-0 bg-ink/50" onClick={() => setOpen(false)} />
          <nav aria-label="Admin" className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col gap-4 overflow-y-auto bg-surface p-3 pb-6">
            <div className="flex items-center justify-between">
              <KsrLogo size="sm" />
              <IconButton label="Close menu" onClick={() => setOpen(false)}>
                <X size={22} aria-hidden="true" />
              </IconButton>
            </div>
            <NavList role={role} onNavigate={() => setOpen(false)} />
            <div className="mt-auto">{who}</div>
          </nav>
        </div>
      )}

      <div className="mx-auto flex max-w-[1500px]">
        <nav aria-label="Admin" className="no-print sticky top-0 hidden h-dvh w-64 shrink-0 flex-col gap-5 overflow-y-auto border-r border-line bg-surface p-3 lg:flex">
          <div className="px-2 pt-2">
            <KsrLogo size="sm" />
          </div>
          <NavList role={role} />
          <div className="mt-auto">{who}</div>
        </nav>
        <main id="admin-main" className="min-w-0 flex-1 px-4 py-5 sm:px-6 lg:px-8 lg:py-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
