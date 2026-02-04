import type { JobRecord } from "./types.js";

const jobs = new Map<string, JobRecord>();

export function createJob(job: JobRecord) {
  jobs.set(job.jobId, job);
  return job;
}

export function getJob(jobId: string) {
  return jobs.get(jobId) || null;
}

export function updateJob(jobId: string, patch: Partial<JobRecord>) {
  const existing = jobs.get(jobId);
  if (!existing) return null;
  const next = { ...existing, ...patch };
  jobs.set(jobId, next);
  return next;
}
