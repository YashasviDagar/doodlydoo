import { create } from "zustand";
import type { Tool } from "../yjs/schema";

interface ToolState {
  tool: Tool;
  color: string;
  width: number;
  /** Shape tools: fill solid vs outline only. */
  filled: boolean;
  setTool: (tool: Tool) => void;
  setColor: (color: string) => void;
  setWidth: (width: number) => void;
  setFilled: (filled: boolean) => void;
}

// Local-only, per the spec: never written into the shared Y.Doc, never sent over the wire.
// (tool/color/width/filled ride along on each stroke's own metadata when it's created.)
export const useToolStore = create<ToolState>((set) => ({
  tool: "pen",
  color: "#1a1a1a",
  width: 4,
  filled: false,
  setTool: (tool) => set({ tool }),
  setColor: (color) => set({ color }),
  setWidth: (width) => set({ width }),
  setFilled: (filled) => set({ filled }),
}));
