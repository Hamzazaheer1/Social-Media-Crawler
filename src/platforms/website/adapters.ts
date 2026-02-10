import type { Profile, Post } from "../../store/types.js";
import { createHttpClient } from "../../core/http.js";
import { logger } from "../../core/logger.js";
import { load } from "cheerio";
import puppeteer from "puppeteer";
import { checkRobotsTxt } from "./robots.js";

const http = createHttpClient();

const pageCache = new Map<string, { html: string; expires: number }>();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractDomain(url: string): string {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname.replace(/^www\./, "");
  } catch {
    return url.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
  }
}

function normalizeUrl(url: string, baseUrl: string): string {
  try {
    return new URL(url, baseUrl).href;
  } catch {
    return url;
  }
}

function extractDate(text: string | null, element: { attr: (name: string) => string | undefined } | null = null): string | null {
  if (!text) return null;
  
  const datePatterns = [
    /\d{4}-\d{2}-\d{2}/, // YYYY-MM-DD
    /\d{2}\/\d{2}\/\d{4}/, // MM/DD/YYYY
    /\d{2}-\d{2}-\d{4}/, // MM-DD-YYYY
    /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4}/i, // Month DD, YYYY
  ];

  for (const pattern of datePatterns) {
    const match = text.match(pattern);
    if (match) {
      try {
        const date = new Date(match[0]);
        if (!isNaN(date.getTime())) {
          return date.toISOString();
        }
      } catch {}
    }
  }

  if (element) {
    const datetime = element.attr("datetime");
    if (datetime) {
      try {
        const date = new Date(datetime);
        if (!isNaN(date.getTime())) {
          return date.toISOString();
        }
      } catch {}
    }
  }

  return null;
}

function matchesKeywords(text: string, keywords: string[]): boolean {
  if (!keywords || keywords.length === 0) return true;
  const lowerText = text.toLowerCase();
  return keywords.some((keyword) => lowerText.includes(keyword.toLowerCase()));
}

function extractSnippet(text: string, keyword: string, contextLength: number = 50): string {
  const lowerText = text.toLowerCase();
  const index = lowerText.indexOf(keyword.toLowerCase());
  if (index === -1) return text.substring(0, contextLength);
  
  const start = Math.max(0, index - contextLength);
  const end = Math.min(text.length, index + keyword.length + contextLength);
  let snippet = text.substring(start, end);
  
  if (start > 0) snippet = "..." + snippet;
  if (end < text.length) snippet = snippet + "...";
  
  return snippet;
}

function findAllMatches(text: string, keyword: string, maxMatches: number = 10): Array<{ context: string; snippet: string }> {
  const matches: Array<{ context: string; snippet: string }> = [];
  const lowerText = text.toLowerCase();
  let searchIndex = 0;
  
  while (matches.length < maxMatches) {
    const index = lowerText.indexOf(keyword.toLowerCase(), searchIndex);
    if (index === -1) break;
    
    const start = Math.max(0, index - 100);
    const end = Math.min(text.length, index + keyword.length + 100);
    const context = text.substring(start, end);
    const snippet = extractSnippet(text.substring(start, end), keyword, 50);
    
    matches.push({ context, snippet });
    searchIndex = index + keyword.length;
  }
  
  return matches;
}

function generatePostId(url: string | null, title: string | null, index: number): string {
  if (url) {
    try {
      const urlObj = new URL(url);
      const path = urlObj.pathname;
      if (path && path !== "/") {
        return path.replace(/^\//, "").replace(/\//g, "-") || `post-${index}`;
      }
    } catch {}
  }
  if (title) {
    return title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || `post-${index}`;
  }
  return `post-${index}`;
}

function extractImages($block: any, imageSelector: string, baseUrl: string, $: ReturnType<typeof load>): string[] {
  const images: string[] = [];
  const imageEls = $block.find(imageSelector);
  
  imageEls.each((_index: number, el: any) => {
    const $img = $(el);
    const src = $img.attr("src") || $img.attr("data-src") || $img.attr("data-lazy-src");
    if (src) {
      const fullUrl = normalizeUrl(src, baseUrl);
      if (fullUrl && !images.includes(fullUrl)) {
        images.push(fullUrl);
      }
    }
  });
  
  return images;
}

function extractAuthor($block: any, authorSelector: string | undefined, $: ReturnType<typeof load>): string | null {
  if (authorSelector) {
    const authorEl = $block.find(authorSelector).first();
    if (authorEl.length) {
      return authorEl.text().trim() || authorEl.attr("content") || null;
    }
  }
  
  const commonSelectors = [
    '[rel="author"]',
    '.author',
    '.byline',
    '.post-author',
    '[itemprop="author"]',
  ];
  
  for (const selector of commonSelectors) {
    const el = $block.find(selector).first();
    if (el.length) {
      const text = el.text().trim();
      if (text) return text;
    }
  }
  
  return null;
}

function extractMetadata($: ReturnType<typeof load>): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  
  $('meta[property^="og:"]').each((_, el) => {
    const property = $(el).attr("property");
    const content = $(el).attr("content");
    if (property && content) {
      metadata[property] = content;
    }
  });
  
  $('meta[name^="twitter:"]').each((_, el) => {
    const name = $(el).attr("name");
    const content = $(el).attr("content");
    if (name && content) {
      metadata[name] = content;
    }
  });
  
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const json = JSON.parse($(el).html() || "{}");
      if (json["@type"]) {
        metadata[`schema_${json["@type"]}`] = json;
      }
    } catch {}
  });
  
  return metadata;
}

function findNextPageUrl($: ReturnType<typeof load>, paginationSelector: string, currentUrl: string): string | null {
  if (!paginationSelector) return null;
  
  const nextLink = $(paginationSelector).first();
  if (nextLink.length) {
    const href = nextLink.attr("href");
    if (href) {
      return normalizeUrl(href, currentUrl);
    }
  }
  
  const commonSelectors = [
    'a[rel="next"]',
    '.next',
    '.pagination-next',
    '.page-next',
  ];
  
  for (const selector of commonSelectors) {
    const link = $(selector).first();
    if (link.length) {
      const href = link.attr("href");
      if (href) {
        return normalizeUrl(href, currentUrl);
      }
    }
  }
  
  return null;
}

