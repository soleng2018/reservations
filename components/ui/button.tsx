import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

// Nile buttons (spec 0005): pills, bold for filled actions. Focus comes from
// the global :focus-visible outline in app/globals.css; ring-3 adds the
// mock's soft glow outside it.
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-full border border-transparent bg-clip-padding text-sm whitespace-nowrap transition-colors duration-120 ease-nile outline-none select-none focus-visible:ring-3 focus-visible:ring-ring/35 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "bg-primary font-bold text-primary-foreground hover:bg-nile-blue-700",
        cta: "bg-nile-cta text-[0.9375rem] font-bold text-primary-foreground shadow-cta hover:brightness-95",
        outline:
          "border-[1.5px] border-border-strong bg-card font-semibold text-fg1 hover:bg-cloud-mist aria-expanded:bg-cloud-mist",
        secondary:
          "bg-secondary font-semibold text-secondary-foreground hover:bg-nile-blue-050",
        ghost:
          "font-semibold text-fg2 hover:bg-accent hover:text-accent-foreground aria-expanded:bg-accent",
        destructive:
          "bg-destructive font-bold text-primary-foreground hover:bg-destructive/90",
        link: "font-semibold text-primary underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-10 gap-1.5 px-5 has-data-[icon=inline-end]:pr-4 has-data-[icon=inline-start]:pl-4",
        sm: "h-8 gap-1.5 px-3.5 text-sub has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-12 gap-2 px-6.5 text-[0.9375rem] has-data-[icon=inline-end]:pr-5.5 has-data-[icon=inline-start]:pl-5.5 [&_svg:not([class*='size-'])]:size-4.5",
        icon: "size-8 rounded-sm [&_svg:not([class*='size-'])]:size-3.5",
        "icon-sm": "size-7 rounded-sm [&_svg:not([class*='size-'])]:size-3.5",
        "icon-lg": "size-9.5 rounded-md [&_svg:not([class*='size-'])]:size-5",
      },
    },
    compoundVariants: [
      // Row action squares in the mock: 1px border, slate icon.
      {
        variant: "outline",
        size: ["icon", "icon-sm", "icon-lg"],
        className: "border border-border text-fg2 hover:text-fg1",
      },
    ],
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
