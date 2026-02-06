import { Router } from "express";
import { z } from "zod";
import { startCrawl } from "../pipelines/crawl.js";
import { getJob } from "../store/db.js";

const router = Router();

const CrawlSchema = z.object({
  platform: z.enum(["x", "instagram", "tiktok", "youtube"]),
  target: z.string().min(2),
  options: z.object({
    includePinned: z.boolean().optional(),
    includeRecent: z.boolean().optional(),
    recentLimit: z.number().int().min(0).max(10_000_000).optional(),
    proofKeywords: z.array(z.string()).optional(),
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
export default router;
