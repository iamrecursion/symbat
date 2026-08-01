// `numbat-shared` blocks as a whole-document string, for the callers that hold a note's text rather
// than a CodeMirror document.
//
// A thin projection of document/fences.ts, which owns the fence rules — including the tracking of
// non-numbat fences, so a `numbat-shared` block quoted inside another fence is example text and
// does not export its bindings.

import { numbatBlockRanges } from "./fences";

/** One `numbat-shared` block's exported source, and where in the note it starts. */
export interface SharedBlock {
  /** 0-indexed line of the opening fence. */
  startLine: number;

  /** The block's inner source (fence lines excluded). */
  content: string;
}

/** Parse every `numbat-shared` fenced block out of a document, in order. */
export function extractSharedBlocks(doc: string): SharedBlock[] {
  return numbatBlockRanges(doc.split("\n"))
    .filter((block) => block.shared)
    .map((block) => ({ startLine: block.openLine, content: block.body.join("\n") }));
}
