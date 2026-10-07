import { ReactNode } from 'react';
import { ScrollView, ScrollViewProps, StyleProp, StyleSheet, View, ViewStyle } from 'react-native';
import { ContentMaxWidth, centerContent } from '@/constants/responsive';

type Props = ScrollViewProps & {
  children: ReactNode;
  /** Max width the content column may grow to on tablet/desktop. */
  maxWidth?: number;
  /** Extra styles merged after the centering styles. */
  contentStyle?: StyleProp<ViewStyle>;
};

/**
 * Drop-in ScrollView replacement that keeps screens full-width on phones
 * but centers + caps content on tablets and web/desktop.
 *
 *   <ResponsiveScrollView contentStyle={{ padding: 16, gap: 14 }}>
 */
export function ResponsiveScrollView({ children, maxWidth = ContentMaxWidth.Default, contentStyle, ...rest }: Props) {
  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      {...rest}
      contentContainerStyle={[styles.content, centerContent(maxWidth), contentStyle, rest.contentContainerStyle]}
    >
      {children}
    </ScrollView>
  );
}

type WrapperProps = {
  children: ReactNode;
  maxWidth?: number;
  style?: StyleProp<ViewStyle>;
};

/** Non-scrolling centered column with the same max-width behavior. */
export function ResponsiveContent({ children, maxWidth = ContentMaxWidth.Default, style }: WrapperProps) {
  return <View style={[styles.content, centerContent(maxWidth), style]}>{children}</View>;
}

const styles = StyleSheet.create({
  content: {
    flexGrow: 1,
  },
});
