"use client";

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  LuExternalLink,
  LuInbox,
  LuLoaderCircle,
  LuRefreshCw,
  LuRotateCcw,
  LuSearch,
  LuTriangleAlert,
} from "react-icons/lu";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export interface PostingRecord {
  id: string;
  event_id?: string;
  profile_id: string;
  brand_id: string;
  target_url: string;
  platform: string;
  kind: string;
  angle: string;
  text_snapshot: string;
  posted_at: number;
  page_title?: string;
  profile_name_snapshot?: string;
  identity_label?: string;
  site_account_id?: string;
  site_account_name?: string;
  platform_comment_id?: string;
  target_comment_id?: string;
  target_author?: string;
  parent_id?: string;
  root_id?: string;
  context_id?: string;
  confirmation_source?: string;
  status?: string;
}

type TimeRange = "all" | "today" | "sevenDays" | "thirtyDays";
type PostingKind = "direct" | "reply";
type ConfirmationStatus = "published" | "manualConfirmed";
type LoadMode = "initial" | "refresh" | "background";

const ALL_FILTER = "__all__";
const UNKNOWN_PLATFORM = "__unknown_platform__";

function timestampMs(record: PostingRecord): number {
  if (!Number.isFinite(record.posted_at) || record.posted_at <= 0) return 0;
  return record.posted_at >= 1_000_000_000_000
    ? record.posted_at
    : record.posted_at * 1000;
}

function startOfToday(now = new Date()): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function timeRangeStart(range: TimeRange, now = new Date()): number {
  const today = startOfToday(now);
  if (range === "today") return today;
  if (range === "sevenDays") {
    return new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - 6,
    ).getTime();
  }
  if (range === "thirtyDays") {
    return new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - 29,
    ).getTime();
  }
  return 0;
}

function postingKind(record: PostingRecord): PostingKind {
  return record.kind.trim().toLowerCase() === "reply" ? "reply" : "direct";
}

function confirmationStatus(record: PostingRecord): ConfirmationStatus {
  const status = record.status?.trim().toLowerCase();
  const source = record.confirmation_source?.trim().toLowerCase();
  if (
    status === "published" ||
    source === "bilibili-api" ||
    source === "platform-api"
  ) {
    return "published";
  }
  return "manualConfirmed";
}

function profileIdentity(record: PostingRecord): string {
  return (
    record.profile_name_snapshot?.trim() ||
    record.identity_label?.trim() ||
    record.profile_id.trim()
  );
}

function siteIdentity(record: PostingRecord): string {
  const name = record.site_account_name?.trim() || "";
  const id = record.site_account_id?.trim() || "";
  if (name && id && name !== id) return `${name} (${id})`;
  return name || id;
}

