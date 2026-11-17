export const RING_BUFFER_BYTES = 256 * 1024;

interface Chunk {
  text: string;
  bytes: number;
}

export function dropLeadingBytes(text: string, minBytes: number): { text: string; removed: number } {
  let removed = 0;
  let index = 0;
  for (const ch of text) {
    if (removed >= minBytes) break;
    removed += Buffer.byteLength(ch, 'utf8');
    index += ch.length;
  }
  return { text: text.slice(index), removed };
}

export class RingBuffer {
  private chunks: Chunk[] = [];
  private head = 0;
  private total = 0;

  constructor(private readonly maxBytes: number = RING_BUFFER_BYTES) {}

  get byteLength(): number {
    return this.total;
  }

  push(text: string): void {
    if (text === '') return;
    const bytes = Buffer.byteLength(text, 'utf8');
    this.chunks.push({ text, bytes });
    this.total += bytes;
    this.trim();
  }

  toString(): string {
    let out = '';
    for (let i = this.head; i < this.chunks.length; i++) out += this.chunks[i].text;
    return out;
  }

  clear(): void {
    this.chunks = [];
    this.head = 0;
    this.total = 0;
  }

  private trim(): void {
    while (this.total > this.maxBytes && this.head < this.chunks.length) {
      const first = this.chunks[this.head];
      const excess = this.total - this.maxBytes;
      if (first.bytes <= excess) {
        this.head++;
        this.total -= first.bytes;
        continue;
      }
      const cut = dropLeadingBytes(first.text, excess);
      first.text = cut.text;
      first.bytes -= cut.removed;
      this.total -= cut.removed;
    }
    if (this.head > 1024 && this.head * 2 > this.chunks.length) {
      this.chunks = this.chunks.slice(this.head);
      this.head = 0;
    }
  }
}
