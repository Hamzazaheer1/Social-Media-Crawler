import { Router } from "express";
import { z } from "zod";
import { startCrawl } from "../pipelines/crawl.js";
import { getJob, getProgress } from "../store/db.js";

const router = Router();

const CrawlSchema = z.object({
  platform: z.enum(["x", "instagram", "tiktok", "youtube", "website"]),
  target: z.string().min(2),
  options: z.object({
    includePinned: z.boolean().optional(),
    includeRecent: z.boolean().optional(),
    recentLimit: z.number().int().min(0).max(10_000_000).optional(),
    proofKeywords: z.array(z.string()).optional(),

    contentSelector: z.string().optional(),
    titleSelector: z.string().optional(),
    textSelector: z.string().optional(),
    linkSelector: z.string().optional(),
    dateSelector: z.string().optional(),
    filterKeywords: z.array(z.string()).optional(),
    waitForSelector: z.string().optional(),
    scrollToLoad: z.boolean().optional(),
    maxScrolls: z.number().int().min(0).max(100).optional(),
  }).optional()
});

router.post("/crawl", (req, res) => {
  const parsed = CrawlSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const crawlRequest: import("../store/types.js").CrawlRequest = {
    platform: parsed.data.platform,
    target: parsed.data.target,
    ...(parsed.data.options ? { options: parsed.data.options } : {}),
  };
  const jobId = startCrawl(crawlRequest);
  return res.status(201).json({ jobId, status: "queued" });
});

router.get("/crawl/:jobId", (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Not found" });
  return res.json({ jobId: job.jobId, status: job.status, error: job.error ?? null });
});

router.get("/results/:jobId", (req, res) => {
  try {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Not found" });
  if (job.status !== "done") return res.status(409).json({ error: "Job not done", status: job.status });
  const result = job.result;
  if (!result) return res.status(404).json({ error: "Result not found" });

return res.json({
  jobId: result.jobId,
  platform: result.platform,
  target: result.target,
  profile: result.profile,
  pinned: result.pinned,
  recent: result.recent,
  proofs: result.proofs,
  meta: {
    fetchedAt: result.meta.fetchedAt,
    totalPosts: result.recent.length,
  },
});
} catch (error) {
  return res.status(500).json({ error: "Internal server error" });
}
});

router.post("/api/search/website", async (req, res) => {
  try {
    const { url, keywords } = req.body;
    if (!url || typeof url !== "string") {
      return res.status(400).json({ error: "URL is required" });
    }
    if (!keywords || !Array.isArray(keywords) || keywords.length === 0) {
      return res.status(400).json({ error: "Keywords array is required" });
    }

    try {
      new URL(url);
    } catch {
      return res.status(400).json({ error: "Invalid URL format" });
    }

    const { fetchWebsiteContent } = await import("../platforms/website/adapters.js");

    const result = await fetchWebsiteContent(url, {
      filterKeywords: keywords,
      scrollToLoad: true,
      maxScrolls: 15,
      limit: 500,
      maxPages: 10,
    });

    return res.json({
      url,
      keywords,
      matchesFound: result.meta.searchResults?.length || 0,
      searchResults: result.meta.searchResults || [],
      matchingPosts: result.posts,
      totalItems: result.posts.length,
      pagesCrawled: result.meta.pagesCrawled,
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "Internal server error" });
  }
});


router.post("/api/website/fetch", async (req, res) => {
  try {
    const { url, maxArticles: bodyMax } = req.body;
    
    if (!url || typeof url !== "string") {
      return res.status(400).json({ error: "URL is required" });
    }

    try {
      new URL(url);
    } catch {
      return res.status(400).json({ error: "Invalid URL format" });
    }

    const { fetchWebsiteContentViaListing } = await import("../platforms/website/adapters.js");
    const result = await fetchWebsiteContentViaListing(url, {
      scrollToLoad: true,
      maxScrolls: 15,
      respectRobotsTxt: true,
      ...(typeof bodyMax === "number" && bodyMax > 0 ? { maxArticles: Math.floor(bodyMax) } : {}),
    });

    const blogPosts = result.posts;
    return res.json({
      url,
      profile: result.profile,
      blogs: blogPosts.length > 0 ? blogPosts : null,
      other: null,
      listingUrl: result.meta.listingUrl,
      articleUrlsFound: result.meta.articleUrlsFound,
      articlesFetched: result.meta.articlesFetched,
      errors: result.meta.errors,
    });
  } catch (error: any) {
    return res.status(500).json({ 
      error: error.message || "Internal server error",
      details: process.env.NODE_ENV === "development" ? error.stack : undefined
    });
  }
});



export default router;
