import type { CrawlResult, ProofSignal, Proofs } from "../store/types.js";

function normalize(s?: string | null) {
  return (s || "").toLowerCase();
}

function matchKeywords(text: string, keywords: string[]): ProofSignal {
  if (!keywords.length) return { matched: false, score: 0, evidence: [] };

  const t = normalize(text);
  const hits = keywords.filter(k => t.includes(k.toLowerCase()));
  const matched = hits.length > 0;
  const score = matched ? Math.min(1, hits.length / Math.max(3, keywords.length)) : 0;
  return { matched, score, evidence: hits };
}
function proofFromPresence(hasContent: boolean): ProofSignal {
  return {
    matched: hasContent,
    score: hasContent ? 1 : 0,
    evidence: hasContent ? ["present"] : [],
  };
}

export function computeProofs(payload: {
  bio?: string | null;
  about?: string | null;
  pinnedText?: string | null;
  pinnedPresent?: boolean;
  recentTexts?: string[];
  recentCount?: number;
  keywords?: string[];
}): Proofs {
  const keywords = payload.keywords || [];
  const hasKeywords = keywords.length > 0;

  let bioMatch: ProofSignal;
  let aboutMatch: ProofSignal;
  let pinnedMatch: ProofSignal;
  let recentMatch: ProofSignal;

  if (hasKeywords) {
    bioMatch = matchKeywords(payload.bio || "", keywords);
    aboutMatch = matchKeywords(payload.about || "", keywords);
    pinnedMatch = matchKeywords(payload.pinnedText || "", keywords);
    const recentCombined = (payload.recentTexts || []).join(" \n ");
    recentMatch = matchKeywords(recentCombined, keywords);
  } else {
    bioMatch = proofFromPresence(!!(payload.bio && payload.bio.trim()));
    aboutMatch = proofFromPresence(!!(payload.about && payload.about.trim()));
    pinnedMatch = proofFromPresence(payload.pinnedPresent ?? !!(payload.pinnedText && payload.pinnedText.trim()));
    recentMatch = {
      matched: (payload.recentCount ?? payload.recentTexts?.length ?? 0) > 0,
      score: (payload.recentCount ?? payload.recentTexts?.length ?? 0) > 0 ? 1 : 0,
      evidence: (payload.recentCount ?? payload.recentTexts?.length ?? 0) > 0 ? ["present"] : [],
    };
  }

  const confidence =
    0.35 * bioMatch.score +
    0.35 * aboutMatch.score +
    0.20 * pinnedMatch.score +
    0.10 * recentMatch.score;

  const matched = confidence >= 0.5 || bioMatch.matched || aboutMatch.matched;

  return {
    bioMatch,
    aboutMatch,
    pinnedMatch,
    recentMatch,
    final: { matched, confidence: Number(confidence.toFixed(2)) },
  };
}

export function attachProofs(result: CrawlResult, keywords: string[]): CrawlResult {
  const proofs = computeProofs({
    bio: result.profile.bio ?? null,
    about: result.profile.about ?? null,
    pinnedText: result.pinned?.text ?? null,
    pinnedPresent: !!result.pinned,
    recentTexts: result.recent.map(r => r.text || ""),
    recentCount: result.recent.length,
    keywords,
  });
  return { ...result, proofs };
}
