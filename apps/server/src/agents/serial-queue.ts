/** One job at a time, in submission order. A rejected job rejects only its own promise. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(job: () => Promise<T>): Promise<T> {
    const result = this.tail.then(job, job);
    this.tail = result.catch(() => undefined);
    return result;
  }

  idle(): Promise<void> {
    return this.tail.then(() => undefined);
  }
}
