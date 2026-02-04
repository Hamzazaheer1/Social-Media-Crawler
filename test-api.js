// Simple test script to test the API
// Run: node test-api.js

const API_URL = "http://localhost:3000";

async function testCrawl() {
  console.log("🚀 Testing Social Media Crawler API\n");

  // Test 1: Start a crawl job
  console.log("1️⃣ Starting crawl job for YouTube...");
  const crawlResponse = await fetch(`${API_URL}/crawl`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      platform: "youtube",
      target: "UC_x5XG1OV2P6uZZ5FSM9Ttw", // Google Developers channel
      options: {
        includeRecent: true,
        recentLimit: 5,
        proofKeywords: ["developer", "coding", "tutorial"],
      },
    }),
  });

  if (!crawlResponse.ok) {
    const error = await crawlResponse.json();
    console.error("❌ Error:", error);
    return;
  }

  const { jobId, status } = await crawlResponse.json();
  console.log(`✅ Job created: ${jobId}`);
  console.log(`   Status: ${status}\n`);

  // Test 2: Check job status (poll until done)
  console.log("2️⃣ Checking job status...");
  let jobStatus = "queued";
  let attempts = 0;
  const maxAttempts = 30;

  while (jobStatus !== "done" && jobStatus !== "failed" && attempts < maxAttempts) {
    await new Promise((resolve) => setTimeout(resolve, 1000)); // Wait 1 second

    const statusResponse = await fetch(`${API_URL}/crawl/${jobId}`);
    if (!statusResponse.ok) {
      console.error("❌ Failed to get status");
      return;
    }

    const statusData = await statusResponse.json();
    jobStatus = statusData.status;
    attempts++;

    if (jobStatus === "running") {
      console.log(`   ⏳ Still running... (attempt ${attempts})`);
    } else if (jobStatus === "failed") {
      console.log(`   ❌ Job failed: ${statusData.error}`);
      return;
    }
  }

  if (jobStatus !== "done") {
    console.log(`   ⚠️  Job did not complete in time (status: ${jobStatus})`);
    return;
  }

  console.log(`   ✅ Job completed!\n`);

  // Test 3: Get results
  console.log("3️⃣ Fetching results...");
  const resultsResponse = await fetch(`${API_URL}/results/${jobId}`);
  if (!resultsResponse.ok) {
    console.error("❌ Failed to get results");
    return;
  }

  const results = await resultsResponse.json();
  console.log("\n📊 Results:");
  console.log("   Platform:", results.platform);
  console.log("   Target:", results.target);
  console.log("   Profile:", {
    handle: results.profile.handle,
    displayName: results.profile.displayName,
    bio: results.profile.bio?.substring(0, 100) + "...",
  });
  console.log("   Recent Posts:", results.recent.length);
  if (results.recent.length > 0) {
    console.log("   First Post:", {
      text: results.recent[0].text?.substring(0, 50) + "...",
      url: results.recent[0].url,
    });
  }
  console.log("   Proof Detection:", {
    matched: results.proofs.final.matched,
    confidence: results.proofs.final.confidence,
    evidence: [
      ...results.proofs.bioMatch.evidence,
      ...results.proofs.aboutMatch.evidence,
      ...results.proofs.recentMatch.evidence,
    ],
  });

  console.log("\n✅ Test completed successfully!");
}

// Run the test
testCrawl().catch((error) => {
  console.error("❌ Test failed:", error);
  process.exit(1);
});
