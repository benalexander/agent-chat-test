/**
 * Expo app config. Native folders are generated from this by prebuild, so
 * change native settings here rather than in ios/.
 */
import type { ConfigContext, ExpoConfig } from 'expo/config';

/** iOS bundle identifier (same prefix as ../../health-store-test). */
const BUNDLE_ID = 'com.homemadedigital.agentchattest';

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'Agent Chat Test',
  slug: 'agent-chat-test',
  scheme: 'agentchattest',
  version: '1.0.0',
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'light',
  ios: {
    bundleIdentifier: BUNDLE_ID,
    supportsTablet: false,
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
      // Plain http to `wrangler dev` on localhost from the simulator.
      NSAppTransportSecurity: { NSAllowsLocalNetworking: true },
    },
  },
  plugins: [
    'expo-router',
    'expo-font',
    'expo-sqlite',
    'expo-secure-store',
    // Adds UIBackgroundModes `processing` + BGTaskSchedulerPermittedIdentifiers.
    'expo-background-task',
    [
      'expo-notifications',
      {
        // Local notifications only: no APNs entitlement needed.
        enableRemoteNotifications: false,
      },
    ],
    [
      'expo-splash-screen',
      {
        image: './assets/splash-icon.png',
        backgroundColor: '#FFFFFF',
        imageWidth: 160,
      },
    ],
  ],
  experiments: {
    typedRoutes: true,
  },
});
