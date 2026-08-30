import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * Badges are mono, squared and tinted — status flags on a console, not pills
 * on a landing page. Semantic variants pull straight from the status tokens.
 */
const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-[4px] border px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-[0.08em] transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
  {
    variants: {
      variant: {
        default: "border-[var(--primary)]/30 bg-[var(--primary)]/12 text-[var(--primary)]",
        secondary: "border-[var(--border)] bg-[var(--secondary)] text-[var(--secondary-foreground)]",
        destructive: "border-[var(--destructive)]/30 bg-[var(--destructive)]/12 text-[var(--destructive)]",
        outline: "border-[var(--border)] text-[var(--muted-foreground)]",
        success: "border-[var(--success)]/25 bg-[var(--success)]/12 text-[var(--success)]",
        warning: "border-[var(--warning)]/25 bg-[var(--warning)]/12 text-[var(--warning)]",
        error: "border-[var(--error)]/25 bg-[var(--error)]/12 text-[var(--error)]",
        info: "border-[var(--info)]/25 bg-[var(--info)]/12 text-[var(--info)]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
