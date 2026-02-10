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

export function updateProgress(jobId: string, progress: { currentPage: number; totalPages?: number; itemsFound: number }) {
  const existing = jobs.get(jobId);
  if (!existing) return null;
  const next = { 
    ...existing, 
    progress: {
      currentPage: progress.currentPage,
      totalPages: progress.totalPages ?? null,
      itemsFound: progress.itemsFound,
    }
  };
  jobs.set(jobId, next);
  return next;
}

export function getProgress(jobId: string) {
  const job = jobs.get(jobId);
  if (!job) return null;
  
  if (!job.progress) {
    return {
      jobId: job.jobId,
      status: job.status,
      progress: {
        currentPage: 0,
        totalPages: null,
        itemsFound: 0,
        pagesCrawled: 0,
        errors: 0,
      },
    };
  }
  
  return {
    jobId: job.jobId,
    status: job.status,
    progress: {
      currentPage: job.progress.currentPage,
      totalPages: job.progress.totalPages ?? null,
      itemsFound: job.progress.itemsFound,
      pagesCrawled: 0, // Can be derived from meta if needed
      errors: 0,
    },
  };
}
