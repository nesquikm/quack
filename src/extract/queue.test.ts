import { describe, test, expect } from "bun:test";
import { BoundedQueue } from "./queue";

describe("BoundedQueue", () => {
  test("FIFO order", () => {
    const q = new BoundedQueue<number>(8);
    [1, 2, 3].forEach((n) => q.enqueue(n));
    expect(q.dequeue()).toBe(1);
    expect(q.dequeue()).toBe(2);
    expect(q.dequeue()).toBe(3);
    expect(q.dequeue()).toBeUndefined();
  });

  test("getDepth reflects size", () => {
    const q = new BoundedQueue<string>(4);
    expect(q.getDepth()).toBe(0);
    q.enqueue("a");
    q.enqueue("b");
    expect(q.getDepth()).toBe(2);
    q.dequeue();
    expect(q.getDepth()).toBe(1);
  });

  test("capacity enforced — enqueue returns false when full", () => {
    const q = new BoundedQueue<number>(3);
    expect(q.enqueue(1)).toBe(true);
    expect(q.enqueue(2)).toBe(true);
    expect(q.enqueue(3)).toBe(true);
    expect(q.enqueue(4)).toBe(false);
    expect(q.isFull()).toBe(true);
  });

  test("ring wraparound", () => {
    const q = new BoundedQueue<number>(3);
    q.enqueue(1);
    q.enqueue(2);
    q.dequeue(); // pop 1
    q.enqueue(3);
    q.enqueue(4);
    expect(q.isFull()).toBe(true);
    expect(q.dequeue()).toBe(2);
    expect(q.dequeue()).toBe(3);
    expect(q.dequeue()).toBe(4);
  });

  test("drain empties the queue and returns items in order", () => {
    const q = new BoundedQueue<number>(4);
    q.enqueue(10);
    q.enqueue(20);
    q.enqueue(30);
    const out = q.drain();
    expect(out).toEqual([10, 20, 30]);
    expect(q.getDepth()).toBe(0);
  });
});
