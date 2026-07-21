"use client";

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
  LuBookOpenText,
  LuBot,
  LuCloud,
  LuCloudOff,
  LuEye,
  LuFileText,
  LuLoaderCircle,
  LuPlus,
  LuRefreshCw,
  LuSave,
  LuSearch,
  LuSparkles,
  LuTrash2,
  LuUsers,
} from "react-icons/lu";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import { LoadingButton } from "@/components/loading-button";
import { AnimatedSwitch } from "@/components/ui/animated-switch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { showErrorToast, showSuccessToast } from "@/lib/toast-utils";
import { cn } from "@/lib/utils";
import type {
  BrandExample,
  BrandExampleKind,
  BrandPreview,
  BrandPreviewContext,
  BrandProfile,
  BrandTone,
  BrowserProfile,
} from "@/types";

const PLATFORM_VALUES = ["bilibili", "xiaohongshu", "zhihu", "douyin"];
const EXAMPLE_PLATFORM_VALUES = ["all", ...PLATFORM_VALUES];
const EMOJI_VALUES = ["none", "light", "moderate", "rich"];
const LENGTH_VALUES = ["short", "medium", "long"];
const LANGUAGE_VALUES = ["zh-CN", "en", "ja", "ko"];

function cloneBrand(brand: BrandProfile): BrandProfile {
  return {
    ...brand,
    platforms: [...brand.platforms],
    doRules: [...brand.doRules],
    dontRules: [...brand.dontRules],
    tone: { ...brand.tone },
    examples: brand.examples.map((example) => ({
      ...example,
      keywords: [...example.keywords],
    })),
  };
}

