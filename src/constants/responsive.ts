/**
 * Central responsive design tokens for EstateFlow.
 *
 * Breakpoints follow common device widths:
 * - phone:   < 600px  (all phones, portrait + landscape)
 * - tablet:  600–1023px (large phones landscape, small tablets, foldables)
 * - desktop: >= 1024px (tablets landscape, laptops, web browsers)
 *
 * Small phones (< 380px) get tighter spacing / stacked rows.
 *
 * Usage (static styles — safe in StyleSheet.create, no re-render needed):
 *   import { ContentMaxWidth, centerContent } from '@/constants/responsive';
 *   scrollContent: { padding: 16, ...centerContent(ContentMaxWidth.Default) }
 *
 * Usage (dynamic — responds to rotation / web resize):
 *   import { useResponsive } from '@/hooks/use-responsive';
 *   const { isSmallPhone, isTabletOrUp, columnsFor, gutter } = useResponsive();
 */

export const Breakpoints = {
  /** Below this width: compact phone layout (stack rows, shrink type). */
  smallPhone: 380,
  /** Below this width: phone layout. At/above: tablet layout. */
  tablet: 600,
  /** At/above this width: desktop/web layout (grids, capped columns). */
  desktop: 1024,
} as const;

/** Max content widths — caps how wide screens stretch on tablet/desktop. */
export const ContentMaxWidth = {
  /** Forms, wizards, auth flows. */
  narrow: 640,
  /** Default app screens (lists, dashboards, details). */
  Default: 1024,
  /** Wide data screens (insights charts, tables). */
  wide: 1200,
} as const;

/** Horizontal padding for a given window width. */
export function gutterFor(width: number): number {
  if (width < Breakpoints.smallPhone) return 12;
  if (width < Breakpoints.tablet) return 16;
  return 24;
}

/** Number of grid columns for card layouts at a given window width. */
export function columnsFor(width: number, options?: { phone?: number; tablet?: number; desktop?: number }): number {
  const { phone = 1, tablet = 2, desktop = 3 } = options ?? {};
  if (width >= Breakpoints.desktop) return desktop;
  if (width >= Breakpoints.tablet) return tablet;
  return phone;
}

/**
 * Static style fragment that centers scroll content and caps its width on
 * tablet/desktop while staying full-width on phones.
 * Spread into any `contentContainerStyle`.
 */
export function centerContent(maxWidth: number = ContentMaxWidth.Default) {
  return {
    width: '100%' as const,
    maxWidth,
    alignSelf: 'center' as const,
  };
}
