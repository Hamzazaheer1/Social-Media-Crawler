import axios from "axios";
import type { Profile, Post } from "../../store/types.js";

const DEFAULT_ACTOR = "apidojo~twitter-profile-scraper";

const safeTweetLimit = (n: number) => Math.max(10, Math.min(n, 100));

function toPost(t: any, username: string): Post {
  return {
    id: String(t.id ?? t.tweetId ?? t.url?.match(/status\/(\d+)/)?.[1] ?? ""),
    url: t.url ?? `https://x.com/${username}/status/${t.id}`,
    text: t.text ?? t.fullText ?? t.content ?? null,
    createdAt: t.createdAt ?? t.time ?? t.timestamp ?? null,
  };
}

export async function fetchXViaProvider(
  username: string,
  limit: number
): Promise<{ profile: Profile; recent: Post[]; pinned: Post | null }> {
  const token = process.env.APIFY_TOKEN;
  if (!token) throw new Error("APIFY_TOKEN missing");

  const actor = process.env.X_APIFY_ACTOR ?? DEFAULT_ACTOR;
  const tweetLimit = safeTweetLimit(limit);


  const input =
    actor === "V38PZzpEgOfeeWvZY"
      ? {
          twitterHandles: [username],
          startUrls: [`https://twitter.com/${username}`],
          getFollowers: false,
          getFollowing: false,
          getRetweeters: false,
          includeUnavailableUsers: false,
          maxItems: tweetLimit,
        }
      : actor.includes("apidojo~twitter-profile-scraper") || actor.includes("twitter-profile-scraper")
        ? { startUrls: [`https://x.com/${username}`], maxRequestRetries: 2, maxTweets: tweetLimit, maxItems: tweetLimit }
        : actor.includes("scrape.badger")
          ? { mode: "Get User by Username", usernames: [username], maxTweets: tweetLimit, maxItems: tweetLimit }
          : { handles: [username], startUrls: [`https://x.com/${username}`], maxRequestRetries: 2, maxTweets: tweetLimit, maxItems: tweetLimit };

  const res = await axios.post(
    `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items`,
    input,
    {
      params: { token },
      timeout: 90000,
      headers: { "Content-Type": "application/json" },
    }
  );

  let items = Array.isArray(res.data) ? res.data : [];
  if (items.length === 0 && res.data && typeof res.data === "object" && !Array.isArray(res.data)) {
    const d = res.data as any;
    if (d.tweets && d.user) items = [{ ...d.user, _tweets: d.tweets }];
    else if (d.profile && d.tweets) items = [{ ...d.profile, _tweets: d.tweets }];
  }
  if (items.length === 0) throw new Error("X Apify returned empty dataset");

  const tweetsFromNested = (items[0] as any)?._tweets;
  const flatTweets = tweetsFromNested ? (Array.isArray(tweetsFromNested) ? tweetsFromNested : []) : [];

  const profileItem = items.find(
    (x: any) =>
      (x.authorUserName ?? x.userName ?? x.handle ?? x.screen_name ?? "").toLowerCase() === username.toLowerCase()
  ) ?? items.find((x: any) => x.type === "profile") ?? items[0];

  const tweetItems =
    flatTweets.length > 0
      ? flatTweets
      : items.filter(
          (x: any) => x.type === "tweet" || ((x.id || x.tweetId) && (x.text || x.fullText) && !x.description)
        );

  const bio =
    profileItem?.description ??
    profileItem?.bio ??
    profileItem?.user?.description ??
    null;

  const profile: Profile = {
    handle: profileItem?.authorUserName ?? profileItem?.userName ?? profileItem?.screen_name ?? profileItem?.handle ?? username,
    displayName: profileItem?.authorName ?? profileItem?.name ?? username,
    bio,
    about: bio,
    links: profileItem?.url ? [profileItem.url] : [`https://x.com/${username}`],
    isPrivate: !!profileItem?.protected,
  };

  const recent: Post[] = tweetItems
    .map((t: any) => toPost(t, username))
    .filter((p: Post) => p.id && p.text)
    .slice(0, limit);

  let pinned: Post | null = null;
  const withPinned = tweetItems.find((t: any) => t.pinned === true || t.isPinned === true);
  if (withPinned) {
    const p = toPost(withPinned, username);
    if (p.id && p.text) pinned = p;
  }
  if (!pinned && recent.length > 0) pinned = recent[0] ?? null;

  return { profile, recent, pinned };
}