function serializedBrand(brand: BrandProfile | null): string {
  return brand ? JSON.stringify(brand) : "";
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function isRevisionConflict(error: unknown): boolean {
  const normalized = errorText(error).toLocaleLowerCase();
  return ["conflict", "revision", "stale", "409"].some((token) =>
    normalized.includes(token),
  );
}

function isBrandInUseError(error: unknown): boolean {
  const normalized = errorText(error).toLocaleUpperCase();
  return normalized.includes("MARINE_BRAND_IN_USE");
}

function inputToLines(value: string): string[] {
  return value.split(/\r?\n/);
}

function normalizeLines(value: string[]): string[] {
  return value.map((line) => line.trim()).filter(Boolean);
}

function normalizeBrandForTransfer(brand: BrandProfile): BrandProfile {
  return {
    ...cloneBrand(brand),
    doRules: normalizeLines(brand.doRules),
    dontRules: normalizeLines(brand.dontRules),
    examples: brand.examples.map((example) => ({
      ...example,
      keywords: normalizeLines(example.keywords),
    })),
  };
}

function makeExample(): BrandExample {
  return {
    id: globalThis.crypto.randomUUID(),
    title: "",
    text: "",
    keywords: [],
    platform: "all",
    kind: "both",
    enabled: true,
  };
}

function formatTimestamp(value: number | undefined, locale: string): string {
  if (!value) return "";
  const timestamp = value >= 1_000_000_000_000 ? value : value * 1000;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}

function EditorSection({
  icon,
  title,
  description,
  children,
}: {
  icon: ReactNode;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="mb-4 flex items-start gap-2.5">
        <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
          {icon}
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          {description ? (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
      </div>
      {children}
    </section>
  );
}

function TextField({
  id,
  label,
  value,
  onChange,
  placeholder,
  multiline = false,
  rows = 3,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  multiline?: boolean;
  rows?: number;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      {multiline ? (
        <Textarea
          id={id}
          value={value}
          rows={rows}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          className="resize-y text-xs leading-5"
        />
      ) : (
        <Input
          id={id}
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          className="h-8 text-xs"
        />
      )}
    </div>
  );
}

function ToneSlider({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id} className="text-xs">
          {label}
        </Label>
        <span className="min-w-6 rounded bg-muted px-1.5 py-0.5 text-center text-[11px] font-medium tabular-nums">
          {value}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={0}
        max={100}
        step={5}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-5 w-full cursor-pointer accent-primary"
      />
    </div>
  );
}

function ensureOption(values: string[], current: string): string[] {
  return current && !values.includes(current) ? [current, ...values] : values;
}

function BrandExampleCard({
  example,
  index,
  onChange,
  onDelete,
}: {
  example: BrandExample;
  index: number;
  onChange: (example: BrandExample) => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const platformId = `example-platform-${example.id}`;
  const kindId = `example-kind-${example.id}`;
  const update = <K extends keyof BrandExample>(
    key: K,
    value: BrandExample[K],
  ) => onChange({ ...example, [key]: value });

  return (
    <article
      className={cn(
        "rounded-lg border border-border bg-background p-3 transition-opacity",
        !example.enabled && "opacity-60",
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="grid size-6 shrink-0 place-items-center rounded bg-muted text-[11px] font-semibold tabular-nums">
            {index + 1}
          </span>
          <p className="truncate text-xs font-medium">
            {example.title.trim() || t("marine.brandStudio.examples.untitled")}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div className="flex items-center gap-1.5">
            <Label
              htmlFor={`example-enabled-${example.id}`}
              className="text-[11px] text-muted-foreground"
            >
              {t("marine.brandStudio.examples.enabled")}
            </Label>
            <AnimatedSwitch
              id={`example-enabled-${example.id}`}
              checked={example.enabled}
              onCheckedChange={(checked) => update("enabled", checked)}
            />
          </div>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label={t("marine.brandStudio.examples.delete")}
            onClick={onDelete}
            className="text-muted-foreground hover:text-destructive"
          >
            <LuTrash2 />
          </Button>
        </div>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <TextField
          id={`example-title-${example.id}`}
          label={t("marine.brandStudio.examples.title")}
          value={example.title}
          placeholder={t("marine.brandStudio.examples.titlePlaceholder")}
          onChange={(value) => update("title", value)}
        />
        <TextField
          id={`example-keywords-${example.id}`}
          label={t("marine.brandStudio.examples.keywords")}
          value={example.keywords.join(", ")}
          placeholder={t("marine.brandStudio.examples.keywordsPlaceholder")}
          onChange={(value) =>
            update(
              "keywords",
              value.split(/[,，]/).map((keyword) => keyword.trim()),
            )
          }
        />
        <div className="space-y-1.5">
          <Label htmlFor={platformId} className="text-xs">
            {t("marine.brandStudio.examples.platform")}
          </Label>
          <Select
            value={example.platform}
            onValueChange={(value) => update("platform", value)}
          >
            <SelectTrigger id={platformId} size="sm" className="w-full text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ensureOption(EXAMPLE_PLATFORM_VALUES, example.platform).map(
                (platform) => (
                  <SelectItem key={platform} value={platform}>
                    {EXAMPLE_PLATFORM_VALUES.includes(platform)
                      ? t(`marine.brandStudio.platforms.${platform}`)
                      : platform}
                  </SelectItem>
                ),
              )}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={kindId} className="text-xs">
            {t("marine.brandStudio.examples.kind")}
          </Label>
          <Select
            value={example.kind}
            onValueChange={(value) => update("kind", value as BrandExampleKind)}
          >
            <SelectTrigger id={kindId} size="sm" className="w-full text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(["both", "direct", "reply"] as BrandExampleKind[]).map(
                (kind) => (
                  <SelectItem key={kind} value={kind}>
                    {t(`marine.brandStudio.kinds.${kind}`)}
                  </SelectItem>
                ),
              )}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="mt-3">
        <TextField
          id={`example-text-${example.id}`}
          label={t("marine.brandStudio.examples.text")}
          value={example.text}
          placeholder={t("marine.brandStudio.examples.textPlaceholder")}
          multiline
          rows={4}
          onChange={(value) => update("text", value)}
        />
      </div>
    </article>
  );
}

function PreviewPanel({
  context,
  onContextChange,
  preview,
  examples,
  isLoading,
  error,
  isBrandDirty,
}: {
  context: BrandPreviewContext;
  onContextChange: (context: BrandPreviewContext) => void;
  preview: BrandPreview | null;
  examples: BrandExample[];
  isLoading: boolean;
  error: boolean;
  isBrandDirty: boolean;
}) {
  const { t } = useTranslation();
  const platformId = "brand-preview-platform";
  const modeId = "brand-preview-mode";
  const selectedExamples = useMemo(() => {
    const selectedIds = new Set(preview?.selectedExampleIds ?? []);
    return examples.filter((example) => selectedIds.has(example.id));
  }, [examples, preview?.selectedExampleIds]);
  const update = <K extends keyof BrandPreviewContext>(
    key: K,
    value: BrandPreviewContext[K],
  ) => onContextChange({ ...context, [key]: value });

  return (
    <aside className="flex min-h-0 flex-col rounded-lg border border-border bg-card xl:sticky xl:top-0 xl:max-h-[calc(100vh-9.5rem)]">
      <div className="border-b border-border p-4">
        <div className="flex items-start gap-2.5">
          <span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
            <LuEye className="size-3.5" />
          </span>
          <div>
            <h2 className="text-sm font-semibold">
              {t("marine.brandStudio.preview.title")}
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t("marine.brandStudio.preview.description")}
            </p>
          </div>
        </div>
        {isBrandDirty ? (
          <p className="mt-3 rounded-md border border-warning/30 bg-warning/10 px-2.5 py-2 text-[11px] text-warning">
            {t("marine.brandStudio.preview.saveFirst")}
          </p>
        ) : null}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 p-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
            <div className="space-y-1.5">
              <Label htmlFor={platformId} className="text-xs">
                {t("marine.brandStudio.preview.platform")}
              </Label>
              <Select
                value={context.platform}
                onValueChange={(value) => update("platform", value)}
              >
                <SelectTrigger
                  id={platformId}
                  size="sm"
                  className="w-full text-xs"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ensureOption(PLATFORM_VALUES, context.platform).map(
                    (platform) => (
                      <SelectItem key={platform} value={platform}>
                        {PLATFORM_VALUES.includes(platform)
                          ? t(`marine.brandStudio.platforms.${platform}`)
                          : platform}
                      </SelectItem>
                    ),
                  )}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={modeId} className="text-xs">
                {t("marine.brandStudio.preview.mode")}
              </Label>
              <Select
                value={context.mode}
                onValueChange={(value) =>
                  update("mode", value as BrandPreviewContext["mode"])
                }
              >
                <SelectTrigger id={modeId} size="sm" className="w-full text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="direct">
                    {t("marine.brandStudio.kinds.direct")}
                  </SelectItem>
                  <SelectItem value="reply">
                    {t("marine.brandStudio.kinds.reply")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <TextField
            id="brand-preview-title"
            label={t("marine.brandStudio.preview.pageTitle")}
            value={context.title}
            placeholder={t("marine.brandStudio.preview.pageTitlePlaceholder")}
            onChange={(value) => update("title", value)}
          />
          <TextField
            id="brand-preview-target"
            label={t("marine.brandStudio.preview.targetSummary")}
            value={context.targetSummary}
            placeholder={t(
              "marine.brandStudio.preview.targetSummaryPlaceholder",
            )}
            multiline
            rows={3}
            onChange={(value) => update("targetSummary", value)}
          />
          <TextField
            id="brand-preview-source"
            label={t("marine.brandStudio.preview.sourceText")}
            value={context.sourceText}
            placeholder={t("marine.brandStudio.preview.sourceTextPlaceholder")}
            multiline
            rows={5}
            onChange={(value) => update("sourceText", value)}
          />

          <div className="border-t border-border pt-4">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="text-xs font-semibold">
                {t("marine.brandStudio.preview.selectedExamples")}
              </h3>
              {preview ? (
                <Badge variant="outline" className="text-[10px]">
                  {t("marine.brandStudio.revision", {
                    revision: preview.revision,
                  })}
                </Badge>
              ) : null}
            </div>
            {isLoading ? (
              <div className="flex items-center gap-2 rounded-md bg-muted/50 px-3 py-4 text-xs text-muted-foreground">
                <LuLoaderCircle className="size-3.5 animate-spin" />
                {t("marine.brandStudio.preview.loading")}
              </div>
            ) : error ? (
              <p className="rounded-md bg-destructive/10 px-3 py-3 text-xs text-destructive">
                {t("marine.brandStudio.preview.failed")}
              </p>
            ) : !preview ? (
              <p className="rounded-md bg-muted/50 px-3 py-4 text-xs text-muted-foreground">
                {t("marine.brandStudio.preview.empty")}
              </p>
            ) : selectedExamples.length === 0 ? (
              <p className="rounded-md bg-muted/50 px-3 py-3 text-xs text-muted-foreground">
                {t("marine.brandStudio.preview.noExamples")}
              </p>
            ) : (
              <div className="space-y-2">
                {selectedExamples.map((example) => (
                  <div
                    key={example.id}
                    className="rounded-md border border-border bg-background p-2.5"
                  >
                    <p className="text-xs font-medium">{example.title}</p>
                    <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-[11px] leading-4 text-muted-foreground">
                      {example.text}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>

          {preview?.skill ? (
            <div>
              <h3 className="mb-2 text-xs font-semibold">
                {t("marine.brandStudio.preview.skill")}
              </h3>
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/40 p-3 font-mono text-[10px] leading-4 text-foreground">
                {preview.skill}
              </pre>
            </div>
          ) : null}
        </div>
      </ScrollArea>
    </aside>
  );
}

export function MarineBrandStudio({
  onDirtyChange,
}: {
  onDirtyChange?: (isDirty: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const [brands, setBrands] = useState<BrandProfile[]>([]);
  const [profiles, setProfiles] = useState<BrowserProfile[]>([]);
  const [selectedBrandId, setSelectedBrandId] = useState<string | null>(null);
  const [draft, setDraft] = useState<BrandProfile | null>(null);
  const [baseline, setBaseline] = useState<BrandProfile | null>(null);
  const [query, setQuery] = useState("");
  const [newBrandName, setNewBrandName] = useState("");
  const [profileQuery, setProfileQuery] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<BrandProfile | null>(null);
  const [bindingProfileIds, setBindingProfileIds] = useState<Set<string>>(
    new Set(),
  );
  const [previewContext, setPreviewContext] = useState<BrandPreviewContext>({
    platform: "zhihu",
    title: "",
    targetSummary: "",
    mode: "direct",
    sourceText: "",
  });
  const [preview, setPreview] = useState<BrandPreview | null>(null);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [previewFailed, setPreviewFailed] = useState(false);
  const previewSequenceRef = useRef(0);
  const loadSequenceRef = useRef(0);
  const profileLoadSequenceRef = useRef(0);
  const didInitialLoadRef = useRef(false);
  const isCreatingRef = useRef(false);
  const selectedBrandIdRef = useRef<string | null>(null);
  const draftRef = useRef<BrandProfile | null>(null);
  const baselineRef = useRef<BrandProfile | null>(null);

  const isDirty =
    draft !== null && serializedBrand(draft) !== serializedBrand(baseline);

  const applySelectedBrand = useCallback((brand: BrandProfile | null) => {
    selectedBrandIdRef.current = brand?.id ?? null;
    draftRef.current = brand ? cloneBrand(brand) : null;
    baselineRef.current = brand ? cloneBrand(brand) : null;
    setSelectedBrandId(brand?.id ?? null);
    setDraft(draftRef.current);
    setBaseline(baselineRef.current);
    setPreview(null);
    setPreviewFailed(false);
  }, []);

  const loadData = useCallback(
    async (preferredBrandId?: string, preserveDirty = false) => {
      const sequence = ++loadSequenceRef.current;
      const profileSequence = ++profileLoadSequenceRef.current;
      const selectedAtStart = selectedBrandIdRef.current;
      const draftAtStart = serializedBrand(draftRef.current);
      setIsLoading(true);
      try {
        const [nextBrands, nextProfiles] = await Promise.all([
          invoke<BrandProfile[]>("marine_list_brands"),
          invoke<BrowserProfile[]>("list_browser_profiles"),
        ]);
        if (sequence !== loadSequenceRef.current) return;
        const sortedBrands = [...nextBrands].sort((left, right) =>
          left.name.localeCompare(
            right.name,
            i18n.resolvedLanguage ?? i18n.language,
          ),
        );
        setBrands(sortedBrands);
        if (profileSequence === profileLoadSequenceRef.current) {
          setProfiles(nextProfiles);
        }
        setLoadFailed(false);

        const selectionChanged =
          selectedBrandIdRef.current !== selectedAtStart ||
          serializedBrand(draftRef.current) !== draftAtStart;
        const currentIsDirty =
          serializedBrand(draftRef.current) !==
          serializedBrand(baselineRef.current);
        if (selectionChanged || (preserveDirty && currentIsDirty)) return;

        const requestedId = preferredBrandId ?? selectedBrandIdRef.current;
        const nextSelected =
          sortedBrands.find((brand) => brand.id === requestedId) ??
          sortedBrands[0] ??
          null;
        applySelectedBrand(nextSelected);
      } catch (error) {
        if (sequence !== loadSequenceRef.current) return;
        console.error("Failed to load Marine brands:", error);
        setLoadFailed(true);
        showErrorToast(t("marine.brandStudio.toasts.loadFailed"));
      } finally {
        if (sequence === loadSequenceRef.current) {
          setIsLoading(false);
        }
      }
    },
    [applySelectedBrand, i18n.language, i18n.resolvedLanguage, t],
  );

  useEffect(() => {
    if (didInitialLoadRef.current) return;
    didInitialLoadRef.current = true;
    void loadData();
  }, [loadData]);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    baselineRef.current = baseline;
  }, [baseline]);

  useEffect(() => {
    selectedBrandIdRef.current = selectedBrandId;
  }, [selectedBrandId]);

  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  useEffect(
    () => () => {
      onDirtyChange?.(false);
    },
    [onDirtyChange],
  );

  useEffect(() => {
    if (!isDirty) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [isDirty]);

  useEffect(() => {
    let disposed = false;
    let unlistenProfiles: (() => void) | undefined;
    let unlistenBrands: (() => void) | undefined;

    const setupListeners = async () => {
      try {
        const stopProfiles = await listen("profiles-changed", () => {
          const sequence = ++profileLoadSequenceRef.current;
          void invoke<BrowserProfile[]>("list_browser_profiles")
            .then((nextProfiles) => {
              if (!disposed && sequence === profileLoadSequenceRef.current) {
                setProfiles(nextProfiles);
              }
            })
            .catch((error) => {
              console.error("Failed to refresh Marine profiles:", error);
            });
        });
        if (disposed) {
          stopProfiles();
          return;
        }
        unlistenProfiles = stopProfiles;

        const stopBrands = await listen("marine-brands-changed", () => {
          void loadData(selectedBrandIdRef.current ?? undefined, true);
        });
        if (disposed) {
          stopBrands();
          return;
        }
        unlistenBrands = stopBrands;
      } catch (error) {
        console.error("Failed to listen for Marine data changes:", error);
      }
    };

    void setupListeners();

    return () => {
      disposed = true;
      unlistenProfiles?.();
      unlistenBrands?.();
    };
  }, [loadData]);

  useEffect(() => {
    const sequence = ++previewSequenceRef.current;
    if (!draft) {
      setPreview(null);
      setIsPreviewLoading(false);
      setPreviewFailed(false);
      return;
    }

    const timer = window.setTimeout(() => {
      setIsPreviewLoading(true);
      setPreviewFailed(false);
      void invoke<BrandPreview>("marine_preview_brand", {
        brand: normalizeBrandForTransfer(draft),
        context: previewContext,
      })
        .then((nextPreview) => {
          if (sequence !== previewSequenceRef.current) return;
          setPreview(nextPreview);
        })
        .catch((error) => {
          if (sequence !== previewSequenceRef.current) return;
          console.error("Failed to preview Marine brand:", error);
          setPreview(null);
          setPreviewFailed(true);
        })
        .finally(() => {
          if (sequence === previewSequenceRef.current) {
            setIsPreviewLoading(false);
          }
        });
    }, 450);

    return () => window.clearTimeout(timer);
  }, [draft, previewContext]);

  const filteredBrands = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return brands;
    return brands.filter((brand) =>
      [brand.name, brand.displayName, brand.positioning]
        .filter(Boolean)
        .some((value) => value.toLocaleLowerCase().includes(normalized)),
    );
  }, [brands, query]);

  const filteredProfiles = useMemo(() => {
    const normalized = profileQuery.trim().toLocaleLowerCase();
    if (!normalized) return profiles;
    return profiles.filter((profile) =>
      [profile.name, profile.note, ...(profile.tags ?? [])]
        .filter(Boolean)
        .some((value) =>
          String(value).toLocaleLowerCase().includes(normalized),
        ),
    );
  }, [profileQuery, profiles]);

  const profileCountByBrand = useMemo(() => {
    const counts = new Map<string, number>();
    for (const profile of profiles) {
      if (!profile.brand_id) continue;
      counts.set(profile.brand_id, (counts.get(profile.brand_id) ?? 0) + 1);
    }
    return counts;
  }, [profiles]);

  const chooseBrand = (brand: BrandProfile) => {
    if (
      brand.id === selectedBrandId ||
      isCreatingRef.current ||
      isSaving ||
      isDeleting
    ) {
      return;
    }
    if (isDirty && !window.confirm(t("marine.brandStudio.discardChanges"))) {
      return;
    }
    applySelectedBrand(brand);
  };

  const handleCreate = async () => {
    if (isCreatingRef.current || isSaving || isDeleting) return;
    const name = newBrandName.trim();
    if (!name) return;
    if (isDirty && !window.confirm(t("marine.brandStudio.discardChanges"))) {
      return;
    }

    const selectedAtStart = selectedBrandIdRef.current;
    const draftAtStart = serializedBrand(draftRef.current);
    isCreatingRef.current = true;
    setIsCreating(true);
    try {
      const created = await invoke<BrandProfile>("marine_create_brand", {
        name,
      });
      setNewBrandName((current) => (current.trim() === name ? "" : current));
      showSuccessToast(t("marine.brandStudio.toasts.created"));
      if (created?.id) {
        setBrands((current) =>
          [...current.filter((brand) => brand.id !== created.id), created].sort(
            (left, right) =>
              left.name.localeCompare(right.name, i18n.resolvedLanguage),
          ),
        );
        if (
          selectedBrandIdRef.current === selectedAtStart &&
          serializedBrand(draftRef.current) === draftAtStart
        ) {
          applySelectedBrand(created);
        }
      } else {
        await loadData(selectedBrandIdRef.current ?? undefined, true);
      }
    } catch (error) {
      console.error("Failed to create Marine brand:", error);
      showErrorToast(t("marine.brandStudio.toasts.createFailed"));
    } finally {
      isCreatingRef.current = false;
      setIsCreating(false);
    }
  };

  const handleSave = async () => {
    if (isCreatingRef.current || !draft || !baseline || !isDirty) return;
    const submitted = normalizeBrandForTransfer(draft);
    const submittedFingerprint = serializedBrand(submitted);
    const submittedId = submitted.id;
    const expectedRevision = baseline.revision;
    setIsSaving(true);
    try {
      const saved = await invoke<BrandProfile>("marine_save_brand", {
        brand: submitted,
        expectedRevision,
      });
      showSuccessToast(t("marine.brandStudio.toasts.saved"));
      if (saved?.id) {
        setBrands((current) =>
          current
            .map((brand) => (brand.id === saved.id ? saved : brand))
            .sort((left, right) =>
              left.name.localeCompare(right.name, i18n.resolvedLanguage),
            ),
        );

        const currentDraft = draftRef.current;
        if (
          selectedBrandIdRef.current === submittedId &&
          currentDraft?.id === submittedId
        ) {
          const savedBaseline = cloneBrand(saved);
          baselineRef.current = savedBaseline;
          setBaseline(savedBaseline);

          if (
            serializedBrand(normalizeBrandForTransfer(currentDraft)) ===
            submittedFingerprint
          ) {
            const savedDraft = cloneBrand(saved);
            draftRef.current = savedDraft;
            setDraft(savedDraft);
          } else {
            const rebasedDraft: BrandProfile = {
              ...currentDraft,
              revision: saved.revision,
              updatedAt: saved.updatedAt,
              builtIn: saved.builtIn,
              syncEnabled: saved.syncEnabled,
              lastSync: saved.lastSync,
            };
            draftRef.current = rebasedDraft;
            setDraft(rebasedDraft);
          }
        }
      } else if (
        selectedBrandIdRef.current === submittedId &&
        serializedBrand(
          normalizeBrandForTransfer(draftRef.current ?? submitted),
        ) === submittedFingerprint
      ) {
        await loadData(submittedId);
      }
    } catch (error) {
      console.error("Failed to save Marine brand:", error);
      if (isRevisionConflict(error)) {
        showErrorToast(t("marine.brandStudio.toasts.conflict"), {
          description: t("marine.brandStudio.toasts.conflictDescription"),
        });
      } else {
        showErrorToast(t("marine.brandStudio.toasts.saveFailed"));
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    const target = cloneBrand(deleteTarget);
    setIsDeleting(true);
    try {
      await invoke("marine_delete_brand", {
        brandId: target.id,
        expectedRevision: target.revision,
      });
      const remaining = brands.filter((brand) => brand.id !== target.id);
      setBrands(remaining);
      if (selectedBrandIdRef.current === target.id) {
        applySelectedBrand(remaining[0] ?? null);
      }
      setDeleteTarget(null);
      showSuccessToast(t("marine.brandStudio.toasts.deleted"));
    } catch (error) {
      console.error("Failed to delete Marine brand:", error);
      if (isRevisionConflict(error)) {
        showErrorToast(t("marine.brandStudio.toasts.conflict"), {
          description: t("marine.brandStudio.toasts.conflictDescription"),
        });
      } else if (isBrandInUseError(error)) {
        showErrorToast(t("marine.brandStudio.toasts.brandInUse"));
      } else {
        showErrorToast(t("marine.brandStudio.toasts.deleteFailed"));
      }
    } finally {
      setIsDeleting(false);
    }
  };

  const handleProfileBinding = async (
    profile: BrowserProfile,
    checked: boolean,
  ) => {
    if (!draft || bindingProfileIds.has(profile.id)) return;
    const previousBrandId = profile.brand_id;
    const nextBrandId = checked ? draft.id : null;
    const previousBrand = previousBrandId
      ? brands.find((brand) => brand.id === previousBrandId)
      : undefined;
    if (
      checked &&
      previousBrandId &&
      previousBrandId !== draft.id &&
      !window.confirm(
        t("marine.brandStudio.bindings.confirmReassign", {
          profile: profile.name,
          brand: previousBrand?.name ?? previousBrandId,
        }),
      )
    ) {
      return;
    }
    ++profileLoadSequenceRef.current;
    setBindingProfileIds((current) => new Set(current).add(profile.id));
    setProfiles((current) =>
      current.map((item) =>
        item.id === profile.id
          ? { ...item, brand_id: nextBrandId ?? undefined }
          : item,
      ),
    );

    try {
      await invoke("marine_bind_profile_brand", {
        profileId: profile.id,
        brandId: nextBrandId,
      });
      showSuccessToast(t("marine.brandStudio.toasts.bindingSaved"), {
        id: `marine-brand-binding-${profile.id}`,
      });
    } catch (error) {
      console.error("Failed to bind Marine brand:", error);
      setProfiles((current) =>
        current.map((item) =>
          item.id === profile.id
            ? { ...item, brand_id: previousBrandId }
            : item,
        ),
      );
      showErrorToast(t("marine.brandStudio.toasts.bindingFailed"), {
        id: `marine-brand-binding-${profile.id}`,
      });
    } finally {
      setBindingProfileIds((current) => {
        const next = new Set(current);
        next.delete(profile.id);
        return next;
      });
    }
  };

  const updateDraft = <K extends keyof BrandProfile>(
    key: K,
    value: BrandProfile[K],
  ) => {
    setDraft((current) => {
      const next = current ? { ...current, [key]: value } : current;
      draftRef.current = next;
      return next;
    });
  };

  const updateTone = <K extends keyof BrandTone>(
    key: K,
    value: BrandTone[K],
  ) => {
    setDraft((current) => {
      const next = current
        ? { ...current, tone: { ...current.tone, [key]: value } }
        : current;
      draftRef.current = next;
      return next;
    });
  };

  const updateExample = (id: string, example: BrandExample) => {
    if (!draft) return;
    updateDraft(
      "examples",
      draft.examples.map((item) => (item.id === id ? example : item)),
    );
  };

  const deleteBlockedReason = draft?.builtIn
    ? t("marine.brandStudio.delete.builtIn")
    : draft && (profileCountByBrand.get(draft.id) ?? 0) > 0
      ? t("marine.brandStudio.delete.inUse")
      : null;

  if (isLoading && brands.length === 0) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center p-6">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <LuLoaderCircle className="size-4 animate-spin" />
          {t("marine.brandStudio.loading")}
        </div>
      </div>
    );
  }

  if (loadFailed && brands.length === 0) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center p-6">
        <div className="max-w-sm rounded-lg border border-destructive/30 bg-destructive/10 p-5 text-center">
          <p className="text-sm font-semibold text-destructive">
            {t("marine.brandStudio.loadFailed")}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("marine.brandStudio.loadFailedDescription")}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-4"
            onClick={() => void loadData()}
          >
            <LuRefreshCw />
            {t("common.buttons.retry")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-4 sm:px-6">
      <div className="mx-auto flex w-full max-w-[96rem] flex-col gap-4">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-lg font-semibold">
              {t("marine.brandStudio.title")}
            </h1>
            <p className="mt-1 max-w-3xl text-xs text-muted-foreground">
              {t("marine.brandStudio.description")}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {isDirty ? (
              <Badge
                variant="outline"
                className="border-warning/40 bg-warning/10 text-warning"
              >
                {t("marine.brandStudio.unsaved")}
              </Badge>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-label={t("common.buttons.refresh")}
              disabled={isLoading || isSaving}
              onClick={() => {
                if (
                  !isDirty ||
                  window.confirm(t("marine.brandStudio.discardChanges"))
                ) {
                  void loadData(selectedBrandId ?? undefined);
                }
              }}
            >
              <LuRefreshCw className={isLoading ? "animate-spin" : undefined} />
              <span className="hidden sm:inline">
                {t("common.buttons.refresh")}
              </span>
            </Button>
            <LoadingButton
              size="sm"
              isLoading={isSaving}
              disabled={!isDirty || !draft || isCreating}
              onClick={() => void handleSave()}
            >
              <LuSave />
              {t("common.buttons.save")}
            </LoadingButton>
          </div>
        </header>

        <div className="grid min-h-0 gap-4 lg:grid-cols-[15rem_minmax(0,1fr)]">
          <aside className="flex min-h-0 flex-col rounded-lg border border-border bg-card lg:sticky lg:top-0 lg:max-h-[calc(100vh-9.5rem)]">
            <div className="space-y-3 border-b border-border p-3">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-xs font-semibold">
                  {t("marine.brandStudio.brandList")}
                </h2>
                <Badge variant="secondary" className="text-[10px] tabular-nums">
                  {brands.length}
                </Badge>
              </div>
              <div className="relative">
                <LuSearch className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t("marine.brandStudio.searchPlaceholder")}
                  aria-label={t("marine.brandStudio.searchLabel")}
                  className="h-8 pl-8 text-xs"
                />
              </div>
              <div className="flex gap-1.5">
                <Input
                  value={newBrandName}
                  onChange={(event) => setNewBrandName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void handleCreate();
                  }}
                  placeholder={t("marine.brandStudio.newNamePlaceholder")}
                  aria-label={t("marine.brandStudio.newNameLabel")}
                  className="h-8 min-w-0 text-xs"
                />
                <LoadingButton
                  type="button"
                  size="icon"
                  isLoading={isCreating}
                  disabled={
                    !newBrandName.trim() || isSaving || isDeleting || isCreating
                  }
                  aria-label={t("marine.brandStudio.create")}
                  onClick={() => void handleCreate()}
                >
                  <LuPlus />
                </LoadingButton>
              </div>
            </div>

            <ScrollArea className="max-h-64 min-h-0 flex-1 lg:max-h-none">
              <div className="space-y-1 p-2">
                {filteredBrands.length === 0 ? (
                  <p className="px-2 py-8 text-center text-xs text-muted-foreground">
                    {brands.length === 0
                      ? t("marine.brandStudio.empty")
                      : t("marine.brandStudio.emptySearch")}
                  </p>
                ) : (
                  filteredBrands.map((brand) => {
                    const active = brand.id === selectedBrandId;
                    return (
                      <button
                        key={brand.id}
                        type="button"
                        aria-pressed={active}
                        disabled={isCreating || isSaving || isDeleting}
                        onClick={() => chooseBrand(brand)}
                        className={cn(
                          "w-full rounded-md px-2.5 py-2 text-left transition-colors",
                          "disabled:pointer-events-none disabled:opacity-60",
                          active
                            ? "bg-accent text-accent-foreground"
                            : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                        )}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <span className="min-w-0">
                            <span className="block truncate text-xs font-medium">
                              {brand.name}
                            </span>
                            {brand.displayName &&
                            brand.displayName !== brand.name ? (
                              <span className="mt-0.5 block truncate text-[10px] opacity-70">
                                {brand.displayName}
                              </span>
                            ) : null}
                          </span>
                          {brand.syncEnabled ? (
                            <LuCloud
                              className="mt-0.5 size-3 shrink-0 text-success"
                              aria-label={t("marine.brandStudio.sync.enabled")}
                            />
                          ) : (
                            <LuCloudOff
                              className="mt-0.5 size-3 shrink-0 opacity-50"
                              aria-label={t("marine.brandStudio.sync.disabled")}
                            />
                          )}
                        </div>
                        <div className="mt-1.5 flex flex-wrap items-center gap-1">
                          {brand.builtIn ? (
                            <Badge
                              variant="secondary"
                              className="h-4 text-[9px]"
                            >
                              {t("marine.brandStudio.builtIn")}
                            </Badge>
                          ) : null}
                          <span className="text-[9px] opacity-70">
                            {t("marine.brandStudio.profileCount", {
                              count: profileCountByBrand.get(brand.id) ?? 0,
                            })}
                          </span>
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </ScrollArea>
          </aside>

          {!draft ? (
            <div className="grid min-h-72 place-items-center rounded-lg border border-dashed border-border bg-card/50 p-6 text-center">
              <div className="max-w-sm">
                <LuSparkles className="mx-auto size-8 text-muted-foreground" />
                <h2 className="mt-3 text-sm font-semibold">
                  {t("marine.brandStudio.noSelection.title")}
                </h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("marine.brandStudio.noSelection.description")}
                </p>
              </div>
            </div>
          ) : (
            <div className="grid min-w-0 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_21rem]">
              <main className="min-w-0 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card px-4 py-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="truncate text-base font-semibold">
                        {draft.name}
                      </h2>
                      <Badge variant="outline" className="text-[10px]">
                        {t("marine.brandStudio.revision", {
                          revision: baseline?.revision ?? draft.revision,
                        })}
                      </Badge>
                      {draft.syncEnabled ? (
                        <Badge
                          variant="outline"
                          className="border-success/40 bg-success/10 text-[10px] text-success"
                        >
                          {t("marine.brandStudio.sync.enabled")}
                        </Badge>
                      ) : null}
                    </div>
                    {draft.lastSync ? (
                      <p className="mt-1 text-[10px] text-muted-foreground">
                        {t("marine.brandStudio.sync.lastSync", {
                          time: formatTimestamp(
                            draft.lastSync,
                            i18n.resolvedLanguage ?? i18n.language,
                          ),
                        })}
                      </p>
                    ) : null}
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={isCreating || isSaving || isDeleting}
                    aria-disabled={deleteBlockedReason ? true : undefined}
                    aria-describedby={
                      deleteBlockedReason
                        ? "brand-delete-blocked-reason"
                        : undefined
                    }
                    title={deleteBlockedReason ?? undefined}
                    onClick={() => {
                      if (deleteBlockedReason) return;
                      setDeleteTarget(baseline ? cloneBrand(baseline) : null);
                    }}
                    className={cn(
                      "text-muted-foreground hover:text-destructive",
                      deleteBlockedReason && "opacity-50",
                    )}
                  >
                    <LuTrash2 />
                    {t("common.buttons.delete")}
                  </Button>
                  {deleteBlockedReason ? (
                    <span id="brand-delete-blocked-reason" className="sr-only">
                      {deleteBlockedReason}
                    </span>
                  ) : null}
                </div>

                <EditorSection
                  icon={<LuBot className="size-3.5" />}
                  title={t("marine.brandStudio.sections.identity")}
                  description={t(
                    "marine.brandStudio.sections.identityDescription",
                  )}
                >
                  <div className="grid gap-3 sm:grid-cols-2">
                    <TextField
                      id="brand-name"
                      label={t("marine.brands.name")}
                      value={draft.name}
                      onChange={(value) => updateDraft("name", value)}
                    />
                    <TextField
                      id="brand-display-name"
                      label={t("marine.brands.displayName")}
                      value={draft.displayName}
                      onChange={(value) => updateDraft("displayName", value)}
                    />
                    <div className="space-y-1.5">
                      <Label htmlFor="brand-language" className="text-xs">
                        {t("marine.brands.language")}
                      </Label>
                      <Select
                        value={draft.language}
                        onValueChange={(value) =>
                          updateDraft("language", value)
                        }
                      >
                        <SelectTrigger
                          id="brand-language"
                          size="sm"
                          className="w-full text-xs"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ensureOption(LANGUAGE_VALUES, draft.language).map(
                            (language) => (
                              <SelectItem key={language} value={language}>
                                {LANGUAGE_VALUES.includes(language)
                                  ? t(
                                      `marine.brandStudio.languages.${language.replace("-", "_")}`,
                                    )
                                  : language}
                              </SelectItem>
                            ),
                          )}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">
                        {t("marine.brands.platforms")}
                      </Label>
                      <div className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-input bg-background px-2.5 py-1.5">
                        {PLATFORM_VALUES.map((platform) => {
                          const checked = draft.platforms.includes(platform);
                          const checkboxId = `brand-platform-${platform}`;
                          return (
                            <label
                              key={platform}
                              htmlFor={checkboxId}
                              className="flex cursor-pointer items-center gap-1.5 text-[11px]"
                            >
                              <Checkbox
                                id={checkboxId}
                                checked={checked}
                                onCheckedChange={(nextChecked) => {
                                  updateDraft(
                                    "platforms",
                                    nextChecked
                                      ? [...draft.platforms, platform]
                                      : draft.platforms.filter(
                                          (item) => item !== platform,
                                        ),
                                  );
                                }}
                              />
                              {t(`marine.brandStudio.platforms.${platform}`)}
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <TextField
                      id="brand-positioning"
                      label={t("marine.brandStudio.fields.positioning")}
                      value={draft.positioning}
                      placeholder={t(
                        "marine.brandStudio.placeholders.positioning",
                      )}
                      multiline
                      onChange={(value) => updateDraft("positioning", value)}
                    />
                    <TextField
                      id="brand-audience"
                      label={t("marine.brandStudio.fields.audience")}
                      value={draft.audience}
                      placeholder={t(
                        "marine.brandStudio.placeholders.audience",
                      )}
                      multiline
                      onChange={(value) => updateDraft("audience", value)}
                    />
                    <TextField
                      id="brand-persona"
                      label={t("marine.brands.personaVoice")}
                      value={draft.personaVoice}
                      placeholder={t("marine.brandStudio.placeholders.persona")}
                      multiline
                      rows={4}
                      onChange={(value) => updateDraft("personaVoice", value)}
                    />
                    <TextField
                      id="brand-product"
                      label={t("marine.brands.productInfo")}
                      value={draft.productInfo}
                      placeholder={t("marine.brandStudio.placeholders.product")}
                      multiline
                      rows={4}
                      onChange={(value) => updateDraft("productInfo", value)}
                    />
                  </div>
                </EditorSection>

                <EditorSection
                  icon={<LuSparkles className="size-3.5" />}
                  title={t("marine.brandStudio.sections.tone")}
                  description={t("marine.brandStudio.sections.toneDescription")}
                >
                  <TextField
                    id="brand-comment-style"
                    label={t("marine.brands.commentStyle")}
                    value={draft.commentStyle}
                    placeholder={t(
                      "marine.brandStudio.placeholders.commentStyle",
                    )}
                    multiline
                    rows={3}
                    onChange={(value) => updateDraft("commentStyle", value)}
                  />
                  <div className="mt-4 grid gap-x-5 gap-y-3 sm:grid-cols-2">
                    <ToneSlider
                      id="tone-warmth"
                      label={t("marine.brandStudio.tone.warmth")}
                      value={draft.tone.warmth}
                      onChange={(value) => updateTone("warmth", value)}
                    />
                    <ToneSlider
                      id="tone-expertise"
                      label={t("marine.brandStudio.tone.expertise")}
                      value={draft.tone.expertise}
                      onChange={(value) => updateTone("expertise", value)}
                    />
                    <ToneSlider
                      id="tone-wit"
                      label={t("marine.brandStudio.tone.wit")}
                      value={draft.tone.wit}
                      onChange={(value) => updateTone("wit", value)}
                    />
                    <ToneSlider
                      id="tone-directness"
                      label={t("marine.brandStudio.tone.directness")}
                      value={draft.tone.directness}
                      onChange={(value) => updateTone("directness", value)}
                    />
                  </div>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="tone-emoji" className="text-xs">
                        {t("marine.brandStudio.tone.emoji")}
                      </Label>
                      <Select
                        value={draft.tone.emoji}
                        onValueChange={(value) => updateTone("emoji", value)}
                      >
                        <SelectTrigger
                          id="tone-emoji"
                          size="sm"
                          className="w-full text-xs"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ensureOption(EMOJI_VALUES, draft.tone.emoji).map(
                            (value) => (
                              <SelectItem key={value} value={value}>
                                {EMOJI_VALUES.includes(value)
                                  ? t(`marine.brandStudio.emoji.${value}`)
                                  : value}
                              </SelectItem>
                            ),
                          )}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="tone-length" className="text-xs">
                        {t("marine.brandStudio.tone.length")}
                      </Label>
                      <Select
                        value={draft.tone.length}
                        onValueChange={(value) => updateTone("length", value)}
                      >
                        <SelectTrigger
                          id="tone-length"
                          size="sm"
                          className="w-full text-xs"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ensureOption(LENGTH_VALUES, draft.tone.length).map(
                            (value) => (
                              <SelectItem key={value} value={value}>
                                {LENGTH_VALUES.includes(value)
                                  ? t(`marine.brandStudio.length.${value}`)
                                  : value}
                              </SelectItem>
                            ),
                          )}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </EditorSection>

                <EditorSection
                  icon={<LuBookOpenText className="size-3.5" />}
                  title={t("marine.brandStudio.sections.rules")}
                  description={t(
                    "marine.brandStudio.sections.rulesDescription",
                  )}
                >
                  <div className="grid gap-3 sm:grid-cols-2">
                    <TextField
                      id="brand-do-rules"
                      label={t("marine.brands.doRules")}
                      value={draft.doRules.join("\n")}
                      placeholder={t("marine.brandStudio.placeholders.rules")}
                      multiline
                      rows={6}
                      onChange={(value) =>
                        updateDraft("doRules", inputToLines(value))
                      }
                    />
                    <TextField
                      id="brand-dont-rules"
                      label={t("marine.brands.dontRules")}
                      value={draft.dontRules.join("\n")}
                      placeholder={t("marine.brandStudio.placeholders.rules")}
                      multiline
                      rows={6}
                      onChange={(value) =>
                        updateDraft("dontRules", inputToLines(value))
                      }
                    />
                  </div>
                </EditorSection>

                <EditorSection
                  icon={<LuFileText className="size-3.5" />}
                  title={t("marine.brandStudio.sections.examples")}
                  description={t(
                    "marine.brandStudio.sections.examplesDescription",
                  )}
                >
                  <div className="space-y-3">
                    {draft.examples.length === 0 ? (
                      <p className="rounded-md border border-dashed border-border px-3 py-8 text-center text-xs text-muted-foreground">
                        {t("marine.brandStudio.examples.empty")}
                      </p>
                    ) : (
                      draft.examples.map((example, index) => (
                        <BrandExampleCard
                          key={example.id}
                          example={example}
                          index={index}
                          onChange={(nextExample) =>
                            updateExample(example.id, nextExample)
                          }
                          onDelete={() =>
                            updateDraft(
                              "examples",
                              draft.examples.filter(
                                (item) => item.id !== example.id,
                              ),
                            )
                          }
                        />
                      ))
                    )}
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        updateDraft("examples", [
                          ...draft.examples,
                          makeExample(),
                        ])
                      }
                    >
                      <LuPlus />
                      {t("marine.brandStudio.examples.add")}
                    </Button>
                  </div>
                </EditorSection>

                <EditorSection
                  icon={<LuUsers className="size-3.5" />}
                  title={t("marine.brandStudio.sections.bindings")}
                  description={t(
                    "marine.brandStudio.sections.bindingsDescription",
                  )}
                >
                  <div className="relative mb-3">
                    <LuSearch className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={profileQuery}
                      onChange={(event) => setProfileQuery(event.target.value)}
                      placeholder={t(
                        "marine.brandStudio.bindings.searchPlaceholder",
                      )}
                      aria-label={t("marine.brandStudio.bindings.searchLabel")}
                      className="h-8 pl-8 text-xs"
                    />
                  </div>
                  {filteredProfiles.length === 0 ? (
                    <p className="rounded-md border border-dashed border-border px-3 py-7 text-center text-xs text-muted-foreground">
                      {t("marine.brandStudio.bindings.empty")}
                    </p>
                  ) : (
                    <div className="grid max-h-72 gap-2 overflow-y-auto sm:grid-cols-2">
                      {filteredProfiles.map((profile) => {
                        const checked = profile.brand_id === draft.id;
                        const otherBrand = profile.brand_id
                          ? brands.find(
                              (brand) => brand.id === profile.brand_id,
                            )
                          : undefined;
                        const isBinding = bindingProfileIds.has(profile.id);
                        const checkboxId = `brand-profile-${profile.id}`;
                        return (
                          <label
                            key={profile.id}
                            htmlFor={checkboxId}
                            className={cn(
                              "flex cursor-pointer items-start gap-2 rounded-md border border-border bg-background p-2.5",
                              checked && "border-primary/40 bg-primary/5",
                              isBinding && "pointer-events-none opacity-60",
                            )}
                          >
                            <span className="relative mt-0.5 size-4 shrink-0">
                              <Checkbox
                                id={checkboxId}
                                className={cn(isBinding && "opacity-0")}
                                checked={checked}
                                disabled={isBinding}
                                onCheckedChange={(nextChecked) =>
                                  void handleProfileBinding(
                                    profile,
                                    nextChecked === true,
                                  )
                                }
                              />
                              {isBinding ? (
                                <LuLoaderCircle className="absolute inset-0 size-4 animate-spin text-muted-foreground" />
                              ) : null}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-xs font-medium">
                                {profile.name}
                              </span>
                              <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
                                {otherBrand && !checked
                                  ? t(
                                      "marine.brandStudio.bindings.boundToOther",
                                      { name: otherBrand.name },
                                    )
                                  : checked
                                    ? t(
                                        "marine.brandStudio.bindings.boundToCurrent",
                                      )
                                    : t(
                                        "marine.brandStudio.bindings.usesDefault",
                                        {
                                          name:
                                            brands.find(
                                              (brand) => brand.id === "scholay",
                                            )?.name ?? "Scholay",
                                        },
                                      )}
                              </span>
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </EditorSection>
              </main>

              <PreviewPanel
                context={previewContext}
                onContextChange={setPreviewContext}
                preview={preview}
                examples={draft.examples}
                isLoading={isPreviewLoading}
                error={previewFailed}
                isBrandDirty={isDirty}
              />
            </div>
          )}
        </div>
      </div>

      <DeleteConfirmationDialog
        isOpen={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        isLoading={isDeleting}
        title={t("marine.brandStudio.delete.title")}
        description={t("marine.brandStudio.delete.description", {
          name: deleteTarget?.name ?? "",
        })}
        confirmButtonText={t("common.buttons.delete")}
      />
    </div>
  );
}
