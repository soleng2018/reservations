import type { ReactNode } from "react";

// An admin page's content column: the page's one <main>, on cloud mist,
// at most 1180px wide.
export function PageBody({ children }: { readonly children: ReactNode }) {
  return (
    <main
      id="content"
      tabIndex={-1}
      className="flex-1 bg-background px-7 pt-6.5 pb-15"
    >
      <div className="mx-auto flex w-full max-w-295 flex-col gap-5">
        {children}
      </div>
    </main>
  );
}
