import { ActivityIndicator, Pressable, type PressableProps } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from './Text';

type PillButtonProps = Omit<PressableProps, 'children' | 'style'> & {
  label: string;
  /** `outline` for secondary actions, `danger` for destructive ones. */
  kind?: 'primary' | 'outline' | 'danger';
  busy?: boolean;
};

/** Call to action. Shape comes from `theme.radius.control`. (From ../../companion-app.) */
export function PillButton({ label, kind = 'primary', busy = false, disabled, ...rest }: PillButtonProps) {
  const { theme } = useUnistyles();
  styles.useVariants({ kind });
  const isDisabled = disabled || busy;
  return (
    <Pressable
      {...rest}
      disabled={isDisabled}
      role="button"
      hitSlop={6}
      style={({ pressed }) => styles.button(kind, pressed, !!isDisabled)}
    >
      {busy ? (
        <ActivityIndicator size="small" color={kind === 'outline' ? theme.colors.text : theme.colors.onAction} />
      ) : (
        <Text variant="bodyStrong" style={styles.label}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  button: (kind: 'primary' | 'outline' | 'danger', pressed: boolean, disabled: boolean) => ({
    minHeight: 36,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.space.md,
    paddingVertical: theme.space.sm,
    borderRadius: theme.radius.control,
    borderWidth: 1.5,
    opacity: disabled ? 0.45 : pressed ? 0.8 : 1,
    transform: [{ scale: pressed ? 0.97 : 1 }],
    backgroundColor:
      kind === 'primary' ? theme.colors.action : kind === 'danger' ? theme.colors.danger : theme.colors.background,
    borderColor: kind === 'primary' ? theme.colors.action : kind === 'danger' ? theme.colors.danger : theme.colors.text,
  }),
  label: {
    variants: {
      kind: {
        primary: { color: theme.colors.onAction },
        outline: { color: theme.colors.text },
        danger: { color: theme.colors.onAction },
      },
    },
  },
}));
