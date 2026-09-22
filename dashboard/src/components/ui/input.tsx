import * as React from "react";
import { cn } from "@/lib/utils";

const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          // Sizing mirrors Button: a 40px tap target on touch, tightening to
          // 32px on pointer devices. Without `min-h-[40px]` the field rendered
          // at 32px on mobile, below the 40px floor in DESIGN.md.
          "flex h-9 min-h-[40px] w-full rounded-md border border-[var(--input)] bg-[var(--background)] px-2.5 text-control text-[var(--foreground)] transition-colors duration-150 ease-out placeholder:text-[var(--muted-faint)] hover:border-[var(--muted)] focus-visible:border-[var(--ring)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]/35 disabled:cursor-not-allowed disabled:opacity-50 md:h-8 md:min-h-0",
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
Input.displayName = "Input";

export { Input };
