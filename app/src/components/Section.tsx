import type { ReactNode } from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from './Text';

/** Titled block with a hairline rule above it (Debug screen). */
export function Section({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <View style={styles.header}>
        <Text variant="heading">{title}</Text>
        {right}
      </View>
      {children}
    </View>
  );
}

/** "label ........ value" row. */
export function KeyValue({ label, value }: { label: string; value: ReactNode }) {
  return (
    <View style={styles.kv}>
      <Text tone="muted">{label}</Text>
      {typeof value === 'string' || typeof value === 'number' ? (
        <Text variant="bodyStrong" style={styles.kvValue}>
          {value}
        </Text>
      ) : (
        value
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  section: {
    gap: theme.space.sm,
    paddingHorizontal: theme.space.gutter,
    paddingVertical: theme.space.md,
    borderTopWidth: theme.stroke.rule,
    borderTopColor: theme.colors.rule,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  kv: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: theme.space.md,
  },
  kvValue: {
    flexShrink: 1,
    textAlign: 'right',
  },
}));
