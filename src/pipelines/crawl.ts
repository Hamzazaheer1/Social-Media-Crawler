import { randomUUID } from "crypto";
import { createJob, updateJob, getJob } from "../store/db.js";
import type { CrawlRequest, CrawlResult } from "../store/types.js";
import { runLimited } from "../core/rateLimiter.js";
import { attachProofs } from "./proof.js";
import { fetchX } from "../platforms/x/index.js";

import { fetchYouTubeProfile, fetchYouTubePinned, fetchYouTubeRecent } from "../platforms/youtube/adapters.js";
import { fetchInstagram } from "../platforms/instagram/index.js";
import { fetchTikTokProfileAndRecent } from "../platforms/tiktok/adapters.js";

export function startCrawl(req: CrawlRequest) {
  const jobId = randomUUID();
  createJob({ jobId, status: "queued", request: req });

  // fire and forget (in-process). Later we swap to BullMQ/Redis.
  void runJob(jobId).catch(() => {});
  return jobId;
}

async function runJob(jobId: string) {
  const job = getJob(jobId);
  if (!job) return;

  updateJob(jobId, { status: "running", error: null });

  try {
    const { platform, target, options } = job.request;
    const recentLimit = options?.recentLimit ?? 10;
    const includePinned = options?.includePinned ?? true;
    const includeRecent = options?.includeRecent ?? true;
    const keywords = options?.proofKeywords ?? [];

    let profile: import("../store/types.js").Profile;
    let pinned: import("../store/types.js").Post | null = null;
    let pinnedPosts: import("../store/types.js").Post[] | undefined;
    let recent: import("../store/types.js").Post[] = [];
    if (platform === "x") {
      const x = await runLimited("x", () =>
        fetchX(target, recentLimit)
      );
    
      profile = x.profile;
      recent = includeRecent ? x.recent : [];
      pinned = includePinned ? x.pinned ?? null : null;
    }
    
    else if (platform === "youtube") {
      profile = await runLimited("youtube", () => fetchYouTubeProfile(target));
      if (includePinned) pinned = await runLimited("youtube", () => fetchYouTubePinned(target));
      if (includeRecent) recent = await runLimited("youtube", () => fetchYouTubeRecent(target, recentLimit));
    }     else if (platform === "instagram") {
      const ig = await runLimited("instagram", () =>
        fetchInstagram(target, recentLimit)
      );
    
      profile = ig.profile;
      recent = ig.recent;
      pinned = includePinned ? (ig.pinned ?? ig.recent[0] ?? null) : null;
    } else if (platform === "tiktok") {
      const tiktokLimit = Math.max(recentLimit, 5);
      const tiktok = await runLimited("tiktok", () => fetchTikTokProfileAndRecent(target, tiktokLimit));
      profile = tiktok.profile;
      recent = includeRecent ? tiktok.recent : [];
      if (includePinned) {
        pinned = tiktok.recent[0] ?? null;
        pinnedPosts = tiktok.recent.slice(0, 5);
      }
    } else {
      // Fallback
      profile = { handle: target, displayName: null, bio: null, about: null, links: [], isPrivate: false };
      pinned = null;
      recent = [];
    }

    const meta: CrawlResult["meta"] = { fetchedAt: new Date().toISOString() };
    if (platform === "instagram" && (!profile.bio || recent.length === 0)) {
      meta.notes = ["Instagram scraping often returns empty data. For full bio/posts, set INSTAGRAM_ACCESS_TOKEN and INSTAGRAM_USER_ID in .env (Graph API – Business/Creator account only). See Meta for Developers."];
    }

    let result: CrawlResult = {
      jobId,
      platform,
      target,
      profile,
      pinned,
      ...(pinnedPosts != null ? { pinnedPosts } : {}),
      recent,
      proofs: {
        bioMatch: { matched: false, score: 0, evidence: [] },
        aboutMatch: { matched: false, score: 0, evidence: [] },
        pinnedMatch: { matched: false, score: 0, evidence: [] },
        recentMatch: { matched: false, score: 0, evidence: [] },
        final: { matched: false, confidence: 0 },
      },
      meta,
    };


    result = attachProofs(result, keywords);

    updateJob(jobId, { status: "done", result });
  } catch (e: any) {
    updateJob(jobId, { status: "failed", error: e?.message || "Unknown error" });
  }
}
