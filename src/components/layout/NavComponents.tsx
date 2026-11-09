import React, { useEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ChevronRightIcon, ChevronDownIcon } from '../icons';
import { NavigationBadge } from '../ActivityBadge';
import { isDemoModeRuntimeAllowed } from '../../utils/runtimeMode';

// --- Sidebar Link (used in mobile menu) ---

interface SidebarLinkProps {
  to: string;
  icon: React.ElementType;
  label: string;
  isCollapsed: boolean;
  hasSubItems?: boolean;
  isSubItem?: boolean;
  onNavigate?: () => void;
}

export function SidebarLink({ to, icon: Icon, label, isCollapsed, hasSubItems, isSubItem, onNavigate }: SidebarLinkProps): React.JSX.Element {
  const location = useLocation();
  const isActive = location.pathname === to ||
    (hasSubItems && location.pathname.startsWith(to));

  const searchParams = new URLSearchParams(location.search);
  const isDemoMode = isDemoModeRuntimeAllowed(import.meta.env) && searchParams.get('demo') === 'true';
  const linkTo = isDemoMode ? `${to}?demo=true` : to;

  const handleLinkClick = () => {
    if (onNavigate) onNavigate();
  };

  const className = `flex items-center gap-2 px-3 py-2.5 md:py-2 rounded-lg transition-colors min-h-[40px] md:min-h-[auto] ${
    isSubItem ? 'ml-5 text-xs' : ''
  } ${
    isCollapsed ? 'sidebar-link-collapsed' : ''
  } ${
    isActive
      ? isCollapsed
        ? 'text-white font-medium'
        : 'bg-white/20 text-white font-medium'
      : 'text-white/70 hover:text-white hover:bg-white/10'
  }`;

  return (
    <Link
      to={linkTo}
      className={className}
      title={isCollapsed ? label : undefined}
      onClick={handleLinkClick}
      aria-label={label}
      aria-current={isActive ? 'page' : undefined}
    >
      <Icon size={isCollapsed ? 24 : 18} />
      {!isCollapsed && (
        <>
          <span className="flex-1 text-sm">{label}</span>
          {hasSubItems && <ChevronRightIcon size={14} className="text-gray-400" />}
        </>
      )}
      {!isCollapsed && hasSubItems && <NavigationBadge type={label === 'Accounts' ? 'account' : label === 'Budget' ? 'budget' : undefined} />}
    </Link>
  );
}

// --- Top Navigation Item ---

export function TopNavItem({ to, icon: Icon, label }: { to: string; icon: React.ElementType; label: string }): React.JSX.Element {
  const location = useLocation();
  const isActive = location.pathname === to;
  const searchParams = new URLSearchParams(location.search);
  const isDemoMode = isDemoModeRuntimeAllowed(import.meta.env) && searchParams.get('demo') === 'true';
  const linkTo = isDemoMode ? `${to}?demo=true` : to;

  return (
    <Link
      to={linkTo}
      className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg transition-colors ${
        isActive
          ? 'bg-white/20 text-white font-medium'
          : 'text-white/70 hover:text-white hover:bg-white/10'
      }`}
      aria-current={isActive ? 'page' : undefined}
    >
      <Icon size={16} />
      <span>{label}</span>
    </Link>
  );
}

// --- Top Navigation Dropdown ---

export interface DropdownItem {
  to: string;
  icon: React.ElementType;
  label: string;
}

export function TopNavDropdown({
  label,
  icon: Icon,
  homeTo,
  items,
  activePaths,
  inactivePaths,
  openDropdown,
  setOpenDropdown
}: {
  label: string;
  icon: React.ElementType;
  // Where the label itself navigates. A top-level item that only toggled a menu
  // taught users that clicking navigation does nothing; the label is now a real
  // link to the menu's home page, and only the chevron toggles the dropdown.
  homeTo: string;
  items: DropdownItem[];
  activePaths?: string[];
  /** Routes inside a claimed prefix that ANOTHER menu owns — see isActive. */
  inactivePaths?: string[];
  openDropdown: string | null;
  setOpenDropdown: (name: string | null) => void;
}): React.JSX.Element {
  const location = useLocation();
  const ref = useRef<HTMLDivElement>(null);
  const searchParams = new URLSearchParams(location.search);
  const isDemoMode = isDemoModeRuntimeAllowed(import.meta.env) && searchParams.get('demo') === 'true';
  const isOpen = openDropdown === label;
  const homeLinkTo = isDemoMode ? `${homeTo}?demo=true` : homeTo;

  const claimed = activePaths
    ? activePaths.some(p => location.pathname === p || location.pathname.startsWith(p))
    : false;
  // A prefix claim can cover pages another menu owns outright — Categories
  // lives under /settings but belongs to Manage, and both bars lit up over
  // it (owner, 30 Aug). The disclaimer names what the prefix gives away, so
  // ownership stays written where the claims are instead of being implied by
  // whichever menu happens to list a page first.
  const disclaimed = inactivePaths
    ? inactivePaths.some(p => location.pathname === p || location.pathname.startsWith(p))
    : false;
  const isActive = claimed && !disclaimed;

  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpenDropdown(null);
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenDropdown(null);
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isOpen, setOpenDropdown]);

  return (
    <div className="relative" ref={ref}>
      {/* Split trigger: the label is a link (Enter follows it), the chevron is a
          separate button that opens the menu (ArrowDown on the label does too).
          The row carries the highlight so label + chevron read as one control. */}
      <div
        className={`flex items-center rounded-lg transition-colors ${
          isActive || isOpen ? 'bg-white/20' : 'hover:bg-white/10'
        }`}
      >
        <Link
          to={homeLinkTo}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setOpenDropdown(label);
            }
          }}
          className={`flex items-center gap-1.5 pl-3 pr-1 py-1.5 text-sm rounded-l-lg transition-colors ${
            isActive || isOpen ? 'text-white font-medium' : 'text-white/70 hover:text-white'
          }`}
          aria-current={isActive ? 'page' : undefined}
        >
          <Icon size={16} />
          <span>{label}</span>
        </Link>
        <button
          type="button"
          onClick={() => setOpenDropdown(isOpen ? null : label)}
          className={`flex items-center pl-0.5 pr-2 py-1.5 rounded-r-lg transition-colors ${
            isActive || isOpen ? 'text-white' : 'text-white/70 hover:text-white'
          }`}
          aria-expanded={isOpen ? 'true' : 'false'}
          aria-haspopup="true"
          aria-label={`${label} menu`}
        >
          <ChevronDownIcon size={14} className={`transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
        </button>
      </div>
      {isOpen && (
        <div className="absolute top-full left-0 mt-1 bg-white dark:bg-gray-800 rounded-lg shadow-xl border border-gray-200 dark:border-gray-700 py-1 min-w-[200px] z-50">
          {items.map(item => {
            const itemTo = isDemoMode ? `${item.to}?demo=true` : item.to;
            const itemActive = location.pathname === item.to;
            return (
              <Link
                key={item.to}
                to={itemTo}
                className={`flex items-center gap-2.5 px-4 py-2 text-sm transition-colors ${
                  itemActive
                    ? 'bg-gray-100 dark:bg-gray-700 text-[#1a2332] dark:text-white font-medium'
                    : 'text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'
                }`}
                onClick={() => setOpenDropdown(null)}
                aria-current={itemActive ? 'page' : undefined}
              >
                <item.icon size={16} className="shrink-0" />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