function deduplicatePosts(posts: Post[]): Post[] {
  const seen = new Map<string, Post>();
  
  for (const post of posts) {
    const postUrl = post.url;
    if (postUrl && typeof postUrl === "string" && postUrl.length > 0) {
      const hashSplit = postUrl.split("#");
      const querySplit = hashSplit[0]?.split("?") ?? [];
      const normalizedUrl = querySplit[0] ?? hashSplit[0] ?? postUrl;
      if (normalizedUrl && normalizedUrl.length > 0 && !seen.has(normalizedUrl)) {
        seen.set(normalizedUrl, post);
      }
    } else {
      if (post.id && !seen.has(post.id)) {
        seen.set(post.id, post);
      }
    }
  }
  
  return Array.from(seen.values());
}

async function fetchPageHtml(
  url: string,
  options: {
    waitForSelector?: string;
    scrollToLoad?: boolean;
    maxScrolls?: number;
    enableCaching?: boolean;
  }
): Promise<{ html: string; source: "http" | "browser" }> {
  if (options.enableCaching) {
    const cached = pageCache.get(url);
    if (cached && cached.expires > Date.now()) {
      logger.debug({ url }, "Using cached page");
      return { html: cached.html, source: "http" };
    }
  }

  let html: string | undefined;
  let source: "http" | "browser" = "http";
  let useBrowser = options.scrollToLoad || !!options.waitForSelector || url.includes("/blog");

  if (!useBrowser) {
    try {
      const response = await http.get(url, {
        timeout: 15000,
        maxRedirects: 5,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      });
      if (response?.data && response.status === 200) {
        html = typeof response.data === "string" ? response.data : JSON.stringify(response.data);
        logger.info({ url, source: "http" }, "Website content fetched via HTTP");
      } else {
        throw new Error("HTTP request failed");
      }
    } catch (error) {
      logger.debug({ url, error: (error as { message?: string }).message }, "HTTP fetch failed, using browser");
      useBrowser = true;
    }
  }

  if (useBrowser || !html) {
    const browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--disable-dev-shm-usage",
      ],
    });

    try {
      const page = await browser.newPage();
      await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
      );
      await page.setViewport({ width: 1920, height: 1080 });

      logger.info({ url }, "Loading page with browser");
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

      if (options.waitForSelector) {
        try {
          await page.waitForSelector(options.waitForSelector, { timeout: 10000 });
          logger.info({ url, selector: options.waitForSelector }, "Wait selector found");
        } catch (error) {
          logger.warn({ url, selector: options.waitForSelector }, "Wait selector not found, continuing anyway");
        }
      }

      if (useBrowser && options.scrollToLoad) {
        logger.info({ url, maxScrolls: options.maxScrolls }, "Scrolling to load content");
        for (let i = 0; i < (options.maxScrolls || 10); i++) {
          await page.evaluate(() => {
            window.scrollTo(0, document.body.scrollHeight);
          });
          await delay(1500);
          
          const isAtBottom = await page.evaluate(() => {
            return window.innerHeight + window.scrollY >= document.body.scrollHeight - 10;
          });
          if (isAtBottom) break;
        }
        await delay(2000);
      }

      html = await page.content();
      source = "browser";
      logger.info({ url, source }, "Page content loaded");
    } finally {
      await browser.close();
    }
  }

  if (options.enableCaching && html) {
    pageCache.set(url, {
      html: html!,
      expires: Date.now() + 3600000, 
    });
  }

  return { html: html!, source };
}

async function findBlogPages(homepageUrl: string, html: string): Promise<string[]> {
  const $ = load(html);
  const blogUrls = new Set<string>();
  const baseUrl = new URL(homepageUrl).origin;
  
  const blogLinkSelectors = [
    'a[href*="/blog"]',
    'a[href*="/articles"]',
    'a[href*="/posts"]',
    'a[href*="/news"]',
    'a[href*="/stories"]',
    'a[href*="/journal"]',
    'a[href*="/magazine"]',
    'a[href*="/updates"]',
    'a[href*="/resources"]',
    'a[class*="blog"]',
    'a[class*="article"]',
    'a[class*="post"]',
    'nav a[href*="blog"]',
    'header a[href*="blog"]',
    '.menu a[href*="blog"]',
    '.navigation a[href*="blog"]',
    'footer a[href*="blog"]',
  ];
  
  for (const selector of blogLinkSelectors) {
    $(selector).each((_, el) => {
      const href = $(el).attr("href");
      if (href) {
        try {
          const fullUrl = normalizeUrl(href, homepageUrl);
          if (fullUrl && (
            fullUrl.includes("/blog") || 
            fullUrl.includes("/articles") || 
            fullUrl.includes("/posts") || 
            fullUrl.includes("/news") ||
            fullUrl.includes("/stories") ||
            fullUrl.includes("/journal") ||
            fullUrl.includes("/magazine")
          )) {
            try {
              const urlObj = new URL(fullUrl);
              const baseUrlObj = new URL(baseUrl);
              if (urlObj.hostname === baseUrlObj.hostname || urlObj.hostname.replace('www.', '') === baseUrlObj.hostname.replace('www.', '')) {
                blogUrls.add(fullUrl);
              }
            } catch {}
          }
        } catch (e) {
        }
      }
    });
  }
  
  $("nav a, .navigation a, .menu a, header a, footer a").each((_, el) => {
    const text = $(el).text().toLowerCase().trim();
    const href = $(el).attr("href");
    if (href && (
      text.includes("blog") || 
      text.includes("articles") || 
      text.includes("posts") ||
      text.includes("news") ||
      text.includes("stories") ||
      text.includes("journal") ||
      text === "blog" ||
      text === "articles" ||
      text === "posts"
    )) {
      try {
        const fullUrl = normalizeUrl(href, homepageUrl);
        try {
          const urlObj = new URL(fullUrl);
          const baseUrlObj = new URL(baseUrl);
          if (urlObj.hostname === baseUrlObj.hostname || urlObj.hostname.replace('www.', '') === baseUrlObj.hostname.replace('www.', '')) {
            blogUrls.add(fullUrl);
          }
        } catch {}
      } catch (e) {
      }
    }
  });
  
  const homepageHasBlogContent = $("article, .post, .blog-post, .entry, [class*='blog'], [class*='article']").length > 0;
  if (homepageHasBlogContent) {
    blogUrls.add(homepageUrl);
  }
  
  return Array.from(blogUrls).slice(0, 10);
}

