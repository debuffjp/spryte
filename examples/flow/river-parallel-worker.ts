// Entry point for one of the river's shared-memory fluid workers (see river-parallel.ts).
import { type Buffers, run } from "./river-parallel.ts";

self.onmessage = (e: MessageEvent) => run(e.data.buffers as Buffers, e.data.index as number);