function identityKey(record: PostingRecord): string {
  return JSON.stringify([
    record.profile_id.trim(),
    record.site_account_id?.trim() || record.site_account_name?.trim() || "",
  ]);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function platformKey(record: PostingRecord): string {
  return record.platform.trim() || UNKNOWN_PLATFORM;
}

function IdentityBlock({
  record,
  unknownLabel,
}: {
  record: PostingRecord;
  unknownLabel: string;
}) {
  const { t } = useTranslation();
  const profile = profileIdentity(record) || unknownLabel;
  const site = siteIdentity(record);
  const profileId = record.profile_id.trim();

  return (
    <div className="min-w-0">
      <p className="truncate font-medium text-foreground" title={profile}>
        {profile}
      </p>
      {site && site !== profile ? (
        <p className="truncate text-[11px] text-muted-foreground" title={site}>
          {site}
        </p>
      ) : null}
      {profileId && profileId !== profile ? (
        <p
          className="truncate text-[10px] text-muted-foreground"
          title={profileId}
        >
          {t("marine.history.profileId", { id: profileId })}
        </p>
      ) : null}
    </div>
  );
}

function ConfirmationBadge({ status }: { status: ConfirmationStatus }) {
  const { t } = useTranslation();
  const automatic = status === "published";

  return (
    <Badge
      variant="outline"
      className={
        automatic
          ? "border-success/40 bg-success/10 text-success"
          : "border-warning/40 bg-warning/10 text-warning"
      }
    >
      {automatic
        ? t("marine.history.status.automatic")
        : t("marine.history.status.manual")}
    </Badge>
  );
}

function PageTitleLink({ record }: { record: PostingRecord }) {
  const { t } = useTranslation();
  const title = record.page_title?.trim() || t("marine.history.untitled");
  const clickable = isHttpUrl(record.target_url);

  if (!clickable) {
    return <span className="line-clamp-2 font-medium">{title}</span>;
  }

  return (
    <button
      type="button"
      className="group flex max-w-full cursor-pointer items-start gap-1 text-left font-medium text-foreground hover:underline"
      title={record.target_url}
      onClick={() => {
        void openUrl(record.target_url).catch((error) => {
          console.error("Failed to open posting history URL:", error);
        });
      }}
    >
      <span className="line-clamp-2">{title}</span>
      <LuExternalLink className="mt-0.5 size-3 shrink-0 text-muted-foreground group-hover:text-foreground" />
    </button>
  );
}

function HistoryCard({
  record,
  formatDate,
  unknownIdentityLabel,
}: {
  record: PostingRecord;
  formatDate: (record: PostingRecord) => string;
  unknownIdentityLabel: string;
}) {
  const { t } = useTranslation();
  const kind = postingKind(record);
  const rawPlatform = platformKey(record);
  const platform =
    rawPlatform === UNKNOWN_PLATFORM
      ? t("marine.history.unknownPlatform")
      : rawPlatform;

  return (
    <article className="rounded-lg border border-border bg-card p-3">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[11px] text-muted-foreground">
          {formatDate(record)}
        </p>
        <ConfirmationBadge status={confirmationStatus(record)} />
      </div>

      <div className="mt-2">
        <PageTitleLink record={record} />
        {record.target_url ? (
          <p
            className="mt-0.5 truncate text-[10px] text-muted-foreground"
            title={record.target_url}
          >
            {record.target_url}
          </p>
        ) : null}
      </div>

      <p className="mt-3 whitespace-pre-wrap text-sm leading-5 text-foreground">
        {record.text_snapshot}
      </p>
      {kind === "reply" && record.target_author?.trim() ? (
        <p className="mt-1 text-[11px] text-muted-foreground">
          {t("marine.history.replyTo", {
            name: record.target_author.trim(),
          })}
        </p>
      ) : null}

      <dl className="mt-3 grid grid-cols-3 gap-2 border-t border-border pt-2 text-xs">
        <div className="min-w-0">
          <dt className="text-[10px] text-muted-foreground">
            {t("marine.history.columns.identity")}
          </dt>
          <dd className="mt-0.5">
            <IdentityBlock
              record={record}
              unknownLabel={unknownIdentityLabel}
            />
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[10px] text-muted-foreground">
            {t("marine.history.columns.platform")}
          </dt>
          <dd className="mt-0.5 truncate font-medium" title={platform}>
            {platform}
          </dd>
        </div>
        <div>
          <dt className="text-[10px] text-muted-foreground">
            {t("marine.history.columns.kind")}
          </dt>
          <dd className="mt-0.5 font-medium">
            {kind === "reply"
              ? t("marine.history.kind.reply")
              : t("marine.history.kind.direct")}
          </dd>
        </div>
      </dl>
    </article>
  );
}

export function CommentHistoryPage() {
  const { t, i18n } = useTranslation();
  const [records, setRecords] = useState<PostingRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [query, setQuery] = useState("");
  const [identityFilter, setIdentityFilter] = useState(ALL_FILTER);
  const [platformFilter, setPlatformFilter] = useState(ALL_FILTER);
  const [kindFilter, setKindFilter] = useState(ALL_FILTER);
  const [statusFilter, setStatusFilter] = useState(ALL_FILTER);
  const [timeRange, setTimeRange] = useState<TimeRange>("all");
  const [localDayStart, setLocalDayStart] = useState(() => startOfToday());
  const requestSequenceRef = useRef(0);

  const loadHistory = useCallback(async (mode: LoadMode) => {
    const requestSequence = ++requestSequenceRef.current;
    if (mode === "initial") setIsLoading(true);
    if (mode === "refresh") setIsRefreshing(true);
    try {
      const nextRecords = await invoke<PostingRecord[]>(
        "marine_list_posting_history",
      );
      if (requestSequence !== requestSequenceRef.current) return;
      setRecords(nextRecords);
      setLoadError(false);
    } catch (error) {
      if (requestSequence !== requestSequenceRef.current) return;
      console.error("Failed to load posting history:", error);
      setLoadError(true);
    } finally {
      if (requestSequence === requestSequenceRef.current) {
        setIsLoading(false);
        setIsRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    const setup = async () => {
      try {
        const stopListening = await listen("history-changed", () => {
          if (!disposed) void loadHistory("background");
        });
        if (disposed) stopListening();
        else unlisten = stopListening;
      } catch (error) {
        console.error("Failed to listen for posting history changes:", error);
      }

      if (!disposed) void loadHistory("initial");
    };

    void setup();

    return () => {
      disposed = true;
      requestSequenceRef.current += 1;
      unlisten?.();
    };
  }, [loadHistory]);

  useEffect(() => {
    let midnightTimer: ReturnType<typeof setTimeout>;

    const scheduleMidnightTick = () => {
      const now = new Date();
      const nextMidnight = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + 1,
      ).getTime();
      midnightTimer = setTimeout(
        () => {
          setLocalDayStart(startOfToday());
          scheduleMidnightTick();
        },
        Math.max(1, nextMidnight - now.getTime() + 100),
      );
    };

    scheduleMidnightTick();
    return () => clearTimeout(midnightTimer);
  }, []);

  const identities = useMemo(() => {
    const options = new Map<
      string,
      { key: string; label: string; postedAt: number }
    >();
    for (const record of records) {
      const key = identityKey(record);
      const postedAt = timestampMs(record);
      const existing = options.get(key);
      if (existing && existing.postedAt >= postedAt) continue;
      const profile =
        profileIdentity(record) || t("marine.history.unknownIdentity");
      const site = siteIdentity(record);
      const profileId = record.profile_id.trim();
      const label = [
        profile,
        site && site !== profile ? site : "",
        profileId && profileId !== profile ? profileId : "",
      ]
        .filter(Boolean)
        .join(" · ");
      options.set(key, { key, label, postedAt });
    }
    return [...options.values()].sort((a, b) =>
      a.label.localeCompare(b.label, i18n.resolvedLanguage),
    );
  }, [records, i18n.resolvedLanguage, t]);

  const platforms = useMemo(() => {
    const options = [...new Set(records.map(platformKey))].map((key) => ({
      key,
      label:
        key === UNKNOWN_PLATFORM ? t("marine.history.unknownPlatform") : key,
    }));
    return options.sort((a, b) =>
      a.label.localeCompare(b.label, i18n.resolvedLanguage),
    );
  }, [records, i18n.resolvedLanguage, t]);

  const stats = useMemo(() => {
    const now = new Date(localDayStart);
    const today = localDayStart;
    const sevenDays = timeRangeStart("sevenDays", now);
    return {
      today: records.filter((record) => timestampMs(record) >= today).length,
      sevenDays: records.filter((record) => timestampMs(record) >= sevenDays)
        .length,
      all: records.length,
    };
  }, [records, localDayStart]);

  const filteredRecords = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const rangeStart = timeRangeStart(timeRange, new Date(localDayStart));

    return records
      .filter((record) => {
        if (
          identityFilter !== ALL_FILTER &&
          identityKey(record) !== identityFilter
        ) {
          return false;
        }
        if (
          platformFilter !== ALL_FILTER &&
          platformKey(record) !== platformFilter
        ) {
          return false;
        }
        if (kindFilter !== ALL_FILTER && postingKind(record) !== kindFilter) {
          return false;
        }
        if (
          statusFilter !== ALL_FILTER &&
          confirmationStatus(record) !== statusFilter
        ) {
          return false;
        }
        if (rangeStart > 0 && timestampMs(record) < rangeStart) return false;
        if (!normalizedQuery) return true;

        return [
          record.text_snapshot,
          record.page_title,
          record.target_url,
          record.angle,
          record.target_author,
          profileIdentity(record),
          siteIdentity(record),
          record.profile_id,
          record.site_account_id,
          record.platform,
        ]
          .filter(Boolean)
          .some((value) =>
            String(value).toLocaleLowerCase().includes(normalizedQuery),
          );
      })
      .sort((a, b) => timestampMs(b) - timestampMs(a));
  }, [
    records,
    query,
    identityFilter,
    platformFilter,
    kindFilter,
    statusFilter,
    timeRange,
    localDayStart,
  ]);

  const hasFilters =
    query.trim().length > 0 ||
    identityFilter !== ALL_FILTER ||
    platformFilter !== ALL_FILTER ||
    kindFilter !== ALL_FILTER ||
    statusFilter !== ALL_FILTER ||
    timeRange !== "all";

  const resetFilters = () => {
    setQuery("");
    setIdentityFilter(ALL_FILTER);
    setPlatformFilter(ALL_FILTER);
    setKindFilter(ALL_FILTER);
    setStatusFilter(ALL_FILTER);
    setTimeRange("all");
  };

  const formatDate = useCallback(
    (record: PostingRecord) => {
      const timestamp = timestampMs(record);
      if (!timestamp) return t("marine.history.unknownTime");
      return new Intl.DateTimeFormat(i18n.resolvedLanguage, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(timestamp);
    },
    [i18n.resolvedLanguage, t],
  );

  const unknownIdentityLabel = t("marine.history.unknownIdentity");

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pt-4 pb-8 sm:px-6">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-4">
        <header className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold">
              {t("marine.history.title")}
            </h1>
            <p className="mt-1 max-w-3xl text-xs text-muted-foreground">
              {t("marine.history.description")}
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-label={t("common.buttons.refresh")}
            disabled={isLoading || isRefreshing}
            onClick={() => {
              void loadHistory("refresh");
            }}
          >
            <LuRefreshCw
              className={isRefreshing ? "animate-spin" : undefined}
            />
            <span className="hidden sm:inline">
              {t("common.buttons.refresh")}
            </span>
          </Button>
        </header>

        <section
          aria-label={t("marine.history.stats.label")}
          className="grid grid-cols-3 gap-2"
        >
          <div className="rounded-lg border border-border bg-card px-3 py-2.5">
            <p className="text-[10px] tracking-wide text-muted-foreground uppercase">
              {t("marine.history.stats.today")}
            </p>
            <p className="mt-1 text-xl font-semibold tabular-nums">
              {stats.today}
            </p>
          </div>
          <div className="rounded-lg border border-border bg-card px-3 py-2.5">
            <p className="text-[10px] tracking-wide text-muted-foreground uppercase">
              {t("marine.history.stats.sevenDays")}
            </p>
            <p className="mt-1 text-xl font-semibold tabular-nums">
              {stats.sevenDays}
            </p>
          </div>
          <div className="rounded-lg border border-border bg-card px-3 py-2.5">
            <p className="text-[10px] tracking-wide text-muted-foreground uppercase">
              {t("marine.history.stats.all")}
            </p>
            <p className="mt-1 text-xl font-semibold tabular-nums">
              {stats.all}
            </p>
          </div>
        </section>

        <section
          aria-label={t("marine.history.filters.label")}
          className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3"
        >
          <div className="flex flex-col gap-2 lg:flex-row">
            <div className="relative min-w-52 flex-1">
              <LuSearch className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                }}
                placeholder={t("marine.history.filters.searchPlaceholder")}
                aria-label={t("marine.history.filters.search")}
                className="h-8 pl-9 text-xs"
              />
            </div>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:flex">
              <Select value={identityFilter} onValueChange={setIdentityFilter}>
                <SelectTrigger
                  size="sm"
                  aria-label={t("marine.history.filters.identity")}
                  className="w-full text-xs lg:w-44"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_FILTER}>
                    {t("marine.history.filters.allIdentities")}
                  </SelectItem>
                  {identities.map((identity) => (
                    <SelectItem key={identity.key} value={identity.key}>
                      {identity.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select value={platformFilter} onValueChange={setPlatformFilter}>
                <SelectTrigger
                  size="sm"
                  aria-label={t("marine.history.filters.platform")}
                  className="w-full text-xs lg:w-36"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_FILTER}>
                    {t("marine.history.filters.allPlatforms")}
                  </SelectItem>
                  {platforms.map((platform) => (
                    <SelectItem key={platform.key} value={platform.key}>
                      {platform.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select value={kindFilter} onValueChange={setKindFilter}>
                <SelectTrigger
                  size="sm"
                  aria-label={t("marine.history.filters.kind")}
                  className="w-full text-xs lg:w-32"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_FILTER}>
                    {t("marine.history.filters.allKinds")}
                  </SelectItem>
                  <SelectItem value="direct">
                    {t("marine.history.kind.direct")}
                  </SelectItem>
                  <SelectItem value="reply">
                    {t("marine.history.kind.reply")}
                  </SelectItem>
                </SelectContent>
              </Select>

              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger
                  size="sm"
                  aria-label={t("marine.history.filters.status")}
                  className="w-full text-xs lg:w-36"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_FILTER}>
                    {t("marine.history.filters.allStatuses")}
                  </SelectItem>
                  <SelectItem value="published">
                    {t("marine.history.status.automatic")}
                  </SelectItem>
                  <SelectItem value="manualConfirmed">
                    {t("marine.history.status.manual")}
                  </SelectItem>
                </SelectContent>
              </Select>

              <Select
                value={timeRange}
                onValueChange={(value) => {
                  setTimeRange(value as TimeRange);
                }}
              >
                <SelectTrigger
                  size="sm"
                  aria-label={t("marine.history.filters.time")}
                  className="w-full text-xs lg:w-32"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">
                    {t("marine.history.filters.allTime")}
                  </SelectItem>
                  <SelectItem value="today">
                    {t("marine.history.filters.today")}
                  </SelectItem>
                  <SelectItem value="sevenDays">
                    {t("marine.history.filters.sevenDays")}
                  </SelectItem>
                  <SelectItem value="thirtyDays">
                    {t("marine.history.filters.thirtyDays")}
                  </SelectItem>
                </SelectContent>
              </Select>

              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={!hasFilters}
                onClick={resetFilters}
                className="px-2 text-xs"
              >
                <LuRotateCcw />
                {t("marine.history.filters.clear")}
              </Button>
            </div>
          </div>
          {!isLoading && !loadError ? (
            <p className="text-[11px] text-muted-foreground">
              {t("marine.history.showing", {
                shown: filteredRecords.length,
                total: records.length,
              })}
            </p>
          ) : null}
        </section>

        {loadError ? (
          <Alert variant="destructive">
            <LuTriangleAlert />
            <AlertTitle>{t("marine.history.loadError.title")}</AlertTitle>
            <AlertDescription>
              <p>{t("marine.history.loadError.description")}</p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  void loadHistory("refresh");
                }}
              >
                {t("common.buttons.retry")}
              </Button>
            </AlertDescription>
          </Alert>
        ) : isLoading ? (
          <div className="flex min-h-56 flex-col items-center justify-center gap-2 rounded-lg border border-border bg-card text-muted-foreground">
            <LuLoaderCircle className="size-5 animate-spin" />
            <p className="text-xs">{t("marine.history.loading")}</p>
          </div>
        ) : filteredRecords.length === 0 ? (
          <div className="flex min-h-56 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-card px-6 text-center">
            <span className="grid size-10 place-items-center rounded-full bg-muted text-muted-foreground">
              <LuInbox className="size-5" />
            </span>
            <h2 className="text-sm font-medium">
              {hasFilters
                ? t("marine.history.empty.filteredTitle")
                : t("marine.history.empty.title")}
            </h2>
            <p className="max-w-md text-xs text-muted-foreground">
              {hasFilters
                ? t("marine.history.empty.filteredDescription")
                : t("marine.history.empty.description")}
            </p>
            {hasFilters ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={resetFilters}
              >
                {t("marine.history.filters.clear")}
              </Button>
            ) : null}
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-2 lg:hidden">
              {filteredRecords.map((record) => (
                <HistoryCard
                  key={record.id}
                  record={record}
                  formatDate={formatDate}
                  unknownIdentityLabel={unknownIdentityLabel}
                />
              ))}
            </div>

            <div className="hidden overflow-hidden rounded-lg border border-border bg-card lg:block">
              <Table containerClassName="max-h-[calc(100dvh-19rem)] overflow-auto">
                <TableHeader className="sticky top-0 z-10 bg-card">
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-36">
                      {t("marine.history.columns.time")}
                    </TableHead>
                    <TableHead className="w-44">
                      {t("marine.history.columns.identity")}
                    </TableHead>
                    <TableHead className="min-w-52">
                      {t("marine.history.columns.page")}
                    </TableHead>
                    <TableHead className="w-28">
                      {t("marine.history.columns.platform")}
                    </TableHead>
                    <TableHead className="w-20">
                      {t("marine.history.columns.kind")}
                    </TableHead>
                    <TableHead className="min-w-72">
                      {t("marine.history.columns.comment")}
                    </TableHead>
                    <TableHead className="w-32">
                      {t("marine.history.columns.status")}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredRecords.map((record) => {
                    const kind = postingKind(record);
                    const rawPlatform = platformKey(record);
                    const platform =
                      rawPlatform === UNKNOWN_PLATFORM
                        ? t("marine.history.unknownPlatform")
                        : rawPlatform;
                    return (
                      <TableRow key={record.id}>
                        <TableCell className="align-top text-xs whitespace-normal text-muted-foreground tabular-nums">
                          {formatDate(record)}
                        </TableCell>
                        <TableCell className="max-w-44 align-top whitespace-normal">
                          <IdentityBlock
                            record={record}
                            unknownLabel={unknownIdentityLabel}
                          />
                        </TableCell>
                        <TableCell className="max-w-72 align-top whitespace-normal">
                          <PageTitleLink record={record} />
                          {record.target_url ? (
                            <p
                              className="mt-0.5 truncate text-[10px] text-muted-foreground"
                              title={record.target_url}
                            >
                              {record.target_url}
                            </p>
                          ) : null}
                        </TableCell>
                        <TableCell className="max-w-28 align-top whitespace-normal">
                          <p className="truncate font-medium" title={platform}>
                            {platform}
                          </p>
                          {record.platform_comment_id?.trim() ? (
                            <p
                              className="mt-0.5 truncate text-[10px] text-muted-foreground"
                              title={record.platform_comment_id.trim()}
                            >
                              #{record.platform_comment_id.trim()}
                            </p>
                          ) : null}
                        </TableCell>
                        <TableCell className="align-top whitespace-normal">
                          {kind === "reply"
                            ? t("marine.history.kind.reply")
                            : t("marine.history.kind.direct")}
                        </TableCell>
                        <TableCell className="max-w-xl align-top whitespace-normal">
                          <p className="whitespace-pre-wrap text-sm leading-5">
                            {record.text_snapshot}
                          </p>
                          {kind === "reply" && record.target_author?.trim() ? (
                            <p className="mt-1 truncate text-[10px] text-muted-foreground">
                              {t("marine.history.replyTo", {
                                name: record.target_author.trim(),
                              })}
                            </p>
                          ) : null}
                        </TableCell>
                        <TableCell className="align-top whitespace-normal">
                          <ConfirmationBadge
                            status={confirmationStatus(record)}
                          />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
