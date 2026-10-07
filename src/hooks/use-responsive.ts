import { useWindowDimensions } from 'react-native';
import { Breakpoints, ContentMaxWidth, columnsFor, gutterFor } from '@/constants/responsive';

/**
 * Reactive responsive hook — re-renders on rotation / window resize
 * (unlike `Dimensions.get('window')` read once at module load).
 *
 * Returns breakpoint flags plus ready-to-use layout values.
 */
export function useResponsive() {
  const { width, height } = useWindowDimensions();

  const isSmallPhone = width < Breakpoints.smallPhone;
  const isPhone = width < Breakpoints.tablet;
  const isTablet = width >= Breakpoints.tablet && width < Breakpoints.desktop;
  const isDesktop = width >= Breakpoints.desktop;
  const isTabletOrUp = width >= Breakpoints.tablet;
  const isLandscape = width > height;
  /** Short screens (landscape phones, small windows) — reduce hero heights. */
  const isShortScreen = height < 650;

  return {
    width,
    height,
    isSmallPhone,
    isPhone,
    isTablet,
    isDesktop,
    isTabletOrUp,
    isLandscape,
    isShortScreen,
    /** Horizontal screen padding appropriate for this width. */
    gutter: gutterFor(width),
    /** Grid column count for card layouts. */
    columns: (options?: { phone?: number; tablet?: number; desktop?: number }) =>
      columnsFor(width, options),
    /** Content width capped for readability (e.g. chat bubbles, modals). */
    capped: (maxWidth: number = ContentMaxWidth.Default) => Math.min(width - 32, maxWidth),
  };
}
