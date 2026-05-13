// Typed FIFO ring buffer. Bun's single-threaded runtime means we don't need
// a mutex — enqueue/dequeue are race-free against concurrent micro-tasks.

export class BoundedQueue<T> {
  private buf: (T | undefined)[];
  private head = 0;
  private tail = 0;
  private size = 0;
  constructor(public readonly capacity: number) {
    if (capacity <= 0) throw new Error("capacity must be > 0");
    this.buf = new Array(capacity);
  }

  enqueue(item: T): boolean {
    if (this.size === this.capacity) return false;
    this.buf[this.tail] = item;
    this.tail = (this.tail + 1) % this.capacity;
    this.size += 1;
    return true;
  }

  dequeue(): T | undefined {
    if (this.size === 0) return undefined;
    const item = this.buf[this.head] as T;
    this.buf[this.head] = undefined;
    this.head = (this.head + 1) % this.capacity;
    this.size -= 1;
    return item;
  }

  getDepth(): number {
    return this.size;
  }

  isFull(): boolean {
    return this.size === this.capacity;
  }

  drain(): T[] {
    const out: T[] = [];
    while (this.size > 0) {
      const item = this.dequeue();
      if (item !== undefined) out.push(item);
    }
    return out;
  }
}
