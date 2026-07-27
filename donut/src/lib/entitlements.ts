import type { CloudUser, Entitlements } from "@/types";

/**
 * This build has no plan tiers. Every capability is granted and every limit is
 * unbounded, regardless of whether a cloud account is signed in and regardless
 * of what plan the backend reports for it.
 *
 * The shape is kept (rather than deleting the concept) because `Entitlements`
 * is part of the `CloudUser` payload the desktop hands to the UI.
 */
const UNLOCKED: Entitlements = {
  active: true,
  browserAutomation: true,
  crossOsFingerprints: true,
  cloudBackup: true,
  teamCollaboration: true,
  profileLimit: Number.POSITIVE_INFINITY,
  requestsPerHour: Number.POSITIVE_INFINITY,
};

export function getEntitlements(_user?: CloudUser | null): Entitlements {
  return UNLOCKED;
}
