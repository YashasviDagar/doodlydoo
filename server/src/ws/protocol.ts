// Top-level message envelope, matching the y-websocket convention: one leading varint picks
// between the Yjs sync sub-protocol and the awareness sub-protocol; each has its own internal
// sub-message typing (see y-protocols/sync and y-protocols/awareness).
export const MESSAGE_SYNC = 0;
export const MESSAGE_AWARENESS = 1;
// Out-of-band metadata push, not part of the Yjs doc: tells every socket currently on this board
// that its name changed, so a rename shows up live for collaborators instead of only the client
// that made the PATCH request (see boards/routes.ts and ws/roomManager.ts's notifyBoardRenamed).
export const MESSAGE_BOARD_RENAMED = 2;
