// Logical drawing surface size - fixed regardless of viewport. Stroke point data (yjs/schema.ts)
// is stored in this coordinate space; the canvas is rendered at whatever size the viewport allows
// (see CanvasBoard's responsive wrapper) and pointer/cursor math scales into/out of this space.
export const BOARD_WIDTH = 1000;
export const BOARD_HEIGHT = 640;
