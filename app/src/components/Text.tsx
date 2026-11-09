import { Text as RNText, type TextProps as RNTextProps } from 'react-native';
import { StyleSheet, type UnistylesVariants } from 'react-native-unistyles';

type TextProps = RNTextProps & UnistylesVariants<typeof styles>;

/**
 * The only place font family, size and line height are set.
 * Screens choose a role (`variant`) and the theme decides how it looks.
 * (Adapted from ../../companion-app/src/components/Text.tsx.)
 */
export function Text({ variant, tone, style, ...rest }: TextProps) {
  styles.useVariants({ variant, tone });
  return <RNText style={[styles.text, style]} {...rest} />;
}

const styles = StyleSheet.create((theme) => ({
  text: {
    fontFamily: theme.fonts.body,
    ...theme.type.body,
    variants: {
      variant: {
        title: { fontFamily: theme.fonts.heading, ...theme.type.title },
        heading: { fontFamily: theme.fonts.heading, ...theme.type.heading },
        chat: { ...theme.type.chat },
        body: {},
        bodyStrong: { fontFamily: theme.fonts.bodyStrong },
        caption: { ...theme.type.caption },
        mono: { fontFamily: 'Menlo', ...theme.type.mono },
        default: {},
      },
      tone: {
        default: { color: theme.colors.text },
        muted: { color: theme.colors.textMuted },
        inverse: { color: theme.colors.onSurfaceInverse },
        onAction: { color: theme.colors.onAction },
        danger: { color: theme.colors.danger },
      },
    },
  },
}));
