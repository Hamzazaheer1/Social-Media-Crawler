import { randomUUID } from "crypto";
import { createJob, updateJob, getJob } from "../store/db.js";
import type { CrawlRequest, CrawlResult, Post } from "../store/types.js";
import { runLimited } from "../core/rateLimiter.js";
import { attachProofs } from "./proof.js";

import { fetchX } from "../platforms/x/index.js";
import {
  fetchYouTubeProfile,
  fetchYouTubePinned,
  fetchYouTubeAllVideos,
} from "../platforms/youtube/adapters.js";

import {
  fetchTikTokProfileAndRecent,
  fetchTikTokAllVideos,
} from "../platforms/tiktok/adapters.js";

import {
  fetchInstagramProfileAndRecent,
  fetchInstagramAllPosts,
  fetchInstagramProfile,
} from "../platforms/instagram/adapters.js";

import {
  fetchWebsiteProfileAndRecent,
  fetchWebsiteContent,
} from "../platforms/website/adapters.js";
import { updateProgress } from "../store/db.js";

import { logger } from "../core/logger.js";

export const FETCH_ALL_LIMIT = 100_000;


export function startCrawl(req: CrawlRequest) {
  const jobId = randomUUID();
  createJob({ jobId, status: "queued", request: req });

  void runJob(jobId).catch(() => {});
  return jobId;
}

