// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

/**
 * Lucide icon paths (24×24 stroke) rendered through one <Icon>. The path data
 * is the system's icon library, inlined so the bundle pulls no icon dependency.
 */
import type { CSSProperties } from "react";

const PAY_ICONS = {
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
  list: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
  receipt: '<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 17.5v-11"/>',
  report: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  chevronLeft: '<path d="m15 18-6-6 6-6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.9 4.9 1.4 1.4"/><path d="m17.7 17.7 1.4 1.4"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.3 17.7-1.4 1.4"/><path d="m19.1 4.9-1.4 1.4"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  store: '<path d="M3 9h18l-1.6-5.2a1 1 0 0 0-.95-.8H5.55a1 1 0 0 0-.95.8L3 9Z"/><path d="M4.5 9v10a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1V9"/><path d="M9.5 20v-5.5h5V20"/>',
  filter: '<path d="M3 5h18"/><path d="M6 12h12"/><path d="M10 19h4"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>',
  arrowUpRight: '<path d="M7 17 17 7"/><path d="M7 7h10v10"/>',
  banknote: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2"/><path d="M6 12h.01"/><path d="M18 12h.01"/>',
  wallet: '<path d="M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/><path d="M21 12v-2a1 1 0 0 0-1-1h-4a2 2 0 0 0 0 4h4a1 1 0 0 0 1-1Z"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M8 2v4"/><path d="M16 2v4"/><path d="M3 10h18"/>',
  lifebuoy: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/><path d="m4.9 4.9 4.2 4.2"/><path d="m14.9 14.9 4.2 4.2"/><path d="m14.9 9.1 4.2-4.2"/><path d="m4.9 19.1 4.2-4.2"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  settings: '<path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"/><path d="M19.4 15a1.8 1.8 0 0 0 .36 1.98l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.8 1.8 0 0 0-1.98-.36 1.8 1.8 0 0 0-1.1 1.65V21a2 2 0 1 1-4 0v-.09A1.8 1.8 0 0 0 8.75 19.3a1.8 1.8 0 0 0-1.98.36l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.8 1.8 0 0 0 4.3 15a1.8 1.8 0 0 0-1.65-1.1H2.5a2 2 0 1 1 0-4h.09A1.8 1.8 0 0 0 4.3 8.75a1.8 1.8 0 0 0-.36-1.98l-.06-.06A2 2 0 1 1 6.7 3.88l.06.06a1.8 1.8 0 0 0 1.98.36 1.8 1.8 0 0 0 1.1-1.65V2.5a2 2 0 1 1 4 0v.09A1.8 1.8 0 0 0 15 4.3a1.8 1.8 0 0 0 1.98-.36l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.8 1.8 0 0 0-.36 1.98 1.8 1.8 0 0 0 1.65 1.1h.09a2 2 0 1 1 0 4h-.09A1.8 1.8 0 0 0 19.4 15Z"/>',
} as const;

export type IconName = keyof typeof PAY_ICONS;

export function Icon({
  name,
  size = 18,
  stroke = 1.75,
  fill = "none",
  color,
  style,
  className,
}: {
  name: IconName;
  size?: number;
  stroke?: number;
  fill?: "none" | "current";
  color?: string;
  style?: CSSProperties;
  className?: string;
}) {
  const filled = fill === "current";
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ color, display: "block", flex: "0 0 auto", ...style }}
      dangerouslySetInnerHTML={{ __html: PAY_ICONS[name] }}
    />
  );
}
