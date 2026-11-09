import { StyleSheet } from 'react-native-unistyles';

import { ridgeway } from './theme';

const themes = { ridgeway };

type AppThemes = typeof themes;

declare module 'react-native-unistyles' {
  // Standard Unistyles pattern: augment its theme registry with our theme.
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  export interface UnistylesThemes extends AppThemes {}
}

/**
 * Must run before any StyleSheet.create() is evaluated, which is why it's
 * imported first in /index.ts, ahead of expo-router.
 */
StyleSheet.configure({
  themes,
  settings: {
    initialTheme: 'ridgeway',
  },
});
