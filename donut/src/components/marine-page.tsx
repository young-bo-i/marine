"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { CommentHistoryPage } from "@/components/comment-history-page";
import { ProspectLedgerPage } from "@/components/prospect-ledger-page";
import {
  AnimatedTabs,
  AnimatedTabsContent,
  AnimatedTabsList,
  AnimatedTabsTrigger,
} from "@/components/ui/animated-tabs";

/**
 * The two ledgers Marine keeps, under one rail entry.
 *
 * They are deliberately separate tables rather than one merged view: the
 * prospect ledger records what was *discovered and claimed* (its job is dedup
 * across accounts, so it holds items nobody ever posted under), while the
 * comment ledger records what was *published*. Merging them would blur exactly
 * the distinction both exist to keep — most importantly `filled` (draft written,
 * never sent) versus a real posting.
 *
 * Discovery leads because it is the tab with the run controls; the posting
 * record is the thing you consult afterwards.
 */
type MarineTab = "prospects" | "history";

export function MarinePage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<MarineTab>("prospects");

  return (
    <AnimatedTabs
      value={tab}
      onValueChange={(value) => {
        setTab(value as MarineTab);
      }}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="shrink-0 border-b border-border px-4 pt-3 pb-2 sm:px-6">
        <AnimatedTabsList>
          <AnimatedTabsTrigger value="prospects">
            {t("marine.tabs.prospects")}
          </AnimatedTabsTrigger>
          <AnimatedTabsTrigger value="history">
            {t("marine.tabs.history")}
          </AnimatedTabsTrigger>
        </AnimatedTabsList>
      </div>

      {/* Radix unmounts the inactive tab, so each child owns its own scroll
          container and refetches when it comes back — which is what we want
          here: both ledgers are cheap reads and staleness is worse. */}
      <AnimatedTabsContent
        value="prospects"
        className="flex min-h-0 flex-1 flex-col"
      >
        <ProspectLedgerPage />
      </AnimatedTabsContent>
      <AnimatedTabsContent
        value="history"
        className="flex min-h-0 flex-1 flex-col"
      >
        <CommentHistoryPage />
      </AnimatedTabsContent>
    </AnimatedTabs>
  );
}
