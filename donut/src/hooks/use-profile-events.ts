import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
import i18n from "@/i18n";
import type { BrowserProfile } from "@/types";

interface UseProfileEventsReturn {
  profiles: BrowserProfile[];
  runningProfiles: Set<string>;
  isLoading: boolean;
  error: string | null;
  loadProfiles: () => Promise<void>;
  clearError: () => void;
}

/**
 * Custom hook to manage profile-related state and listen for backend events.
 * This hook eliminates the need for manual UI refreshes by automatically
 * updating state when the backend emits profile change events.
 */
export function useProfileEvents(): UseProfileEventsReturn {
  const [profiles, setProfiles] = useState<BrowserProfile[]>([]);
  const [runningProfiles, setRunningProfiles] = useState<Set<string>>(
    new Set(),
  );
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load profiles from backend
  const loadProfiles = useCallback(async () => {
    try {
      const profileList = await invoke<BrowserProfile[]>(
        "list_browser_profiles",
      );
      setProfiles(profileList);
      setError(null);
    } catch (err: unknown) {
      console.error("Failed to load profiles:", err);
      setError(
        i18n.t("errors.loadProfilesFailed", { error: JSON.stringify(err) }),
      );
    }
  }, []);

  // Group state deliberately does NOT live here. `useGroupEvents` owns it and
  // subscribes to the same `profiles-changed` event, so keeping a second copy
  // meant every event paid for two `get_groups_with_profile_counts` round trips
  // — and neither consumer of this hook ever read the copy.

  // Clear error state
  const clearError = useCallback(() => {
    setError(null);
  }, []);

  // Initial load and event listeners setup
  useEffect(() => {
    let profilesUnlisten: (() => void) | undefined;
    let runningUnlisten: (() => void) | undefined;

    const setupListeners = async () => {
      try {
        // Initial load
        await loadProfiles();

        // Listen for profile changes (create, delete, rename, update, etc.)
        profilesUnlisten = await listen("profiles-changed", () => {
          void loadProfiles();
        });

        // Listen for profile running state changes
        runningUnlisten = await listen<{ id: string; is_running: boolean }>(
          "profile-running-changed",
          (event) => {
            const { id, is_running } = event.payload;
            setRunningProfiles((prev) => {
              // Returning `prev` unchanged is what stops a no-op event from
              // re-rendering the tree. A new Set identity propagates into
              // runningProfileIds, which tears down and rebuilds the 1 Hz
              // traffic-polling interval and fires an extra IPC immediately.
              if (prev.has(id) === is_running) return prev;
              const next = new Set(prev);
              if (is_running) {
                next.add(id);
              } else {
                next.delete(id);
              }
              return next;
            });
          },
        );
      } catch (err) {
        console.error("Failed to setup profile event listeners:", err);
        setError(
          i18n.t("errors.setupProfileListenersFailed", {
            error: JSON.stringify(err),
          }),
        );
      } finally {
        setIsLoading(false);
      }
    };

    void setupListeners();

    // Cleanup listeners on unmount
    return () => {
      if (profilesUnlisten) profilesUnlisten();
      if (runningUnlisten) runningUnlisten();
    };
  }, [loadProfiles]);

  // Hydrate the initial runningProfiles set from the loaded list — every
  // profile that has a stored process_id is a candidate. The Rust status
  // checker emits profile-running-changed for any transitions; we then
  // mutate the Set incrementally instead of fan-out-polling all N profiles
  // every 30s (which was O(N) sysinfo scans and saturated the runtime for
  // users with hundreds of profiles).
  //
  // This effect runs after EVERY profiles reload, and a reload happens on every
  // `profiles-changed` — including the ones the sync engine emits purely to
  // record `last_sync`. Returning `prev` when the membership is identical is
  // what keeps that bookkeeping from cascading into a second render pass, a new
  // `runningProfiles` identity, and a rebuild of the 1 Hz traffic interval.
  useEffect(() => {
    setRunningProfiles((prev) => {
      const next = new Set(prev);
      for (const p of profiles) {
        if (p.process_id != null) next.add(p.id);
      }
      // Drop ids for profiles that no longer exist
      const valid = new Set(profiles.map((p) => p.id));
      for (const id of next) {
        if (!valid.has(id)) next.delete(id);
      }
      if (next.size === prev.size && [...next].every((id) => prev.has(id))) {
        return prev;
      }
      return next;
    });
  }, [profiles]);

  return {
    profiles,
    runningProfiles,
    isLoading,
    error,
    loadProfiles,
    clearError,
  };
}
