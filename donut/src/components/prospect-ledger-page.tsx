"use client";

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  LuCirclePlay,
  LuCircleStop,
  LuExternalLink,
  LuInbox,
  LuLoaderCircle,
  LuRefreshCw,
  LuSearch,
  LuTriangleAlert,
} from "react-icons/lu";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { translateBackendError } from "@/lib/backend-errors";
import {
  MARINE_PLATFORMS,
  profileHasMarineAutomation,
} from "@/lib/marine-platforms";
import { showToast } from "@/lib/toast-utils";
import type { BrowserProfile } from "@/types";

/** Mirrors `marine::prospect::ProspectState` (serde `snake_case`). */
type ProspectState =
  | "seen"
  | "claimed"
  | "posted"
  | "unconfirmed"
  | "skipped"
  | "filled"
  | "failed"
  | "blocked";

interface AccountTouch {
  profile_id: string;
  state: ProspectState;
  at: number;
}

/** Mirrors `marine::prospect::ProspectRecord`. */
export interface ProspectRecord {
  key: string;
  platform: string;
  item_id: string;
  title: string;
  open_url: string;
  open_url_durability: "permanent" | "session";
  resolved_at: number;
  first_seen_at: number;
  keywords: string[];
  state: ProspectState;
  claimed_by?: string;
  claimed_at?: number;
  send_started_at?: number;
  touches: AccountTouch[];
}

type LegOutcome =
  | "posted"
  | "unconfirmed"
  | "filled"
  | "timed_out"
  | "no_work"
  | "no_slot"
  | "already_open"
  | "skipped"
  | "failed"
  | "cancelled";

interface LegReport {
  profile_id: string;
  profile_name: string;
  platform: string;
  outcome: LegOutcome;
  settled_count: number;
  error?: string;
}

type RunPhase =
  | "idle"
  | "launching"
  | "working"
  | "closing"
  | "pausing"
  | "done"
  | "cancelled";

/** Mirrors `marine::scheduler::RunProgress`. */
interface MarineLogLocations {
  app_log_dir: string;
  app_log_file: string;
  extension_log_file: string;
}

interface RunProgress {
  running: boolean;
  leg_index: number;
  total_legs: number;
  current_profile_id?: string;
  current_profile_name?: string;
  current_platform?: string;
  phase: RunPhase;
  finished: LegReport[];
}

const PROGRESS_EVENT = "marine-discovery-progress";
const ALL_FILTER = "__all__";

/**
 * Wayfern only, and not as a preference: the discovery pipeline *is* the Marine
 * MV3 extension, and that extension is stamped into a profile solely on the
 * Wayfern launch path (`marine::extension::ensure_for_profile`). A Camoufox
 * profile launches without it, so nothing ever ingests or settles — the leg
 * would idle out its full timeout and report "nothing settled", which reads
 * identically to "not logged in". Mirrors `DISCOVERY_ENGINES` in scheduler.rs,
 * which rejects the same thing server-side.
 */
const AUTOMATABLE_BROWSERS = new Set(["wayfern"]);

const OUTCOME_CLASS: Record<LegOutcome, string> = {
  posted: "text-success",
  unconfirmed: "text-warning",
  // A filled draft is durable work, but it has no public footprint and must
  // never share the success colour used by a receipt-confirmed post.
  filled: "text-muted-foreground",
  timed_out: "text-muted-foreground",
  // 「没活干」不是失败也不是卡住：未登录 / 台账里没有该账号能碰的候选了。
  no_work: "text-muted-foreground",
  no_slot: "text-muted-foreground",
  // Not a failure, but the operator has to act on it (close the window and
  // re-run), so it does not get the same grey as "nothing to do".
  already_open: "text-warning",
  // 前置条件没满足（比如租约在别的设备上）——要人处理，但不是"跑失败了"。
  skipped: "text-warning",
  failed: "text-destructive",
  cancelled: "text-muted-foreground",
};

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function idleProgress(): RunProgress {
  return {
    running: false,
    leg_index: 0,
    total_legs: 0,
    phase: "idle",
    finished: [],
  };
}

