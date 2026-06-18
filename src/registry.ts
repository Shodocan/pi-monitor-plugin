import type { JobKind, JobMetadata, JobRecord, JobState } from './types.ts';
import { MAX_ACTIVE_JOBS, MAX_COMPLETED_RETENTION } from './limits.ts';

export class JobRegistry {
  #counter: number = 0;
  #active = new Map<string, JobRecord>();
  #completed: JobRecord[] = [];
  #sessionID: string;

  constructor(sessionID: string) {
    this.#sessionID = sessionID;
  }

  get sessionID(): string {
    return this.#sessionID;
  }

  /** Number of currently active jobs. */
  get activeCount(): number {
    return this.#active.size;
  }

  /**
   * Register a new job. Returns the generated jobID (<kind>_<counter>).
   *
   * @throws `Error: max active jobs (20)` when limit is reached.
   */
  register(kind: JobKind, metadata: JobMetadata = {}): string {
    if (this.#active.size >= MAX_ACTIVE_JOBS) {
      throw new Error(`max active jobs (${MAX_ACTIVE_JOBS})`);
    }

    this.#counter += 1;
    const jobID = `${kind}_${this.#counter}`;

    const record: JobRecord = {
      jobID,
      kind,
      state: 'active',
      sessionID: this.#sessionID,
      createdAt: Date.now(),
      ...metadata,
    };

    this.#active.set(jobID, record);
    return jobID;
  }

  /** Get a job record by ID. Returns `undefined` when not found. */
  get(jobID: string): JobRecord | undefined {
    return this.#active.get(jobID) ?? this.#completed.find((e) => e.jobID === jobID);
  }

  /** List all jobs (active + recently completed), sorted by createdAt descending. */
  list(): JobRecord[] {
    const all: JobRecord[] = [];
    for (const [, record] of this.#active) {
      all.push(record);
    }
    all.push(...this.#completed);
    all.sort((a, b) => b.createdAt - a.createdAt);
    return all;
  }

  /**
   * Cancel an active job.
   *
   * @throws `Error: job {jobID} not found.`
   * @throws `Error: job {jobID} cannot be cancelled (state: {state}).`
   */
  cancel(jobID: string): void {
    const record = this.#active.get(jobID);
    if (!record) {
      const inCompleted = this.#completed.find((e) => e.jobID === jobID);
      if (!inCompleted) {
        throw new Error(`Error: job ${jobID} not found.`);
      }
      throw new Error(`Error: job ${jobID} cannot be cancelled (state: ${inCompleted.state}).`);
    }

    record.state = 'cancelled';
    this.#active.delete(jobID);
    this.#completed.push(record);
    this.#trimCompleted();
  }

  /** Mark a job as completed. */
  complete(jobID: string): void {
    const record = this.#active.get(jobID);
    if (!record) return;
    record.state = 'completed';
    this.#active.delete(jobID);
    this.#completed.push(record);
    this.#trimCompleted();
  }

  /** Mark a job as failed. */
  fail(jobID: string): void {
    const record = this.#active.get(jobID);
    if (!record) return;
    record.state = 'failed';
    this.#active.delete(jobID);
    this.#completed.push(record);
    this.#trimCompleted();
  }

  /** Return only active jobs. */
  active(): JobRecord[] {
    return [...this.#active.values()];
  }

  /** Return only completed jobs. */
  completed(): JobRecord[] {
    return [...this.#completed];
  }

  /** Return jobs belonging to a specific session. */
  bySession(sessionID: string): JobRecord[] {
    const all: JobRecord[] = [];
    for (const [, record] of this.#active) {
      if (record.sessionID === sessionID) all.push(record);
    }
    for (const record of this.#completed) {
      if (record.sessionID === sessionID) all.push(record);
    }
    return all;
  }

  /** Trim completed list to MAX_COMPLETED_RETENTION. */
  #trimCompleted(): void {
    while (this.#completed.length > MAX_COMPLETED_RETENTION) {
      this.#completed.shift();
    }
  }
}
