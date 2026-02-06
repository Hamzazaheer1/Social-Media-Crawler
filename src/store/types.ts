export type Platform = "x" | "instagram" | "tiktok" | "youtube" | "website";
export type JobStatus = "queued" | "running" | "done" | "failed";

export type CrawlOptions = {
  includePinned?: boolean | undefined;
  includeRecent?: boolean | undefined;
  recentLimit?: number | undefined;
  proofKeywords?: string[] | undefined;
  // Website-specific options
  contentSelector?: string | undefined; // CSS selector for content blocks (e.g., "article", ".blog-post", "#content")
  titleSelector?: string | undefined; // CSS selector for title within content block (e.g., "h1", ".title")
  textSelector?: string | undefined; // CSS selector for text content (e.g., ".content", "p")
  linkSelector?: string | undefined; // CSS selector for link (e.g., "a", ".read-more")
  dateSelector?: string | undefined; // CSS selector for date (e.g., ".date", "time")
  authorSelector?: string | undefined; // CSS selector for author (e.g., ".author", "[rel='author']")
  imageSelector?: string | undefined; // CSS selector for images (e.g., "img", ".post-image")
  filterKeywords?: string[] | undefined; // Keywords to filter content (content must contain at least one)
  waitForSelector?: string | undefined; // Selector to wait for before scraping (for dynamic content)
  scrollToLoad?: boolean | undefined; // Whether to scroll page to load lazy content
  maxScrolls?: number | undefined; // Maximum number of scrolls (default: 10)
  // Multi-page crawling
  followPagination?: boolean | undefined; // Whether to follow pagination links
  paginationSelector?: string | undefined; // CSS selector for next page link (e.g., ".next", "a[rel='next']")
  maxPages?: number | undefined; // Maximum number of pages to crawl (default: 10)
  // Advanced options
  respectRobotsTxt?: boolean | undefined; // Whether to respect robots.txt (default: true)
  extractImages?: boolean | undefined; // Whether to extract image URLs (default: true)
  extractAuthor?: boolean | undefined; // Whether to extract author information (default: true)
  extractMetadata?: boolean | undefined; // Whether to extract Open Graph, Twitter Cards metadata (default: true)
  enableCaching?: boolean | undefined; // Whether to cache responses (default: false)
  deduplicateContent?: boolean | undefined; // Whether to remove duplicate content (default: true)
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
  author?: string | null; // Author name
  images?: string[] | null; // Array of image URLs
  metadata?: Record<string, unknown> | null; // Open Graph, Twitter Cards, etc.
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
  meta: { 
    fetchedAt: string; 
    /** Optional note when data is limited (e.g. Instagram without login). */ 
    notes?: string[]; 
    /** Website crawling statistics */
    pagesCrawled?: number;
    totalItems?: number;
    duplicatesRemoved?: number;
    /** Website search results for keywords/identifiers */
    searchResults?: Array<{
      keyword: string;
      found: boolean;
      totalMatches: number;
      locations: Array<{
        url: string;
        context: string;
        position: string;
        matchType: string; // "title", "content", "url", "meta", "html"
        snippet?: string;
      }>;
    }>;
    /** Website posts/content (only for website platform) */
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
  estimatedTimeRemaining?: number; // seconds
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