async function runJob(jobId: string) {
  const job = getJob(jobId);
  if (!job) return;

  updateJob(jobId, { status: "running", error: null });

  try {
    const { platform, target, options } = job.request;

    const recentLimit =
      options?.recentLimit === undefined || options?.recentLimit === 0
        ? FETCH_ALL_LIMIT
        : options.recentLimit;

    const includePinned = options?.includePinned ?? true;
    const includeRecent = options?.includeRecent ?? true;
    const keywords = options?.proofKeywords ?? [];

    let profile;
    let pinned: Post | null = null;
    let pinnedPosts: Post[] | undefined;
    let recent: Post[] = [];
    let crawlMeta: { 
      pagesCrawled?: number; 
      duplicatesRemoved?: number;
      posts?: Post[];
      searchResults?: Array<{
        keyword: string;
        found: boolean;
        totalMatches: number;
        locations: Array<{
          url: string;
          context: string;
          position: string;
          matchType: string;
          snippet?: string;
        }>;
      }>;
    } = {};

    /* ======================= X ======================= */
    if (platform === "x") {
      logger.info({ target }, "[X] crawl started");

      const x = await runLimited("x", () =>
        fetchX(target, recentLimit)
      );

      profile = x.profile;
      recent = includeRecent ? x.recent : [];
      pinned = includePinned ? x.pinned ?? null : null;
    }

    /* ======================= YOUTUBE ======================= */
    else if (platform === "youtube") {
      logger.info({ target }, "[YouTube] crawl started");

      profile = await runLimited("youtube", () =>
        fetchYouTubeProfile(target)
      );

      if (includePinned) {
        pinned = await runLimited("youtube", () =>
          fetchYouTubePinned(target)
        );
      }

      if (includeRecent && recentLimit >= FETCH_ALL_LIMIT) {
        logger.info("[YouTube] fetching ALL videos (start → end)");
        recent = await runLimited("youtube", () =>
          fetchYouTubeAllVideos(target)
        );
      }
    }

    /* ======================= TIKTOK ======================= */
    else if (platform === "tiktok") {
      logger.info({ target }, "[TikTok] crawl started");
    
      // Fetch profile first, then all videos if needed
      const profileAndRecent = await runLimited("tiktok", () =>
        fetchTikTokProfileAndRecent(target, recentLimit < FETCH_ALL_LIMIT ? recentLimit : FETCH_ALL_LIMIT)
      );
    
      profile = profileAndRecent.profile;
    
      if (includeRecent && recentLimit >= FETCH_ALL_LIMIT) {
        logger.info("[TikTok] fetching ALL videos (first → latest)");
        recent = await runLimited("tiktok", () =>
          fetchTikTokAllVideos(target)
        );
      } else {
        recent = includeRecent ? profileAndRecent.recent : [];
      }
      
      if (includePinned && recent.length > 0) {
        const firstPost = recent[0];
        pinned = firstPost ?? null;
      } else {
        pinned = null;
      }
    }

    /* ======================= INSTAGRAM ======================= */
    else if (platform === "instagram") {
      logger.info({ target }, "[Instagram] crawl started");
        
      if (includeRecent && recentLimit >= FETCH_ALL_LIMIT) {
        logger.info("[Instagram] fetching ALL posts (first → latest)");
        recent = await runLimited("instagram", () =>
          fetchInstagramAllPosts(target)
        );
        profile = await runLimited("instagram", () =>
          fetchInstagramProfile(target)
        );
      } else {
        const profileAndRecent = await runLimited("instagram", () =>
          fetchInstagramProfileAndRecent(target, recentLimit)
        );
        profile = profileAndRecent.profile;
        recent = includeRecent ? profileAndRecent.recent : [];
      }
      
      if (includePinned && recent.length > 0) {
        const firstPost = recent[0];
        pinned = firstPost ?? null;
      } else {
        pinned = null;
      }
    }

    /* ======================= WEBSITE ======================= */
    else if (platform === "website") {
      logger.info({ target }, "[Website] crawl started");

      // Build website options, filtering out undefined values
      const websiteOptions: {
        contentSelector?: string;
        titleSelector?: string;
        textSelector?: string;
        linkSelector?: string;
        dateSelector?: string;
        authorSelector?: string;
        imageSelector?: string;
        filterKeywords?: string[];
        waitForSelector?: string;
        scrollToLoad?: boolean;
        maxScrolls?: number;
        followPagination?: boolean;
        paginationSelector?: string;
        maxPages?: number;
        respectRobotsTxt?: boolean;
        extractImages?: boolean;
        extractAuthor?: boolean;
        extractMetadata?: boolean;
        enableCaching?: boolean;
        deduplicateContent?: boolean;
        onProgress?: (progress: { currentPage: number; totalPages?: number; itemsFound: number }) => void;
      } = {};
      
      if (options?.contentSelector !== undefined) websiteOptions.contentSelector = options.contentSelector;
      if (options?.titleSelector !== undefined) websiteOptions.titleSelector = options.titleSelector;
      if (options?.textSelector !== undefined) websiteOptions.textSelector = options.textSelector;
      if (options?.linkSelector !== undefined) websiteOptions.linkSelector = options.linkSelector;
      if (options?.dateSelector !== undefined) websiteOptions.dateSelector = options.dateSelector;
      if (options?.authorSelector !== undefined) websiteOptions.authorSelector = options.authorSelector;
      if (options?.imageSelector !== undefined) websiteOptions.imageSelector = options.imageSelector;
      if (options?.filterKeywords !== undefined) websiteOptions.filterKeywords = options.filterKeywords;
      if (options?.waitForSelector !== undefined) websiteOptions.waitForSelector = options.waitForSelector;
      if (options?.scrollToLoad !== undefined) websiteOptions.scrollToLoad = options.scrollToLoad;
      if (options?.maxScrolls !== undefined) websiteOptions.maxScrolls = options.maxScrolls;
      if (options?.followPagination !== undefined) websiteOptions.followPagination = options.followPagination;
      if (options?.paginationSelector !== undefined) websiteOptions.paginationSelector = options.paginationSelector;
      if (options?.maxPages !== undefined) websiteOptions.maxPages = options.maxPages;
      if (options?.respectRobotsTxt !== undefined) websiteOptions.respectRobotsTxt = options.respectRobotsTxt;
      if (options?.extractImages !== undefined) websiteOptions.extractImages = options.extractImages;
      if (options?.extractAuthor !== undefined) websiteOptions.extractAuthor = options.extractAuthor;
      if (options?.extractMetadata !== undefined) websiteOptions.extractMetadata = options.extractMetadata;
      if (options?.enableCaching !== undefined) websiteOptions.enableCaching = options.enableCaching;
      if (options?.deduplicateContent !== undefined) websiteOptions.deduplicateContent = options.deduplicateContent;

      // Add progress tracking
      websiteOptions.onProgress = (progress) => {
        updateProgress(jobId, progress);
      };

      if (includeRecent && recentLimit >= FETCH_ALL_LIMIT) {
        logger.info("[Website] fetching ALL content");
        const result = await runLimited("website", () =>
          fetchWebsiteContent(target, { ...websiteOptions, limit: FETCH_ALL_LIMIT })
        );
        profile = result.profile;
        recent = []; // Website doesn't use recent field
        crawlMeta.pagesCrawled = result.meta.pagesCrawled;
        crawlMeta.duplicatesRemoved = result.meta.duplicatesRemoved;
        crawlMeta.posts = result.posts;
        if (result.meta.searchResults && result.meta.searchResults.length > 0) {
          crawlMeta.searchResults = result.meta.searchResults;
        }
      } else {
        const profileAndRecent = await runLimited("website", () =>
          fetchWebsiteProfileAndRecent(target, recentLimit, websiteOptions)
        );
        profile = profileAndRecent.profile;
        recent = []; // Website doesn't use recent field
        crawlMeta.pagesCrawled = profileAndRecent.meta.pagesCrawled;
        crawlMeta.duplicatesRemoved = profileAndRecent.meta.duplicatesRemoved;
        crawlMeta.posts = profileAndRecent.recent;
        if (profileAndRecent.meta.searchResults && profileAndRecent.meta.searchResults.length > 0) {
          crawlMeta.searchResults = profileAndRecent.meta.searchResults;
        }
      }

      pinned = null; // Website doesn't use pinned field
    }
    
    else {
      profile = {
        handle: target,
        displayName: null,
        bio: null,
        about: null,
        links: [],
        isPrivate: false,
      };
    }

    const meta: CrawlResult["meta"] = {
      fetchedAt: new Date().toISOString(),
      ...(platform === "website" && crawlMeta ? {
        pagesCrawled: crawlMeta.pagesCrawled,
        duplicatesRemoved: crawlMeta.duplicatesRemoved,
        posts: crawlMeta.posts,
        searchResults: crawlMeta.searchResults,
      } : {}),
    };

    // Build result - exclude recent/pinned/proofs for website platform
    let result: CrawlResult;
    if (platform === "website") {
      result = {
        jobId,
        platform,
        target,
        profile,
        pinned: null, // Required by type but not used for website
        recent: [], // Required by type but not used for website
        proofs: {
          bioMatch: { matched: false, score: 0, evidence: [] },
          aboutMatch: { matched: false, score: 0, evidence: [] },
          pinnedMatch: { matched: false, score: 0, evidence: [] },
          recentMatch: { matched: false, score: 0, evidence: [] },
          final: { matched: false, confidence: 0 },
        }, // Required by type but not returned in API response
        meta,
      };
    } else {
      result = {
        jobId,
        platform,
        target,
        profile,
        pinned,
        ...(pinnedPosts ? { pinnedPosts } : {}),
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
    }

    // Only attach proofs for non-website platforms
    if (platform !== "website") {
      result = attachProofs(result, keywords);
    }

    updateJob(jobId, { status: "done", result });
  } catch (e: any) {
    const errorMessage = formatError(e);
    logger.error({ jobId, error: errorMessage, originalError: e?.message }, "Crawl job failed");
    updateJob(jobId, {
      status: "failed",
      error: errorMessage,
    });
  }
}

function formatError(e: any): string {
  if (!e) return "Unknown error";
  
  const message = e?.message || String(e);
  
  if (typeof message === "string") {
    if (message.includes("ERR_NAME_NOT_RESOLVED")) {
      const urlMatch = message.match(/at\s+(https?:\/\/[^\s]+)/);
      const url = urlMatch ? urlMatch[1] : "the requested URL";
      return `DNS resolution failed: Unable to resolve domain name for ${url}. This may be due to network connectivity issues, DNS server problems, or the domain being temporarily unavailable.`;
    }

    if (message.includes("timeout") || message.includes("Timeout")) {
      return `Request timeout: The operation took too long to complete. This may indicate network issues or the target site being slow to respond.`;
    }

    if (message.includes("Navigation failed") || message.includes("net::ERR")) {
      const urlMatch = message.match(/at\s+(https?:\/\/[^\s]+)/);
      const url = urlMatch ? urlMatch[1] : "the requested URL";
      return `Navigation failed for ${url}: ${message}`;
    }

    if (message.includes("ERR_CONNECTION") || message.includes("ECONNREFUSED")) {
      return `Connection error: Unable to establish a connection to the server. This may be due to network issues or the server being unavailable.`;
    }
  }
  
  return message;
}
