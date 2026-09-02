import type { BrowserProfile } from "@/types";

/** Keep in sync with `marine::prospect::SUPPORTED_PLATFORMS`. */
export const MARINE_PLATFORMS = [
  "bilibili",
  "zhihu",
  "douyin",
  "xiaohongshu",
] as const;

export type MarinePlatform = (typeof MARINE_PLATFORMS)[number];

const MARINE_PLATFORM_SET = new Set<string>(MARINE_PLATFORMS);

/**
 * Drop stale/unknown values and restore the product-defined platform order.
 * The backend performs the same normalization before persisting metadata.
 */
export function normalizeMarinePlatforms(
  platforms: readonly string[] | null | undefined,
): MarinePlatform[] {
  if (!platforms?.length) return [];
  const selected = new Set(
    platforms.filter((platform) => MARINE_PLATFORM_SET.has(platform)),
  );
  return MARINE_PLATFORMS.filter((platform) => selected.has(platform));
}

export function profileHasMarineAutomation(profile: BrowserProfile): boolean {
  return normalizeMarinePlatforms(profile.marine_platforms).length > 0;
}
