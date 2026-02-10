import { createHttpClient } from "../../core/http.js";
import { logger } from "../../core/logger.js";

const http = createHttpClient();
const robotsCache = new Map<string, { rules: string[]; expires: number }>();

/**
 * Check if URL is allowed by robots.txt
 */
export async function checkRobotsTxt(url: string, userAgent: string = "*"): Promise<boolean> {
  try {
    const urlObj = new URL(url);
    const robotsUrl = `${urlObj.protocol}//${urlObj.hostname}/robots.txt`;
    
    // Check cache
    const cached = robotsCache.get(robotsUrl);
    if (cached && cached.expires > Date.now()) {
      return !cached.rules.some((rule) => url.includes(rule));
    }

    try {
      const response = await http.get(robotsUrl, {
        timeout: 5000,
        headers: {
          "User-Agent": "Mozilla/5.0",
        },
      });

      if (response?.data && typeof response.data === "string") {
        const rules = parseRobotsTxt(response.data, userAgent);
        robotsCache.set(robotsUrl, {
          rules,
          expires: Date.now() + 3600000, // Cache for 1 hour
        });
        return !rules.some((rule) => url.includes(rule));
      }
    } catch (error) {
      // robots.txt not found or error - allow by default
      logger.debug({ url: robotsUrl }, "robots.txt not found or error, allowing");
      return true;
    }
  } catch (error) {
    logger.debug({ url, error: (error as { message?: string }).message }, "Error checking robots.txt, allowing");
  }

  return true; // Allow by default if robots.txt check fails
}

/**
 * Parse robots.txt content
 */
function parseRobotsTxt(content: string, userAgent: string): string[] {
  const disallowedPaths: string[] = [];
  const lines = content.split("\n");
  let currentUserAgent = "*";
  let inUserAgentBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const [directive, value] = trimmed.split(":").map((s) => s.trim());
    if (!directive || !value) continue;

    if (directive.toLowerCase() === "user-agent") {
      currentUserAgent = value.toLowerCase();
      inUserAgentBlock = currentUserAgent === userAgent.toLowerCase() || currentUserAgent === "*";
    } else if (directive.toLowerCase() === "disallow" && inUserAgentBlock) {
      if (value && value !== "") {
        disallowedPaths.push(value);
      }
    }
  }

  return disallowedPaths;
}
