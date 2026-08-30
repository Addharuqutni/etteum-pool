import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  // Press gives 3% back on scale — enough to feel mechanical, not bouncy.
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-[13px] font-medium transition-[color,background-color,border-color,transform] duration-150 [transition-timing-function:var(--ease-out-expo)] active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--background)] disabled:pointer-events-none disabled:opacity-45 disabled:active:scale-100 cursor-pointer",
  {
    variants: {
      variant: {
        // The one filled-green button. Flat: the brand color IS the emphasis,
        // it doesn't need a halo underneath it too.
        default:
          "bg-[var(--primary)] text-[var(--primary-foreground)] hover:bg-[var(--primary)]/88",
        destructive:
          "bg-[var(--destructive)] text-[var(--destructive-foreground)] hover:bg-[var(--destructive)]/88",
        outline:
          "border border-[var(--border)] bg-transparent text-[var(--foreground)] hover:border-[var(--primary)]/40 hover:text-[var(--primary)]",
        secondary:
          "bg-[var(--secondary)] text-[var(--secondary-foreground)] hover:bg-[var(--secondary)]/70 hover:text-[var(--foreground)]",
        ghost: "text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)]",
        link: "text-[var(--primary)] underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-3 min-h-[40px] md:min-h-0 md:h-8",
        sm: "h-8 rounded-[5px] px-2.5 text-xs min-h-[40px] md:min-h-0 md:h-7",
        lg: "h-10 px-5",
        icon: "h-9 w-9 min-h-[40px] min-w-[40px] md:h-8 md:w-8 md:min-h-0 md:min-w-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