export function ProspectLedgerPage() {
  const { t, i18n } = useTranslation();

  const [records, setRecords] = useState<ProspectRecord[]>([]);
  const [profiles, setProfiles] = useState<BrowserProfile[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [loadError, setLoadError] = useState(false);

  const [query, setQuery] = useState("");
  const [platformFilter, setPlatformFilter] = useState(ALL_FILTER);

  const [keyword, setKeyword] = useState("");
  // 空 = 只跑一轮。填了分钟数就变成「跑完歇这么久，再跑下一轮」。
  const [cycleGap, setCycleGap] = useState("");
  const [progress, setProgress] = useState<RunProgress>(idleProgress);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [isRestartCoolingDown, setIsRestartCoolingDown] = useState(false);
  const [logs, setLogs] = useState<MarineLogLocations | null>(null);

  // `marine_stop_discovery` only requests cancellation; the run claim remains
  // held until claim cleanup and browser shutdown finish. Keep the old button
  // disabled through that interval, then for one short guard window. Without
  // it, the terminal event swaps Stop for Start under the pointer and a double
  // click immediately launches a fresh cycle (observed in the live run).
  const stopRequestedRef = useRef(false);
  const restartCooldownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const finishStopTransition = useCallback(() => {
    if (!stopRequestedRef.current) return;
    stopRequestedRef.current = false;
    setIsStopping(false);
    setIsRestartCoolingDown(true);
    if (restartCooldownTimerRef.current !== null) {
      clearTimeout(restartCooldownTimerRef.current);
    }
    restartCooldownTimerRef.current = setTimeout(() => {
      restartCooldownTimerRef.current = null;
      setIsRestartCoolingDown(false);
    }, 650);
  }, []);

  const acceptProgress = useCallback(
    (next: RunProgress) => {
      setProgress(next);
      if (!next.running) finishStopTransition();
    },
    [finishStopTransition],
  );

  // The terminal progress event is the fast path, but desktop event delivery
  // can be lost during a route/window transition. While Stop is pending, poll
  // the authoritative backend snapshot for up to 30s. Each request schedules
  // the next only after it resolves, so calls never overlap; cleanup cancels
  // its timers and ignores an in-flight response after unmount/state exit.
  useEffect(() => {
    if (!isStopping) return;

    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const maxAttempts = 120;

    const poll = async () => {
      if (disposed) return;
      try {
        const current = await invoke<RunProgress>("marine_discovery_status");
        if (disposed) return;
        acceptProgress(current);
        if (!current.running) return;
      } catch (error) {
        if (disposed) return;
        console.warn("Failed to poll discovery stop status:", error);
      }

      attempts += 1;
      if (attempts >= maxAttempts) {
        // Keep the backend's last `running` snapshot, which leaves Stop (not
        // Start) on screen, but allow the operator to request cancellation
        // again instead of trapping the UI in an eternal spinner.
        stopRequestedRef.current = false;
        setIsStopping(false);
        return;
      }
      timer = setTimeout(() => {
        void poll();
      }, 250);
    };

    timer = setTimeout(() => {
      void poll();
    }, 250);
    watchdog = setTimeout(() => {
      // Also bounds a pathological invoke that never resolves.
      disposed = true;
      stopRequestedRef.current = false;
      setIsStopping(false);
    }, 30_000);
    return () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      if (watchdog !== undefined) clearTimeout(watchdog);
    };
  }, [acceptProgress, isStopping]);

  // 路径在进程生命周期内不变，挂载取一次即可。取不到就不显示这一块 ——
  // 排查入口本身不该成为新的报错来源。
  useEffect(() => {
    void invoke<MarineLogLocations>("marine_log_locations")
      .then(setLogs)
      .catch(() => setLogs(null));
  }, []);

  const requestSequenceRef = useRef(0);

  const loadRecords = useCallback(async (refreshing: boolean) => {
    const sequence = ++requestSequenceRef.current;
    if (refreshing) setIsRefreshing(true);
    try {
      const next = await invoke<ProspectRecord[]>("marine_list_prospects");
      if (sequence !== requestSequenceRef.current) return;
      setRecords(next);
      setLoadError(false);
    } catch (error) {
      if (sequence !== requestSequenceRef.current) return;
      console.error("Failed to load prospect ledger:", error);
      setLoadError(true);
    } finally {
      if (sequence === requestSequenceRef.current) {
        setIsLoading(false);
        setIsRefreshing(false);
      }
    }
  }, []);

  const loadProfiles = useCallback(async () => {
    try {
      const all = await invoke<BrowserProfile[]>("list_browser_profiles");
      setProfiles(all.filter((p) => AUTOMATABLE_BROWSERS.has(p.browser)));
    } catch (error) {
      console.error("Failed to load profiles for discovery run:", error);
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlistenProgress: (() => void) | undefined;
    let unlistenProfiles: (() => void) | undefined;

    const setup = async () => {
      try {
        const stop = await listen<RunProgress>(PROGRESS_EVENT, (event) => {
          if (disposed) return;
          acceptProgress(event.payload);
          // Each progress tick is a chance the ledger moved. Reloading here is
          // what makes the table update live during a run instead of only when
          // the operator remembers to hit refresh.
          void loadRecords(false);
        });
        if (disposed) stop();
        else unlistenProgress = stop;
      } catch (error) {
        console.error("Failed to listen for discovery progress:", error);
      }

      try {
        const stop = await listen("profiles-changed", () => {
          if (!disposed) void loadProfiles();
        });
        if (disposed) stop();
        else unlistenProfiles = stop;
      } catch (error) {
        console.error("Failed to listen for profile changes:", error);
      }

      if (disposed) return;
      try {
        const current = await invoke<RunProgress>("marine_discovery_status");
        if (!disposed) acceptProgress(current);
      } catch (error) {
        console.error("Failed to read discovery status:", error);
      }
      void loadRecords(false);
      void loadProfiles();
    };

    void setup();
    return () => {
      disposed = true;
      requestSequenceRef.current += 1;
      if (restartCooldownTimerRef.current !== null) {
        clearTimeout(restartCooldownTimerRef.current);
        restartCooldownTimerRef.current = null;
      }
      unlistenProgress?.();
      unlistenProfiles?.();
    };
  }, [acceptProgress, loadRecords, loadProfiles]);

  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.language, {
        dateStyle: "short",
        timeStyle: "short",
      }),
    [i18n.language],
  );

  // 确认发布与「已点击但回执未知」必须分开统计。后者会保守占用公开足迹额度，
  // 但不能冒充发布成功；否则运营侧只看到候选莫名永久不再分配。
  //
  // 以前还并排显示候选总数 / 未处理 / 已填入。那三个都不是成绩：前两个是发现池
  // 的规模，跟投放成果无关；`filled` 更是历史遗留 —— 四个平台都放开发送之后，
  // 一条记录停在 filled 只意味着「草稿写了但没发出去」，那是故障，摆在成绩旁边
  // 会让人误读成「差不多成了」。台账本身仍然保留全部状态，那是去重的依据
  // （有过终态 touch 的「账号 × 靶子」永不再发），只是不该当成统计给人看。
  const stats = useMemo(() => {
    const byPlatform = new Map<string, number>();
    let posted = 0;
    let unconfirmed = 0;
    for (const record of records) {
      for (const touch of record.touches) {
        if (touch.state === "unconfirmed") {
          unconfirmed += 1;
          continue;
        }
        if (touch.state !== "posted") continue;
        posted += 1;
        byPlatform.set(
          record.platform,
          (byPlatform.get(record.platform) ?? 0) + 1,
        );
      }
    }
    return { posted, unconfirmed, byPlatform };
  }, [records]);

  const platformsPresent = useMemo(() => {
    const present = new Set(records.map((r) => r.platform));
    return MARINE_PLATFORMS.filter((p) => present.has(p));
  }, [records]);

  // 表格列出确认发布和回执待确认的公开动作；待确认项必须显式标注，不能混进
  // 已发布成绩，也不能隐藏掉它为何仍占着 per-item cap。
  //
  // 台账文件里还有大量 `seen`（每轮从搜索页入账的候选池）—— 那是编排选靶的工作
  // 数据，不是成果：一轮就能入几十条，把整张表淹掉。它们也不携带去重信息，
  // 去重靠的是有终态 touch 的记录（`touched_by`）。
  //
  // 按**发布时间**倒序，不是发现时间：这张表回答的是「我们发了什么」，
  // 而一条上个月发现、今天才发的记录按发现时间排会沉到底下。
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return records
      .map((record) => {
        const publicTouches = record.touches.filter(
          (touch) => touch.state === "posted" || touch.state === "unconfirmed",
        );
        const recordedAt = publicTouches.reduce(
          (newest, touch) => Math.max(newest, touch.at),
          0,
        );
        return { record, publicTouches, recordedAt };
      })
      .filter(({ record, recordedAt }) => {
        if (recordedAt === 0) return false;
        if (platformFilter !== ALL_FILTER && record.platform !== platformFilter)
          return false;
        if (!needle) return true;
        return (
          record.title.toLowerCase().includes(needle) ||
          record.item_id.toLowerCase().includes(needle) ||
          record.keywords.some((k) => k.toLowerCase().includes(needle))
        );
      })
      .sort((a, b) => b.recordedAt - a.recordedAt);
  }, [records, query, platformFilter]);

  const profileNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const profile of profiles) map.set(profile.id, profile.name);
    return map;
  }, [profiles]);

  const hasConfiguredProfiles = profiles.some(profileHasMarineAutomation);

  const canStart =
    !progress.running &&
    !isSubmitting &&
    !isStopping &&
    !isRestartCoolingDown &&
    keyword.trim().length > 0 &&
    hasConfiguredProfiles;

  const handleStart = useCallback(async () => {
    setIsSubmitting(true);
    try {
      await invoke("marine_start_discovery", {
        request: {
          keyword: keyword.trim(),
          // 留空就是只跑一轮 —— 循环是明确开启的东西，不该有默认值。
          cycle_gap_minutes: Number(cycleGap) > 0 ? Number(cycleGap) : null,
        },
      });
    } catch (error) {
      console.error("Failed to start discovery run:", error);
      showToast({
        type: "error",
        title: t("marine.prospects.run.startFailed"),
        description: translateBackendError(t, error),
      });
    } finally {
      setIsSubmitting(false);
    }
  }, [keyword, t, cycleGap]);

  const handleStop = useCallback(async () => {
    if (stopRequestedRef.current) return;
    stopRequestedRef.current = true;
    setIsStopping(true);
    try {
      await invoke("marine_stop_discovery");
    } catch (error) {
      stopRequestedRef.current = false;
      setIsStopping(false);
      console.error("Failed to stop discovery run:", error);
      showToast({
        type: "error",
        title: t("marine.prospects.run.stopFailed"),
        description: translateBackendError(t, error),
      });
      return;
    }

    try {
      // Covers the narrow race where the terminal event landed between the
      // click and listener delivery. The status read uses the same stored
      // progress and is read-only. If this read fails, the bounded poll above
      // remains active; the cancellation request itself still succeeded.
      const current = await invoke<RunProgress>("marine_discovery_status");
      acceptProgress(current);
    } catch (error) {
      console.warn("Failed to read discovery status after Stop:", error);
    }
  }, [acceptProgress, t]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pt-4 pb-8 sm:px-6">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-4">
        <header className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold">
              {t("marine.prospects.title")}
            </h1>
            <p className="mt-1 max-w-3xl text-xs text-muted-foreground">
              {t("marine.prospects.description")}
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-label={t("common.buttons.refresh")}
            disabled={isLoading || isRefreshing}
            onClick={() => {
              void loadRecords(true);
              void loadProfiles();
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
          aria-label={t("marine.prospects.run.label")}
          className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3"
        >
          <div>
            <h2 className="text-sm font-medium">
              {t("marine.prospects.run.title")}
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("marine.prospects.run.description")}
            </p>
          </div>

          <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
            <div className="flex min-w-52 flex-1 flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                {t("marine.prospects.run.keyword")}
              </span>
              <Input
                value={keyword}
                disabled={
                  progress.running || isStopping || isRestartCoolingDown
                }
                placeholder={t("marine.prospects.run.keywordPlaceholder")}
                onChange={(event) => {
                  setKeyword(event.target.value);
                }}
              />
            </div>

            <div className="flex w-full flex-col gap-1.5 lg:w-40">
              <span className="text-xs font-medium text-muted-foreground">
                {t("marine.prospects.run.cycleGap")}
              </span>
              <Input
                value={cycleGap}
                disabled={
                  progress.running || isStopping || isRestartCoolingDown
                }
                inputMode="numeric"
                placeholder={t("marine.prospects.run.cycleGapPlaceholder")}
                onChange={(event) => {
                  // 只留数字：这个值直接决定自动化的重复节奏，
                  // 让一个笔误变成「每 0 分钟跑一次」不值得。
                  setCycleGap(event.target.value.replace(/[^0-9]/g, ""));
                }}
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {progress.running || isStopping || isRestartCoolingDown ? (
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={isStopping || isRestartCoolingDown}
                onClick={() => {
                  void handleStop();
                }}
              >
                {isStopping || isRestartCoolingDown ? (
                  <LuLoaderCircle className="animate-spin" />
                ) : (
                  <LuCircleStop />
                )}
                {t("marine.prospects.run.stop")}
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                disabled={!canStart}
                onClick={() => {
                  void handleStart();
                }}
              >
                {isSubmitting ? (
                  <LuLoaderCircle className="animate-spin" />
                ) : (
                  <LuCirclePlay />
                )}
                {t("marine.prospects.run.start")}
              </Button>
            )}
            <p className="text-xs text-muted-foreground">
              {progress.running || progress.phase !== "idle"
                ? t("marine.prospects.run.progress", {
                    done: progress.leg_index,
                    total: progress.total_legs,
                    phase: t(`marine.prospects.phase.${progress.phase}`),
                    target:
                      progress.current_profile_name && progress.current_platform
                        ? `${progress.current_profile_name} · ${t(`marine.prospects.platform.${progress.current_platform}`)}`
                        : "—",
                  })
                : hasConfiguredProfiles
                  ? t("marine.prospects.run.hint")
                  : t("marine.prospects.run.noProfiles")}
            </p>
          </div>

          {progress.finished.length > 0 && (
            <ul className="flex flex-col gap-1 border-t border-border pt-2">
              {progress.finished.map((leg, index) => (
                <li
                  key={`${leg.profile_id}-${leg.platform}-${index}`}
                  className="flex flex-wrap items-center gap-2 text-xs"
                >
                  <span className="text-muted-foreground">
                    {leg.profile_name} ·{" "}
                    {t(`marine.prospects.platform.${leg.platform}`)}
                  </span>
                  <span className={OUTCOME_CLASS[leg.outcome]}>
                    {t(`marine.prospects.outcome.${leg.outcome}`)}
                  </span>
                  {leg.settled_count > 0 && (
                    <span className="text-muted-foreground tabular-nums">
                      {/* `n`, not `count` — `count` triggers i18next's plural
                          resolution, which needs `_one`/`_other` variants in
                          every locale and silently misses without them. */}
                      {t("marine.prospects.run.settledCount", {
                        n: leg.settled_count,
                      })}
                    </span>
                  )}
                  {leg.error && (
                    <span
                      className="basis-full cursor-help text-[11px] text-destructive underline decoration-dotted underline-offset-2"
                      title={leg.error}
                    >
                      {t("marine.prospects.run.errorDetail")}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}

          {/* 排查入口。两个日志缺一不可，而且有用的那个不在「日志目录」里：
              应用日志是调度器的视角（哪个 profile、哪条腿、为什么关了浏览器），
              扩展日志是页内视角（选择器为什么没命中、草稿核对比了什么）。
              后者落在数据目录下，不写出来没人找得到。 */}
          {logs && (
            <div className="flex flex-col gap-1.5 border-t border-border pt-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[10px] tracking-wide text-muted-foreground uppercase">
                  {t("marine.prospects.run.logs.label")}
                </p>
                <div className="flex items-center gap-1">
                  {/* 跨设备去重靠这个：导出本机分片，拷到另一台的
                      prospects/remote/ 下，那台机器就不会再把本机已经用掉的
                      话题发出去。同步层自动搬运之前，这是唯一的路径。 */}
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-xs"
                    onClick={() => {
                      void invoke<string>("marine_export_ledger_shard")
                        .then((path) => {
                          showToast({
                            type: "success",
                            title: t("marine.prospects.run.logs.exported"),
                            description: path,
                          });
                        })
                        .catch((error) => {
                          showToast({
                            type: "error",
                            title: translateBackendError(t, error),
                          });
                        });
                    }}
                  >
                    {t("marine.prospects.run.logs.exportShard")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-xs"
                    onClick={() => {
                      void invoke("open_log_directory").catch(() => {});
                    }}
                  >
                    {t("marine.prospects.run.logs.open")}
                  </Button>
                </div>
              </div>
              {[
                {
                  key: "app",
                  hint: t("marine.prospects.run.logs.appHint"),
                  path: logs.app_log_file,
                },
                {
                  key: "extension",
                  hint: t("marine.prospects.run.logs.extensionHint"),
                  path: logs.extension_log_file,
                },
              ].map((entry) => (
                <div key={entry.key} className="flex flex-col gap-0.5">
                  <span className="text-[11px] text-muted-foreground">
                    {entry.hint}
                  </span>
                  {/* 可选中复制：排查时多半是要把路径贴进终端。 */}
                  <code className="rounded bg-muted px-1.5 py-1 font-mono text-[10px] break-all select-all">
                    {entry.path}
                  </code>
                </div>
              ))}
            </div>
          )}
        </section>

        <section
          aria-label={t("marine.prospects.stats.label")}
          className="grid grid-cols-2 gap-2 sm:grid-cols-6"
        >
          <div className="rounded-lg border border-border bg-card px-3 py-2.5">
            <p className="text-[10px] tracking-wide text-muted-foreground uppercase">
              {t("marine.prospects.stats.posted")}
            </p>
            <p className="mt-1 text-xl font-semibold tabular-nums">
              {stats.posted}
            </p>
          </div>
          <div className="rounded-lg border border-warning/40 bg-card px-3 py-2.5">
            <p className="text-[10px] tracking-wide text-warning uppercase">
              {t("marine.prospects.stats.unconfirmed")}
            </p>
            <p className="mt-1 text-xl font-semibold tabular-nums">
              {stats.unconfirmed}
            </p>
          </div>
          {MARINE_PLATFORMS.map((platform) => (
            <div
              key={platform}
              className="rounded-lg border border-border bg-card px-3 py-2.5"
            >
              <p className="text-[10px] tracking-wide text-muted-foreground uppercase">
                {t(`marine.prospects.platform.${platform}`)}
              </p>
              <p className="mt-1 text-xl font-semibold tabular-nums">
                {stats.byPlatform.get(platform) ?? 0}
              </p>
            </div>
          ))}
        </section>

        <section
          aria-label={t("marine.prospects.filters.label")}
          className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3 lg:flex-row"
        >
          <div className="relative min-w-52 flex-1">
            <LuSearch className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              className="pl-8"
              placeholder={t("marine.prospects.filters.searchPlaceholder")}
              onChange={(event) => {
                setQuery(event.target.value);
              }}
            />
          </div>
          <Select value={platformFilter} onValueChange={setPlatformFilter}>
            <SelectTrigger className="lg:w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_FILTER}>
                {t("marine.prospects.filters.allPlatforms")}
              </SelectItem>
              {platformsPresent.map((platform) => (
                <SelectItem key={platform} value={platform}>
                  {t(`marine.prospects.platform.${platform}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </section>

        {loadError && (
          <Alert variant="destructive">
            <LuTriangleAlert />
            <AlertTitle>{t("marine.prospects.error.title")}</AlertTitle>
            <AlertDescription>
              {t("marine.prospects.error.description")}
            </AlertDescription>
          </Alert>
        )}

        {isLoading ? (
          <div className="flex items-center justify-center gap-2 rounded-lg border border-border bg-card py-12 text-sm text-muted-foreground">
            <LuLoaderCircle className="size-4 animate-spin" />
            {t("marine.prospects.loading")}
          </div>
        ) : visible.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-border bg-card py-12 text-center">
            <LuInbox className="size-6 text-muted-foreground" />
            <p className="text-sm font-medium">
              {t("marine.prospects.empty.title")}
            </p>
            <p className="max-w-md text-xs text-muted-foreground">
              {t("marine.prospects.empty.description")}
            </p>
          </div>
        ) : (
          <Table containerClassName="rounded-lg border border-border">
            <TableHeader>
              <TableRow>
                <TableHead>{t("marine.prospects.table.platform")}</TableHead>
                <TableHead>{t("marine.prospects.table.title")}</TableHead>
                <TableHead>{t("marine.prospects.table.keywords")}</TableHead>
                <TableHead>{t("marine.prospects.table.accounts")}</TableHead>
                <TableHead>{t("marine.prospects.table.postedAt")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map(({ record, publicTouches, recordedAt }) => (
                <TableRow key={record.key}>
                  <TableCell className="text-xs whitespace-nowrap">
                    {t(`marine.prospects.platform.${record.platform}`)}
                  </TableCell>
                  <TableCell className="max-w-md">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-xs">
                        {record.title.trim() || t("marine.prospects.untitled")}
                      </span>
                      {isHttpUrl(record.open_url) && (
                        <button
                          type="button"
                          aria-label={t("marine.prospects.table.open")}
                          className="shrink-0 cursor-pointer text-muted-foreground hover:text-foreground"
                          onClick={() => {
                            void openUrl(record.open_url);
                          }}
                        >
                          <LuExternalLink className="size-3.5" />
                        </button>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {record.keywords.join(" / ") || "—"}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {/* 失败/填入过的账号没有公开足迹；回执待确认的账号则必须可见，
                        并明确区别于已经确认发布。 */}
                    {publicTouches
                      .map((touch) => {
                        const name =
                          profileNameById.get(touch.profile_id) ??
                          touch.profile_id;
                        return touch.state === "unconfirmed"
                          ? `${name} · ${t("marine.prospects.stats.unconfirmed")}`
                          : name;
                      })
                      .join(" / ") || "—"}
                  </TableCell>
                  <TableCell className="text-xs whitespace-nowrap text-muted-foreground">
                    {dateFormatter.format(recordedAt * 1000)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
