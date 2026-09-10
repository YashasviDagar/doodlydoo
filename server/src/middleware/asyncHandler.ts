import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Express 4 does not catch rejected promises thrown from async route handlers - a dropped DB
 * connection mid-query becomes an unhandled rejection that can crash the process exactly like the
 * WS upgrade path did (see PLAN.md for that incident). Wrapping every async handler with this
 * routes the error to Express's error middleware instead.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
