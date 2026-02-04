export type Platform = "x" | "instagram" | "tiktok" | "youtube";
export type JobStatus = "queued" | "running" | "done" | "failed";

export type CrawlOptions = {
  includePinned?: boolean | undefined;
  includeRecent?: boolean | undefined;
  recentLimit?: number | undefined;
  proofKeywords?: string[] | undefined;
};

export type CrawlRequest = {
  platform: Platform;
  target: string;
  options?: CrawlOptions | undefined;
};

export type Profile = {
  handle: string;
  displayName?: string | null;
  bio?: string | null;
  about?: string | null;
  links: string[];
  isPrivate: boolean;
};

export type Post = {
  id: string;
  url?: string | null;
  text?: string | null;
  createdAt?: string | null;
};

export type ProofSignal = { matched: boolean; score: number; evidence: string[] };

export type Proofs = {
  bioMatch: ProofSignal;
  aboutMatch: ProofSignal;
  pinnedMatch: ProofSignal;
  recentMatch: ProofSignal;
  final: { matched: boolean; confidence: number };
};

export type CrawlResult = {
  jobId: string;
  platform: Platform;
  target: string;
  profile: Profile;
  pinned: Post | null;
  /** Multiple pinned/featured posts (e.g. TikTok: first N videos). First item = same as pinned. */
  pinnedPosts?: Post[];
  recent: Post[];
  proofs: Proofs;
  meta: { fetchedAt: string; /** Optional note when data is limited (e.g. Instagram without login). */ notes?: string[] };
};

export type JobRecord = {
  jobId: string;
  status: JobStatus;
  error?: string | null;
  request: CrawlRequest;
  result?: CrawlResult;
};
