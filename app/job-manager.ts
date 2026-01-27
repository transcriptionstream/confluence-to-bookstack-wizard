import { EventEmitter } from 'events';

export interface Job {
  id: string;
  type: string;
  folder: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: Date;
  completedAt?: Date;
  result?: any;
  error?: string;
}

export class JobManager extends EventEmitter {
  private jobs: Map<string, Job> = new Map();
  private abortControllers: Map<string, AbortController> = new Map();
  private currentJobId: string | null = null;

  generateJobId(): string {
    return `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  createJob(type: string, folder: string): Job {
    const id = this.generateJobId();
    const job: Job = {
      id,
      type,
      folder,
      status: 'pending',
      startedAt: new Date(),
    };
    this.jobs.set(id, job);
    this.abortControllers.set(id, new AbortController());
    return job;
  }

  startJob(id: string): AbortController | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    job.status = 'running';
    this.currentJobId = id;
    this.emit('jobStarted', job);
    return this.abortControllers.get(id) || null;
  }

  completeJob(id: string, result?: any): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.status = 'completed';
    job.completedAt = new Date();
    job.result = result;
    if (this.currentJobId === id) {
      this.currentJobId = null;
    }
    this.emit('jobCompleted', job);
  }

  failJob(id: string, error: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.status = 'failed';
    job.completedAt = new Date();
    job.error = error;
    if (this.currentJobId === id) {
      this.currentJobId = null;
    }
    this.emit('jobFailed', job);
  }

  cancelJob(id: string): boolean {
    const job = this.jobs.get(id);
    const controller = this.abortControllers.get(id);
    if (!job || job.status !== 'running') {
      return false;
    }
    if (controller) {
      controller.abort();
    }
    job.status = 'cancelled';
    job.completedAt = new Date();
    if (this.currentJobId === id) {
      this.currentJobId = null;
    }
    this.emit('jobCancelled', job);
    return true;
  }

  getJob(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  getCurrentJob(): Job | null {
    if (!this.currentJobId) return null;
    return this.jobs.get(this.currentJobId) || null;
  }

  getAllJobs(): Job[] {
    return Array.from(this.jobs.values());
  }

  isJobCancelled(id: string): boolean {
    const controller = this.abortControllers.get(id);
    return controller?.signal.aborted || false;
  }

  cleanup(maxAge: number = 3600000): void {
    const now = Date.now();
    for (const [id, job] of this.jobs) {
      if (job.completedAt && now - job.completedAt.getTime() > maxAge) {
        this.jobs.delete(id);
        this.abortControllers.delete(id);
      }
    }
  }
}

// Singleton instance
export const jobManager = new JobManager();
