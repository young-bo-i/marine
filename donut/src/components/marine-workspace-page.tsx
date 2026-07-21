"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { LuBookOpenText, LuNotebookText } from "react-icons/lu";
import { CommentHistoryPage } from "@/components/comment-history-page";
import { MarineBrandStudio } from "@/components/marine-brand-studio";
import {
  AnimatedTabs,
  AnimatedTabsContent,
  AnimatedTabsList,
  AnimatedTabsTrigger,
} from "@/components/ui/animated-tabs";

type MarineWorkspaceTab = "brands" | "history";

export function MarineWorkspacePage({
  onDirtyChange,
}: {
  onDirtyChange?: (isDirty: boolean) => void;
}) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<MarineWorkspaceTab>("brands");

  return (
    <AnimatedTabs
      value={activeTab}
      onValueChange={(value) => setActiveTab(value as MarineWorkspaceTab)}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="flex h-10 shrink-0 items-center border-b border-border px-4 sm:px-6">
        <AnimatedTabsList aria-label={t("marine.workspace.tabsLabel")}>
          <AnimatedTabsTrigger value="brands">
            <LuBookOpenText className="size-3.5" />
            {t("marine.workspace.tabs.brands")}
          </AnimatedTabsTrigger>
          <AnimatedTabsTrigger value="history">
            <LuNotebookText className="size-3.5" />
            {t("marine.workspace.tabs.history")}
          </AnimatedTabsTrigger>
        </AnimatedTabsList>
      </div>

      <AnimatedTabsContent
        value="brands"
        forceMount
        className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
      >
        <MarineBrandStudio onDirtyChange={onDirtyChange} />
      </AnimatedTabsContent>
      <AnimatedTabsContent
        value="history"
        forceMount
        className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
      >
        <CommentHistoryPage />
      </AnimatedTabsContent>
    </AnimatedTabs>
  );
}
