import * as React from "react";
import { cn } from "@/lib/utils";

const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-9 w-full rounded-md border border-[var(--input)] bg-[var(--background)] px-2.5 text-[13px] text-[var(--foreground)] transition-colors duration-150 ease-out placeholder:text-[var(--muted-foreground)]/70 hover:border-[var(--muted)] focus-visible:border-[var(--ring)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]/35 disabled:cursor-not-allowed disabled:opacity-50 md:h-8",
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
