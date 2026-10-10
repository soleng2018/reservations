import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import type { BadgeTone } from "@/lib/badge-tones";
import { cn } from "@/lib/utils";

// Nile status pills. Pick the tone from a status word with toneFor().
const badgeVariants = cva(
  "group/badge inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full px-2.75 py-1 text-pill font-semibold whitespace-nowrap [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      tone: {
        info: "bg-nile-blue-100 text-nile-blue",
        success: "bg-teal-100 text-success-fg",
        neutral: "bg-bg-inset text-fg2",
        accent: "bg-violet-100 text-violet-fg",
      } satisfies Record<BadgeTone, string>,
    },
    defaultVariants: {
      tone: "neutral",
    },
  },
);

function Badge({
  className,
  tone = "neutral",
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ tone }), className),
      },
      props,
    ),
    render,
    state: {
      slot: "badge",
      tone,
    },
  });
}

export { Badge, badgeVariants };
