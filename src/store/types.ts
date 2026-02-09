export type Platform = "x" | "instagram" | "tiktok" | "youtube" | "website";
export type JobStatus = "queued" | "running" | "done" | "failed";

export type CrawlOptions = {
  includePinned?: boolean | undefined;
  includeRecent?: boolean | undefined;
  recentLimit?: number | undefined;
  proofKeywords?: string[] | undefined;

  contentSelector?: string | undefined;
  titleSelector?: string | undefined; 
  textSelector?: string | undefined;
  linkSelector?: string | undefined; 
  dateSelector?: string | undefined; 
  authorSelector?: string | undefined; 
  imageSelector?: string | undefined; 
  filterKeywords?: string[] | undefined; 
  waitForSelector?: string | undefined;
  scrollToLoad?: boolean | undefined;
  maxScrolls?: number | undefined; 

  followPagination?: boolean | undefined; 
  paginationSelector?: string | undefined; 
  maxPages?: number | undefined;

  respectRobotsTxt?: boolean | undefined; 
  extractImages?: boolean | undefined; 
  extractAuthor?: boolean | undefined;
  extractMetadata?: boolean | undefined; 
  enableCaching?: boolean | undefined;
  deduplicateContent?: boolean | undefined;
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
  author?: string | null; 
  images?: string[] | null; 
  metadata?: Record<string, unknown> | null; 
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

  pinnedPosts?: Post[];
  recent: Post[];
  proofs: Proofs;
  meta: { 
    fetchedAt: string; 

    notes?: string[]; 

    pagesCrawled?: number;
    totalItems?: number;
    duplicatesRemoved?: number;

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

    posts?: Post[];
  };
};

export type CrawlProgress = {
  jobId: string;
  status: JobStatus;
  progress: {
    currentPage: number;
    totalPages?: number;
    itemsFound: number;
    pagesCrawled: number;
    errors: number;
  };
  estimatedTimeRemaining?: number;
};

export type JobRecord = {
  jobId: string;
  status: JobStatus;
  error?: string | null;
  request: CrawlRequest;
  result?: CrawlResult;
  progress?: {
    currentPage: number;
    totalPages?: number | null;
    itemsFound: number;
  };
};
