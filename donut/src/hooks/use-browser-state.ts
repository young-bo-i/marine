import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  getBrowserDisplayName,
  getOSDisplayName,
  isCrossOsProfile,
} from "@/lib/browser-utils";
import type { BrowserProfile } from "@/types";

/**
 * Hook for managing browser state
 */
export function useBrowserState(
  profiles: BrowserProfile[],
  runningProfiles: Set<string>,
  _isUpdating: (browser: string) => boolean,
  launchingProfiles: Set<string>,
  stoppingProfiles: Set<string>,
) {
  const { t } = useTranslation();
  const [isClient, setIsClient] = useState(false);

  useEffect(() => {
    setIsClient(true);
  }, []);

  /**
   * Check if a browser type allows only one instance to run at a time
   */
  const isSingleInstanceBrowser = useCallback(
    (_browserType: string): boolean => {
      return false; // No browsers currently require single instance
    },
    [],
  );

  /**
   * Check if any instance of a specific browser type is currently running
   */
  const isAnyInstanceRunning = useCallback(
    (browserType: string): boolean => {
      if (!isClient) return false;
      return profiles.some(
        (p) => p.browser === browserType && runningProfiles.has(p.id),
      );
    },
    [profiles, runningProfiles, isClient],
  );

  /**
   * Check if a profile can be launched (not disabled by single-instance rules)
   */
  const canLaunchProfile = useCallback(
    (profile: BrowserProfile): boolean => {
      if (!isClient) return false;

      const isRunning = runningProfiles.has(profile.id);
      const isLaunching = launchingProfiles.has(profile.id);
      const isStopping = stoppingProfiles.has(profile.id);

      // If the profile is launching or stopping, disable the button
      if (isLaunching || isStopping) {
        return false;
      }

      // If the profile is already running, it can always be stopped
      if (isRunning) return true;

      // For single-instance browsers, check if any instance is running
      if (isSingleInstanceBrowser(profile.browser)) {
        return !isAnyInstanceRunning(profile.browser);
      }

      return true;
    },
    [
      runningProfiles,
      isClient,
      isSingleInstanceBrowser,
      isAnyInstanceRunning,
      launchingProfiles,
      stoppingProfiles,
    ],
  );

  /**
   * Check if a profile can be used for opening links
   * This is more restrictive than canLaunchProfile as it considers running state
   */
  const canUseProfileForLinks = useCallback(
    (profile: BrowserProfile): boolean => {
      if (!isClient) return false;

      const isLaunching = launchingProfiles.has(profile.id);
      const isStopping = stoppingProfiles.has(profile.id);

      // If this specific browser is launching or stopping, block it
      if (isLaunching || isStopping) {
        return false;
      }

      // For single-instance browsers
      if (isSingleInstanceBrowser(profile.browser)) {
        const isRunning = runningProfiles.has(profile.id);
        const runningInstancesOfType = profiles.filter(
          (p) => p.browser === profile.browser && runningProfiles.has(p.id),
        );

        // If no instances are running, any profile of this type can be used
        if (runningInstancesOfType.length === 0) {
          return true;
        }

        // If instances are running, only the running ones can be used
        return isRunning;
      }

      // For other browsers, any profile can be used
      return true;
    },
    [
      profiles,
      runningProfiles,
      isClient,
      isSingleInstanceBrowser,
      launchingProfiles,
      stoppingProfiles,
    ],
  );

  /**
   * Check if a profile can be selected for actions (delete, move group, etc.)
   */
  const canSelectProfile = useCallback(
    (profile: BrowserProfile): boolean => {
      if (!isClient) return false;

      const isRunning = runningProfiles.has(profile.id);
      const isLaunching = launchingProfiles.has(profile.id);
      const isStopping = stoppingProfiles.has(profile.id);

      // If profile is running, launching, or stopping, block selection
      if (isRunning || isLaunching || isStopping) {
        return false;
      }

      return true;
    },
    [isClient, runningProfiles, launchingProfiles, stoppingProfiles],
  );

  /**
   * Get tooltip content for a profile's launch button
   */
  const getLaunchTooltipContent = useCallback(
    (profile: BrowserProfile): string => {
      if (!isClient) return "Loading...";

      if (isCrossOsProfile(profile)) {
        // 不再是「不能启动」——启动时后端会自动把它接管到本机（备份 cookie、
        // 翻转 host_os、清掉跨 OS 指纹）。提示要说清会发生什么，因为这一步
        // 会换掉指纹，而那是用户该知情的。
        const profileOs =
          profile.host_os ||
          profile.camoufox_config?.os ||
          profile.wayfern_config?.os;
        return profileOs
          ? t("crossOs.adoptHint", { os: getOSDisplayName(profileOs) })
          : t("crossOs.adoptHintUnknownOs");
      }

      const isRunning = runningProfiles.has(profile.id);
      const isLaunching = launchingProfiles.has(profile.id);
      const isStopping = stoppingProfiles.has(profile.id);

      if (isLaunching) {
        return "Launching browser...";
      }

      if (isStopping) {
        return "Stopping browser...";
      }

      if (isRunning) {
        return "";
      }

      if (
        isSingleInstanceBrowser(profile.browser) &&
        !canLaunchProfile(profile)
      ) {
        return `Only one instance of this browser can run at a time. Stop the running browser first.`;
      }

      return "";
    },
    [
      runningProfiles,
      isClient,
      isSingleInstanceBrowser,
      canLaunchProfile,
      launchingProfiles,
      t,
      stoppingProfiles,
    ],
  );

  /**
   * Get tooltip content for profile selection (for opening links)
   */
  const getProfileTooltipContent = useCallback(
    (profile: BrowserProfile): string | null => {
      if (!isClient) return null;

      const canUseForLinks = canUseProfileForLinks(profile);

      if (canUseForLinks) return null;

      const isLaunching = launchingProfiles.has(profile.id);
      const isStopping = stoppingProfiles.has(profile.id);

      if (isLaunching) {
        return "Profile is currently launching. Please wait.";
      }

      if (isStopping) {
        return "Profile is currently stopping. Please wait.";
      }

      if (isSingleInstanceBrowser(profile.browser)) {
        const runningInstancesOfType = profiles.filter(
          (p) => p.browser === profile.browser && runningProfiles.has(p.id),
        );

        if (runningInstancesOfType.length > 0) {
          const runningProfileNames = runningInstancesOfType
            .map((p) => p.name)
            .join(", ");
          return `${getBrowserDisplayName(profile.browser)} browser is already running (${runningProfileNames}). Only one instance can run at a time.`;
        }
      }

      return "This profile cannot be used for opening links right now.";
    },
    [
      profiles,
      runningProfiles,
      isClient,
      canUseProfileForLinks,
      isSingleInstanceBrowser,
      launchingProfiles,
      stoppingProfiles,
    ],
  );

  // Memoized because consumers put this object in dependency arrays. Returning a
  // bare literal gave it a new identity on every render, which silently defeated
  // the `tableMeta` useMemo in profile-data-table.tsx.
  return useMemo(
    () => ({
      isClient,
      isSingleInstanceBrowser,
      isAnyInstanceRunning,
      canLaunchProfile,
      canUseProfileForLinks,
      canSelectProfile,
      getLaunchTooltipContent,
      getProfileTooltipContent,
    }),
    [
      isClient,
      isSingleInstanceBrowser,
      isAnyInstanceRunning,
      canLaunchProfile,
      canUseProfileForLinks,
      canSelectProfile,
      getLaunchTooltipContent,
      getProfileTooltipContent,
    ],
  );
}
