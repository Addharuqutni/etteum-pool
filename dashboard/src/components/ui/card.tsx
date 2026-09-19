import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Cards are FLAT by default: a hairline and a surface tint, nothing else.
 * In a dense ops console, a page of drop-shadowed boxes reads as noise and
 * flattens hierarchy — everything shouts, so nothing does.
 *
 * When a view has one dominant surface (a chart, the main table), give that
 * one `className="shadow-[var(--shadow-raised)]"` and let the rest stay flat.
 */
const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "rounded-md border border-[var(--border)] bg-[var(--card)] text-[var(--card-foreground)]",
        className
      )}
      {...props}
    />
  )
);
Card.displayName = "Card";

/**
 * Header / title / content follow the console idiom used everywhere else:
 * a hairline rule, a mono uppercase eyebrow, tight padding. They exist so a
 * long settings page doesn't repeat the same three divs forty times.
 */
const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn("flex flex-col gap-1 border-b border-[var(--border)] px-4 py-3", className)}
      {...props}
    />
  )
);
CardHeader.displayName = "CardHeader";

const CardTitle = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h3
      ref={ref}
      className={cn(
        "font-mono text-micro font-medium uppercase leading-none tracking-eyebrow text-[var(--foreground)]",
        className
      )}
      {...props}
    />
  )
);
CardTitle.displayName = "CardTitle";

const CardDescription = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => (
    <p
      ref={ref}
      className={cn("font-mono text-meta leading-relaxed text-[var(--muted-foreground)]", className)}
      {...props}
    />
  )
);
CardDescription.displayName = "CardDescription";

const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("px-4 py-3", className)} {...props} />
  )
);
CardContent.displayName = "CardContent";

const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn("flex items-center border-t border-[var(--border)] px-4 py-3", className)}
      {...props}
    />
  )
);
CardFooter.displayName = "CardFooter";

export { Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent };
