import { Link } from "react-router-dom";

type Variant = "hero" | "compact";

/** Static lockup - for contexts that shouldn't be a navigation link (e.g. the auth page title). */
export function BrandLockup({ variant = "compact" }: { variant?: Variant }) {
  return (
    <span className="brand-lockup">
      <span className={`brand-word brand-word--${variant}`}>doodlydoo</span>
    </span>
  );
}

/** Linked lockup - the normal navbar brand, always back to the dashboard. */
export function BrandLink({ variant = "compact" }: { variant?: Variant }) {
  return (
    <Link to="/" className="brand-lockup" aria-label="doodlydoo - home">
      <span className={`brand-word brand-word--${variant}`}>doodlydoo</span>
    </Link>
  );
}
