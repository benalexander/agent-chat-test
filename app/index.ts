/**
 * App entry point (package.json "main").
 * Order matters:
 *  1. Unistyles must be configured before any StyleSheet.create() runs.
 *  2. Polyfills before anything touches the AI SDK.
 *  3. The background task must be defined before expo-router so a headless
 *     background launch can reach it without mounting React.
 */
import './src/theme/unistyles';
import './src/lib/polyfills';
import './src/sync/background';
import 'expo-router/entry';