function isListingUrlBlogSite(listingUrl: string): boolean {
  try {
    const u = new URL(listingUrl);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();
    if (/^blog\.|\.blog\./i.test(host)) return true;
    if (/^news\.|\.news\./i.test(host)) return true;
    if (/\/blog(\/|$)/i.test(path) || /\/news(\/|$)/i.test(path)) return true;
    if (/\/articles?(\/|$)/i.test(path) || /\/posts?(\/|$)/i.test(path)) return true;
    return false;
  } catch {
    return false;
  }
}

function extractArticleUrlsFromListing(
  html: string,
  listingUrl: string,
  baseOrigin: string,
  options?: { listingDetectedAsBlog?: boolean }
): string[] {
  const $ = load(html);
  const articleUrls = new Set<string>();
  const listingPath = new URL(listingUrl).pathname.replace(/\/?$/, "") || "/";
  const listingIsBlogSite = isListingUrlBlogSite(listingUrl) || options?.listingDetectedAsBlog === true;

  const blogPathPatterns = [
    /\/news(\/|$)/i,
    /\/blog(\/|$)/i,
    /\/articles?(\/|$)/i,
    /\/posts?(\/|$)/i,
    /\/stories(\/|$)/i,
    /\/journal(\/|$)/i,
    /\/magazine(\/|$)/i,
    /\/updates(\/|$)/i,
    /\/post\//i,
    /\/article\//i,
    /\/press(\/|$)/i,
    /\/media(\/|$)/i,
  ];

  const excludePathPatterns = [
    /^\/$/,
    /\/page\/\d+/i,
    /\/tag\//i,
    /\/category\//i,
    /\/author\//i,
    /\/search/i,
    /\/product/i,
    /\/products/i,
    /\/about/i,
    /\/contact/i,
    /\/inquiry/i,
    /\/contactus/i,
    /\.pdf$/i,
    /\/beautyinstrument/i,
    /\/cart/i,
    /\/account/i,
    /\/login/i,
    /\/signup/i,
    /\/privacy/i,
    /\/terms/i,
    /mailto:/i,
    /tel:/i,
    /javascript:/i,
  ];

  const contentRoots = $("main, [role='main'], .content, .posts, .blog-list, .article-list, #content");
  const searchRoot = contentRoots.length > 0 ? contentRoots.first() : $("body");

  searchRoot.find("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("javascript:")) return;
    try {
      const fullUrl = normalizeUrl(href, listingUrl);
      const urlObj = new URL(fullUrl);
      const path = urlObj.pathname;

      if (!path || path === "/" || path === listingPath || path.length < 2) return;

      const base = new URL(baseOrigin).origin;
      const origin = urlObj.origin;
      if (origin !== base && origin.replace(/^https?:\/\//, "").replace(/^www\./, "") !== base.replace(/^https?:\/\//, "").replace(/^www\./, "")) return;

      if (excludePathPatterns.some((p) => p.test(path) || p.test(fullUrl))) return;

      if (listingIsBlogSite) {
        articleUrls.add(fullUrl);
      } else {
        const looksLikeBlog = blogPathPatterns.some((p) => p.test(path));
        if (!looksLikeBlog) return;
        articleUrls.add(fullUrl);
      }
    } catch {}
  });

  return Array.from(articleUrls);
}

async function fetchSingleArticle(
  articleUrl: string,
  options: { respectRobotsTxt?: boolean; enableCaching?: boolean } = {}
): Promise<Post> {
  const { respectRobotsTxt = true, enableCaching = false } = options;
  if (respectRobotsTxt) {
    const allowed = await checkRobotsTxt(articleUrl);
    if (!allowed) throw new Error(`URL disallowed by robots.txt: ${articleUrl}`);
  }

  const { html } = await fetchPageHtml(articleUrl, { enableCaching });
  const $ = load(html);

  const articleEl = $("article, .post, .blog-post, .entry-content, .post-content, .article-content, [role='article'], main").first();
  const root = articleEl.length > 0 ? articleEl : $("body");

  let title: string | null = $("h1").first().text().trim() || null;
  if (!title) title = root.find("h1, .title, .post-title, .entry-title").first().text().trim() || null;
  if (!title) title = $("meta[property='og:title']").attr("content")?.trim() || null;

  const textEls = root.find("p, .content p, .post-content p, .entry-content p, .article-body p, [class*='content'] p");
  const textParts: string[] = [];
  textEls.each((_, el) => {
    const t = $(el).text().trim();
    if (t.length > 0) textParts.push(t);
  });
  const text = textParts.length > 0 ? textParts.join("\n\n") : root.text().trim().replace(/\s+/g, " ").trim();

  const headings: string[] = [];
  root.find("h1, h2, h3, h4").each((_, el) => {
    const h = $(el).text().trim();
    if (h) headings.push(h);
  });

  let createdAt: string | null = null;
  const dateEl = root.find("time, .date, .published, .post-date, .entry-date, [datetime]").first();
  if (dateEl.length) {
    const dt = dateEl.attr("datetime") || dateEl.text().trim();
    createdAt = extractDate(dt, dateEl);
  }
  if (!createdAt && text) createdAt = extractDate(text);

  let author: string | null = null;
  const authorEl = root.find('[rel="author"], .author, .byline, .post-author, [itemprop="author"]').first();
  if (authorEl.length) author = authorEl.text().trim() || authorEl.attr("content") || null;
  if (!author) {
    const metaAuthor = $('meta[name="author"]').attr("content");
    if (metaAuthor) author = metaAuthor.trim();
  }

  const images: string[] = [];
  root.find("img").each((_, el) => {
    const src = $(el).attr("src") || $(el).attr("data-src");
    if (src) {
      const full = normalizeUrl(src, articleUrl);
      if (full && !images.includes(full)) images.push(full);
    }
  });

  const id = generatePostId(articleUrl, title, 0);
  const post: Post = {
    id,
    url: articleUrl,
    text: text || title || null,
    createdAt: createdAt || null,
    author: author || null,
    images: images.length > 0 ? images : null,
    metadata: headings.length > 0 ? { headings } : null,
  };
  return post;
}

export async function detectBlogType(url: string, html: string): Promise<{ isBlog: boolean; isBlogListing: boolean; isBlogArticle: boolean; recommendedStrategy: string }> {
  const $ = load(html);
  
  const urlLower = url.toLowerCase();
  const isBlogUrl = /\/blog|\/articles|\/posts|\/news|\/stories/i.test(urlLower);
  
  const hasArticleTags = $("article").length > 0;
  const hasBlogClasses = $("[class*='blog'], [class*='post'], [class*='article']").length > 0;
  const hasMultipleHeadings = $("h1, h2, h3").length > 3;
  const hasContentBlocks = $("article, .post, .blog-post, .entry").length > 0;
  
  const hasMultipleLinks = $("main a, article a, .post a").length > 5;
  const hasPagination = $(".pagination, .page-nav, [rel='next']").length > 0;
  
  const hasSingleMainHeading = $("main h1, article h1").length === 1;
  const hasLongContent = $("main p, article p").length > 5;
  
  const isBlog = isBlogUrl || hasArticleTags || hasBlogClasses || hasContentBlocks;
  const isBlogListing = isBlog && (hasMultipleLinks || hasPagination || $("article, .post, .blog-post").length > 1);
  const isBlogArticle = isBlog && hasSingleMainHeading && hasLongContent && !isBlogListing;
  
  let recommendedStrategy = "html-scrape";
  if (isBlogListing) {
    recommendedStrategy = "html-scrape-with-scroll";
  } else if (isBlogArticle) {
    recommendedStrategy = "html-scrape-single-article";
  }
  
  return {
    isBlog,
    isBlogListing,
    isBlogArticle,
    recommendedStrategy,
  };
}

export async function fetchWebsiteContent(
  url: string,
  options: {
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
    limit?: number;
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
  } = {}
): Promise<{ profile: Profile; posts: Post[]; meta: { pagesCrawled: number; duplicatesRemoved: number; searchResults?: Array<{ keyword: string; found: boolean; totalMatches: number; locations: Array<{ url: string; context: string; position: string; matchType: string; snippet?: string }> }> } }> {
  const {
    contentSelector = "article, .post, .blog-post, .entry, [role='article']",
    titleSelector = "h1, h2, .title, .post-title, .entry-title",
    textSelector = "p, .content, .excerpt, .summary, .post-content",
    linkSelector = "a",
    dateSelector = ".date, .published, time, .post-date, .entry-date",
    authorSelector,
    imageSelector = "img",
    filterKeywords = [],
    waitForSelector,
    scrollToLoad = false,
    maxScrolls = 10,
    limit = 100,
    followPagination = false,
    paginationSelector,
    maxPages = 10,
    respectRobotsTxt = true,
    extractImages: shouldExtractImages = true,
    extractAuthor: shouldExtractAuthor = true,
    extractMetadata: shouldExtractMetadata = true,
    enableCaching = false,
    deduplicateContent: shouldDeduplicate = true,
    onProgress,
  } = options;

  if (respectRobotsTxt) {
    const allowed = await checkRobotsTxt(url);
    if (!allowed) {
      throw new Error("URL is disallowed by robots.txt");
    }
  }

  const domain = extractDomain(url);
  const allPosts: Post[] = [];
  const seenIds = new Set<string>();
  let currentUrl = url;
  let pagesCrawled = 0;
  let maxPagesToCrawl = followPagination ? maxPages : 1;
  
  const urlsToCrawl: string[] = [url];
  const crawledUrls = new Set<string>();

  let siteMetadata: Record<string, unknown> = {};
  
  let profile: Profile | null = null;
  
  const pageHtmls = new Map<string, string>();
  const pageTitles = new Map<string, string>();
  
  let blogPagesFound: string[] = [];
  let isHomepage = true;

  while (pagesCrawled < maxPagesToCrawl && allPosts.length < limit && urlsToCrawl.length > 0) {
    currentUrl = urlsToCrawl.shift() || currentUrl;
    if (crawledUrls.has(currentUrl)) continue;
    crawledUrls.add(currentUrl);
    pagesCrawled++;
    
    if (respectRobotsTxt && pagesCrawled > 1) {
      const allowed = await checkRobotsTxt(currentUrl);
      if (!allowed) {
        logger.warn({ url: currentUrl }, "Page disallowed by robots.txt, skipping");
        break;
      }
    }

    logger.info({ url: currentUrl, page: pagesCrawled, totalPages: maxPagesToCrawl }, "Crawling page");

    let shouldScroll = scrollToLoad || currentUrl.includes("/blog") || (filterKeywords.length > 0);
    let fetchOptions: {
      waitForSelector?: string;
      scrollToLoad?: boolean;
      maxScrolls?: number;
      enableCaching?: boolean;
    } = {
      scrollToLoad: shouldScroll,
      maxScrolls: shouldScroll ? (maxScrolls || 15) : maxScrolls,
      enableCaching,
    };
    if (waitForSelector) {
      fetchOptions.waitForSelector = waitForSelector;
    }
    
    let { html, source } = await fetchPageHtml(currentUrl, fetchOptions);

    if (isHomepage) {
      const blogDetection = await detectBlogType(currentUrl, html);
      logger.info({ 
        url: currentUrl, 
        ...blogDetection 
      }, "Blog detection result");
      
      if (!blogDetection.isBlog && !blogDetection.isBlogListing) {
        logger.info({ url: currentUrl }, "Homepage detected, searching for blog pages");
        blogPagesFound = await findBlogPages(currentUrl, html);
        logger.info({ url: currentUrl, blogPagesFound: blogPagesFound.length, pages: blogPagesFound }, "Found blog pages");
        
        // Add blog pages to crawl queue
        if (blogPagesFound.length > 0) {
          for (const blogUrl of blogPagesFound.slice(0, maxPages - 1)) {
            if (!crawledUrls.has(blogUrl) && !urlsToCrawl.includes(blogUrl)) {
              urlsToCrawl.push(blogUrl);
            }
          }
          maxPagesToCrawl = Math.min(maxPages, blogPagesFound.length + 1); // +1 for homepage
          logger.info({ 
            totalPagesToCrawl: maxPagesToCrawl, 
            blogPagesAdded: blogPagesFound.length 
          }, "Added blog pages to crawl queue");
        } else {
          logger.info({ url: currentUrl }, "No blog pages found on homepage, crawling homepage only");
        }
      } else {
        // Homepage is a blog page, use it directly
        logger.info({ url: currentUrl }, "Homepage is already a blog page, crawling directly");
        isHomepage = false;
      }
      
      // Auto-adjust strategy based on detection - re-fetch if needed
      if (blogDetection.isBlogListing && !shouldScroll) {
        logger.info({ url: currentUrl }, "Blog listing detected, enabling auto-scroll and re-fetching");
        shouldScroll = true;
        fetchOptions.scrollToLoad = true;
        fetchOptions.maxScrolls = 15;
        // Re-fetch with scroll enabled
        const reFetchResult = await fetchPageHtml(currentUrl, fetchOptions);
        html = reFetchResult.html;
        source = reFetchResult.source;
      }
    } else {
      // For blog pages, enable scroll
      if (!shouldScroll) {
        shouldScroll = true;
        fetchOptions.scrollToLoad = true;
        fetchOptions.maxScrolls = 15;
      }
    }
    
    isHomepage = false; // Only first page is homepage
    
    // Store HTML for search
    pageHtmls.set(currentUrl, html);

    // Parse HTML
    const $ = load(html);
    
    // Extract page title
    const pageTitle = $("title").first().text().trim() || "";
    pageTitles.set(currentUrl, pageTitle);
    
    // Extract metadata from first page
    if (pagesCrawled === 1 && shouldExtractMetadata) {
      siteMetadata = extractMetadata($);
    }

    // Extract profile from first page
    if (pagesCrawled === 1) {
      profile = {
        handle: domain,
        displayName: pageTitle || domain,
        bio: $('meta[name="description"]').attr("content") || 
             $('meta[property="og:description"]').attr("content") || 
             null,
        about: $('meta[name="description"]').attr("content") || 
                $('meta[property="og:description"]').attr("content") || 
                null,
        links: [url],
        isPrivate: false,
      };
    }

    let contentBlocks = $(contentSelector);
    logger.info({ 
      url: currentUrl, 
      selector: contentSelector, 
      blocksFound: contentBlocks.length,
      source,
      scrollUsed: shouldScroll 
    }, "Found content blocks");

    if (contentBlocks.length === 0) {
      logger.info({ url: currentUrl }, "No content blocks found with default selector, trying fallback selectors");
      const fallbackSelectors = [
        ".blog-item, .blog-post-item, .post-item",
        "[class*='blog'], [class*='post'], [class*='article']",
        ".entry, .item, .card",
        "main article, main .post, main .entry",
        "section article, section .post",
        "div[class*='content']:has(h2, h3):has(a)",
        "div:has(> h2):has(> a), div:has(> h3):has(> a)",
      ];
      
      for (const fallbackSelector of fallbackSelectors) {
        contentBlocks = $(fallbackSelector);
        if (contentBlocks.length > 0) {
          logger.info({ url: currentUrl, selector: fallbackSelector, blocksFound: contentBlocks.length }, "Found content with fallback selector");
          break;
        }
      }
      
      if (contentBlocks.length === 0) {
        logger.info({ url: currentUrl }, "Trying last resort: divs with headings and links");
        
        const mainContent = $("main, [role='main'], .main-content, .content-area");
        if (mainContent.length > 0) {
          contentBlocks = mainContent.find("div:has(h1, h2, h3, h4):has(a), article, .post");
          if (contentBlocks.length > 0) {
            logger.info({ url: currentUrl, selector: "main content area", blocksFound: contentBlocks.length }, "Found content in main area");
          }
        }
        
        if (contentBlocks.length === 0) {
          const allDivs = $("div");
          contentBlocks = allDivs.filter((_, el) => {
            const $el = $(el);
            
            const parentClasses = $el.parent().attr("class") || "";
            const parentId = $el.parent().attr("id") || "";
            const isNav = /nav|header|footer|sidebar|menu|topbar|bottombar/i.test(parentClasses + parentId);
            if (isNav) return false;
            
            const hasHeading = $el.find("h1, h2, h3, h4").length > 0;
            const hasLink = $el.find("a").length > 0;
            const text = $el.text().trim();
            const hasText = text.length > 100; 
            
            const textLower = text.toLowerCase();
            const isNavigation = /^(home|about|contact|help|privacy|terms|login|signup|cart|checkout|account)$/i.test(textLower.substring(0, 50));
            
            return hasHeading && hasLink && hasText && !isNavigation;
          });
        }
        
        logger.info({ url: currentUrl, blocksFound: contentBlocks.length }, "Last resort selector found blocks");
      }
    }

    contentBlocks.each((index, element) => {
      if (allPosts.length >= limit) return false;

      const $block = $(element);
      
      // Extract title
      let title: string | null = null;
      if (titleSelector) {
        const titleEl = $block.find(titleSelector).first();
        title = titleEl.text().trim() || null;
      }
      
      if (!title) {
        const headings = $block.find("h1, h2, h3, h4, .title, .post-title, .entry-title, [class*='title']").first();
        if (headings.length > 0) {
          title = headings.text().trim() || null;
        }
        
        if (!title) {
          const firstLink = $block.find("a").first();
          const linkText = firstLink.text().trim();
          if (linkText && linkText.length > 10 && linkText.length < 200) {
            title = linkText;
          }
        }
      }

      let text: string | null = null;
      if (textSelector) {
        const textEls = $block.find(textSelector);
        const texts: string[] = [];
        textEls.each((_, el) => {
          const txt = $(el).text().trim();
          if (txt && txt.length > 10) texts.push(txt);
        });
        text = texts.join(" ").trim() || null;
      }
      
      if (!text) {
        const contentEls = $block.find("p, .content, .excerpt, .summary, .description, [class*='content'], [class*='text']");
        if (contentEls.length > 0) {
          const texts: string[] = [];
          contentEls.each((_, el) => {
            const txt = $(el).text().trim();
            if (txt && txt.length > 10) texts.push(txt);
          });
          text = texts.join(" ").trim() || null;
        }
        
        if (!text) {
          const allText = $block.clone().children().remove().end().text().trim();
          if (allText && allText.length > 20) {
            text = allText;
          }
        }
      }

      let link: string | null = null;
      if (linkSelector) {
        const linkEl = $block.find(linkSelector).first();
        link = linkEl.attr("href") || null;
        if (link) {
          link = normalizeUrl(link, currentUrl);
        }
      }
      
      if (!link) {
        const firstLink = $block.find("a").first();
        link = firstLink.attr("href") ? normalizeUrl(firstLink.attr("href")!, currentUrl) : null;
      }

      // Extract date
      let createdAt: string | null = null;
      if (dateSelector) {
        const dateEl = $block.find(dateSelector).first();
        const dateText = dateEl.text().trim();
        createdAt = extractDate(dateText, dateEl);
      }
      
      if (!createdAt && text) {
        createdAt = extractDate(text);
      }

      let author: string | null = null;
      if (shouldExtractAuthor) {
        author = extractAuthor($block, authorSelector, $);
      }

      let images: string[] | null = null;
      if (shouldExtractImages) {
        const extractedImages = extractImages($block, imageSelector, currentUrl, $);
        images = extractedImages.length > 0 ? extractedImages : null;
      }

      if (filterKeywords && filterKeywords.length > 0) {
        const combinedText = [title, text, link].filter(Boolean).join(" ").toLowerCase();
        const matchesAnyKeyword = filterKeywords.some(keyword => 
          combinedText.includes(keyword.toLowerCase())
        );
        
        if (!matchesAnyKeyword) {
          logger.debug({ index, title, hasKeywords: filterKeywords }, "Skipping block - doesn't match any keyword");
          return;
        }
      }

      const skipPatterns = [
        /^(about|contact|help|privacy|terms|exchange|return|payment|shipping|faq|login|signup|register|cart|checkout|account|profile|settings|search|menu|home|store|locator)$/i,
        /^(mailto:|tel:|#|javascript:)/i,
        /^(remove|delete|cancel|submit|send|close|back|next|previous|more|less)$/i,
        /^(exchange|return|policy|payment|shipping|delivery|track|order|wishlist|fabric|glossary)$/i,
        /^pages\//i, // Footer/navigation pages
        /@.*\.(com|pk|net|org)/i, // Email addresses
        /^\+?\d{10,}/i, // Phone numbers
      ];
      
      const titleLower = title?.toLowerCase().trim() || "";
      const textLower = text?.toLowerCase().trim() || "";
      const linkLower = link?.toLowerCase() || "";
      const combinedText = `${titleLower} ${textLower.substring(0, 100)} ${linkLower}`;
      
      const shouldSkip = 
        // Check title
        (titleLower && skipPatterns.some(pattern => pattern.test(titleLower))) ||
        // Check text (first 100 chars)
        (textLower && skipPatterns.some(pattern => pattern.test(textLower.substring(0, 100)))) ||
        // Check link
        (linkLower && (
          skipPatterns.some(pattern => pattern.test(linkLower)) ||
          linkLower.startsWith("mailto:") ||
          linkLower.startsWith("tel:") ||
          linkLower === "#" ||
          linkLower.startsWith("javascript:") ||
          linkLower.includes("/pages/") || // Footer pages
          linkLower.includes("remove-") || // Form actions
          linkLower.includes("delete-") ||
          linkLower.includes("cancel-")
        )) ||
        // Very short text without title is likely not a blog post
        (text && text.length < 50 && !title) ||
        // Email addresses in text
        (textLower && /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(textLower.trim())) ||
        // Phone numbers in text
        (textLower && /^\+?\d{10,}/.test(textLower.trim().replace(/\s/g, "")));
      
      if (shouldSkip) {
        logger.debug({ index, title, link, textPreview: text?.substring(0, 50) }, "Skipping block - matches skip patterns (navigation/contact/footer)");
        return;
      }

      // Skip if no meaningful content (too short or just whitespace)
      const hasContent = (title && title.length > 3) || (text && text.length > 50);
      if (!hasContent) {
        logger.debug({ index, titleLength: title?.length, textLength: text?.length }, "Skipping block - insufficient content");
        return;
      }
      
      // Prefer blocks that look like blog posts (have substantial text content)
      if (text && text.length < 100 && !title) {
        logger.debug({ index, textLength: text.length }, "Skipping block - too short for blog post");
        return;
      }

      // Generate ID
      const id = generatePostId(link, title, index + allPosts.length);

      // Skip if already seen
      if (seenIds.has(id)) return;
      seenIds.add(id);

      // Only add if we have at least title or text
      if (title || text) {
        const post: Post = {
          id,
          url: link || `${currentUrl}#${id}`,
          text: text || title || null,
          createdAt,
        };

        if (author) post.author = author;
        if (images) post.images = images;
        if (shouldExtractMetadata && Object.keys(siteMetadata).length > 0) {
          post.metadata = siteMetadata;
        }

        allPosts.push(post);
      }
    });

    // Update progress
    if (onProgress) {
      onProgress({
        currentPage: pagesCrawled,
        totalPages: maxPagesToCrawl,
        itemsFound: allPosts.length,
      });
    }

    // Find next page if pagination enabled (only for current blog page, not when crawling multiple blog pages)
    if (followPagination && pagesCrawled < maxPagesToCrawl && allPosts.length < limit && urlsToCrawl.length === 0) {
      const nextUrl = findNextPageUrl($, paginationSelector || "", currentUrl);
      if (nextUrl && nextUrl !== currentUrl && !crawledUrls.has(nextUrl)) {
        urlsToCrawl.push(nextUrl);
        await delay(1000); // Delay before next page
      }
    }
    
    // Continue if there are more URLs in queue
    if (urlsToCrawl.length === 0 && !followPagination) {
      break; // No more pages to crawl
    }
    
    await delay(500); // Small delay between page crawls
  }

  // Deduplicate if enabled
  let duplicatesRemoved = 0;
  let finalPosts = allPosts;
  if (shouldDeduplicate) {
    const beforeCount = allPosts.length;
    finalPosts = deduplicatePosts(allPosts);
    duplicatesRemoved = beforeCount - finalPosts.length;
  }

  logger.info({ 
    url, 
    postsFound: finalPosts.length, 
    pagesCrawled,
    duplicatesRemoved,
  }, "Website content extracted");

  // Comprehensive search for keywords/identifiers - search in page HTML, URLs, titles, content
  // This searches on the SAME page that was crawled (single page search)
  const searchResults: Array<{ 
    keyword: string; 
    found: boolean; 
    totalMatches: number;
    locations: Array<{ 
      url: string; 
      context: string; 
      position: string;
      matchType: string; // "title", "content", "url", "meta", "html"
      snippet?: string;
    }> 
  }> = [];
  
  if (filterKeywords && filterKeywords.length > 0) {
    logger.info({ 
      keywords: filterKeywords, 
      pagesToSearch: pageHtmls.size,
      postsToSearch: finalPosts.length 
    }, "Starting keyword search on crawled page(s)");
    
    for (const keyword of filterKeywords) {
      const locations: Array<{ 
        url: string; 
        context: string; 
        position: string;
        matchType: string;
        snippet?: string;
      }> = [];
      const keywordLower = keyword.toLowerCase();
      
      // Search in page HTMLs (comprehensive search)
      for (const [pageUrl, pageHtml] of pageHtmls.entries()) {
        const pageTitle = pageTitles.get(pageUrl) || "";
        const $page = load(pageHtml);
        
        // Search in page title
        if (pageTitle.toLowerCase().includes(keywordLower)) {
          locations.push({
            url: pageUrl,
            context: pageTitle,
            position: "title",
            matchType: "title",
            snippet: extractSnippet(pageTitle, keywordLower, 50),
          });
        }
        
        // Search in page HTML content (body text)
        const bodyText = $page("body").text();
        if (bodyText.toLowerCase().includes(keywordLower)) {
          const matches = findAllMatches(bodyText, keywordLower, 5);
          for (const match of matches) {
            locations.push({
              url: pageUrl,
              context: match.context,
              position: "content",
              matchType: "html",
              snippet: match.snippet,
            });
          }
        }
        
        // Search in meta tags
        const metaDesc = $page('meta[name="description"]').attr("content") || 
                         $page('meta[property="og:description"]').attr("content") || "";
        if (metaDesc.toLowerCase().includes(keywordLower)) {
          locations.push({
            url: pageUrl,
            context: metaDesc,
            position: "meta",
            matchType: "meta",
            snippet: extractSnippet(metaDesc, keywordLower, 50),
          });
        }
        
        // Search in URL
        if (pageUrl.toLowerCase().includes(keywordLower)) {
          locations.push({
            url: pageUrl,
            context: pageUrl,
            position: "url",
            matchType: "url",
            snippet: pageUrl,
          });
        }
      }
      
      // Search in extracted posts (more specific)
      for (const post of finalPosts) {
        // Search in post content/text
        if (post.text && post.text.toLowerCase().includes(keywordLower)) {
          const matches = findAllMatches(post.text, keywordLower, 2);
          for (const match of matches) {
            locations.push({
              url: post.url || "",
              context: match.context,
              position: "content",
              matchType: "content",
              snippet: match.snippet,
            });
          }
        }

        if (post.url && post.url.toLowerCase().includes(keywordLower)) {
          locations.push({
            url: post.url,
            context: post.url,
            position: "url",
            matchType: "url",
            snippet: post.url,
          });
        }
        
        // Search in author
        if (post.author && post.author.toLowerCase().includes(keywordLower)) {
          locations.push({
            url: post.url || "",
            context: post.author,
            position: "author",
            matchType: "meta",
            snippet: post.author,
          });
        }
      }
      
      const seen = new Set<string>();
      const uniqueLocations = locations.filter(loc => {
        const key = `${loc.url}|${loc.position}|${loc.matchType}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      
      const result = {
        keyword,
        found: uniqueLocations.length > 0,
        totalMatches: uniqueLocations.length,
        locations: uniqueLocations.slice(0, 50),
      };
      
      logger.info({ 
        keyword, 
        found: result.found, 
        totalMatches: result.totalMatches,
        locationsCount: result.locations.length 
      }, "Keyword search completed");
      
      searchResults.push(result);
    }
  }

  const meta: { 
    pagesCrawled: number; 
    duplicatesRemoved: number; 
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
      }> 
    }> 
  } = {
    pagesCrawled,
    duplicatesRemoved,
  };
  
  if (searchResults.length > 0) {
    meta.searchResults = searchResults;
  }

  return { 
    profile: profile || {
      handle: domain,
      displayName: null,
      bio: null,
      about: null,
      links: [url],
      isPrivate: false,
    },
    posts: finalPosts,
    meta,
  };
}

export async function fetchWebsiteContentViaListing(
  url: string,
  options: {
    maxArticles?: number;
    scrollToLoad?: boolean;
    maxScrolls?: number;
    respectRobotsTxt?: boolean;
    enableCaching?: boolean;
    onProgress?: (progress: { phase: string; articleUrlsFound?: number; articlesFetched?: number }) => void;
  } = {}
): Promise<{ profile: Profile; posts: Post[]; meta: { listingUrl: string; articleUrlsFound: number; articlesFetched: number; errors: number } }> {
  const {
    maxArticles = 0, // 0 = no limit, fetch all articles found
    scrollToLoad = true,
    maxScrolls = 15,
    respectRobotsTxt = true,
    enableCaching = false,
    onProgress,
  } = options;

  if (respectRobotsTxt) {
    const allowed = await checkRobotsTxt(url);
    if (!allowed) throw new Error("URL is disallowed by robots.txt");
  }

  const domain = extractDomain(url);
  const baseOrigin = new URL(url).origin;

  onProgress?.({ phase: "fetching_listing" });
  const { html: initialHtml } = await fetchPageHtml(url, {
    scrollToLoad,
    maxScrolls,
    enableCaching,
  });

  const blogDetection = await detectBlogType(url, initialHtml);
  let listingUrl = url;
  let listingHtml = initialHtml;

  if (!blogDetection.isBlog && !blogDetection.isBlogListing) {
    const blogPages = await findBlogPages(url, initialHtml);
    if (blogPages.length === 0) {
      logger.info({ url }, "No blog listing found, treating current page as listing");
    } else {
      listingUrl = blogPages[0] ?? listingUrl;
      onProgress?.({ phase: "fetching_listing", articleUrlsFound: 0 });
      const { html } = await fetchPageHtml(listingUrl, {
        scrollToLoad: true,
        maxScrolls,
        enableCaching,
      });
      listingHtml = html;
    }
  } else if (blogDetection.isBlogListing && !scrollToLoad) {
    const { html } = await fetchPageHtml(listingUrl, {
      scrollToLoad: true,
      maxScrolls,
      enableCaching,
    });
    listingHtml = html;
  }

  const listingDetectedAsBlog = blogDetection.isBlogListing || blogDetection.isBlog;
  const articleUrls = extractArticleUrlsFromListing(listingHtml, listingUrl, baseOrigin, {
    listingDetectedAsBlog,
  });
  const uniqueUrls = maxArticles > 0
    ? Array.from(new Set(articleUrls)).slice(0, maxArticles)
    : Array.from(new Set(articleUrls));
  onProgress?.({ phase: "extracted_articles", articleUrlsFound: uniqueUrls.length });

  const $listing = load(listingHtml);
  const pageTitle = $listing("title").first().text().trim() || "";
  const profile: Profile = {
    handle: domain,
    displayName: pageTitle || domain,
    bio: $listing('meta[name="description"]').attr("content") ||
         $listing('meta[property="og:description"]').attr("content") ||
         null,
    about: null,
    links: [url],
    isPrivate: false,
  };

  const posts: Post[] = [];
  let errors = 0;
  for (let i = 0; i < uniqueUrls.length; i++) {
    const articleUrl = uniqueUrls[i];
    if (!articleUrl) continue;
    onProgress?.({ phase: "fetching_articles", articleUrlsFound: uniqueUrls.length, articlesFetched: posts.length });
    try {
      const post = await fetchSingleArticle(articleUrl, { respectRobotsTxt, enableCaching });
      posts.push(post);
      await delay(300);
    } catch (err) {
      logger.warn({ articleUrl, err: (err as Error).message }, "Failed to fetch article");
      errors++;
    }
  }

  onProgress?.({ phase: "done", articleUrlsFound: uniqueUrls.length, articlesFetched: posts.length });

  return {
    profile,
    posts,
    meta: {
      listingUrl,
      articleUrlsFound: uniqueUrls.length,
      articlesFetched: posts.length,
      errors,
    },
  };
}

export async function fetchWebsiteProfile(url: string): Promise<Profile> {
  try {
    const response = await http.get(url, {
      timeout: 15000,
      maxRedirects: 5,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });

    if (!response?.data || response.status !== 200) {
      throw new Error("Failed to fetch");
    }

    const html = typeof response.data === "string" ? response.data : JSON.stringify(response.data);
    const $ = load(html);
    const domain = extractDomain(url);

    return {
      handle: domain,
      displayName: $("title").first().text().trim() || domain,
      bio: $('meta[name="description"]').attr("content") || 
           $('meta[property="og:description"]').attr("content") || 
           null,
      about: $('meta[name="description"]').attr("content") || 
              $('meta[property="og:description"]').attr("content") || 
              null,
      links: [url],
      isPrivate: false,
    };
  } catch (error) {
    const domain = extractDomain(url);
    logger.error({ url, error: (error as { message?: string }).message }, "Failed to fetch website profile");
    return {
      handle: domain,
      displayName: null,
      bio: null,
      about: null,
      links: [url],
      isPrivate: false,
    };
  }
}


export async function fetchWebsiteProfileAndRecent(
  url: string,
  limit: number,
  options: {
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
  } = {}
): Promise<{ profile: Profile; recent: Post[]; meta: { pagesCrawled: number; duplicatesRemoved: number; searchResults?: Array<{ keyword: string; found: boolean; totalMatches: number; locations: Array<{ url: string; context: string; position: string; matchType: string; snippet?: string }> }> } }> {
  const result = await fetchWebsiteContent(url, { ...options, limit });
  return {
    profile: result.profile,
    recent: result.posts.slice(0, limit),
    meta: result.meta,
  };
}
