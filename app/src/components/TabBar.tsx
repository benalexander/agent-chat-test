import Ionicons from '@expo/vector-icons/Ionicons';
import type { ComponentProps, ComponentRef, Ref } from 'react';
import { Pressable, View, type ViewProps } from 'react-native';
import type { TabTriggerSlotProps } from 'expo-router/ui';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from './Text';

type IconName = ComponentProps<typeof Ionicons>['name'];

// TabTriggerSlotProps' `ref` is typed against View; we render a Pressable, so retype it.
type TabButtonProps = Omit<TabTriggerSlotProps, 'ref'> & {
  ref?: Ref<ComponentRef<typeof Pressable>>;
  icon: IconName;
  label: string;
  badgeCount?: number;
};

/**
 * The bar itself. Rendered via <TabList asChild>.
 *
 * Note the prop order in both components: incoming props first, our styles
 * last. The expo-router slots pass their own `style`, which would otherwise
 * replace ours.
 */
export function TabBarContainer({ style: _slotStyle, children, ...rest }: ViewProps) {
  return (
    <View {...rest} role="tablist" style={styles.bar}>
      {children}
    </View>
  );
}

/**
 * One tab. Rendered via <TabTrigger asChild>, which injects `isFocused`,
 * `onPress` and the ref. Layout of the bar itself lives in app/_layout.tsx.
 */
export function TabButton({
  icon,
  label,
  badgeCount,
  isFocused = false,
  ref,
  style: _slotStyle,
  ...rest
}: TabButtonProps) {
  const { theme } = useUnistyles();
  styles.useVariants({ focused: isFocused });

  const a11yLabel = badgeCount ? `${label}, ${badgeCount} unread` : label;

  return (
    <Pressable
      {...rest}
      ref={ref}
      role="tab"
      aria-selected={isFocused}
      aria-label={a11yLabel}
      style={styles.tab}
    >
      <View>
        <Ionicons name={icon} size={22} color={isFocused ? theme.colors.text : theme.colors.onTabBar} />
        {badgeCount ? (
          <View style={styles.badge}>
            <Text variant="caption" style={styles.badgeText}>
              {badgeCount > 9 ? '9+' : badgeCount}
            </Text>
          </View>
        ) : null}
      </View>
      <Text variant="caption" style={styles.label}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme, rt) => ({
  bar: {
    flexDirection: 'row',
    backgroundColor: theme.colors.tabBar,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.space.xs,
    paddingTop: theme.space.md,
    // Inset goes on each tab (not the bar) so the active tab's fill reaches the screen edge.
    // `rt` is the Unistyles runtime: safe-area insets without a provider or hook.
    paddingBottom: theme.space.md + rt.insets.bottom,
    variants: {
      focused: {
        true: { backgroundColor: theme.colors.tabBarActive },
        false: { backgroundColor: theme.colors.tabBar },
      },
    },
  },
  label: {
    variants: {
      focused: {
        true: { color: theme.colors.text },
        false: { color: theme.colors.onTabBar },
      },
    },
  },
  badge: {
    position: 'absolute',
    top: -10,
    right: -12,
    minWidth: 20,
    height: 20,
    paddingHorizontal: 5,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.badge,
  },
  badgeText: {
    color: theme.colors.onBadge,
    fontFamily: theme.fonts.bodyStrong,
  },
}));
